import { NextRequest, NextResponse } from "next/server";

import { decodeValidPolyline, isLatLngPath } from "@/lib/api-validation";
import { type FuelKind, gasAlongRoute } from "@/lib/opinet";
import type { LatLng } from "@/lib/types";

/** 가는 길(경로)에 있는 주유소·유가. POST {path(encoded|배열), fuel?, sort?} */
export async function POST(req: NextRequest) {
  let body: { path?: unknown; fuel?: unknown; sort?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }

  let path: LatLng[] = [];
  if (typeof body.path === "string") {
    if (body.path.length > 200_000)
      return NextResponse.json({ error: "path가 너무 깁니다" }, { status: 400 });
    path = decodeValidPolyline(body.path) ?? [];
  } else if (Array.isArray(body.path)) {
    path = body.path as LatLng[];
  }
  if (!isLatLngPath(path)) {
    return NextResponse.json({ error: "path가 필요합니다" }, { status: 400 });
  }

  const fuel = (["gasoline", "premium", "diesel", "lpg"] as FuelKind[]).includes(
    body.fuel as FuelKind,
  )
    ? (body.fuel as FuelKind)
    : "gasoline";
  const sort = body.sort === "distance" ? "distance" : "price";

  try {
    const stations = await gasAlongRoute(path, { fuel, sort });
    return NextResponse.json({ stations });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "주유소 조회 실패" },
      { status: 502 },
    );
  }
}
