import "server-only";

import { loopCount, startLoopStage } from "@/lib/loop-timing";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { nodelinkSpeedKmh, trafficAvailable } from "@/lib/its-speed";
import type { LatLng } from "@/lib/types";

interface Meta {
  version: number;
  nodes: number;
  links: number;
  geometryPoints: number;
  gridCells: number;
  cellSizeDeg: number;
}

interface NativeGraph {
  meta: Meta;
  nodeCoords: Float32Array;
  linkFrom: Uint32Array;
  linkTo: Uint32Array;
  length: Float32Array;
  rank: Uint8Array;
  maxSpeed: Uint8Array;
  lanes: Uint8Array;
  flags: Uint8Array;
  geom: Float32Array;
  geomOff: Uint32Array;
  geomCnt: Uint32Array;
  adjOff: Uint32Array;
  adjLinks: Uint32Array;
  gridKeys: Int32Array;
  gridOffsets: Uint32Array;
  gridLinks: Uint32Array;
  forbidden: Set<bigint>;
  /** TURNINFO 유턴 허용(011·012) 링크쌍. 비어 있으면(사이드카 없음) 예전처럼 어디서나 유턴 */
  uturnAllow: Set<bigint>;
  /** 유턴 허용이 기록된 교차로 노드 — 링크쌍이 교차로 안쪽 짧은 링크와 달라도 같은 자리면 허용 */
  /** 유턴 허용 기록이 있는 교차로 노드 – 그 기록의 [진입 방위, 진출 방위] 목록 (방향이 맞는 동작만 허용) */
  uturnNodes: Map<number, [number, number][]>;
  outBearing: Float32Array;
  inBearing: Float32Array;
}

export interface NativeRouteOptions {
  /** 코스 추천 탐색 전용 — 빠른 어림값과 방문 상한을 쓴다. 내비 안내 경로에는 켜지 않는다. */
  explore?: boolean;
  itsSpeedScale: number;
  searchBlend: number;
  maxSpeedup: number;
  roadPrefScale: number;
  turnScale: number;
  fallbackMultiplier: number;

  alternatives?: number;
  /** 탐색 목적. time은 ITS 현재속도, distance는 실제 링크 길이를 최소화한다. */
  objective?: "time" | "distance";
  /** 고속도로·도시고속도로(표준노드링크 ROAD_RANK 1~2) 본선 회피 */
  avoidMotorway?: boolean;
  /**
   * 정체 회피 강화 — 관측속도가 기준속도보다 낮은 만큼 간선 비용을 증폭해,
   * 시간이 조금 더 걸려도 안 막히는 평행 도로로 실제 우회하게 만든다. 동시에
   * 왕복 1차선·시군도(rank≥7)급 좁은 길은 통과로에서 배제한다(연결로만 허용).
   * objective와 무관하게 time 계열로 취급한다.
   */
  avoidJam?: boolean;
  /**
   * 출발 헤딩(진행 방위, °). 이탈 재탐색에서 운전자가 실제 가는 방향과 반대인
   * 시작 링크(즉시 U턴/역주행)에 큰 페널티를 줘, 복귀 경로가 뒤로 돌아가지
   * 않게 한다. 막다른 길 등 정말 뒤로만 갈 수 있으면 페널티가 유한이라 허용.
   */
  startHeading?: number;
  /** 큰길 유턴은 TURNINFO 허용 지점에서만(내부용 — nativeNodelinkRoutes가 켜고, 길이 없으면 끄고 다시 찾는다) */
  strictUturn?: boolean;
}

export interface NativeNodelinkRoute {
  path: LatLng[];
  dist: number;
  /** ITS 속도에 보정 배율을 적용하기 전 순수 링크 적분시간. ETA 피팅용이다. */
  itsRawSec: number;
  itsSec: number;
  fallbackSec: number;
  turnSec: number;
  itsCoverage: number;
  startConnectorM: number;
  endConnectorM: number;
  links: number[];
}

interface SnapCandidate {
  link: number;
  distance: number;
  fraction: number;
  segment: number;
  projected: LatLng;
}

const DIR = join(process.cwd(), "src/lib/data/nodelink");
const TURN_PATH = join(process.cwd(), "src/lib/data/roadgraph/nodelink-turn-forbid.bin");
const UTURN_ALLOW_PATH = join(process.cwd(), "src/lib/data/roadgraph/nodelink-uturn-allow.bin");
const RANK_KMH = [50, 100, 90, 80, 70, 60, 50, 35];
const RANK_PREF = [1, 1, 1, 1, 1.02, 1.05, 1.09, 1.18];
/** avoidJam: 정체분(1−관측/기준)에 곱하는 우회 가중치. 클수록 더 멀리 돌아간다. */
const JAM_WEIGHT = 2.5;
const MAX_SNAP_M = 110;
const MAX_VISITS = 1_200_000;
/**
 * 코스 후보 탐색 전용 어림값 배수. 남은 시간을 시속 130km로 어림하면 사방을 뒤진다(서울 4시간
 * 780만 번). 2배(시속 65km 어림)면 절반 이하로 줄고 표본 코스는 같았다(2026-11-05).
 */
export const EXPLORE_HEURISTIC_SCALE = 2;
/**
 * 코스 후보 탐색 전용 방문 상한. 넘으면 이 엔진은 실패로 보고 기존 폴백으로 넘어간다.
 * 해안 0.4km 구간이 120만 번씩 2회 돌고 나서야 OSM으로 수 ms에 풀린 일이 있었다.
 */
export function exploreVisitLimit(straightM: number): number {
  return Math.min(MAX_VISITS, 60_000 + 25 * straightM);
}
/** 역방향 시작 페널티 — 시작 링크가 운전자 헤딩과 반대(즉시 유턴)면 시작 비용에
 *  더한다. 유한·소액이라, 앞으로 가는 대안이 이 값보다 "크게" 돌아가야 할 때만
 *  유턴을 고른다. 과거 100,000(=time 27시간)은 유턴을 피하려 대형 루프를 만들었다.
 *  objective별 단위: time=초, distance=m. */
