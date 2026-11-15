package dev.homesev.drivelog;

import android.content.Context;
import android.content.SharedPreferences;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.GnssStatus;
import android.location.Location;
import android.location.LocationManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.SystemClock;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Locale;
import java.util.zip.GZIPOutputStream;

/**
 * 센서 원본 기록 (테스트용, 설정에서 켤 때만) — 터널 속도 보정·횡G 검증을
 * 컴퓨터에서 재생하려고 GPS 픽스 전부(정확도 필터 전)와 가속도·자이로·중력
 * 센서를 50Hz로 그대로 남긴다. 서버 본문 상한(2MB) 때문에 압축 전 4MB마다
 * 조각(part-NNN.csv.gz)을 끊고, 주행이 끝나면 /api/raw-log로 올린다.
 *
 * 줄 형식 (t = 주행 시작 기준 ms, 기기 부팅시계 elapsedRealtime 기준):
 *   G,t,utcMs,lat,lng,acc,spd,spdAcc,brg,brgAcc,alt,vAcc,provider   (없는 값 = 빈칸)
 *   A,t,x,y,z  가속도계(중력 포함, m/s²)
 *   W,t,x,y,z  자이로(rad/s)
 *   R,t,x,y,z  중력 센서(융합값, m/s²)
 *   P,t,hPa    기압계(있는 기기만)
 *   S,t,used,visible,cn0avg  위성 상태
 *   E,t,이벤트  pause/resume/stop
 */
final class RawLogger implements SensorEventListener {
  private static final String PREFS = "drivelog";
  private static final String KEY_ON = "rawlog_on";
  private static final long PART_RAW_BYTES = 4L * 1024 * 1024;

  static boolean isOn(Context c) {
    return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean(KEY_ON, false);
  }

  static void setOn(Context c, boolean on) {
    c.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putBoolean(KEY_ON, on).apply();
  }

  static File rootDir(Context c) {
    return new File(c.getFilesDir(), "rawlog");
  }
  private final Context ctx;
  private final File dir;
  private final long t0Ns;
  private final SensorManager sm;
  private HandlerThread thread;
  private Handler handler;
  private volatile GnssStatus.Callback gnssCb;
  private final LocationRegistration gnssRegistration = new LocationRegistration();
  private Writer out;
  private int partNo = -1;
  private long partBytes = 0;
  private long lastFlushMs = 0;

  RawLogger(Context ctx, long tripStartTs, String owner) {
    this.ctx = ctx.getApplicationContext();
    this.dir = new File(rootDir(ctx), String.valueOf(tripStartTs));
    this.t0Ns = SystemClock.elapsedRealtimeNanos();
    this.sm = (SensorManager) ctx.getSystemService(Context.SENSOR_SERVICE);
    dir.mkdirs();
    QueueOwner.write(dir, owner);
    activeTrip = dir.getName();
    synchronized (this) {
      openPart();
      write(String.format(Locale.US, "# drivelog-raw v1 trip=%d model=%s sdk=%d\n", tripStartTs,
          (Build.MANUFACTURER + " " + Build.MODEL).replace(',', ' '), Build.VERSION.SDK_INT));
    }
  }

  /** 센서·위성 상태 수신 시작 (주행 시작/재개) */
  void startSensors(LocationManager lm) {
    if (thread == null) {
      thread = new HandlerThread("rawlog");
      thread.start();
      handler = new Handler(thread.getLooper());
    }
    for (int type : new int[] {Sensor.TYPE_ACCELEROMETER, Sensor.TYPE_GYROSCOPE,
             Sensor.TYPE_GRAVITY, Sensor.TYPE_PRESSURE}) {
      Sensor s = sm.getDefaultSensor(type);
      if (s != null) {
        sm.registerListener(this, s, 20_000, handler);
      }
    }
    if (lm != null && gnssCb == null) {
      gnssCb = new GnssStatus.Callback() {
        @Override
        public void onSatelliteStatusChanged(GnssStatus st) {
          if (gnssCb != this || !gnssRegistration.active()) {
            return;
          }
          int used = 0, n = st.getSatelliteCount();
          double cn0 = 0;
          for (int i = 0; i < n; i++) {
            if (st.usedInFix(i)) {
              used++;
              cn0 += st.getCn0DbHz(i);
            }
          }
          line(String.format(Locale.US, "S,%d,%d,%d,%.1f\n",
              relMs(SystemClock.elapsedRealtimeNanos()), used, n, used > 0 ? cn0 / used : 0.0));
        }
      };
      GnssStatus.Callback satellites = gnssCb;
      Handler delivery = new Handler(android.os.Looper.getMainLooper());
      gnssRegistration.start(() -> lm.registerGnssStatusCallback(satellites, delivery),
          () -> lm.unregisterGnssStatusCallback(satellites));
    }
  }

  void stopSensors(LocationManager lm) {
    if (sm != null) {
      sm.unregisterListener(this);
    }
    gnssCb = null;
    gnssRegistration.stop();
  }

  void event(String name) {
    line("E," + relMs(SystemClock.elapsedRealtimeNanos()) + "," + name + "\n");
  }

