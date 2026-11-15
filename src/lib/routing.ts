import "server-only";

import { loopCount, startLoopStage } from "@/lib/loop-timing";

import { coastalSpine } from "@/lib/coastgraph";
import { getDirections, routePath } from "@/lib/kakao";
import { isMilitaryAnchor, isRoutableAnchor, localLeg, type LocalLeg } from "@/lib/localroute";
import { fetchCoastalRoadPoints } from "@/lib/osm";
import { segSceneryTags, type WindingSegment } from "@/lib/winding";
import { searchByType } from "@/lib/places";
import { estimateFuelCost } from "@/lib/scoring/cost";
import { curveMetrics, distanceM } from "@/lib/scoring/curvature";
import type {
  AvoidOption,
  DriveStyle,
  LatLng,
  Place,
  RouteCandidate,
  WaypointType,
} from "@/lib/types";

/**
 * 경유지를 독립 구간으로 나눠 이어붙인다. 각 구간은 로컬 노드링크+ITS를
 * 우선하고 그래프 연결 실패 때만 카카오로 폴백한다.
 * 순환형은 destination에 origin을 넘기면 된다.
 */
async function routeViaKakaoRaw(
  origin: LatLng,
  destination: LatLng,
  vias: Place[],
  avoid: AvoidOption[] | undefined,
  label: string,
  styleTag?: DriveStyle,
): Promise<{ candidate: RouteCandidate; legDistM: number[] } | null> {
  const chunks: Place[][] = [];
  for (let i = 0; i < vias.length; i += 4) chunks.push(vias.slice(i, i + 4));
  const requests = chunks.map((chunk) => ({
    destination: chunk[chunk.length - 1].coord,
    waypoints: chunk.slice(0, -1).map((place) => place.coord),
  }));
  requests.push({ destination, waypoints: [] });
  let start = origin;
  const fullPath: LatLng[] = [];
  const legDistM: number[] = [];
  let durationSec = 0, totalDistM = 0, tollFare = 0;
  for (const request of requests) {
    const route = (await getDirections(start, request.destination, "RECOMMEND", {
      waypoints: request.waypoints,
      alternatives: false,
      avoid,
    }))[0];
    if (!route) return null;
    durationSec += route.summary.duration;
    totalDistM += route.summary.distance;
    tollFare += route.summary.fare.toll;
    for (const point of routePath(route)) {
      const last = fullPath[fullPath.length - 1];
      if (!last || distanceM(last, point) > 0.2) fullPath.push(point);
    }
    for (const section of route.sections) legDistM.push(section.distance ?? 0);
    start = request.destination;
  }
  return {
    candidate: {
      label,
      waypoints: vias,
      styleTag,
      durationSec,
      distanceM: totalDistM,
      tollFare,
      fuelCost: estimateFuelCost(totalDistM),
      curve: curveMetrics(fullPath),
      path: fullPath,
      routeSource: "kakao",
    },
    legDistM,
  };
}

async function routeViaRaw(
  origin: LatLng,
  destination: LatLng,
  vias: Place[],
  avoid: AvoidOption[] | undefined,
  label: string,
  styleTag?: DriveStyle,
): Promise<{ candidate: RouteCandidate; legDistM: number[] } | null> {
  try {
    // 유료도로 회피는 로컬 데이터로 보장할 수 없으므로 카카오에 맡긴다.
    if (avoid?.includes("toll")) {
      return await routeViaKakaoRaw(origin, destination, vias, avoid, label, styleTag);
    }
    const stops = [origin, ...vias.map((place) => place.coord), destination];
    const legs = stops.slice(0, -1).map((start, i) =>
      localLeg(start, stops[i + 1], { avoidMotorway: avoid?.includes("motorway") }),
    );
    // 일부 구간마다 카카오를 따로 호출하면 경유지가 많은 코스에서 호출 폭탄이
    // 된다. 하나라도 로컬 연결에 실패하면 전체를 카카오의 4개 청크로 폴백한다.
    if (legs.some((leg) => leg === null)) {
      return await routeViaKakaoRaw(origin, destination, vias, avoid, label, styleTag);
    }
    const routed = legs as LocalLeg[];
    const fullPath: LatLng[] = [];
    const legDistM = routed.map((leg) => leg.dist);
    let durationSec = 0;
    let totalDistM = 0;
    let tollFare = 0;
    for (const leg of routed) {
      durationSec += leg.dur;
      totalDistM += leg.dist;
      tollFare += leg.toll;
      for (const point of leg.path) {
        const last = fullPath[fullPath.length - 1];
        if (!last || distanceM(last, point) > 0.2) fullPath.push(point);
      }
    }
    return {
      candidate: {
        label,
        waypoints: vias,
        styleTag,
        durationSec,
        distanceM: totalDistM,
        tollFare,
        fuelCost: estimateFuelCost(totalDistM),
        curve: curveMetrics(fullPath),
        path: fullPath,
        estimated: true,
        routeSource: "local-its",
        tollUnknown: true,
      },
      legDistM,
    };
  } catch {
    return null;
  }
}

