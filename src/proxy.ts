import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * API 남용·DoS 방지 rate limit (Next v16 proxy = 구 middleware).
 *
 * 이 서버는 인터넷에 노출돼 있고(/api/*), 무인증 엔드포인트 다수가 카카오·
 * 오피넷 등 쿼터/과금 외부 API를 호출하거나 도로그래프 스캔 같은 CPU 작업을
 * 한다. 스크립트로 폭주시키면 쿼터 소진·맥미니 과부하로 이어질 수 있어,
 * IP별 고정창 카운터로 막는다. 자체 호스팅(next start, Node 런타임)이라
 * 모듈 스코프 Map 상태가 프로세스 내에서 유지된다.
 *
 * 상한은 정상 사용(내비 폴링 ~20회/분)엔 절대 안 걸리게 넉넉히 두고,
 * 초당 수십~수백 건 폭주만 차단한다. 어떤 이유로든 실패하면 통과(fail-open)
 * 해서 rate limit 버그가 정상 API를 죽이지 않게 한다.
 */
const WINDOW_MS = 60_000;
const MAX = 300; // IP당 분당 요청
const hits = new Map<string, { n: number; reset: number }>();
const HEAVY_WINDOW_MS = 10 * 60_000;
const heavyHits = new Map<string, { n: number; reset: number }>();
// 폰 계산용 타일은 한 경로에 수십 개를 연달아 받으므로 일반 한도와 따로 센다(정적 파일이라 비용은 작다).
const tileHits = new Map<string, { n: number; reset: number }>();
const MAX_TILES = 1200;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
let lastSweep = 0;

function take(
  table: Map<string, { n: number; reset: number }>,
  key: string,
  max: number,
  windowMs: number,
  now: number,
): number {
  let entry = table.get(key);
  if (!entry || now > entry.reset) {
    entry = { n: 0, reset: now + windowMs };
    table.set(key, entry);
  }
  entry.n++;
  return entry.n > max
    ? Math.max(1, Math.ceil((entry.reset - now) / 1000))
    : 0;
}

function tooMany(retry: number) {
  return NextResponse.json(
    { error: "요청이 너무 많습니다. 잠시 후 다시 시도해주세요." },
    { status: 429, headers: { "Retry-After": String(retry) } },
  );
}

function clientIp(req: NextRequest): string {
  // Caddy가 X-Forwarded-For "끝"에 실제 접속 IP를 덧붙인다 — 클라가 앞쪽을
  // 위조해도 마지막 값은 프록시가 본 진짜 IP라 스푸핑에 강하다. 앞단에
  // Cloudflare가 없어 cf-connecting-ip는 클라가 임의로 넣을 수 있으므로
  // rate-limit 키로 신뢰하지 않는다(신뢰 시 헤더 회전으로 전 제한 우회).
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const parts = xff.split(",").map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.headers.get("x-real-ip") || "unknown";
}

/**
 * 카카오 REST는 호출 서버 IP로만 허용한다. 맥 개발 서버는 집 인터넷이라 IP가 바뀌면 막힌다(2026-11-13 401 확인).
 * KAKAO_API_ORIGIN(예: 오라클 고정 IP의 drivelog)이 설정되면, 카카오가 꼭 필요한 기능만 그쪽으로 넘긴다.
 * 로그인이 필요한 기능(route-confirm 등)은 계정 저장소가 달라 넘기지 않는다.
 */
const KAKAO_API_ORIGIN = process.env.KAKAO_API_ORIGIN?.replace(/\/$/, "");
const KAKAO_FORWARD: Record<string, string> = {
  "/api/geocode": "/api/geocode",
  "/api/revgeocode": "/api/revgeocode",
  "/api/course-spots": "/api/course-spots",
  "/api/nav-directions": "/api/nav-directions",
  // 카카오 교통 1순위. 오라클에 아직 배포 전이면 404가 나고, 화면(page.tsx)이 ITS로 되돌아간다
  "/api/route-traffic-kakao": "/api/route-traffic-kakao",
  "/api/route-traffic-its": "/api/route-traffic-its",
};

export function proxy(req: NextRequest) {
  const forward = KAKAO_API_ORIGIN ? KAKAO_FORWARD[req.nextUrl.pathname] : undefined;
  if (forward) {
    return NextResponse.rewrite(new URL(forward + req.nextUrl.search, KAKAO_API_ORIGIN));
  }
  try {
    const now = Date.now();
    const contentLength = Number(req.headers.get("content-length"));
    if (
      ["POST", "PUT", "PATCH"].includes(req.method) &&
      Number.isFinite(contentLength) &&
      contentLength > MAX_BODY_BYTES
    ) {
      return NextResponse.json(
        { error: "요청 데이터가 너무 큽니다" },
        { status: 413 },
      );
    }
    // 만료된 IP 항목 주기적 정리 — Map 무한 증가 방지
    if (now - lastSweep > WINDOW_MS) {
      lastSweep = now;
      for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
      for (const [k, v] of heavyHits) if (now > v.reset) heavyHits.delete(k);
      for (const [k, v] of tileHits) if (now > v.reset) tileHits.delete(k);
    }
    const ip = clientIp(req);
    const retry = req.nextUrl.pathname.startsWith("/api/traffic-tiles/")
      ? take(tileHits, ip, MAX_TILES, WINDOW_MS, now)
      : take(hits, ip, MAX, WINDOW_MS, now);
    if (retry) return tooMany(retry);

    // A*·스타일 탐색은 worker로 격리했어도 비싼 작업이다. 한 IP가 짧은 시간에
    // 큐를 독점하거나 외부 API 검증을 소진하지 못하게 별도 예산을 둔다.
    const path = req.nextUrl.pathname;
    const heavyLimit =
      path === "/api/loop" || path === "/api/local-route"
        ? 12
        : path === "/api/directions"
          ? 30
          : 0;
    if (heavyLimit) {
      const heavyRetry = take(
        heavyHits,
        `${path}:${ip}`,
        heavyLimit,
        HEAVY_WINDOW_MS,
        now,
      );
      if (heavyRetry) return tooMany(heavyRetry);
    }
  } catch {
    // fail-open — 어떤 예외든 요청은 통과시킨다
  }
  return NextResponse.next();
}

export const config = { matcher: "/api/:path*" };
