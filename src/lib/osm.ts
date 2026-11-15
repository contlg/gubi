import "server-only";

import { loopFetch, startLoopStage } from "@/lib/loop-timing";

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { distanceM } from "@/lib/scoring/curvature";
import type { CoastSample, LatLng, Place, RouteMetrics } from "@/lib/types";

/** 프리페치 해안도로 정점 — d는 해안선까지 거리(m). 998=거리 미상(구형 데이터) */
export interface CoastPoint {
  lat: number;
  lng: number;
  d: number;
}

/**
 * 프리페치된 해안도로 정점(해안선 150m 이내 도로) — 실시간 Overpass 의존을
 * 없애기 위해 scripts/prefetch-coast.mjs 가 만든 로컬 데이터. 없으면 빈 배열.
 * 파일 mtime을 보고 바뀌면 다시 읽는다(프리페치가 도중에 파일을 늘려도 서버
 * 재시작 없이 새 커버리지를 반영). 쓰기 도중 부분 JSON은 catch로 기존값 유지.
 * 형식: [lat,lng,dcoast] (구형 [lat,lng]은 dcoast=998).
 */
const COASTAL_FILE = join(process.cwd(), "src/lib/data/coastal-road-points.json");
let coastalPoints: CoastPoint[] | null = null;
let coastalMtime = -1;
function loadCoastalPoints(): CoastPoint[] {
  try {
    const mtime = statSync(COASTAL_FILE).mtimeMs;
    if (coastalPoints && mtime === coastalMtime) return coastalPoints;
    const arr = JSON.parse(readFileSync(COASTAL_FILE, "utf8")) as number[][];
    coastalPoints = arr.map((e) => ({
      lat: e[0],
      lng: e[1],
      d: e.length > 2 ? e[2] : 998,
    }));
    coastalMtime = mtime;
  } catch {
    if (!coastalPoints) coastalPoints = [];
  }
  return coastalPoints;
}

/** 프리페치된 전국 해안도로 정점 전체 (해안 관통선 그래프용, dcoast 포함) */
export function getPrefetchedPoints(): CoastPoint[] {
  return loadCoastalPoints();
}

/** 프리페치 데이터에서 기준점 코리더(1.5km) 안의 해안도로 정점만 추린다 */
function prefetchedPointsNear(near: LatLng[]): CoastPoint[] {
  const all = loadCoastalPoints();
  if (all.length === 0) return [];
  const out: CoastPoint[] = [];
  for (const p of all) {
    for (const s of near) {
      if (distanceM(p, s) <= 1500) {
        out.push(p);
        break;
      }
    }
  }
  return out;
}

/** 공용 Overpass 서버는 과부하가 잦아 미러 순차 폴백. 기본 UA는 406으로 차단됨 */
const OVERPASS_URLS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
const USER_AGENT = "drive-planner-dev/0.1";

/**
 * 바닷가(진짜 해안도로) 판정 거리. 300m는 해안선 옆 7번국도(내륙 간선)까지
 * "바닷가"로 크레딧을 줘서, 실제 해안도로로 좁혔다.
 */
const SEA_SHORE_M = 150;
/**
 * 바다뷰 도로 판정 거리. 800m는 7번국도·내륙 상가 뒤 도로까지 "뷰"로 잡아
 * 오탐이 많았다. 실제로 바다가 보이는 근접 구간만 남기려고 좁혔다.
 */
const SEA_VIEW_M = 450;
/** 해안선 지오메트리 조회 반경 — 판정(≤450m)보다 넉넉해야 경계가 안 잘린다 */
const SEA_FETCH_M = 900;
const RIVER_RADIUS_M = 300;
const PEAK_RADIUS_M = 1500;
/** 신호등/터널/교량은 경로에 붙은 것만 세야 하므로 좁은 반경 + 촘촘한 체인 */
const SIGNAL_RADIUS_M = 100;
const STRUCTURE_RADIUS_M = 150;

/** 공용 Overpass 서버 부하 한계 내에서 도는 수준으로 조정된 값 */
const MAX_COARSE_SAMPLES = 100;
const MAX_FINE_SAMPLES = 150;

function pathLengthM(path: LatLng[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i]);
  return total;
}