export async function routeVia(
  origin: LatLng,
  destination: LatLng,
  vias: Place[],
  avoid: AvoidOption[] | undefined,
  label: string,
  styleTag?: DriveStyle,
): Promise<RouteCandidate | null> {
  const res = await routeViaRaw(origin, destination, vias, avoid, label, styleTag);
  return res?.candidate ?? null;
}

/** 되짚기(스퍼)로 볼 최소 도로거리 — 이보다 짧은 우회는 그냥 둔다 */
const SPUR_ROAD_MIN_M = 2500;
/** 그 구간의 양 끝(직선)이 이보다 가까우면 "제자리로 돌아온" 되짚기 */
const SPUR_CHORD_MAX_M = 900;
/**
 * 이보다 도로거리가 긴 구간은 이 방식의 대상이 아니다.
 * (순환형은 출발지로 되돌아오므로, 창이 너무 크면 루프 전체를 스퍼로 오인한다)
 */
const SPUR_ROAD_MAX_M = 7000;
/** 왕복 두 다리가 이보다 가까이 지나면 "같은 길을 되밟았다"고 본다 */
const SPUR_OVERLAP_M = 220;
/** 나가는 다리의 이 비율 이상이 돌아오는 다리와 겹치면 진짜 되짚기 */
const SPUR_OVERLAP_RATIO = 0.4;

/**
 * i–tip(나감)과 tip–j(돌아옴)가 같은 길을 되밟는지.
 * 되짚기(막다른 진입로 왕복)는 두 다리가 겹치지만, 만(灣)을 감아 도는
 * 정상 해안도로는 양쪽 다리가 만을 사이에 두고 떨어져 있어 안 겹친다.
 */
function foldbackRatio(path: LatLng[], i: number, tip: number, j: number): number {
  let count = 0;
  let overlap = 0;
  for (let a = i; a < tip; a += 3) {
    count++;
    for (let b = tip + 1; b <= j; b += 3) {
      if (distanceM(path[a], path[b]) < SPUR_OVERLAP_M) {
        overlap++;
        break;
      }
    }
  }
  return count > 0 ? overlap / count : 0;
}
function isFoldback(path: LatLng[], i: number, tip: number, j: number): boolean {
  return foldbackRatio(path, i, tip, j) >= SPUR_OVERLAP_RATIO;
}

/**
 * 경로에서 가장 심한 되짚기(스퍼)의 꼭짓점 인덱스를 찾는다. 없으면 -1.
 * 1) 짧은 직선거리(현)를 큰 도로거리(호)로 잇는 구간 = 나갔다 돌아온 후보
 * 2) 그 왕복 두 다리가 같은 길을 되밟아야 진짜 스퍼 (만 도로 오검출 방지)
 * localLoopScore(고정 반경 이웃)와 달리 통과 진행에 얹힌 국소 U턴도 잡는다.
 */
function worstSpurTip(path: LatLng[], requireFoldback = true): number {
  if (path.length < 3) return -1;
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + distanceM(path[i - 1], path[i]));
  }
  const STEP = 4;
  let bestRoad = SPUR_ROAD_MIN_M;
  let bestTip = -1;
  for (let i = 0; i < path.length; i += STEP) {
    for (let j = i + STEP; j < path.length; j += STEP) {
      const road = cum[j] - cum[i];
      if (road > SPUR_ROAD_MAX_M) break; // 창을 넘으면 더 볼 필요 없다
      if (road <= bestRoad) continue;
      if (distanceM(path[i], path[j]) > SPUR_CHORD_MAX_M) continue;
      // 꼭짓점 = i에서 직선거리가 가장 먼 점 (되짚기의 반환 지점)
      let tipD = -1;
      let tip = i;
      for (let k = i; k <= j; k++) {
        const d = distanceM(path[i], path[k]);
        if (d > tipD) {
          tipD = d;
          tip = k;
        }
      }
      // requireFoldback=false면 현(chord)이 짧게 되돌아온 것만으로 루프로 본다.
      // 해안의 만(灣)·항만 루프(다른 길로 돌아와 겹침이 없어도)를 잡기 위함.
      // 현이 짧다(≤900m) = 제자리로 돌아옴이라, 감아 지나가는 큰 만은 안 걸린다.
      if (requireFoldback && !isFoldback(path, i, tip, j)) continue;
      bestRoad = road;
      bestTip = tip;
    }
  }
  return bestTip;
}

/**
 * routeVia + 스퍼 제거: 막다른 진입로/도로에서 벗어난 POI 경유지 때문에
 * 경로가 갔다가 되돌아 나오면, 그 경유지를 빼고 재탐색한다 (최대 6회).
 * "그 길을 지나가는" 경로를 만드는 게 목적이지 "그 지점에 들르는" 게 아니다.
 */
