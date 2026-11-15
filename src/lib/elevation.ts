import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { distanceM } from "@/lib/scoring/curvature";
import type { LatLng } from "@/lib/types";

/**
 * Copernicus GLO-30 기반 고도 조회 (scripts/build-dem.mjs 산출물).
 * 타일: int16 LE 1200×1200, 셀 1/1200°, 행 0 = 타일 북쪽 끝, 바다/결측 = 0.
 * DSM(수관 포함)이라 숲에선 지면보다 +10~25m 높게 나올 수 있다 — 배지/그래프
 * 용도로는 충분하고, 정밀 측량 용도가 아니다.
 */

const DEM_DIR = join(process.cwd(), "src/lib/data/dem");
const N = 1200;

// 타일 캐시 — 전국 20여 장 × 2.9MB라 전부 올라와도 ~60MB
const tiles = new Map<string, Int16Array | null>();
function loadTile(latF: number, lngF: number): Int16Array | null {
  const key = `N${latF}E${lngF}`;
  const hit = tiles.get(key);
  if (hit !== undefined) return hit;
  let t: Int16Array | null = null;
  try {
    const buf = readFileSync(join(DEM_DIR, `${key}.bin`));
    if (buf.byteLength === N * N * 2) {
      t = new Int16Array(buf.buffer, buf.byteOffset, N * N);
    }
  } catch {
    t = null; // 바다 타일이거나 DEM 미구축
  }
  tiles.set(key, t);
  return t;
}

/** 지점 고도(m). 데이터 없으면 null. 쌍선형 보간. */
export function elevationAt(p: LatLng): number | null {
  const latF = Math.floor(p.lat);
  const lngF = Math.floor(p.lng);
  const t = loadTile(latF, lngF);
  if (!t) return null;
  // 행 0 = 북쪽 끝 (lat = latF+1), 열 0 = 서쪽 끝
  const r = (latF + 1 - p.lat) * N - 0.5;
  const c = (p.lng - lngF) * N - 0.5;
  const r0 = Math.min(Math.max(Math.floor(r), 0), N - 2);
  const c0 = Math.min(Math.max(Math.floor(c), 0), N - 2);
  const fr = Math.min(Math.max(r - r0, 0), 1);
  const fc = Math.min(Math.max(c - c0, 0), 1);
  const v00 = t[r0 * N + c0];
  const v01 = t[r0 * N + c0 + 1];
  const v10 = t[(r0 + 1) * N + c0];
  const v11 = t[(r0 + 1) * N + c0 + 1];
  return (
    v00 * (1 - fr) * (1 - fc) +
    v01 * (1 - fr) * fc +
    v10 * fr * (1 - fc) +
    v11 * fr * fc
  );
}

export interface ElevationProfile {
  /** 경로를 따라 등간격 샘플한 고도(m) 배열 */
  samples: number[];

  stepM: number;
  maxEle: number;
  minEle: number;
  /** 오르막 누적(m) — 노이즈 완화를 위해 10m 문턱 초과분만 */
  gainM: number;
}

/**
 * 경로 종단면. 카드 그래프용으로 샘플 수를 targetSamples 근처로 맞춘다.
 * DEM 미구축이면 null.
 */
export function elevationProfile(
  path: LatLng[],
  targetSamples = 120,
): ElevationProfile | null {
  if (path.length < 2) return null;
  let totalM = 0;
  for (let i = 1; i < path.length; i++) totalM += distanceM(path[i - 1], path[i]);
  if (totalM < 1000) return null;
  const stepM = Math.max(200, Math.round(totalM / targetSamples / 100) * 100);

  const samples: number[] = [];
  let carry = 0;
  const push = (p: LatLng) => {
    const e = elevationAt(p);
    samples.push(e === null ? 0 : Math.round(e));
    return e !== null;
  };
  let anyData = push(path[0]);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = distanceM(a, b);
    if (seg <= 0) continue;
    let d = stepM - carry;
    while (d <= seg) {
      const t = d / seg;
      if (push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }))
        anyData = true;
      d += stepM;
    }
    carry = seg - (d - stepM);
  }
  if (!anyData || samples.length < 2) return null;

  let maxEle = -Infinity,
    minEle = Infinity;
  for (const e of samples) {
    if (e > maxEle) maxEle = e;
    if (e < minEle) minEle = e;
  }
  // 오르막 누적 — 국지 최저점–최고점 상승분이 10m 넘는 것만 합산 (보간 노이즈 제거)
  let gainM = 0;
  let base = samples[0];
  let peak = samples[0];
  for (const e of samples) {
    if (e < peak - 10) {
      if (peak - base > 10) gainM += peak - base;
      base = e;
      peak = e;
    } else if (e > peak) {
      peak = e;
    } else if (e < base) {
      base = e;
    }
  }
  if (peak - base > 10) gainM += peak - base;

  return { samples, stepM, maxEle, minEle, gainM };
}

/** 경로 최고 고도(m) — 배지용 (프로필보다 성긴 500m 간격). null = 데이터 없음 */
export function maxElevation(path: LatLng[]): number | null {
  const prof = elevationProfile(path, 60);
  return prof ? prof.maxEle : null;
}
