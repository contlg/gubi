import { join } from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { ratingsByArea, ratingsFor } from "@/lib/google-places";
import { isLatLngPath } from "@/lib/api-validation";
import { gasAlongRoute } from "@/lib/opinet";
import { PersistCache } from "@/lib/persist-cache";
import { placesAlongRoute } from "@/lib/kakao-area-places";
import { searchByType } from "@/lib/places";
import { distanceM, pointAtFraction } from "@/lib/scoring/curvature";
import type { LatLng, Place, WaypointType } from "@/lib/types";

/**
 * 선택 코스 주변 "별점순 추천 명소" — OSM 로컬 색인에서 경로 주변 볼거리를
 * 찾고 구글 별점으로 베이지안 랭킹한다. 결과는 경로 격자로 30일 캐싱한다.
 * 구글 실패 시엔 별점 없이 OSM 중요도순으로 폴백한다.
 */
const TYPES: WaypointType[] = ["전망대", "관광명소", "강/호수", "카페", "맛집"];
/** 종류 가점(낮을수록 위로) — 드라이브 볼거리를 밥집보다 앞세운다 */
const TYPE_PENALTY: Record<string, number> = {
  전망대: 0,
  관광명소: 0,
  "강/호수": 0.5,
  카페: 1.5,
  맛집: 3,
};
/** 종류 필터 — 없으면 전체(볼거리 우선) */
const FILTERS: Record<string, WaypointType[]> = {
  cafe: ["카페"],
  food: ["맛집"],
  sight: ["전망대", "관광명소", "강/호수"],
};
// 경로를 9개 지점으로 나눠 반경 2.5km씩 찾고, 실제 경로선과의 거리로 다시 거른다.
// 예전엔 5지점×5km라 순환 코스 반환점에서 경로가 안 가는 동네(동해시 카페)까지 떴다.
const FRACTIONS = [0.06, 0.17, 0.28, 0.39, 0.5, 0.61, 0.72, 0.83, 0.94];
const RADIUS_M = 2500;
/** 경로선에서 이 거리 안만 "가는 길" — 카페·맛집은 500m, 볼거리(전망대 등)는 1km.
 *  직선거리라 언덕 너머·산책로 쪽 가게가 걸리지 않게 좁게 잡는다(정동진 윤슬 사례). */
const MAX_OFF_ROUTE_M: Record<string, number> = { 카페: 500, 맛집: 500 };
const MAX_OFF_ROUTE_DEFAULT = 1000;
/** 카페·맛집만 골라 보면 "조금 돌아가도 들를 곳" — 3km까지(들르면 경로가 바뀐다) */
const MAX_OFF_ROUTE_DETOUR_M = 3000;
const MAX = 10;
const PRIOR = 4.0;
// 신뢰가중 — 클수록 리뷰 적은 고득점을 사전평균으로 강하게 끌어내린다.
// 리뷰 1개 평점5 – 가중 ~4.03, 리뷰 500개 평점4.5 – ~4.47 (많이 검증된 곳이 위로).
const CONF = 30;

const cache = new PersistCache<Place[]>(
  join(process.cwd(), "data/cache/course-spots.json"),
  30 * 24 * 3600 * 1000,
  4000,
);

/** 경로 대표점을 ~2km 격자로 반올림한 캐시 키 — 같은 코스/지역은 재계산 없음 */
function routeKey(path: LatLng[], filter: string): string {
  const g = (n: number) => Math.round(n / 0.02);
  return `osm-v10|${filter}|${FRACTIONS.map((f) => {
    const p = pointAtFraction(path, f);
    return `${g(p.lat)},${g(p.lng)}`;
  }).join("|")}`;
}

