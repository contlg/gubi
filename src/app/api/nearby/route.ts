import { NextRequest, NextResponse } from "next/server";

import { searchByType } from "@/lib/places";
import { isLatLngPath } from "@/lib/api-validation";
import { pointAtFraction } from "@/lib/scoring/curvature";
import {
  WAYPOINT_TYPES,
  type Place,
  type WaypointType,
} from "@/lib/types";

/** 경로의 이 지점들(비율) 주변에서 장소를 찾는다 */
const FRACTIONS = [0.25, 0.5, 0.75];
const SEARCH_RADIUS_M = 5000;
const MAX_RESULTS = 15;

export async function POST(req: NextRequest) {
  let body: { path?: unknown; types?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }

  const path = body.path;
  const types = (Array.isArray(body.types) ? body.types : []).filter(
    (t): t is WaypointType => (WAYPOINT_TYPES as readonly string[]).includes(t),
  );
  if (!isLatLngPath(path) || types.length === 0) {
    return NextResponse.json(
      { error: "path({lat,lng} 배열)와 types(경유지 종류 배열)가 필요합니다" },
      { status: 400 },
    );
  }

  try {
    const centers = FRACTIONS.map((f) => pointAtFraction(path, f));
    const batches = await Promise.all(
      types.flatMap((type) =>
        centers.map((c) =>
          searchByType(c, SEARCH_RADIUS_M, type)
            .then((places) => places.slice(0, 3).map((p) => ({ ...p, type })))
            .catch(() => [] as (Place & { type: WaypointType })[]),
        ),
      ),
    );

    const seen = new Set<string>();
    const places: (Place & { type: WaypointType })[] = [];
    for (const p of batches.flat()) {
      const key = `${p.name}|${p.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      places.push(p);
      if (places.length >= MAX_RESULTS) break;
    }

    return NextResponse.json({ places });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "주변 검색 실패" },
      { status: 502 },
    );
  }
}