const START_REVERSE_PENALTY_S = 300;
/** 유턴 회피용 **탐색 전용** 가산 비용(초). ETA에는 반영되지 않는다. */
const UTURN_SEARCH_PENALTY_S = 240;
/** 유턴 허용으로 기록된 자리의 유턴 벌점(초) — 카카오도 이런 유턴은 쓴다(수원 시청사거리). 60이면 앞쪽 재탐색 10건이 늘어 0 */
const UTURN_LISTED_PENALTY_S = Number(process.env.NODELINK_UTURN_LISTED_PENALTY ?? 0);
const START_REVERSE_PENALTY_M = 1200;
/** 링크 진입·진출 방위를 잴 최소 현 길이(m). 끝점의 미세 꼬리 점을 무시한다. */
const BEARING_SPAN_M = 15;
/** 중앙분리대 횡단 스텁으로 볼 최대 길이(m). 이보다 짧으면 회전 한 동작의 일부다. */
const MEDIAN_STUB_M = 30;
const MIL_CELL = 0.0012;
let militaryCells: Set<number> | null = null;

function militaryBlocked(lat: number, lng: number): boolean {
  if (militaryCells === null) {
    try {
      militaryCells = new Set<number>(
        JSON.parse(
          readFileSync(join(process.cwd(), "src/lib/data/military-cells.json"), "utf8"),
        ) as number[],
      );
    } catch {
      militaryCells = new Set();
    }
  }
  return militaryCells.has(
    Math.floor(lat / MIL_CELL) * 1_000_000 + Math.floor(lng / MIL_CELL),
  );
}

const bytes = (path: string): ArrayBuffer => {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

let graph: NativeGraph | null | undefined;
function loadGraph(): NativeGraph | null {
  if (graph !== undefined) return graph;
  const endLoad = startLoopStage("local.nativeGraphLoad");
  try {
    const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf8")) as Meta;
    if (meta.version !== 3 || !(meta.nodes > 0)) {
      throw new Error("scripts/build-nodelink.mjs의 v3 산출물이 필요합니다.");
    }
    const ft = new Uint32Array(bytes(join(DIR, "link-fromto.bin")));
    const gi = new Uint32Array(bytes(join(DIR, "geom-index.bin")));
    let forbidden = new Set<bigint>();
    try {
      const turns = new Uint32Array(bytes(TURN_PATH));
      forbidden = new Set();
      for (let i = 0; i + 1 < turns.length; i += 2) {
        forbidden.add((BigInt(turns[i]) << BigInt(32)) | BigInt(turns[i + 1]));
      }
    } catch {
      // TURNINFO 사이드카가 없으면 방향 그래프만 사용한다.
    }
    const uturnAllow = new Set<bigint>();
    try {
      const pairs = new Uint32Array(bytes(UTURN_ALLOW_PATH));
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        uturnAllow.add((BigInt(pairs[i]) << BigInt(32)) | BigInt(pairs[i + 1]));
      }
    } catch {
      // scripts/build-uturn-allow.mjs 산출물이 없으면 유턴 제한 없이 예전 동작
    }
    const next: NativeGraph = {
      meta,
      nodeCoords: new Float32Array(bytes(join(DIR, "node-coords.bin"))),
      linkFrom: ft.subarray(0, meta.links),
      linkTo: ft.subarray(meta.links),
      length: new Float32Array(bytes(join(DIR, "link-length.bin"))),
      rank: new Uint8Array(bytes(join(DIR, "link-rank.bin"))),
      maxSpeed: new Uint8Array(bytes(join(DIR, "link-maxspeed.bin"))),
      lanes: new Uint8Array(bytes(join(DIR, "link-lanes.bin"))),
      flags: new Uint8Array(bytes(join(DIR, "link-flags.bin"))),
      geom: new Float32Array(bytes(join(DIR, "geom.bin"))),
      geomOff: gi.subarray(0, meta.links),
      geomCnt: gi.subarray(meta.links),
      adjOff: new Uint32Array(bytes(join(DIR, "adj-offsets.bin"))),
      adjLinks: new Uint32Array(bytes(join(DIR, "adj-links.bin"))),
      gridKeys: new Int32Array(bytes(join(DIR, "grid-keys.bin"))),
      gridOffsets: new Uint32Array(bytes(join(DIR, "grid-offsets.bin"))),
      gridLinks: new Uint32Array(bytes(join(DIR, "grid-links.bin"))),
      forbidden,
      uturnAllow,
      uturnNodes: new Map<number, [number, number][]>(),
      outBearing: new Float32Array(meta.links),
      inBearing: new Float32Array(meta.links),
    };
    // 허용 링크쌍의 교차로 노드(진입 링크 끝·진출 링크 시작)
    const uturnPairs: [number, number][] = [];
    for (const key of uturnAllow) {
      const a = Number(key >> BigInt(32)), b = Number(key & BigInt(0xffffffff));
      if (a < meta.links && b < meta.links) uturnPairs.push([a, b]);
    }

    next.outBearing.fill(Number.NaN);
    next.inBearing.fill(Number.NaN);
    if (
      next.nodeCoords.length !== meta.nodes * 2 ||
      ft.length !== meta.links * 2 ||
      next.length.length !== meta.links ||
      next.adjOff.length !== meta.nodes + 1 ||
      next.adjLinks.length !== meta.links
    ) {
      throw new Error("표준노드링크 v3 바이너리 길이가 meta와 다릅니다.");
    }
    // 유턴 허용 노드별 [진입, 진출] 방위 — 방위 캐시(NaN 초기화)·길이 검증 뒤에 계산해야 한다
    for (const [a, b] of uturnPairs) {
      const dirs: [number, number] = [bearingAt(next, a, true), bearingAt(next, b, false)];
      for (const n of [next.linkTo[a], next.linkFrom[b]]) {
        const list = next.uturnNodes.get(n);
        if (list) list.push(dirs); else next.uturnNodes.set(n, [dirs]);
      }
    }
    graph = next;
  } catch (error) {
    console.error("[nodelink-route] 방향 그래프 로딩 실패:", error);
    graph = null;
  } finally {
    endLoad?.({ available: !!graph, nodes: graph?.meta.nodes ?? 0, links: graph?.meta.links ?? 0 });
  }
  return graph;
}

