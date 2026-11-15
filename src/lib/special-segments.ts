import { distanceM } from "@/lib/scoring/curvature";
import type { DriveStyle, LatLng, SpecialRanges } from "@/lib/types";

export type SpecialKind = keyof SpecialRanges;

/** 고른 길 종류 → 지도에 덧칠할 특별 구간 종류 (와인딩·산길은 굽잇길) */
export function specialKindsFor(styles: DriveStyle[]): SpecialKind[] {
  const out: SpecialKind[] = [];
  if (styles.includes("와인딩") || styles.includes("산길")) out.push("winding");
  if (styles.includes("해안도로")) out.push("coast");
  if (styles.includes("강변도로")) out.push("river");
  return out;
}

/**
 * 서버가 준 거리 구간(출발부터 m)을 실제 경로 조각으로 자른다.
 * 서버는 같은 경로를 20m 간격으로 따라가며 쟀으므로 누적 거리로 맞추면 된다.
 */
export function cutRanges(path: LatLng[], ranges: [number, number][]): { path: LatLng[]; km: number }[] {
  if (path.length < 2 || ranges.length === 0) return [];
  const cum: number[] = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + distanceM(path[i - 1], path[i]));
  const at = (d: number): LatLng => {
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    if (lo === 0) return path[0];
    const span = cum[lo] - cum[lo - 1];
    const t = span > 0 ? (d - cum[lo - 1]) / span : 0;
    const a = path[lo - 1];
    const b = path[lo];
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  };
  const out: { path: LatLng[]; km: number }[] = [];
  for (const [from, to] of ranges) {
    const a = Math.max(0, from);
    const b = Math.min(cum[cum.length - 1], to);
    if (b <= a) continue;
    const pts: LatLng[] = [at(a)];
    for (let i = 0; i < path.length; i++) if (cum[i] > a && cum[i] < b) pts.push(path[i]);
    pts.push(at(b));
    out.push({ path: pts, km: (b - a) / 1000 });
  }
  return out;
}
