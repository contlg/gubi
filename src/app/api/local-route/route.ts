import { NextRequest, NextResponse } from "next/server";

import { isLatLng } from "@/lib/api-validation";
import { jsonBodyError, readJsonBody } from "@/lib/request-json";
import {
  isRoutingBusyError,
  runLocalRouteRouting,
} from "@/lib/routing-worker-client";
import type { AvoidOption } from "@/lib/types";

/**
 * 다중 경유지 로컬 라우팅 — 카카오 길찾기는 경유지 5개 하드 제한이라
 * ("waypoints must be between 0 and 5" 실측), 6개 이상은 보정된 로컬 A*로
 * 잇는다 (±10%, estimated 표시). 상한 20개.
 */
export async function POST(req: NextRequest) {
  let body: {
    origin?: unknown;
    destination?: unknown;
    waypoints?: unknown;
    avoid?: unknown;
  };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const detail = jsonBodyError(error);
    return NextResponse.json({ error: detail.message }, { status: detail.status });
  }
  const { origin, destination, waypoints, avoid } = body;
  if (!isLatLng(origin) || !isLatLng(destination)) {
    return NextResponse.json(
      { error: "origin/destination 좌표가 필요합니다" },
      { status: 400 },
    );
  }
  const wps = (Array.isArray(waypoints) ? waypoints : []).filter(isLatLng);
  if (wps.length > 20) {
    return NextResponse.json({ error: "경유지는 최대 20개" }, { status: 400 });
  }
  const av = (Array.isArray(avoid) ? avoid : []).filter(
    (a): a is AvoidOption => a === "toll" || a === "motorway",
  );

  try {
    const { candidate } = await runLocalRouteRouting(
      { origin, destination, waypoints: wps, avoid: av },
      req.signal,
    );
    if (!candidate) {
      return NextResponse.json(
        { error: "경유지 사이 경로를 찾지 못했어요" },
        { status: 502 },
      );
    }
    return NextResponse.json({ candidate });
  } catch (error) {
    if (isRoutingBusyError(error)) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { "Retry-After": "3" } },
      );
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return new NextResponse(null, { status: 499 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "로컬 경로 탐색 실패" },
      { status: 502 },
    );
  }
}