export async function routeViaSmooth(
  origin: LatLng,
  destination: LatLng,
  vias: Place[],
  avoid: AvoidOption[] | undefined,
  label: string,
  styleTag?: DriveStyle,
  /** 해안: 만·항만 루프까지 지우려면 되짚기 조건 없이 현(chord) 기준으로만 판단 */
  aggressiveSpur = false,
): Promise<RouteCandidate | null> {
  const endTiming = startLoopStage("routing.smooth");
  try {
  let current = vias;
  let best: RouteCandidate | null = null;
  const maxAttempts = aggressiveSpur ? 18 : 6;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    loopCount("smoothingAttempts");
    const res = await routeViaRaw(origin, destination, current, avoid, label, styleTag);
    if (!res) return best;
    best = res.candidate;
    // 경유지가 1개 남을 때까지 스퍼 제거를 계속한다. 2개에서 멈추면
    // 마지막 경유지가 만드는 되짚기(예: 도로에서 벗어난 해변 마커)를 못 고친다.
    if (current.length <= 1) return best;

    const tip = worstSpurTip(res.candidate.path, !aggressiveSpur);
    if (tip === -1) return best;

    // 되짚기를 유발한(꼭짓점에 가장 가까운) 경유지를 제거하고 재시도
    const spurTip = res.candidate.path[tip];
    let worstIdx = -1;
    let nearestD = 5000;
    current.forEach((v, i) => {
      const d = distanceM(v.coord, spurTip);
      if (d < nearestD) {
        nearestD = d;
        worstIdx = i;
      }
    });
    if (worstIdx === -1) return best; // 경유지와 무관한 되짚기 — 제거로는 못 고침
    current = current.filter((_, i) => i !== worstIdx);
  }
  return best;
  } finally {
    endTiming?.();
  }
}

/** 사슬에서 최대 n개를 양 끝 포함 고르게 뽑는다 (순서 유지) */
export function samplePlaces(chain: Place[], n: number): Place[] {
  if (chain.length <= n) return chain;
  const out: Place[] = [];
  for (let i = 0; i < n; i++) {
    const p = chain[Math.round((i * (chain.length - 1)) / (n - 1))];
    if (!out.some((q) => q.name === p.name)) out.push(p);
  }
  return out;
}

/**
 * 출발지 근처 해변에서 목적지 방향으로 해안선을 따라 해변 사슬을 만든다.
 * (목적지형용 해안 크롤링 — 기준 경로가 내륙이면 회랑 검색으로는 해변을 못 찾는다)
 */
export async function crawlCoastToward(
  origin: LatLng,
  destination: LatLng,
  type: WaypointType,
): Promise<Place[]> {
  /**
   * 홉이 너무 길면 사이 해변(심곡·금진 헌화로 같은 구간)을 건너뛰어
   * 내륙 고개로 질러가게 된다. 매 홉 '가장 가까운 전진 해변'을 골라 촘촘히
   * 이어야 앵커 사이를 카카오가 내륙으로 질러가지 못한다. 좁은 홉을 많이
   * 밟기 위해 홉 상한도 크게 잡는다(사슬이 촘촘할수록 실제 해안을 탄다).
   */
  const MAX_HOP_PROGRESS_M = 3_500;
  const MIN_HOP_PROGRESS_M = 700;

  let seeds: Place[] = [];
  try {
    seeds = await searchCoastAnchors(origin, 20_000, type, "distance");
  } catch {
    return [];
  }
  if (seeds.length === 0) return [];
  // 씨앗은 '출발지 근처면서 목적지 길목'인 해변으로 — 최근접만 쓰면 강 하구
  // 반대편(북쪽)에서 시작해 루프가 생긴다(강릉 송정–안목). origin–p–dest 최소화.
  const seed = seeds.reduce((best, p) => {
    const c = distanceM(origin, p.coord) + distanceM(p.coord, destination);
    const cb = distanceM(origin, best.coord) + distanceM(best.coord, destination);
    return c < cb ? p : best;
  }, seeds[0]);

  const chain = [seed];
  const visited = new Set([seed.name]);
  let current = seed;
  for (let hop = 0; hop < 50; hop++) {
    const curToDest = distanceM(current.coord, destination);
    if (curToDest < 6_000) break;
    let places: Place[] = [];
    try {
      places = await searchCoastAnchors(current.coord, 15_000, type, "distance");
    } catch {
      break;
    }
    const progress = (p: Place) => curToDest - distanceM(p.coord, destination);
    const options = places.filter(
      (p) => !visited.has(p.name) && progress(p) > MIN_HOP_PROGRESS_M,
    );
    // 가장 가까운 전진 해변(작은 홉)을 우선 — 사이 해변을 건너뛰지 않는다.
    // 좁은 홉 범위에 후보가 없을 때만 더 먼 해변으로 점프해 사슬을 잇는다.
    const next =
      options
        .filter((p) => progress(p) <= MAX_HOP_PROGRESS_M)
        .sort((a, b) => progress(a) - progress(b))[0] ??
      options.sort((a, b) => progress(a) - progress(b))[0];
    if (!next) break;
    visited.add(next.name);
    chain.push(next);
    current = next;
  }
  return chain;
}

