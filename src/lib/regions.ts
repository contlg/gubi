import "server-only";

import { adminDongAt } from "@/lib/admdong";
import { decodePolyline } from "@/lib/polyline";
import type { LatLng } from "@/lib/types";

/**
 * 주행 궤적 – "지나온 시·군·구" 목록. 저장된 전국 행정동 폴리곤으로
 * point-in-polygon 판정하므로 외부 API 호출이나 디스크 캐시가 필요 없다.
 */

export interface Region {
  sido: string;
  sigungu: string;
}

// 중복 판정 격자 — 위경도 0.02도 ≈ 2km. 같은 칸은 경계 검사를 한 번만 한다.
const GRID = 0.02;
const gridKey = (p: LatLng) =>
  `${Math.round(p.lat / GRID)},${Math.round(p.lng / GRID)}`;

function haversineM(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx);
}

/** 궤적을 최소 간격(m)으로 솎아 대표 표본 좌표만 남긴다 */
function sample(pts: LatLng[], everyM: number): LatLng[] {
  if (pts.length === 0) return [];
  const out: LatLng[] = [pts[0]];
  let last = pts[0];
  for (const p of pts) {
    if (haversineM(last, p) >= everyM) {
      out.push(p);
      last = p;
    }
  }
  const end = pts[pts.length - 1];
  if (haversineM(last, end) > everyM / 2) out.push(end);
  return out;
}

/** 격자별로 유일한 좌표만 로컬 경계 판정, 격자–지역 맵 반환 */
function resolveGrid(samples: LatLng[]): Map<string, Region | null> {
  const byGrid = new Map<string, LatLng>();
  for (const p of samples) {
    const k = gridKey(p);
    if (!byGrid.has(k)) byGrid.set(k, p);
  }
  const result = new Map<string, Region | null>();
  for (const [k, p] of byGrid) {
    const dong = adminDongAt(p);
    result.set(k, dong ? { sido: dong.sido, sigungu: dong.sigungu } : null);
  }
  return result;
}

/** 단일 주행: 지나온 순서대로 시·군·구(연속 중복 제거) */
export async function regionsAlongPath(enc: string): Promise<Region[]> {
  const pts = decodePolyline(enc).map(([lat, lng]) => ({ lat, lng }));
  const samples = sample(pts, 3000); // ~3km 간격
  if (samples.length === 0) return [];
  const grid = resolveGrid(samples);
  const out: Region[] = [];
  for (const p of samples) {
    const r = grid.get(gridKey(p));
    if (!r) continue;
    const prev = out[out.length - 1];
    if (prev && prev.sido === r.sido && prev.sigungu === r.sigungu) continue;
    out.push(r);
  }
  return out;
}

/** 정복 지도: 여러 주행을 합쳐 방문한 시·군·구 유일 집합(시/도–가나다) */
export async function regionsForPaths(encs: string[]): Promise<Region[]> {
  const all: LatLng[] = [];
  for (const enc of encs) {
    const pts = decodePolyline(enc).map(([lat, lng]) => ({ lat, lng }));
    // 정복은 넓으니 더 성기게(~6km), 전체 표본 상한으로 비용 방어
    for (const p of sample(pts, 6000)) all.push(p);
  }
  const MAX = 1500;
  const samples =
    all.length > MAX
      ? all.filter((_, i) => i % Math.ceil(all.length / MAX) === 0)
      : all;
  if (samples.length === 0) return [];
  const grid = resolveGrid(samples);
  const seen = new Set<string>();
  const out: Region[] = [];
  for (const r of grid.values()) {
    if (!r) continue;
    const k = `${r.sido}|${r.sigungu}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  out.sort((a, b) => a.sido.localeCompare(b.sido) || a.sigungu.localeCompare(b.sigungu));
  return out;
}
