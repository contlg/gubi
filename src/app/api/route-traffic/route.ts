import { NextRequest, NextResponse } from "next/server";

import { jsonBodyError, readJsonBody } from "@/lib/request-json";
import {
  isRoutingBusyError,
  runRouteTrafficRouting,
} from "@/lib/routing-worker-client";
import type { LatLng } from "@/lib/types";

function isCoord(v: unknown): v is LatLng {
  const p = v as LatLng;
  return (
    typeof p?.lat === "number" &&
    typeof p?.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

/**
 * 구버전 클라이언트 호환용 교통 API. origin/waypoints/destination을 로컬
 * 노드링크로 잇고 5분 주기 ITS 캐시로 색칠한다. 새 코드는 경로 자체를 보내는
 * /api/route-traffic-its를 사용한다.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const detail = jsonBodyError(error);
    return NextResponse.json({ error: detail.message }, { status: detail.status });
  }
  const { origin, destination, waypoints } = (body ?? {}) as {
    origin?: unknown;
    destination?: unknown;
    waypoints?: unknown;
  };
  if (!isCoord(origin) || !isCoord(destination)) {
    return NextResponse.json(
      { error: "origin/destination 좌표가 필요합니다" },
      { status: 400 },
    );
  }
  const stops = [
    origin,
    ...(Array.isArray(waypoints) ? waypoints : []).filter(isCoord).slice(0, 5),
    destination,
  ];
  try {
    const result = await runRouteTrafficRouting({ stops }, req.signal);
    if (!result) {
      return NextResponse.json({ error: "로컬 경로 없음" }, { status: 502 });
    }
    return NextResponse.json(result);
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
      { error: error instanceof Error ? error.message : "교통 경로 계산 실패" },
      { status: 502 },
    );
  }
}
