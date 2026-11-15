import "server-only";

import { join } from "node:path";

import { PersistCache } from "@/lib/persist-cache";
import type { LatLng, Place } from "@/lib/types";

/**
 * 카카오 카테고리 장소를 "지도 칸" 단위로 받아 30일 캐시한다.
 *
 * 경로 주변을 한 번에 검색하면 코스마다 같은 동네를 또 부른다. 그래서 전국을
 * 약 2.2km 칸으로 나누고, 칸마다 결과와 받은 날짜를 저장한다. 다른 코스가 같은
 * 칸을 지나가면 30일 안에는 카카오를 다시 부르지 않는다.
 *
 * 칸 하나는 카카오 사각형 검색(rect)으로 최대 3쪽(45곳)까지 받는다. 시내처럼
 * 45곳을 넘는 칸은 4등분해서 한 번 더 받는다.
 */

export type KakaoCategory = "CE7" | "FD6"; // 카페 / 음식점

export interface AreaPlace extends Place {
  /** 카카오 분류 — "음식점 > 카페 > 커피전문점" 등 */
  category?: string;
  kakaoId?: string;
  phone?: string;
}

const CELL_LAT = 0.02; // ≈ 2.2km
const CELL_LNG = 0.025; // ≈ 2.2km (위도 37° 기준)
const TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_CELLS_PER_CALL = 400;
const CONCURRENCY = 8;

const cache = new PersistCache<AreaPlace[]>(
  join(process.cwd(), "data/cache/kakao-area-places.json"),
  TTL_MS,
  60_000,
);

interface CategoryDoc {
  id: string;
  place_name: string;
  category_name: string;
  address_name: string;
  road_address_name?: string;
  phone?: string;
  x: string;
  y: string;
}
interface CategoryResp {
  documents: CategoryDoc[];
  meta: { is_end: boolean; pageable_count: number; total_count: number };
}

async function fetchRect(
  code: KakaoCategory,
  rect: [number, number, number, number],
): Promise<{ places: AreaPlace[]; overflow: boolean }> {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) throw new Error("KAKAO_REST_API_KEY 없음");
  const places: AreaPlace[] = [];
  let overflow = false;
  for (let page = 1; page <= 3; page++) {
    const url =
      `https://dapi.kakao.com/v2/local/search/category.json?category_group_code=${code}` +
      `&rect=${rect.join(",")}&page=${page}&size=15`;
    const res = await fetch(url, { headers: { Authorization: `KakaoAK ${key}` } });
    if (!res.ok) throw new Error(`카카오 카테고리 검색 ${res.status}`);
    const data = (await res.json()) as CategoryResp;
    for (const d of data.documents) {
      places.push({
        name: d.place_name,
        address: d.road_address_name || d.address_name,
        coord: { lat: Number(d.y), lng: Number(d.x) },
        category: d.category_name,
        kakaoId: d.id,
        ...(d.phone ? { phone: d.phone } : {}),
      });
    }
    if (data.meta.is_end) break;
    if (page === 3 && data.meta.total_count > 45) overflow = true;
  }
  return { places, overflow };
}

function cellOf(p: LatLng): [number, number] {
  return [Math.floor(p.lat / CELL_LAT), Math.floor(p.lng / CELL_LNG)];
}

async function loadCell(code: KakaoCategory, i: number, j: number): Promise<AreaPlace[]> {
  const k = `v2|${code}|${i}|${j}`;
  const hit = cache.get(k);
  if (hit) return hit;
  const lat0 = i * CELL_LAT, lng0 = j * CELL_LNG;
  const rect: [number, number, number, number] = [lng0, lat0, lng0 + CELL_LNG, lat0 + CELL_LAT];
  const first = await fetchRect(code, rect);
  let places = first.places;
  if (first.overflow) {
    // 시내 칸 — 4등분해서 더 받는다
    const hl = CELL_LAT / 2, hg = CELL_LNG / 2;
    const quads = await Promise.all(
      [
        [lng0, lat0],
        [lng0 + hg, lat0],
        [lng0, lat0 + hl],
        [lng0 + hg, lat0 + hl],
      ].map(([x, y]) => fetchRect(code, [x, y, x + hg, y + hl])),
    );
    const seen = new Set<string>();
    places = quads
      .flatMap((q) => q.places)
      .filter((p) => !seen.has(p.kakaoId!) && seen.add(p.kakaoId!));
  }
  cache.set(k, places);
  return places;
}

/**
 * 경로선에서 radiusM 안을 덮는 칸들의 장소 — 캐시에 없는(또는 30일 지난) 칸만
 * 카카오를 부른다. 돌려주는 건 칸 단위 후보라 거리 필터는 호출 쪽이 한다.
 */
export async function placesAlongRoute(
  path: LatLng[],
  code: KakaoCategory,
  radiusM: number,
): Promise<{ places: AreaPlace[]; cells: number; fetched: number }> {
  const cells = new Map<string, [number, number]>();
  const di = Math.ceil(radiusM / 1000 / (CELL_LAT * 111));
  const dj = Math.ceil(radiusM / 1000 / (CELL_LNG * 88));
  // 경로를 약 500m 간격으로 훑으며 주변 칸을 모은다
  let acc = 500;
  for (let n = 0; n < path.length; n++) {
    if (n > 0) {
      const a = path[n - 1], b = path[n];
      acc += Math.hypot((b.lat - a.lat) * 110574, (b.lng - a.lng) * 88000);
    }
    if (acc < 500 && n !== path.length - 1) continue;
    acc = 0;
    const [ci, cj] = cellOf(path[n]);
    for (let i = ci - di; i <= ci + di; i++)
      for (let j = cj - dj; j <= cj + dj; j++) cells.set(`${i}|${j}`, [i, j]);
  }
  const list = [...cells.values()].slice(0, MAX_CELLS_PER_CALL);
  let fetched = 0;
  const out: AreaPlace[] = [];
  let next = 0;
  async function worker() {
    while (next < list.length) {
      const [i, j] = list[next++];
      const before = cache.get(`v2|${code}|${i}|${j}`);
      try {
        const ps = await loadCell(code, i, j);
        if (!before) fetched++;
        out.push(...ps);
      } catch {
        // 한 칸 실패는 건너뛴다(다음 요청 때 다시 시도)
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seen = new Set<string>();
  return {
    places: out.filter((p) => !seen.has(p.kakaoId!) && seen.add(p.kakaoId!)),
    cells: list.length,
    fetched,
  };
}