function sampleByInterval(path: LatLng[], intervalM: number): LatLng[] {
  const samples = [path[0]];
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    acc += distanceM(path[i - 1], path[i]);
    if (acc >= intervalM) {
      samples.push(path[i]);
      acc = 0;
    }
  }
  return samples;
}

/** 풍경 지표용 성긴 샘플 (최소 3km 간격) */
export function samplePath(path: LatLng[]): LatLng[] {
  if (path.length < 2) return path;
  const intervalM = Math.max(3000, pathLengthM(path) / MAX_COARSE_SAMPLES);
  return sampleByInterval(path, intervalM);
}

/** 신호등/터널/교량용 촘촘한 샘플 (최소 1km 간격) */
function samplePathFine(path: LatLng[]): LatLng[] {
  if (path.length < 2) return path;
  const intervalM = Math.max(1000, pathLengthM(path) / MAX_FINE_SAMPLES);
  return sampleByInterval(path, intervalM);
}

function aroundChain(points: LatLng[], radiusM: number): string {
  const chain = points
    .map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`)
    .join(",");
  return `around:${radiusM},${chain}`;
}

interface OverpassWay {
  type: "way";
  tags?: Record<string, string>;
  geometry: { lat: number; lon: number }[];
}

interface OverpassNode {
  type: "node";
  tags?: Record<string, string>;
  lat: number;
  lon: number;
}

interface OverpassResponse {
  elements: (OverpassWay | OverpassNode)[];
}

/** 점-선분 거리(m) — 좁은 범위라 등장방형 근사로 충분 */
function pointSegDistM(p: LatLng, a: LatLng, b: LatLng): number {
  const kx = Math.cos((p.lat * Math.PI) / 180) * 111320;
  const ky = 110540;
  const ax = (a.lng - p.lng) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + dx * t, ay + dy * t);
}

function nearAnyWay(p: LatLng, ways: OverpassWay[], radiusM: number): boolean {
  for (const way of ways) {
    const g = way.geometry;
    for (let i = 0; i + 1 < g.length; i++) {
      const a = { lat: g[i].lat, lng: g[i].lon };
      const b = { lat: g[i + 1].lat, lng: g[i + 1].lon };
      if (pointSegDistM(p, a, b) <= radiusM) return true;
    }
  }
  return false;
}

/**
 * 점 p에서 세그먼트 a-b 위의 가장 가까운 점과 그 거리(m)를 반환.
 * 좁은 범위라 등장방형 근사(미터 좌표)로 충분하다.
 */
function nearestOnSeg(
  p: LatLng,
  a: LatLng,
  b: LatLng,
): { point: LatLng; distM: number } {
  const kx = Math.cos((p.lat * Math.PI) / 180) * 111320;
  const ky = 110540;
  const ax = (a.lng - p.lng) * kx;
  const ay = (a.lat - p.lat) * ky;
  const bx = (b.lng - p.lng) * kx;
  const by = (b.lat - p.lat) * ky;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cxm = ax + dx * t;
  const cym = ay + dy * t;
  return {
    point: { lat: p.lat + cym / ky, lng: p.lng + cxm / kx },
    distM: Math.hypot(cxm, cym),
  };
}

/** 점에서 way들까지의 최단 거리(m). cap 이상이면 cap 반환 */
function minDistToWays(p: LatLng, ways: OverpassWay[], capM: number): number {
  let min = capM;
  for (const way of ways) {
    const g = way.geometry;
    for (let i = 0; i + 1 < g.length; i++) {
      const a = { lat: g[i].lat, lng: g[i].lon };
      const b = { lat: g[i + 1].lat, lng: g[i + 1].lon };
      const d = pointSegDistM(p, a, b);
      if (d < min) min = d;
    }
  }
  return min;
}

/**
 * 상하행 분리 도로(고속도로·자동차전용 등)는 터널/교량이 방향별로 두 way라
 * 이중 계산된다 — 그 경우에만 절반 보정한다. 왕복 2차선 지방도는 way가
 * 하나뿐이라 무조건 반토막 내면 터널·교량을 심각하게 과소평가한다.
 */
function isDualCarriage(tags: Record<string, string> | undefined): boolean {
  return (
    tags?.oneway === "yes" || /^(motorway|trunk)/.test(tags?.highway ?? "")
  );
}

function wayLengthM(way: OverpassWay): number {
  let total = 0;
  const g = way.geometry;
  for (let i = 1; i < g.length; i++) {
    total += distanceM(
      { lat: g[i - 1].lat, lng: g[i - 1].lon },
      { lat: g[i].lat, lng: g[i].lon },
    );
  }
  return total;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function runOverpass(
  query: string,
  opts?: { timeoutMs?: number; rounds?: number },
): Promise<OverpassResponse> {
  const endTiming = startLoopStage("external.overpass");
  try {
  const timeoutMs = opts?.timeoutMs ?? 45_000;
  const rounds = opts?.rounds ?? 2;
  let lastError = "";
  // 공용 서버는 순간 과부하(429/504)가 흔해서 미러 순회를 여러 라운드 반복.
  // 인터랙티브 경로(스냅)는 rounds=1 + 짧은 timeout으로 빠르게 실패시켜 폴백한다.
  for (let round = 0; round < rounds; round++) {
    if (round > 0) await sleep(3000);
    for (const url of OVERPASS_URLS) {
      try {
        const res = await loopFetch(url, {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
            "User-Agent": USER_AGENT,
          },
          body: `data=${encodeURIComponent(query)}`,
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          continue;
        }
        return (await res.json()) as OverpassResponse;
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e);
      }
    }
  }
  throw new Error(`Overpass API 오류 (${lastError}) — 잠시 후 다시 시도`);
  } finally {
    endTiming?.();
  }
}

/** 같은 경로 재검색 시 Overpass 재조회 방지 (프로세스 생존 동안 유지) */
const cache = new Map<string, RouteMetrics>();
const CACHE_MAX = 200;

function cacheKey(samples: LatLng[]): string {
  return samples.map((p) => `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`).join(";");
}

export async function routeMetrics(path: LatLng[]): Promise<RouteMetrics> {
  const coarse = samplePath(path);
  if (coarse.length < 2) {
    return {
      seaShoreRatio: 0,
      seaViewRatio: 0,
      coast: [],
      riverRatio: 0,
      peaksPerKm: 0,
      signalsPerKm: 0,
      tunnelRatio: 0,
      bridgeCount: 0,
    };
  }

  const key = cacheKey(coarse);
  const cached = cache.get(key);
  if (cached) return cached;

  const fine = samplePathFine(path);
  // 한 방에 다 묻으면 긴 경로에서 타임아웃이 나서 두 쿼리로 분리 (순차 실행)
  const sceneryQuery = `[out:json][timeout:40];
(
  way[natural=coastline](${aroundChain(coarse, SEA_FETCH_M)});
  way[waterway=river](${aroundChain(coarse, RIVER_RADIUS_M)});
  node[natural=peak](${aroundChain(coarse, PEAK_RADIUS_M)});
);
out geom;`;
  const structureQuery = `[out:json][timeout:40];
(
  node[highway=traffic_signals](${aroundChain(fine, SIGNAL_RADIUS_M)});
  way[tunnel][highway](${aroundChain(fine, STRUCTURE_RADIUS_M)});
  way[bridge][highway](${aroundChain(fine, STRUCTURE_RADIUS_M)});
);
out geom;`;

  const sceneryData = await runOverpass(sceneryQuery);
  const structureData = await runOverpass(structureQuery);
  const data: OverpassResponse = {
    elements: [...sceneryData.elements, ...structureData.elements],
  };

  const coastWays: OverpassWay[] = [];
  const riverWays: OverpassWay[] = [];
  let peakCount = 0;
  let signalCount = 0;
  let tunnelLenM = 0;
  let bridgeCount = 0;
  for (const el of data.elements) {
    if (el.type === "node") {
      if (el.tags?.natural === "peak") peakCount++;
      else if (el.tags?.highway === "traffic_signals") signalCount++;
    } else if (el.tags?.natural === "coastline") {
      coastWays.push(el);
    } else if (el.tags?.waterway === "river") {
      riverWays.push(el);
    } else if (el.tags?.tunnel && el.tags.tunnel !== "no") {
      tunnelLenM += wayLengthM(el) * (isDualCarriage(el.tags) ? 0.5 : 1);
    } else if (el.tags?.bridge && el.tags.bridge !== "no") {
      // 고가·짧은 교량은 잡음이라 200m 이상만 "교량"으로 센다
      if (wayLengthM(el) >= 200) bridgeCount += isDualCarriage(el.tags) ? 0.5 : 1;
    }
  }
  bridgeCount = Math.round(bridgeCount);

  // 해안 판정/색칠은 500m 촘촘 샘플로 — 성기면 지도 색칠 반경을 크게 잡아야
  // 하고(내륙까지 초록으로 샘), 촘촘하면 반경을 줄여 딱 해안만 칠할 수 있다.
  const coastFine = sampleByInterval(path, Math.max(500, pathLengthM(path) / 300));
  let shoreCount = 0;
  let viewCount = 0;
  const coast: CoastSample[] = [];
  for (const p of coastFine) {
    const d = minDistToWays(p, coastWays, SEA_FETCH_M + 1);
    if (d <= SEA_SHORE_M) {
      shoreCount++;
      coast.push({ lat: p.lat, lng: p.lng, tier: 2 });
    } else if (d <= SEA_VIEW_M) {
      viewCount++;
      coast.push({ lat: p.lat, lng: p.lng, tier: 1 });
    }
  }

  let riverNear = 0;
  for (const p of coarse) {
    if (nearAnyWay(p, riverWays, RIVER_RADIUS_M)) riverNear++;
  }

  const totalM = pathLengthM(path);
  const km = totalM / 1000;

  const metrics: RouteMetrics = {
    seaShoreRatio: shoreCount / coastFine.length,
    seaViewRatio: viewCount / coastFine.length,
    coast,
    riverRatio: riverNear / coarse.length,
    peaksPerKm: km > 0 ? peakCount / km : 0,
    signalsPerKm: km > 0 ? signalCount / km : 0,
    tunnelRatio: totalM > 0 ? Math.min(tunnelLenM / totalM, 1) : 0,
    bridgeCount,
  };

  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest) cache.delete(oldest);
  }
  cache.set(key, metrics);
  return metrics;
}

/** 이 거리 안에서 해안선을 따라 달리는 도로 = '해안도로'로 본다 */
const COAST_ROAD_M = 150;

/** 정점 중복 제거 격자 키 (≈110m) */
function gridKey(p: LatLng): string {
  return `${p.lat.toFixed(3)},${p.lng.toFixed(3)}`;
}

/**
 * 해안선(natural=coastline)을 따라 달리는 드라이브 가능한 도로의 정점을 뽑는다.
 * 해변 POI가 아니라 '도로 그 자체'의 좌표라, 이걸 순서대로 경유지로 쓰면
 * 카카오가 진짜 해안도로 위를 달린다(해변으로 새는 왕복이 없다).
 * near: 해안 위치를 알려주는 기준점들(보통 해변 사슬). 그 주변만 조회한다.
 * 인터랙티브 경로 — 빠른 실패(rounds=1), 실패 시 예외를 던져 호출부가 폴백.
 */
export async function fetchCoastalRoadPoints(near: LatLng[]): Promise<LatLng[]> {
  if (near.length === 0) return [];
  // 1) 프리페치 로컬 데이터 우선 — 네트워크 0, 항상 빠르고 결정론적.
  const prefetched = prefetchedPointsNear(near);
  if (prefetched.length >= 3) return prefetched;

  // 2) 미수록 지역 — 라이브 Overpass 폴백.
  // 기준점을 최대 14개로 솎아 조회를 가볍게. 반경은 1200m로 잡아 해안 관광
  // 도로(헌화로 등)까지 덮는다. residential/living_street(마을 도로 메시)는
  // 빼서 덩치를 줄이고, 항만·염전 골목이 만드는 루프도 함께 줄인다.
  const step = Math.max(1, Math.ceil(near.length / 14));
  const seeds = near.filter((_, i) => i % step === 0);
  const around = aroundChain(seeds, 1200);
  const query = `[out:json][timeout:10];
(
  way[natural=coastline](${around});
  way[highway~"^(trunk|primary|secondary|tertiary|unclassified|road)$"](${around});
);
out geom;`;
  const data = await runOverpass(query, { timeoutMs: 8_000, rounds: 1 });

  const coastWays: OverpassWay[] = [];
  const roadWays: OverpassWay[] = [];
  for (const el of data.elements) {
    if (el.type !== "way" || !el.geometry) continue;
    if (el.tags?.natural === "coastline") coastWays.push(el);
    else if (el.tags?.highway) roadWays.push(el);
  }
  if (coastWays.length === 0 || roadWays.length === 0) {
    throw new Error("해안도로 데이터 없음");
  }

  // 해안선 150m 이내의 도로 정점만 남기고 격자로 중복 제거
  const seen = new Set<string>();
  const points: LatLng[] = [];
  for (const road of roadWays) {
    for (const v of road.geometry) {
      const p = { lat: v.lat, lng: v.lon };
      if (minDistToWays(p, coastWays, COAST_ROAD_M + 1) > COAST_ROAD_M) continue;
      const key = gridKey(p);
      if (seen.has(key)) continue;
      seen.add(key);
      points.push(p);
    }
  }
  return points;
}

/** 해안선에서 이만큼 육지쪽으로 들어온 점 = 바닷가 도로(해안도로)가 있는 위치 */
const SHORE_ROAD_OFFSET_M = 45;
/** 이보다 해안선에서 먼 앵커는 개방 해안이 아니라고 보고 스냅하지 않는다 */
const SHORE_MAX_SNAP_M = 700;

/** 앵커 사슬 좌표 스냅 결과 캐시 (같은 해안 사슬 재검색 시 Overpass 재조회 방지) */
const shoreCache = new Map<string, Place[]>();

/**
 * 해변 POI 앵커를 '바다쪽 해안도로 위'로 스냅한다. 해변 마커는 주차장·진입로에
 * 스냅돼 카카오가 옆 7번국도(내륙 간선)로 붙는데, 앵커를 해안선 바로 안쪽
 * (SHORE_ROAD_OFFSET_M)으로 옮기면 카카오가 바닷가 도로에 스냅한다.
 * OSM 해안선을 한 번 조회(Overpass)하므로 실패할 수 있고, 그 경우 예외를
 * 던져 호출부가 원본 앵커로 폴백하게 한다.
 */
export async function snapAnchorsToShore(anchors: Place[]): Promise<Place[]> {
  if (anchors.length === 0) return anchors;
  const key = cacheKey(anchors.map((a) => a.coord));
  const hit = shoreCache.get(key);
  if (hit) return hit;

  const query = `[out:json][timeout:8];
way[natural=coastline](${aroundChain(
    anchors.map((a) => a.coord),
    SHORE_MAX_SNAP_M + 100,
  )});
out geom;`;
  // 인터랙티브 경로 — 8초 안에 응답 없으면 던지고 원본 앵커로 폴백한다.
  const data = await runOverpass(query, { timeoutMs: 8_000, rounds: 1 });
  const coastWays = data.elements.filter(
    (el): el is OverpassWay => el.type === "way" && el.tags?.natural === "coastline",
  );
  // 해안선을 못 받으면 스냅 의미가 없다 — 폴백하도록 예외
  if (coastWays.length === 0) throw new Error("해안선 데이터 없음");

  const snapped = anchors.map((anchor) => {
    let best: { point: LatLng; distM: number } | null = null;
    for (const way of coastWays) {
      const g = way.geometry;
      for (let i = 0; i + 1 < g.length; i++) {
        const a = { lat: g[i].lat, lng: g[i].lon };
        const b = { lat: g[i + 1].lat, lng: g[i + 1].lon };
        const r = nearestOnSeg(anchor.coord, a, b);
        if (!best || r.distM < best.distM) best = r;
      }
    }
    // 개방 해안에서 너무 멀면(호수/강 해변 오분류 등) 원본 유지
    if (!best || best.distM > SHORE_MAX_SNAP_M) return anchor;

    const C = best.point;
    const d = best.distM;
    // 해안선점 C에서 앵커(=육지) 방향으로 OFFSET만큼 들어온 지점 = 해안도로 위.
    // 이미 OFFSET 안쪽이면 앵커를 그대로 둔다.
    const f = d > SHORE_ROAD_OFFSET_M ? SHORE_ROAD_OFFSET_M / d : 0;
    const coord: LatLng = {
      lat: C.lat + (anchor.coord.lat - C.lat) * f,
      lng: C.lng + (anchor.coord.lng - C.lng) * f,
    };
    return { ...anchor, coord };
  });

  if (shoreCache.size >= CACHE_MAX) {
    const oldest = shoreCache.keys().next().value;
    if (oldest) shoreCache.delete(oldest);
  }
  shoreCache.set(key, snapped);
  return snapped;
}
