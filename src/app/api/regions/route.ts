import { NextRequest, NextResponse } from "next/server";

import { visitedDongs } from "@/lib/admdong";
import { regionsAlongPath, regionsForPaths } from "@/lib/regions";
import { jsonBodyError, readJsonBody } from "@/lib/request-json";

/**
 * 주행 궤적 – 지나온 시·군·구. 클라가 자기 기록의 encoded path를 보내면
 * 지역명만 돌려준다(민감정보 없음). path=단일 주행(순서 유지),
 * paths=정복 지도(유일 집합). 모두 로컬 행정동 경계로 판정한다.
 */
export async function POST(req: NextRequest) {
  let body: { path?: unknown; paths?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const detail = jsonBodyError(error);
    return NextResponse.json({ error: detail.message }, { status: detail.status });
  }

  try {
    if (
      typeof body.path === "string" &&
      body.path.length > 0 &&
      body.path.length <= 200_000
    ) {
      const regions = await regionsAlongPath(body.path);
      return NextResponse.json({ regions });
    }
    if (Array.isArray(body.paths)) {
      const encs = body.paths
        .filter(
          (p): p is string =>
            typeof p === "string" && p.length > 0 && p.length <= 200_000,
        )
        .slice(0, 500);
      let totalChars = 0;
      const bounded = encs.filter((path) => {
        if (totalChars + path.length > 1_500_000) return false;
        totalChars += path.length;
        return true;
      });
      // 지나간 시·군·구와 정복 동 폴리곤을 같은 로컬 경계에서 반환.
      const [regions, dongs] = await Promise.all([
        regionsForPaths(bounded),
        Promise.resolve(visitedDongs(bounded)),
      ]);
      return NextResponse.json({ regions, dongs });
    }
    return NextResponse.json({ error: "path 또는 paths가 필요합니다" }, { status: 400 });
  } catch (e) {
    // 경계 데이터 장애가 기록 보기를 막지 않게 빈 목록으로
    return NextResponse.json({
      regions: [],
      warn: e instanceof Error ? e.message : "지역 조회 실패",
    });
  }
}
