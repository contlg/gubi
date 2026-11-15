import "server-only";

import { loopCount, startLoopStage } from "@/lib/loop-timing";

import { coastalSpine } from "@/lib/coastgraph";
import { getDirections, jamRatio, routePath } from "@/lib/kakao";
import { isRoutableAnchor, pathJuncPerKm } from "@/lib/localroute";
import { getPrefetchedPoints } from "@/lib/osm";
import { styleAnchorsAlong, STYLE_VARIANTS } from "@/lib/places";
import {
  courseLeg,
  routeViaSmooth,
  searchAnchors,
  searchCoastAnchors,
  spineDirectRoute,
  styleAvoid,
  windingLoopRoute,
  type SegLoopTheme,
} from "@/lib/routing";
import {
  findRiversideSegments,
  findWindingSegments,
  riversideQuality,
  segMid,
  segQuality,
  type WindingSegment,
} from "@/lib/winding";
import { estimateFuelCost } from "@/lib/scoring/cost";
import { curveMetrics } from "@/lib/scoring/curvature";
import type {
  AvoidOption,
  DriveStyle,
  LatLng,
  Place,
  RouteCandidate,
  WaypointType,
} from "@/lib/types";

export interface LoopOptions {
  avoid?: AvoidOption[];
  /** 앵커(경유지)로 쓸 장소 종류 — 섹터마다 순환 배정 */
  waypointTypes?: WaypointType[];
  /** 사용자가 반드시 들르겠다고 지정한 경유지 (최대 3개) */
  fixed?: Place[];
  /** 드라이브 종류 — 해안도로/강변도로면 앵커 편향 + 변형 루프 생성 */
  styles?: DriveStyle[];
}

/** 출발지 기준 방향 섹터 수 (= 앵커 탐색 횟수) */
const SECTORS = 8;
const AVG_SPEED_KMH = 55;
/**
 * 루프 총 주행거리 ≈ 반경 × 이 계수.
 * (반경 왕복 2R + 앵커 간 이동 ~1.4R) × 도로 우회율 ~1.25
 */
const LOOP_DISTANCE_FACTOR = 4.3;
const MIN_RADIUS_M = 15_000;
const MAX_RADIUS_M = 110_000;
/** 앵커는 투영점 주변 이 반경 안의 장소에서 고른다 */
const ANCHOR_SEARCH_RADIUS_M = 15_000;
const MAX_CANDIDATES = 5;
/** 예산 허용 오차 — 이 안에 들면 "예산에 맞는" 코스로 본다 */
const BUDGET_TOLERANCE_SEC = 1800;
/** 산 정상 등 도로가 안 닿는 앵커 대비, 한 루프당 라우팅 재시도 상한 */
const MAX_ROUTE_ATTEMPTS = 4;
/**
 * 카카오 실측 검증 게이트 — 경로 교차로 밀도가 이 미만(교외·시골)이면
 * 보정된 로컬 추정(실측 대비 ±9%, time-calib 피팅)을 신뢰하고 검증을
 * 생략한다. 도심 비중이 큰 경로만 실측 — 낮 시간대 정체는 hourProfile이
 * 찰 때까지 로컬이 과소평가할 수 있어서다. 보정 표본 기준 경로 전체 평균
 * jpk가 시골 0.5~1.6, 도심 관통 1.8~4 — 1.7이 안정된 분리선 (재피팅으로
 * 변하는 d0와는 별개인 고정 판별 상수).
 */
const KAKAO_VERIFY_JPK = 1.7;

function project(origin: LatLng, bearingDeg: number, distM: number): LatLng {
  const rad = (bearingDeg * Math.PI) / 180;
  return {
    lat: origin.lat + (distM * Math.cos(rad)) / 111_320,
    lng:
      origin.lng +
      (distM * Math.sin(rad)) /
        (111_320 * Math.cos((origin.lat * Math.PI) / 180)),
  };
}

function clampRadius(m: number): number {
  return Math.min(MAX_RADIUS_M, Math.max(MIN_RADIUS_M, m));
}

function bearingOf(origin: LatLng, p: LatLng): number {
  const dx = (p.lng - origin.lng) * Math.cos((origin.lat * Math.PI) / 180);
  const dy = p.lat - origin.lat;
  return Math.atan2(dx, dy);
}

/** 출발지 기준 방위각 순으로 정렬 — 한 방향으로 도는 자연스러운 루프가 된다 */
function orderByBearing(origin: LatLng, places: Place[]): Place[] {
  return [...places].sort(
    (p, q) => bearingOf(origin, p.coord) - bearingOf(origin, q.coord),
  );
}

function straightDistM(a: LatLng, b: LatLng): number {
  const kx = Math.cos((a.lat * Math.PI) / 180) * 111_320;
  return Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * 110_540);
}

/** 직선 거리 기반 루프 소요시간 추정(초) — 고정 경유지의 시간 비용 계산용 */
function estimateLoopSec(origin: LatLng, places: Place[]): number {
  if (places.length === 0) return 0;
  const sorted = orderByBearing(origin, places);
  let straightM = 0;
  let prev = origin;
  for (const p of sorted) {
    straightM += straightDistM(prev, p.coord);
    prev = p.coord;
  }
  straightM += straightDistM(prev, origin);
  return (straightM * 1.3) / ((AVG_SPEED_KMH * 1000) / 3600);
}

/** 섹터별 앵커 후보를 여러 개 확보 (도로가 안 닿는 곳 대비 대체 후보) */
async function findAnchorOptions(
  origin: LatLng,
  radiusM: number,
  types: WaypointType[],
): Promise<Place[][]> {
  return Promise.all(
    Array.from({ length: SECTORS }, async (_, i) => {
      const target = project(origin, (360 / SECTORS) * i, radiusM);
      try {
        const places = await searchAnchors(
          target,
          ANCHOR_SEARCH_RADIUS_M,
          types[i % types.length],
        );
        return places.slice(0, 3);
      } catch {
        return [];
      }
    }),
  );
}

/**
 * 루프 하나의 경유지 슬롯 조합들.
 * 각 슬롯은 후보 리스트 — 첫 후보로 라우팅이 실패하면 다음 후보로 재시도한다.
 */
