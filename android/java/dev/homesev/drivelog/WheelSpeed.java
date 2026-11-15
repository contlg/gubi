package dev.homesev.drivelog;

import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.os.Handler;
import java.util.ArrayDeque;

/**
 * 바퀴 진동 속도 — GPS가 끊긴 터널에서 화면 속도를 추정한다.
 *
 * 바퀴는 한 바퀴마다 아주 살짝 덜컹해서(중력의 0.5~4%), 가속도계 스펙트럼에 "회전수 = 속도 ÷ 둘레"
 * 줄기가 생긴다. GPS가 좋을 때 그 줄기로 바퀴 둘레를 맞춰 두고(차마다 다름: 1.5~2.3m),
 * 끊기면 입구 속도에서 출발해 줄기를 따라간다. 다음 창 위치는 가속도로 먼저 짐작해서
 * (급제동 때 줄기가 멀리 움직여도 놓치지 않게) 그 ±10% 안의 뚜렷한 극대만 받는다.
 * 믿을 근거가 부족하면 아무것도 안 낸다 – 화면은 입구 속도 유지.
 *
 * 검증(scripts/rawlog/wheel-speed.mjs, 차 기록 25개): GPS를 가린 곧은 길 출구 속도 오차 중앙
 * 30초 4.1·4분 1.5km/h(입구 속도 유지 7.8·6.4), 실제 끊김 5개 평균 2.6km/h(유지 14.8).
 * 그 스크립트와 같은 계산이다 — 한쪽을 바꾸면 다른 쪽도.
 */
final class WheelSpeed implements SensorEventListener {
  interface Listener {
    /** 끊김 중 새 추정 속도(m/s) — 2.56초마다 */
    void onEstimate(double mps);
  }
  private static final int FS = 100, WIN = 512, HOP = 256, HALF = WIN / 2;
  private static final double DF = (double) FS / WIN;
  private static final double C_MIN = 1.5, C_STEP = 0.01;
  private static final int NC = 111;
  private static final long PRE_MS = 180_000, GAP_MS = 3_000;
  private final Listener listener;
  private SensorManager sm;
  // 원시 가속도 (부팅 후 ms, x, y, z) — 최근 15초
  private final double[] rt = new double[2048], rx = new double[2048], ry = new double[2048],
                         rz = new double[2048];
  private int rHead = 0, rCount = 0;
  private double nextWinEnd = -1;
  // 60초 평균 (1초 묶음) — 창 평균 가속에서 중력·치우침을 빼는 기준
  private final ArrayDeque<double[]> sec = new ArrayDeque<>();
  private double secT = -1, sx, sy, sz;
  private int sn;
  // GPS 속도 기록 (부팅 후 ms, m/s, 좋은 픽스?)
  private final ArrayDeque<double[]> fixes = new ArrayDeque<>();
  private double lastFixEt = -1, lastFixV = -1;
  /** 직전 3분 보정 창 */
  private static final class Win {
    double t, v;
    float[] w;
    double[] am;
    /** 직전 창 대비 GPS 속도 변화 (이어진 창일 때만) */
    double dv;
    boolean hasDv;
  }
  private final ArrayDeque<Win> pre = new ArrayDeque<>();
  private Win lastWin;
  // 기록 시작부터 둘레 후보별 줄기 세기 합
  private final double[] cSum = new double[NC];
  private int cCount = 0;
  // 끊김 추적 상태
  private boolean inGap = false, tracking = false;
  private double f, cGap;
  private double[] wA;
  private final double[] han = new double[WIN];
  /** 마지막 끊김 판단 이유 — 원본 기록에 남겨 나중에 확인 */
  String gateInfo = "";

