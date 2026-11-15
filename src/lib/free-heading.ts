import type { LatLng } from "@/lib/types";

export const FREE_HEADING_MIN_M = 4;

function distanceM(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * kx);
}

function bearingDeg(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((b.lat * Math.PI) / 180);
  return (
    (Math.atan2((b.lng - a.lng) * kx, (b.lat - a.lat) * 111_320) * 180) /
    Math.PI
  );
}

// 방향 기준점은 작은 위치 변화마다 옮기지 않고 누적 이동이 임계 거리를 넘을 때만 갱신한다.
export function advanceFreeHeading(
  anchor: LatLng | null,
  current: LatLng,
  minM = FREE_HEADING_MIN_M,
): { anchor: LatLng; heading: number | null } {
  if (!anchor) return { anchor: current, heading: null };
  if (distanceM(anchor, current) <= minM) return { anchor, heading: null };
  return { anchor: current, heading: bearingDeg(anchor, current) };
}
