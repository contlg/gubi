import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { distanceM, resamplePath } from "@/lib/scoring/curvature";
import type { CoastSample, LatLng, RouteMetrics } from "@/lib/types";

/**
 * 로컬 도로 지표 — 전국 OSM 프리빌드 데이터로 route-metrics를 계산한다.
 * osm.ts의 Overpass 버전(공용 서버 2콜, 느리고 자주 "계속 계산 중"에 걸림)을
 * 대체한다. 네트워크 0콜이라 후보 3개도 수십 ms에 끝난다. 판정 반경·상수는
 * osm.ts와 동일하게 맞춰 점수 일관성을 유지한다.
 *
 * 데이터(모두 scripts/build-*-from-osm.mjs 산출물):
 *  - coastline-points.json  해안선 점(100m) – 바닷가/바다뷰 거리 판정
 *  - river-points.json      강 점(200m)     – 강변 비율
 *  - peak-points.json       봉우리 노드     – 봉우리 밀도
 *  - signals.json           신호등 노드     – 신호 밀도
 *  - tunnel-points.json     터널 도로 점    – 터널 비율
 *  - bridge-points.json     교량(200m+) 중점 – 교량 수(dual=상하행 0.5)
 */

const SEA_SHORE_M = 150;
const SEA_VIEW_M = 450;
const RIVER_RADIUS_M = 300;
const PEAK_RADIUS_M = 1500;
const SIGNAL_RADIUS_M = 100;
const BRIDGE_RADIUS_M = 300;
const TUNNEL_RADIUS_M = 80;
const MAX_COARSE_SAMPLES = 100;
const MAX_FINE_SAMPLES = 150;

const DATA = (f: string) => join(process.cwd(), "src/lib/data", f);

const CELL = 0.005;
const OFFSET = 2_000_000_000;
const gkey = (lat: number, lng: number) =>
  Math.floor(lat / CELL) * 100000 + Math.floor(lng / CELL) + OFFSET;
/** 셀 크기(위도 기준 ~555m)로 반경을 덮는 데 필요한 셀 반경 */
const cellSpan = (radiusM: number) => Math.max(1, Math.ceil(radiusM / (CELL * 111_000)));

type Grid = Map<number, number[][]>;

function loadGrid(file: string): Grid {
  const g: Grid = new Map();
  try {
    const arr = JSON.parse(readFileSync(DATA(file), "utf8")) as number[][];
    for (const e of arr) {
      const k = gkey(e[0], e[1]);
      const cell = g.get(k);
      if (cell) cell.push(e);
      else g.set(k, [e]);
    }
  } catch {
    // 데이터 없으면 빈 격자 — 해당 지표는 0으로 나온다
  }
  return g;
}

// 지연 로드 싱글턴 (프로세스 생존 동안 캐시)
const grids: Record<string, Grid | undefined> = {};
function grid(file: string): Grid {
  return (grids[file] ??= loadGrid(file));
}

/** p에서 격자 내 최단 점 거리(m). capM 안에 없으면 capM */
function minDist(g: Grid, p: LatLng, capM: number): number {
  if (g.size === 0) return capM;
  const span = cellSpan(capM);
  const ci = Math.floor(p.lat / CELL);
  const cj = Math.floor(p.lng / CELL);
  let min = capM;
  for (let a = ci - span; a <= ci + span; a++) {
    for (let b = cj - span; b <= cj + span; b++) {
      const cell = g.get(a * 100000 + b + OFFSET);
      if (!cell) continue;
      for (const e of cell) {
        const d = distanceM(p, { lat: e[0], lng: e[1] });
        if (d < min) min = d;
      }
    }
  }
  return min;
}

/** p의 radiusM 안에 점이 하나라도 있으면 true (minDist의 cap==radius 오판 방지) */
function withinDist(g: Grid, p: LatLng, radiusM: number): boolean {
  if (g.size === 0) return false;
  const span = cellSpan(radiusM);
  const ci = Math.floor(p.lat / CELL);
  const cj = Math.floor(p.lng / CELL);
  for (let a = ci - span; a <= ci + span; a++) {
    for (let b = cj - span; b <= cj + span; b++) {
      const cell = g.get(a * 100000 + b + OFFSET);
      if (!cell) continue;
      for (const e of cell) {
        if (distanceM(p, { lat: e[0], lng: e[1] }) <= radiusM) return true;
      }
    }
  }
  return false;
}

/** samples 중 하나라도 radiusM 안에 있는 고유 점 개수 (osm의 node 카운트와 동일) */
function countUniqueNear(g: Grid, samples: LatLng[], radiusM: number): number {
  if (g.size === 0) return 0;
  const span = cellSpan(radiusM);
  const seen = new Set<string>();
  for (const s of samples) {
    const ci = Math.floor(s.lat / CELL);
    const cj = Math.floor(s.lng / CELL);
    for (let a = ci - span; a <= ci + span; a++) {
      for (let b = cj - span; b <= cj + span; b++) {
        const cell = g.get(a * 100000 + b + OFFSET);
        if (!cell) continue;
        for (const e of cell) {
          if (distanceM(s, { lat: e[0], lng: e[1] }) <= radiusM) seen.add(`${e[0]},${e[1]}`);
        }
      }
    }
  }
  return seen.size;
}

