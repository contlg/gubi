import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

// 개발자 옵션 "다른 내비 비교"용 — 반경 안 단속카메라를 출처별(공공·티맵·카카오)로.
// 서버 경고에 실제로 쓰는 자료(CAMS_REF)와 무관하게 셋 다. (api/dev/compare)
export type DevCam = { lat: number; lng: number; limit: number; kind: string; dir?: number };
export type DevSrc = "public" | "tmap" | "kakao";
const G = 0.01; // 격자 약 1km
let cache: { key: string; grid: Record<DevSrc, Map<string, DevCam[]>> } | null = null;

const file = (n: string) => join(/* turbopackIgnore: true */ process.cwd(), "data", n);
function mtime(n: string) {
  try {
    return statSync(file(n)).mtimeMs;
  } catch {
    return 0;
  }
}
function load() {
  const key = ["speedcams.json", "tmap-cams.json", "kakao-cams.json"].map(mtime).join(",");
  if (cache?.key === key) return cache.grid;
  const grid: Record<DevSrc, Map<string, DevCam[]>> = { public: new Map(), tmap: new Map(), kakao: new Map() };
  const put = (src: DevSrc, c: DevCam) => {
    const k = `${Math.floor(c.lat / G)},${Math.floor(c.lng / G)}`;
    const a = grid[src].get(k);
    if (a) a.push(c);
    else grid[src].set(k, [c]);
  };
  try {
    const j = JSON.parse(readFileSync(file("speedcams.json"), "utf8"));
    for (const kind of ["fixed", "signal", "section"] as const)
      for (const r of (j[kind] ?? []) as number[][]) put("public", { lat: r[0], lng: r[1], limit: r[2] ?? 0, kind });
  } catch {}
  for (const src of ["tmap", "kakao"] as const) {
    try {
      const j = JSON.parse(readFileSync(file(`${src}-cams.json`), "utf8"));
      for (const r of j.cams ?? []) {
        put(src, {
          lat: r.lat,
          lng: r.lng,
          limit: r.limit ?? 0,
          kind: r.sec ? "section" : r.signal ? "signal" : "fixed",
          ...(r.dir != null ? { dir: r.dir } : {}),
        });
      }
    } catch {}
  }
  cache = { key, grid };
  return grid;
}

export function devCamsNear(lat: number, lng: number, r: number): Record<DevSrc, DevCam[]> {
  const grid = load();
  const kx = 111320 * Math.cos((lat * Math.PI) / 180);
  const span = Math.ceil(r / 1000) + 1;
  const ci = Math.floor(lat / G), cj = Math.floor(lng / G);
  const out: Record<DevSrc, DevCam[]> = { public: [], tmap: [], kakao: [] };
  for (const src of ["public", "tmap", "kakao"] as const)
    for (let a = ci - span; a <= ci + span; a++)
      for (let b = cj - span; b <= cj + span; b++)
        for (const c of grid[src].get(`${a},${b}`) ?? [])
          if (Math.hypot((c.lng - lng) * kx, (c.lat - lat) * 111320) <= r) out[src].push(c);
  return out;
}
