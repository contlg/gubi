import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

import type { LatLng } from "./types";

/**
 * 세계 인구 1.5만+ 도시(GeoNames cities15000, 이름 한글 우선) — 해외 기록의 지명용.
 * 앱 오프라인 지명과 같은 파일(android/assets/cities.bin, scripts/build-offline-geo.mjs)을 읽는다.
 * 형식: gzip { int n; n×{ UTF name; UTF country; int lat,lng(1e5); int pop } } (빅엔디언)
 */
interface City { name: string; country: string; lat: number; lng: number; pop: number }
let cache: City[] | null = null;
function load(): City[] {
  if (cache) return cache;
  try {
    const b = gunzipSync(readFileSync(join(/* turbopackIgnore: true */ process.cwd(), "android/assets/cities.bin")));
    let o = 0;
    const int = () => { const v = b.readInt32BE(o); o += 4; return v; };
    const utf = () => { const n = b.readUInt16BE(o); o += 2; const s = b.toString("utf8", o, o + n); o += n; return s; };
    const n = int();
    const out: City[] = [];
    for (let i = 0; i < n; i++) {
      const name = utf(), country = utf();
      out.push({ name, country, lat: int() / 1e5, lng: int() / 1e5, pop: int() });
    }
    cache = out;
  } catch {
    cache = [];
  }
  return cache;
}

/** 가장 가까운 도시 — 50km 안에 인구 10만+가 있으면 그쪽 우선(OfflineGeo.nearestCity와 같은 규칙) */
export function nearestCity(p: LatLng): (City & { distKm: number }) | null {
  let best: City | null = null, big: City | null = null;
  let bd = Infinity, bbd = Infinity;
  const kx = 111.32 * Math.cos((p.lat * Math.PI) / 180);
  for (const c of load()) {
    if (Math.abs(c.lat - p.lat) > 5) continue;
    const d = Math.hypot((c.lng - p.lng) * kx, (c.lat - p.lat) * 110.54);
    if (d < bd) { bd = d; best = c; }
    if (c.pop >= 100_000 && d < bbd) { bbd = d; big = c; }
  }
  if (big && bbd <= 50) return { ...big, distKm: bbd };
  return best ? { ...best, distKm: bd } : null;
}
