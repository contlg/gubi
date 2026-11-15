import type { CurveMetrics, LatLng } from "@/lib/types";

const HARD_CORNER_DEG = 45;
/** GPS 노이즈로 인한 미세한 방위각 변화는 무시 */
const MIN_TURN_DEG = 5;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** 두 좌표 사이 방위각(도, 0~360) */
function bearing(a: LatLng, b: LatLng): number {
  const dLng = toRad(b.lng - a.lng);
  const latA = toRad(a.lat);
  const latB = toRad(b.lat);
  const y = Math.sin(dLng) * Math.cos(latB);
  const x =
    Math.cos(latA) * Math.sin(latB) -
    Math.sin(latA) * Math.cos(latB) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI + 180;
}

/** 두 좌표 사이 거리(m) — haversine */
export function distanceM(a: LatLng, b: LatLng): number {
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  // sqrt(h)를 1로 클램프 — 부동소수 오차로 h가 1을 살짝 넘어도 asin이 NaN이
  // 되지 않게(정석 Haversine). 도로 세그먼트는 h≈0이라 실발동은 없지만 안전.
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * 경로를 stepM 균일 간격 점열로 리샘플한다. 정점만 고르는 게 아니라 긴 선분
 * 내부를 실제 거리 기준으로 보간하고(정점 간격이 stepM보다 커도 중간 좌표 생성),
 * 선분에서 남은 간격을 다음 선분으로 carry해 간격이 끊기지 않는다. 시작점은 항상
 * 포함, 마지막 점은 마지막 보간점과 충분히 떨어졌을 때만 추가(중복 방지).
 * 배지·도로지표 등 "균일 간격이 전제"인 계산의 공용 샘플러.
 */
export function resamplePath(path: LatLng[], stepM: number): LatLng[] {
  if (path.length < 2) return path.slice();
  const out: LatLng[] = [path[0]];
  let carry = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const seg = distanceM(a, b);
    if (seg <= 0) continue;
    let d = stepM - carry;
    while (d <= seg) {
      const t = d / seg;
      out.push({ lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t });
      d += stepM;
    }
    carry = seg - (d - stepM);
  }
  // 마지막 점 보존 — 마지막 보간점과 stepM 절반(최대 30m) 넘게 떨어졌을 때만.
  const last = path[path.length - 1];
  if (distanceM(out[out.length - 1], last) > Math.min(stepM / 2, 30)) out.push(last);
  return out;
}

/** 구간 경계의 중복 좌표·GPS 노이즈가 방위각을 오염시키지 않도록 최소 간격 보장 */
const MIN_SEGMENT_M = 10;

function simplify(path: LatLng[]): LatLng[] {
  if (path.length === 0) return path;
  const result = [path[0]];
  for (const p of path) {
    if (distanceM(result[result.length - 1], p) >= MIN_SEGMENT_M) {
      result.push(p);
    }
  }
  return result;
}

/** 경로 총 길이의 fraction(0~1) 지점 좌표 */
export function pointAtFraction(path: LatLng[], fraction: number): LatLng {
  if (fraction <= 0) return path[0]; // 0% 지점은 시작점(첫 순회가 즉시 path[1] 반환하는 것 방지)
  let total = 0;
  for (let i = 1; i < path.length; i++) total += distanceM(path[i - 1], path[i]);
  const target = total * fraction;
  let acc = 0;
  for (let i = 1; i < path.length; i++) {
    acc += distanceM(path[i - 1], path[i]);
    if (acc >= target) return path[i];
  }
  return path[path.length - 1];
}

export interface CurveSegment {
  path: LatLng[];
  /** 이 구간의 와인딩 지수 (°/km) */
  degPerKm: number;
}

/**
 * 한 점에서 이보다 크게 꺾이면 도로 커브가 아니라 교차로 회전으로 본다.
 * (와인딩은 완만한 커브의 연속이고, 시내 좌/우회전은 90°에 가깝다)
 */
const INTERSECTION_TURN_DEG = 60;

/**
 * 경로를 일정 길이 창으로 잘라 구간별 와인딩 지수를 계산한다.
 * 지도에서 커브 정도를 색으로 표현하는 용도.
 */
export function curvatureSegments(
  rawPath: LatLng[],
  windowM = 2000,
): CurveSegment[] {
  const path = simplify(rawPath);
  if (path.length < 3) return [{ path: rawPath, degPerKm: 0 }];

  const segments: CurveSegment[] = [];
  let segPts: LatLng[] = [path[0], path[1]];
  let segDist = distanceM(path[0], path[1]);
  let segTurn = 0;
  let prevBearing = bearing(path[0], path[1]);

  for (let i = 1; i < path.length - 1; i++) {
    const curBearing = bearing(path[i], path[i + 1]);
    let turn = Math.abs(curBearing - prevBearing);
    if (turn > 180) turn = 360 - turn;
    // 교차로 회전(급격한 단일 꺾임)은 와인딩이 아니므로 제외
    if (turn >= MIN_TURN_DEG && turn <= INTERSECTION_TURN_DEG) segTurn += turn;
    prevBearing = curBearing;

    segDist += distanceM(path[i], path[i + 1]);
    segPts.push(path[i + 1]);

    if (segDist >= windowM) {
      segments.push({
        path: segPts,
        degPerKm: Math.round(segTurn / (segDist / 1000)),
      });
      segPts = [path[i + 1]];
      segDist = 0;
      segTurn = 0;
    }
  }
  if (segPts.length > 1 && segDist > 0) {
    segments.push({
      path: segPts,
      degPerKm: Math.round(segTurn / (segDist / 1000)),
    });
  }
  return segments;
}

/**
 * 경로 좌표열에서 와인딩 지수를 계산한다.
 * 연속 세 점의 방위각 변화를 누적해 km당 회전량(도)으로 정규화.
 */
export function curveMetrics(rawPath: LatLng[]): CurveMetrics {
  const path = simplify(rawPath);
  if (path.length < 3) return { degPerKm: 0, hardCorners: 0 };

  let totalTurnDeg = 0;
  let hardCorners = 0;
  let totalDistM = 0;

  let prevBearing = bearing(path[0], path[1]);
  totalDistM += distanceM(path[0], path[1]);

  for (let i = 1; i < path.length - 1; i++) {
    const curBearing = bearing(path[i], path[i + 1]);
    totalDistM += distanceM(path[i], path[i + 1]);

    let turn = Math.abs(curBearing - prevBearing);
    if (turn > 180) turn = 360 - turn;

    if (turn >= MIN_TURN_DEG) {
      totalTurnDeg += turn;
      if (turn >= HARD_CORNER_DEG) hardCorners++;
    }
    prevBearing = curBearing;
  }

  const km = totalDistM / 1000;
  return {
    degPerKm: km > 0 ? Math.round(totalTurnDeg / km) : 0,
    hardCorners,
  };
}
