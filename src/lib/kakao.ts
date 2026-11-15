import "server-only";

import { loopCount, loopFetch, startLoopStage } from "@/lib/loop-timing";

import type { LatLng, Place } from "@/lib/types";

const LOCAL_BASE = "https://dapi.kakao.com/v2/local";
const NAVI_BASE = "https://apis-navi.kakaomobility.com/v1";

function authHeaders(): HeadersInit {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) {
    throw new Error("KAKAO_REST_API_KEY가 없습니다. .env.local을 확인하세요.");
  }
  return { Authorization: `KakaoAK ${key}` };
}

async function kakaoGet<T>(url: string): Promise<T> {
  const endTiming = startLoopStage("external.kakaoLocal");
  try {
  const res = await loopFetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`카카오 API 오류 ${res.status}: ${body}`);
  }
  return res.json() as Promise<T>;
  } finally {
    endTiming?.();
  }
}

interface LocalDocument {
  place_name?: string;
  address_name: string;
  x: string; // 경도
  y: string; // 위도
  distance?: string; // 키워드 검색에 x,y를 주면 채워지는 직선거리(m)
}

interface LocalResponse {
  documents: LocalDocument[];
}

function toPlace(doc: LocalDocument): Place {
  return {
    name: doc.place_name ?? doc.address_name,
    address: doc.address_name,
    coord: { lat: Number(doc.y), lng: Number(doc.x) },
    ...(doc.distance ? { distanceM: Number(doc.distance) } : {}),
  };
}

function haversineM(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.round(Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx));
}

/**
 * 주소 검색 – 결과 없으면 키워드 검색으로 폴백. 핵심은 정렬: 이름 정확도가
 * 1순위, 거리가 2순위다. 예전엔 거리순(sort=distance)만 써서 "대방역"을 치면
 * 실제 대방역(지하철) 대신 이름에 '대방'이 든 먼 상호가 먼저 떴다. 이제
 * 카카오 정확도순(accuracy)으로 받아 완전일치>접두일치>부분일치로 재정렬하고,
 * 같은 등급 안에서만 가까운 곳을 앞에 둔다. origin이 있으면 직선거리를 채운다.
 */
export async function searchPlaces(
  query: string,
  origin?: LatLng,
): Promise<Place[]> {
  const q = encodeURIComponent(query);
  const byAddress = await kakaoGet<LocalResponse>(
    `${LOCAL_BASE}/search/address.json?query=${q}&size=5`,
  );
  let docs = byAddress.documents;
  if (docs.length === 0) {
    // 키워드 검색 — 정확도순(유명 지점·정확 매칭이 앞). origin은 힌트로만 주고
    // 거리순 정렬은 쓰지 않는다(정확도를 뭉개므로).
    const loc = origin ? `&x=${origin.lng}&y=${origin.lat}` : "";
    const byKeyword = await kakaoGet<LocalResponse>(
      `${LOCAL_BASE}/search/keyword.json?query=${q}&size=15&sort=accuracy${loc}`,
    );
    docs = byKeyword.documents;
  }
  const places = docs.map(toPlace);
  if (origin) {
    for (const p of places) {
      if (p.distanceM == null) p.distanceM = haversineM(origin, p.coord);
    }
  }
  // 이름 정확도 등급 — 공백 무시. 0=완전일치 1=접두 2=부분 3=그 외(카카오 판단)
  const norm = (s: string) => s.replace(/\s+/g, "");
  const qn = norm(query);
  const rel = (name: string) => {
    const n = norm(name);
    if (n === qn) return 0;
    if (n.startsWith(qn)) return 1;
    if (n.includes(qn)) return 2;
    return 3;
  };
  // 등급 1순위, 그 안에서만 거리 2순위(origin 없으면 카카오 정확도 순서 유지)
  const relOf = new Map(places.map((p, i) => [p, [rel(p.name), i] as const]));
  places.sort((a, b) => {
    const [ra, ia] = relOf.get(a)!;
    const [rb, ib] = relOf.get(b)!;
    if (ra !== rb) return ra - rb;
    if (origin) return (a.distanceM ?? 1e9) - (b.distanceM ?? 1e9);
    return ia - ib;
  });
  return places;
}

export type RoutePriority = "RECOMMEND" | "TIME" | "DISTANCE";

export interface NaviRoute {
  result_code: number;
  result_msg: string;
  summary: {
    distance: number;
    duration: number;
    fare: { toll: number; taxi: number };
  };
  sections: {
    /** 이 구간(경유지 사이) 거리(m) — 스퍼(왕복 진입) 감지에 사용 */
    distance?: number;
    roads: {
      vertexes: number[];

      distance?: number;
      /** 실시간 교통 속도(km/h) — road_details=true일 때 */
      traffic_speed?: number;
      /** 실시간 소통: 0정보없음 1정체 2지체 3서행 4원활 */
      traffic_state?: number;
    }[];
  }[];
}

/**
 * 실시간 정체(1)+지체(2) 구간의 거리 비율 — road_details 기반.
 * 소통 정보가 있는 구간이 30% 미만이면(시골 등 미제공 지역) null.
 */
export function jamRatio(route: NaviRoute): number | null {
  let total = 0;
  let known = 0;
  let jam = 0;
  for (const s of route.sections) {
    for (const r of s.roads) {
      const d = r.distance ?? 0;
      total += d;
      if (r.traffic_state && r.traffic_state > 0) {
        known += d;
        if (r.traffic_state <= 2) jam += d;
      }
    }
  }
  if (total === 0 || known / total < 0.3) return null;
  return jam / total;
}

