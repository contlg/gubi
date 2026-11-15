import { NextRequest, NextResponse } from "next/server";

import { createAuthSession, readAuthSession } from "@/lib/auth-session";
import { appReturnPage, consumeAppTicket, createAppTicket } from "@/lib/oauth-app-handoff";
import { lookupLink, setLink } from "@/lib/oauth-links";
import {
  OAUTH_STATE_COOKIE,
  PROVIDERS,
  accountHashes,
  isProvider,
  publicOrigin,
  redirectUri,
  safeNext,
} from "@/lib/oauth";

/**
 * 소셜 로그인 콜백 — state 대조 후 code를 토큰으로 교환하고, provider 프로필로
 * 안정 계정 해시를 만들어 기존 세션([[auth-session]])을 발급한다. 비밀번호
 * 레지스트리(auth-users.json)는 건드리지 않는다(provider가 매 로그인 검증).
 */
export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ provider: string }> },
) {
  const { provider } = await ctx.params;
  const origin = publicOrigin(req);

  // state 쿠키(복귀 경로 포함)를 먼저 읽어, 실패해도 올바른 화면으로 되돌린다.
  let saved: { state?: string; next?: string; link?: boolean; app?: boolean; lt?: string } | null = null;
  try {
    const raw = req.cookies.get(OAUTH_STATE_COOKIE)?.value;
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  const next = safeNext(saved?.next);

  const clearState = <T extends NextResponse>(res: T): T => {
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };
  const fail = (msg: string) => {
    // 앱에서 연 로그인이면 오류도 앱으로 돌려보낸다(브라우저에 웹 화면만 남지 않게)
    if (saved?.app) return clearState(appReturnPage({ error: msg }, "로그인하지 못했어요"));
    const url = new URL(next, origin);
    url.searchParams.set("authError", msg);
    const res = NextResponse.redirect(url);
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  };

  if (!isProvider(provider)) return fail("지원하지 않는 로그인이에요");
  const cfg = PROVIDERS[provider];

  const params = req.nextUrl.searchParams;
  if (params.get("error")) return fail("로그인이 취소됐어요");
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state || !saved?.state || state !== saved.state) {
    return fail("로그인 검증에 실패했어요. 다시 시도해주세요");
  }

  const clientId = cfg.clientId();
  if (!clientId) return fail(`${cfg.label} 로그인이 아직 설정되지 않았어요`);
  const clientSecret = cfg.clientSecret();

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    redirect_uri: redirectUri(req, provider),
    code,
  });
  if (clientSecret) tokenBody.set("client_secret", clientSecret);
  let accessToken: string | null = null;
  try {
    const tr = await fetch(cfg.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: tokenBody,
    });
    if (!tr.ok) return fail("로그인 토큰 교환에 실패했어요");
    const token = (await tr.json()) as { access_token?: unknown };
    accessToken = typeof token.access_token === "string" ? token.access_token : null;
  } catch {
    return fail("로그인 서버 연결에 실패했어요");
  }
  if (!accessToken) return fail("로그인 토큰을 받지 못했어요");

  // 2) access token – 프로필
  let profile: { sub: string; name: string } | null = null;
  try {
    const ur = await fetch(cfg.userinfoUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!ur.ok) return fail("프로필 조회에 실패했어요");
    profile = cfg.parseUser(await ur.json());
  } catch {
    return fail("프로필 조회에 실패했어요");
  }
  if (!profile) return fail("프로필을 확인하지 못했어요");

  // 3a) 연동 모드 — 새 세션을 만들지 않고, 로그인된 계정에 이 소셜 신원을 붙인다.
  // 이후 같은 소셜 로그인은 이 계정(기록 버킷 포함)으로 들어온다.
  if (saved?.link) {
    // 앱 연동은 외부 브라우저라 앱 세션 쿠키가 없다 — 앱이 넘긴 연동 표로 계정을 안다.
    const session = saved.app ? consumeAppTicket(saved.lt, "link") : readAuthSession(req);
    if (!session) return fail("연동하려면 먼저 로그인해주세요");
    setLink(provider, profile.sub, session.idHash, session.recordHash);
    if (saved.app) {
      return clearState(appReturnPage({ linked: cfg.label }, `${cfg.label} 연동 완료`));
    }
    const dest = new URL(next, origin);
    dest.searchParams.set("linked", cfg.label);
    const res = NextResponse.redirect(dest);
    res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
    return res;
  }

  // 3b) 로그인 모드 — 연동된 기존 계정이 있으면 그 계정으로, 없으면 소셜 전용
  // 계정으로. welcome로 표시 이름을 클라이언트에 전달한다.
  const linked = lookupLink(provider, profile.sub);
  const { idHash, recordHash } = linked ?? accountHashes(provider, profile.sub);
  if (saved?.app) {
    // 세션은 앱 WebView가 app-exchange에서 받는다 — 브라우저엔 만들지 않는다.
    const code = createAppTicket({ kind: "login", idHash, recordHash, name: profile.name });
    return clearState(appReturnPage({ code }, "로그인 완료"));
  }
  const dest = new URL(next, origin);
  dest.searchParams.set("welcome", profile.name);
  const res = NextResponse.redirect(dest);
  res.cookies.set(OAUTH_STATE_COOKIE, "", { path: "/", maxAge: 0 });
  createAuthSession(req, res, idHash, recordHash);
  return res;
}