  /** 정확도 필터 전의 모든 GPS 픽스 */
  void location(Location l) {
    StringBuilder b = new StringBuilder(128);
    b.append("G,").append(relMs(l.getElapsedRealtimeNanos())).append(',').append(l.getTime());
    b.append(String.format(Locale.US, ",%.7f,%.7f", l.getLatitude(), l.getLongitude()));
    b.append(',').append(l.hasAccuracy() ? fmt1(l.getAccuracy()) : "");
    b.append(',').append(l.hasSpeed() ? fmt2(l.getSpeed()) : "");
    b.append(',').append(l.hasSpeedAccuracy() ? fmt2(l.getSpeedAccuracyMetersPerSecond()) : "");
    b.append(',').append(l.hasBearing() ? fmt1(l.getBearing()) : "");
    b.append(',').append(l.hasBearingAccuracy() ? fmt1(l.getBearingAccuracyDegrees()) : "");
    b.append(',').append(l.hasAltitude() ? fmt1(l.getAltitude()) : "");
    b.append(',').append(l.hasVerticalAccuracy() ? fmt1(l.getVerticalAccuracyMeters()) : "");
    // 위치 출처(gps/fused/network) — 통합 위치가 터널에서 추정값을 내는지 검증용
    b.append(',').append(l.getProvider() == null ? "" : l.getProvider());
    b.append('\n');
    line(b.toString());
  }
  @Override
  public void onSensorChanged(SensorEvent e) {
    char k;
    String f;
    switch (e.sensor.getType()) {
      case Sensor.TYPE_ACCELEROMETER:
        k = 'A';
        f = "%c,%d,%.3f,%.3f,%.3f\n";
        break;
      case Sensor.TYPE_GYROSCOPE:
        k = 'W';
        f = "%c,%d,%.4f,%.4f,%.4f\n";
        break;
      case Sensor.TYPE_GRAVITY:
        k = 'R';
        f = "%c,%d,%.3f,%.3f,%.3f\n";
        break;
      case Sensor.TYPE_PRESSURE:
        line(String.format(Locale.US, "P,%d,%.3f\n", relMs(e.timestamp), e.values[0]));
        return;
      default:
        return;
    }
    line(String.format(Locale.US, f, k, relMs(e.timestamp), e.values[0], e.values[1], e.values[2]));
  }
  @Override
  public void onAccuracyChanged(Sensor s, int a) {}

  /** 기록 마감 후 업로드 시작 */
  void close(LocationManager lm) {
    stopSensors(lm);
    event("stop");
    synchronized (this) {
      closePart();
      try {
        new File(dir, "done").createNewFile();
      } catch (IOException ignored) {
      }
    }
    if (thread != null) {
      thread.quitSafely();
    }
    activeTrip = null;
    uploadPendingAsync(ctx);
  }

  private long relMs(long elapsedNs) {
    return (elapsedNs - t0Ns) / 1_000_000L;
  }

  private static String fmt1(double v) {
    return String.format(Locale.US, "%.1f", v);
  }

  private static String fmt2(double v) {
    return String.format(Locale.US, "%.2f", v);
  }
  private synchronized void line(String s) {
    if (out == null) {
      return;
    }
    write(s);
    if (partBytes >= PART_RAW_BYTES) {
      closePart();
      openPart();
    }
  }

  private void write(String s) {
    try {
      out.write(s);
      partBytes += s.length();
      // 프로세스가 죽어도 대부분 남게 5초마다 압축 스트림을 동기 플러시
      long now = SystemClock.elapsedRealtime();
      if (now - lastFlushMs > 5000) {
        lastFlushMs = now;
        out.flush();
      }
    } catch (IOException e) {
      out = null;
    }
  }

  private void openPart() {
    partNo++;
    partBytes = 0;
    try {
      OutputStream fo =
          new FileOutputStream(new File(dir, String.format(Locale.US, "part-%03d.csv.gz", partNo)));
      out =
          new OutputStreamWriter(new GZIPOutputStream(fo, 64 * 1024, true), StandardCharsets.UTF_8);
    } catch (IOException e) {
      out = null;
    }
  }

  private void closePart() {
    if (out == null) {
      return;
    }
    try {
      out.close();
    } catch (IOException ignored) {
    }
    out = null;
  }
  // ── 업로드 ───────────────────────────────────────────────
  private static final Object UPLOAD_LOCK = new Object();
  /** 지금 쓰는 중인 주행 폴더 이름 — 업로드가 건드리지 않게 */
  static volatile String activeTrip = null;

  /** 마감된(done) 주행의 조각을 전부 올린다. 성공한 조각은 지운다. */
  static void uploadPendingAsync(Context c) {
    // 빌려쓰기 모드는 drivelog 서버에 기록을 올리지 않는다 — 파일은 기기에 그대로 둔다.
    if (BuildConfig.BORROW_UI) {
      return;
    }
    final Context app = c.getApplicationContext();
    new Thread(() -> {
      synchronized (UPLOAD_LOCK) {
        uploadPending(app);
      }
    }, "rawlog-upload").start();
  }