const lonMeters = (lat: number) => Math.cos((lat * Math.PI) / 180) * 111_320;
const distanceM = (a: LatLng, b: LatLng) =>
  Math.hypot((b.lng - a.lng) * lonMeters((a.lat + b.lat) / 2), (b.lat - a.lat) * 110_540);
function lowerBound(a: Int32Array, value: number): number {
  let lo = 0, hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function projectToLink(g: NativeGraph, link: number, point: LatLng): SnapCandidate {
  const off = g.geomOff[link], cnt = g.geomCnt[link], mx = lonMeters(point.lat);
  let total = 0, before = 0, best = Infinity, bestAlong = 0, bestSeg = 0, bestT = 0;
  for (let i = 1; i < cnt; i++) {
    const aLat = g.geom[(off + i - 1) * 2], aLng = g.geom[(off + i - 1) * 2 + 1];
    const bLat = g.geom[(off + i) * 2], bLng = g.geom[(off + i) * 2 + 1];
    const dx = (bLng - aLng) * mx, dy = (bLat - aLat) * 110_540;
    const segLen = Math.hypot(dx, dy);
    const ax = (aLng - point.lng) * mx, ay = (aLat - point.lat) * 110_540;
    const t = Math.max(0, Math.min(1, segLen ? -(ax * dx + ay * dy) / (segLen * segLen) : 0));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      bestAlong = before + segLen * t;
      bestSeg = i - 1;
      bestT = t;
    }
    before += segLen;
  }
  total = before;
  const aLat = g.geom[(off + bestSeg) * 2], aLng = g.geom[(off + bestSeg) * 2 + 1];
  const bLat = g.geom[(off + bestSeg + 1) * 2], bLng = g.geom[(off + bestSeg + 1) * 2 + 1];
  return {
    link,
    distance: best,
    fraction: total > 0 ? bestAlong / total : 0,
    segment: bestSeg,
    projected: { lat: aLat + (bLat - aLat) * bestT, lng: aLng + (bLng - aLng) * bestT },
  };
}

function snapCandidates(g: NativeGraph, point: LatLng): SnapCandidate[] {
  const cy = Math.floor(point.lat / g.meta.cellSizeDeg);
  const cx = Math.floor(point.lng / g.meta.cellSizeDeg);
  const seen = new Set<number>();
  const found: SnapCandidate[] = [];
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      const key = y * 100_000 + x;
      const ci = lowerBound(g.gridKeys, key);
      if (ci >= g.gridKeys.length || g.gridKeys[ci] !== key) continue;
      for (let p = g.gridOffsets[ci]; p < g.gridOffsets[ci + 1]; p++) {
        const link = g.gridLinks[p];
        if (seen.has(link)) continue;
        seen.add(link);
        // 공식 코드: ROAD_USE 0=사용, 1=미사용. 폐기·갱신 이력 링크를
        // 출발/도착 스냅 후보로 잡거나 경로에 통과시키면 안 된다.
        if ((g.flags[link] & 15) !== 0) continue;
        const hit = projectToLink(g, link, point);
        if (hit.distance <= MAX_SNAP_M) found.push(hit);
      }
    }
  }
  found.sort((a, b) => a.distance - b.distance);
  if (!found.length) return [];
  // 평행 반대차로와 입체도로 후보는 남기되 전혀 다른 인근 도로로 건너가지 않는다.
  const gate = Math.min(MAX_SNAP_M, found[0].distance + 28);
  return found.filter((x) => x.distance <= gate).slice(0, 10);
}

class Heap {
  private costs: number[] = [];
  private links: number[] = [];
  get size() { return this.costs.length; }
  push(cost: number, link: number) {
    const c = this.costs, l = this.links;
    c.push(cost); l.push(link);
    let i = c.length - 1;
    while (i) {
      const p = (i - 1) >> 1;
      if (c[p] <= c[i]) break;
      [c[p], c[i]] = [c[i], c[p]]; [l[p], l[i]] = [l[i], l[p]]; i = p;
    }
  }
  pop(): { cost: number; link: number } {
    const c = this.costs, l = this.links;
    const out = { cost: c[0], link: l[0] };
    const lastC = c.pop()!, lastL = l.pop()!;
    if (c.length) {
      c[0] = lastC; l[0] = lastL;
      let i = 0;
      for (;;) {
        const left = i * 2 + 1, right = left + 1;
        let best = i;
        if (left < c.length && c[left] < c[best]) best = left;
        if (right < c.length && c[right] < c[best]) best = right;
        if (best === i) break;
        [c[i], c[best]] = [c[best], c[i]]; [l[i], l[best]] = [l[best], l[i]]; i = best;
      }
    }
    return out;
  }
}

let distBuf: Float64Array | null = null;
let prevBuf: Int32Array | null = null;
let genBuf: Uint32Array | null = null;
let generation = 0;

