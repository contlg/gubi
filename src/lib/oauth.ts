import "server-only";

import { createHash } from "node:crypto";

import type { NextRequest } from "next/server";

/**
 * 소셜 로그인(카카오·구글) 공용 설정·헬퍼. 서버에서만 실행되며 client secret은
 * 절대 클라이언트로 나가지 않는다. 기록 버킷 키는 provider+subject로 파생해
 * 비밀번호 계정([[auth-session]])과 겹치지 않는 안정 키를 만든다.
 */

export type OAuthProvider = "kakao" | "google";

interface ProviderConfig {
  label: string;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  /** 빈 문자열이면 scope 파라미터를 안 붙인다(카카오는 콘솔 동의항목으로 결정) */
  scope: string;
  clientId: () => string | undefined;
  clientSecret: () => string | undefined;
  /** userinfo 응답에서 안정적 식별자(sub)와 표시 이름을 뽑는다 */
  parseUser: (json: unknown) => { sub: string; name: string } | null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export const PROVIDERS: Record<OAuthProvider, ProviderConfig> = {
  kakao: {
    label: "카카오",
    authorizeUrl: "https://kauth.kakao.com/oauth/authorize",
    tokenUrl: "https://kauth.kakao.com/oauth/token",
    userinfoUrl: "https://kapi.kakao.com/v2/user/me",
    // 기본 프로필(닉네임)은 콘솔 동의항목에서 켠다. scope는 비워 콘솔 설정을 따른다.
    scope: "",
    // 로그인은 "리다이렉트 URI·시크릿을 등록한 앱"의 REST 키를 써야 한다.
    // 지도/모빌리티(KAKAO_REST_API_KEY)와 다른 앱이면 KAKAO_OAUTH_CLIENT_ID로
    // 지정한다(없으면 기존 키로 폴백).
    clientId: () =>
      process.env.KAKAO_OAUTH_CLIENT_ID || process.env.KAKAO_REST_API_KEY,
    clientSecret: () => process.env.KAKAO_CLIENT_SECRET,
    parseUser: (json) => {
      const j = json as {
        id?: number | string;
        properties?: { nickname?: unknown };
        kakao_account?: { profile?: { nickname?: unknown } };
      };
      if (j == null || (typeof j.id !== "number" && typeof j.id !== "string")) {
        return null;
      }
      const nick =
        str(j.kakao_account?.profile?.nickname) ?? str(j.properties?.nickname);
      return { sub: String(j.id), name: nick ?? "카카오 사용자" };
    },
  },
  google: {
    label: "구글",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid profile email",
    clientId: () => process.env.GOOGLE_OAUTH_CLIENT_ID,
    clientSecret: () => process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    parseUser: (json) => {
      const j = json as { sub?: unknown; name?: unknown; email?: unknown };
      const sub = str(j?.sub);
      if (!sub) return null;
      const name = str(j.name) ?? str(j.email);
      return { sub, name: name ?? "구글 사용자" };
    },
  },
};

export function isProvider(v: string): v is OAuthProvider {
  return v === "kakao" || v === "google";
}

/**
 * 브라우저가 실제로 접속한 origin — Caddy 뒤라 req.nextUrl은 localhost:1006일 수
 * 있어 X-Forwarded-* 를 우선한다. authorize/token의 redirect_uri가 이 값으로
 * 일관돼야 provider 검증을 통과한다.
 */
export function publicOrigin(req: NextRequest): string {
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    req.nextUrl.protocol.replace(":", "");
  const host =
    req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() ||
    req.headers.get("host") ||
    req.nextUrl.host;
  return `${proto}://${host}`;
}

export function redirectUri(req: NextRequest, provider: OAuthProvider): string {
  return `${publicOrigin(req)}/api/auth/oauth/${provider}/callback`;
}

/** provider+subject로 로그인 계정 해시와 기록 버킷 해시를 결정론적으로 파생한다. */
export function accountHashes(
  provider: OAuthProvider,
  sub: string,
): { idHash: string; recordHash: string } {
  const key = `${provider}:${sub}`;
  return {
    idHash: createHash("sha256").update(key).digest("hex"),
    recordHash: createHash("sha256").update(`rec:${key}`).digest("hex"),
  };
}

export const OAUTH_STATE_COOKIE = "drivelog-oauth-state";

/** 로그인 후 돌아갈 경로 — 오픈 리다이렉트 방지로 내부 절대경로만 허용. */
export function safeNext(next: string | null | undefined): string {
  return next && next.startsWith("/") && !next.startsWith("//") ? next : "/log";
}
