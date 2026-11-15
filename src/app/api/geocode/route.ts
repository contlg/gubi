import { NextRequest, NextResponse } from "next/server";

import { searchPlaces } from "@/lib/kakao";

export async function GET(req: NextRequest) {
  const query = req.nextUrl.searchParams.get("q")?.trim();
  if (!query || query.length > 100) {
    return NextResponse.json({ error: "q 파라미터가 필요합니다" }, { status: 400 });
  }
  // 현재 위치(x=경도, y=위도) — 있으면 그 주변 가까운 순으로 검색·거리 표시
  const x = Number(req.nextUrl.searchParams.get("x"));
  const y = Number(req.nextUrl.searchParams.get("y"));
  const origin =
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= -180 &&
    x <= 180 &&
    y >= -90 &&
    y <= 90 &&
    (x !== 0 || y !== 0)
      ? { lat: y, lng: x }
      : undefined;
  try {
    const places = await searchPlaces(query, origin);
    return NextResponse.json({ places });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "검색 실패" },
      { status: 502 },
    );
  }
}
