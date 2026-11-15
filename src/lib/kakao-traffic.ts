/**
 * 카카오 길찾기 응답(roads[].traffic_state)을 우리 경로 위 표본점의 소통 상태로 옮긴다.
 * 응답 형태는 ITS 색칠(trafficAlongPath)과 같다: 1정체 2지체 3서행 4원활, 0정보없음.
 * 카카오가 우리 경로와 다른 길로 갔으면 그 구간은 0으로 남긴다(엉뚱한 길 색을 칠하지 않음).
 */

export interface TrafficPoint {
  lat: number;
  lng: number;
}

export interface KakaoRoad {
  traffic_state?: number;
  vertexes?: number[];
}

export interface PathTrafficSample extends TrafficPoint {
  state: number;
}

export interface KakaoPathTraffic {
  samples: PathTrafficSample[];
  distanceM: number;
  coverage: number;
  jamRatio: number | null;
}

/** 카카오 길찾기는 경유지를 최대 30개까지 받는다. */
export const KAKAO_MAX_WAYPOINTS = 30;
/** 경유지를 너무 촘촘히 찍으면 반대 차선에 붙어 유턴하며 돌아간다(30개: 15.8→28.4km 실측). */
const WAYPOINT_SPACING_M = 5000;

export function pathLengthM(path: TrafficPoint[]): number {
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i]);
  return total;
}

/** 경로 길이에 맞는 경유지 수: 5km마다 하나, 최대 30개. */
export function waypointCount(totalM: number): number {
  return Math.max(0, Math.min(KAKAO_MAX_WAYPOINTS, Math.floor(totalM / WAYPOINT_SPACING_M)));
}

/** 카카오 경로가 우리 경로보다 10% 넘게 길면 경유지 때문에 돌아간 것으로 본다. */
export function detoured(kakaoM: number, pathM: number): boolean {
  return pathM > 0 && kakaoM > pathM * 1.1;
}
/**
 * 표본점과 카카오 도로선 사이가 이보다 멀면 다른 길로 본다.
 * 40m는 같은 길인데도 지도마다 도로선이 어긋나 30%가 빠졌다(2026-11-14 실측: 40m 65~70%, 80m 79~83%).
 */
const MATCH_M = 80;

function distanceM(a: TrafficPoint, b: TrafficPoint): number {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx);
}

/** 카카오 상태값을 ITS 단계로 맞춘다. 6(통행 불가)은 정체로 본다. */
export function kakaoState(state: number | undefined): number {
  if (state === 1 || state === 2 || state === 3 || state === 4) return state;
  if (state === 6) return 1;
  return 0;
}

/** 경로를 따라 같은 간격의 점 count개를 고른다(양 끝 제외). 카카오가 우리 길을 따르게 하는 경유지다. */
export function pickWaypoints(path: TrafficPoint[], count = KAKAO_MAX_WAYPOINTS): TrafficPoint[] {
  if (path.length < 3 || count <= 0) return [];
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i]);
  if (total <= 0) return [];
  const step = total / (count + 1);
  const out: TrafficPoint[] = [];
  let walked = 0;
  let next = step;
  for (let i = 1; i < path.length && out.length < count; i++) {
    const a = path[i - 1];
    const b = path[i];
    const length = distanceM(a, b);
    while (length > 0 && walked + length >= next && out.length < count) {
      const t = (next - walked) / length;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      next += step;
    }
    walked += length;
  }
  return out;
}

interface RoadSegment {
  a: TrafficPoint;
  b: TrafficPoint;
  state: number;
}

function segments(roads: KakaoRoad[]): RoadSegment[] {
  const out: RoadSegment[] = [];
  for (const road of roads) {
    const v = road.vertexes ?? [];
    const state = kakaoState(road.traffic_state);
    for (let i = 0; i + 3 < v.length; i += 2) {
      out.push({ a: { lng: v[i], lat: v[i + 1] }, b: { lng: v[i + 2], lat: v[i + 3] }, state });
    }
  }
  return out;
}

function segmentDistanceM(p: TrafficPoint, s: RoadSegment): number {
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const ax = (s.a.lng - p.lng) * kx, ay = (s.a.lat - p.lat) * 110_540;
  const bx = (s.b.lng - p.lng) * kx, by = (s.b.lat - p.lat) * 110_540;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t, ay + dy * t);
}

/** 가장 가까운 카카오 도로선의 상태. MATCH_M 밖이면 0. */
function stateAt(p: TrafficPoint, segs: RoadSegment[]): number {
  let best = Infinity;
  let state = 0;
  for (const s of segs) {
    const d = segmentDistanceM(p, s);
    if (d < best) {
      best = d;
      state = s.state;
    }
  }
  return best <= MATCH_M ? state : 0;
}

/** 우리 경로를 sampleM 간격으로 훑어 각 점의 카카오 소통 상태를 붙인다. */
export function trafficFromKakaoRoads(
  path: TrafficPoint[],
  roads: KakaoRoad[],
  sampleM = 300,
): KakaoPathTraffic {
  if (path.length < 2) return { samples: [], distanceM: 0, coverage: 0, jamRatio: null };
  const segs = segments(roads);
  const samples: PathTrafficSample[] = [];
  let totalM = 0;
  let untilNext = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const length = distanceM(a, b);
    if (length <= 0) continue;
    let offset = untilNext;
    while (offset <= length) {
      const t = Math.min(1, offset / length);
      const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      samples.push({ ...point, state: stateAt(point, segs) });
      offset += sampleM;
    }
    untilNext = offset - length;
    totalM += length;
  }
  const end = path[path.length - 1];
  const last = samples[samples.length - 1];
  if (!last || distanceM(last, end) > sampleM * 0.35) samples.push({ ...end, state: stateAt(end, segs) });
  const known = samples.filter((s) => s.state > 0).length;
  const jam = samples.filter((s) => s.state === 1 || s.state === 2).length;
  const coverage = samples.length > 0 ? known / samples.length : 0;
  return {
    samples,
    distanceM: totalM,
    coverage,
    jamRatio: coverage >= 0.3 ? jam / samples.length : null,
  };
}
