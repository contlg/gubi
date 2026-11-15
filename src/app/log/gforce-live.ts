// 실시간 G 추정기 — 폰 가속도·자이로 + GPS G(1초)로 차 기준 G를 낸다.
// React 밖 순수 계산이라 GForcePanel(useSensorG)과 센서 원본 재생 시험
// (scripts/rawlog/live-replay.mjs)이 같은 코드를 쓴다.
//
// 폰 흔들림 거르기(서버 사후 계산 scripts/rawlog/gforce.mjs와 같은 생각, 실주행 6건으로 숫자 정함):
//  1. 자이로: 수직축이 아닌 회전이 초당 20° 넘으면 폰을 만진 것으로 보고 1초 동안 무시,
//     직전 1초의 최대값 후보도 취소. 그동안 화면은 마지막 정상값에서 멈춘다.
//  2. 튐: 최근 1초 표본의 가운데값에서 퍼짐(MAD)의 4배 넘게 떨어진 표본은 버린다.
//  3. 영점: 움직임이 작은 동안 센서 1초 평균과 GPS G의 차이를 20초에 걸쳐 빼 준다.
//  4. 최대값은 바로 기록하지 않고 GPS가 온 뒤 확정 — 센서 값이 같은 1초 GPS 값보다
//     max(0.2G, GPS의 40%) 넘게 크면 버린다(실측: 진짜 제동·코너는 최대 0.17G 차이).
//     GPS가 3초 넘게 안 오면(터널) 1·2번 검사만으로 확정.

export interface GLive {

  lat: number;

  lon: number;
  /** GPS 값이 계산된 시각(ms) — 센서 각도 맞추기용 */
  t?: number;
}
export interface GPeaks {
  accel: number;
  brake: number;
  left: number;
  right: number;
}

export const G_BINS = 36;
export const BINS = G_BINS; // 최대 G 도형 — 10° 방향 칸마다 이번 주행 최대값
const UP_TAU_S = 20; // 위 방향 보정 시간
const UP_TAU_START_S = 2; // 처음 15초는 빨리 — 출발 가속 중에 잡힌 기울기를 금방 푼다
const UP_FAST_S = 15;
const SHOW_TAU_S = 0.25; // 화면 값 부드럽게
const TOUCH_RAD_S = (20 * Math.PI) / 180; // 수직축 아닌 회전 — 넘으면 폰 만짐
const TOUCH_HOLD_MS = 1000;
const TOUCH_AVG_S = 0.1; // 회전은 0.1초 평균으로 본다(서버와 같게) — 원본 표본 하나하나는 노면 진동에도 넘는다
const MOUNT_AVG_S = 3; // 거치 바뀜 판단용 위 방향 — 3초 평균(거치대 흔들림은 평균에서 지워진다)
const MOUNT_DEG = 15;
const SPIKE_K = 4; // 퍼짐의 몇 배 넘으면 튐
const SPIKE_FLOOR_G = 0.02; // 퍼짐 최소 — 직선 정속에서 과하게 거르지 않게
const BIAS_TAU_S = 20; // 영점 따라가는 시간
const BIAS_MAX_G = 0.15;
const PEAK_TOL_G = 0.2; // 최대값 확정: GPS보다 이만큼(또는 GPS의 40%)까지 커도 인정
const PEAK_TOL_RATIO = 0.4;
const PEAK_MAX_WAIT_MS = 3000;
const MAX_CAR_G = 1.2;
const PAIR_DECAY = Number(process.env.NEXT_PUBLIC_G_PAIR_DECAY || 0.97); // 약 30짝(1~2분 주행) 기억
/** 맞췄다고 볼 최소 움직임(GPS G² 합) — 잊는 만큼 낮춘다 */
export const CAL_MIN_GG = Number(process.env.NEXT_PUBLIC_G_MIN_GG || 0.05);
export type V3 = [number, number, number];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (a: V3): V3 => {
  const n = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / n, a[1] / n, a[2] / n];
};

