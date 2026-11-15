import type { LatLng } from "@/lib/types";

export interface RouteSimilarityOptions {
  /** 서로 같은 도로 회랑으로 볼 최대 횡방향 거리. */
  maxDistanceM?: number;
  /** 진행방향 차이 허용치. 반대 방향·왕복 겹침을 배제한다. */
  maxHeadingDiffDeg?: number;
  sourceSamples?: number;
  targetSamples?: number;
}

function distanceM(a: LatLng, b: LatLng): number {
  const meanLat = ((a.lat + b.lat) * Math.PI) / 360;
  const x = (b.lng - a.lng) * 111_320 * Math.cos(meanLat);
  const y = (b.lat - a.lat) * 110_540;
  return Math.hypot(x, y);
}

/**
 * 경로를 길이 기준으로 고르게 count개 점으로 다시 찍는다. 같은 길이라도 좌표 밀도가
 * 다르면(200점 vs 100점, 직선 구간에 점 2개뿐 등) 점 순번으로 고른 표본은 위치가
 * 어긋나고 개수도 모자라, 같은 경로가 62.5%처럼 낮게 나왔다.
 */
function resampleByDistance(path: LatLng[], count: number): LatLng[] {
  const cumulative = [0];
  for (let i = 1; i < path.length; i++) {
    cumulative.push(cumulative[i - 1] + distanceM(path[i - 1], path[i]));
  }
  const total = cumulative[cumulative.length - 1];
  if (total <= 0) return [path[0]];
  const out: LatLng[] = [];
  let segment = 1;
  for (let i = 0; i < count; i++) {
    const at = (total * i) / (count - 1);
    while (segment < path.length - 1 && cumulative[segment] < at) segment++;
    const a = path[segment - 1];
    const b = path[segment];
    const span = cumulative[segment] - cumulative[segment - 1];
    const t = span > 0 ? Math.min(1, Math.max(0, (at - cumulative[segment - 1]) / span)) : 0;
    out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
  }
  return out;
}

/** 너무 촘촘한 GPS 점의 흔들림을 피하려고 앞뒤 25m 이상 떨어진 점으로 방위를 잰다. */
function headingAt(path: LatLng[], index: number): number | null {
  const point = path[index];
  let before = index;
  let after = index;
  while (before > 0 && distanceM(path[before], point) < 25) before--;
  while (after < path.length - 1 && distanceM(path[after], point) < 25) after++;
  if (before === after) return null;
  const from = path[before];
  const to = path[after];
  const meanLat = ((from.lat + to.lat) * Math.PI) / 360;
  const east = (to.lng - from.lng) * Math.cos(meanLat);
  const north = to.lat - from.lat;
  if (Math.abs(east) + Math.abs(north) < 1e-12) return null;
  return (Math.atan2(east, north) * 180) / Math.PI;
}

function headingDifference(a: number, b: number): number {
  const raw = Math.abs(a - b) % 360;
  return Math.min(raw, 360 - raw);
}

function directionalOverlap(
  source: LatLng[],
  target: LatLng[],
  options: Required<RouteSimilarityOptions>,
): number {
  // 표본은 길이 기준으로 고르게. target을 source보다 훨씬 촘촘히(기본 900 vs 160)
  // 찍어 두므로, 순서를 강제해도 target 표본이 모자라지 않는다.
  const sourcePoints = resampleByDistance(source, options.sourceSamples);
  const targetPoints = resampleByDistance(target, options.targetSamples);
  if (sourcePoints.length < 2 || targetPoints.length < 2) return 0;

  let cursor = 0;
  let matched = 0;
  for (let sourceIndex = 0; sourceIndex < sourcePoints.length; sourceIndex++) {
    const sourceHeading = headingAt(sourcePoints, sourceIndex);
    let bestPosition = -1;
    let bestDistance = Infinity;
    for (let position = cursor; position < targetPoints.length; position++) {
      const distance = distanceM(sourcePoints[sourceIndex], targetPoints[position]);
      if (distance > options.maxDistanceM || distance >= bestDistance) continue;
      const targetHeading = headingAt(targetPoints, position);
      if (
        sourceHeading !== null &&
        targetHeading !== null &&
        headingDifference(sourceHeading, targetHeading) > options.maxHeadingDiffDeg
      ) {
        continue;
      }
      bestDistance = distance;
      bestPosition = position;
    }
    if (bestPosition < 0) continue;
    matched++;
    // 같은 target 표본 하나로 여러 source 표본을 통과시키지 않고, 경로 진행
    // 순서를 강제한다. 마지막 표본까지 썼다면 이후 source는 매칭되지 않는다.
    cursor = bestPosition + 1;
  }
  return matched / sourcePoints.length;
}

/**
 * 두 경로의 공간·순서·진행방향을 양방향 비교한다. 단순 "반경 안 점 개수"와
 * 달리 평행도로 지름길, 반대 방향 왕복, 순서를 뒤집은 경로가 통과하지 않는다.
 */
export function routeOverlapRatio(
  a: LatLng[],
  b: LatLng[],
  options: RouteSimilarityOptions = {},
): number {
  if (a.length < 2 || b.length < 2) return 0;
  const resolved: Required<RouteSimilarityOptions> = {
    maxDistanceM: options.maxDistanceM ?? 180,
    maxHeadingDiffDeg: options.maxHeadingDiffDeg ?? 70,
    sourceSamples: Math.max(2, options.sourceSamples ?? 160),
    targetSamples: Math.max(2, options.targetSamples ?? 900),
  };
  return Math.min(
    directionalOverlap(a, b, resolved),
    directionalOverlap(b, a, resolved),
  );
}
