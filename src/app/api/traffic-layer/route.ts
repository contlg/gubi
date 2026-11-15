import { NextRequest, NextResponse } from "next/server";

import { trafficLayer } from "@/lib/its-speed";

/**
 * 지도 뷰포트(bbox) – ITS 실시간 소통이 잡히는 링크의 상태색 폴리라인.
 * 카카오 콜 없이(5분 캐시) 화면 전체 정체 레이어를 그린다. 줌 레벨(z)로
 * 표시 도로급을 좁혀(줌아웃=주요도로만) payload를 억제한다.
 *   /api/traffic-layer?bbox=minLng,minLat,maxLng,maxLat&z=12
 */
export async function GET(req: NextRequest) {
  const bbox = (req.nextUrl.searchParams.get("bbox") ?? "").split(",").map(Number);
  const z = Number(req.nextUrl.searchParams.get("z") ?? 12);
  if (bbox.length !== 4 || bbox.some((v) => !Number.isFinite(v))) {
    return NextResponse.json({ error: "bbox=minLng,minLat,maxLng,maxLat 필요" }, { status: 400 });
  }
  const [minLng, minLat, maxLng, maxLat] = bbox;
  if (
    minLat < -90 ||
    maxLat > 90 ||
    minLng < -180 ||
    maxLng > 180 ||
    minLat >= maxLat ||
    minLng >= maxLng ||
    maxLat - minLat > 3 ||
    maxLng - minLng > 3 ||
    !Number.isFinite(z) ||
    z < 5 ||
    z > 22
  ) {
    return NextResponse.json({ error: "bbox 범위 오류" }, { status: 400 });
  }
  // 줌아웃일수록 상위 도로급만 — z<=9 고속·국도, <=11 지방도까지, 그 이상 전부
  const maxRank = z <= 9 ? 3 : z <= 11 ? 6 : 7;
  const links = trafficLayer(minLat, minLng, maxLat, maxLng, maxRank);
  return NextResponse.json(
    { links },
    { headers: { "Cache-Control": "public, max-age=60" } },
  );
}