async function buildSlotSets(
  origin: LatLng,
  radiusM: number,
  opts: LoopOptions,
): Promise<Place[][][]> {
  const endTiming = startLoopStage("generic.anchors");
  try {
  const fixed = (opts.fixed ?? []).slice(0, 3);
  if (fixed.length >= 3) return [fixed.map((f) => [f])];

  const types = opts.waypointTypes?.length
    ? opts.waypointTypes
    : ["관광명소" as const];
  // 8개 방위 섹터 배열을 그대로 유지한다(빈 섹터도 자리 보존). 예전엔 빈
  //   섹터를 먼저 걸러낸 뒤 (i+2)로 짝지어, 섹터–방위가 어긋나 오이도(SW)와
  //   DMZ(N)처럼 정반대(180°) 앵커가 묶여 "갔다가 반대편으로 되돌아오는" 시간
  //   낭비 루프가 나왔다. 원본 인덱스로 방위 간격을 잡아야 자연스러운 루프가 된다.
  const rawSectors = (await findAnchorOptions(origin, radiusM, types)).map(
    (list) => list.filter((p) => !fixed.some((f) => f.name === p.name)),
  );

  const sets: Place[][][] = [];
  const seen = new Set<string>();
  const push = (slots: Place[][]) => {
    if (slots.some((s) => s.length === 0)) return;
    const key = slots
      .map((s) => s[0].name)
      .sort()
      .join("|");
    if (!seen.has(key)) {
      seen.add(key);
      sets.push(slots);
    }
  };

  if (fixed.length === 0) {
    // 방위 2섹터(90°) 떨어진 앵커끼리 묶어 "갈 때 ≠ 올 때"의 둥근 삼각형
    // 루프를 만든다. 부족하면 45°(gap 1, 더 촘촘)로 보충한다. 3섹터(135°)
    // 이상은 쓰지 않는다: 오이도(SW)+DMZ(N)처럼 거의 반대편이라 고속도로로
    // 한참 갔다 반대편으로 되돌아오는 시간 낭비 루프가 된다.
    for (const gap of [2, 1]) {
      for (let i = 0; i < SECTORS; i++) {
        const a = rawSectors[i];
        const b = rawSectors[(i + gap) % SECTORS];
        if (a.length === 0 || b.length === 0 || a[0].name === b[0].name) continue;
        push([a, b]);
      }
      if (sets.length >= 4) break;
    }
    if (sets.length === 0) {
      const only = rawSectors.find((s) => s.length > 0);
      if (only) push([only]);
    }
  } else {
    // 고정 경유지 + 앵커 1개씩 조합해 방향이 다른 루프 변형을 만든다
    if (fixed.length >= 2) push(fixed.map((f) => [f]));
    for (const options of rawSectors) {
      if (options.length === 0) continue;
      push([...fixed.map((f) => [f]), options]);
    }
  }
  return sets.slice(0, SECTORS);
  } finally {
    endTiming?.();
  }
}

async function routeWaypoints(
  origin: LatLng,
  set: Place[],
  opts: LoopOptions,
  label?: string,
  styleTag?: DriveStyle,
): Promise<RouteCandidate | null> {
  const endTiming = startLoopStage("generic.verify");
  loopCount("waypointVerifications");
  try {
  try {
    const routes = await getDirections(origin, origin, "RECOMMEND", {
      waypoints: set.map((p) => p.coord),
      alternatives: false,
      avoid: opts.avoid,
    });
    const route = routes[0];
    if (!route) return null;
    const path = routePath(route);
    return {
      label: label ?? set.map((p) => p.name).join(" – "),
      waypoints: set,
      styleTag,
      durationSec: route.summary.duration,
      distanceM: route.summary.distance,
      tollFare: route.summary.fare.toll,
      fuelCost: estimateFuelCost(route.summary.distance),
      curve: curveMetrics(path),
      path,
      // 실측 검증 응답의 실시간 소통 — '정체 회피' 필터용 (0콜 추가)
      jamRatio: jamRatio(route) ?? undefined,
      routeSource: "kakao",
    };
  } catch {
    return null;
  }
  } finally {
    endTiming?.();
  }
}

/**
 * routeWaypoints의 탐색용 로컬 버전 — 경유지를 로컬 OSM A*로 이어 0 API로
 * 루프 후보를 만든다. 순위 선별 후 최종 후보만 routeWaypoints(카카오)로
 * 실측 검증한다.
 */
async function routeWaypointsLocal(
  origin: LatLng,
  set: Place[],
  opts: LoopOptions,
): Promise<RouteCandidate | null> {
  const endTiming = startLoopStage("generic.localCandidate");
  loopCount("candidatesTried");
  try {
  const path: LatLng[] = [];
  let dur = 0,
    dist = 0,
    toll = 0;
  let usesLocal = false;
  let cur = origin;
  for (const next of [...set.map((p) => p.coord), origin]) {
    const leg = await courseLeg(cur, next, opts.avoid);
    if (!leg) return null;
    path.push(...leg.path);
    dur += leg.dur;
    dist += leg.dist;
    toll += leg.toll;
    usesLocal ||= leg.source === "local-its";
    cur = next;
  }
  return {
    label: set.map((p) => p.name).join(" – "),
    waypoints: set,
    estimated: usesLocal,
    routeSource: usesLocal ? "local-its" : "kakao",
    tollUnknown: usesLocal || undefined,
    durationSec: Math.round(dur),
    distanceM: Math.round(dist),
    tollFare: toll,
    fuelCost: estimateFuelCost(dist),
    curve: curveMetrics(path),
    path,
  };
  } finally {
    endTiming?.();
  }
}

/** 사슬에서 최대 n개를 양 끝 포함 고르게 뽑는다 (출발지에서 먼 순서 유지) */
function samplePlaces(chain: Place[], n: number): Place[] {
  if (chain.length <= n) return chain;
  const out: Place[] = [];
  for (let i = 0; i < n; i++) {
    const p = chain[Math.round((i * (chain.length - 1)) / (n - 1))];
    if (!out.some((q) => q.name === p.name)) out.push(p);
  }
  return out;
}

/** 슬롯 조합 하나를 라우팅 — 실패하면 슬롯별 대체 후보로 재시도 */
async function routeSlotSet(
  origin: LatLng,
  slots: Place[][],
  opts: LoopOptions,
): Promise<RouteCandidate | null> {
  const combos: number[][] = [new Array(slots.length).fill(0)];
  for (let s = 0; s < slots.length; s++) {
    for (let k = 1; k < slots[s].length; k++) {
      const idx = new Array(slots.length).fill(0);
      idx[s] = k;
      combos.push(idx);
    }
  }
  for (const combo of combos.slice(0, MAX_ROUTE_ATTEMPTS)) {
    loopCount("genericCandidatesTried");
    const set = orderByBearing(
      origin,
      combo.map((k, s) => slots[s][k]),
    );
    // 탐색은 로컬 A* — 선별된 최종 후보만 generateLoops 끝에서 카카오 실측
    const candidate = await routeWaypointsLocal(origin, set, opts);
    if (candidate) return candidate;
  }
  return null;
}

async function attemptLoops(
  origin: LatLng,
  radiusM: number,
  opts: LoopOptions,
): Promise<RouteCandidate[]> {
  const endTiming = startLoopStage("generic.attempt", { radiusM });
  try {
  const slotSets = await buildSlotSets(origin, radiusM, opts);
  loopCount("genericRounds");
  loopCount("genericSlotSets", slotSets.length);
  const results = await Promise.all(
    slotSets.map((slots) => routeSlotSet(origin, slots, opts)),
  );
  return results.filter((c): c is RouteCandidate => c !== null);
  } finally {
    endTiming?.();
  }
}

function withinBudget(candidates: RouteCandidate[], budgetSec: number) {
  return candidates.filter(
    (c) => Math.abs(c.durationSec - budgetSec) <= BUDGET_TOLERANCE_SEC,
  );
}

/**
 * 해안 크롤링 — 출발지 근처 해변에서 시작해 20km 반경 검색을 연쇄하며
 * 해안선을 따라 해변 사슬을 만든다. 방향 섹터 투영은 굽은 해안선을
 * 빗나가기 때문에, 실제 해안을 따라가려면 이 방식이 필요하다.
 */
/** 두 방위각의 차이 (랩핑 처리, 0~π) */
function bearingDiff(a: number, b: number): number {
  const d = Math.abs(a - b) % (2 * Math.PI);
  return Math.min(d, 2 * Math.PI - d);
}