/**
 * 해안도로 정점들을 목적지 방향으로 정렬해 사슬을 만든다.
 * 출발지에서 가장 가까운 정점에서 시작해, 매번 '전진하는 가장 가까운 정점'으로
 * 이어간다(만灣을 따라 도로를 그대로 따라감 — 물을 가로질러 점프하지 않는다).
 * 2km 안에 전진 정점이 없으면 더 먼 전진 정점으로 다리를 놓아 도로 끊긴
 * 구간(해안도로 없는 항만·산단 등)을 건넌다. API 호출 없이 로컬 계산.
 */
function orderCoastalRoad(
  origin: LatLng,
  destination: LatLng,
  pts: LatLng[],
): Place[] {
  if (pts.length < 2) return [];
  // 시작 정점: 출발지 근처(12km)면서 '목적지로 가는 길목'인 정점을 고른다.
  // 최근접만 쓰면 강 하구 반대편(북쪽)에서 시작해 다리로 넘어오며 루프가
  // 생긴다(강릉 송정–안목). origin–v–dest 합을 최소화하면 전진쪽 진입부가 잡힘.
  let startIdx = 0;
  let startCost = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dO = distanceM(pts[i], origin);
    if (dO > 12000) continue;
    const cost = dO + distanceM(pts[i], destination);
    if (cost < startCost) {
      startCost = cost;
      startIdx = i;
    }
  }
  // 12km 안에 해안 정점이 없으면 그냥 최근접에서 시작
  if (startCost === Infinity) {
    let d = Infinity;
    pts.forEach((p, i) => {
      const dd = distanceM(p, origin);
      if (dd < d) {
        d = dd;
        startIdx = i;
      }
    });
  }
  const used = new Array<boolean>(pts.length).fill(false);
  const order = [startIdx];
  used[startIdx] = true;
  let cur = pts[startIdx];
  const NEAR_WINDOW_M = 2000;
  while (order.length < 500) {
    const curToDest = distanceM(cur, destination);
    if (curToDest < 3000) break;
    let best = -1;
    let bestDist = Infinity;
    // 1) 2km 이내 전진 정점 중 가장 가까운 것 (도로를 그대로 따라감)
    for (let i = 0; i < pts.length; i++) {
      if (used[i]) continue;
      if (curToDest - distanceM(pts[i], destination) <= 0) continue;
      const d = distanceM(cur, pts[i]);
      if (d > NEAR_WINDOW_M) continue;
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    // 2) 없으면(도로 끊김) 전진 정점 중 가장 가까운 것으로 다리를 놓는다
    if (best < 0) {
      for (let i = 0; i < pts.length; i++) {
        if (used[i]) continue;
        if (curToDest - distanceM(pts[i], destination) <= 0) continue;
        const d = distanceM(cur, pts[i]);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      }
    }
    if (best < 0) break;
    used[best] = true;
    order.push(best);
    cur = pts[best];
  }
  return order.map((i, k) => ({ name: `해안${k}`, address: "", coord: pts[i] }));
}

/**
 * 목적지형 해안 사슬을 만든다. 우선 OSM 해안도로(도로 선형)를 뽑아 정렬해
 * 그 위를 타게 하고(진짜 해안도로, 해변 왕복 없음), OSM 실패/부족 시 해변
 * 사슬을 바다쪽 도로로 스냅한 것으로 폴백한다.
 */
export async function buildCoastalChain(
  origin: LatLng,
  destination: LatLng,
  beachChain: Place[],
): Promise<{ chain: Place[]; roadLinear: boolean }> {
  // 1) 프리페치 그래프에서 해안 관통선(Dijkstra) — 항만·지선·7번국도 없이
  //    관통 해안도로만. 관통선 위 정점이라 촘촘히 박아도 detour가 없다.
  const spine = coastalSpine(origin, destination);
  if (spine.length >= 3) {
    const chain = spine.map((c, i) => ({
      name: `해안${i}`,
      address: "",
      coord: c,
    }));
    return { chain, roadLinear: true };
  }

  // 2) 데이터 미수록 지역 — 라이브 Overpass 점 + 그리디 정렬로 폴백
  if (beachChain.length >= 1) {
    try {
      const pts = await fetchCoastalRoadPoints(beachChain.map((p) => p.coord));
      const ordered = orderCoastalRoad(origin, destination, pts);
      if (ordered.length >= 3) return { chain: ordered, roadLinear: true };
    } catch {
      // Overpass 실패 — 2차 호출 없이 해변 사슬 폴백
    }
  }
  // 3) 해변 사슬 폴백(도로 위 정점 아님 – roadLinear=false)
  return { chain: beachChain, roadLinear: false };
}

