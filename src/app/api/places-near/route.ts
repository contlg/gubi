import { NextRequest, NextResponse } from "next/server";

import { ratingsFor } from "@/lib/google-places";
import { searchByType } from "@/lib/places";
import type { LatLng, Place, WaypointType } from "@/lib/types";

/**
 * 현재 위치 주변 "드라이브 명소" — OSM 중요도(위키데이터·한국어명 등)와
 * 볼거리 종류 가중치·거리를 섞어 랭킹한다. 상위 결과만 구글 별점으로 보강한다.
 */
const TYPES: WaypointType[] = ["전망대", "관광명소", "강/호수", "카페", "맛집"];
/** 종류별 가점(낮을수록 위로) — 드라이브 볼거리를 밥집·카페보다 앞세운다 */
const TYPE_PENALTY: Record<string, number> = {
  전망대: 0,
  관광명소: 0,
  "강/호수": 0.5,
  카페: 1.5,
  맛집: 3,
};
const RADIUS_M = 20000;
const MAX = 24;

function haversineM(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.round(Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx));
}

export async function POST(req: NextRequest) {
  let body: { lat?: unknown; lng?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const lat = Number(body.lat);
  const lng = Number(body.lng);
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return NextResponse.json({ error: "lat/lng이 필요합니다" }, { status: 400 });
  }
  const center: LatLng = { lat, lng };

  try {
    // 각 종류를 로컬 OSM 중요도순으로 받아 배치 내 순위를 품질 신호로 쓴다.
    const batches = await Promise.all(
      TYPES.map((type) =>
        searchByType(center, RADIUS_M, type, "accuracy")
          .then((places) =>
            places.slice(0, 10).map((p, rank) => ({
              place: { ...p, type } as Place & { type: WaypointType },
              rank,
              type,
            })),
          )
          .catch(() => []),
      ),
    );

    const seen = new Set<string>();
    const scored: { place: Place & { type: WaypointType }; score: number }[] = [];
    for (const { place, rank, type } of batches.flat()) {
      const key = `${place.name}|${place.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const distanceM = place.distanceM ?? haversineM(center, place.coord);
      place.distanceM = distanceM;
      // 인기순위 + 종류가점 + 거리(2.5km당 1점). 낮을수록 위로.
      const score = rank + (TYPE_PENALTY[type] ?? 2) + distanceM / 2500;
      scored.push({ place, score });
    }
    scored.sort((a, b) => a.score - b.score);

    // 상위 후보에 구글 별점 보강. 별점이 있으면 랭킹에도
    // 반영 — 평 좋은 맛집·카페를 위로. 별점 없는 볼거리는 기존 순위 유지.
    const top = scored.slice(0, MAX);
    const ratings = await ratingsFor(
      top.map((s) => ({ name: s.place.name, coord: s.place.coord })),
    );
    // 베이지안 가중 — 리뷰가 적으면 평점을 사전평균(PRIOR) 쪽으로 끌어내려
    // 신뢰도만큼만 반영한다. "리뷰 1개 평점5"가 "리뷰 1000개 평점4.3"을 못 이기게.
    //   weighted = (v·R + m·C) / (v + m)   (v=리뷰수, m=신뢰가중, C=사전평균)
    const PRIOR = 4.0;
    const CONF = 20;
    top.forEach((s, i) => {
      const r = ratings[i];
      if (r) {
        s.place.rating = r.rating;
        s.place.ratingCount = r.count;
        const weighted = (r.count * r.rating + CONF * PRIOR) / (r.count + CONF);
        // 신뢰 가중 평점이 사전평균보다 높은 만큼만 위로(낮으면 아래로)
        s.score -= (weighted - PRIOR) * 1.6;
      }
    });
    top.sort((a, b) => a.score - b.score);

    return NextResponse.json({ places: top.map((s) => s.place) });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "주변 검색 실패" },
      { status: 502 },
    );
  }
}
