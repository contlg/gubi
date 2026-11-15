import "server-only";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

interface RoadLevelMetadata {
  names: string[];
  edgeNames: Uint32Array;
  layers: Int8Array;
}

let cached: RoadLevelMetadata | null | undefined;

// 선택적인 보강 자료가 없거나 오래되면 도로 높이 판정을 보류한다.
export function readRoadLevelMetadata(edgeCount: number): RoadLevelMetadata | null {
  if (cached !== undefined) return cached;
  cached = null;
  try {
    const dir = join(process.cwd(), "data/road-levels");
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    if (manifest.version !== 1 || manifest.edges !== edgeCount) return null;
    const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");
    const expected = ["nodes.bin", "edges-ab.bin", "edges-cls.bin", "edges-struct.bin", "edges-geom-idx.bin", "edges-len.bin"];
    for (const file of expected) {
      if (digest(readFileSync(join(process.cwd(), "src/lib/data/roadgraph", file))) !== manifest.graphHashes?.[file]) return null;
    }
    const load = (file: string) => {
      const data = readFileSync(join(dir, file));
      if (digest(data) !== manifest.hashes?.[file]) throw new Error("Road-level sidecar checksum mismatch");
      return data;
    };
    const names: unknown = JSON.parse(load("names.json").toString("utf8"));
    const indexes = load("edge-names.bin"), layers = load("edge-layers.bin");
    if (!Array.isArray(names) || names.some((s) => typeof s !== "string")
        || indexes.byteLength !== edgeCount * 4 || layers.byteLength !== edgeCount) return null;
    const edgeNames = new Uint32Array(indexes.buffer, indexes.byteOffset, edgeCount);
    if (edgeNames.some((n) => n >= names.length)) return null;
    cached = { names, edgeNames, layers: new Int8Array(layers.buffer, layers.byteOffset, edgeCount) };
  } catch {
    // 보강 자료를 읽지 못해도 카메라 경고는 숨기지 않는다.
  }
  return cached;
}
