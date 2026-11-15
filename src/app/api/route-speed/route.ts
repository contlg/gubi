import { NextRequest, NextResponse } from "next/server";

import { isLatLngPath } from "@/lib/api-validation";
import { pathSpeedSamples } from "@/lib/localroute";

/** 경로의 도로종류 기반 속도 샘플 — 로컬 그래프만 쓰므로 빠르다(카카오 X). */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const path = (body as { path?: unknown })?.path;
  if (!isLatLngPath(path)) {
    return NextResponse.json(
      { error: "path는 {lat, lng} 배열이어야 합니다 (최소 2개)" },
      { status: 400 },
    );
  }
  return NextResponse.json({ speed: pathSpeedSamples(path) });
}
