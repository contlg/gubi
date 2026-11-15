// fundrive 서비스워커 — 지도 타일 오프라인 캐시.
//
// 목적: 산악 와인딩·해안 명품길처럼 셀 신호가 끊기는 곳에서도 지도가 회색으로
// 죽지 않게 한다. 지도 타일(OSM·Esri)을 캐시-우선으로 서빙하고, 평소 주행 중
// 받은 타일을 자동 저장한다. "코스 미리 저장"은 caches.open으로 직접 채운다.
//
// 앱 셸(HTML/JS)은 캐시하지 않는다 — Next 배포마다 바뀌고, 오프라인 첫 로딩보다
// "이미 켜둔 앱이 신호 끊겨도 지도가 유지"되는 게 이 앱의 실제 시나리오다.

const TILE_CACHE = "drive-tiles-v1";
const TILE_HOSTS = ["tile.openstreetmap.org", "server.arcgisonline.com"];
const MAX_TILES = 6000; // 대략 타일당 ~20KB → ~120MB 상한

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

let sinceTrim = 0;
async function trimIfNeeded() {
  if (++sinceTrim < 200) return; // 매번 세지 않고 가끔만
  sinceTrim = 0;
  const cache = await caches.open(TILE_CACHE);
  const keys = await cache.keys(); // 삽입 순서(오래된 것부터)
  if (keys.length <= MAX_TILES) return;
  const over = keys.length - MAX_TILES;
  for (let i = 0; i < over; i++) await cache.delete(keys[i]);
}

function isTile(url) {
  try {
    return TILE_HOSTS.includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || !isTile(req.url)) return; // 타일만 개입
  event.respondWith(
    (async () => {
      const cache = await caches.open(TILE_CACHE);
      const cached = await cache.match(req);
      if (cached) return cached; // 캐시-우선 — 오프라인에서도 즉시
      try {
        const res = await fetch(req); // 이미지 요청이라 대개 no-cors(opaque)
        // opaque(status 0)도 캐시 가능 — 이미지는 정상 렌더된다
        if (res && (res.ok || res.type === "opaque")) {
          cache.put(req, res.clone());
          trimIfNeeded();
        }
        return res;
      } catch {
        // 네트워크 실패 & 캐시 없음 — 브라우저가 onerror 처리(부모타일 폴백)
        return Response.error();
      }
    })(),
  );
});
