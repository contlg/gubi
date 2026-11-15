import type { LatLng } from "./types";

type TrafficSample = LatLng & { state: number };
const CELL = 0.001;
// 작은 입력은 인덱스 생성보다 단순 반복이 빠르다.
const INDEX_THRESHOLD = 4_000_000;

/** 기존 거리식·반경·동점 시 첫 표본 우선 규칙을 유지하는 공간 검색. */
export function matchTrafficStates(
  path: readonly LatLng[],
  samples: readonly TrafficSample[] | undefined,
  radiusM = 70,
): Int8Array | null {
  if (!samples?.length) return null;
  const states = new Int8Array(path.length);
  const radius2 = radiusM * radiusM;
  const useIndex = path.length * samples.length >= INDEX_THRESHOLD;
  if (!useIndex) {
    for (let i = 0; i < path.length; i++) {
      const point = path[i];
      const kx = 111_320 * Math.cos(point.lat * Math.PI / 180);
      let best = radius2, state = 0;
      for (const sample of samples) {
        const dx = (sample.lng - point.lng) * kx;
        const dy = (sample.lat - point.lat) * 111_320;
        const distance2 = dx * dx + dy * dy;
        if (distance2 < best) { best = distance2; state = sample.state; }
      }
      states[i] = state;
    }
    return states;
  }
  const grid = new Map<number, Map<number, number[]>>();
  samples.forEach((sample, index) => {
    const y = Math.floor(sample.lat / CELL), x = Math.floor(sample.lng / CELL);
    let row = grid.get(y);
    if (!row) grid.set(y, row = new Map());
    const bucket = row.get(x);
    if (bucket) bucket.push(index);
    else row.set(x, [index]);
  });
  for (let i = 0; i < path.length; i++) {
    const point = path[i];
    const kx = 111_320 * Math.cos(point.lat * Math.PI / 180);
    const nx = Math.ceil(radiusM / (Math.abs(kx) * CELL));
    const ny = Math.ceil(radiusM / (111_320 * CELL));
    let best = radius2, state = 0, bestIndex = Infinity;
    const consider = (index: number) => {
      const sample = samples[index];
      const dx = (sample.lng - point.lng) * kx;
      const dy = (sample.lat - point.lat) * 111_320;
      const distance2 = dx * dx + dy * dy;
      if (distance2 < best || (distance2 === best && distance2 < radius2 && index < bestIndex)) {
        best = distance2;
        bestIndex = index;
        state = sample.state;
      }
    };
    // 극지방 등 경도 셀이 지나치게 넓어지는 경우는 기존 탐색으로 폴백한다.
    if (!Number.isFinite(nx) || nx > 8 || ny > 8) {
      for (let j = 0; j < samples.length; j++) consider(j);
    } else {
      const cx = Math.floor(point.lng / CELL), cy = Math.floor(point.lat / CELL);
      for (let y = cy - ny; y <= cy + ny; y++) {
        const row = grid.get(y);
        if (!row) continue;
        for (let x = cx - nx; x <= cx + nx; x++) {
          for (const index of row.get(x) ?? []) consider(index);
        }
      }
    }
    states[i] = state;
  }
  return states;
}
