import { NextRequest, NextResponse } from "next/server";

import { adminDongAt } from "@/lib/admdong";
import { isLatLngPath } from "@/lib/api-validation";
import { photoSpots } from "@/lib/photospots";
import { distanceM } from "@/lib/scoring/curvature";
import { DRIVE_STYLES, type DriveStyle, type LatLng } from "@/lib/types";

/** 지점이 코스 어디쯤인지 — 출발부터 가장 가까운 경로 점까지의 거리(km) */
function kmAlong(path: LatLng[], p: LatLng): number {
  let acc = 0, best = Infinity, at = 0;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) acc += distanceM(path[i - 1], path[i]);
    const d = distanceM(path[i], p);
    if (d < best) {
      best = d;
      at = acc;
    }
  }
  return Math.round(at / 100) / 10;
}

/** 코스의 로드뷰 촬영 지점 — 스타일 풍경 매칭·도시 제외·물 방향 pan (로컬 데이터만, 카카오 X) */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const { path, styles } = (body ?? {}) as { path?: unknown; styles?: unknown };
  if (!isLatLngPath(path)) {
    return NextResponse.json(
      { error: "path는 {lat, lng} 배열이어야 합니다 (최소 2개)" },
      { status: 400 },
    );
  }
  const valid = (Array.isArray(styles) ? styles : []).filter((s): s is DriveStyle =>
    DRIVE_STYLES.includes(s as DriveStyle),
  );
  // "바닷가 구간"만으로는 어디인지 몰랐다(10-27) — 코스 몇 km 지점·시군구 읍면동을 같이 준다
  const spots = photoSpots(path, valid).map((s) => {
    const dong = adminDongAt(s.coord);
    const place = dong ? dong.name.split(" ").slice(1).join(" ") : undefined;
    return { ...s, km: kmAlong(path, s.coord), place };
  });
  return NextResponse.json({ spots });
}
