"use client";

import { useEffect, useRef, useState } from "react";
import { usePleosFeed } from "@/lib/pleos-feed";
import { devlog } from "@/lib/devlog";
import { BINS, CAL_MIN_GG, G_BINS, calCorr, saveCal, type SavedCal, newSensorState, sensorGps, sensorMotion, type GLive, type GPeaks, type SensorState, type V3 } from "./gforce-live";

export { pushEnv, type GLive, type GPeaks } from "./gforce-live";

/**
 * 주행 화면 오른쪽에서 꺼내는 G-Force 패널 — 현대 N 인포테인먼트의 G-Force
 * 화면처럼. 평소엔 오른쪽 가장자리 "G" 탭만 보이고, 누르면 미끄러져 나온다.
 *
 * 실시간(센서): 패널이 열려 있는 동안 폰 가속도·자이로(devicemotion, 수십 Hz)를
 * 읽는다. 위 방향은 자이로로 따라가고 가속도로 20초에 걸쳐 천천히 바로잡는다
 * (실주행 분석에서 삼성 중력센서 대신 쓴 방식). 폰이 차 안에서 돌아간 각도는
 * GPS로 계산한 G(page.tsx feedG, 1초)와 맞춰 찾는다. 맞추기 전·센서 없음이면
 * GPS 값을 그대로 보여준다.
 * 점은 가속 방향으로 움직인다: 위=가속, 아래=제동, 왼쪽=좌회전, 오른쪽=우회전.
 * 계산(흔들림 거르기 포함)은 ./gforce-live.ts — 센서 원본 재생 시험과 같은 코드.
 */
const MAX_G = 1; // 원 가장자리 = 1G
const R = 70; // 원 반지름(viewBox 단위)
export { G_BINS } from "./gforce-live";

/** 빈 칸은 양옆 기록을 이어 채운다 — 최대점들을 곡선처럼 잇는 도형 */
export function fillEnv(env: number[]): number[] {
  const known = env.filter((v) => v > 0).length;
  if (known < 2) return env.slice();
  return env.map((v, i) => {
    if (v > 0) return v;
    let p = i, q = i, dp = 0, dq = 0;
    while (env[p] <= 0) { p = (p - 1 + BINS) % BINS; dp++; }
    while (env[q] <= 0) { q = (q + 1) % BINS; dq++; }
    return (env[p] * dq + env[q] * dp) / (dp + dq);
  });
}

function fmt(g: number) {
  return Math.abs(g).toFixed(2);
}

/** 센서 – 차 기준 G 추정기 (상태는 ref에, 화면 갱신은 15fps) */
const CAL_KEY = "drivelog-gcal-v1";
const ROT_KEY = "drivelog-grot-v1"; // 이 기기 rotationRate 축 규약(판정 결과)

