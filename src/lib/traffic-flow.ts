/** ITS supplies speed, not authoritative four-grade Kakao states. */
export const ITS_FLOW_REVISION = "its-flow-v4-stable-jam-20261103";
const REFERENCE_KMH = [60, 100, 80, 80, 60, 70, 60, 50] as const;
export function flowReferenceKmh(rank: number): number { return REFERENCE_KMH[rank] ?? 60; }

// Selected only on the 17:44 training route families, then frozen before a
// separate 18:01 live validation. No route names or Kakao labels at runtime.
export const ITS_FLOW_THRESHOLDS = {
  highway: { jamRatio: 0.45, freeRatio: 0.80 },
  expressway: { jamRatio: 0.45, freeRatio: 0.97 },
  other: { jamRatio: 0.45, freeRatio: 0.55 },
} as const;

/** Before-calibration classifier, retained for same-observation comparisons. */
export function legacyFlowState(speedKmh: number, rank: number): number {
  if (!(speedKmh > 0) || !Number.isFinite(speedKmh)) return 0;
  const r = speedKmh / flowReferenceKmh(rank);
  return r >= .65 ? 4 : r >= .45 ? 3 : r >= .3 ? 2 : 1;
}

/**
 * Keep the previous jam/delay detection envelope (<45% of reference speed).
 * Report jam(1), slow(3), free(4); class2 had no reference observations and is
 * not manufactured as an extra speed band. Missing data always stays unknown.
 */
export function calibratedFlowState(speedKmh: number, rank: number): number {
  if (!(speedKmh > 0) || !Number.isFinite(speedKmh) || speedKmh > 160) return 0;
  const cuts = rank === 1 ? ITS_FLOW_THRESHOLDS.highway : rank === 2 ? ITS_FLOW_THRESHOLDS.expressway : ITS_FLOW_THRESHOLDS.other;
  const r = speedKmh / flowReferenceKmh(rank);
  return r < cuts.jamRatio ? 1 : r < cuts.freeRatio ? 3 : 4;
}