/** 교량: samples 근처 고유 교량 중점의 가중합 (dual=상하행 0.5), 반올림 */
function bridgeCountNear(g: Grid, samples: LatLng[], radiusM: number): number {
  if (g.size === 0) return 0;
  const span = cellSpan(radiusM);
  const seen = new Map<string, number>();
  for (const s of samples) {
    const ci = Math.floor(s.lat / CELL);
    const cj = Math.floor(s.lng / CELL);
    for (let a = ci - span; a <= ci + span; a++) {
      for (let b = cj - span; b <= cj + span; b++) {
        const cell = g.get(a * 100000 + b + OFFSET);
        if (!cell) continue;
        for (const e of cell) {
          if (distanceM(s, { lat: e[0], lng: e[1] }) <= radiusM) seen.set(`${e[0]},${e[1]}`, e[2] ?? 0);
        }
      }
    }
  }
  let sum = 0;
  for (const dual of seen.values()) sum += dual ? 0.5 : 1;
  return Math.round(sum);
}

function pathLengthM(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i]);
  return total;
}

const cache = new Map<string, RouteMetrics>();
const CACHE_MAX = 300;
function cacheKey(samples: LatLng[]): string {
  return samples.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";");
}

const EMPTY: RouteMetrics = {
  seaShoreRatio: 0,
  seaViewRatio: 0,
  coast: [],
  riverRatio: 0,
  peaksPerKm: 0,
  signalsPerKm: 0,
  tunnelRatio: 0,
  bridgeCount: 0,
};

/** 로컬 데이터만으로 도로 지표를 계산한다 (동기, 네트워크 0콜). */
export function routeMetricsLocal(path: LatLng[]): RouteMetrics {
  if (path.length < 2) return EMPTY;
  const totalM = pathLengthM(path);
  if (totalM <= 0) return EMPTY;

  const coarse = resamplePath(path, Math.max(3000, totalM / MAX_COARSE_SAMPLES));
  const key = cacheKey(coarse);
  const cached = cache.get(key);
  if (cached) return cached;

  const fine = resamplePath(path, Math.max(1000, totalM / MAX_FINE_SAMPLES));
  const coastFine = resamplePath(path, Math.max(500, totalM / 300));
  const dense = resamplePath(path, 60);
  const km = totalM / 1000;

  // 해안 — 각 촘촘 샘플에서 해안선까지 실제 거리로 바닷가/바다뷰 판정
  const cg = grid("coastline-points.json");
  let shoreCount = 0;
  let viewCount = 0;
  const coast: CoastSample[] = [];
  for (const p of coastFine) {
    const d = minDist(cg, p, SEA_VIEW_M + 50);
    if (d <= SEA_SHORE_M) {
      shoreCount++;
      coast.push({ lat: p.lat, lng: p.lng, tier: 2 });
    } else if (d <= SEA_VIEW_M) {
      viewCount++;
      coast.push({ lat: p.lat, lng: p.lng, tier: 1 });
    }
  }

  // 강 — 성긴 샘플 중 강 300m 이내 비율
  const rg = grid("river-points.json");
  let riverNear = 0;
  for (const p of coarse) if (withinDist(rg, p, RIVER_RADIUS_M)) riverNear++;

  // 터널 — 촘촘(60m) 경로 점 중 터널 위 비율 ≈ 터널 길이 비율
  const tg = grid("tunnel-points.json");
  let inTunnel = 0;
  for (const p of dense) if (withinDist(tg, p, TUNNEL_RADIUS_M)) inTunnel++;

  const peakCount = countUniqueNear(grid("peak-points.json"), coarse, PEAK_RADIUS_M);
  const signalCount = countUniqueNear(grid("signals.json"), fine, SIGNAL_RADIUS_M);
  const bridgeCount = bridgeCountNear(grid("bridge-points.json"), fine, BRIDGE_RADIUS_M);

  const metrics: RouteMetrics = {
    seaShoreRatio: coastFine.length ? shoreCount / coastFine.length : 0,
    seaViewRatio: coastFine.length ? viewCount / coastFine.length : 0,
    coast,
    riverRatio: coarse.length ? riverNear / coarse.length : 0,
    peaksPerKm: km > 0 ? peakCount / km : 0,
    signalsPerKm: km > 0 ? signalCount / km : 0,
    tunnelRatio: dense.length ? inTunnel / dense.length : 0,
    bridgeCount,
  };

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, metrics);
  return metrics;
}
