import { NextRequest, NextResponse } from "next/server";

import { createAuthSession } from "@/lib/auth-session";
import { consumeAppTicket } from "@/lib/oauth-app-handoff";
import { publicOrigin } from "@/lib/oauth";

/**
 * 앱 소셜 로그인 마무리 — 외부 브라우저 로그인이 앱으로 넘긴 일회용 표(code)를
 * 앱 WebView가 이 주소로 열면, 표를 지우고 WebView에 세션 쿠키를 심는다.
 */
export async function GET(req: NextRequest) {
  const origin = publicOrigin(req);
  const ticket = consumeAppTicket(req.nextUrl.searchParams.get("code"), "login");
  const dest = new URL("/log", origin);
  if (!ticket) {
    dest.searchParams.set("authError", "로그인 시간이 지났어요. 다시 시도해주세요");
    return NextResponse.redirect(dest);
  }
  dest.searchParams.set("welcome", ticket.name);
  const res = NextResponse.redirect(dest);
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("Referrer-Policy", "no-referrer");
  createAuthSession(req, res, ticket.idHash, ticket.recordHash);
  return res;
}