interface NaviResponse {
  routes: NaviRoute[];
}

export interface DirectionsOptions {
  avoid?: ("motorway" | "toll")[];
  waypoints?: LatLng[];
  alternatives?: boolean;
}

/**
 * 카카오모빌리티 길찾기는 초당 호출 제한이 있다(-10 "API limit has been
 * exceeded"). 루프 생성은 한 요청에서 길찾기를 수십 번 병렬로 쏘므로,
 * 동시 실행 수를 제한하고 제한 응답이면 백오프 후 재시도한다.
 */
const NAVI_CONCURRENCY = 4;
let naviActive = 0;
const naviQueue: (() => void)[] = [];
async function naviSlot(): Promise<void> {
  if (naviActive < NAVI_CONCURRENCY) {
    naviActive++;
    return;
  }
  await new Promise<void>((resolve) => naviQueue.push(resolve));
  naviActive++;
}
function naviRelease() {
  naviActive--;
  naviQueue.shift()?.();
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 길찾기 응답 캐시 — 같은 OD·옵션 반복 호출(재시도·재탐색)에 쿼터를 아낀다 */
const naviCache = new Map<string, { ts: number; data: unknown }>();
const NAVI_CACHE_TTL_MS = 10 * 60 * 1000;
const NAVI_CACHE_MAX = 500;

/**
 * 서킷 브레이커 — 일일 쿼터 소진이면 재시도가 무의미한데, 실패마다 백오프
 * 재시도(수 초)를 반복하면 요청 전체가 재시도 폭풍으로 수십 초 느려진다.
 * 제한을 만나면 1번만 짧게 재시도(순간 제한 대비)하고, 그래도 막히면
 * 60초간 카카오 호출을 즉시 실패시켜 로컬 폴백이 바로 잡게 한다.
 */
let naviBlockedUntil = 0;

async function naviGet<T>(url: string): Promise<T> {
  const endTiming = startLoopStage("external.kakaoNavi");
  try {
  const hit = naviCache.get(url);
  if (hit && Date.now() - hit.ts < NAVI_CACHE_TTL_MS) {
    loopCount("naviCacheHit");
    return hit.data as T;
  }
  loopCount("naviCacheMiss");
  if (Date.now() < naviBlockedUntil) {
    loopCount("naviCircuitBlocked");
    throw new Error("카카오 길찾기 한도 초과 — 로컬 추정 모드");
  }
  const endSlot = startLoopStage("kakao.slotWait");
  await naviSlot();
  endSlot?.();
  try {
    for (let attempt = 0; ; attempt++) {
      const res = await loopFetch(url, { headers: authHeaders() });
      if (res.ok) {
        const data = (await res.json()) as T;
        if (naviCache.size >= NAVI_CACHE_MAX) {
          const oldest = naviCache.keys().next().value;
          if (oldest !== undefined) naviCache.delete(oldest);
        }
        naviCache.set(url, { ts: Date.now(), data });
        return data;
      }
      const body = await res.text();
      const limited = res.status === 429 || body.includes('"code":-10');
      if (limited && attempt < 1) {
        loopCount("naviRetries");
        await sleep(500 + Math.random() * 200);
        continue;
      }
      if (limited) naviBlockedUntil = Date.now() + 60_000;
      throw new Error(`카카오 API 오류 ${res.status}: ${body}`);
    }
  } finally {
    naviRelease();
  }
  } finally {
    endTiming?.();
  }
}

export async function getDirections(
  origin: LatLng,
  destination: LatLng,
  priority: RoutePriority,
  opts: DirectionsOptions = {},
): Promise<NaviRoute[]> {
  const params = new URLSearchParams({
    origin: `${origin.lng},${origin.lat}`,
    destination: `${destination.lng},${destination.lat}`,
    priority,
    alternatives: String(opts.alternatives ?? true),
    road_details: "true",
  });
  if (opts.avoid?.length) params.set("avoid", opts.avoid.join("|"));
  if (opts.waypoints?.length) {
    params.set(
      "waypoints",
      opts.waypoints.map((p) => `${p.lng},${p.lat}`).join("|"),
    );
  }
  const data = await naviGet<NaviResponse>(
    `${NAVI_BASE}/directions?${params}`,
  );
  return (data.routes ?? []).filter((r) => r.result_code === 0);
}

/** 좌표 – 도로명·지번 주소(카카오 로컬 coord2address). 지도에서 고른 지점 이름용. */
export async function coordToAddress(c: LatLng): Promise<{ road?: string; jibun?: string; building?: string } | null> {
  type R = { documents?: { road_address?: { address_name?: string; building_name?: string } | null; address?: { address_name?: string } | null }[] };
  const data = await kakaoGet<R>(`${LOCAL_BASE}/geo/coord2address.json?x=${c.lng}&y=${c.lat}`);
  const d = data.documents?.[0];
  if (!d) return null;
  return {
    ...(d.road_address?.address_name ? { road: d.road_address.address_name } : {}),
    ...(d.road_address?.building_name ? { building: d.road_address.building_name } : {}),
    ...(d.address?.address_name ? { jibun: d.address.address_name } : {}),
  };
}

/** vertexes 평면 배열([lng,lat,lng,lat,...])을 좌표 리스트로 변환 */
export function routePath(route: NaviRoute): LatLng[] {
  const path: LatLng[] = [];
  for (const section of route.sections) {
    for (const road of section.roads) {
      const v = road.vertexes;
      for (let i = 0; i + 1 < v.length; i += 2) {
        path.push({ lng: v[i], lat: v[i + 1] });
      }
    }
  }
  return path;
}
