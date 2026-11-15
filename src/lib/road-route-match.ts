import type { LatLng } from "./types";

/** IDs must come from the same documented road network, never from road names. */
export interface DirectedRoadId {
  network: string;
  id: string;
  direction: string;
  level?: string | number;
}
export interface RoadRoute {
  kind: "road-polyline" | "waypoints" | "summary";
  points?: readonly LatLng[];
  /** Identity of points[i] -> points[i+1]; optional entries stay unverified. */
  roads?: readonly (DirectedRoadId | null)[];
}
export interface RouteMatchOptions {
  maxDistanceM?: number;
  maxHeadingDeg?: number;
  sampleM?: number;
  minRunM?: number;
}
export interface MatchedRoutePiece {
  fromM: number;
  toM: number;
  referenceFromM: number;
  referenceToM: number;
  evidence: "directed-road-id" | "geometry-only";
  maxDistanceM: number;
}
export interface RoadRouteMatch {
  /** Verified physical road agreement, not merely nearby coordinates. */
  status: "same" | "partial" | "different" | "unknown";
  geometryStatus: "same" | "partial" | "different" | "unknown";
  targetDistanceM: number;
  referenceDistanceM: number;
  matchedM: number;
  matchedRatio: number;
  trafficEligibleM: number;
  pieces: MatchedRoutePiece[];
  reasons: string[];
}
type Point = { x: number; y: number };
type Segment = { a: Point; b: Point; fromM: number; length: number; road?: DirectedRoadId | null };
type Projection = { at: number; distance: number; segment: Segment; verified: boolean };
const GRID = 50;
const MAX_POINTS = 50_000;
const MAX_CELLS = 1_000_000;
const length = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y);
const lerp = (a: Point, b: Point, t: number): Point => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

function validId(id: DirectedRoadId | null | undefined): id is DirectedRoadId {
  return !!id && [id.network, id.id, id.direction].every(v => typeof v === "string" && v.length > 0);
}
function identity(a: DirectedRoadId | null | undefined, b: DirectedRoadId | null | undefined): "same" | "different" | "unknown" {
  if (a?.level != null && b?.level != null && String(a.level) !== String(b.level)) return "different";
  if (!validId(a) || !validId(b) || a.network !== b.network) return "unknown";
  return a.id === b.id && a.direction === b.direction ? "same" : "different";
}
function prepare(route: RoadRoute, origin: LatLng): Segment[] | null {
  if (route.kind !== "road-polyline" || !route.points || route.points.length < 2 || route.points.length > MAX_POINTS) return null;
  if (route.roads && route.roads.length !== route.points.length - 1) return null;
  if (route.points.some(p => !p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng) || Math.abs(p.lat) > 85 || Math.abs(p.lng) > 180 || Math.abs(p.lng - origin.lng) > 10 || Math.abs(p.lat - origin.lat) > 10)) return null;
  const mx = 111_320 * Math.cos(origin.lat * Math.PI / 180);
  const points = route.points.map(p => ({ x: (p.lng - origin.lng) * mx, y: (p.lat - origin.lat) * 110_540 }));
  const segments: Segment[] = [];
  let fromM = 0;
  for (let i = 1; i < points.length; i++) {
    const n = length(points[i - 1], points[i]);
    if (n < 0.01) continue;
    // Very sparse endpoints are insufficient evidence for a road's actual shape.
    if (n > 2_000) return null;
    segments.push({ a: points[i - 1], b: points[i], fromM, length: n, road: route.roads?.[i - 1] });
    fromM += n;
  }
  return segments.length ? segments : null;
}
function total(segments: Segment[]): number { const last = segments.at(-1); return last ? last.fromM + last.length : 0; }
function empty(reason: string, targetDistanceM = 0, referenceDistanceM = 0): RoadRouteMatch {
  return { status: "unknown", geometryStatus: "unknown", targetDistanceM, referenceDistanceM, matchedM: 0, matchedRatio: 0, trafficEligibleM: 0, pieces: [], reasons: [reason] };
}

/**
 * Ordered directed segment matching. Geometric similarity is reported separately
 * from road identity: parallel/stacked roads without IDs can never adopt traffic.
 * Outputs distance correspondences, not a single whole-route percentage.
 */
