import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { adminDongAt } from "@/lib/admdong";
import { distanceM, resamplePath } from "@/lib/scoring/curvature";
import type { CoastSample, LatLng, RouteMetrics, SpecialRanges } from "@/lib/types";
import { allRiversideSegments, allWindingSegments } from "@/lib/winding";

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

/** 특별 구간 판정 — 20m 간격 표본, 굽잇길·강변길 재고 30m 안, 400m 미만 끊김은 잇고 1km 미만은 버림 */
const SPECIAL_STEP_M = 20;
const SPECIAL_NEAR_M = 30;
const SPECIAL_GAP_M = 400;
const SPECIAL_MIN_M = 1000;
const WINDING_SPECIAL_DEG = 150;

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

/** 구간 재고(와인딩·강변)의 점들로 만든 격자 — 이미 읽어 둔 재고를 쓴다 */
function segmentGrid(key: string, pick: () => { pts: [number, number][] }[]): Grid {
  const hit = grids[key];
  if (hit) return hit;
  const g: Grid = new Map();
  try {
    for (const s of pick()) {
      for (const e of s.pts) {
        const k = gkey(e[0], e[1]);
        const cell = g.get(k);
        if (cell) cell.push(e);
        else g.set(k, [e]);
      }
    }
  } catch {
    // 재고 없음 — 그 구간은 비어 나온다
  }
  return (grids[key] = g);
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

/** 표시(flag)된 20m 표본을 거리 구간으로 — 짧은 끊김은 잇고 짧은 조각은 버린다 */
function flagRuns(flags: boolean[], stepM: number): [number, number][] {
  const out: [number, number][] = [];
  let start = -1;
  let last = -1;
  for (let i = 0; i < flags.length; i++) {
    if (!flags[i]) continue;
    if (start < 0) start = i;
    else if ((i - last) * stepM > SPECIAL_GAP_M) {
      out.push([start * stepM, last * stepM]);
      start = i;
    }
    last = i;
  }
  if (start >= 0) out.push([start * stepM, last * stepM]);
  return out.filter(([a, b]) => b - a >= SPECIAL_MIN_M);
}

/** 코스 위 와인딩·해안·강변 구간(출발부터 m) — 지도 색칠과 구간 길이 표시용 */
function specialRanges(path: LatLng[]): SpecialRanges {
  const pts = resamplePath(path, SPECIAL_STEP_M);
  const wg = segmentGrid("special:winding", () =>
    allWindingSegments().filter((s) => s.degPerKm >= WINDING_SPECIAL_DEG),
  );
  const rg = segmentGrid("special:river", allRiversideSegments);
  const cg = grid("coastline-points.json");
  return {
    winding: flagRuns(pts.map((p) => withinDist(wg, p, SPECIAL_NEAR_M)), SPECIAL_STEP_M),
    coast: flagRuns(pts.map((p) => withinDist(cg, p, SEA_SHORE_M)), SPECIAL_STEP_M),
    river: flagRuns(pts.map((p) => withinDist(rg, p, SPECIAL_NEAR_M)), SPECIAL_STEP_M),
  };
}

type LandmarkKind = "island" | "peak" | "beach" | "water" | "sight";
type NameFor = "coast" | "winding" | "river" | "far";
/** 코스 종류별로 먼저 찾는 지명 종류 — 해안은 섬·해변, 와인딩은 산, 강변은 강·호수 */
const LANDMARK_ORDER: Record<NameFor, LandmarkKind[]> = {
  coast: ["island", "beach", "sight", "water"],
  winding: ["peak", "water", "island", "sight"],
  river: ["water", "island", "sight", "peak"],
  far: ["island", "beach", "sight", "water"],
};
/** 지명이 코스에서 이만큼 안에 있어야 쓴다(m). 섬은 클수록 멀리까지(대부도 같은 큰 섬 안 도로) */
function landmarkReach(kind: LandmarkKind, size: number): number {
  if (kind === "island") return 1500 + Math.sqrt(Math.max(0, size)) * 600;
  if (kind === "peak") return 3000;
  if (kind === "water") return 1500;
  return 1500;
}
function landmarkLabel(name: string): string {
  // "을왕리해수욕장(Eulwangri Beach)" → "을왕리해수욕장", "화악산 상봉" → "화악산"
  const base = name.replace(/\s*\(.*\)\s*$/, "").trim();
  const first = base.split(" ")[0];
  return /(산|봉)$/.test(first) && first.length >= 2 ? first : base;
}

/** 코스 조각 근처의 이름난 곳(섬·산·해변·호수/강·명소) — 종류 우선순위, 같은 종류면 큰 것 */
function landmarkNear(points: LatLng[], forKind: NameFor): string | undefined {
  const g = grid("landmarks.json");
  if (g.size === 0 || points.length === 0) return undefined;
  const order = LANDMARK_ORDER[forKind];
  let lat0 = Infinity, lat1 = -Infinity, lng0 = Infinity, lng1 = -Infinity;
  for (const p of points) {
    lat0 = Math.min(lat0, p.lat); lat1 = Math.max(lat1, p.lat);
    lng0 = Math.min(lng0, p.lng); lng1 = Math.max(lng1, p.lng);
  }
  const padDeg = 0.08;
  let best: { rank: number; size: number; d: number; name: string } | null = null;
  for (let a = Math.floor((lat0 - padDeg) / CELL); a <= Math.floor((lat1 + padDeg) / CELL); a++) {
    for (let b = Math.floor((lng0 - padDeg) / CELL); b <= Math.floor((lng1 + padDeg) / CELL); b++) {
      for (const e of g.get(a * 100000 + b + OFFSET) ?? []) {
        const kind = e[2] as unknown as LandmarkKind;
        const rank = order.indexOf(kind);
        if (rank < 0) continue;
        const size = Number(e[4]) || 0;
        const reach = landmarkReach(kind, size);
        let d = Infinity;
        for (const p of points) d = Math.min(d, distanceM(p, { lat: e[0], lng: e[1] }));
        if (d > reach) continue;
        const name = landmarkLabel(String(e[3]));
        if (!name) continue;
        if (!best || rank < best.rank || (rank === best.rank && (size > best.size || (size === best.size && d < best.d))))
          best = { rank, size, d, name };
      }
    }
  }
  return best?.name;
}

/**
 * 행정동 이름으로 — 번호 동만 번호와 "동"을 뗀다("송도3동"→"송도"). 번호 없는 동·읍·면은
 * 그대로 둔다("대부동", "청평면"). "남면"처럼 흔한 이름은 시·군을 붙인다("홍천 남면").
 */
function dongPlace(p: LatLng): string | undefined {
  const ad = adminDongAt(p);
  if (!ad?.dong) return undefined;
  const dong = ad.dong.split("·")[0];
  const numbered = dong.match(/^(.{2,})\d+동$/);
  if (numbered) return numbered[1];
  const town = ad.sigungu.match(/^(.+?)(?:시|군|구)/)?.[1];
  if (dong.length <= 2 && town) return `${town} ${dong}`;
  return dong;
}

/** 코스 이름용 지명 — 이름난 곳을 먼저, 없으면 행정동 */
function nameFor(points: LatLng[], forKind: NameFor, center: LatLng): string | undefined {
  return landmarkNear(points, forKind) ?? dongPlace(center);
}

/** 출발에서 가장 먼 곳과, 종류별 가장 긴 특별 구간의 지명 */
function placeNames(path: LatLng[], special: SpecialRanges): NonNullable<RouteMetrics["places"]> {
  const out: NonNullable<RouteMetrics["places"]> = {};
  const step = Math.max(1, Math.floor(path.length / 400));
  let far = path[0];
  let farD = -1;
  for (let i = 0; i < path.length; i += step) {
    const d = distanceM(path[0], path[i]);
    if (d > farD) {
      farD = d;
      far = path[i];
    }
  }
  out.far = nameFor([far], "far", far);
  const pts = resamplePath(path, SPECIAL_STEP_M);
  for (const kind of ["winding", "coast", "river"] as const) {
    const best = special[kind].reduce<[number, number] | null>((m, r) => (!m || r[1] - r[0] > m[1] - m[0] ? r : m), null);
    if (!best) continue;
    const i0 = Math.floor(best[0] / SPECIAL_STEP_M);
    const i1 = Math.min(pts.length - 1, Math.ceil(best[1] / SPECIAL_STEP_M));
    const seg = pts.slice(i0, i1 + 1).filter((_, i) => i % 25 === 0);
    const mid = pts[Math.round((i0 + i1) / 2)];
    if (mid && seg.length) out[kind] = nameFor(seg, kind, mid);
  }
  return out;
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
  metrics.special = specialRanges(path);
  metrics.places = placeNames(path, metrics.special);

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, metrics);
  return metrics;
}
