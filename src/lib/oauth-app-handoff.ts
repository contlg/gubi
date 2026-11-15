import "server-only";

import { randomBytes } from "node:crypto";

import { NextResponse } from "next/server";

/**
 * 앱(안드로이드 WebView) 소셜 로그인 다리.
 *
 * 구글은 앱 안 브라우저(WebView) 로그인을 막고, 앱은 우리 사이트가 아닌 주소를
 * 외부 브라우저로 넘긴다. 그래서 앱에선 로그인을 **외부 브라우저**에서 하고,
 * 그 결과를 일회용 표(ticket)로 앱에 돌려준다.
 *  - login: 콜백(브라우저)이 만든다 – 앱 WebView가 app-exchange로 바꿔 세션 쿠키를 받는다.
 *  - link: 앱 WebView(로그인 상태)가 만든다 – 브라우저의 콜백이 "어느 계정에 붙일지" 안다.
 * 표는 추측 불가(32바이트), 5분, 한 번 쓰면 끝. 서버 프로세스 메모리에만 둔다
 * (재시작되면 진행 중이던 로그인만 다시 하면 된다).
 */
export interface AppLoginTicket {
  kind: "login";
  idHash: string;
  recordHash: string;
  name: string;
}
export interface AppLinkTicket {
  kind: "link";
  idHash: string;
  recordHash: string;
}
type Ticket = AppLoginTicket | AppLinkTicket;

const TTL_MS = 5 * 60_000;
const MAX = 2_000;
const TICKET_RE = /^[A-Za-z0-9_-]{43}$/;
const tickets = new Map<string, { t: Ticket; exp: number }>();

function sweep(now: number) {
  for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k);
  // 폭주 방어 — 가장 오래된 것부터 버린다(Map은 삽입 순서)
  while (tickets.size > MAX) tickets.delete(tickets.keys().next().value as string);
}

export function createAppTicket(t: Ticket): string {
  const now = Date.now();
  sweep(now);
  const id = randomBytes(32).toString("base64url");
  tickets.set(id, { t, exp: now + TTL_MS });
  return id;
}

/** 표를 꺼내면서 지운다(일회용). 종류가 다르거나 만료면 null. */
export function consumeAppTicket<K extends Ticket["kind"]>(
  id: unknown,
  kind: K,
): Extract<Ticket, { kind: K }> | null {
  if (typeof id !== "string" || !TICKET_RE.test(id)) return null;
  const hit = tickets.get(id);
  tickets.delete(id);
  if (!hit || hit.exp <= Date.now() || hit.t.kind !== kind) return null;
  return hit.t as Extract<Ticket, { kind: K }>;
}

/** 앱으로 돌아가는 링크 — 크롬이 package를 보고 우리 앱만 연다. */
export function appReturnUrl(params: Record<string, string>): string {
  const q = new URLSearchParams(params).toString();
  return `intent://auth?${q}#Intent;scheme=drivelog;package=dev.homesev.drivelog;end`;
}

/**
 * 외부 브라우저에 띄우는 "앱으로 돌아가는 중" 페이지. 자동 이동을 시도하고,
 * 브라우저가 막으면 누를 버튼을 보여준다.
 */
export function appReturnPage(params: Record<string, string>, message: string): NextResponse {
  const url = appReturnUrl(params);
  const esc = (s: string) =>
    s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  const html = `<!doctype html><html lang="ko"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gubi</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#09090b;color:#fafafa;font-family:-apple-system,sans-serif}
main{text-align:center;padding:24px}p{color:#a1a1aa;font-size:14px}
a{display:inline-block;margin-top:16px;padding:14px 24px;border-radius:16px;background:#3182f6;color:#fff;text-decoration:none;font-weight:700}</style>
</head><body><main><h2>${esc(message)}</h2><p>Gubi 앱으로 돌아갑니다</p>
<a href="${esc(url)}">앱으로 돌아가기</a></main>
<script>location.replace(${JSON.stringify(url).replace(/</g, "\\u003c")});</script></body></html>`;
  return new NextResponse(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
    },
  });
}
