import { NextRequest, NextResponse } from "next/server";

import { readAuthSession } from "@/lib/auth-session";
import { createAppTicket } from "@/lib/oauth-app-handoff";

/**
 * 앱에서 소셜 "연동"을 시작할 때 — 로그인된 앱 WebView가 일회용 연동 표를 받아
 * 외부 브라우저 로그인 주소(start?mode=link&app=1&lt=…)에 실어 보낸다.
 */
export async function POST(req: NextRequest) {
  const session = readAuthSession(req);
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const ticket = createAppTicket({
    kind: "link",
    idHash: session.idHash,
    recordHash: session.recordHash,
  });
  return NextResponse.json({ ticket }, { headers: { "Cache-Control": "no-store" } });
}