function useSensorG(open: boolean, gps: GLive | null) {
  const st = useRef<SensorState>(newSensorState());
  const [view, setView] = useState<{
    g: GLive;
    env: number[];
    ready: boolean;
    peaks: GPeaks;
    sensor: boolean;

    held?: boolean;
    /** 맞추기 진행 — 짝 수·일치도·센서 이벤트 수(문제 찾기용 표시) */
    cal?: { pairs: number; corr: number; gg: number; motions: number; hz: number; skipWin: number; skipSmall: number; win: number };
  } | null>(null);
  const lastGpsT = useRef(0);

  // GPS G가 새로 오면: 같은 1초 구간의 센서 평균과 짝지어 폰–차 각도를 학습
  useEffect(() => {
    const s = st.current;
    if (!gps || gps.t == null || gps.t === lastGpsT.current) return;
    lastGpsT.current = gps.t;
    sensorGps(s, gps.lat, gps.lon, gps.t - performance.timeOrigin);
  }, [gps]);

  useEffect(() => {
    if (!open || typeof window === "undefined" || !("DeviceMotionEvent" in window)) return;
    const s = st.current;
    if (!s.rotMap) {
      const m = localStorage.getItem(ROT_KEY);
      if (m === "spec" || m === "chrome") s.rotMap = m;
    }
    if (!s.restore) {
      try {
        const j = JSON.parse(localStorage.getItem(CAL_KEY) ?? "null") as SavedCal | null;
        if (j && Array.isArray(j.up) && Number.isFinite(j.GG)) s.restore = j;
      } catch {}
    }
    let saveT = 0;
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      const ai: V3 = [a.x, a.y, a.z];
      // 측정 시각 — 처리가 밀려도 실제 측정 순간(같은 performance 시계)
      // 기기에 따라 timeStamp가 다른 시계(부팅 후 시간 등)라 5초 넘게 어긋나면 처리 시각을 쓴다
      const pnow = performance.now();
      const t = e.timeStamp > 0 && Math.abs(e.timeStamp - pnow) < 5000 ? e.timeStamp : pnow;
      const r = e.rotationRate;
      sensorMotion(
        s, t, ai,
        r && r.alpha != null && r.beta != null && r.gamma != null ? [r.alpha, r.beta, r.gamma] : null,
      );
    };
    window.addEventListener("devicemotion", onMotion);
    let rateN = s.motions, rateT = performance.now(), hz = 0, logT = 0;
    const iv = setInterval(() => {
      const now = performance.now();
      if (now - rateT >= 2000) { hz = Math.round(((s.motions - rateN) * 1000) / (now - rateT)); rateN = s.motions; rateT = now; }
      // 맞춘 각도 저장(10초마다) — 다음 주행은 거치 자세가 같으면 바로 실시간
      if (now - saveT >= 10_000) {
        saveT = now;
        if (s.rotMap) localStorage.setItem(ROT_KEY, s.rotMap);
        const c = saveCal(s);
        if (c) {
          s.restore = c;
          try {
            localStorage.setItem(CAL_KEY, JSON.stringify(c));
          } catch {}
        }
      }
      // 개발자 기록 — 1초마다 추정기 상태(켜져 있을 때만 실제로 쌓인다)
      if (now - logT >= 1000) {
        logT = now;
        const r2 = (v: number) => Math.round(v * 100) / 100;
        devlog("g", {
          ready: s.GG >= CAL_MIN_GG && now - s.liveTs < 2000, hz, pairs: s.pairs, resets: s.resets,
          held: now < s.badUntil, show: [r2(s.show.lat), r2(s.show.lon)], bias: [r2(s.bias.lat), r2(s.bias.lon)],
          peaks: [r2(s.peaks.accel), r2(s.peaks.brake), r2(s.peaks.left), r2(s.peaks.right)],
          corr: r2(calCorr(s).corr), mir: calCorr(s).mir,
          up: s.upSlow?.map(r2), pend: s.pending.length, restored: s.restored, rot: s.rotMap,
        });
      }
      const ready = st.current.GG >= CAL_MIN_GG && performance.now() - st.current.liveTs < 2000;
      setView(
        ready
          ? {
              g: { ...st.current.show },
              env: st.current.env.slice(),
              ready: true,
              peaks: { ...st.current.peaks },
              sensor: true,
              held: performance.now() < st.current.badUntil,
            }
          : {
              g: { lat: 0, lon: 0 },
              env: st.current.env.slice(),
              ready: false,
              peaks: { ...st.current.peaks },
              sensor: st.current.up != null,
              cal: {
                pairs: st.current.pairs,
                gg: st.current.GG,
                motions: st.current.motions,
                hz,
                skipWin: st.current.skip.win,
                skipSmall: st.current.skip.small,
                win: st.current.win.filter((p) => p.t >= (st.current.win.at(-1)?.t ?? 0) - 1000).length,
                corr: calCorr(st.current).corr,
              },
            },
      );
    }, 66);
    return () => {
      window.removeEventListener("devicemotion", onMotion);
      clearInterval(iv);
    };
  }, [open]);
  return view;
}

