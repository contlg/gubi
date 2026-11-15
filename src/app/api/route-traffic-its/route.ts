import { NextRequest, NextResponse } from "next/server";

import { trafficAlongPath } from "@/lib/its-speed";
import {
  applyTimeCalib,
  pathJuncPerKm,
} from "@/lib/localroute";
import { pathEtaSec } from "@/lib/path-eta";
import type { LatLng } from "@/lib/types";

/**
 * 카카오 없이 ITS 캐시로 경로 실시간 색칠 + 소요시간. 카카오 route-traffic 대체.
 * - 색칠: 경로를 ~300m로 훑어 각 점의 ITS 소통상태(1정체~4원활, 0정보없음).
 * - 시간: ITS 실시간속도 + 도로급 폴백으로 적분하되, 뒤쪽 구간은 도착할 때쯤의 보통 교통을 반영(pathEtaSec).
 * 유저 수와 무관하게 5분 캐시(ITS)만 쓴다. 응답 형태는 route-traffic과 동일.
 */
function isValidPath(v: unknown): v is LatLng[] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    v.length <= 20_000 &&
    v.every(
      (p) =>
        typeof p?.lat === "number" &&
        typeof p?.lng === "number" &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        p.lat >= -90 &&
        p.lat <= 90 &&
        p.lng >= -180 &&
        p.lng <= 180,
    )
  );
}

export async function POST(req: NextRequest) {
  let body: { path?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  if (!isValidPath(body.path)) {
    return NextResponse.json({ error: "path({lat,lng} 배열)가 필요합니다" }, { status: 400 });
  }
  const path = body.path;

  const traffic = trafficAlongPath(path);

  // 소요시간 — ITS 속도(50m마다, 도착 시각의 보통 교통 반영) + ITS 없는 곳은 도로급·교차로 보정.
  const sec = pathEtaSec(path, applyTimeCalib(1, pathJuncPerKm(path)));

  return NextResponse.json({
    samples: traffic.samples,
    durationSec: sec != null ? Math.round(sec) : null,
    distanceM: Math.round(traffic.distanceM),
    jamRatio: traffic.jamRatio,
    coverage: traffic.coverage,
    source: "its",
  });
}
