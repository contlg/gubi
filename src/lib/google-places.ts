import "server-only";

import { join } from "node:path";

import { PersistCache } from "@/lib/persist-cache";
import type { LatLng } from "@/lib/types";

/**
 * 구글 Places API (New)로 장소 별점을 가져온다 — 카카오는 별점을 API로 주지
 * 않아서, 카카오로 찾은 장소의 이름+좌표로 구글에서 평점만 조회해 보강한다.
 * 결과 좌표가 원 좌표에서 멀면(다른 지점) 버린다. 평점은 잘 안 바뀌므로 캐시.
 */
export interface PlaceRating {
  rating: number;
  count: number;
}

const KEY = process.env.GOOGLE_PLACES_API_KEY;
// 파일 캐시 7일 — 별점은 잘 안 바뀌고, 서버 재시작에도 유지돼 비용을 아낀다
const cache = new PersistCache<PlaceRating | null>(
  join(process.cwd(), "data/cache/place-ratings.json"),
  7 * 24 * 60 * 60 * 1000,
);

// 일일 호출 상한 — /api/places-near가 무인증 공개라, 남이 좌표 바꿔가며
// 호출해도 구글 요금이 무한정 나가지 않게 하드캡. 초과하면 별점 조회를
// 건너뛴다(장소 목록은 카카오라 무료·정상). ※ 진짜 안전장치는 구글 클라우드
// 콘솔의 일일 할당량/예산 상한 — 아래 캡은 2차 방어선.
const DAILY_CAP = 800;
let dayKey = "";
let dayCount = 0;
/** 구글이 일일 할당량 초과(429)를 돌려준 날 — 그날은 더 부르지 않는다 */
let quotaDeadDay = "";
function budgetOk(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (quotaDeadDay === today) return false;
  if (today !== dayKey) {
    dayKey = today;
    dayCount = 0;
  }
  if (dayCount >= DAILY_CAP) return false;
  dayCount++;
  return true;
}

function km(a: LatLng, b: LatLng): number {
  const kx = 111.32 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 110.54, (b.lng - a.lng) * kx);
}

/** 이름+좌표로 구글 1건 조회 (없으면 null). 400m 넘게 벗어나면 무시 */
export async function placeRating(
  name: string,
  coord: LatLng,
): Promise<PlaceRating | null> {
  if (!KEY) return null;
  const ck = `${name}|${coord.lat.toFixed(3)}|${coord.lng.toFixed(3)}`;
  const hit = cache.get(ck);
  if (hit !== undefined) return hit;
  // 캐시 미스인데 일일 상한 초과면 조회 안 함(별점 없이 진행) — 요금 하드캡
  if (!budgetOk()) return null;

  let v: PlaceRating | null = null;
  // 확정 응답(성공)만 캐시한다 — 예전엔 할당량 초과·오류도 "별점 없음"으로 7일
  // 저장해, 한도가 풀려도 일주일간 별점이 안 떴다.
  let definitive = false;
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask":
          "places.rating,places.userRatingCount,places.location",
      },
      body: JSON.stringify({
        textQuery: name,
        languageCode: "ko",
        maxResultCount: 1,
        locationBias: {
          circle: {
            center: { latitude: coord.lat, longitude: coord.lng },
            radius: 600,
          },
        },
      }),
    });
    if (res.status === 429) quotaDeadDay = new Date().toISOString().slice(0, 10);
    if (res.ok) {
      definitive = true;
      const data = await res.json();
      const p = data.places?.[0];
      if (p?.rating != null) {
        const loc = p.location;
        const near =
          !loc || km(coord, { lat: loc.latitude, lng: loc.longitude }) < 0.4;
        if (near) v = { rating: p.rating, count: p.userRatingCount ?? 0 };
      }
    }
  } catch {
    // 조회 실패는 조용히 무시 (별점 없이 표시)
  }
  if (definitive) cache.set(ck, v);
  return v;
}

/** 동시 실행 제한하며 여러 장소 평점을 병렬 조회 */
export async function ratingsFor(
  items: { name: string; coord: LatLng }[],
  concurrency = 6,
): Promise<(PlaceRating | null)[]> {
  const out: (PlaceRating | null)[] = new Array(items.length).fill(null);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await placeRating(items[i].name, items[i].coord);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker),
  );
  return out;
}

// 가게마다 구글을 한 번씩 부르면(텍스트 검색) 카페 20곳에 20번이 든다. 구글 "주변
// 검색"은 한 번에 그 동네 인기 가게 최대 20곳의 별점을 준다 — 카카오 칸과 같은
// 2.2km 칸 단위로 한 번 받아 30일 저장하고, 카카오 가게와 위치·이름으로 짝짓는다.