function bearingAt(g: NativeGraph, link: number, incoming: boolean): number {
  const cache = incoming ? g.inBearing : g.outBearing;
  if (!Number.isNaN(cache[link])) return cache[link];
  const off = g.geomOff[link], cnt = g.geomCnt[link];
  // 끝 구간 하나만 보면 안 된다 — 표준노드링크에는 0.4m짜리 꼬리 점이 흔하고
  // (전국 링크의 3.9%가 마지막 구간 3m 미만) 그러면 진행 방향이 통째로
  // 뒤집힌다. 울진 후포로는 서쪽으로 가는 길인데 0.4m 꼬리 탓에 "남쪽"으로
  // 읽혀, 60° 우회전이 150° 유턴으로 찍혔다. 최소 BEARING_SPAN_M만큼
  // 떨어진 점까지 물러나 현을 긋는다(링크가 그보다 짧으면 링크 전체).
  let aLat: number, aLng: number, bLat: number, bLng: number;
  if (incoming) {
    bLat = g.geom[(off + cnt - 1) * 2]; bLng = g.geom[(off + cnt - 1) * 2 + 1];
    aLat = g.geom[(off + cnt - 2) * 2]; aLng = g.geom[(off + cnt - 2) * 2 + 1];
    for (let j = off + cnt - 2; j >= off; j--) {
      aLat = g.geom[j * 2]; aLng = g.geom[j * 2 + 1];
      if (distanceM({ lat: aLat, lng: aLng }, { lat: bLat, lng: bLng }) >= BEARING_SPAN_M) break;
    }
  } else {
    aLat = g.geom[off * 2]; aLng = g.geom[off * 2 + 1];
    bLat = g.geom[(off + 1) * 2]; bLng = g.geom[(off + 1) * 2 + 1];
    for (let j = off + 1; j < off + cnt; j++) {
      bLat = g.geom[j * 2]; bLng = g.geom[j * 2 + 1];
      if (distanceM({ lat: aLat, lng: aLng }, { lat: bLat, lng: bLng }) >= BEARING_SPAN_M) break;
    }
  }
  return (cache[link] =
    (Math.atan2((bLng - aLng) * lonMeters((aLat + bLat) / 2), (bLat - aLat) * 110_540) * 180) /
    Math.PI);
}

/**
 * 큰길 유턴이 허용된 자리인지 — 우리나라는 유턴 표지가 있는 곳에서만 유턴할 수 있다.
 * 큰길(지방도 이상 또는 한 방향 2차로+)은 TURNINFO 유턴 허용 링크쌍에 있어야 하고,
 * 골목·시군도 1차로는 돌아 나오는 게 현실적이라 그대로 허용한다.
 * 10-27 여의대방로: 가장 가까운 허용 지점이 400m 떨어진 곳에서 "잠시 후 유턴"을 시켰다.
 */
function uturnLegal(g: NativeGraph, nodes: number[], pairs: [number, number][]): boolean {
  if (g.uturnAllow.size === 0) return true;
  const [first] = pairs;
  const major = (l: number) => g.rank[l] <= 6 || g.lanes[l] >= 2;
  if (!major(first[0]) && !major(first[1])) return true;
  return uturnListed(g, nodes, pairs);
}
const angleGap = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
/** 유턴 허용 기록과 실제 동작의 방위 허용 오차(°) — 허용쌍이 교차로 안쪽 링크면 큰길 방위와 60~90° 다르다(해군회관앞: 60이면 합법 유턴을 막음). 반대 방향 진입(~180°)은 계속 막힌다 */
const UTURN_DIR_TOL = Number(process.env.NODELINK_UTURN_DIR_TOL ?? 90);
const UTURN_DIR_SUM = Number(process.env.NODELINK_UTURN_DIR_SUM ?? 150);

/** 교차로 안쪽 짧은 링크로 볼 길이(m) — 이보다 짧은 링크가 이어지면 회전 하나로 합쳐 본다 */
const CHAIN_LINK_M = 30;
/** 짧은 링크 묶음 전체 길이 상한(m) */
const CHAIN_TOTAL_M = 45;

/**
 * 교차로 안 짧은 링크 여러 개를 거쳐 되돌아가는 유턴 — 진입 링크 `back`(체인 시작 전)을 돌려준다.
 * 대방역 앞(여의대방로)은 교차로가 12m 링크 3개로 그려져 북행–우97°–우83°–남행이 되는데,
 * 한 번에 150°를 넘는 꺾임이 없어 유턴으로 안 잡혔다 — 벌점 없는 공짜 유턴이라 재탐색이
 * 자꾸 골랐다(10-27 "잠시 후 유턴"). 체인 앞뒤 진행방위로 165°+면 유턴이다.
 */
function chainUturnBack(g: NativeGraph, prev: Int32Array | number[], link: number, next: number): number {
  let acc = 0, cur = link;
  for (let step = 0; step < 4; step++) {
    if (g.length[cur] > CHAIN_LINK_M) return -1;
    acc += g.length[cur];
    if (acc > CHAIN_TOTAL_M) return -1;
    const back = prev[cur];
    if (back === undefined || back < 0) return -1;
    const signed = ((bearingAt(g, next, false) - bearingAt(g, back, true) + 540) % 360) - 180;
    // 165°: 짧은 링크 2개로 꺾는 급좌회전(98°+53°=151°, 홍천)을 유턴으로 오인하지 않게 — 안내도 165°+만 유턴
    if (Math.abs(signed) >= 165) return back;
    cur = back;
  }
  return -1;
}

/**
 * 유턴 허용 기록이 있는지 — 링크쌍이 그대로 있거나, **실제로 도는 교차로 노드**(nodes: 직접 유턴은
 * 진입 링크 끝 노드, 짧은 링크 체인은 체인 안 노드들)에 허용 기록이 있으면.
 * 수원 시청사거리는 허용쌍이 진입로–반대 진출로인데 경로는 교차로 안쪽 12m·24m 링크로 돌아 쌍이
 * 달랐다(허용 노드 1m). 링크 양 끝을 다 보면 수백 m 떨어진 반대쪽 끝의 허용까지 통과했다(검사 지적).
 */
function uturnListed(g: NativeGraph, nodes: number[], pairs: [number, number][]): boolean {
  if (pairs.some(([a, b]) => g.uturnAllow.has((BigInt(a) << BigInt(32)) | BigInt(b)))) return true;
  // 같은 교차로라도 다른 방향에서 들어온 유턴까지 허용하면 안 된다(검사 지적) — 동작 전체(첫 쌍의
  // 진입 링크 – 진출 링크) 방위가 허용 기록과 35° 안에서 맞을 때만
  const [inL, outL] = pairs[0];
  const inB = bearingAt(g, inL, true), outB = bearingAt(g, outL, false);
  return nodes.some((n) =>
    (g.uturnNodes.get(n) ?? []).some(([ai, ao]) => {
      const gi = angleGap(ai, inB), go = angleGap(ao, outB);
      // 각각 90° 안이면서 합도 150° 안 — 진입·진출이 직각인 기록은 각각 90°만 보면 반대 방향
      // 진입(둘 다 정확히 90°)까지 통과했다(검사 지적). 반대 방향은 합이 ~180°라 걸러진다.
      return gi <= UTURN_DIR_TOL && go <= UTURN_DIR_TOL && gi + go <= UTURN_DIR_SUM;
    }));
}