const median = (a: number[]) => {
  const v = [...a].sort((x, y) => x - y);
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

/** 방향 칸에 최대값 기록 — 방향은 점 위치 기준(위=가속, 오른쪽=우회전) */
export function pushEnv(env: number[], lat: number, lon: number) {
  const m = Math.hypot(lat, lon);
  if (m < 0.02) return;
  const a = (Math.atan2(lat, lon) + 2 * Math.PI) % (2 * Math.PI);
  const b = Math.floor((a / (2 * Math.PI)) * BINS) % BINS;
  if (m > env[b]) env[b] = m;
}
export function newSensorState() {
  return {
    up: null as V3 | null,
    upAtCal: null as V3 | null,
    upSlow: null as V3 | null, // 위 방향 3초 평균 — 거치 바뀜 판단
    offRate: 0, // 수직축 아닌 회전(rad/s) 0.1초 평균 — 폰 만짐 판단
    axis: 0 as 0 | 1, // 수평 기준축: 폰 x(0) 또는 y(1)
    lastTs: 0,
    liveTs: 0,
    startTs: 0,
    win: [] as { t: number; x: number; y: number; bad: boolean }[], // 최근 4초 센서 수평 G(폰 기준 2D, 측정 시각, 만짐·튐 표시)
    C: 0,
    S: 0,
    Cm: 0, // 거울상(폰 y축 뒤집음) 가정의 짝 합 — 브라우저·기기마다 축 방향 규약이 달라도 맞추게
    Sm: 0,
    SS: 0,
    GG: 0,
    pairs: 0,
    resets: 0,
    restored: 0, // 저장 각도를 이어 쓴 횟수
    motions: 0,
    skip: { win: 0, small: 0 },
    show: { lat: 0, lon: 0 },
    bias: { lat: 0, lon: 0 }, // 영점(차 기준) — GPS와 비교해 천천히
    badUntil: 0, // 폰 만짐 — 이 시각까지 무시
    pending: [] as { t: number; lat: number; lon: number; ok: boolean }[], // 최대값 후보(GPS 확인 대기)
    // rotationRate 축 규약 — 표준은 alpha=z·beta=x·gamma=y인데 크롬 안드로이드는 alpha=x·beta=y·gamma=z로 준다
    // (2026-10-19 실주행 개발자 기록: 위 방향이 코너마다 옆으로 넘어가 20분에 57번 초기화, 실시간 8%).
    // 두 규약으로 각각 2초씩 자이로만으로 위 방향을 굴려 보고, 가속도로 본 중력과 덜 어긋나는 쪽을 고른다.
    rotMap: null as RotMap | null,
    rotTest: { spec: null as V3 | null, chrome: null as V3 | null, t0: 0, wdeg: 0, eSpec: 0, eChrome: 0, deg: 0 },
    gLP: null as V3 | null, // 가속도만으로 본 중력 방향(1초 평균) — 축 규약 판정용
    restore: null as SavedCal | null, // 지난 주행에서 맞춘 각도 — 거치 자세가 같으면 바로 이어 쓴다
    env: new Array(BINS).fill(0) as number[],
    peaks: { accel: 0, brake: 0, left: 0, right: 0 } as GPeaks,
  };
}
export type SensorState = ReturnType<typeof newSensorState>;
export type RotMap = "spec" | "chrome";
const ROT_DECIDE_DEG = 180; // 판정에 쓴 창들의 회전이 이만큼 쌓이면 판정
const ROT_WIN_MS = 2000;
/** rotationRate(alpha, beta, gamma °/s) – 폰 x·y·z축 회전(rad/s) */
function rotVec(m: RotMap, r: V3): V3 {
  const k = Math.PI / 180;
  return m === "spec" ? [r[1] * k, r[2] * k, r[0] * k] : [r[0] * k, r[1] * k, r[2] * k];
}

/** 맞춘 폰–차 각도 저장본(기기에 보관) — 매 주행 처음부터 1~2분씩 맞추지 않게 */
export type SavedCal = { C: number; S: number; Cm: number; Sm: number; SS: number; GG: number; up: V3; axis: 0 | 1 };
const SAVED_GG = 0.5; // 이어 쓸 때 무게 — 새 주행 짝 수십 개면 새 값이 이긴다
export function saveCal(s: SensorState): SavedCal | null {
  if (!calRot(s) || !s.upSlow) return null;
  const k = SAVED_GG / s.GG;
  return { C: s.C * k, S: s.S * k, Cm: s.Cm * k, Sm: s.Sm * k, SS: s.SS * k, GG: SAVED_GG, up: s.upSlow, axis: s.axis };
}
function applyRestore(s: SensorState) {
  const r = s.restore, u = s.upSlow ?? s.up;
  if (!r || !u || r.axis !== s.axis || dot3(u, r.up) < Math.cos((MOUNT_DEG * Math.PI) / 180)) return;
  s.C = r.C; s.S = r.S; s.Cm = r.Cm; s.Sm = r.Sm; s.SS = r.SS; s.GG = r.GG;
  s.restored++;
}

/** 학습한 폰–차 각도(맞추기 전이면 null) */
export function calRot(s: SensorState): { cos: number; sin: number; mir: boolean; corr: number } | null {
  const c = calCorr(s);
  if (s.GG < CAL_MIN_GG || c.corr < 0.6) return null;
  const C = c.mir ? s.Cm : s.C, S = c.mir ? s.Sm : s.S;
  const mag = Math.hypot(C, S);
  return { cos: C / mag, sin: S / mag, mir: c.mir, corr: c.corr };
}
/** 회전만으로 맞춘 일치도와, 거울상(축 하나 뒤집힘)이 더 잘 맞는지.
 *  거울상인 기기에서 회전만 쓰면 일치도가 0.6 아래로 떨어져 실시간이 안 켜지고,
 *  켜져도 제동이 옆 G로 새어 나온다(2026-10-19 실주행 증상, 재생 시험으로 재현). */
export function calCorr(s: SensorState): { corr: number; mir: boolean } {
  if (!(s.SS > 0 && s.GG > 0)) return { corr: 0, mir: false };
  const d = Math.sqrt(s.SS * s.GG);
  const a = Math.hypot(s.C, s.S) / d, b = Math.hypot(s.Cm, s.Sm) / d;
  return b > a ? { corr: b, mir: true } : { corr: a, mir: false };
}

function commitPeak(s: SensorState, lat: number, lon: number) {
  pushEnv(s.env, lat, lon);
  const p = s.peaks;
  p.accel = Math.max(p.accel, lon);
  p.brake = Math.max(p.brake, -lon);
  p.left = Math.max(p.left, -lat);
  p.right = Math.max(p.right, lat);
}
function reset(s: SensorState) {
  s.C = s.S = s.SS = s.GG = s.Cm = s.Sm = 0;
  s.pairs = 0;
  s.resets++;
  s.bias = { lat: 0, lon: 0 };
  s.pending = [];
  s.upAtCal = s.upSlow;
  applyRestore(s); // 같은 거치 자세로 돌아왔으면 저장 각도로 바로 시작
}

/**
 * GPS G가 새로 오면: 같은 1초 구간의 센서 평균과 짝지어 폰–차 각도를 학습하고,
 * 영점을 맞추고, 대기 중인 최대값 후보를 확정한다.
 * gpsPerf: GPS 값 시각을 센서와 같은 시계(performance ms)로.
 */
export function sensorGps(s: SensorState, gLat: number, gLon: number, gpsPerf: number) {
  pushEnv(s.env, gLat, gLon);
  // 센서 표본은 "측정된 시각"(event.timeStamp)으로 쌓인다. 폰이 바빠 처리가 늦어도
  // GPS 픽스 시각과 같은 1초를 고른다. 시계가 어긋나 보이면 가장 최근 표본 기준.
  const newest = s.win.length ? s.win[s.win.length - 1].t : gpsPerf;
  const end = Math.abs(gpsPerf - newest) < 3000 ? Math.min(gpsPerf, newest) : newest;
  // 최대값 후보 확정 — 이 GPS 1초 값보다 지나치게 큰 후보는 폰 움직임으로 보고 버린다
  const tolLat = Math.max(PEAK_TOL_G, PEAK_TOL_RATIO * Math.abs(gLat));
  const tolLon = Math.max(PEAK_TOL_G, PEAK_TOL_RATIO * Math.abs(gLon));
  while (s.pending.length && s.pending[0].t <= end) {
    const c = s.pending.shift()!;
    if (c.ok && Math.abs(c.lat) - Math.abs(gLat) <= tolLat && Math.abs(c.lon) - Math.abs(gLon) <= tolLon) {
      commitPeak(s, c.lat, c.lon);
    }
  }
  const w = s.win.filter((p) => p.t >= end - 1000 && p.t <= end && !p.bad);
  // 앱 안 브라우저는 센서 신호를 초당 7번 정도만 주기도 한다(에뮬레이터 실측) — 3번이면 평균으로 충분
  if (w.length < 3) { s.skip.win++; return; }
  const sx = w.reduce((a, p) => a + p.x, 0) / w.length;
  const sy = w.reduce((a, p) => a + p.y, 0) / w.length;
  const gx = gLat, gy = gLon;
  // 영점: 각도를 맞춘 뒤, 움직임이 작은 동안(시각 어긋남 영향 작음) 센서−GPS 차이를 천천히 따라간다
  const rot = calRot(s);
  if (rot && Math.hypot(gx, gy) < 0.15) {
    const a = 1 - Math.exp(-1 / BIAS_TAU_S);
    const clamp = (v: number) => Math.max(-BIAS_MAX_G, Math.min(BIAS_MAX_G, v));
    const syy = rot.mir ? -sy : sy;
    s.bias.lat = clamp(s.bias.lat + a * (sx * rot.cos - syy * rot.sin - gx - s.bias.lat));
    s.bias.lon = clamp(s.bias.lon + a * (sx * rot.sin + syy * rot.cos - gy - s.bias.lon));
  }
  if (Math.hypot(gx, gy) < 0.03) { s.skip.small++; return; } // 움직임이 작으면 각도 정보가 없다
  // 오래된 짝은 서서히 잊는다(짝마다 PAIR_DECAY배). 폰을 거치대에서 돌려 놓으면 위 방향은 그대로라
  // 초기화가 안 걸리는데, 예전 방향으로 쌓인 짝을 다 붙들고 있으면 새 방향이 이길 때까지
  // 일치도가 0.6 아래에서 맴돈다(10-19 실주행: 뒤집은 뒤 약 10분 "맞추는 중").
  s.C *= PAIR_DECAY; s.S *= PAIR_DECAY; s.Cm *= PAIR_DECAY; s.Sm *= PAIR_DECAY;
  s.SS *= PAIR_DECAY; s.GG *= PAIR_DECAY;
  s.C += sx * gx + sy * gy;
  s.S += sx * gy - sy * gx;
  s.Cm += sx * gx - sy * gy;
  s.Sm += sx * gy + sy * gx;
  s.SS += sx * sx + sy * sy;
  s.GG += gx * gx + gy * gy;
  s.pairs++;
}

/** 센서 한 표본. t: 측정 시각(performance ms), ai: 중력 포함 가속도(m/s²),
 *  rot: rotationRate 그대로 [alpha, beta, gamma] (°/s) — 축 규약은 여기서 판정 */
export function sensorMotion(s: SensorState, t: number, ai: V3, rr: V3 | null) {
  s.motions++;
  const dt = s.lastTs ? Math.min(0.2, (t - s.lastTs) / 1000) : 0;
  s.lastTs = t;
  if (!s.up) {
    s.startTs = t;
    s.up = norm(ai);
    s.upSlow = s.up;
    s.axis = Math.abs(s.up[0]) < 0.8 ? 0 : 1;
    reset(s);
    return;
  }
  // 0) 축 규약 판정 — 정해지기 전엔 자이로를 안 쓴다(위 방향은 가속도만으로)
  const an0 = norm(ai);
  const g0 = s.gLP ?? an0;
  const kg = Math.min(1, dt / 1);
  s.gLP = norm([g0[0] + kg * (an0[0] - g0[0]), g0[1] + kg * (an0[1] - g0[1]), g0[2] + kg * (an0[2] - g0[2])]);
  if (rr && !s.rotMap && dt > 0) {
    const T = s.rotTest;
    if (!T.spec || !T.chrome) { T.spec = s.gLP; T.chrome = s.gLP; T.t0 = t; T.wdeg = 0; }
    for (const m of ["spec", "chrome"] as const) {
      const w = rotVec(m, rr), u = T[m]!;
      const c = cross(w, u);
      T[m] = norm([u[0] - c[0] * dt, u[1] - c[1] * dt, u[2] - c[2] * dt]);
    }
    T.wdeg += Math.hypot(rr[0], rr[1], rr[2]) * dt;
    if (t - T.t0 >= ROT_WIN_MS) {
      // 돈 만큼(10°~90°) 있는 창만 — 정지·직진 창은 정보가 없고, 크게 돈 창은 폰을 만진 것
      if (T.wdeg >= 10 && T.wdeg <= 90) {
        const ang = (u: V3) => Math.acos(Math.max(-1, Math.min(1, dot3(u, s.gLP!))));
        T.eSpec += ang(T.spec!); T.eChrome += ang(T.chrome!); T.deg += T.wdeg;
        if (T.deg >= ROT_DECIDE_DEG) {
          if (Math.max(T.eSpec, T.eChrome) > 1.5 * Math.min(T.eSpec, T.eChrome)) s.rotMap = T.eSpec <= T.eChrome ? "spec" : "chrome";
          else { T.eSpec = T.eChrome = T.deg = 0; } // 애매하면 다시 모은다
        }
      }
      T.spec = s.gLP; T.chrome = s.gLP; T.t0 = t; T.wdeg = 0;
    }
  }
  // 1) 자이로로 위 방향 회전 추적
  if (rr && s.rotMap && dt > 0) {
    const w = rotVec(s.rotMap, rr);
    // 폰 만짐: 차는 거의 수직축으로만 돈다 — 그 밖의 회전이 크면 1초 무시 + 직전 1초 후보 취소
    const along = dot3(w, s.up);
    const off = Math.hypot(w[0] - along * s.up[0], w[1] - along * s.up[1], w[2] - along * s.up[2]);
    s.offRate += Math.min(1, dt / TOUCH_AVG_S) * (off - s.offRate);
    if (s.offRate > TOUCH_RAD_S) {
      s.badUntil = t + TOUCH_HOLD_MS;
      for (const c of s.pending) if (c.t >= t - TOUCH_HOLD_MS) c.ok = false;
    }
    const c = cross(w, s.up);
    s.up = norm([s.up[0] - c[0] * dt, s.up[1] - c[1] * dt, s.up[2] - c[2] * dt]);
  }
  // 2) 가속도로 천천히 바로잡기(차 가감속에 끌려가지 않게 20초)
  const k = dt / ((t - s.startTs) / 1000 < UP_FAST_S ? UP_TAU_START_S : UP_TAU_S);
  const an = norm(ai);
  s.up = norm([
    s.up[0] * (1 - k) + an[0] * k,
    s.up[1] * (1 - k) + an[1] * k,
    s.up[2] * (1 - k) + an[2] * k,
  ]);
  // 거치를 바꿨으면(3초 평균 위 방향이 15° 넘게 변화) 각도 학습을 처음부터.
  // 순간 위 방향으로 보면 흔들리는 거치대에서 1초에 몇 번씩 초기화된다(10-17 실주행 83번).
  const ks = Math.min(1, dt / MOUNT_AVG_S);
  const us = s.upSlow ?? s.up;
  s.upSlow = norm([us[0] + ks * (s.up[0] - us[0]), us[1] + ks * (s.up[1] - us[1]), us[2] + ks * (s.up[2] - us[2])]);
  if (s.upAtCal && dot3(s.upSlow, s.upAtCal) < Math.cos((MOUNT_DEG * Math.PI) / 180)) {
    s.axis = Math.abs(s.up[0]) < 0.8 ? 0 : 1;
    reset(s);
  }
  // 3) 수평 가속(중력 뺀 값)을 폰 기준 수평 2D로
  const lin: V3 = [ai[0] - s.up[0] * 9.81, ai[1] - s.up[1] * 9.81, ai[2] - s.up[2] * 9.81];
  const vUp = dot3(lin, s.up);
  const h: V3 = [lin[0] - vUp * s.up[0], lin[1] - vUp * s.up[1], lin[2] - vUp * s.up[2]];
  const base: V3 = s.axis === 0 ? [1, 0, 0] : [0, 1, 0];
  const e1 = norm([
    base[0] - dot3(base, s.up) * s.up[0],
    base[1] - dot3(base, s.up) * s.up[1],
    base[2] - dot3(base, s.up) * s.up[2],
  ]);
  const e2 = cross(s.up, e1);
  const x = dot3(h, e1) / 9.81, y = dot3(h, e2) / 9.81;
  // 튐: 최근 1초 정상 표본의 가운데값·퍼짐과 비교
  const recent = s.win.filter((p) => !p.bad && p.t >= t - 1000);
  let spike = false;
  if (recent.length >= 5) {
    const xs = recent.map((p) => p.x), ys = recent.map((p) => p.y);
    const mx = median(xs), my = median(ys);
    const dx = Math.max(SPIKE_FLOOR_G, 1.4826 * median(xs.map((v) => Math.abs(v - mx))));
    const dy = Math.max(SPIKE_FLOOR_G, 1.4826 * median(ys.map((v) => Math.abs(v - my))));
    spike = Math.abs(x - mx) > SPIKE_K * dx || Math.abs(y - my) > SPIKE_K * dy;
  }
  const bad = spike || t < s.badUntil;
  s.win.push({ t, x, y, bad });
  while (s.win.length && s.win[0].t < t - 4000) s.win.shift();
  // 4) 학습한 각도로 차 기준(좌우, 앞뒤)으로 돌린다
  const rot = calRot(s);
  if (!rot) return; // 아직 못 맞춤 – GPS 값 표시
  s.liveTs = t;
  if (bad) return; // 흔들림·튐 — 화면은 마지막 정상값 유지
  const yy = rot.mir ? -y : y;
  const lat = x * rot.cos - yy * rot.sin - s.bias.lat;
  const lon = x * rot.sin + yy * rot.cos - s.bias.lon;
  if (Math.abs(lat) > MAX_CAR_G || Math.abs(lon) > MAX_CAR_G) return;
  const kk = dt > 0 ? 1 - Math.exp(-dt / SHOW_TAU_S) : 1;
  s.show = { lat: s.show.lat + kk * (lat - s.show.lat), lon: s.show.lon + kk * (lon - s.show.lon) };
  // 최대값은 GPS 확인 뒤 확정(GPS 효과 쪽). GPS가 끊겼으면 3초 뒤 자이로·튐 검사만으로
  s.pending.push({ t, lat: s.show.lat, lon: s.show.lon, ok: true });
  while (s.pending.length && s.pending[0].t < t - PEAK_MAX_WAIT_MS) {
    const c = s.pending.shift()!;
    if (c.ok) commitPeak(s, c.lat, c.lon);
  }
}
