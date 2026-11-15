import { NextRequest, NextResponse } from "next/server";

import { decodeValidPolyline, isLatLng } from "@/lib/api-validation";
import { encodePolyline } from "@/lib/polyline";
import { jsonBodyError, readJsonBody } from "@/lib/request-json";
import {
  isRoutingBusyError,
  runNavGuidanceRouting,
  runNavRerouteRouting,
} from "@/lib/routing-worker-client";
import type { LatLng } from "@/lib/types";

/**
 * 자체 내비 안내 — 코스 경로(encoded polyline)를 주면 회전 안내·경로변
 * 단속카메라·속도 프로파일을 돌려준다. from/idx가 있으면 이탈 재탐색:
 * 현위치–코스 전방 복귀점을 로컬 A*로 잇고 새 경로+안내를 준다.
 */
export async function POST(req: NextRequest) {
  let body: { path?: unknown; from?: unknown; idx?: unknown; heading?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const detail = jsonBodyError(error);
    return NextResponse.json({ error: detail.message }, { status: detail.status });
  }
  if (typeof body.path !== "string" || body.path.length === 0 || body.path.length > 200_000) {
    return NextResponse.json({ error: "path(encoded polyline)가 필요합니다" }, { status: 400 });
  }
  const path: LatLng[] | null = decodeValidPolyline(body.path);
  if (!path || path.length < 2)
    return NextResponse.json({ error: "path 해석 실패" }, { status: 400 });

  const from = body.from;
  if (isLatLng(from)) {
    const idx =
      typeof body.idx === "number" && Number.isFinite(body.idx)
        ? Math.max(0, Math.min(path.length - 1, Math.round(body.idx)))
        : 0;
    // 출발 헤딩(진행 방위) — 복귀 경로가 뒤로 돌아가지 않게 역방향 시작을 페널티.
    const heading =
      typeof body.heading === "number" && Number.isFinite(body.heading)
        ? body.heading
        : undefined;
    try {
      const result = await runNavRerouteRouting(
        { from, path, fromIdx: idx, heading },
        req.signal,
      );
      if (!result) {
        return NextResponse.json(
          { error: "복귀 경로를 찾지 못했어요" },
          { status: 502 },
        );
      }
      return NextResponse.json({
        path: encodePolyline(
          result.path.map((point): [number, number] => [point.lat, point.lng]),
        ),
        ...result.guidance,
      });
    } catch (error) {
      if (isRoutingBusyError(error)) {
        return NextResponse.json(
          { error: error.message },
          { status: 429, headers: { "Retry-After": "2" } },
        );
      }
      if (error instanceof DOMException && error.name === "AbortError") {
        return new NextResponse(null, { status: 499 });
      }
      return NextResponse.json(
        { error: error instanceof Error ? error.message : "복귀 경로 계산 실패" },
        { status: 502 },
      );
    }
  }

  try {
    const guidance = await runNavGuidanceRouting({ path }, req.signal);
    return NextResponse.json({ path: body.path, ...guidance });
  } catch (error) {
    if (isRoutingBusyError(error)) {
      return NextResponse.json(
        { error: error.message },
        { status: 429, headers: { "Retry-After": "2" } },
      );
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      return new NextResponse(null, { status: 499 });
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "안내 생성 실패" },
      { status: 502 },
    );
  }
}
