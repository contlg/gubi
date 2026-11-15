// 오프라인 지도 타일 — 서비스워커 등록 + 코스 주변 타일 미리 저장(프리페치).
//
// NavMap의 타일 URL 규약과 호스트를 그대로 맞춘다(sw.js의 TILE_HOSTS와도 일치).
// 프리페치는 caches.open으로 캐시를 직접 채워, SW가 아직 페이지를 제어하지
// 않는 첫 로드에도 동작한다. SW의 fetch 핸들러가 같은 캐시를 읽는다.

import { BORROW_SERVER } from "@/lib/borrow-mode";
import type { LatLng } from "@/lib/types";

const TILE_CACHE = "drive-tiles-v1";

export type TileMode = "road" | "sat";
const tileUrl = (mode: TileMode, z: number, x: number, y: number) =>
  mode === "sat"
    ? `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
    : `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;

export function registerTileSW() {
  // 빌려 쓰기 모드는 drivelog 주소에서 열린다 — /sw.js가 drivelog 자신의 것이라 등록하지 않는다.
  if (BORROW_SERVER) return;
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // 로드 부하와 안 겹치게 idle 후 등록
  const go = () => navigator.serviceWorker.register("/sw.js").catch(() => {});
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
}

function lngLatToTile(lat: number, lng: number, z: number) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n,
  );
  return { x: ((x % n) + n) % n, y: Math.max(0, Math.min(n - 1, y)) };
}

// 프리페치 줌: 개요(13)~주행 상세(16). 상한 초과 시 높은 줌부터 뺀다.
const PREFETCH_ZOOMS = [13, 14, 15, 16];
const MAX_TILES = 4000;

/** path(코스 좌표열) 주변 회랑 타일 집합 — 각 점 타일 ±1로 도로 폭을 덮는다 */
function corridorTiles(path: LatLng[], zooms: number[]): string[] {
  const set = new Set<string>();
  for (const z of zooms) {
    for (const p of path) {
      const { x, y } = lngLatToTile(p.lat, p.lng, z);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++) set.add(`${z}/${x + dx}/${y + dy}`);
    }
  }
  return [...set];
}

export interface PrefetchResult {
  saved: number;
  total: number;
  capped: boolean;
}

/**
 * 코스 경로 주변 타일을 캐시에 미리 저장. onProgress(done,total)로 진행률.
 * 상한(MAX_TILES) 초과면 낮은 줌만 저장하고 capped=true.
 */
export async function prefetchRouteTiles(
  path: LatLng[],
  mode: TileMode,
  onProgress?: (done: number, total: number) => void,
): Promise<PrefetchResult> {
  if (!("caches" in window) || path.length < 2) {
    return { saved: 0, total: 0, capped: false };
  }
  // 상한에 맞게 줌 축소 (높은 줌=타일 급증부터 제외)
  let zooms = PREFETCH_ZOOMS;
  let keys = corridorTiles(path, zooms);
  let capped = false;
  while (keys.length > MAX_TILES && zooms.length > 1) {
    zooms = zooms.slice(0, -1);
    keys = corridorTiles(path, zooms);
    capped = true;
  }
  if (keys.length > MAX_TILES) {
    keys = keys.slice(0, MAX_TILES);
    capped = true;
  }

  const cache = await caches.open(TILE_CACHE);
  const total = keys.length;
  let done = 0;
  let saved = 0;
  // OSM 타일 사용정책: 동시 스레드 ≤2, 대량 다운로드 자제. 위반 시 IP가
  // 타일서버에서 차단돼 지도가 통째로 죽는다. 동시 2 + 타일당 소폭 지연으로
  // 정책을 지킨다(느리지만 안전 — 프리페치는 백그라운드 1회성이라 괜찮다).
  const CONC = 2;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  let idx = 0;
  async function worker() {
    while (idx < keys.length) {
      const k = keys[idx++];
      const [z, x, y] = k.split("/").map(Number);
      const url = tileUrl(mode, z, x, y);
      try {
        const hit = await cache.match(url);
        if (!hit) {
          // no-cors(opaque, status 0) 응답은 cache.add()가 거부해 하나도 안 저장됐다.
          // 두 타일 서버 모두 CORS를 허용하니 일반 fetch로 받아 ok인 것만 put.
          // 키는 URL 문자열 — 지도 <img> 요청(헤더 없음)과 sw.js의 match가 그대로 맞는다.
          const res = await fetch(url);
          await sleep(60); // 서버당 부담 완화 (캐시 히트면 지연 없음)
          if (!res.ok) throw new Error(`tile ${res.status}`);
          await cache.put(url, res);
        }
        saved++;
      } catch {
        // 개별 타일 실패는 무시 — 네트워크 일부 유실은 다음 기회에 채워짐
      }
      done++;
      if (onProgress && done % 12 === 0) onProgress(done, total);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  onProgress?.(total, total);
  return { saved, total, capped };
}

/** 저장된 타일 개수(대략적 사용량 표시용) */
export async function cachedTileCount(): Promise<number> {
  if (!("caches" in window)) return 0;
  try {
    const cache = await caches.open(TILE_CACHE);
    return (await cache.keys()).length;
  } catch {
    return 0;
  }
}
