export interface VehicleTrace {
  steering: [number, number][];
  brake: [number, boolean | null][];
  brakeOverflow: boolean;
  intervalMs: number;
}
export interface VehicleRecord {
  vehicleTrace?: VehicleTrace;
  maxSteeringDeg?: number;
  brakeCount?: number;
  brakeSeconds?: number;
}

const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;

/** Shared native import/server schema. Never reconstruct exact summaries from a sampled trace. */
export function sanitizeVehicleRecord(value: unknown, durationMs: number): VehicleRecord {
  if (!value || typeof value !== "object") return {};
  const x = value as Record<string, unknown>;
  const out: VehicleRecord = {};
  if (finite(x.maxSteeringDeg, 0, 2000)) out.maxSteeringDeg = x.maxSteeringDeg;
  if (finite(x.brakeCount, 0, 100_000_000) && Number.isInteger(x.brakeCount)) out.brakeCount = x.brakeCount;
  if (finite(x.brakeSeconds, 0, Math.max(0, durationMs) / 1000 + 1)) out.brakeSeconds = x.brakeSeconds;
  const t = x.vehicleTrace as VehicleTrace | undefined;
  if (!t || !Array.isArray(t.steering) || !Array.isArray(t.brake) || t.steering.length > 3600 || t.brake.length > 2000 ||
      !finite(t.intervalMs, 1000, 7 * 24 * 3600_000) || typeof t.brakeOverflow !== "boolean") return out;
  const ordered = (items: unknown[], steering: boolean) => items.every((p, i) => Array.isArray(p) && p.length === 2 &&
    finite(p[0], 0, durationMs + 1000) && (i === 0 || p[0] >= ((items[i - 1] as number[])[0])) &&
    (steering ? finite(p[1], -2000, 2000) : p[1] === null || typeof p[1] === "boolean"));
  if (!ordered(t.steering, true) || !ordered(t.brake, false)) return out;
  const trace: VehicleTrace = { steering: t.steering.map(([at, v]) => [at, v]), brake: t.brake.map(([at, v]) => [at, v]), brakeOverflow: t.brakeOverflow, intervalMs: t.intervalMs };
  if (new TextEncoder().encode(JSON.stringify(trace)).length <= 200_000) out.vehicleTrace = trace;
  return out;
}