async function crawlChain(
  origin: LatLng,
  seed: Place,
  targetM: number,
  type: WaypointType,
): Promise<Place[]> {
  const chain = [seed];
  const visited = new Set([seed.name]);
  /** 홉이 너무 길면 사이 해변을 건너뛰어 바이패스를 타게 되므로 간격 제한 */
  const MAX_HOP_PROGRESS_M = 9_000;
  let current = seed;
  for (let hop = 0; hop < 26; hop++) {
    if (straightDistM(origin, current.coord) >= targetM) break;
    let places: Place[] = [];
    try {
      // 거리순 — 정확도순은 멀리 있는 유명 해변만 나와 사슬이 끊긴다
      places = await searchCoastAnchors(current.coord, 20_000, type, "distance");
    } catch {
      break;
    }
    const currentDist = straightDistM(origin, current.coord);
    // 직전 지점의 방위각 기준 ±60° 연속성 — 사슬이 반대 방향으로 새는 것을 막고,
    // 굽은 해안선도 점진적으로는 따라갈 수 있다
    const headBearing = bearingOf(origin, current.coord);
    const options = places.filter(
      (p) =>
        !visited.has(p.name) &&
        straightDistM(origin, p.coord) > currentDist + 1500 &&
        bearingDiff(bearingOf(origin, p.coord), headBearing) < Math.PI / 3,
    );
    const progress = (p: Place) => straightDistM(origin, p.coord) - currentDist;
    const next =
      options
        .filter((p) => progress(p) <= MAX_HOP_PROGRESS_M)
        .sort((a, b) => progress(b) - progress(a))[0] ??
      options.sort((a, b) => progress(a) - progress(b))[0];
    if (!next) break;
    visited.add(next.name);
    chain.push(next);
    current = next;
  }
  return chain;
}

/**
 * 해안 spine 순환 — 목적지형과 같은 OSM 관통선 엔진을 순환형에 재사용한다.
 * 프리페치 해안점에서 예산 거리대의 회차 후보를 양방향으로 잡고, 관통선을
 * 예산에 맞게 잘라 "갈 때 해안(직접 그리기), 올 때 내륙(카카오)" 루프를 만든다.
 * POI 크롤 방식(해안밀착 27%)을 대체하고, 데이터가 없으면 빈 배열 – 폴백.
 */
const COAST_MPS = 30 / 3.6;
function cutSpineForBudget(
  origin: LatLng,
  spine: LatLng[],
  budgetSec: number,
): LatLng[] {
  const entrySec = straightDistM(origin, spine[0]) / CONNECTOR_SPEED_MPS;
  let cum = 0;
  let cut = spine.length - 1;
  for (let i = 1; i < spine.length; i++) {
    cum += straightDistM(spine[i - 1], spine[i]);
    const total =
      entrySec +
      cum / COAST_MPS +
      straightDistM(spine[i], origin) / CONNECTOR_SPEED_MPS;
    if (total > budgetSec * 0.95) {
      cut = i;
      break;
    }
  }
  return spine.slice(0, Math.max(cut + 1, 15));
}

async function coastalSpineLoops(
  origin: LatLng,
  budgetSec: number,
  opts: LoopOptions,
): Promise<RouteCandidate[]> {
  const endTiming = startLoopStage("style.coastSpine");
  try {
  const pts = getPrefetchedPoints();
  if (pts.length < 100) return [];

  // 가장 가까운 해안까지의 직선거리 — 깊은 내륙(대전 등)도 반드시 해안을
  // 잡게 하는 기준. (Math.min(...39k)은 스택 넘칠 수 있어 루프로 구한다)
  let nearestDist = Infinity;
  for (const p of pts) {
    const d = straightDistM(origin, p);
    if (d < nearestDist) nearestDist = d;
  }

  const outM = Math.min(budgetSec * 0.55 * COAST_MPS * 1.6, 160_000);

  // 최근접 해안이 45km보다 멀면 예산과 무관하게 '단일 해안 n 기준' 분기를
  // 탄다. 대전처럼 서해·남해 사이 중앙 내륙은 origin 주변 링으로 회차점을
  // 잡으면 서해점–남해점이 다른 연결요소라 spine이 0이 됐다(예산이 클수록
  // outM이 커져 이 분기를 못 타는 역설도 있었다). n 기준이면 같은 해안만 잡혀
  // 반드시 이어진다. 해안 근처(서울 28·강릉 2km)는 종전대로 origin 링을 쓴다.
  const deepInland = nearestDist > Math.min(outM * 1.05, 45_000);
  const bySector = new Map<number, { p: LatLng; d: number }>();
  if (deepInland) {
    // 깊은 내륙(대전 등) — 예산대에 해안이 없다. 유저: 왕복 오래 걸려도
    // 무조건 해안을 타게. 최근접 해안점 n을 찾고, n에서 15~45km 떨어진(같은
    // 해안 줄기라 그래프가 이어지는) 점들을 방위별 회차점으로. n에서 먼
    // 회차점(다른 해안=서해 vs 남해)을 잡으면 컴포넌트가 끊겨 spine이 안 난다.
    let n: LatLng | null = null;
    let nd = Infinity;
    for (const p of pts) {
      const d = straightDistM(origin, p);
      if (d < nd) {
        nd = d;
        n = { lat: p.lat, lng: p.lng };
      }
    }
    if (n) {
      for (const p of pts) {
        const dn = straightDistM(n, p);
        if (dn < 15_000 || dn > 45_000) continue;
        // 30°(12섹터)로 잘게 — 해안이 한 방향(서해만)이어도 그 안에서 여러
        // 회차점(다른 지점)을 뽑아 코스가 1개로 쪼그라들지 않게 한다.
        const sec = Math.floor((bearingOf(n, p) + Math.PI) / (Math.PI / 6));
        const cur = bySector.get(sec);
        if (!cur || dn < cur.d) bySector.set(sec, { p: { lat: p.lat, lng: p.lng }, d: dn });
      }
    }
  } else {
    // 해안 근처 — 예산대(왕복이 예산에 맞음)에서 방위 12섹터(30°)별 **가장
    // 가까운** 점을 회차점으로. 6섹터(60°)면 서울처럼 해안이 서/남서 한쪽에만
    // 있는 내륙은 1~2섹터만 차 코스가 1개로 줄었다 — 30°로 쪼개 인천·오이도·
    // 대부도·강화 방면을 각각 뽑는다. 하한 0.33: 더 가까운(짧은 왕복) 해안도
    // 후보에 넣어 예산 맞는 코스 수를 늘린다.
    for (const p of pts) {
      const d = straightDistM(origin, p);
      if (d < outM * 0.4 || d > outM * 1.05) continue;
      const sec = Math.floor((bearingOf(origin, p) + Math.PI) / (Math.PI / 6));
      const cur = bySector.get(sec);
      if (!cur || d < cur.d) bySector.set(sec, { p: { lat: p.lat, lng: p.lng }, d });
    }
  }
  const turnSet: LatLng[] = [...bySector.values()].map((e) => e.p);
  if (turnSet.length === 0) return [];

  // 해안 진입 상한 — 예산 기반이되, 최근접 해안까지는 아무리 멀어도 닿게
  // (깊은 내륙에서도 해안도로를 타려면 진입 연결다리가 길어질 수밖에 없다).
  // 전국 어디서나 서해/남해/동해 중 하나엔 닿도록 170km로 캡.
  const maxEntryM = Math.min(
    Math.max(budgetSec * 0.25 * CONNECTOR_SPEED_MPS, nearestDist + 10_000),
    170_000,
  );

  // 탐색: 로컬 A*(0 API)로 각 회차 후보의 왕복/순환 생성
  const explored: { c: RouteCandidate; cut: LatLng[] }[] = [];
  for (const turn of turnSet) {
    loopCount("coastCandidatesTried");
    loopCount("candidatesTried");
    const spine = coastalSpine(origin, { lat: turn.lat, lng: turn.lng }, maxEntryM);
    if (spine.length < 15) continue;
    const cut = cutSpineForBudget(origin, spine, budgetSec);
    const candidate = await spineDirectRoute(
      origin,
      origin,
      cut,
      styleAvoid("해안도로", opts.avoid),
      "해안도로 순환",
      courseLeg,
      opts.fixed,
    );
    if (candidate) {
      // 방면 표기: 회차점 방위 8방위 + 편도 거리. 방위만으론 서해처럼 해안이
      // 한 방향에 몰린 내륙(서울 등)은 여러 후보가 전부 "서쪽 해안 방면"이 돼
      // 라벨이 겹치고, 라벨 기준 중복 제거에 걸려 코스가 1개로 합쳐졌다.
      // 편도 거리(오이도 40km vs 대부도 65km 등)를 붙여 실제로 다른 코스로 구분한다.
      const brg = ((bearingOf(origin, cut[cut.length - 1]) * 180) / Math.PI + 360) % 360;
      const dir = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"][
        Math.round(brg / 45) % 8
      ];
      const km = Math.round(straightDistM(origin, cut[cut.length - 1]) / 1000);
      candidate.label = `해안도로 순환 · ${dir}쪽 해안 · 편도 ${km}km`;
      explored.push({ c: candidate, cut });
    }
  }
  const byBudget = (a: (typeof explored)[number], b: (typeof explored)[number]) =>
    Math.abs(a.c.durationSec - budgetSec) - Math.abs(b.c.durationSec - budgetSec);
  // 같은 방위+같은 편도거리(라벨 동일)면 사실상 같은 코스 — 하나만 남긴다
  // (예산 근접 우선). 서로 다른 회차점이 거의 겹치는 spine을 만들 때 중복
  // 카드가 뜨는 것을 막는다.
  const byLabel = new Map<string, (typeof explored)[number]>();
  for (const e of [...explored].sort(byBudget)) {
    if (!byLabel.has(e.c.label)) byLabel.set(e.c.label, e);
  }
  const uniq = [...byLabel.values()];
  // 예산 근접 상위 3개를 검증(카카오 콜 3회로 캡) — 예산 안이 1개뿐이어도
  // 다른 방면/거리 해안 코스를 옵션으로 함께 보여준다(유저: 하나만 뜨지 말고
  // 여럿 + 왕복 길어도 해안 타게). 초과 코스는 상위 generateLoops가 예산순
  // 정렬로 아래에 배치하고 API note가 "왕복 길어요" 배너를 붙인다.
  const pool = uniq.sort(byBudget).slice(0, 3);
  // 최종 검증: 도심 비중이 큰 경로(진입/복귀가 시내 관통)만 카카오 실측
  // 연결다리로 재라우팅. 교외·시골 경로는 보정된 로컬 추정을 그대로 신뢰
  // (time-calib 피팅 ±9%) — 카카오 콜 절약. 실패 시 로컬 추정 유지.
  const out = await Promise.all(
    pool.map(async (e) => {
      if (pathJuncPerKm(e.c.path) < KAKAO_VERIFY_JPK)
        return { ...e.c, estimated: true };
      const real = await spineDirectRoute(
        origin,
        origin,
        e.cut,
        styleAvoid("해안도로", opts.avoid),
        e.c.label,
        undefined,
        opts.fixed,
      );
      if (real) {
        real.label = e.c.label;
        return real;
      }
      return { ...e.c, estimated: true };
    }),
  );
  return out;
  } finally {
    endTiming?.();
  }
}