/**
 * 해안 사슬을 "시간 상한(maxDurationSec) 안에서 최대한 해안을 타는" 경로로
 * 만든다. 강제 경유지가 많을수록 실제 해안을 촘촘히 타지만 우회도 길어지므로,
 * 경유지 수를 큰 값부터 줄여가며 상한을 만족하는 가장 촘촘한 후보를 채택한다.
 * (maxDurationSec = Infinity면 첫 시도에서 바로 통과 = 최대 강도)
 * "이내"는 하드 캡이라, 상한에 드는 후보가 하나도 없으면 null을 반환한다
 * (가장 성긴 해안 후보조차 상한을 넘으면 그 OD엔 "살짝 해안"이 불가능).
 */
export async function coastalRouteWithinBudget(
  origin: LatLng,
  destination: LatLng,
  chain: Place[],
  avoid: AvoidOption[] | undefined,
  label: string,
  maxDurationSec: number,
  /** 도로 선형 사슬이면 만·항만 루프까지 적극 제거. 해변 폴백은 false(과제거 방지) */
  aggressiveSpur = false,
): Promise<RouteCandidate | null> {
  // 해안도로에 붙잡아 두려면 ~1km 간격 앵커가 필요(성기면 7번국도로 질러감).
  // 관통선(coastalSpine)은 항만·지선이 제거돼 있어 촘촘히 박아도 detour가
  // 없다. 경로 길이에 비례해 40~90개(카카오 콜은 90에서 캡).
  let chainLenM = 0;
  for (let i = 1; i < chain.length; i++) {
    chainLenM += distanceM(chain[i - 1].coord, chain[i].coord);
  }
  const dense = Math.max(40, Math.min(Math.round(chainLenM / 1000), 90));
  const top = Math.min(chain.length, dense);
  const rungs = [top, 40, 28, 18, 12, 8, 5, 3, 2].filter(
    (n) => n >= 2 && n <= chain.length,
  );
  const ladder = [...new Set(rungs)].sort((a, b) => b - a);
  if (ladder.length === 0) ladder.push(chain.length);
  for (const n of ladder) {
    const candidate = await routeViaSmooth(
      origin,
      destination,
      samplePlaces(chain, n),
      styleAvoid("해안도로", avoid ?? []),
      label,
      "해안도로",
      aggressiveSpur,
    );
    if (!candidate) continue;
    // 사다리가 내림차순 – 상한을 만족하는 첫 후보 = 상한 내 가장 촘촘한 해안
    if (candidate.durationSec <= maxDurationSec) return candidate;
  }
  return null;
}

/** 해안 소도로 평균 속도 추정(km/h–m/s) — spine 직접 구간의 소요시간 산정용 */
const COASTAL_SPEED_MPS = 30 / 3.6;
/** spine 점 사이가 이보다 멀면 데이터 gap(항만배후·터널 등) — 카카오로 잇는다 */
const SPINE_GAP_M = 300;

/**
 * 경로에서 '왔던 길 되돌아오기'(막다른 곶·진입로 왕복)를 잘라낸다.
 * path[j]가 path[i]의 RETURN_M 이내로 되돌아오고 그 사이 도로거리가 의미있게
 * 길면(왕복), i..j 사이를 제거해 i–j로 직결한다(썬크루즈 곶 왕복 등 제거).
 */
function trimBacktracks(path: LatLng[]): LatLng[] {
  const RETURN_M = 180;
  const MIN_EXCURSION = 500;
  const MAX_EXCURSION = 6000;
  const out: LatLng[] = [];
  let i = 0;
  while (i < path.length) {
    out.push(path[i]);
    let jump = -1;
    let road = 0;
    for (let j = i + 1; j < path.length; j++) {
      road += distanceM(path[j - 1], path[j]);
      if (road > MAX_EXCURSION) break;
      if (road >= MIN_EXCURSION && distanceM(path[i], path[j]) <= RETURN_M) {
        jump = j; // path[i] 근처로 되돌아옴 – 그 사이(왕복) 스킵
      }
    }
    i = jump >= 0 ? jump + 1 : i + 1;
  }
  return out;
}

function pathLen(path: LatLng[]): number {
  let s = 0;
  for (let k = 1; k < path.length; k++) s += distanceM(path[k - 1], path[k]);
  return s;
}

export interface Leg {
  path: LatLng[];
  dur: number;
  dist: number;
  toll: number;
  source?: "local-its" | "kakao";
}
export type LegFn = (
  from: LatLng,
  to: LatLng,
  avoid: AvoidOption[] | undefined,
) => Promise<Leg | null>;

/**
 * 탐색용 연결다리: 로컬 OSM A* 우선(0 API), 그래프 밖이면 카카오 폴백.
 * 후보 "탐색"은 전부 이걸 쓰고, 사용자에게 보여줄 최종 후보만 kakaoLeg로
 * 실측 검증한다 — 쿼터 소진의 주범(탐색 30~50콜)을 몇 콜로 줄인다.
 *
 * 코스추천은 같은 앵커쌍 구간을 콤보·반경 재시도마다 반복 라우팅한다. 로컬 A*는
 * 결정론적(그래프+ITS 캐시)이라 (from,to,avoid) 키로 180초 캐싱해 중복 계산을
 * 없앤다 — 결과는 동일하고 탐색이 크게 빨라진다(실측 코스추천 A* 10초–대폭).
 */