export function compareRoadRoutes(target: RoadRoute, reference: RoadRoute, options: RouteMatchOptions = {}): RoadRouteMatch {
  const radius = options.maxDistanceM ?? 8;
  const angle = options.maxHeadingDeg ?? 15;
  const step = options.sampleM ?? 20;
  const minRun = options.minRunM ?? 80;
  if (![radius, angle, step, minRun].every(Number.isFinite) || radius < 0.1 || radius > 30 || angle < 0 || angle > 45 || step < 2 || step > 40 || minRun < 20 || minRun > 1000) return empty("invalid_options");
  const origin = target.points?.[0];
  if (!origin || !Number.isFinite(origin.lat) || !Number.isFinite(origin.lng)) return empty("missing_road_geometry");
  const ts = prepare(target, origin), rs = prepare(reference, origin);
  if (!ts || !rs) return empty("missing_or_invalid_road_geometry");
  const referenceSegments = rs;
  const targetLength = total(ts), referenceLength = total(rs);
  if (targetLength / step > 50_000 || referenceLength / step > 50_000) return empty("route_too_large", targetLength, referenceLength);
  const grid = new Map<string, Set<number>>();
  let cells = 0;
  rs.forEach((s, id) => {
    // Insert short portions instead of filling a diagonal segment's huge box.
    const n = Math.max(1, Math.ceil(s.length / GRID));
    for (let i = 0; i < n; i++) {
      const a = lerp(s.a, s.b, i / n), b = lerp(s.a, s.b, (i + 1) / n);
      for (let x = Math.floor((Math.min(a.x, b.x) - radius) / GRID); x <= Math.floor((Math.max(a.x, b.x) + radius) / GRID); x++) {
        for (let y = Math.floor((Math.min(a.y, b.y) - radius) / GRID); y <= Math.floor((Math.max(a.y, b.y) + radius) / GRID); y++) {
          if (++cells > MAX_CELLS) return;
          const key = `${x},${y}`;
          let bucket = grid.get(key); if (!bucket) grid.set(key, bucket = new Set());
          bucket.add(id);
        }
      }
    }
  });
  if (cells > MAX_CELLS) return empty("route_too_large", targetLength, referenceLength);
  const reasons = new Set<string>();
  const cosine = Math.cos(angle * Math.PI / 180);
  function project(p: Point, segment: Segment, floor: number): Projection | null {
    const ids = grid.get(`${Math.floor(p.x / GRID)},${Math.floor(p.y / GRID)}`);
    const candidates: Projection[] = [];
    for (const id of ids ?? []) {
      const s = referenceSegments[id];
      const dot = ((segment.b.x - segment.a.x) * (s.b.x - s.a.x) + (segment.b.y - segment.a.y) * (s.b.y - s.a.y)) / (segment.length * s.length);
      if (dot < cosine) continue;
      const relation = identity(segment.road, s.road);
      if (relation === "different") { reasons.add("road_identity_or_level_conflict"); continue; }
      const dx = s.b.x - s.a.x, dy = s.b.y - s.a.y;
      const t = Math.max(0, Math.min(1, ((p.x - s.a.x) * dx + (p.y - s.a.y) * dy) / (s.length * s.length)));
      const d = length(p, lerp(s.a, s.b, t));
      const at = s.fromM + t * s.length;
      if (d > radius || at < floor - 0.5) continue;
      candidates.push({ at, distance: d, segment: s, verified: relation === "same" });
    }
    candidates.sort((a, b) => a.distance - b.distance || a.at - b.at);
    const best = candidates[0];
    if (!best) return null;
    // Repeated loops/close parallel branches can produce two plausible stations.
    if (candidates.some(c => Math.abs(c.at - best.at) > 2 * step && c.distance <= best.distance + 2)) {
      reasons.add("ambiguous_reference_position"); return null;
    }
    return best;
  }
  const raw: MatchedRoutePiece[] = [];
  let previous: MatchedRoutePiece | null = null;
  for (const segment of ts) {
    const n = Math.max(1, Math.ceil(segment.length / step));
    for (let i = 0; i < n; i++) {
      const start = segment.fromM + segment.length * i / n;
      const end = segment.fromM + segment.length * (i + 1) / n;
      const floor = previous?.referenceToM ?? 0;
      const a = project(lerp(segment.a, segment.b, i / n), segment, floor);
      const m = project(lerp(segment.a, segment.b, (i + .5) / n), segment, a?.at ?? floor);
      const b = project(lerp(segment.a, segment.b, (i + 1) / n), segment, m?.at ?? floor);
      if (!a || !m || !b) continue;
      const span = b.at - a.at, expected = end - start;
      if (span < expected * .75 || span > expected * 1.25) { reasons.add("distance_progress_conflict"); continue; }
      if (previous && a.at - previous.referenceToM > Math.max(60, (start - previous.toM) * 2 + 20)) {
        reasons.add("route_order_conflict"); continue;
      }
      const piece: MatchedRoutePiece = { fromM: start, toM: end, referenceFromM: a.at, referenceToM: b.at,
        evidence: a.verified && m.verified && b.verified ? "directed-road-id" : "geometry-only",
        maxDistanceM: Math.max(a.distance, m.distance, b.distance) };
      raw.push(piece); previous = piece;
    }
  }
  // An isolated intersection or short touch is never a matching road section.
  const pieces: MatchedRoutePiece[] = [];
  let run: MatchedRoutePiece[] = [];
  const finish = () => { if (run.reduce((n, p) => n + p.toM - p.fromM, 0) >= minRun) pieces.push(...run); else if (run.length) reasons.add("shared_section_too_short"); run = []; };
  for (const p of raw) {
    const last = run.at(-1);
    if (last && (p.fromM - last.toM > .1 || p.referenceFromM - last.referenceToM > 2 || p.evidence !== last.evidence)) finish();
    run.push(p);
  }
  finish();
  const matchedM = pieces.reduce((n, p) => n + p.toM - p.fromM, 0);
  const verifiedM = pieces.filter(p => p.evidence === "directed-road-id").reduce((n, p) => n + p.toM - p.fromM, 0);
  const referenceMatched = pieces.reduce((n, p) => n + p.referenceToM - p.referenceFromM, 0);
  const referenceVerified = pieces.filter(p => p.evidence === "directed-road-id").reduce((n, p) => n + p.referenceToM - p.referenceFromM, 0);
  if (matchedM > verifiedM) reasons.add("geometry_does_not_prove_road_identity");
  const same = matchedM / targetLength >= .98 && referenceMatched / referenceLength >= .98;
  const geometryStatus = same ? "same" : matchedM > 0 ? "partial" : reasons.has("ambiguous_reference_position") ? "unknown" : "different";
  const verifiedSame = verifiedM / targetLength >= .98 && referenceVerified / referenceLength >= .98;
  return { status: verifiedSame ? "same" : verifiedM > 0 ? "partial" : geometryStatus === "different" ? "different" : "unknown", geometryStatus,
    targetDistanceM: targetLength, referenceDistanceM: referenceLength, matchedM,
    matchedRatio: Math.min(1, matchedM / targetLength), trafficEligibleM: verifiedM, pieces, reasons: [...reasons] };
}