/** 해안 사슬 기반 "해안도로 위주" 루프 — 양쪽 해안 방향으로 최대 2개 */
async function coastalLoops(
  origin: LatLng,
  budgetSec: number,
  type: WaypointType,
  opts: LoopOptions,
): Promise<RouteCandidate[]> {
  const endTiming = startLoopStage("style.coastFallback");
  try {
  // 왕복 + 도로 우회율을 감안한 편도 목표 거리
  const oneWayM = Math.min(
    ((budgetSec * AVG_SPEED_KMH * 1000) / 3600) / 2.5,
    200_000,
  );

  // 시드는 "가장 가까운" 해변 — 유명한 곳(정확도순)으로 시작하면
  // 출발지~시드 사이 해안이 통째로 비어 바이패스를 타게 된다
  let seeds: Place[] = [];
  try {
    seeds = await searchCoastAnchors(origin, 20_000, type, "distance");
  } catch {
    return [];
  }
  if (seeds.length === 0) return [];

  // 방위각이 가장 크게 벌어지는 시드 2개 = 해안의 양쪽 방향
  const first = seeds[0];
  const firstBearing = bearingOf(origin, first.coord);
  let second: Place | undefined;
  let bestDiff = Math.PI / 2; // 최소 90°는 벌어져야 반대 방향으로 본다
  for (const p of seeds.slice(1)) {
    const diff = bearingDiff(bearingOf(origin, p.coord), firstBearing);
    if (diff > bestDiff) {
      bestDiff = diff;
      second = p;
    }
  }
  // 근처 시드가 다 같은 방향이면 정반대쪽을 직접 탐사해서 시드를 찾는다
  if (!second) {
    const oppositeDeg = (((firstBearing + Math.PI) * 180) / Math.PI + 360) % 360;
    const probe = project(origin, oppositeDeg, 15_000);
    try {
      const found = (await searchCoastAnchors(probe, 20_000, type, "distance"))[0];
      if (
        found &&
        bearingDiff(bearingOf(origin, found.coord), firstBearing) >= Math.PI / 3
      ) {
        second = found;
      }
    } catch {
      // 반대 방향 시드가 없으면 한 방향 사슬만 쓴다
    }
  }
  const chains = await Promise.all(
    [first, second]
      .filter((s): s is Place => s !== undefined)
      .map((s) => crawlChain(origin, s, oneWayM, type)),
  );

  const out: RouteCandidate[] = [];
  for (const chain of chains) {
    if (chain.length === 0) continue;
    // 경유지가 촘촘해야 해변 사이 구간이 내륙 바이패스로 빠지지 않는다.
    // 5개 제한은 구간 분할 라우팅(routeThrough)으로 넘는다.
    const vias: Place[] = [...(opts.fixed ?? []).slice(0, 2)];
    for (const p of samplePlaces(chain, 12)) {
      if (!vias.some((c) => c.name === p.name)) vias.push(p);
    }
    // 출발지에서 가까운 순 = 해안을 따라 나가는 주행 순서
    vias.sort(
      (a, b) =>
        straightDistM(origin, a.coord) - straightDistM(origin, b.coord),
    );
    loopCount("coastFallbackCandidatesTried");
    loopCount("candidatesTried");
    const candidate = await routeViaSmooth(
      origin,
      origin,
      vias,
      styleAvoid("해안도로", opts.avoid),
      `해안도로 위주 · ${chain[chain.length - 1].name} 방면`,
      "해안도로",
    );
    if (candidate) out.push(candidate);
  }

  // 한 방향만으로 예산이 안 차면(반도 끝·접경 등) 양방향을 이어 왕복 종주를 만든다
  if (
    chains.length === 2 &&
    chains[0].length > 0 &&
    chains[1].length > 0 &&
    out.every((c) => c.durationSec < budgetSec - BUDGET_TOLERANCE_SEC)
  ) {
    const [a, b] = chains;
    const aOut = samplePlaces(a, 4);
    const bBack = samplePlaces(b, 4).reverse();
    const vias = [...aOut, ...bBack].filter(
      (p, i, arr) => arr.findIndex((q) => q.name === p.name) === i,
    );
    loopCount("coastFallbackCandidatesTried");
    loopCount("candidatesTried");
    const combined = await routeViaSmooth(
      origin,
      origin,
      vias,
      styleAvoid("해안도로", opts.avoid),
      `해안도로 위주 · ${a[a.length - 1].name} – ${b[b.length - 1].name} 종주`,
      "해안도로",
    );
    if (combined) out.push(combined);
  }
  return out;
  } finally {
    endTiming?.();
  }
}

