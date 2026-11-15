/**
 * 현대 예상 경로(requestTrip)의 소통 구간을 우리 경로의 "앞 구간"에 덮어쓴다.
 * 현대 예상 경로는 출발지가 항상 지금 차 위치이고, 경로 선 없이 비율(0~100) 구간만 준다.
 * 그래서 우리 경로를 따라 20km→10km→5km→2.5km→1km 앞 지점을 차례로 물어, 현대 거리와 우리 거리가
 * 맞는 가장 먼 지점까지만 같은 길로 보고 비율대로 칠한다. 하나도 안 맞으면 바꾸지 않는다.
 */

export interface AheadPoint {
  lat: number;
  lng: number;
}

export interface AheadSample extends AheadPoint {
  state: number;
}

export interface HyundaiTrafficSpan {
  t: string;
  s: number;
  e: number;
}

/** 현대 소통 단계를 색칠 단계(1정체 2지체 3서행 4원활, 0정보없음)로 맞춘다. */
export function hyundaiState(type: string): number {
  switch (type) {
    case "FAST":
      return 4;
    case "MODERATE":
      return 3;
    case "SLOW":
      return 2;
    case "HEAVY":
      return 1;
    default:
      return 0;
  }
}

function distanceM(a: AheadPoint, b: AheadPoint): number {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx);
}

/** fromIdx에서 경로를 따라 aheadM 앞(또는 끝)까지의 구간. */
export function legAhead(path: AheadPoint[], fromIdx: number, aheadM: number) {
  const start = Math.max(0, Math.min(path.length - 1, fromIdx));
  const points: AheadPoint[] = [path[start]];
  let lengthM = 0;
  for (let i = start + 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const d = distanceM(a, b);
    if (lengthM + d >= aheadM && d > 0) {
      const t = (aheadM - lengthM) / d;
      points.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      lengthM = aheadM;
      break;
    }
    points.push(b);
    lengthM += d;
  }
  return { points, lengthM, end: points[points.length - 1] };
}

/**
 * 현대 거리와 우리 구간 거리가 5%(짧으면 150m) 안이면 같은 길로 본다.
 * 현대는 경로 선을 주지 않아 거리로만 추정한다. 길이가 같은 다른 길은 못 거른다.
 */
export function sameRoad(hyundaiM: number, legM: number): boolean {
  return legM > 0 && Math.abs(hyundaiM - legM) <= Math.max(150, legM * 0.05);
}

/** 같은 길을 찾을 때 물어볼 앞 거리. 먼 곳부터 물어 맞는 가장 먼 지점까지를 같은 길로 본다. */
export const AHEAD_STEPS_M = [20_000, 10_000, 5_000, 2_500, 1_000];

function stateAtRatio(spans: HyundaiTrafficSpan[], ratio: number): number {
  for (const span of spans) {
    if (ratio >= span.s && ratio <= span.e) return hyundaiState(span.t);
  }
  return 0;
}

/**
 * 앞 구간을 sampleM 간격으로 현대 상태로 칠하고, 그 구간에 있던 기존 표본은 지운다.
 * 현대 거리가 다르거나 소통 구간이 없으면 기존 표본을 그대로 돌려준다.
 */
export function applyHyundaiAhead(
  samples: AheadSample[],
  leg: { points: AheadPoint[]; lengthM: number },
  hyundaiM: number,
  spans: HyundaiTrafficSpan[] | undefined,
  sampleM = 300,
): AheadSample[] {
  if (!spans || spans.length === 0 || leg.points.length < 2 || !sameRoad(hyundaiM, leg.lengthM)) {
    return samples;
  }
  const legSamples: AheadSample[] = [];
  let walked = 0;
  let next = 0;
  for (let i = 1; i < leg.points.length; i++) {
    const a = leg.points[i - 1], b = leg.points[i];
    const d = distanceM(a, b);
    while (d > 0 && walked + d >= next) {
      const t = (next - walked) / d;
      const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      legSamples.push({ ...point, state: stateAtRatio(spans, (next / leg.lengthM) * 100) });
      next += sampleM;
    }
    walked += d;
  }
  if (legSamples.length === 0) return samples;
  // 앞 구간 위(표본 간격 절반 안)에 있던 기존 표본은 현대 표본으로 바꾼다.
  const near = (p: AheadPoint) => legSamples.some((q) => distanceM(p, q) <= sampleM / 2);
  return [...legSamples, ...samples.filter((p) => !near(p))];
}