/**
 * 스냅한 구간 근처의 진행 방위 — 링크 시작점 방위로 보면 길게 휜 큰길에서 지금 위치의 방향과
 * 110°+ 달라 맞는 차선 후보까지 빠질 수 있었다(검사 지적). 구간 앞뒤로 BEARING_SPAN_M만큼 넓힌다.
 */
function bearingNear(g: NativeGraph, link: number, segment: number): number {
  const off = g.geomOff[link], cnt = g.geomCnt[link];
  let a = Math.max(0, Math.min(cnt - 2, segment)), b = a + 1;
  const pt = (i: number) => ({ lat: g.geom[(off + i) * 2], lng: g.geom[(off + i) * 2 + 1] });
  while (distanceM(pt(a), pt(b)) < BEARING_SPAN_M && (a > 0 || b < cnt - 1)) {
    if (a > 0) a--;
    if (b < cnt - 1 && distanceM(pt(a), pt(b)) < BEARING_SPAN_M) b++;
  }
  const p = pt(a), q = pt(b);
  return (Math.atan2((q.lng - p.lng) * lonMeters(p.lat), (q.lat - p.lat) * 110_540) * 180 / Math.PI + 360) % 360;
}

/** 유턴(되돌아 나가기)인지 — 같은 링크 반환이거나 150°+ 꺾임 */
function isUturn(g: NativeGraph, from: number, to: number): boolean {
  if (from === to) return true;
  const signed =
    ((bearingAt(g, to, false) - bearingAt(g, from, true) + 540) % 360) - 180;
  return Math.abs(signed) >= 150;
}

/**
 * 중앙분리대 횡단 스텁으로 들어가는 길인지 — 좌회전을 유턴으로 오인하지 않기 위함.
 * 분리대가 있는 교차로에서 표준노드링크는 좌회전을 "12m짜리 횡단 링크"로 그린다.
 * 이 스텁은 들어온 방향의 반대편을 향하므로 각도만 보면 유턴이지만, 스텁 뒤에
 * 앞으로 이어지는 길이 있으면 실제로는 좌회전이다. 진입 시점에는 벌점을 보류하고
 * 스텁에서 나가는 순간 정산한다(정말 되돌아가면 그때 물린다).
 * 강릉 비행장교차로: 율곡로 동행 – 월호평길 좌회전이 유턴으로 찍혀 240초를 물고,
 * 그걸 피하려 독송길로 1.2km 뒷길을 돌았다(7.0km, 카카오는 5.9km 좌회전).
 */
function medianStub(g: NativeGraph, from: number, to: number): boolean {
  if (g.length[to] > MEDIAN_STUB_M) return false;
  const node = g.linkTo[to];
  for (let p = g.adjOff[node]; p < g.adjOff[node + 1]; p++) {
    const next = g.adjLinks[p];
    if (next !== from && !isUturn(g, from, next)) return true;
  }
  return false;
}

function turnSeconds(g: NativeGraph, from: number, to: number): number {
  if (from === to) return 55;
  const signed = ((bearingAt(g, to, false) - bearingAt(g, from, true) + 540) % 360) - 180;
  const angle = Math.abs(signed);
  const fast = g.rank[from] <= 4 || g.rank[to] <= 4;
  if (angle < 25) return fast ? 0 : 2;
  if (angle >= 150) return 55;
  if (fast) return 2;
  return signed > 0 ? 7 : 15;
}

function appendPoint(path: LatLng[], point: LatLng) {
  const last = path[path.length - 1];
  if (!last || distanceM(last, point) > 0.2) path.push(point);
}

function routeGeometry(
  g: NativeGraph,
  links: number[],
  start: SnapCandidate,
  end: SnapCandidate,
  from: LatLng,
  to: LatLng,
): LatLng[] {
  const path: LatLng[] = [from];
  for (let p = 0; p < links.length; p++) {
    const link = links[p], off = g.geomOff[link], cnt = g.geomCnt[link];
    const first = p === 0, last = p === links.length - 1;
    if (first) appendPoint(path, start.projected);
    const begin = first ? start.segment + 1 : 0;
    const finish = last ? end.segment : cnt - 1;
    if (!first || !last || end.fraction >= start.fraction) {
      for (let i = begin; i <= finish; i++) {
        appendPoint(path, { lat: g.geom[(off + i) * 2], lng: g.geom[(off + i) * 2 + 1] });
      }
    }
    if (last) appendPoint(path, end.projected);
  }
  appendPoint(path, to);
  return path;
}

interface SearchResult {
  links: number[];
  start: SnapCandidate;
  end: SnapCandidate;
}