/**
 * 와인딩 루프들 — OSM 곡률 데이터에서 뽑은 진짜 고갯길 구간을 중심으로 만든
 * 루프. 랜덤 명소 앵커와 달리 '어떤 길을 달릴지'가 코스의 뼈대가 된다.
 * 예산이 클수록 먼 고개를 골라(targetDist) 루프 시간이 예산에 차게 한다.
 */
const CONNECTOR_SPEED_MPS = 17; // 직선거리 기준 실효 이동 속도 (~61km/h)

/** 구간 루프 테마 — 와인딩과 강변길이 같은 탐색·검증 기계를 공유한다 */
interface SegLoopThemeCfg {
  find: typeof findWindingSegments;
  quality: (s: WindingSegment) => number;
  /** 구간 폴리라인 주행 평균속도 — 와인딩 35km/h, 강변 50km/h */
  segMps: number;
  route: SegLoopTheme;
}
const SEG_LOOP_THEMES = {
  와인딩: {
    find: findWindingSegments,
    quality: segQuality,
    segMps: 35 / 3.6,
    route: {
      segSpeedMps: 35 / 3.6,
      kind: "와인딩",
      styleTag: "와인딩",
      anonName: "무명 고갯길",
    },
  },
  강변: {
    find: findRiversideSegments,
    quality: riversideQuality,
    segMps: 50 / 3.6,
    route: {
      segSpeedMps: 50 / 3.6,
      kind: "강변길",
      styleTag: "강변도로",
      anonName: "무명 강변길",
    },
  },
} satisfies Record<string, SegLoopThemeCfg>;

async function themedSegmentLoops(
  origin: LatLng,
  budgetSec: number,
  opts: LoopOptions,
  count: number,
  themeName: keyof typeof SEG_LOOP_THEMES,
): Promise<RouteCandidate[]> {
  const endTiming = startLoopStage("style.segments", { theme: themeName, budgetSec });
  try {
  const t: SegLoopThemeCfg = SEG_LOOP_THEMES[themeName];
  // 구간 주행 ~25분을 뺀 나머지의 절반이 편도 이동 시간
  const targetDistM = Math.max(
    ((budgetSec - 1500) / 2) * CONNECTOR_SPEED_MPS,
    8000,
  );
  const maxDistM = targetDistM * 1.5 + 20000;
  // 품질 점수가 거리 페널티를 압도해 3시간 예산에 5시간 루프가 1등으로
  // 나오는 것을 막는다: 라우팅 전에 시간 추정으로 예산 창 밖을 잘라낸다
  const estSec = (s: WindingSegment) =>
    2 * (straightDistM(origin, segMid(s)) / CONNECTOR_SPEED_MPS) +
    s.lenM / t.segMps;
  // 추정치는 지역에 따라 ±40% 틀린다(산간 내륙은 과소평가). 그래서 창은
  // "예산을 넘지 않을 것 같은 쪽"으로만 크게 열고(0.4~1.0), 품질순으로
  // 여러 개 라우팅해 실측이 결정하게 한다.
  const segs = t.find(origin, maxDistM, targetDistM, 24);
  const pruned = segs.filter((s) => {
    const e = estSec(s);
    // 상한은 최종 실측 필터와 동일(+오차) — 추정이 살짝 높게 나온 우수 후보를
    // 조기 폐기하지 않는다. 탐색이 로컬(0 API)이라 넓혀도 비용이 없다.
    // 하한 0.3: 직선거리 추정은 도심 정체를 모른다 — 강남 2h에서 북악산로가
    // 추정 37분(0.31×)이라 잘렸지만 실측은 100분대다. 밑도는 후보는 어차피
    // 실측 필터(0.5×)와 예산 근접 정렬이 걸러준다.
    return e >= budgetSec * 0.3 && e <= budgetSec + BUDGET_TOLERANCE_SEC;
  });
  // 탐색이 로컬(0 API)이라 넉넉히 라우팅해 실측 필터에 재료를 준다
  const chosen = (pruned.length > 0 ? pruned : segs).slice(
    0,
    Math.max(count + 2, 8),
  );

  // 구간 2개 체이닝 — "미시령으로 넘고 진부령으로 돌아오기"(와인딩),
  // "이 강 따라 갔다가 저 강 따라 돌아오기"(강변). 예산이 넉넉하면
  // 단일 구간은 밑돌기 쉬워, 서로 적당히 떨어진(5~45km) 쌍을 이어본다
  const pairs: WindingSegment[][] = [];
  if (budgetSec >= 9000) {
    const scoredPairs: { p: WindingSegment[]; q: number }[] = [];
    for (let i = 0; i < segs.length; i++) {
      for (let j = i + 1; j < segs.length; j++) {
        const a = segs[i],
          b = segs[j];
        const link = straightDistM(segMid(a), segMid(b));
        if (link < 5000 || link > 45000) continue;
        const e =
          (straightDistM(origin, segMid(a)) +
            link +
            straightDistM(origin, segMid(b))) /
            CONNECTOR_SPEED_MPS +
          (a.lenM + b.lenM) / t.segMps;
        if (e < budgetSec * 0.6 || e > budgetSec * 0.95) continue;
        // 출발지에서 가까운 고개를 먼저 넘는다
        const ordered =
          straightDistM(origin, segMid(a)) <= straightDistM(origin, segMid(b))
            ? [a, b]
            : [b, a];
        scoredPairs.push({ p: ordered, q: t.quality(a) + t.quality(b) });
      }
    }
    scoredPairs.sort((x, y) => y.q - x.q);
    pairs.push(...scoredPairs.slice(0, 2).map((e) => e.p));
  }

  // 가까운 보석 보험: 목표거리 가중치는 먼 명품을 선호하는데, 도심 출발은
  // 실측(정체)이 그 먼 후보들을 전부 예산 밖으로 밀어낼 수 있다. 그때
  // 순차 검증이 잡을 수 있게 근거리 품질 최상 구간을 항상 후보에 끼운다
  // (강남 2h의 북악산로가 이 케이스 — 추정 37분이라 목표거리 기준으론
  // 안 뽑히지만 실측은 100분대로 유일한 예산 내 와인딩이다).
  const near = t
    .find(origin, targetDistM * 0.6, targetDistM * 0.35, 2)
    .filter((s) => !chosen.includes(s));

  // 탐색: 로컬 A*(0 API)로 전부 라우팅
  const attempts: WindingSegment[][] = [
    ...chosen.map((s) => [s]),
    ...near.map((s) => [s]),
    ...pairs,
  ];
  loopCount("segmentCandidatesTried", attempts.length);
  loopCount("candidatesTried", attempts.length);
  loopCount("segmentPairCandidates", pairs.length);
  const routed = (
    await Promise.all(
      attempts.map(async (a) => {
        const c = await windingLoopRoute(origin, a, opts.avoid, courseLeg, t.route, opts.fixed);
        return c ? { c, segs: a } : null;
      }),
    )
  ).filter((e): e is { c: RouteCandidate; segs: WindingSegment[] } => e !== null);
  // 소요시간으로 최종 필터 — 허용 오차 안이 없으면 가장 가까운 1개만
  routed.sort(
    (a, b) =>
      Math.abs(a.c.durationSec - budgetSec) -
      Math.abs(b.c.durationSec - budgetSec),
  );
  // 최종 검증: 카카오 실측(구간 직접 그리기는 유지, 연결다리만 실측으로
  // 교체). 로컬 추정은 도심 정체를 몰라 실측이 +30~40% 길게 나온다 —
  // 2시간 요청에 178분이 1위로 나오던 구멍. 그래서 적응형 보정: 실측을
  // 하나 얻을 때마다 실측/추정 비율을 배우고, 남은 후보의 예산 판정
  // (초과 예측 제외·미달 하한·정렬)을 전부 보정된 추정으로 다시 한다.
  // 강남 2h에서 먼 후보 4개에 검증을 다 쓰고 전멸하는 대신, 첫 초과 실측이
  // "가까운 게 답"임을 알려줘 남한산성로(로컬 48분 – 실측 ~70분)같은
  // 근거리 후보가 살아난다. 검증은 최대 4회로 묶어 쿼터를 지키고, 검증
  // 실패(쿼터 소진 등) 시엔 추정치를 그대로 쓴다. 전부 초과면 가장 덜 넘는
  // 실측 1개는 남긴다 — 클라이언트가 예산 초과를 표시한다.
  const limit = budgetSec + BUDGET_TOLERANCE_SEC;
  // 상한만 사전 필터 — 하한(미달)은 보정 후에야 판단할 수 있다
  const roughPool = routed.filter((e) => e.c.durationSec <= limit);
  const queue = roughPool.length > 0 ? roughPool : routed.slice(0, 1);
  const out: RouteCandidate[] = [];
  let overBest: RouteCandidate | null = null;
  let calib = 1;
  let verifies = 0;
  while (queue.length > 0 && out.length < count) {
    queue.sort(
      (a, b) =>
        Math.abs(a.c.durationSec * calib - budgetSec) -
        Math.abs(b.c.durationSec * calib - budgetSec),
    );
    const e = queue.shift()!;
    const est = e.c.durationSec * calib;
    if (verifies >= 4) {
      // 검증 여력이 없으면 보정된 추정이 예산 창 안일 때만 추정 표시로
      if (est >= budgetSec * 0.5 && est <= limit) {
        out.push({ ...e.c, estimated: true });
      }
      continue;
    }
    // 보정 결과 초과가 예측되면 검증을 낭비하지 않는다 (첫 후보는 사전
    // 필터로 항상 통과하므로 실측 없이 전부 걸러지는 일은 없다)
    if (est > limit) continue;
    // 교외·시골 경로는 보정된 로컬 추정을 신뢰 — 실측(카카오) 생략.
    // 와인딩 루프는 대부분 여기 해당해 검증 여력(4회)을 도심 진입형에 아낀다.
    if (pathJuncPerKm(e.c.path) < KAKAO_VERIFY_JPK) {
      if (est >= budgetSec * 0.4) out.push({ ...e.c, estimated: true });
      continue;
    }
    verifies++;
    loopCount("segmentVerifications");
    const real = await windingLoopRoute(origin, e.segs, opts.avoid, undefined, t.route, opts.fixed);
    if (!real) {
      if (est >= budgetSec * 0.5) out.push({ ...e.c, estimated: true });
      continue;
    }
    calib = Math.min(
      Math.max(real.durationSec / Math.max(e.c.durationSec, 1), 0.8),
      1.6,
    );
    // 예산 초과는 엄격히(+오차), 미달은 관대하게(0.4×) — 짧은 건 유저가
    // 더 달리면 그만이지만 긴 건 계획을 깬다
    if (real.durationSec >= budgetSec * 0.4 && real.durationSec <= limit) {
      out.push(real);
    } else if (
      real.durationSec > limit &&
      (!overBest || real.durationSec < overBest.durationSec)
    ) {
      overBest = real;
    }
  }
  if (out.length === 0 && overBest) out.push(overBest);
  return out;
  } finally {
    endTiming?.();
  }
}

