/**
 * 라우팅 워커 프리웜 — 서버 부팅 시 1회.
 *
 * 도로 그래프는 워커 스레드 안에서 첫 라우팅 잡이 올 때 lazy 로드되는데,
 * `.bin` 7개 + JSON 3개를 동기로 읽어 typed-array로 만드는 데 ~1.3s가 든다.
 * 그래서 서버가 뜨자마자 두 워커(planner·navigation)에 더미 잡을 하나씩
 * 던져 그래프를 미리 메모리에 올린다. 이후 첫 사용자 요청은 ~3ms(웜)로 떨어진다.
 *
 * register()는 "요청 처리 전 완료"돼야 하므로 여기서 await하지 않는다 — 워커
 * 로드는 백그라운드로 흐르고, 서버 준비는 즉시 끝난다. 프리웜이 실패해도
 * 무시한다(다음 실제 요청이 정상 경로로 그래프를 로드하므로 치명적이지 않다).
 */
export function register(): void {
  // Edge 런타임에는 워커/파일시스템이 없다 — Node 인스턴스에서만.
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Keep Node-only imports directly inside the runtime guard so the Edge
    // instrumentation bundle never tries to resolve fs/worker_threads.
    void import("@/lib/routing-worker-client").then(({ runLocalRouteRouting, runNavGuidanceRouting }) => {
    // 실제 그래프 영역(서울 인근) 두 점 — 결과는 버린다. 목적은 loadGraph 유발.
    const a = { lat: 37.5665, lng: 126.978 };
    const b = { lat: 37.5172, lng: 127.0473 };
    // planner 워커(코스 추천·로컬 라우트)
    void runLocalRouteRouting({
      origin: a,
      destination: b,
      waypoints: [],
      avoid: [],
    }).catch(() => {});
    // navigation 워커(내비 안내·재탐색)
    void runNavGuidanceRouting({ path: [a, b] }).catch(() => {});
    }).catch(() => {});
  }
}
