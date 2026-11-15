import { NextRequest, NextResponse } from "next/server";

import { isLatLngPath } from "@/lib/api-validation";
import { routeMetricsLocal } from "@/lib/route-metrics-local";

/** 최대 배치 크기 — 후보 3~8개가 정상, 남용/오작동 방어 */
const MAX_BATCH = 16;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }

  // 배치: {paths: LatLng[][]} – {metrics: (RouteMetrics|null)[]}
  // 단건 호환: {path: LatLng[]} – {metrics: RouteMetrics}
  // 로컬 계산(Overpass 0콜)이라 한 요청에서 여러 경로를 동기로 처리한다.
  const rawPaths = (body as { paths?: unknown })?.paths;
  if (rawPaths !== undefined) {
    if (!Array.isArray(rawPaths)) {
      return NextResponse.json({ error: "paths는 경로 배열이어야 합니다" }, { status: 400 });
    }
    if (rawPaths.length > MAX_BATCH) {
      return NextResponse.json(
        { error: `한 번에 최대 ${MAX_BATCH}개 경로까지` },
        { status: 400 },
      );
    }
    // 경로별로 독립 계산 — 하나가 잘못돼도 나머지는 정상 반환(null 자리표시)
    let totalPoints = 0;
    const metrics = rawPaths.map((p) => {
      if (!isLatLngPath(p) || totalPoints + p.length > 80_000) return null;
      totalPoints += p.length;
      return routeMetricsLocal(p);
    });
    return NextResponse.json({ metrics });
  }

  const path = (body as { path?: unknown })?.path;
  if (!isLatLngPath(path)) {
    return NextResponse.json(
      { error: "path는 {lat, lng} 배열이어야 합니다 (최소 2개)" },
      { status: 400 },
    );
  }

  try {
    const metrics = routeMetricsLocal(path);
    return NextResponse.json({ metrics });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "도로 지표 조회 실패" },
      { status: 502 },
    );
  }
}