/** 루프 하나의 경로를 따라 스타일 장소를 경유지로 끼워 재탐색한 변형 */
async function styleLoopVariant(
  origin: LatLng,
  base: RouteCandidate,
  variant: (typeof STYLE_VARIANTS)[number],
  opts: LoopOptions,
): Promise<RouteCandidate | null> {
  const endTiming = startLoopStage("style.variant");
  try {
  const styleAnchors = await styleAnchorsAlong(base.path, variant.type, (p) => isRoutableAnchor(p.coord));
  if (styleAnchors.length === 0) return null;

  // 경유지 구성 우선순위: 필수 경유지 – 스타일 앵커 – 기존 앵커 (최대 5개)
  const combined: Place[] = [...(opts.fixed ?? []).slice(0, 3)];
  for (const p of [...styleAnchors, ...(base.waypoints ?? [])]) {
    if (combined.length >= 5) break;
    if (!combined.some((c) => c.name === p.name)) combined.push(p);
  }
  let ordered = orderByBearing(origin, combined);

  // 경유지 조합이 베이스와 같으면 같은 경로가 나오므로 생략
  const baseKey = (base.waypoints ?? [])
    .map((p) => p.name)
    .sort()
    .join("|");
  if (ordered.map((p) => p.name).sort().join("|") === baseKey) return null;

  // 라우팅이 안 되면 스타일 앵커를 하나씩 빼며 재시도.
  // 탐색은 로컬 A*(0 API) — 교외·시골이면 그대로 신뢰하고, 도심 비중이
  // 크면 카카오로 실측한다 (낮 정체는 hourProfile 찰 때까지 실측이 안전).
  for (let attempt = 0; attempt < 3 && ordered.length > 0; attempt++) {
    const local = await routeWaypointsLocal(origin, ordered, opts);
    if (local) {
      if (pathJuncPerKm(local.path) >= KAKAO_VERIFY_JPK) {
        const real = await routeWaypoints(
          origin,
          ordered,
          opts,
          variant.label,
          variant.style,
        );
        if (real) return real;
      }
      return { ...local, label: variant.label, styleTag: variant.style };
    }
    ordered = ordered.filter((_, i) => i !== ordered.length - 1);
  }
  return null;
  } finally {
    endTiming?.();
  }
}