const legCache = new Map<string, { leg: Leg | null; ts: number }>();
const LEG_TTL_MS = 180_000;
const legKey = (from: LatLng, to: LatLng, avoid: AvoidOption[] | undefined) =>
  `${from.lat.toFixed(5)},${from.lng.toFixed(5)}|${to.lat.toFixed(5)},${to.lng.toFixed(5)}|${(avoid ?? []).join(",")}`;

const makeLocalLeg = (explore: boolean): LegFn => async (from, to, avoid) => {
  const key = `${explore ? "course" : "route"}|${legKey(from, to, avoid)}`;
  const hit = legCache.get(key);
  if (hit && Date.now() - hit.ts < LEG_TTL_MS) {
    loopCount("legCacheHit");
    return hit.leg;
  }
  loopCount("legCacheMiss");
  // 로컬 데이터에는 유료구간 속성이 없으므로 무료도로 제약만큼은 카카오가
  // 직접 보장한다. 고속도로 회피는 표준노드링크 도로등급으로 로컬 처리한다.
  const local = avoid?.includes("toll")
    ? null
    : localLeg(from, to, {
        avoidMotorway: avoid?.includes("motorway"),
        ...(explore ? { explore: true } : {}),
      });
  const leg = local
    ? { ...local, source: "local-its" as const }
    : await kakaoLeg(from, to, avoid);
  loopCount(local ? "localLegSuccess" : "kakaoFallbackLegs");
  if (legCache.size > 3000) legCache.clear();
  legCache.set(key, { leg, ts: Date.now() });
  return leg;
};
export const exploreLeg = makeLocalLeg(false);
/** 코스 추천 후보 탐색 전용. 앱 내비가 쓰는 /api/local-route는 exploreLeg를 그대로 쓴다. */
export const courseLeg = makeLocalLeg(true);

/**
 * 해안 사슬용 검색 — 군사 구역만 뺀다. 사슬은 해변을 차례로 잇는 길잡이라, 도로에서 먼 해변까지
 * 빼면 사슬이 일찍 끊겨 6시간 요청에 46분 코스가 나왔다(인천).
 */
export async function searchCoastAnchors(
  ...args: Parameters<typeof searchByType>
): Promise<Awaited<ReturnType<typeof searchByType>>> {
  return (await searchByType(...args)).filter((p) => !isMilitaryAnchor(p.coord));
}

/** 코스 경유지 후보 검색 — 갈 수 없는 곳은 길찾기 전에 뺀다. */
export async function searchAnchors(
  ...args: Parameters<typeof searchByType>
): Promise<Awaited<ReturnType<typeof searchByType>>> {
  return (await searchByType(...args)).filter((p) => isRoutableAnchor(p.coord));
}

async function kakaoLeg(
  from: LatLng,
  to: LatLng,
  avoid: AvoidOption[] | undefined,
): Promise<Leg | null> {
  try {
    const routes = await getDirections(from, to, "RECOMMEND", { avoid });
    const r = routes[0];
    if (!r) return null;
    return {
      path: routePath(r),
      dur: r.summary.duration,
      dist: r.summary.distance,
      toll: r.summary.fare.toll,
      source: "kakao",
    };
  } catch (e) {
    console.error(
      `[kakaoLeg] ${from.lng.toFixed(4)},${from.lat.toFixed(4)}–${to.lng.toFixed(4)},${to.lat.toFixed(4)} 실패:`,
      e instanceof Error ? e.message : e,
    );
    return null;
  }
}

/**
 * 관통선(spine)을 **그대로** 경로로 그린다(카카오가 안쪽으로 재라우팅 못 하게).
 * 출발지–해안진입, 해안이탈–목적지, 그리고 데이터가 끊긴 gap만 카카오로 잇고,
 * 이어진 해안 구간은 OSM 해안도로 정점을 직접 폴리라인으로 쓴다.
 * 해안 구간 소요시간은 실시간 교통이 없어 평균속도로 추정한다.
 */