function search(
  g: NativeGraph,
  starts: SnapCandidate[],
  ends: SnapCandidate[],
  to: LatLng,
  options: NativeRouteOptions,
  speedOf: (link: number) => number | null,
  penalized: Set<number>,
): SearchResult | null {
  const endTiming = startLoopStage("local.nativeSearch", {
    nodes: g.meta.nodes, links: g.meta.links, strictUturn: !!options.strictUturn,
  });
  loopCount("nativeSearches");
  try {
  const m = g.meta.links;
  if (!distBuf || distBuf.length !== m) {
    distBuf = new Float64Array(m); prevBuf = new Int32Array(m); genBuf = new Uint32Array(m);
  }
  generation++;
  if (generation === 0) { genBuf!.fill(0); generation = 1; }
  const dist = distBuf, prev = prevBuf!, gen = genBuf!;
  const get = (i: number) => gen[i] === generation ? dist[i] : Infinity;
  const set = (i: number, value: number, before: number) => {
    gen[i] = generation; dist[i] = value; prev[i] = before;
  };
  const baseKmh = (link: number) => g.maxSpeed[link] || RANK_KMH[g.rank[link]] || 40;
  const edgeCost = (link: number) => {
    if (options.objective === "distance") {
      return g.length[link] * (penalized.has(link) ? 1.12 : 1);
    }
    const base = baseKmh(link), observed = speedOf(link);
    const capped = observed == null ? base : Math.min(observed, base * options.maxSpeedup);
    const kmh = observed == null ? base : base + (capped - base) * options.searchBlend;
    const pref = 1 + ((RANK_PREF[g.rank[link]] ?? 1.2) - 1) * options.roadPrefScale;
    const narrow = g.lanes[link] === 1 && g.rank[link] >= 6 ? 1.04 : 1;
    let jamMul = 1;
    if (options.avoidJam) {
      // 관측속도가 기준속도보다 느린 만큼 비용을 증폭 – 안 막히는 평행 도로로 우회.
      if (observed != null && observed < base) {
        jamMul += JAM_WEIGHT * Math.min(1, (base - observed) / base);
      }
      // 좁은 길 하한선: 왕복 1차선은 강히, 시군도(rank7)급은 완만히 통과로 기피.
      if (g.lanes[link] === 1 && g.rank[link] >= 6) jamMul *= 1.6;
      else if (g.rank[link] >= 7) jamMul *= 1.35;
    }
    return (g.length[link] / (Math.max(kmh, 5) / 3.6)) * pref * narrow * jamMul *
      (penalized.has(link) ? 1.12 : 1);
  };
  const heuristicScale = options.explore ? EXPLORE_HEURISTIC_SCALE : 1;
  const maxVisits = options.explore
    ? exploreVisitLimit(distanceM(starts[0].projected, to))
    : MAX_VISITS;
  const heuristic = (link: number) => {
    const node = g.linkTo[link];
    const direct = distanceM(
      { lat: g.nodeCoords[node * 2], lng: g.nodeCoords[node * 2 + 1] },
      to,
    );
    return (options.objective === "distance" ? direct : direct / (130 / 3.6)) * heuristicScale;
  };
  const endMap = new Map<number, SnapCandidate[]>();
  for (const end of ends) {
    const list = endMap.get(end.link);
    if (list) list.push(end); else endMap.set(end.link, [end]);
  }
  const startChoice = new Map<number, SnapCandidate>();
  const reversePenalty =
    options.objective === "distance"
      ? START_REVERSE_PENALTY_M
      : START_REVERSE_PENALTY_S;
  const heap = new Heap();
  for (const start of starts) {
    const connector = options.objective === "distance" ? start.distance : start.distance / (15 / 3.6);
    let cost = connector + edgeCost(start.link) * (1 - start.fraction);
    // 출발 헤딩 제약 — 시작 링크 진행 방위가 운전자 헤딩과 크게(>110°) 어긋나면
    // 즉시 역주행이다. 큰(유한) 페널티로 앞으로 가는 시작 후보를 우선시킨다.
    if (options.startHeading != null) {
      // 큰길에서 반대 차선으로 출발 = 그 자리 유턴(불법) — 엄격 모드에선 후보에서 뺀다. 스냅 지점
      // 근처 방위로 본다(링크 시작점 방위 검사 안에 두면 휜 길에서 아예 안 걸렸다, 검사 지적).
      // 앞으로 가는 후보가 하나도 없으면 탐색이 실패하고 예전 규칙으로 다시 찾는다.
      if (options.strictUturn && (g.rank[start.link] <= 6 || g.lanes[start.link] >= 2) &&
        angleGap(bearingNear(g, start.link, start.segment), options.startHeading) > 110) continue;
      const diff = Math.abs(
        ((bearingAt(g, start.link, false) - options.startHeading + 540) % 360) - 180,
      );
      if (diff > 110) cost += reversePenalty;
    }
    if (cost < get(start.link)) {
      set(start.link, cost, -1); startChoice.set(start.link, start);
      heap.push(cost + heuristic(start.link), start.link);
    }
  }
  let best = Infinity, goalLink = -1, goalEnd: SnapCandidate | null = null;
  let visits = 0;
  while (heap.size && visits++ < maxVisits) {
    const item = heap.pop(), link = item.link;
    if (item.cost > get(link) + heuristic(link) + 1e-6) continue;
    if (item.cost >= best) break;
    const targets = endMap.get(link);
    if (targets) {
      for (const end of targets) {
        const start = startChoice.get(link);
        if (prev[link] < 0 && start && end.fraction < start.fraction) continue;
        const connector = options.objective === "distance"
          ? end.distance
          : end.distance / (15 / 3.6);
        const goalCost = get(link) - edgeCost(link) * (1 - end.fraction) + connector;
        if (goalCost < best) { best = goalCost; goalLink = link; goalEnd = end; }
      }
    }
    const node = g.linkTo[link];
    for (let p = g.adjOff[node]; p < g.adjOff[node + 1]; p++) {
      const next = g.adjLinks[p];
      if ((g.flags[next] & 15) !== 0) continue;
      // 출발·도착점 자체가 고속도로 위인 경우 빠져나오거나 들어가는 마지막
      // 링크는 허용하고, 중간 경로의 고속/도시고속 본선만 제외한다.
      if (options.avoidMotorway && g.rank[next] <= 2 && !endMap.has(next)) continue;
      // 정체 회피 우회 시 왕복 1차선 시군도급 좁은 길은 통과로에서 배제(연결로 예외).
      if (
        options.avoidJam &&
        g.lanes[next] === 1 &&
        g.rank[next] >= 7 &&
        !endMap.has(next)
      ) continue;
      const nextNode = g.linkTo[next];
      // 군부대 구역 회피는 부대 안 도로(시군도급)만 — 고속·국도·지방도는 부대
      // 옆이나 위를 지나가도 공공도로다. 등급 무관하게 막았더니 거가대로(국지도58)가
      // 저도 부근 1.5km에서 끊겨 거제–부산이 62km 대신 115km로 돌았다.
      if (
        g.rank[next] >= 7 &&
        militaryBlocked(g.nodeCoords[nextNode * 2], g.nodeCoords[nextNode * 2 + 1])
      ) continue;
      if (g.forbidden.has((BigInt(link) << BigInt(32)) | BigInt(next))) continue;
      // 유턴 회피 — **탐색 비용에만** 얹는 가산점(ETA에는 안 들어간다, 아래
      // 최종 turnSec 합산은 turnSeconds 원값만 씀). 실제 유턴은 물리적으로
      // 55초여도 운전자는 몇 분 더 돌더라도 유턴을 피하려 하고, 신호 대기·
      // 불법 유턴 위험도 있다. 이게 없으면 회전을 놓쳤을 때 "되돌아가기"가
      // 늘 최단이라 재탐색이 무조건 유턴을 시킨다.
      let uturn = isUturn(g, link, next);
      /** 유턴이 TURNINFO 허용 자리인지(벌점을 줄인다) */
      let uturnOk = false;
      if (uturn && medianStub(g, link, next)) uturn = false;
      // 큰길 불법 유턴은 아예 막는다(벌점이 아니라 금지) — 허용 링크쌍만 통과
      if (uturn) {
        const at = [g.linkTo[link]], pr: [number, number][] = [[link, next]];
        if (options.strictUturn && !uturnLegal(g, at, pr)) continue;
        if (g.uturnAllow.size > 0) uturnOk = uturnListed(g, at, pr);
      }
      if (!uturn) {
        // 보류했던 횡단 스텁 정산 — 스텁을 지나 실제로 되돌아가면 여기서 물린다.
        const back = prev[link];
        if (
          back >= 0 && g.length[link] <= MEDIAN_STUB_M &&
          isUturn(g, back, link) && isUturn(g, back, next)
        ) {
          const at = [g.linkTo[back], g.linkTo[link]];
          const pr: [number, number][] = [[back, next], [back, link], [link, next]];
          if (options.strictUturn && !uturnLegal(g, at, pr)) continue;
          uturn = true;
          uturnOk = g.uturnAllow.size > 0 && uturnListed(g, at, pr);
        }
      }
      if (!uturn) {
        // 교차로 안 짧은 링크 여러 개로 나뉜 유턴(한 번에 150° 안 넘음)
        const back = chainUturnBack(g, prev, link, next);
        if (back >= 0) {
          const pairs: [number, number][] = [[back, next], [link, next]];
          const at: number[] = [];
          for (let c = link; c !== back && c >= 0; c = prev[c]) {
            at.push(g.linkTo[c]);
            if (prev[c] >= 0) { pairs.push([prev[c], c]); at.push(g.linkTo[prev[c]]); }
          }
          if (options.strictUturn && !uturnLegal(g, at, pairs)) continue;
          uturn = true;
          uturnOk = g.uturnAllow.size > 0 && uturnListed(g, at, pairs);
        }
      }
      const turnCost =
        options.objective === "distance"
          ? 0
          : turnSeconds(g, link, next) * options.turnScale +
            (uturn ? (uturnOk ? UTURN_LISTED_PENALTY_S : UTURN_SEARCH_PENALTY_S) : 0);
      const nd = get(link) + turnCost + edgeCost(next);
      if (nd < get(next)) {
        set(next, nd, link);
        heap.push(nd + heuristic(next), next);
      }
    }
  }
  loopCount("nativeHeapPops", Math.min(visits, MAX_VISITS));
  if (visits > MAX_VISITS) loopCount("nativeVisitLimitReached");
  if (goalLink < 0 || !goalEnd) return null;
  const links: number[] = [];
  for (let link = goalLink; link >= 0; link = prev[link]) links.push(link);
  links.reverse();
  const start = startChoice.get(links[0]);
  return start ? { links, start, end: goalEnd } : null;
  } finally {
    endTiming?.();
  }
}

