import "server-only";

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { nearestLinkSpeedKmh } from "@/lib/its-speed";
import { pathSpeedProfile } from "@/lib/localroute";
import { nearbyNodelinks } from "@/lib/nodelink";
import type { LatLng } from "@/lib/types";

/**
 * 시간대별 "보통 걸리는 시간" 표 — 지역(수도권/그 밖) × 도로 묶음(고속/간선/그 밖) × 요일(평일/토/일) × 24시.
 * 값은 한산할 때를 1로 둔 km당 시간 배율. 카카오는 긴 코스의 뒤쪽 구간을 "도착할 때쯤"의 교통으로
 * 계산한다(11-14 확인: 같은 구간을 "지금 출발"로 따로 물으면 11~47% 더 길다). 그래서 지금 ITS 시간에
 * (도착 시각 값 ÷ 지금 시각 값)을 곱한다. 파일이 없으면 곱하지 않는다.
 * 만드는 법: scripts/nav-eval/build-its-forecast.mjs.
 */
type ForecastDay = "weekday" | "sat" | "sun";
type ForecastTable = Record<string, Record<ForecastDay, number[]>>;
const FORECAST_PATH = join(process.cwd(), "src/lib/data/its-forecast.json");
let forecastCache: ForecastTable | null = null;
let forecastCheckedAt = 0;
let forecastMtime = 0;
function forecastTable(): ForecastTable | null {
  const now = Date.now();
  if (now - forecastCheckedAt > 300_000) {
    forecastCheckedAt = now;
    try {
      const mt = statSync(FORECAST_PATH).mtimeMs;
      if (mt !== forecastMtime) {
        forecastMtime = mt;
        forecastCache = JSON.parse(readFileSync(FORECAST_PATH, "utf8")).groups ?? null;
      }
    } catch {
      forecastCache = null;
    }
  }
  return forecastCache;
}

/** 수도권(서울·인천·경기 대부분을 덮는 네모)은 하루 중 교통 변화가 훨씬 커서 표를 따로 둔다. build-its-forecast.mjs와 같아야 한다. */
const forecastGroup = (rank: number, p: LatLng) =>
  `${p.lat >= 37.0 && p.lat <= 37.9 && p.lng >= 126.5 && p.lng <= 127.5 ? "m" : "r"}-${rank === 1 ? "hw" : rank <= 3 ? "art" : "loc"}`;

/** 표에서 그 시각(ms)의 값. 정시 값 사이는 곧게 이어서 읽는다(요일이 바뀌는 자정도 이어진다). */
function forecastPaceAt(rows: Record<ForecastDay, number[]>, ms: number): number {
  const at = (t: number) => {
    const kst = new Date(t + 9 * 3_600_000);
    const dow = kst.getUTCDay();
    return rows[dow === 0 ? "sun" : dow === 6 ? "sat" : "weekday"]?.[kst.getUTCHours()] ?? 1;
  };
  const frac = (((ms % 3_600_000) + 3_600_000) % 3_600_000) / 3_600_000;
  return at(ms) * (1 - frac) + at(ms + 3_600_000) * frac;
}

const envNum = (name: string, fallback: number) => {
  const v = Number(process.env[name]);
  return process.env[name] !== undefined && Number.isFinite(v) ? v : fallback;
};
/** ITS가 시속 10km보다 느리다고 한 곳은 10km로 본다(신호 대기 같은 순간값이 구간 전체로 번지는 것을 막는다). */
const ITS_FLOOR_KMH = envNum("ETA_ITS_FLOOR_KMH", 10);
const SAMPLE_M = Math.max(10, envNum("ETA_SAMPLE_M", 50));
const USE_FORECAST = process.env.ETA_FORECAST !== "0";

const dM = (a: LatLng, b: LatLng) => {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx);
};

/**
 * 경로 소요시간(초) — 화면에 보이는 코스 시간용.
 * integrateSpeedProfile(400m마다 한 번)보다 촘촘히(50m) ITS 속도를 읽고, 아주 느린 값에 바닥을 두고,
 * 출발 뒤 흐른 시간만큼 뒤 구간에는 그 시각의 보통 교통(시간대 표)을 반영한다.
 * ITS가 없는 구간은 예전과 같이 도로 종류 속도 × fallbackCalibMul.
 * 검증(11-14 토 저녁, 카카오가 간 길 기준): 단거리 86개 평균 오차 8.7→6.1%, 긴 코스 3개 +14/+4/+17% → -3/-5/+2%.
 */
export function pathEtaSec(
  path: LatLng[],
  fallbackCalibMul: number,
  departMs = Date.now(),
): number | null {
  if (path.length < 2) return null;
  const table = USE_FORECAST ? forecastTable() : null;
  // ITS가 없는 곳에 쓸 도로 종류 속도 — 예전 방식의 표본(약 400m 간격)을 그대로 쓴다.
  const profile = pathSpeedProfile(path);
  let p = 0;
  let sec = 0;
  let known = 0;
  for (let i = 1; i < path.length; i++) {
    while (p < profile.length - 1 && profile[p + 1].i <= i - 1) p++;
    const a = path[i - 1], b = path[i];
    const len = dM(a, b);
    if (len <= 0) continue;
    const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const heading = (Math.atan2((b.lng - a.lng) * kx, (b.lat - a.lat) * 110_540) * 180) / Math.PI;
    const n = Math.max(1, Math.round(len / SAMPLE_M));
    const part = len / n;
    for (let k = 0; k < n; k++) {
      const t = (k + 0.5) / n;
      const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      const its = nearestLinkSpeedKmh(point, heading);
      if (its !== null) {
        const kmh = Math.min(130, Math.max(its, ITS_FLOOR_KMH, 5));
        let mul = 1;
        if (table) {
          const rank = nearbyNodelinks(point, heading, 70, 60)[0]?.rank;
          const rows = rank ? table[forecastGroup(rank, point)] : undefined;
          if (rows) {
            const nowPace = forecastPaceAt(rows, departMs);
            const thenPace = forecastPaceAt(rows, departMs + sec * 1000);
            if (nowPace > 0) mul = Math.max(0.5, Math.min(2, thenPace / nowPace));
          }
        }
        sec += (part / (kmh / 3.6)) * mul;
        known++;
        continue;
      }
      const base = profile[p];
      if (base && !base.its) {
        sec += (part / (Math.max(base.kmh, 5) / 3.6)) * fallbackCalibMul;
        known++;
      } else {
        // 도로 종류를 못 읽은 짧은 틈은 시속 50km로 채운다(0초로 빠지지 않게).
        sec += (part / (50 / 3.6)) * fallbackCalibMul;
      }
    }
  }
  return known > 0 ? sec : null;
}