export async function spineDirectRoute(
  origin: LatLng,
  destination: LatLng,
  spine: LatLng[],
  avoid: AvoidOption[] | undefined,
  label: string,
  legFn: LegFn = kakaoLeg,
  fixed: Place[] = [],
): Promise<RouteCandidate | null> {
  const endTiming = startLoopStage("routing.spine");
  try {
  if (spine.length < 2) return null;
  const path: LatLng[] = [];
  let dur = 0,
    toll = 0;

  // 필수 경유지 — 해안 구간은 건드리지 않고, 진입/복귀 다리 중 우회가
  // 적은 쪽 사슬에 끼운다
  const entry: LatLng[] = [origin, spine[0]];
  const exit: LatLng[] = [spine[spine.length - 1], destination];
  for (const f of fixed.slice(0, 3)) {
    let chain = entry,
      at = 1,
      best = Infinity;
    for (const c of [entry, exit]) {
      for (let k = 0; k + 1 < c.length; k++) {
        const cost =
          distanceM(c[k], f.coord) +
          distanceM(f.coord, c[k + 1]) -
          distanceM(c[k], c[k + 1]);
        if (cost < best) {
          best = cost;
          chain = c;
          at = k + 1;
        }
      }
    }
    chain.splice(at, 0, f.coord);
  }
  const routeChain = async (stops: LatLng[]): Promise<Leg | null> => {
    const parts = await Promise.all(
      stops.slice(0, -1).map((s, i) => legFn(s, stops[i + 1], avoid)),
    );
    if (parts.some((p) => p === null)) return null;
    const ls = parts as Leg[];
    return {
      path: ls.flatMap((l) => l.path),
      dist: ls.reduce((s, l) => s + l.dist, 0),
      dur: ls.reduce((s, l) => s + l.dur, 0),
      toll: ls.reduce((s, l) => s + l.toll, 0),
    };
  };

  const c0 = await routeChain(entry);
  if (!c0) return null;
  path.push(...c0.path);
  dur += c0.dur;
  toll += c0.toll;

  let i = 0;
  while (i < spine.length - 1) {
    if (distanceM(spine[i], spine[i + 1]) <= SPINE_GAP_M) {
      // 이어진 해안 구간 — 정점을 직접 폴리라인으로
      let runDist = 0;
      path.push(spine[i]);
      while (i < spine.length - 1 && distanceM(spine[i], spine[i + 1]) <= SPINE_GAP_M) {
        runDist += distanceM(spine[i], spine[i + 1]);
        path.push(spine[i + 1]);
        i++;
      }
      dur += runDist / COASTAL_SPEED_MPS;
    } else {
      // 데이터 gap — 카카오로 잇는다
      const leg = await legFn(spine[i], spine[i + 1], avoid);
      if (leg) {
        path.push(...leg.path);
        dur += leg.dur;
        toll += leg.toll;
      } else {
        const d = distanceM(spine[i], spine[i + 1]);
        path.push(spine[i], spine[i + 1]);
        dur += d / COASTAL_SPEED_MPS;
      }
      i++;
    }
  }

  const cN = await routeChain(exit);
  if (cN) {
    path.push(...cN.path);
    dur += cN.dur;
    toll += cN.toll;
  }

  // '왔던 길 되돌아오기'(곶 왕복 등) 제거. 거리는 잘린 경로로 재계산하고
  // 시간은 비율로 보정한다. 필수 경유지가 있으면 생략 — 핀 들르는 왕복
  // 스퍼를 곶 왕복으로 오인해 잘라버린다.
  const trimmed = fixed.length > 0 ? path : trimBacktracks(path);
  const rawLen = pathLen(path);
  const newLen = pathLen(trimmed);
  const scale = rawLen > 0 ? newLen / rawLen : 1;

  // 색칠/내비용 경유지 — spine을 성기게 샘플
  const wpChain: Place[] = spine.map((c, k) => ({
    name: `해안${k}`,
    address: "",
    coord: c,
  }));

  return {
    label,
    waypoints: [...fixed.slice(0, 3), ...samplePlaces(wpChain, 15)],
    styleTag: "해안도로",
    durationSec: Math.round(dur * scale),
    distanceM: Math.round(newLen),
    tollFare: toll,
    fuelCost: estimateFuelCost(newLen),
    curve: curveMetrics(trimmed),
    path: trimmed,
    estimated: true,
    routeSource: "local-its",
    tollUnknown: true,
  };
  } finally {
    endTiming?.();
  }
}

/** 와인딩 구간 평균속도 — 헤어핀·급커브 감안 */
const WINDING_SPEED_MPS = 35 / 3.6;

/** 구간 테마 — 와인딩(기본)과 강변길이 같은 루프 기계를 공유한다 */
export interface SegLoopTheme {
  /** 구간 폴리라인 주행 평균속도 (기본: 와인딩 35km/h) */
  segSpeedMps: number;

  kind: string;
  styleTag: DriveStyle;

  anonName: string;
}
const WINDING_THEME: SegLoopTheme = {
  segSpeedMps: WINDING_SPEED_MPS,
  kind: "와인딩",
  styleTag: "와인딩",
  anonName: "무명 고갯길",
};

/**
 * 구간 루프: 출발지 – 구간 진입(카카오) – 구간 폴리라인 직접 주행 –
 * (다음 구간으로 연결) – … – 복귀(카카오). 고개는 넘어가는 길이라 진입/복귀가
 * 자연히 다른 길이 된다(왕복 겹침 없는 루프). 2개 체이닝이면 "미시령으로
 * 넘고 진부령으로 돌아오는" 클래식 코스가 된다. trimBacktracks는 헤어핀을
 * 왕복으로 오인해 잘라버리므로 여기선 쓰지 않는다.
 */
