import { readFileSync } from "node:fs";
import { join } from "node:path";

// Main thread and worker threads share immutable road binaries (not cloned Buffers).
// Each Node process has one registry; workerData transfers SharedArrayBuffer handles.
const globalCache = globalThis as typeof globalThis & {
  __driveSharedRoadBinaries?: Map<string, SharedArrayBuffer>;
};
const binaryCache =
  globalCache.__driveSharedRoadBinaries ??
  (globalCache.__driveSharedRoadBinaries = new Map<string, SharedArrayBuffer>());

export function readRoadBinary(file: string): SharedArrayBuffer {
  const hit = binaryCache.get(file);
  if (hit) return hit;
  const contents = readFileSync(file);
  const shared = new SharedArrayBuffer(contents.byteLength);
  new Uint8Array(shared).set(contents);
  binaryCache.set(file, shared);
  return shared;
}

/** Read binaries once before spawning the first worker; subsequent workers reuse them. */
export function preloadRoadBinaries(): Record<string, SharedArrayBuffer> {
  // Only preload files actually used by the two routing loaders. The folders
  // contain additional large access-route and construction sidecars which
  // must not consume memory merely because a worker starts.
  const files: Record<string, string[]> = {
    roadgraph: [
      "nodes.bin", "edges-ab.bin", "edges-len.bin", "edges-cls.bin",
      "edges-maxspeed.bin", "edges-camlimit.bin", "edges-motorroad.bin",
      "edges-struct.bin", "edges-geom-idx.bin", "geom.bin",
      "edges-nodelink-mid.bin", "edges-nodelink-turn.bin",
      "nodelink-turn-forbid.bin", "nodes-ok.bin",
    ],
    nodelink: [
      "link-ids.bin", "link-rank.bin", "link-maxspeed.bin", "link-lanes.bin",
      "link-fromto.bin", "geom.bin", "geom-index.bin", "grid-keys.bin",
      "grid-offsets.bin", "grid-links.bin", "adj-offsets.bin", "adj-links.bin",
      "link-road-index.bin", "link-route-direction.bin", "link-roadtype.bin",
      "link-flags.bin",
    ],
  };
  for (const [folder, names] of Object.entries(files)) {
    const dir = join(process.cwd(), "src/lib/data", folder);
    for (const name of names) {
      // Sidecars are optional in older datasets; loaders retain their fallback.
      try { readRoadBinary(join(dir, name)); } catch { /* optional/missing data */ }
    }
  }
  return Object.fromEntries(binaryCache);
}

/** Called by the worker entry before loading any routing modules. */
export function installSharedRoadBinaries(
  binaries: Record<string, SharedArrayBuffer> | undefined,
): void {
  if (!binaries) return;
  for (const [file, buffer] of Object.entries(binaries)) {
    if (buffer instanceof SharedArrayBuffer) binaryCache.set(file, buffer);
  }
}