function evaluate(
  g: NativeGraph,
  result: SearchResult,
  from: LatLng,
  to: LatLng,
  options: NativeRouteOptions,
  speedOf: (link: number) => number | null,
): NativeNodelinkRoute {
  let dist = result.start.distance + result.end.distance;
  let itsRawSec = 0, itsSec = 0, fallbackSec = 0, turnSec = 0, itsM = 0;
  for (let i = 0; i < result.links.length; i++) {
    const link = result.links[i];
    let fraction = 1;
    if (i === 0) fraction -= result.start.fraction;
    if (i === result.links.length - 1) fraction -= 1 - result.end.fraction;
    fraction = Math.max(0, fraction);
    const len = g.length[link] * fraction;
    dist += len;
    const observed = speedOf(link);
    if (observed != null) {
      itsRawSec += len / (Math.max(Math.min(130, observed), 5) / 3.6);
      itsSec += len / (Math.max(Math.min(130, observed * options.itsSpeedScale), 5) / 3.6);
      itsM += len;
    } else {
      const base = g.maxSpeed[link] || RANK_KMH[g.rank[link]] || 40;
      fallbackSec += len / (Math.max(base, 5) / 3.6);
    }
    if (i > 0) turnSec += turnSeconds(g, result.links[i - 1], link) * options.turnScale;
  }
  return {
    path: routeGeometry(g, result.links, result.start, result.end, from, to),
    dist,
    itsRawSec,
    itsSec,
    fallbackSec,
    turnSec,
    itsCoverage: dist > 0 ? itsM / dist : 0,
    startConnectorM: result.start.distance,
    endConnectorM: result.end.distance,
    links: result.links,
  };
}

/**
 * 표준노드링크 F_NODE–T_NODE 네이티브 A*. 최대 K개 대안을 만들고 실제 ITS
 * 적분시간으로 재랭킹한다. 스냅/연결 실패 시 null을 반환해 OSM A*가 폴백한다.
 */
