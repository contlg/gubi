import type { LatLng } from "@/lib/types";

export const FITNESS_SCHEMA_VERSION = 5;
// Inventory evidence has not changed; result/cache semantics have.
export const ROAD_EVIDENCE_VERSION = 1;

/** null is unobserved/unrecognized, never a claim that a road is suitable. */
export interface RoadEvidenceSpan {
  fromM: number;
  toM: number;
  surface: "paved" | "unpaved" | null;
  widthM: number | null;
  lanes: number | null;
  /** Relative to the stored geometry, including reversed source ways. */
  oneway: -1 | 0 | 1 | null;
}

export interface FitnessInventorySegment {
  pts: [number, number][];
  evidenceVersion?: number;
  evidence?: RoadEvidenceSpan[];
}

export interface RoadHotspot {
  id?: string;
  kind: "accident" | "school-zone";
  name: string;
  lat: number;
  lng: number;
  count: number;
  year: number;
}

export interface CourseFitness {
  schemaVersion: number;
  generationId: string;
  totalM: number;
  unpavedM: number;
  narrowM: number;
  againstOnewayM: number;
  /** Length with unknown surface, including uncovered connectors. */
  unknownM: number;
  unknownRatioPct: number;
  /** Length with lanes OR width known / course length. Display only. */
  widthKnownPct: number;
  /** Locations, not the number of historical crashes. null means data unavailable. */
  hotspots: { accident: number | null; schoolZone: number | null };
}

/** Points per percentage point of course length / matched location. Unknown has no cost. */
export const FITNESS_PENALTIES = Object.freeze({
  unpavedPerPct: 2,
  unpavedCap: 30,
  narrowPerPct: 1,
  narrowCap: 15,
  againstOnewayThresholdM: 50,
  againstOneway: 30,
  accident: 2,
  schoolZone: 3,
  hotspotCap: 12,
});

export function fitnessPenalty(fitness?: CourseFitness): number {
  if (!fitness) return 0;
  const p = FITNESS_PENALTIES;
  const sharePct = (m: number) => fitness.totalM > 0 ? 100 * Math.max(0, m) / fitness.totalM : 0;
  return Math.min(p.unpavedCap, sharePct(fitness.unpavedM) * p.unpavedPerPct) +
    Math.min(p.narrowCap, sharePct(fitness.narrowM) * p.narrowPerPct) +
    (fitness.againstOnewayM > p.againstOnewayThresholdM ? p.againstOneway : 0) +
    Math.min(p.hotspotCap, (fitness.hotspots.accident ?? 0) * p.accident +
      (fitness.hotspots.schoolZone ?? 0) * p.schoolZone);
}

const KY = 110540;
const kx = (lat: number) => Math.cos(lat * Math.PI / 180) * 111320;
// Same linear metric as the inventory builder. Course totals use routing distance.
export const geometryDistanceM = (a: LatLng, b: LatLng) =>
  Math.hypot((b.lng - a.lng) * kx(a.lat), (b.lat - a.lat) * KY);
const mix = (a: LatLng, b: LatLng, t: number): LatLng => ({
  lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t,
});

const CELL = 0.001;
const cellKey = (r: number, c: number) => `${r},${c}`;
function visitCells(a: LatLng, b: LatLng, padding: number, visit: (key: string) => void) {
  // Walking the line avoids scanning a huge diagonal bounding box on sparse paths.
  const steps = Math.max(1, Math.ceil(geometryDistanceM(a, b) / 50));
  const seen = new Set<string>();
  for (let i = 0; i <= steps; i++) {
    const p = mix(a, b, i / steps);
    const r = Math.floor(p.lat / CELL), c = Math.floor(p.lng / CELL);
    for (let dr = -padding; dr <= padding; dr++) for (let dc = -padding; dc <= padding; dc++) {
      const key = cellKey(r + dr, c + dc);
      if (!seen.has(key)) { seen.add(key); visit(key); }
    }
  }
}

interface EvidenceEdge { a: LatLng; b: LatLng; span: RoadEvidenceSpan }
export interface FitnessIndex {
  edges: EvidenceEdge[];
  grid: Map<string, number[]>;
  hotspots: RoadHotspot[] | null;
  hotspotGrid: Map<string, number[]>;
  generationId: string;
}