export async function generateLoops(
  origin: LatLng,
  budgetSec: number,
  opts: LoopOptions = {},
): Promise<RouteCandidate[]> {
  const endTiming = startLoopStage("loop.generate", { budgetSec });
  try {
  // 해안도로/강변도로 스타일이면 앵커 종류를 그쪽으로 편향시키되,
  // 해변이 없는 내륙 섹터도 앵커를 잡을 수 있게 관광명소를 폴백으로 섞는다
  const impliedTypes = STYLE_VARIANTS.filter((v) =>
    opts.styles?.includes(v.style),
  ).map((v) => v.type);
  if (impliedTypes.length > 0) {
    const rest = (opts.waypointTypes ?? []).filter(
      (t) => !impliedTypes.includes(t),
    );
    opts = {
      ...opts,
      waypointTypes: [
        ...impliedTypes,
        ...(rest.length > 0 ? rest : ["관광명소" as const]),
      ],
    };
  }

  // 고정 경유지를 도는 데 드는 시간을 뺀 나머지 예산으로 앵커 반경을 잡는다
  const fixedSec = estimateLoopSec(origin, opts.fixed ?? []);
  const effectiveSec = Math.max(budgetSec - fixedSec * 0.5, budgetSec * 0.2);
  const radiusM = clampRadius(
    ((effectiveSec / 3600) * AVG_SPEED_KMH * 1000) / LOOP_DISTANCE_FACTOR,
  );

  // 일반(무스타일) 루프 계산 — attemptLoops×최대 3회 + 정렬. 총 생성시간의
  // 약 절반을 먹는데, 스타일을 고르면 전용 엔진(와인딩·해안·강변) 결과가
  // 이걸 통째로 덮어써 버려진다. 그래서 **폴백이 실제로 필요할 때만** 돌도록
  // 지연·메모이즈한다(스타일 성공 시엔 아예 호출 안 됨 – 새 출발지 ~2배 빠름).
  let genericResult: RouteCandidate[] | null = null;
  const ensureGeneric = async (): Promise<RouteCandidate[]> => {
    if (genericResult) return genericResult;
    let valid = await attemptLoops(origin, radiusM, opts);

    // 코스가 2개 미만이면(투영점이 바다·접경 등) 반경을 줄여 한 번 더 시도한다. 제주는 필터로
    // 우도가 빠지면 짧은 코스 1개만 남아, 0개일 때만 줄이면 섬 안쪽 경유지를 찾지 못했다.
    if (valid.length < 2) {
      const closer = await attemptLoops(origin, clampRadius(radiusM * 0.55), opts);
      const known = new Set(valid.map((c) => c.label));
      valid = [...valid, ...closer.filter((c) => !known.has(c.label))];
    }

    // 예산 안에 드는 루프가 부족하면 실측 소요시간으로 반경을 보정해 한 번 재시도
    // (도심 출발은 평균 속도가 낮아 첫 추정 반경이 과대해지기 쉽다)
    if (withinBudget(valid, budgetSec).length < 2 && valid.length > 0) {
      const durations = valid.map((c) => c.durationSec).sort((a, b) => a - b);
      const median = durations[Math.floor(durations.length / 2)];
      const scaled = clampRadius((radiusM * budgetSec) / median);
      if (Math.abs(scaled - radiusM) / radiusM > 0.15) {
        const retried = await attemptLoops(origin, scaled, opts);
        const known = new Set(valid.map((c) => c.label));
        valid = [...valid, ...retried.filter((c) => !known.has(c.label))];
      }
    }

    // 시간 예산 안에 드는 루프 우선, 부족하면 예산에 가까운 순으로 채운다
    const within = withinBudget(valid, budgetSec);
    const pool = within.length >= 2 ? within : valid;
    genericResult = pool
      .sort(
        (x, y) =>
          Math.abs(x.durationSec - budgetSec) - Math.abs(y.durationSec - budgetSec),
      )
      .slice(0, MAX_CANDIDATES);
    return genericResult;
  };

  // 스타일 전용 엔진 — 고른 스타일만 만든다 (안 고른 스타일이 끼면 선택이
  // 무의미해진다). 각 엔진의 결과를 리스트로 모아뒀다가 라운드로빈으로
  // 섞는다: 중복선택 시 마지막에 처리된 스타일이 상위를 독식하지 않고
  // "와인딩 1위, 해안 1위, 와인딩 2위, …" 순으로 고르게 노출된다.
  const styleLists: RouteCandidate[][] = [];
  const wantsWinding =
    opts.styles?.includes("와인딩") || opts.styles?.includes("산길");
  if (wantsWinding) {
    styleLists.push(await themedSegmentLoops(origin, budgetSec, opts, 3, "와인딩"));
  }

  const targets = STYLE_VARIANTS.filter((v) => opts.styles?.includes(v.style));
  for (const target of targets) {
    if (target.style === "해안도로") {
      // 1순위: OSM 해안 관통선 순환(목적지형과 같은 엔진). 데이터가 없으면
      // 구식 해변 POI 크롤링으로 폴백.
      // 예산 절반도 안 되는 해안 코스는 없는 셈 친다. 진입로 수정으로 경로가 살아나면서
      // 서울 8시간에 66분 코스가 나왔다. 와인딩·강변도 하한 0.5배를 쓴다.
      const longEnough = (list: RouteCandidate[]) =>
        list.filter((c) => c.durationSec >= budgetSec * 0.5);
      let coastal = longEnough(await coastalSpineLoops(origin, budgetSec, opts));
      if (coastal.length === 0) {
        coastal = longEnough(await coastalLoops(origin, budgetSec, target.type, opts));
      }
      if (coastal.length > 0) {
        styleLists.push(coastal);
        continue;
      }
    }
    if (target.style === "강변도로") {
      // 1순위: OSM 강변길 재고 루프(와인딩과 같은 기계). 재고가 안 닿는
      // 지역만 구식 앵커 변형으로 폴백.
      const riverside = await themedSegmentLoops(origin, budgetSec, opts, 3, "강변");
      if (riverside.length > 0) {
        styleLists.push(riverside);
        continue;
      }
    }
    // 폴백(해안 데이터 없음·강변 재고 없음 등): 기존 루프 경로 주변에서
    // 스타일 장소를 찾아 끼운다. 1순위 루프 주변에 없으면 상위 루프 순회.
    // 이 폴백이 도는 지역만 일반 루프가 실제로 필요하다 – 여기서 지연 계산.
    const generic = await ensureGeneric();
    for (const base of generic.slice(0, 3)) {
      const variant = await styleLoopVariant(origin, base, target, opts);
      if (variant && !generic.some((r) => r.label === variant.label)) {
        styleLists.push([variant]);
        break;
      }
    }
  }

  // 직선도로: 전용 재고가 없는 대신 일반 루프를 곡률 낮은 순으로 재정렬 —
  // "시원하게 뻗은 길" 선호를 후보 순서로 반영한다(일반 루프가 필요 – 지연 계산).
  if (opts.styles?.includes("직선도로")) {
    (await ensureGeneric()).sort(
      (a, b) => (a.curve?.degPerKm ?? 999) - (b.curve?.degPerKm ?? 999),
    );
  }

  // 라운드로빈 인터리브
  const mixed: RouteCandidate[] = [];
  for (let i = 0; styleLists.some((l) => i < l.length); i++) {
    for (const list of styleLists) {
      const c = list[i];
      if (c && !mixed.some((m) => m.label === c.label)) mixed.push(c);
    }
  }
  // 스타일을 골랐고 스타일 후보가 하나라도 나왔으면 = 그 스타일 코스만
  //   보여준다. 이 경우 일반 루프는 계산조차 하지 않는다(ensureGeneric 미호출)
  //   — 새 출발지 코스추천이 ~2배 빨라지는 지점. 일반 루프를 섞으면 "해안
  //   골랐는데 왜 내륙 DMZ 찍고 시간 낭비하냐"가 된다(유저). 스타일 후보가
  //   아예 없을 때만(그 지역에 그 스타일 자체가 없음) 일반 루프로 폴백한다.
  let result: RouteCandidate[];
  if (opts.styles?.length && mixed.length > 0) {
    result = [...mixed];
  } else {
    result = [...(await ensureGeneric())];
    for (const c of [...mixed].reverse()) {
      if (!result.some((r) => r.label === c.label)) result.unshift(c);
    }
  }
  // 최종 후보만 카카오 실측 검증 — 탐색은 전부 로컬 추정이었다.
  // 스타일 후보(와인딩/해안)는 각 생성기에서 이미 검증/게이트했고, 여기선
  // 로컬 추정으로 남은 일반 루프 중 **도심 비중이 큰 것만** 실측한다.
  // 교외·시골은 보정된 로컬(±9%)을 신뢰 — 카카오 콜 절약. 실패 시 추정 유지.
  const finalized = await Promise.all(
    result.map(async (c) => {
      if (!c.estimated || c.styleTag || !c.waypoints?.length || c.waypoints.length > 5)
        return c;
      if (pathJuncPerKm(c.path) < KAKAO_VERIFY_JPK) return c;
      const real = await routeWaypoints(origin, c.waypoints, opts, c.label, c.styleTag);
      return real ?? c;
    }),
  );
  // 스타일 요청은 여기서 종결한다. 고른 스타일 코스를 예산 안 우선으로
  //   정렬해 그대로 돌려주되, 예산을 넘는 코스도 버리지 않고 아래 옵션으로
  //   남긴다. 서울 등 내륙에서 해안을 고르면 서해 왕복이 대개 예산을 넘는데
  //   (로컬 추정 199분 – 카카오 실측 265분), 무스타일용 트리밍(초과 2개 캡·
  //   나머지 폐기)에 걸리면 코스가 1개로 쪼그라들었다. 유저: 왕복 길어도
  //   해안 코스 여럿 보여줘, 초과는 배너로 알려주면 됨. 초과 코스가 섞여도
  //   프론트가 예산 안을 위로 올리고 초과엔 '예산 초과' 칩을 붙인다.
  if (opts.styles?.length) {
    const lim = budgetSec + BUDGET_TOLERANCE_SEC;
    return [...finalized]
      .sort((a, b) => {
        const ao = a.durationSec <= lim ? 0 : 1;
        const bo = b.durationSec <= lim ? 0 : 1;
        return (
          ao - bo ||
          Math.abs(a.durationSec - budgetSec) - Math.abs(b.durationSec - budgetSec)
        );
      })
      .slice(0, MAX_CANDIDATES);
  }

  // 실측이 추정을 덮어쓴 뒤의 최종 예산 재검사 — 도심 출발은 실측이 로컬
  // 추정보다 30~40% 길게 나와 여기서 처음 초과가 드러난다(2시간 요청에
  // 178분이 1위로 나오던 구멍). 살짝 넘는 건(허용 오차 2배까지) 뒤로 미뤄
  // 최대 2개만 남기고, 그 이상은 계획을 깨니 버린다. 전부 초과면 예산에
  // 가까운 순으로 2개는 남긴다 — 클라이언트가 예산 초과를 표시한다.
  const limit = budgetSec + BUDGET_TOLERANCE_SEC;
  let inBudget = finalized.filter((c) => c.durationSec <= limit);
  // 폴백이 돌면 살릴, 고른 스타일의 "예산 초과지만 최선" 루프 하나 (유저: 삥
  // 도는 큰 루프도 옵션으로 남겨줘 + 예산 내 대안도 보여줘)
  let styleKeep: RouteCandidate[] = [];

  // 실측이 전부 예산 초과 — 로컬 추정이 도심 정체를 과소평가해 첫 반경이
  // 과대했던 것(대방중 2시간 요청에 3시간 루프만 나오던 구멍: 110km 루프를
  // 55km/h로 봐 120분이라 여겼지만 실측은 167분). 실측 소요/예산 비율로
  // 반경을 줄여(안전계수 0.9로 살짝 밑돌게) 한 번 더 돌리고, 새 후보만
  // 카카오로 검증해 예산 안에 드는 루프를 건진다.
  // 스타일을 고른 요청엔 절대 발동하지 않는다: 해안 골랐는데 도심 공원
  //   루프(수리산·관곡지)를 섞으면 "선택한 스타일만 떠야지" 원칙 위반이다.

  if (inBudget.length === 0 && finalized.length > 0 && !opts.styles?.length) {
    const durs = finalized.map((c) => c.durationSec).sort((a, b) => a - b);
    const realMed = durs[Math.floor(durs.length / 2)];
    const shrunk = clampRadius((radiusM * budgetSec * 0.9) / Math.max(realMed, 1));
    if (shrunk < radiusM * 0.9) {
      // 스타일 앵커 편향을 벗고(해안 편향이면 도심 근처엔 해변이 없어 또
      // 빈손) 일반 명소로 예산 내 대안을 찾는다: 고른 스타일이 예산 안에
      // 물리적으로 불가능할 때(대방중 2h 해안 — 최근접 해안 오이도 30km)라도
      // "그 시간에 갈 만한 코스"는 제시한다. 스타일 전용 루프가 예산에 들었으면
      // inBudget이 안 비어 이 폴백 자체가 안 돈다.
      const retryOpts: LoopOptions = { ...opts, styles: undefined, waypointTypes: undefined };
      const known = new Set(finalized.map((c) => c.label));
      const retry = (await attemptLoops(origin, shrunk, retryOpts))
        .filter((c) => !known.has(c.label))
        .sort(
          (a, b) =>
            Math.abs(a.durationSec - budgetSec) -
            Math.abs(b.durationSec - budgetSec),
        )
        .slice(0, 4);
      const verified = await Promise.all(
        retry.map(async (c) =>
          c.waypoints?.length &&
          c.waypoints.length <= 5 &&
          pathJuncPerKm(c.path) >= KAKAO_VERIFY_JPK
            ? ((await routeWaypoints(origin, c.waypoints, retryOpts, c.label, c.styleTag)) ??
              c)
            : c,
        ),
      );
      const fit = verified
        .filter((c) => c.durationSec <= limit)
        .sort(
          (a, b) =>
            Math.abs(a.durationSec - budgetSec) -
            Math.abs(b.durationSec - budgetSec),
        );
      if (fit.length > 0) {
        // 예산 초과 루프 중 예산에 가장 가까운(제일 덜 도는) 1개는 "예산 초과"
        // 표시로 남긴다 — 유저: 삥 도는 큰 루프도 옵션이고, 2시간이면 아래
        // 대안들. (이 시점 finalized는 전부 초과라 정렬 첫 개가 최선.)
        const big = [...finalized].sort((a, b) => a.durationSec - b.durationSec)[0];
        if (big) styleKeep = [big];
        finalized.push(...fit);
        inBudget = fit;
      }
    }
  }

  if (inBudget.length === 0) {
    return finalized
      .sort(
        (a, b) =>
          Math.abs(a.durationSec - budgetSec) - Math.abs(b.durationSec - budgetSec),
      )
      .slice(0, 2);
  }
  const slightlyOver = finalized
    .filter(
      (c) =>
        c.durationSec > limit &&
        c.durationSec <= budgetSec + 2 * BUDGET_TOLERANCE_SEC,
    )
    .sort((a, b) => a.durationSec - b.durationSec)
    .slice(0, 2);
  const merged = [...inBudget, ...slightlyOver, ...styleKeep];
  return merged.filter(
    (c, i) => merged.findIndex((m) => m.label === c.label) === i,
  );
  } finally {
    endTiming?.();
  }
}