export default function GForcePanel({
  open,
  onToggle,
  g,
  peaks,
  zero50Sec,
  maxKmh,
  kmh = 0,
  gpsEnv,
}: {
  open: boolean;
  onToggle: () => void;

  g: GLive | null;
  peaks: GPeaks;
  zero50Sec: number | null;
  maxKmh: number;
  /** 지금 속도 — 멈춰 있으면 방향을 맞출 수 없다는 안내용 */
  kmh?: number;
  /** GPS로 쌓은 방향별 최대 G — 센서가 없어도 도형을 그린다 */
  gpsEnv?: number[];
}) {
  const sensor = useSensorG(open, g);
  const vehicle = usePleosFeed().feed?.vehicle;
  useEffect(() => {
    window.DriveNative?.setGForceOpen?.(open);
    return () => window.DriveNative?.setGForceOpen?.(false);
  }, [open]);
  const live = sensor?.ready ? sensor.g : (g ?? { lat: 0, lon: 0 });
  // 방향별 최대 G 도형 — 센서가 꺼져 있어도 GPS 값으로 쌓인다(useSensorG가 둘 다 기록)
  const raw = new Array(BINS).fill(0).map((_, i) => Math.max(sensor?.env?.[i] ?? 0, gpsEnv?.[i] ?? 0));
  const env = fillEnv(raw);
  const pk: GPeaks = sensor
    ? {
        accel: Math.max(peaks.accel, sensor.peaks.accel),
        brake: Math.max(peaks.brake, sensor.peaks.brake),
        left: Math.max(peaks.left, sensor.peaks.left),
        right: Math.max(peaks.right, sensor.peaks.right),
      }
    : peaks;
  const c = sensor?.cal;
  const status = sensor?.ready
    ? sensor.held
      ? "센서 실시간"
      : "센서 실시간"
    : sensor?.sensor
      ? // 폰이 앞을 어느 쪽으로 보고 있는지는 GPS로 잰 가속·회전과 맞춰 봐야 안다 —
        // 멈춰 있으면 맞출 거리가 없어 계속 "맞추는 중"으로 보였다
        kmh < 5
        ? "멈춤"
        : "방향 맞추는 중"
      : "GPS 1초 갱신";

  const pos = (v: { lat: number; lon: number }) => {
    let x = (v.lat / MAX_G) * R;
    let y = (-v.lon / MAX_G) * R;
    const r = Math.hypot(x, y);
    if (r > R) {
      x = (x / r) * R;
      y = (y / r) * R;
    }
    return { x, y };
  };
  const dot = pos(live);
  // 방향별 최대값을 36칸 곡선으로 — 속이 빈 찌그러진 원(많이 쓴 방향으로 늘어남)
  const envPts = env.map((m, i) => {
    const a = ((i + 0.5) / BINS) * 2 * Math.PI; // 칸 가운데 방향
    return pos({ lat: m * Math.sin(a), lon: m * Math.cos(a) });
  });
  const hasEnv = raw.filter((m) => m > 0).length >= 2;
  // GPS(1초)일 때만 점을 미끄러지게 — 센서는 자체로 부드럽다
  const glide = sensor?.ready ? "none" : "cx 0.9s linear, cy 0.9s linear";

  return (
    <div
      data-over-map
      data-g-lat={live.lat.toFixed(3)}
      data-g-lon={live.lon.toFixed(3)}
      data-g-mode={sensor?.ready ? "sensor" : "gps"}
      data-g-panel
      className={`pointer-events-none fixed right-0 top-1/2 z-50 flex max-h-[calc(100dvh-16px)] -translate-y-1/2 items-start ${
        open ? "translate-x-0" : "translate-x-[calc(100%-64px)]"
      }`}
    >
      {/* 꺼내기 탭 */}
      <button data-over-map
        type="button"
        onClick={onToggle}
        aria-label={open ? "G-Force 닫기" : "G-Force 열기"}
        className="pointer-events-auto relative -top-[134px] flex h-16 w-16 flex-col self-center items-center justify-center rounded-l-lg bg-panel text-[11px] font-black text-primary ring-1 ring-line"
      >
        <span className="text-[15px] leading-none">G</span>
        <span className="mt-1 text-secondary">{open ? "›" : "‹"}</span>
      </button>

      <div data-over-map className="pointer-events-auto max-h-[calc(100dvh-16px)] w-[236px] overflow-y-auto rounded-l-lg bg-bg p-3 text-primary ring-1 ring-line">
        <div className="rounded-md bg-panel p-3">
          <div className="flex items-baseline justify-between">
            <span className="text-[13px] font-semibold">G-Force</span>
            <span className={`text-[10px] ${sensor?.ready ? "text-ok" : "text-secondary"}`}>{status}</span>
          </div>
          {/* 원판 — 0.25G 간격 고리, 네 방향에 이번 주행 최고값 */}
          <div className="relative mx-auto mt-1 h-[164px] w-[200px]">
            <span className="absolute left-1/2 top-0 -translate-x-1/2 text-[10px] tabular-nums text-secondary">
              가속 {fmt(pk.accel)}G
            </span>
            <span className="absolute bottom-0 left-1/2 -translate-x-1/2 text-[10px] tabular-nums text-secondary">
              제동 {fmt(pk.brake)}G
            </span>
            <span className="absolute left-0 top-1/2 -translate-y-1/2 text-center text-[10px] leading-tight tabular-nums text-secondary">
              좌<br />
              {fmt(pk.left)}
            </span>
            <span className="absolute right-0 top-1/2 -translate-y-1/2 text-center text-[10px] leading-tight tabular-nums text-secondary">
              우<br />
              {fmt(pk.right)}
            </span>
            <svg viewBox="-82 -82 164 164" className="absolute inset-x-[30px] inset-y-[14px]">
              {/* 바깥 눈금 테두리 */}
              {Array.from({ length: 72 }, (_, i) => {
                const a = (i / 72) * Math.PI * 2;
                const r1 = R + 3, r2 = R + (i % 6 === 0 ? 8 : 5.5);
                return (
                  <line
                    key={`t${i}`}
                    x1={Math.cos(a) * r1}
                    y1={Math.sin(a) * r1}
                    x2={Math.cos(a) * r2}
                    y2={Math.sin(a) * r2}
                    stroke="#52525b"
                    strokeWidth={i % 6 === 0 ? 1 : 0.6}
                  />
                );
              })}
              {[0.25, 0.5, 0.75, 1].map((r) => (
                <circle
                  key={r}
                  r={r * R}
                  fill="none"
                  stroke={r === 1 ? "#52525b" : "#3f3f46"}
                  strokeWidth={r === 1 ? 1.2 : 0.8}
                />
              ))}
              <line x1={-R} y1={0} x2={R} y2={0} stroke="#3f3f46" strokeWidth={0.8} />
              <line x1={0} y1={-R} x2={0} y2={R} stroke="#3f3f46" strokeWidth={0.8} />
              <text x={0.5 * R + 2} y={-3} fontSize={7} fill="#3b82f6">
                0.5G
              </text>
              {/* 이번 주행 방향별 최대 G — 속이 빈 도형(많이 쓴 방향으로 늘어난다) */}
              {hasEnv && (
                <polygon
                  points={envPts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}
                  fill="#3b82f6"
                  fillOpacity={0.12}
                  stroke="#3b82f6"
                  strokeWidth={1.4}
                  strokeLinejoin="round"
                />
              )}
              {hasEnv &&
                envPts.map((p, i) =>
                  raw[i] > 0 ? <circle key={i} cx={p.x} cy={p.y} r={1.3} fill="#60a5fa" /> : null,
                )}
              <circle cx={dot.x} cy={dot.y} r={9} fill="#ef4444" opacity={0.25} style={{ transition: glide }} />
              <circle
                cx={dot.x}
                cy={dot.y}
                r={4.5}
                fill="#ef4444"
                stroke="#fff"
                strokeWidth={1.5}
                style={{ transition: glide }}
              />
            </svg>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <div>
              <div className="text-[11px] text-secondary">
                코너링{Math.abs(live.lat) >= 0.005 && <span> {live.lat > 0 ? "우" : "좌"}</span>}
              </div>
              <div className="text-[26px] font-black italic tabular-nums leading-tight">
                {fmt(live.lat)}
                <span className="ml-1 text-[15px] not-italic">G</span>
              </div>
            </div>
            <div>
              <div className="text-[11px] text-secondary">{live.lon < 0 ? "감속" : "가속"}</div>
              <div className="text-[26px] font-black italic tabular-nums leading-tight">
                {fmt(live.lon)}
                <span className="ml-1 text-[15px] not-italic">G</span>
              </div>
            </div>
          </div>
        </div>

        <VehicleControls steeringDeg={vehicle?.steeringDeg ?? null} brake={vehicle?.brake ?? null} />

        {/* 런치컨트롤 자리 – 이번 주행 최고 0–50, 퍼포먼스 옵션 자리 – 최고속도 */}
        <div className="mt-2 grid grid-cols-2 gap-2">
          <div className="rounded-md bg-panel p-3">
            <div className="text-[11px] text-secondary">최고 0–50</div>
            <div className="mt-1 text-[20px] font-black tabular-nums">
              {zero50Sec != null ? (
                <>
                  {zero50Sec.toFixed(1)}
                  <span className="ml-1 text-[12px] font-semibold text-secondary">초</span>
                </>
              ) : (
                <span className="text-disabled">–</span>
              )}
            </div>
          </div>
          <div className="rounded-md bg-panel p-3">
            <div className="text-[11px] text-secondary">최고 속도</div>
            <div className="mt-1 text-[20px] font-black tabular-nums">
              {maxKmh > 0 ? (
                <>
                  {maxKmh}
                  <span className="ml-1 text-[12px] font-semibold text-secondary">km/h</span>
                </>
              ) : (
                <span className="text-disabled">–</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/** 기록 상세용 — 저장된 이번 주행 G(방향별 최대 도형 + 네 방향 최고값) */
export function GForceRecord({ g }: { g: { accel: number; brake: number; left: number; right: number; env?: number[]; source?: string } }) {
  const R2 = 60;
  const raw = g.env && g.env.length === G_BINS ? g.env : new Array(G_BINS).fill(0);
  const env = fillEnv(raw);
  const has = raw.filter((m) => m > 0).length >= 2;
  const maxR = Math.max(0.5, ...env, g.accel, g.brake, g.left, g.right); // 원 가장자리(최소 0.5G)
  const scale = Math.ceil(maxR * 4) / 4;
  const pts = env.map((m, i) => {
    const a = ((i + 0.5) / G_BINS) * 2 * Math.PI;
    return `${((m * Math.sin(a)) / scale * R2).toFixed(1)},${((-m * Math.cos(a)) / scale * R2).toFixed(1)}`;
  });
  const f = (v: number) => v.toFixed(2);
  return (
    <div className="flex items-center gap-4 rounded-md border border-line bg-raised p-4">
      <svg viewBox="-70 -70 140 140" className="h-36 w-36 shrink-0">
        {[0.25, 0.5, 0.75, 1].map((r) => (
          <circle key={r} r={r * R2} fill="none" stroke={r === 1 ? "#52525b" : "#3f3f46"} strokeWidth={r === 1 ? 1.2 : 0.8} />
        ))}
        <line x1={-R2} y1={0} x2={R2} y2={0} stroke="#3f3f46" strokeWidth={0.8} />
        <line x1={0} y1={-R2} x2={0} y2={R2} stroke="#3f3f46" strokeWidth={0.8} />
        {has && (
          <polygon points={pts.join(" ")} fill="#3b82f6" fillOpacity={0.15} stroke="#3b82f6" strokeWidth={1.6} strokeLinejoin="round" />
        )}
        <text x={2} y={-R2 - 2} fontSize={8} fill="#71717a">{scale.toFixed(2)}G</text>
      </svg>
      <div className="grid flex-1 grid-cols-2 gap-x-3 gap-y-2 text-[12px] text-secondary">
        <div className="col-span-2 flex items-baseline justify-between text-[13px] font-semibold text-primary">G-Force 최고<span className="text-[10px] font-normal text-secondary">{g.source === "sensor" ? "자이로 센서" : "GPS"}</span></div>
        {([["가속", g.accel], ["제동", g.brake], ["좌회전", g.left], ["우회전", g.right]] as const).map(([l, v]) => (
          <div key={l}>
            {l}
            <div className="text-[17px] font-bold tabular-nums text-primary">
              {f(v)}
              <span className="ml-1 text-[11px] font-normal text-secondary">G</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}


export function VehicleControls({ steeringDeg, brake }: { steeringDeg: number | null; brake: boolean | null }) {
  const angle = Math.max(-90, Math.min(90, steeringDeg ?? 0));
  return (
    <div className="mt-2 flex items-center justify-between rounded-md bg-panel p-3 text-[12px]">
      <div className="text-primary">
        <svg viewBox="-45 -40 90 48" className="h-12 w-24 text-secondary" aria-hidden="true">
          <path d="M-35 0 A35 35 0 0 1 35 0" fill="none" stroke="currentColor" strokeWidth="2" />
          {steeringDeg !== null && <line x1="0" y1="0" x2="0" y2="-31" transform={`rotate(${angle})`} stroke="var(--color-accent)" strokeWidth="3" />}
        </svg>
        <span>{steeringDeg === null ? "조향 –" : `조향 ${Math.round(steeringDeg)}°`}</span>
      </div>
      <span role="status" aria-label={brake === null ? "제동 정보 없음" : brake ? "제동 중" : "제동 해제"}
        className={`rounded-sm border px-3 py-2 font-semibold ${brake === true ? "border-accent bg-accent-surface text-accent-text" : "border-line text-secondary"}`}>
        제동{brake === null ? " –" : ""}
      </span>
    </div>
  );
}