/** 점에서 경로선(선분들)까지 최단거리(m) — 평면 근사 */
function distToPath(p: LatLng, path: LatLng[]): number {
  const kx = 111320 * Math.cos((p.lat * Math.PI) / 180), ky = 110574;
  let best = Infinity;
  // 긴 경로는 솎아서(최대 ~1500점) 계산량을 묶는다
  const step = Math.max(1, Math.floor(path.length / 1500));
  for (let i = 0; i + step < path.length; i += step) {
    const a = path[i], b = path[i + step];
    const ax = (a.lng - p.lng) * kx, ay = (a.lat - p.lat) * ky;
    const bx = (b.lng - p.lng) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const JUNK_NAME = /출구|입구|주차장|화장실|exit|entrance|parking|toilet|천$|하천|둔치/i;

function typeFromName(name: string): WaypointType | null {
  if (/카페|커피|coffee|cafe|베이커리|bakery|디저트/i.test(name)) return "카페";
  if (/식당|맛집|국밥|횟집|막국수|순두부|칼국수|갈비|restaurant/i.test(name)) return "맛집";
  return null;
}

export async function POST(req: NextRequest) {
  let body: { path?: unknown; filter?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  if (!isLatLngPath(body.path)) {
    return NextResponse.json({ error: "path({lat,lng} 배열)가 필요합니다" }, { status: 400 });
  }
  const path = body.path;
  // 주유소 — 오피넷 유가. 값이 하루에도 바뀌어 30일 경로 캐시에 넣지 않고,
  // 오피넷 쪽 30분 지점 캐시만 탄다. 경로 3km 안만.
  if (body.filter === "gas") {
    try {
      const stations = await gasAlongRoute(path, { fuel: "gasoline", sort: "price" });
      // 싼 곳이 멀면 왕복 기름·시간이 든다 — 경로에서 1km 벗어날 때마다 리터당
      // 30원 비싼 셈으로 쳐서 줄 세운다(값만 보면 2.7km 밖 주유소가 1등이 된다).
      const eff = (s: (typeof stations)[number]) => s.price + (s.offM / 1000) * 30;
      stations.sort((a, b) => eff(a) - eff(b));
      const places = stations.slice(0, MAX).map((s) => ({
        name: s.name,
        address: "",
        coord: s.coord,
        type: "주유소",
        offRouteM: s.offM,
        price: s.price,
        brand: s.brand,
        fuel: "휘발유",
      }));
      return NextResponse.json({ places });
    } catch {
      return NextResponse.json({ error: "주유소 조회 실패" }, { status: 502 });
    }
  }
  const filter = typeof body.filter === "string" && body.filter in FILTERS ? body.filter : "all";
  const types = filter === "all" ? TYPES : FILTERS[filter];
  const key = routeKey(path, filter);
  const hit = cache.get(key);
  if (hit) return NextResponse.json({ places: hit, cached: true });

  try {
    const centers = FRACTIONS.map((f) => pointAtFraction(path, f));
    // 한 요청의 동기 공간검색이 몰리지 않도록 25개(타입×지점)를 6개씩 처리한다.
    const jobs = types.flatMap((type) => centers.map((c) => ({ type, c })));
    type Hit = { place: Place & { type: WaypointType }; rank: number; type: WaypointType };
    const batches: Hit[][] = [];
    let localOk = 0;
    const CONC = 6;
    if (filter === "cafe" || filter === "food") {
      // 카페·맛집은 지도 자료(OSM)에 빠진 가게가 많아 카카오 장소를 쓴다. 지도 칸
      // 단위 30일 캐시라 같은 동네는 다시 안 부른다(kakao-area-places).
      const type: WaypointType = filter === "cafe" ? "카페" : "맛집";
      const { places } = await placesAlongRoute(
        path,
        filter === "cafe" ? "CE7" : "FD6",
        MAX_OFF_ROUTE_DETOUR_M,
      );
      // 경로를 8구간으로 나눠 구간마다 가까운 6곳씩 — 한쪽 동네만 몰리지 않게.
      // (별점 조회 후보를 묶어 구글 호출도 제한)
      const step = Math.max(1, Math.floor(path.length / 400));
      const lite = path.filter((_, i) => i % step === 0);
      const withPos = places
        .map((p) => {
          let bi = 0, bd = Infinity;
          for (let i = 0; i < lite.length; i++) {
            const d = distanceM(p.coord, lite[i]);
            if (d < bd) { bd = d; bi = i; }
          }
          return { p, bucket: Math.min(7, Math.floor((bi / lite.length) * 8)), off: distToPath(p.coord, path) };
        })
        .filter((x) => x.off <= MAX_OFF_ROUTE_DETOUR_M)
        .sort((a, b) => a.off - b.off);
      const perBucket = new Map<number, number>();
      const picked: Hit[] = [];
      for (const x of withPos) {
        const n = perBucket.get(x.bucket) ?? 0;
        if (n >= 6) continue;
        perBucket.set(x.bucket, n + 1);
        picked.push({ place: { ...x.p, type } as Place & { type: WaypointType }, rank: n, type });
      }
      batches.push(picked);
      localOk = jobs.length;
    }
    for (let i = 0; filter !== "cafe" && filter !== "food" && i < jobs.length; i += CONC) {
      const slice = jobs.slice(i, i + CONC);
      const res = await Promise.all(
        slice.map(({ type, c }) =>
          searchByType(c, RADIUS_M, type, "accuracy")
            .then((places) => {
              localOk++;
              // 한 종류만 볼 땐 지점당 더 많이 받아 10곳을 채운다
              return places.slice(0, filter === "all" ? 4 : 10).map((p, rank) => ({
                place: { ...p, type } as Place & { type: WaypointType },
                rank,
                type,
              }));
            })
            .catch(() => [] as Hit[]),
        ),
      );
      batches.push(...res);
    }

    const seen = new Set<string>();
    const scored: { place: Place & { type: WaypointType }; score: number }[] = [];
    for (const { place, rank, type } of batches.flat()) {
      const k = `${place.name}|${place.address}`;
      if (seen.has(k)) continue;
      seen.add(k);
      // 이름으로 종류 바로잡기 — 지도 자료 분류가 틀린 경우(강릉커피거리=전망대 등)
      const fixed = typeFromName(place.name) ?? type;
      if (!types.includes(fixed)) continue;
      place.type = fixed;
      // 실제 경로선에서 멀면 "가는 길"이 아니다
      const off = distToPath(place.coord, path);
      const limit =
        filter === "cafe" || filter === "food"
          ? MAX_OFF_ROUTE_DETOUR_M
          : (MAX_OFF_ROUTE_M[fixed] ?? MAX_OFF_ROUTE_DEFAULT);
      if (off > limit) continue;
      (place as Place & { offRouteM?: number }).offRouteM = Math.round(off);
      // 인기순위 + 종류가점(전체 보기일 때만). 이미 경로 주변이라 거리는 안 쓴다.
      scored.push({ place, score: rank + (filter === "all" ? (TYPE_PENALTY[fixed] ?? 2) : 0) });
    }
    scored.sort((a, b) => a.score - b.score);

    // 상위 후보에 구글 별점 보강 + 베이지안 가중(리뷰 적으면 사전평균으로 끌어내림)
    // 카페·맛집은 지역(칸) 단위 구글 별점 — 칸마다 한 번, 30일 저장. 후보 48곳 전부에
    // 붙여도 새로 부르는 건 칸 수(최대 12)뿐이다. 볼거리는 가게별 조회(7일 캐시).
    const detour = filter === "cafe" || filter === "food";
    const top = scored.slice(0, detour ? 48 : 24);
    const items = top.map((s) => ({ name: s.place.name, coord: s.place.coord }));
    const ratings = detour
      ? await ratingsByArea(items, filter === "cafe" ? "cafe" : "restaurant")
      : await ratingsFor(items);
    top.forEach((s, i) => {
      const r = ratings[i];
      if (r) {
        s.place.rating = r.rating;
        s.place.ratingCount = r.count;
        const weighted = (r.count * r.rating + CONF * PRIOR) / (r.count + CONF);
        s.score -= (weighted - PRIOR) * 6;
      } else {
        s.score += 2; // 별점 없는 곳은 검증된 곳보다 아래로
      }
    });
    // 돌아가는 거리도 감점 — 1km당 0.5점(별점 0.1점 차이 ≈ 0.6점)
    for (const s of top) {
      const off = (s.place as Place & { offRouteM?: number }).offRouteM ?? 0;
      s.score += (off / 1000) * 0.5;
    }
    top.sort((a, b) => a.score - b.score);

    // 쓸모없는 항목 빼기 — 별점이 없는데 영어 이름뿐이거나 출구·하천·주차장 같은 곳
    const useful = top.filter((s) => {
      const r = s.place.rating, n = s.place.ratingCount ?? 0;
      if (r != null) return !(r < 3.5 && n >= 5); // 평이 확실히 나쁜 곳 제외
      return /[가-힣]/.test(s.place.name) && !JUNK_NAME.test(s.place.name);
    });
    // 같은 곳 합치기 — 150m 안에서 별점·리뷰 수가 같으면(영어/한글 이름만 다른 경우)
    // 하나로, 60m 안이면 무조건 하나로. 한글 이름을 남긴다.
    const merged: typeof useful = [];
    for (const s of useful) {
      const dup = merged.findIndex((m) => {
        const d = distanceM(m.place.coord, s.place.coord);
        const sameRating =
          m.place.rating != null &&
          m.place.rating === s.place.rating &&
          m.place.ratingCount === s.place.ratingCount;
        return d < 60 || (d < 150 && sameRating);
      });
      if (dup < 0) merged.push(s);
      else if (!/[가-힣]/.test(merged[dup].place.name) && /[가-힣]/.test(s.place.name)) {
        merged[dup] = s;
      }
    }

    const result = merged.slice(0, MAX).map((s) => s.place);
    // 빈 결과나 로컬 색인 로딩 실패는 캐시하지 않아 데이터 복구 후 재시도한다.
    if (result.length > 0 && localOk >= jobs.length * 0.6) cache.set(key, result);
    return NextResponse.json({ places: result });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "추천 실패" },
      { status: 502 },
    );
  }
}