export async function windingLoopRoute(
  origin: LatLng,
  segs: WindingSegment[],
  avoid: AvoidOption[] | undefined,
  legFn: LegFn = kakaoLeg,
  theme: SegLoopTheme = WINDING_THEME,
  fixed: Place[] = [],
): Promise<RouteCandidate | null> {
  const endTiming = startLoopStage("routing.segments");
  try {
  if (segs.length === 0 || segs.some((s) => s.pts.length < 2)) return null;
  // 각 구간을 진행 방향으로 정렬: 첫 구간은 출발지, 다음 구간은 직전 이탈점
  // 기준으로 가까운 끝을 진입부로 삼는다
  const oriented: LatLng[][] = [];
  let cursor = origin;
  for (const seg of segs) {
    const pts: LatLng[] = seg.pts.map(([lat, lng]) => ({ lat, lng }));
    const o =
      distanceM(cursor, pts[0]) <= distanceM(cursor, pts[pts.length - 1])
        ? pts
        : [...pts].reverse();
    oriented.push(o);
    cursor = o[o.length - 1];
  }

  // 연결 다리들: 출발–첫 진입, 구간 사이, 마지막 이탈–복귀.
  // 각 다리는 정류장 사슬 [시작, (필수 경유…), 끝] — 필수 경유지는 구간
  // 주행을 건드리지 않고 우회가 가장 적은 다리에 끼운다.
  const bridges: LatLng[][] = [[origin, oriented[0][0]]];
  for (let i = 0; i + 1 < oriented.length; i++) {
    bridges.push([oriented[i][oriented[i].length - 1], oriented[i + 1][0]]);
  }
  bridges.push([oriented[oriented.length - 1].slice(-1)[0], origin]);
  for (const f of fixed.slice(0, 3)) {
    let bi = 0,
      bk = 1,
      bestCost = Infinity;
    for (let i = 0; i < bridges.length; i++) {
      const b = bridges[i];
      for (let k = 0; k + 1 < b.length; k++) {
        const cost =
          distanceM(b[k], f.coord) +
          distanceM(f.coord, b[k + 1]) -
          distanceM(b[k], b[k + 1]);
        if (cost < bestCost) {
          bestCost = cost;
          bi = i;
          bk = k + 1;
        }
      }
    }
    bridges[bi].splice(bk, 0, f.coord);
  }
  const routeBridge = async (stops: LatLng[]): Promise<Leg | null> => {
    const parts = await Promise.all(
      stops.slice(0, -1).map((s, i) => legFn(s, stops[i + 1], avoid)),
    );
    if (parts.some((p) => p === null)) return null;
    const ls = parts as Leg[];
    return {
      path: ls.flatMap((l) => l.path),
      dist: ls.reduce((s, l) => s + l.dist, 0),
      dur: ls.reduce((s, l) => s + l.dur, 0),
      toll: ls.reduce((s, l) => s + l.toll, 0),
    };
  };
  const legs = await Promise.all(bridges.map(routeBridge));
  if (legs.some((l) => l === null)) return null;

  const path: LatLng[] = [];
  let dist = 0,
    dur = 0,
    toll = 0;
  const wpChain: Place[] = [];
  for (let i = 0; i < oriented.length; i++) {
    const leg = legs[i]!;
    path.push(...leg.path, ...oriented[i]);
    dist += leg.dist + segs[i].lenM;
    dur += leg.dur + segs[i].lenM / theme.segSpeedMps;
    toll += leg.toll;
    const nm = segs[i].name ?? theme.anonName;
    for (const c of oriented[i]) wpChain.push({ name: nm, address: "", coord: c });
  }
  const last = legs[legs.length - 1]!;
  path.push(...last.path);
  dist += last.dist;
  dur += last.dur;
  toll += last.toll;

  const names = segs.map((s) => s.name ?? theme.anonName);
  const scenery = segSceneryTags(segs);
  return {
    label: `${[...new Set(names)].join(" – ")} ${theme.kind} 루프${scenery.length > 0 ? ` · ${scenery.join("·")}` : ""}`,
    waypoints: [...fixed.slice(0, 3), ...samplePlaces(wpChain, 5)],
    highlights: oriented.map((o, i) => ({ name: names[i], path: o })),
    styleTag: theme.styleTag,
    durationSec: Math.round(dur),
    distanceM: Math.round(dist),
    tollFare: toll,
    fuelCost: estimateFuelCost(dist),
    curve: curveMetrics(path),
    path,
    estimated: true,
    routeSource: "local-its",
    tollUnknown: true,
  };
  } finally {
    endTiming?.();
  }
}

/** 스타일 변형용 회피 옵션 — 해안도로는 고속도로를 타면 의미가 없다 */
export function styleAvoid(
  style: DriveStyle,
  base: AvoidOption[] = [],
): AvoidOption[] {
  return style === "해안도로" ? [...new Set([...base, "motorway" as const])] : base;
}