export interface ReferenceTrafficRange { fromM: number; toM: number; state: number }
export interface AcceptedTrafficRange extends ReferenceTrafficRange { source: "hyundai" }
export interface DistanceTrafficSample { distanceM: number; state: number }
/** Adopt only proven matching pieces; unmatched/uncertain pieces keep ITS. */
export function projectVerifiedTraffic(match: RoadRouteMatch, traffic: readonly ReferenceTrafficRange[]): AcceptedTrafficRange[] {
  const accepted: AcceptedTrafficRange[] = [];
  const valid = traffic.filter(r => Number.isFinite(r.fromM) && Number.isFinite(r.toM) && r.fromM >= 0 && r.toM > r.fromM && r.toM <= match.referenceDistanceM + .01 && Number.isInteger(r.state) && r.state >= 1 && r.state <= 4);
  for (const p of match.pieces) {
    if (p.evidence !== "directed-road-id") continue;
    // Conflicting provider intervals are discarded, never resolved by array order.
    for (const r of valid) {
      const a = Math.max(p.referenceFromM, r.fromM), b = Math.min(p.referenceToM, r.toM);
      if (b <= a || valid.some(other => other !== r && other.state !== r.state && Math.min(b, other.toM) > Math.max(a, other.fromM))) continue;
      const span = p.referenceToM - p.referenceFromM;
      if (span <= 0) continue;
      accepted.push({ fromM: p.fromM + (a - p.referenceFromM) / span * (p.toM - p.fromM),
        toM: p.fromM + (b - p.referenceFromM) / span * (p.toM - p.fromM), state: r.state, source: "hyundai" });
    }
  }
  return accepted;
}

/** Fresh verified Hyundai sections take priority; all other samples keep ITS. */
export function mergeVerifiedTraffic(
  base: readonly DistanceTrafficSample[],
  match: RoadRouteMatch,
  traffic: readonly ReferenceTrafficRange[],
  receivedAt: number,
  now = Date.now(),
): (DistanceTrafficSample & { source: "its" | "hyundai" })[] {
  const fresh = Number.isFinite(receivedAt) && Number.isFinite(now) && receivedAt <= now + 5_000 && now - receivedAt <= 120_000;
  const accepted = fresh ? projectVerifiedTraffic(match, traffic) : [];
  return base.map(sample => {
    const found = accepted.find(r => sample.distanceM >= r.fromM && sample.distanceM < r.toM);
    return { ...sample, state: found?.state ?? sample.state, source: found ? "hyundai" : "its" };
  });
}
