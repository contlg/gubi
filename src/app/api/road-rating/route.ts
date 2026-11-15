import { NextRequest, NextResponse } from "next/server";

import { readAuthSession } from "@/lib/auth-session";
import { addRating } from "@/lib/roadinfo";

/** 도로 별점 등록/수정 — 파일 저장(단일 홈서버). prev를 주면 재평가로 처리 */
export async function POST(req: NextRequest) {
  if (!readAuthSession(req)) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
  let body: { key?: unknown; stars?: unknown; prev?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const { key, stars, prev } = body;
  if (typeof key !== "string" || key.length < 3 || key.length > 200) {
    return NextResponse.json({ error: "key가 필요합니다" }, { status: 400 });
  }
  if (!Number.isFinite(stars) || typeof stars !== "number" || stars < 1 || stars > 5) {
    return NextResponse.json({ error: "stars는 1~5" }, { status: 400 });
  }
  const rating = addRating(
    key,
    Math.round(stars),
    typeof prev === "number" && Number.isFinite(prev) && prev >= 1 && prev <= 5
      ? Math.round(prev)
      : undefined,
  );
  return NextResponse.json({ rating });
}