export function nativeNodelinkRoutes(
  from: LatLng,
  to: LatLng,
  options: NativeRouteOptions,
): NativeNodelinkRoute[] {
  const endTiming = startLoopStage("local.nativeRoutes");
  try {
  const g = loadGraph();
  if (!g) return [];
  const starts = snapCandidates(g, from), ends = snapCandidates(g, to);
  if (!starts.length || !ends.length) return [];
  if (options.explore && exploreUnreachable(g, starts, ends)) return [];
  const useIts = trafficAvailable();
  const speedCache = new Map<number, number | null>();
  const speedOf = (link: number) => {
    if (!useIts) return null;
    if (speedCache.has(link)) return speedCache.get(link) ?? null;
    const speed = nodelinkSpeedKmh(link);
    speedCache.set(link, speed);
    return speed;
  };
  const candidates: NativeNodelinkRoute[] = [];
  const penalized = new Set<number>();
  const count = Math.max(1, Math.min(5, options.alternatives ?? 1));
  // 큰길 불법 유턴 금지가 기본(NODELINK_STRICT_UTURN=0이면 예전처럼 벌점만).
  // 허용 지점만으로 길이 안 이어지면(데이터 누락·막다른 곳) 첫 후보만 예전 규칙으로 다시 찾는다.
  const strict = g.uturnAllow.size > 0 && process.env.NODELINK_STRICT_UTURN !== "0";
  for (let k = 0; k < count; k++) {
    let found = search(g, starts, ends, to, { ...options, strictUturn: strict }, speedOf, penalized);
    if (!found && strict && k === 0) {
      loopCount("nativeRelaxedRetries");
      found = search(g, starts, ends, to, options, speedOf, penalized);
    }
    if (!found) break;
    const route = evaluate(g, found, from, to, options, speedOf);
    if (!candidates.some((x) => x.links.length === route.links.length &&
      x.links.every((link, i) => link === route.links[i]))) {
      candidates.push(route);
    }
    for (const link of found.links) penalized.add(link);
  }
  candidates.sort((a, b) =>
    options.objective === "distance"
      ? a.dist - b.dist
      : a.itsSec + a.fallbackSec * options.fallbackMultiplier + a.turnSec -
        (b.itsSec + b.fallbackSec * options.fallbackMultiplier + b.turnSec));
  return candidates;
  } finally {
    endTiming?.();
  }
}

export function nativeNodelinkRoute(
  from: LatLng,
  to: LatLng,
  options: NativeRouteOptions,
): NativeNodelinkRoute | null {
  return nativeNodelinkRoutes(from, to, options)[0] ?? null;
}

/**
 * 표준노드링크 도로망 조각 번호 — 방향을 무시하고 이어진 도로끼리 같은 번호를 준다.
 * 제주↔육지처럼 번호가 다르면 길이 없으므로 탐색 없이 바로 실패시킨다. 처음 쓸 때 한 번 만든다.
 */
let linkComponents: Uint32Array | null = null;
let componentLinkCounts: Uint32Array | null = null;
function nodeComponents(g: NativeGraph): Uint32Array {
  if (linkComponents) return linkComponents;
  const parent = new Uint32Array(g.adjOff.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let link = 0; link < g.linkTo.length; link++) {
    if ((g.flags[link] & 15) !== 0) continue;
    const a = find(g.linkFrom[link]), b = find(g.linkTo[link]);
    if (a !== b) parent[a] = b;
  }
  for (let i = 0; i < parent.length; i++) parent[i] = find(i);
  const counts = new Uint32Array(parent.length);
  for (let link = 0; link < g.linkTo.length; link++) {
    if ((g.flags[link] & 15) === 0) counts[parent[g.linkTo[link]]]++;
  }
  componentLinkCounts = counts;
  return (linkComponents = parent);
}

const REACH_LINKS = 3000;
let inLinks: { off: Uint32Array; links: Uint32Array } | null = null;
/**
 * 도착 링크로 들어오는 길이 거의 없는지 — 거꾸로 따라가 링크가 충분히 나오면 도로망과 이어진 것이다.
 * 평창향교처럼 들어오는 길이 없는 조각은 탐색이 지도 전체를 뒤진 뒤에야(약 7초) 실패한다.
 * 회전 제한은 보지 않으므로 끊긴 곳만 잡고, 갈 수 있는 곳을 끊겼다고 하지 않는다.
 */
function targetIsolated(g: NativeGraph, ends: SnapCandidate[]): boolean {
  if (!inLinks) {
    const nodes = g.adjOff.length, total = g.linkTo.length, off = new Uint32Array(nodes + 1);
    for (let i = 0; i < total; i++) off[g.linkTo[i] + 1]++;
    for (let i = 0; i < nodes; i++) off[i + 1] += off[i];
    const pos = off.slice(), links = new Uint32Array(total);
    for (let i = 0; i < total; i++) links[pos[g.linkTo[i]]++] = i;
    inLinks = { off, links };
  }
  const seen = new Set<number>(), queue = ends.map((end) => end.link);
  for (const link of queue) seen.add(link);
  for (let i = 0; i < queue.length && seen.size < REACH_LINKS; i++) {
    const from = g.linkFrom[queue[i]];
    for (let k = inLinks.off[from]; k < inLinks.off[from + 1]; k++) {
      const link = inLinks.links[k];
      if ((g.flags[link] & 15) !== 0 || seen.has(link)) continue;
      seen.add(link);
      queue.push(link);
    }
  }
  if (seen.size >= REACH_LINKS) return false;
  // 울릉도처럼 도로망 전체가 작으면 그 조각을 거의 다 돌았을 때 이어진 것으로 본다.
  const comp = nodeComponents(g);
  return seen.size < componentLinkCounts![comp[g.linkTo[ends[0].link]]] * 0.5;
}

/** 코스 탐색에서 표준노드링크로는 닿을 수 없는 구간인지. 이때는 탐색 없이 OSM 폴백으로 넘긴다. */
function exploreUnreachable(g: NativeGraph, starts: SnapCandidate[], ends: SnapCandidate[]): boolean {
  const comp = nodeComponents(g);
  const startComps = new Set(starts.map((s) => comp[g.linkTo[s.link]]));
  if (!ends.some((e) => startComps.has(comp[g.linkTo[e.link]]))) return true;
  return targetIsolated(g, ends);
}

/** 코스 경유지 판단용 — 이 지점에 표준노드링크로 들어갈 수 있으면 true. */
export function nodelinkTargetConnected(point: LatLng): boolean {
  const g = loadGraph();
  if (!g) return false;
  const ends = snapCandidates(g, point);
  return ends.length > 0 && !targetIsolated(g, ends);
}
