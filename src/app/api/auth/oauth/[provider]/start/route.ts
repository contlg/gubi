import { randomBytes } from "node:crypto";

import { NextRequest, NextResponse } from "next/server";

import {
  OAUTH_STATE_COOKIE,
  PROVIDERS,
  isProvider,
  publicOrigin,
  redirectUri,
  safeNext,
} from "@/lib/oauth";

/**
 * 소셜 로그인 시작 — provider authorize 페이지로 top-level 리다이렉트. CSRF
 * 방지용 state와 복귀 경로(next)를 httpOnly 쿠키에 담아 콜백에서 대조한다.
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
) {
  const { provider } = await ctx.params;
  const origin = publicOrigin(req);

  const backToLogin = (msg: string) => {
    const url = new URL("/log", origin);
    url.searchParams.set("authError", msg);
    return NextResponse.redirect(url);
  };

  if (!isProvider(provider)) return backToLogin("지원하지 않는 로그인이에요");
  const cfg = PROVIDERS[provider];
  const clientId = cfg.clientId();
  if (!clientId) return backToLogin(`${cfg.label} 로그인이 아직 설정되지 않았어요`);

  const state = randomBytes(16).toString("hex");
  const next = safeNext(req.nextUrl.searchParams.get("next"));
  // mode=link: 새 로그인이 아니라 "로그인한 계정에 이 소셜을 연결". 콜백에서
  // 현재 세션 계정에 provider 신원을 붙인다(신규 세션은 발급하지 않는다).
  const link = req.nextUrl.searchParams.get("mode") === "link";
  // app=1: Gubi 앱이 외부 브라우저로 연 로그인. 콜백이 세션 대신 일회용
  // 표를 만들어 앱으로 돌려보낸다(oauth-app-handoff). 앱의 연동(link)은 브라우저에
  // 앱 세션이 없으니, 앱이 미리 받은 연동 표(lt)로 계정을 알려준다.
  const app = req.nextUrl.searchParams.get("app") === "1";
  const lt = app && link ? (req.nextUrl.searchParams.get("lt") ?? "").slice(0, 64) : "";

  const authUrl = new URL(cfg.authorizeUrl);
  authUrl.searchParams.set("client_id", clientId);
  authUrl.searchParams.set("redirect_uri", redirectUri(req, provider));
  authUrl.searchParams.set("response_type", "code");
  if (cfg.scope) authUrl.searchParams.set("scope", cfg.scope);
  authUrl.searchParams.set("state", state);

  const res = NextResponse.redirect(authUrl);
  res.cookies.set(OAUTH_STATE_COOKIE, JSON.stringify({ state, next, link, ...(app ? { app: true } : {}), ...(lt ? { lt } : {}) }), {
    httpOnly: true,
    sameSite: "lax",
    secure: origin.startsWith("https"),
    path: "/",
    maxAge: 600,
  });
  return res;
}