export interface AreaRating {
  name: string;
  lat: number;
  lng: number;
  rating: number;
  count: number;
}

const AREA_CELL_LAT = 0.02;
const AREA_CELL_LNG = 0.025;
const areaCache = new PersistCache<AreaRating[]>(
  join(process.cwd(), "data/cache/google-area-ratings.json"),
  30 * 24 * 60 * 60 * 1000,
  20_000,
);
let nearbyDeadDay = "";

export function areaCellOf(p: LatLng): [number, number] {
  return [Math.floor(p.lat / AREA_CELL_LAT), Math.floor(p.lng / AREA_CELL_LNG)];
}

async function fetchAreaCell(
  kind: "cafe" | "restaurant",
  i: number,
  j: number,
): Promise<AreaRating[] | null> {
  const k = `v1|${kind}|${i}|${j}`;
  const hit = areaCache.get(k);
  if (hit) return hit;
  const today = new Date().toISOString().slice(0, 10);
  if (!KEY || nearbyDeadDay === today || !budgetOk()) return null;
  const center = { latitude: (i + 0.5) * AREA_CELL_LAT, longitude: (j + 0.5) * AREA_CELL_LNG };
  try {
    const res = await fetch("https://places.googleapis.com/v1/places:searchNearby", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": KEY,
        "X-Goog-FieldMask":
          "places.displayName,places.location,places.rating,places.userRatingCount",
      },
      body: JSON.stringify({
        includedTypes: [kind],
        maxResultCount: 20,
        rankPreference: "POPULARITY",
        languageCode: "ko",
        // 칸(2.2km)을 덮는 원 — 반대각선 약 1.6km
        locationRestriction: { circle: { center, radius: 1600 } },
      }),
    });
    if (res.status === 429) nearbyDeadDay = today;
    if (!res.ok) return null; // 실패는 저장하지 않는다(다음에 다시)
    const data = await res.json();
    const list: AreaRating[] = (data.places ?? [])
      .filter((p: { rating?: number }) => p.rating != null)
      .map(
        (p: {
          displayName?: { text?: string };
          location: { latitude: number; longitude: number };
          rating: number;
          userRatingCount?: number;
        }) => ({
          name: p.displayName?.text ?? "",
          lat: p.location.latitude,
          lng: p.location.longitude,
          rating: p.rating,
          count: p.userRatingCount ?? 0,
        }),
      );
    areaCache.set(k, list);
    return list;
  } catch {
    return null;
  }
}

const normName = (s: string) => s.toLowerCase().replace(/[\s()\-·.,'&]/g, "");

/**
 * 카카오 등에서 찾은 가게들에 지역 단위 구글 별점을 붙인다. 칸은 최대 maxCells개만
 * 새로 부른다(나머지는 캐시에 있으면 쓰고, 없으면 별점 없이).
 * 짝짓기: 80m 안에서 이름이 서로 포함되거나, 25m 안이면 이름이 달라도 같은 가게로 본다.
 */
export async function ratingsByArea(
  items: { name: string; coord: LatLng }[],
  kind: "cafe" | "restaurant",
  maxCells = 12,
): Promise<(PlaceRating | null)[]> {
  const cells = new Map<string, [number, number]>();
  for (const it of items) {
    const [i, j] = areaCellOf(it.coord);
    cells.set(`${i}|${j}`, [i, j]);
  }
  const byCell = new Map<string, AreaRating[]>();
  let fresh = 0;
  for (const [key, [i, j]] of cells) {
    const cached = areaCache.get(`v1|${kind}|${i}|${j}`);
    if (cached) {
      byCell.set(key, cached);
      continue;
    }
    if (fresh >= maxCells) continue;
    fresh++;
    const got = await fetchAreaCell(kind, i, j);
    if (got) byCell.set(key, got);
  }
  return items.map((it) => {
    const [i, j] = areaCellOf(it.coord);
    // 칸 경계 근처 가게는 이웃 칸 결과에도 있을 수 있어 주변 9칸을 본다
    const pool: AreaRating[] = [];
    for (let di = -1; di <= 1; di++)
      for (let dj = -1; dj <= 1; dj++) pool.push(...(byCell.get(`${i + di}|${j + dj}`) ?? []));
    const n = normName(it.name);
    let best: AreaRating | null = null;
    let bestD = Infinity;
    for (const r of pool) {
      const d = km(it.coord, { lat: r.lat, lng: r.lng }) * 1000;
      const rn = normName(r.name);
      const nameOk = n.length >= 2 && rn.length >= 2 && (rn.includes(n) || n.includes(rn));
      if ((d < 80 && nameOk) || d < 25) {
        if (d < bestD) {
          bestD = d;
          best = r;
        }
      }
    }
    return best ? { rating: best.rating, count: best.count } : null;
  });
}
