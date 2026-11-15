import { NextRequest, NextResponse } from "next/server";

import { roadAtPoint } from "@/lib/roadinfo";

/** 지도 클릭 좌표 – 그 자리의 이름 있는 도로 전체 기하+특성+(로컬 데이터만) */
export async function GET(req: NextRequest) {
  const coord = req.nextUrl.searchParams.get("coord"); // "lng,lat" (카카오 관례)
  const [lng, lat] = (coord ?? "").split(",").map(Number);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return NextResponse.json({ error: "coord=lng,lat 형식이 필요합니다" }, { status: 400 });
  }
  const road = roadAtPoint({ lat, lng });
  if (!road) {
    return NextResponse.json({ road: null });
  }
  return NextResponse.json({ road });
}