  WheelSpeed(Listener l) {
    listener = l;
    for (int i = 0; i < WIN; i++) {
      han[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1));
    }
  }

  void start(SensorManager s, Handler h) {
    sm = s;
    Sensor a = s.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
    if (a != null) {
      s.registerListener(this, a, 1_000_000 / FS, h);
    }
  }

  void stop() {
    if (sm != null) {
      sm.unregisterListener(this);
    }
    sm = null;
  }

  /** 받아들인 GPS 픽스 — 끊김을 끝내고, 좋은 픽스(정확도 15m 안)면 보정에 쓴다 */
  void fix(double et, double mps, boolean good) {
    lastFixEt = et;
    lastFixV = mps;
    if (inGap) {
      inGap = false;
      tracking = false;
    }
    if (good) {
      fixes.addLast(new double[] {et, mps});
      while (fixes.size() > 400) {
        fixes.pollFirst();
      }
    }
  }

  boolean tracking() {
    return inGap && tracking;
  }
  @Override
  public void onSensorChanged(SensorEvent e) {
    accel(e.timestamp / 1e6, e.values[0], e.values[1], e.values[2]);
  }

  /** 가속도 한 표본 (부팅 후 ms, m/s²) — 재생 시험도 이걸 부른다 */
  void accel(double t, float ax, float ay, float az) {
    rt[rHead] = t;
    rx[rHead] = ax;
    ry[rHead] = ay;
    rz[rHead] = az;
    rHead = (rHead + 1) % rt.length;
    if (rCount < rt.length) {
      rCount++;
    }
    // 1초 묶음
    if (secT < 0) {
      secT = t;
    }
    sx += ax;
    sy += ay;
    sz += az;
    sn++;
    if (t - secT >= 1000) {
      sec.addLast(new double[] {sx / sn, sy / sn, sz / sn});
      while (sec.size() > 60) {
        sec.pollFirst();
      }
      sx = sy = sz = 0;
      sn = 0;
      secT = t;
    }
    if (nextWinEnd < 0) {
      nextWinEnd = t + WIN * 1000.0 / FS;
    }
    if (t - nextWinEnd > 10_000) {
      // 센서가 오래 멈췄다 재개 — 밀린 창을 한꺼번에 계산하지 않고, 새 표본이 한 창 찰 때부터 다시
      nextWinEnd = t + WIN * 1000.0 / FS;
    } else if (t >= nextWinEnd) {
      double end = nextWinEnd;
      nextWinEnd += HOP * 1000.0 / FS;
      window(end);
    }
  }
  @Override
  public void onAccuracyChanged(Sensor s, int a) {}

  private void window(double end) {
    double start = end - WIN * 1000.0 / FS;
    double[][] x = new double[3][WIN];
    if (!resample(start, x)) {
      return;
    }
    // 스펙트럼 (3축 합) – 로그 – 이웃 평균 빼기(백색화)
    double[] p = new double[HALF];
    double[] am = new double[3];
    for (int k = 0; k < 3; k++) {
      double m = 0;
      for (int i = 0; i < WIN; i++) {
        m += x[k][i];
      }
      m /= WIN;
      am[k] = m;
      double[] re = new double[WIN], im = new double[WIN];
      for (int i = 0; i < WIN; i++) {
        re[i] = (x[k][i] - m) * han[i];
      }
      fft(re, im);
      for (int i = 0; i < HALF; i++) {
        p[i] += re[i] * re[i] + im[i] * im[i];
      }
    }
    if (sec.size() >= 10) {
      double[] s = new double[3];
      for (double[] q : sec) {
        for (int k = 0; k < 3; k++) {
          s[k] += q[k];
        }
      }
      for (int k = 0; k < 3; k++) {
        am[k] -= s[k] / sec.size();
      }
    } else {
      am = new double[3];
    }
    double[] lg = new double[HALF];
    for (int i = 0; i < HALF; i++) {
      lg[i] = Math.log(p[i] + 1e-12);
    }
    float[] w = new float[HALF];
    for (int i = 0; i < HALF; i++) {
      double s = 0;
      int c = 0;
      for (int q = Math.max(1, i - 8); q <= Math.min(HALF - 1, i + 8); q++) {
        if (Math.abs(q - i) > 1) {
          s += lg[q];
          c++;
        }
      }
      w[i] = (float) (lg[i] - s / c);
    }
    Win cur = new Win();
    // 창 가운데
    cur.t = end - WIN * 500.0 / FS;
    cur.w = w;
    cur.am = am;
    cur.v = speedAt(cur.t);
    // 끊김 시작: 받아들인 픽스가 3초 넘게 없음
    if (!inGap && lastFixEt > 0 && end - lastFixEt > GAP_MS && lastFixV >= 0) {
      beginGap(end);
    }
    if (inGap) {
      if (tracking) {
        step(cur);
        if (tracking) {
          listener.onEstimate(f * cGap);
        } else {
          // 믿을 수 없게 됐다 — 화면을 입구 속도로 돌려놓고 이번 끊김은 더 추정하지 않는다
          gateInfo = String.format(java.util.Locale.US, "gave-up C=%.2f", cGap);
          listener.onEstimate(vEntry);
        }
      }
    } else if (cur.v > 8) {
      calib(cur);
    }
    lastWin = cur;
  }

  private void calib(Win cur) {
    if (lastWin != null && lastWin.v > 8 && cur.t - lastWin.t <= 3000) {
      // fitAccel용: 이전 창 속도를 함께 들고 간다
      cur.dv = cur.v - lastWin.v;
      cur.hasDv = true;
    }
    pre.addLast(cur);
    while (!pre.isEmpty() && cur.t - pre.peekFirst().t > PRE_MS) {
      pre.pollFirst();
    }
    for (int c = 0; c < NC; c++) {
      double r = ridge(cur, C_MIN + c * C_STEP);
      if (!Double.isNaN(r)) {
        cSum[c] += r;
      }
    }
    cCount++;
  }

  private void beginGap(double now) {
    inGap = true;
    tracking = false;
    // 정차·저속에서 끊긴 경우(주차장 등)는 추정 안 함 — 바퀴 줄기는 보정 기준(8m/s) 이상에서만 검증했다
    if (lastFixV < 8) {
      gateInfo = String.format(java.util.Locale.US, "slow entry %.1fm/s", lastFixV);
      return;
    }
    // 직전 3분은 끊김 시점 기준으로 다시 자른다(마지막 보정 창 기준이면 3분 넘은 창이 섞였다)
    while (!pre.isEmpty() && now - pre.peekFirst().t > PRE_MS) {
      pre.pollFirst();
    }
    // 직전 3분이 끊김 직전까지 이어져 있어야
    if (pre.size() < 20 || cCount < 40 || now - pre.peekLast().t > 15_000) {
      gateInfo = String.format(java.util.Locale.US, "no-calib pre=%d all=%d lastAgo=%.0f",
          pre.size(), cCount, pre.isEmpty() ? -1 : now - pre.peekLast().t);
      return;
    }
    // 둘레는 기록 전체 값 — 같은 차 타이어는 주행 중 안 바뀐다. 직전 3분만으로 재면 굽은 길에서
    // 2.08–2.21m로 흔들려 첫 보령터널을 거부했다(10-25). 직전 3분은 줄기가 뚜렷했는지만 본다.
    int ia = 0;
    for (int c = 1; c < NC; c++) {
      if (cSum[c] > cSum[ia]) {
        ia = c;
      }
    }
    double cs = C_MIN + ia * C_STEP;
    int clear = 0, n = 0;
    for (Win q : pre) {
      double r = ridge(q, cs);
      if (Double.isNaN(r)) {
        continue;
      }
      n++;
      if (r > 0.8) {
        clear++;
      }
    }
    if (n == 0 || (double) clear / n < 0.5) {
      gateInfo = String.format(java.util.Locale.US, "weak C=%.2f clear=%d/%d", cs, clear, n);
      return;
    }
    cGap = cs;
    vEntry = lastFixV;
    f = lastFixV / cs;
    wA = fitAccel();
    tracking = true;
    gateInfo = String.format(
        java.util.Locale.US, "track C=%.2f clear=%d/%d accel=%s", cs, clear, n, wA != null);
  }
  /** 한 창(2.56초)에 믿을 속도 변화 상한(m/s) — 약 0.6G. 넘으면 예측을 버린다 */
  private static final double MAX_DV = 15;
  /** 입구 속도보다 이만큼(m/s, 40km/h) 넘게 빨라지면 다른 떨림으로 옮겨 탄 것으로 본다 —
   *  GPS 가림 재생에서 120초 뒤 254km/h 같은 값이 나왔다(입구 유지는 최대 87). 추적을 멈추고 입구 속도로 */
  private static final double MAX_RISE = 11;
  private double vEntry;

  private void step(Win w) {
    if (wA != null) {
      double dv = wA[0] * w.am[0] + wA[1] * w.am[1] + wA[2] * w.am[2];
      if (Double.isFinite(dv) && Math.abs(dv) <= MAX_DV) {
        f = Math.max(0, f + dv / cGap);
      }
    }
    // 예측 ±10% 안의 뚜렷한(세기>1) 극대만 받는다 — 보간한 주파수도 그 범위 안이어야 한다.
    // ±6%로 좁히면 출구 급감속을 못 따라가 보령터널 출구가 46/67·69/38km/h로 틀렸다(10%: 68/67·41/38).
    // 스펙트럼으로 못 보는 저속(3빈 아래)은 피크를 찾지 않고 가속도 예측만 쓴다(0까지 내려갈 수 있게)
    double flo = f * 0.90, fhi = f * 1.10, best = Double.NaN, bv = 1.0;
    for (int b = Math.max(3, (int) Math.ceil(flo / DF) - 1);
        b <= (int) Math.floor(fhi / DF) + 1 && b < HALF - 1; b++) {
      double y0 = w.w[b - 1], y1 = w.w[b], y2 = w.w[b + 1];
      if (y1 <= bv || y1 < y0 || y1 < y2) {
        continue;
      }
      double den = 2 * (y0 - 2 * y1 + y2);
      double fi = (b + (den != 0 ? Math.max(-0.5, Math.min(0.5, (y0 - y2) / den)) : 0)) * DF;
      if (fi < flo || fi > fhi) {
        continue;
      }
      bv = y1;
      best = fi;
    }
    if (!Double.isNaN(best)) {
      f = best;
    }
    if (!Double.isFinite(f) || f * cGap > vEntry + MAX_RISE) {
      tracking = false;
    }
  }

  /** 둘레 C에서 바퀴 주파수 자리의 줄기 세기 (범위 밖이면 NaN) */
  private static double ridge(Win w, double c) {
    int b = (int) Math.round(w.v / c / DF);
    if (b <= 2 || b >= HALF - 2) {
      return Double.NaN;
    }
    return Math.max(w.w[b - 1], Math.max(w.w[b], w.w[b + 1]));
  }

  /** 직전 3분: 창 사이 GPS 속도 변화 ≈ w·평균가속 (3축 최소제곱) */
  private double[] fitAccel() {
    double[][] m = new double[3][3];
    double[] y = new double[3];
    int n = 0;
    for (Win q : pre) {
      if (!q.hasDv) {
        continue;
      }
      n++;
      for (int r = 0; r < 3; r++) {
        y[r] += q.am[r] * q.dv;
        for (int c = 0; c < 3; c++) {
          m[r][c] += q.am[r] * q.am[c];
        }
      }
    }
    if (n < 20) {
      return null;
    }
    // 거의 안 흔들린 축이 있으면 그 축 가중치가 수백 배로 튄다(검사 지적: diag(1,1,1e-6)) —
    // 대각에 작은 값을 더해 누르고(릿지), 결과 가중치가 물리적으로 말이 안 되면 버린다
    double tr = (m[0][0] + m[1][1] + m[2][2]) / 3;
    if (!(tr > 1e-6)) {
      return null;
    }
    for (int r = 0; r < 3; r++) {
      m[r][r] += 0.01 * tr;
    }
    double d = det(m);
    if (!(Math.abs(d) > 1e-12)) {
      return null;
    }
    double[] out = new double[3];
    for (int c = 0; c < 3; c++) {
      double[][] mc = new double[3][3];
      for (int r = 0; r < 3; r++) {
        for (int k = 0; k < 3; k++) {
          mc[r][k] = k == c ? y[r] : m[r][k];
        }
      }
      out[c] = det(mc) / d;
    }
    // 창 하나(2.56초) 동안 가속 1m/s²면 속도 변화 ≈ 2.56m/s — 축 하나 가중치가 5를 넘으면 엉터리 보정
    for (double g : out) {
      if (!Double.isFinite(g) || Math.abs(g) > 5) {
        return null;
      }
    }
    return out;
  }

  private static double det(double[][] m) {
    return m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  }

  /** 창 가운데 시각의 GPS 속도 (1초 안 좋은 픽스, 없으면 -1) */
  private double speedAt(double t) {
    double best = -1, bd = 1000;
    for (double[] q : fixes) {
      double d = Math.abs(q[0] - t);
      if (d < bd) {
        bd = d;
        best = q[1];
      }
    }
    return best;
  }

  /** [start, start+5.12초) 를 100Hz 균일 격자로 (선형 보간). 표본이 모자라면 false */
  private boolean resample(double start, double[][] out) {
    if (rCount < WIN / 2) {
      return false;
    }
    int n = rCount, first = (rHead - n + rt.length) % rt.length;
    if (rt[first] > start + 50) {
      return false;
    }
    // first 기준 오프셋
    int j = 0;
    for (int i = 0; i < WIN; i++) {
      double t = start + i * 1000.0 / FS;
      while (j + 1 < n && rt[(first + j + 1) % rt.length] < t) {
        j++;
      }
      int a = (first + j) % rt.length, b = (first + Math.min(j + 1, n - 1)) % rt.length;
      double ta = rt[a], tb = rt[b];
      // 표본 구멍(100ms 넘게 빔)을 직선으로 이어 붙이면 가짜 스펙트럼이 된다 — 창을 버린다
      if (tb - ta > 100 || t - tb > 100) {
        return false;
      }
      double u = tb > ta ? Math.max(0, Math.min(1, (t - ta) / (tb - ta))) : 0;
      out[0][i] = rx[a] + (rx[b] - rx[a]) * u;
      out[1][i] = ry[a] + (ry[b] - ry[a]) * u;
      out[2][i] = rz[a] + (rz[b] - rz[a]) * u;
    }
    return true;
  }

  private static void fft(double[] re, double[] im) {
    int n = re.length;
    for (int i = 1, r = 0; i < n; i++) {
      int bit = n >> 1;
      for (; (r & bit) != 0; bit >>= 1) {
        r ^= bit;
      }
      r ^= bit;
      if (i < r) {
        double t = re[i];
        re[i] = re[r];
        re[r] = t;
        t = im[i];
        im[i] = im[r];
        im[r] = t;
      }
    }
    for (int len = 2; len <= n; len <<= 1) {
      double ang = -2 * Math.PI / len;
      for (int i = 0; i < n; i += len) {
        for (int k = 0; k < len / 2; k++) {
          double wr = Math.cos(ang * k), wi = Math.sin(ang * k);
          int p = i + k, q = i + k + len / 2;
          double vr = re[q] * wr - im[q] * wi, vi = re[q] * wi + im[q] * wr;
          re[q] = re[p] - vr;
          im[q] = im[p] - vi;
          re[p] += vr;
          im[p] += vi;
        }
      }
    }
  }
}
