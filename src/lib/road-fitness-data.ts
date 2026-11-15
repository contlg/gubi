import "server-only";

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  computeCourseFitness, createFitnessIndex, FITNESS_SCHEMA_VERSION,
  type CourseFitness, type FitnessIndex, type FitnessInventorySegment, type RoadHotspot,
} from "@/lib/road-fitness";
import type { LatLng } from "@/lib/types";

interface Snapshot { stamp: string; id: string }
const snapshots = new Map<string, Snapshot>();
function snapshot(file: string): Snapshot {
  try {
    const stat = statSync(file);
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const previous = snapshots.get(file);
    if (previous?.stamp === stamp) return previous;
    const raw = readFileSync(file);
    const next = { stamp, id: createHash("sha256").update(raw).digest("hex") };
    snapshots.set(file, next);
    return next;
  } catch {
    // Deletion must disable old data too, rather than retaining a stale last-good layer.
    snapshots.delete(file);
    return { stamp: "missing", id: "missing" };
  }
}

function readJson(file: string): unknown {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return null; }
}

/** The host writes a complete snapshot only after both endpoints/regions succeed. */
export function loadHotspots(file = join(process.cwd(), "data/koroad-hotspots.json")): RoadHotspot[] | null {
  const value = readJson(file);
  if (!Array.isArray(value)) return null;
  if (!value.every((v) => v && ["accident", "school-zone"].includes(v.kind) &&
    typeof v.name === "string" && Number.isFinite(v.lat) && Math.abs(v.lat) <= 90 &&
    Number.isFinite(v.lng) && Math.abs(v.lng) <= 180 && Number.isFinite(v.count) && v.count >= 0 &&
    Number.isInteger(v.year))) return null;
  return value as RoadHotspot[];
}

function dataSnapshots() {
  const winding = snapshot(join(process.cwd(), "src/lib/data/winding-segments.json"));
  const riverside = snapshot(join(process.cwd(), "src/lib/data/riverside-segments.json"));
  const hotspots = snapshot(join(process.cwd(), "data/koroad-hotspots.json"));
  const id = createHash("sha256").update(`${FITNESS_SCHEMA_VERSION}:${winding.id}:${riverside.id}:${hotspots.id}`).digest("hex");
  return id;
}

export function fitnessGenerationId(): string { return dataSnapshots(); }

let cachedIndex: FitnessIndex | undefined;
export function currentFitnessIndex(): FitnessIndex {
  const id = dataSnapshots();
  if (cachedIndex?.generationId === id) return cachedIndex;
  // Only workers that annotate a course need parsed inventory, retained via the
  // spatial index rather than a second parsed copy in the generation cache.
  const inventory = ["winding-segments.json", "riverside-segments.json"]
    .flatMap((file) => {
      const value = readJson(join(process.cwd(), "src/lib/data", file));
      return Array.isArray(value) ? value : [];
    }) as FitnessInventorySegment[];
  cachedIndex = createFitnessIndex(inventory, loadHotspots(), id);
  return cachedIndex;
}

export function annotateCourseFitness<T extends { path: LatLng[]; distanceM: number }>(candidate: T): T & { fitness: CourseFitness } {
  return Object.assign(candidate, { fitness: computeCourseFitness(candidate.path, candidate.distanceM, currentFitnessIndex()) });
}
