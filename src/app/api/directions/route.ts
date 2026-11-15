import { NextRequest, NextResponse } from "next/server";

import {
  parseAvoid,
  parseCoastIntensity,
  parseCoord,
  parseDriveStyles,
} from "@/lib/params";
import {
  isRoutingBusyError,
  runDirectionsRouting,
} from "@/lib/routing-worker-client";

export async function GET(req: NextRequest) {
  const origin = parseCoord(req.nextUrl.searchParams.get("origin"));
  const destination = parseCoord(req.nextUrl.searchParams.get("destination"));
  if (!origin || !destination) {
    return NextResponse.json(
      { error: "origin, destination 파라미터가 필요합니다 (형식: 경도,위도)" },
      { status: 400 },
    );
  }

  const globalAvoid = parseAvoid(req.nextUrl.searchParams.get("avoid"));

  // 경유지가 지정되면 모든 우선순위 호출에 함께 전달한다
  const waypointsParam = req.nextUrl.searchParams.get("waypoints");
  let waypoints: { lat: number; lng: number }[] | undefined;
  if (waypointsParam) {
    const parsed = waypointsParam.split("|").map(parseCoord);
    if (parsed.some((w) => w === null) || parsed.length > 5) {
      return NextResponse.json(
        { error: "waypoints는 '경도,위도|경도,위도' 형식, 최대 5개입니다" },
        { status: 400 },
      );
    }
    waypoints = parsed as { lat: number; lng: number }[];
  }

  try {
    const maxCost = Number(req.nextUrl.searchParams.get("maxCost") ?? 0);
    const styles = parseDriveStyles(req.nextUrl.searchParams.get("styles"));
    const { candidates, notes } = await runDirectionsRouting(
      {
        origin,
        destination,
        waypoints,
        avoid: globalAvoid,
        styles,
        coastIntensity: parseCoastIntensity(req.nextUrl.searchParams.get("coast")),
        maxCost,
      },
      req.signal,
    );
    return NextResponse.json({ candidates, notes });
  } catch (e) {
    if (isRoutingBusyError(e)) {
      return NextResponse.json(
        { error: e.message },
        { status: 429, headers: { "Retry-After": "3" } },
      );
    }
    if (e instanceof DOMException && e.name === "AbortError") {
      return new NextResponse(null, { status: 499 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "길찾기 실패" },
      { status: 502 },
    );
  }
}