export function createFitnessIndex(
  inventory: FitnessInventorySegment[],
  hotspots: RoadHotspot[] | null,
  generationId = "test",
): FitnessIndex {
  const index: FitnessIndex = { edges: [], grid: new Map(), hotspots, hotspotGrid: new Map(), generationId };
  const add = (grid: Map<string, number[]>, key: string, value: number) => {
    const bucket = grid.get(key);
    if (bucket) bucket.push(value); else grid.set(key, [value]);
  };
  for (const segment of inventory) {
    // Legacy aggregate narrow ratios cannot establish evidence for a traversed part.
    if (segment.evidenceVersion !== ROAD_EVIDENCE_VERSION || !segment.evidence?.length) continue;
    let offset = 0, firstSpan = 0;
    for (let i = 1; i < segment.pts.length; i++) {
      const a = { lat: segment.pts[i - 1][0], lng: segment.pts[i - 1][1] };
      const b = { lat: segment.pts[i][0], lng: segment.pts[i][1] };
      const length = geometryDistanceM(a, b);
      if (length <= 0) continue;
      while (firstSpan < segment.evidence.length && segment.evidence[firstSpan].toM <= offset) firstSpan++;
      for (let j = firstSpan; j < segment.evidence.length; j++) {
        const span = segment.evidence[j];
        if (span.fromM >= offset + length) break;
        const lo = Math.max(0, (span.fromM - offset) / length);
        const hi = Math.min(1, (span.toM - offset) / length);
        if (hi <= lo) continue;
        const edge = { a: mix(a, b, lo), b: mix(a, b, hi), span };
        const id = index.edges.push(edge) - 1;
        visitCells(edge.a, edge.b, 0, (key) => add(index.grid, key, id));
      }
      offset += length;
    }
  }
  hotspots?.forEach((spot, id) => {
    add(index.hotspotGrid, cellKey(Math.floor(spot.lat / CELL), Math.floor(spot.lng / CELL)), id);
  });
  return index;
}

// Evidence requires close, parallel geometry; a crossing is not supporting evidence.
const EVIDENCE_MATCH_M = 10;
// Surface/width must be close enough to distinguish an adjacent uninventoried
// road. Keep the wider direction search to avoid false oneway violations.
const ATTRIBUTE_MATCH_M = 5;
interface Match { lo: number; hi: number; reverse: boolean; edge: EvidenceEdge; distanceAt: (t: number) => number }
function matchEdge(a: LatLng, b: LatLng, edge: EvidenceEdge, maxDistanceM = EVIDENCE_MATCH_M): Match | null {
  const sx = kx((a.lat + b.lat) / 2);
  const rx = (b.lng - a.lng) * sx, ry = (b.lat - a.lat) * KY;
  const ex = (edge.b.lng - edge.a.lng) * sx, ey = (edge.b.lat - edge.a.lat) * KY;
  const el = Math.hypot(ex, ey), rl = Math.hypot(rx, ry);
  if (!el || !rl) return null;
  const dot = rx * ex + ry * ey;
  if (Math.abs(dot / (el * rl)) < 0.95) return null;
  const ax = (a.lng - edge.a.lng) * sx, ay = (a.lat - edge.a.lat) * KY;
  const u0 = (ax * ex + ay * ey) / (el * el), du = dot / (el * el);
  const d0 = (ex * ay - ey * ax) / el, dd = (ex * ry - ey * rx) / el;
  let lo = 0, hi = 1;
  const restrict = (base: number, delta: number, min: number, max: number) => {
    if (Math.abs(delta) < 1e-10) return base >= min && base <= max;
    const t0 = (min - base) / delta, t1 = (max - base) / delta;
    lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
    return hi > lo;
  };
  if (!restrict(u0, du, 0, 1) || !restrict(d0, dd, -maxDistanceM, maxDistanceM)) return null;
  return { lo, hi, reverse: dot < 0, edge, distanceAt: (t) => Math.abs(d0 + dd * t) };
}

