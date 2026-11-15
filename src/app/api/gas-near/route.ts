import { NextRequest, NextResponse } from "next/server";

import { type FuelKind, gasNear } from "@/lib/opinet";

/** 현재 위치 주변 주유소·유가 (오피넷). POST {lat,lng,fuel?,sort?} */
export async function POST(req: NextRequest) {
  let body: { lat?: unknown; lng?: unknown; fuel?: unknown; sort?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return NextResponse.json({ error: "lat/lng이 필요합니다" }, { status: 400 });
  }
  const fuel = (["gasoline", "premium", "diesel", "lpg"] as FuelKind[]).includes(
    body.fuel as FuelKind,
  )
    ? (body.fuel as FuelKind)
    : "gasoline";
  const sort = body.sort === "distance" ? "distance" : "price";

  try {
    const stations = await gasNear({ lat, lng }, { fuel, sort });
    return NextResponse.json({ stations });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "주유소 조회 실패" },
      { status: 502 },
    );
  }
}