  private static void uploadPending(Context c) {
    File[] trips = rootDir(c).listFiles();
    if (trips == null) {
      return;
    }
    String owner = QueueOwner.current();
    if (owner == null) return;
    URL base;
    String cookie;
    try {
      URL page = new URL(BuildUrl.VALUE);
      base = new URL(page.getProtocol(), page.getHost(), page.getPort(), "/api/raw-log");
      cookie = android.webkit.CookieManager.getInstance().getCookie(BuildUrl.VALUE);
    } catch (Exception e) {
      return;
    }
    // 로그인 전 — 다음 앱 실행 때 다시
    if (cookie == null) {
      return;
    }
    // Validate this exact cookie before using it, including after a VIN session change.
    try {
      java.net.HttpURLConnection auth = (java.net.HttpURLConnection) new URL(base, "/api/auth").openConnection();
      auth.setConnectTimeout(5000);
      auth.setReadTimeout(5000);
      auth.setRequestProperty("Cookie", cookie);
      try {
        if (auth.getResponseCode() != 200) return;
        String body = new String(auth.getInputStream().readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        if (!owner.equals(new org.json.JSONObject(body).optString("idHash"))) return;
      } finally { auth.disconnect(); }
    } catch (Exception e) { return; }
    for (File trip : trips) {
      if (!owner.equals(QueueOwner.read(trip)) || !owner.equals(QueueOwner.current())) continue;
      // 마감 표시가 없어도 진행 중 주행이 아니고 30분 넘게 안 쓰인 건 앱이
      // 죽어 끊긴 기록 — 있는 만큼 올린다
      boolean stale = !trip.getName().equals(activeTrip)
          && System.currentTimeMillis() - trip.lastModified() > 30 * 60_000L;
      if (!new File(trip, "done").exists() && !stale) {
        continue;
      }
      File[] parts = trip.listFiles((d, n) -> n.endsWith(".csv.gz"));
      if (parts == null) {
        continue;
      }
      Arrays.sort(parts);
      boolean allOk = true;
      for (File p : parts) {
        String no = p.getName().substring(5, 8);
        if (post(base, cookie, owner, trip.getName(), no, p)) {
          p.delete();
        } else {
          allOk = false;
          break;
        }
      }
      if (allOk) {
        new File(trip, "done").delete();
        new File(trip, "owner").delete();
        trip.delete();
      }
    }
  }

  static java.util.Set<String> unassigned(Context c) {
    java.util.Set<String> starts = new java.util.HashSet<>();
    File[] dirs = rootDir(c).listFiles(File::isDirectory);
    if (dirs != null) for (File dir : dirs) {
      if (!dir.getName().equals(activeTrip) && QueueOwner.UNASSIGNED.equals(QueueOwner.read(dir))) starts.add(dir.getName());
    }
    return starts;
  }
  static void adopt(Context c, long startTs, String owner) {
    File dir = new File(rootDir(c), String.valueOf(startTs));
    if (dir.isDirectory() && QueueOwner.UNASSIGNED.equals(QueueOwner.read(dir))) {
      long modified = dir.lastModified();
      QueueOwner.write(dir, owner);
      dir.setLastModified(modified);
    }
  }
  static void adoptUnassigned(Context c, String owner) {
    File[] dirs = rootDir(c).listFiles(File::isDirectory);
    if (dirs != null) for (File dir : dirs) {
      if (!dir.getName().equals(activeTrip) && QueueOwner.UNASSIGNED.equals(QueueOwner.read(dir))) {
        long modified = dir.lastModified();
        QueueOwner.write(dir, owner);
        dir.setLastModified(modified);
      }
    }
  }

  private static boolean post(URL base, String cookie, String owner, String trip, String part, File f) {
    HttpURLConnection con = null;
    try {
      URL u = new URL(base.toString() + "?trip=" + trip + "&part=" + part);
      con = (HttpURLConnection) u.openConnection();
      con.setRequestMethod("POST");
      con.setDoOutput(true);
      con.setConnectTimeout(15_000);
      con.setReadTimeout(60_000);
      con.setRequestProperty("Cookie", cookie);
      con.setRequestProperty("X-Fundrive-Owner", owner);
      con.setRequestProperty("Content-Type", "application/gzip");
      con.setFixedLengthStreamingMode(f.length());
      try (OutputStream o = con.getOutputStream();
          java.io.FileInputStream in = new java.io.FileInputStream(f)) {
        byte[] buf = new byte[64 * 1024];
        int n;
        while ((n = in.read(buf)) > 0) {
          o.write(buf, 0, n);
        }
      }
      int code = con.getResponseCode();
      // 형식 거부(400)·너무 큼(413)만 재시도 무의미라 버린다. 그 외(401 로그인
      // 만료, 404 서버 미배포, 429, 5xx)는 다음 기회에 다시 올린다.
      return code == 200 || code == 400 || code == 413;
    } catch (IOException e) {
      return false;
    } finally {
      if (con != null) {
        con.disconnect();
      }
    }
  }
}