export function pointPolylineDistanceM(point: LatLng, path: LatLng[]): number {
  let best = Infinity;
  const sx = kx(point.lat);
  for (let i = 1; i < path.length; i++) {
    const ax = (path[i - 1].lng - point.lng) * sx, ay = (path[i - 1].lat - point.lat) * KY;
    const dx = (path[i].lng - path[i - 1].lng) * sx, dy = (path[i].lat - path[i - 1].lat) * KY;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
  }
  return best;
}

/** Single annotator input is always the FINAL ordered path, including connectors. */
export function computeCourseFitness(path: LatLng[], distanceM: number, index: FitnessIndex): CourseFitness {
  const lengths = path.slice(1).map((p, i) => geometryDistanceM(path[i], p));
  const geometryM = lengths.reduce((sum, m) => sum + m, 0);
  const totalM = Number.isFinite(distanceM) && distanceM > 0 ? distanceM : geometryM;
  const scale = geometryM > 0 ? totalM / geometryM : 0;
  let unpavedM = 0, narrowM = 0, againstOnewayM = 0, surfaceKnownM = 0, widthKnownM = 0;
  const matchedHotspots = new Set<string>();
  let accident = 0, schoolZone = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], length = lengths[i - 1] * scale;
    if (length <= 0) continue;
    const edgeIds = new Set<number>(), spotIds = new Set<number>();
    visitCells(a, b, 1, (key) => {
      for (const id of index.grid.get(key) ?? []) edgeIds.add(id);
      for (const id of index.hotspotGrid.get(key) ?? []) spotIds.add(id);
    });
    const matches = [...edgeIds].map((id) => matchEdge(a, b, index.edges[id])).filter((m): m is Match => m !== null);
    const closeMatches = matches.map((m) => matchEdge(a, b, m.edge, ATTRIBUTE_MATCH_M))
      .filter((m): m is Match => m !== null);
    const cuts = [...new Set([0, 1, ...matches.flatMap((m) => [m.lo, m.hi]),
      ...closeMatches.flatMap((m) => [m.lo, m.hi])])].sort((x, y) => x - y);
    for (let j = 1; j < cuts.length; j++) {
      const mid = (cuts[j - 1] + cuts[j]) / 2;
      const covering = matches.filter((m) => m.lo <= mid && m.hi >= mid);
      if (!covering.length) continue;
      const nearest = closeMatches.filter((m) => m.lo <= mid && m.hi >= mid)
        .sort((x, y) => x.distanceAt(mid) - y.distanceAt(mid))[0];
      const m = (cuts[j] - cuts[j - 1]) * length;
      if (nearest) {
        const span = nearest.edge.span;
        if (span.surface === "unpaved") unpavedM += m;
        if ((span.lanes !== null && span.lanes <= 1) || (span.widthM !== null && span.widthM < 4.5)) narrowM += m;
        if (span.surface != null) surfaceKnownM += m;
        if (span.widthM != null || span.lanes != null) widthKnownM += m;
      }
      // Require a close edge on this sub-span; a lone adjacent carriageway is
      // direction-unknown. Every covering edge within 10m, including the nearest
      // close edge, must prohibit this traversal before confirming a violation.
      if (nearest && covering.every(({ edge, reverse }) => reverse ? edge.span.oneway === 1 : edge.span.oneway === -1)) againstOnewayM += m;
    }
    for (const id of spotIds) {
      const spot = index.hotspots![id];
      const key = `${spot.kind}:${spot.id ?? `${spot.year}:${spot.lat}:${spot.lng}:${spot.name}`}`;
      if (!matchedHotspots.has(key) && pointPolylineDistanceM(spot, [a, b]) <= 50 + 1e-7) {
        matchedHotspots.add(key);
        if (spot.kind === "accident") accident++; else schoolZone++;
      }
    }
  }
  const unknownM = Math.max(0, totalM - surfaceKnownM);
  return {
    schemaVersion: FITNESS_SCHEMA_VERSION, generationId: index.generationId, totalM,
    unpavedM, narrowM, againstOnewayM, unknownM,
    unknownRatioPct: totalM > 0 ? 100 * unknownM / totalM : 100,
    widthKnownPct: totalM > 0 ? Math.min(100, 100 * widthKnownM / totalM) : 0,
    hotspots: { accident: index.hotspots === null ? null : accident, schoolZone: index.hotspots === null ? null : schoolZone },
  };
}
