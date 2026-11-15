import "server-only";

import { startLoopStage } from "@/lib/loop-timing";

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readRoadBinary } from "@/lib/shared-road-binaries";

import type { LatLng } from "@/lib/types";
import { calibratedFlowState, flowReferenceKmh } from "./traffic-flow";

interface Meta {
  version: number;
  cellSizeDeg: number;
  links: number;
  geometryPoints: number;
  gridCells: number;
}

interface RoadMeta {
  name: string;
  no: string;
}

interface NodelinkIndex {
  meta: Meta;
  ids: BigUint64Array;
  rank: Uint8Array;
  maxSpeed: Uint8Array;
  lanes: Uint8Array;
  linkFrom: Uint32Array;
  linkTo: Uint32Array;
  geom: Float32Array;
  geomOff: Uint32Array;
  geomCnt: Uint32Array;
  gridKeys: Int32Array;
  gridOffsets: Uint32Array;
  gridLinks: Uint32Array;
  adjOffsets?: Uint32Array;
  adjLinks?: Uint32Array;
  roadIndex?: Uint32Array;
  roadTable?: RoadMeta[];

  routeDirection?: Uint8Array;
  /** 표준노드링크 ROAD_TYPE 0=일반 1=고가 2=지하도로 3=교량 4=터널 255=모름 (scripts/build-nodelink-roadtype.mjs) */
  roadType?: Uint8Array;
}

export interface NodelinkMatch {
  linkId: string;
  rank: number;
  /** 국토부 표준노드링크 MAX_SPD. 0이면 미상. */
  maxSpeedKmh: number;
  /** 국토부 표준노드링크 LANES. 0이면 미상. */
  lanes: number;

  fromNodeIndex: number;
  toNodeIndex: number;
  distanceM: number;
  bearingDeg: number;
  headingDiffDeg: number | null;

  roadName?: string;
  roadNo?: string;

  routeDirection?: 1 | 2;
}

/** ROAD_RANK(끝자리 1~7)별 자유주행 기준속도 km/h — 정체율 판정용. */
export function refSpeedKmh(rank: number): number {
  return flowReferenceKmh(rank);
}

/**
 * 현재속도/기준속도 비율 – 소통상태 코드(카카오 관례: 1정체 2지체 3서행 4원활,
 * 0정보없음). RouteMap의 TRAFFIC_COLORS와 동일한 코드계다.
 */
export function congestionState(speedKmh: number, rank: number): number {
  return calibratedFlowState(speedKmh, rank);
}

const DIR = join(process.cwd(), "src/lib/data/nodelink");
let index: NodelinkIndex | null | undefined;

function bytes(path: string): SharedArrayBuffer {
  return readRoadBinary(path);
}

function loadNodelink(): NodelinkIndex | null {
  if (index !== undefined) return index;
  const endLoad = startLoopStage("local.nodelinkIndexLoad");
  try {
    const metaPath = join(DIR, "meta.json");
    if (!existsSync(metaPath)) { index = null; return index; }
    const meta = JSON.parse(readFileSync(metaPath, "utf8")) as Meta;
    if (meta.version !== 2 && meta.version !== 3) {
      throw new Error(`지원하지 않는 버전 ${meta.version}`);
    }
    const ids = new BigUint64Array(bytes(join(DIR, "link-ids.bin")));
    const rank = new Uint8Array(bytes(join(DIR, "link-rank.bin")));
    const maxSpeed = new Uint8Array(bytes(join(DIR, "link-maxspeed.bin")));
    const lanes = new Uint8Array(bytes(join(DIR, "link-lanes.bin")));
    const ft = new Uint32Array(bytes(join(DIR, "link-fromto.bin")));
    const geom = new Float32Array(bytes(join(DIR, "geom.bin")));
    const gi = new Uint32Array(bytes(join(DIR, "geom-index.bin")));
    const gridKeys = new Int32Array(bytes(join(DIR, "grid-keys.bin")));
    const gridOffsets = new Uint32Array(bytes(join(DIR, "grid-offsets.bin")));
    const gridLinks = new Uint32Array(bytes(join(DIR, "grid-links.bin")));
    let adjOffsets: Uint32Array | undefined;
    let adjLinks: Uint32Array | undefined;
    if (meta.version >= 3) {
      try {
        adjOffsets = new Uint32Array(bytes(join(DIR, "adj-offsets.bin")));
        adjLinks = new Uint32Array(bytes(join(DIR, "adj-links.bin")));
      } catch {
        // 인접 그래프가 없어도 노드 일치로 경로를 매칭할 수 있다.
      }
    }
    let roadIndex: Uint32Array | undefined;
    let roadTable: RoadMeta[] | undefined;
    try {
      roadIndex = new Uint32Array(bytes(join(DIR, "link-road-index.bin")));
      roadTable = JSON.parse(readFileSync(join(DIR, "road-table.json"), "utf8")) as RoadMeta[];
      if (roadIndex.length !== meta.links || !Array.isArray(roadTable) || roadTable.length === 0) {
        roadIndex = undefined;
        roadTable = undefined;
      }
    } catch {
      // 도로명 보강 데이터가 없어도 경로 탐색은 동작한다.
    }
    let routeDirection: Uint8Array | undefined;
    try {
      const rd = new Uint8Array(bytes(join(DIR, "link-route-direction.bin")));
      if (rd.length === meta.links) routeDirection = rd;
    } catch {
      // 도로망 자료를 가져오기 전에는 KTDB 매핑 없이 동작한다.
    }
    let roadType: Uint8Array | undefined;
    try {
      const rt = new Uint8Array(bytes(join(DIR, "link-roadtype.bin")));
      if (rt.length === meta.links) roadType = rt;
    } catch {
      // 도로 구조(고가·지하)는 선택 자료 — 없으면 층 판정을 안 한다.
    }
    if (
      ids.length !== meta.links ||
      rank.length !== meta.links ||
      maxSpeed.length !== meta.links ||
      lanes.length !== meta.links ||
      ft.length !== meta.links * 2 ||
      geom.length !== meta.geometryPoints * 2 ||
      gi.length !== meta.links * 2 ||
      gridKeys.length !== meta.gridCells ||
      gridOffsets.length !== meta.gridCells + 1
    ) {
      throw new Error("meta와 바이너리 길이가 다름");
    }
    index = {
      meta,
      ids,
      rank,
      maxSpeed,
      lanes,
      linkFrom: ft.subarray(0, meta.links),
      linkTo: ft.subarray(meta.links),
      geom,
      geomOff: gi.subarray(0, meta.links),
      geomCnt: gi.subarray(meta.links),
      gridKeys,
      gridOffsets,
      gridLinks,
      adjOffsets,
      adjLinks,
      roadIndex,
      roadTable,
      routeDirection,
      roadType,
    };
  } catch (error) {
    console.error("[nodelink] 인덱스 로딩 실패:", error);
    index = null;
  } finally {
    endLoad?.({ available: !!index, links: index?.meta.links ?? 0 });
  }
  return index;
}

/** 오프라인 crosswalk가 저장한 0-based 인덱스를 실제 LINK_ID/등급으로 변환. */
export function nodelinkAt(indexValue: number): {
  linkId: string; rank: number; roadName?: string; roadNo?: string; routeDirection?: 1 | 2;
} | null {
  const idx = loadNodelink();
  if (!idx || indexValue < 0 || indexValue >= idx.ids.length) return null;
  const road = idx.roadIndex && idx.roadTable
    ? idx.roadTable[idx.roadIndex[indexValue]]
    : undefined;
  return {
    linkId: idx.ids[indexValue].toString(),
    rank: idx.rank[indexValue],
    ...(road?.name ? { roadName: road.name } : {}),
    ...(road?.no && road.no !== "-" ? { roadNo: road.no } : {}),
    ...(idx.routeDirection?.[indexValue] === 1 || idx.routeDirection?.[indexValue] === 2
      ? { routeDirection: idx.routeDirection[indexValue] as 1 | 2 } : {}),
  };
}

const cellKey = (cell: number, lat: number, lng: number) =>
  Math.floor(lat / cell) * 100_000 + Math.floor(lng / cell);
const angDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

function lowerBound(a: Int32Array, value: number): number {
  let lo = 0;
  let hi = a.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (a[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function distanceToLink(
  idx: NodelinkIndex,
  link: number,
  p: LatLng,
): { distanceM: number; bearingDeg: number } {
  const off = idx.geomOff[link];
  const count = idx.geomCnt[link];
  const lonM = Math.cos((p.lat * Math.PI) / 180) * 111_320;
  let best = Infinity;
  let bestSq = Infinity;
  let bestBearing = 0;
  for (let i = 1; i < count; i++) {
    const aLat = idx.geom[(off + i - 1) * 2];
    const aLng = idx.geom[(off + i - 1) * 2 + 1];
    const bLat = idx.geom[(off + i) * 2];
    const bLng = idx.geom[(off + i) * 2 + 1];
    const ax = (aLng - p.lng) * lonM;
    const ay = (aLat - p.lat) * 110_540;
    const dx = (bLng - aLng) * lonM;
    const dy = (bLat - aLat) * 110_540;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx;
    const py = ay + t * dy;
    // 제곱거리로 먼저 거른다(상한에 1e-9 여유) — Math.hypot은 더 가까울 수 있는 구간에서만 부른다.
    if (px * px + py * py <= bestSq) {
      const d = Math.hypot(px, py);
      if (d < best) {
        best = d;
        bestSq = d * d * (1 + 1e-9);
        bestBearing = (Math.atan2(dx, dy) * 180) / Math.PI;
      }
    }
  }
  return { distanceM: best, bearingDeg: bestBearing };
}

/**
 * 링크별 경계 상자(최소·최대 위경도) — 점에서 멀리 떨어진 링크는 구간별 거리 계산(distanceToLink)을
 * 건너뛰기 위한 것이다. 경계 상자까지의 거리는 실제 링크까지의 거리보다 작거나 같으므로
 * (같은 미터 환산을 쓴다) 건너뛴 링크는 원래도 반경 밖이라 결과는 그대로다.
 * 링크 geometry는 float32라 경계 상자도 정확히 같은 값이다. 처음 쓰는 링크만 계산한다.
 */
let bboxOf: NodelinkIndex | null = null;
let bboxReady = new Uint8Array(0);
let bboxVals = new Float32Array(0);
function linkBbox(idx: NodelinkIndex, link: number): number {
  if (bboxOf !== idx) {
    bboxOf = idx;
    bboxReady = new Uint8Array(idx.ids.length);
    bboxVals = new Float32Array(idx.ids.length * 4);
  }
  const base = link * 4;
  if (bboxReady[link] === 0) {
    const off = idx.geomOff[link];
    const count = idx.geomCnt[link];
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    // 점이 둘 미만인 링크는 distanceToLink가 Infinity를 돌려주므로 빈 상자(= 항상 건너뜀)로 둔다.
    if (count >= 2) {
      for (let i = 0; i < count; i++) {
        const lat = idx.geom[(off + i) * 2];
        const lng = idx.geom[(off + i) * 2 + 1];
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lng < minLng) minLng = lng;
        if (lng > maxLng) maxLng = lng;
      }
    }
    bboxVals[base] = minLat;
    bboxVals[base + 1] = maxLat;
    bboxVals[base + 2] = minLng;
    bboxVals[base + 3] = maxLng;
    bboxReady[link] = 1;
  }
  return base;
}

/**
 * 점 주변 표준노드링크를 거리순으로 반환한다. 링크 geometry는 F_NODE→T_NODE
 * 방향이므로 heading이 있으면 역방향 링크를 하드 게이트해 반대차로 오매칭을 막는다.
 */
interface IndexedNodelinkMatch extends NodelinkMatch {
  linkIndex: number;
}

function nearbyIndexedNodelinks(
  point: LatLng,
  headingDeg?: number | null,
  maxDistanceM = 70,
  maxHeadingDiffDeg = 60,
): IndexedNodelinkMatch[] {
  const idx = loadNodelink();
  if (!idx) return [];
  const cell = idx.meta.cellSizeDeg;
  const cy = Math.floor(point.lat / cell);
  const cx = Math.floor(point.lng / cell);
  const seen = new Set<number>();
  const out: IndexedNodelinkMatch[] = [];
  const lonM = Math.cos((point.lat * Math.PI) / 180) * 111_320;
  const skipM2 = (maxDistanceM + 0.001) * (maxDistanceM + 0.001);
  // 반경은 70m지만 경계에 걸친 링크를 위해 중심 셀과 8개 이웃을 본다.
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      const key = y * 100_000 + x;
      const cellIndex = lowerBound(idx.gridKeys, key);
      if (cellIndex >= idx.gridKeys.length || idx.gridKeys[cellIndex] !== key) continue;
      for (let p = idx.gridOffsets[cellIndex]; p < idx.gridOffsets[cellIndex + 1]; p++) {
        const link = idx.gridLinks[p];
        if (seen.has(link)) continue;
        seen.add(link);
        // 경계 상자까지가 이미 반경 밖이면 구간별 계산을 건너뛴다(미터 환산은 distanceToLink와 같다).
        const b = linkBbox(idx, link);
        const dx = Math.max(0, bboxVals[b + 2] - point.lng, point.lng - bboxVals[b + 3]) * lonM;
        const dy = Math.max(0, bboxVals[b] - point.lat, point.lat - bboxVals[b + 1]) * 110_540;
        if (dx * dx + dy * dy > skipM2) continue;
        const hit = distanceToLink(idx, link, point);
        if (hit.distanceM > maxDistanceM) continue;
        const diff = headingDeg == null ? null : angDiff(headingDeg, hit.bearingDeg);
        if (diff != null && diff > maxHeadingDiffDeg) continue;
        const road = idx.roadIndex && idx.roadTable
          ? idx.roadTable[idx.roadIndex[link]]
          : undefined;
        out.push({
          linkIndex: link,
          linkId: idx.ids[link].toString(),
          rank: idx.rank[link],
          maxSpeedKmh: idx.maxSpeed[link],
          lanes: idx.lanes[link],
          fromNodeIndex: idx.linkFrom[link],
          toNodeIndex: idx.linkTo[link],
          distanceM: hit.distanceM,
          bearingDeg: hit.bearingDeg,
          headingDiffDeg: diff,
          ...(road?.name ? { roadName: road.name } : {}),
          ...(road?.no && road.no !== "-" ? { roadNo: road.no } : {}),
          ...(idx.routeDirection?.[link] === 1 || idx.routeDirection?.[link] === 2
            ? { routeDirection: idx.routeDirection[link] as 1 | 2 } : {}),
        });
      }
    }
  }
  return out.sort((a, b) => {
    // 같은 도로의 평행 링크끼리는 방위가 더 맞는 쪽을 우선한다.
    const ah = a.headingDiffDeg ?? 0;
    const bh = b.headingDiffDeg ?? 0;
    return a.distanceM + ah * 0.15 - (b.distanceM + bh * 0.15);
  });
}

export function nearbyNodelinks(
  point: LatLng,
  headingDeg?: number | null,
  maxDistanceM = 70,
  maxHeadingDiffDeg = 60,
): NodelinkMatch[] {
  return nearbyIndexedNodelinks(point, headingDeg, maxDistanceM, maxHeadingDiffDeg)
    .map(({ linkIndex: _linkIndex, ...match }) => match);
}

export interface NodelinkLinkRun {
  fromM: number;
  toM: number;
  linkId: string;
  fromNodeIndex: number;
  toNodeIndex: number;
  roadName?: string;
  roadNo?: string;
  routeDirection?: 1 | 2;
}

export interface NodelinkRoadRun {
  fromM: number;
  toM: number;
  roadName?: string;
  roadNo?: string;
}

export interface NodelinkPathMatch {

  linkIds: string[];

  linkRuns: NodelinkLinkRun[];

  roadRuns: NodelinkRoadRun[];

  coverage: number;

  meanDistanceM: number;

  continuity: number;
  sampleCount: number;
}

function routeBearing(a: LatLng, b: LatLng): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * 111_320;
  return (Math.atan2((b.lng - a.lng) * k, (b.lat - a.lat) * 110_540) * 180) / Math.PI;
}

function routeDistanceM(a: LatLng, b: LatLng): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * 111_320;
  return Math.hypot((b.lng - a.lng) * k, (b.lat - a.lat) * 110_540);
}

function resampleRoute(path: LatLng[], stepM: number): { point: LatLng; heading: number; alongM: number }[] {
  const out: { point: LatLng; heading: number; alongM: number }[] = [];
  let baseM = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const len = routeDistanceM(a, b);
    if (!(len > 0.2)) continue;
    const heading = routeBearing(a, b);
    const pieces = Math.max(1, Math.ceil(len / stepM));
    for (let k = i === 1 ? 0 : 1; k <= pieces; k++) {
      const t = k / pieces;
      out.push({
        point: { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t },
        heading,
        alongM: baseM + len * t,
      });
    }
    baseM += len;
  }
  return out;
}

function transitionHops(idx: NodelinkIndex, fromLink: number, toLink: number): number {
  if (fromLink === toLink) return 0;
  if (idx.linkTo[fromLink] === idx.linkFrom[toLink]) return 1;
  const off = idx.adjOffsets, links = idx.adjLinks;
  if (!off || !links) return 99;
  const node = idx.linkTo[fromLink];
  for (let p = off[node]; p < off[node + 1]; p++) {
    const mid = links[p];
    if (mid === toLink || idx.linkTo[mid] === idx.linkFrom[toLink]) return 2;
  }
  return 99;
}

// 개별 최근접점 대신 경로 방향과 그래프 연결을 함께 사용해 평행 도로와 교차로를 구분한다.
export function matchPathNodelinks(path: LatLng[], stepM = 25): NodelinkPathMatch {
  const idx = loadNodelink();
  if (!idx || path.length < 2) {
    return { linkIds: [], linkRuns: [], roadRuns: [], coverage: 0, meanDistanceM: 0, continuity: 0, sampleCount: 0 };
  }
  const samples = resampleRoute(path, Math.max(10, Math.min(50, stepM)));
  const chosen: IndexedNodelinkMatch[] = [];
  const chosenAlong: number[] = [];
  const chosenBreak: boolean[] = [];
  let matchedSamples = 0;
  let distanceSum = 0;

  // 표준 링크가 없는 구간을 건너뛴 뒤 다음 도로까지 잘못된 평행 링크로 끌려가지 않게 매칭을 나눈다.
  let states: { c: IndexedNodelinkMatch; cost: number; prev: number }[] | null = null;
  let layers: { c: IndexedNodelinkMatch; cost: number; prev: number }[][] = [];
  let layerAlong: number[] = [];
  const flush = () => {
    if (!states || layers.length === 0) return;
    let best = 0;
    for (let i = 1; i < states.length; i++) if (states[i].cost < states[best].cost) best = i;
    const seq: IndexedNodelinkMatch[] = new Array(layers.length);
    for (let l = layers.length - 1; l >= 0; l--) {
      const st = layers[l][best];
      seq[l] = st.c;
      best = st.prev;
      if (best < 0 && l > 0) best = 0;
    }
    const startsNewSegment = chosen.length > 0;
    chosen.push(...seq);
    chosenAlong.push(...layerAlong);
    chosenBreak.push(...seq.map((_, i) => startsNewSegment && i === 0));
    layers = [];
    layerAlong = [];
    states = null;
  };

  for (const sample of samples) {
    const candidates = nearbyIndexedNodelinks(sample.point, sample.heading, 45, 65).slice(0, 10);
    if (candidates.length === 0) { flush(); continue; }
    matchedSamples++;
    const next = candidates.map((c) => {
      const emission = c.distanceM + (c.headingDiffDeg ?? 0) * 0.28;
      if (!states) return { c, cost: emission, prev: -1 };
      let bestCost = Infinity, bestPrev = 0;
      for (let i = 0; i < states.length; i++) {
        const prev = states[i].c;
        const hops = transitionHops(idx, prev.linkIndex, c.linkIndex);
        // 연결된 링크를 우선하되 지도 누락 구간은 충분한 기하 근거가 있으면 통과시킨다.
        const transition = hops === 0 ? 0 : hops === 1 ? 0.6 : hops === 2 ? 3 : 38;
        const cost = states[i].cost + transition + emission;
        if (cost < bestCost) { bestCost = cost; bestPrev = i; }
      }
      return { c, cost: bestCost, prev: bestPrev };
    });
    layers.push(next);
    layerAlong.push(sample.alongM);
    states = next;
  }
  flush();

  const linkIds: string[] = [];
  let connected = 0, changes = 0;
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    distanceSum += c.distanceM;
    if (linkIds[linkIds.length - 1] !== c.linkId) linkIds.push(c.linkId);
    if (i > 0 && chosen[i - 1].linkIndex !== c.linkIndex) {
      changes++;
      if (transitionHops(idx, chosen[i - 1].linkIndex, c.linkIndex) <= 2) connected++;
    }
  }
  const cleanNo = (v?: string) => v && v !== "-" ? v : undefined;
  const linkRuns: NodelinkLinkRun[] = [];
  const roadRuns: NodelinkRoadRun[] = [];
  for (let i = 0; i < chosen.length; i++) {
    const c = chosen[i];
    const fromM = chosenAlong[i];
    const nextSameSegment = i + 1 < chosenAlong.length && !chosenBreak[i + 1];
    const toM = nextSameSegment ? chosenAlong[i + 1] : fromM;
    const roadNo = cleanNo(c.roadNo);
    const prevLink = linkRuns[linkRuns.length - 1];
    if (!chosenBreak[i] && prevLink && prevLink.linkId === c.linkId) {
      prevLink.toM = Math.max(prevLink.toM, toM);
    } else {
      linkRuns.push({
        fromM, toM, linkId: c.linkId,
        fromNodeIndex: c.fromNodeIndex,
        toNodeIndex: c.toNodeIndex,
        ...(c.roadName ? { roadName: c.roadName } : {}),
        ...(roadNo ? { roadNo } : {}),
        ...(c.routeDirection ? { routeDirection: c.routeDirection } : {}),
      });
    }
    const prevRoad = roadRuns[roadRuns.length - 1];
    if (!chosenBreak[i] && prevRoad && prevRoad.roadName === c.roadName && prevRoad.roadNo === roadNo) {
      prevRoad.toM = Math.max(prevRoad.toM, toM);
    } else {
      roadRuns.push({
        fromM, toM,
        ...(c.roadName ? { roadName: c.roadName } : {}),
        ...(roadNo ? { roadNo } : {}),
      });
    }
  }
  return {
    linkIds,
    linkRuns,
    roadRuns,
    coverage: samples.length ? matchedSamples / samples.length : 0,
    meanDistanceM: chosen.length ? distanceSum / chosen.length : 0,
    continuity: changes ? connected / changes : (chosen.length ? 1 : 0),
    sampleCount: samples.length,
  };
}

// matchPathNodelinks는 경로 전체를 한 번에 푼다. 실주행은 GPS가 한 점씩 오므로,
// 같은 "heading + 그래프 연속성" 원리를 점별로 이어간다. 순간 GPS 튐으로 평행
// 옆 도로/합류차선으로 스냅이 튀어도, 그 링크가 확정링크와 그래프상 끊겨 있으면
// (99홉) 곧바로 넘어가지 않고 속도비례 시간창 동안 지속돼야 전환한다. 좌·우회전과
// 우측 램프 이탈은 교차점 노드로 이어진 링크(≤2홉)라 지연 없이 즉시 전환한다.
export interface RoadTrackState {
  /** 현재 확정된 방향성 링크 인덱스. null이면 아직 미획득/그래프 밖. */
  committedLink: number | null;
  /** 확정링크와 끊긴 후보 위에서 이어 달린 누적 전진거리(m) — 튐 억제용. */
  deviationRunM: number;
  /** 직전 픽스 좌표(전진거리 계산용). */
  lastPoint: LatLng | null;
}

export interface RoadTrackResult {
  state: RoadTrackState;
  committedLinkId: string | null;
  roadName?: string;
  /** 이번 픽스에서 확정링크가 바뀌었나. */
  switched: boolean;
  /** 확정링크에서 지속적으로 벗어남이 확정됐나(재탐색/도로바뀜 트리거용). */
  departed: boolean;
  reason:
    | "acquired" // 최초 획득
    | "on-committed" // 여전히 확정링크 위
    | "connected" // 연결된 링크로 정상 전환(회전·직진 연속)
    | "held-jitter" // 끊긴 후보 — 지속 미달로 확정링크 유지(튐 억제)
    | "switched-sustained" // 끊긴 후보가 속도비례 지속 – 전환 확정
    | "no-link"; // 근처 링크 없음(그래프 공백)
  /** 확정링크까지 옆거리(m). 근처 후보에 없으면 null. */
  lateralM: number | null;
}

export const ROAD_TRACK_INIT: RoadTrackState = {
  committedLink: null,
  deviationRunM: 0,
  lastPoint: null,
};

const TRACK_SNAP_M = 45; // 후보 탐색 반경
const TRACK_HEADING_DIFF = 65; // 방향 필터(반대차로 배제)
const TRACK_ON_ROAD_M = 30; // 확정링크가 이 안이면 그대로 유지(관성)
const TRACK_WINDOW_S = 3.5; // 끊긴 후보 지속 시간창(속도 곱해 거리로)
const TRACK_FLOOR_M = 30; // 저속에서도 최소 이만큼은 벗어나야 전환
const TRACK_FAR_M = 120; // 이보다 멀면 지속 무시하고 즉시 전환

function trackPointDistM(a: LatLng, b: LatLng): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * 111_320;
  return Math.hypot((b.lng - a.lng) * k, (b.lat - a.lat) * 110_540);
}

/**
 * 확정링크 추적기 — 이전 상태 + 새 GPS 픽스 – 새 상태 + 판정.
 * speedMps는 실지면 속도(EMA 권장). heading이 null이면 방향 필터 없이 스냅.
 */
export function trackCommittedLink(
  prev: RoadTrackState,
  point: LatLng,
  headingDeg: number | null,
  speedMps: number,
): RoadTrackResult {
  const idx = loadNodelink();
  const travelM = prev.lastPoint ? trackPointDistM(prev.lastPoint, point) : 0;
  const mk = (
    s: Partial<RoadTrackState>,
    r: RoadTrackResult["reason"],
    extra: Partial<RoadTrackResult>,
  ): RoadTrackResult => {
    const committedLink = s.committedLink ?? null;
    return {
      state: {
        committedLink,
        deviationRunM: s.deviationRunM ?? 0,
        lastPoint: point,
      },
      committedLinkId:
        idx && committedLink != null ? idx.ids[committedLink].toString() : null,
      switched: false,
      departed: false,
      reason: r,
      lateralM: null,
      ...extra,
    };
  };

  if (!idx) return mk({ ...prev, lastPoint: point }, "no-link", {});
  const cands = nearbyIndexedNodelinks(point, headingDeg, TRACK_SNAP_M, TRACK_HEADING_DIFF);
  const best = cands[0] ?? null;
  const roadOf = (link: number | null) =>
    idx.roadIndex && idx.roadTable && link != null
      ? idx.roadTable[idx.roadIndex[link]]?.name
      : undefined;

  // 최초 획득 — 근처 링크가 있으면 붙잡는다.
  if (prev.committedLink == null) {
    if (!best) return mk({ committedLink: null, deviationRunM: 0 }, "no-link", {});
    return mk({ committedLink: best.linkIndex, deviationRunM: 0 }, "acquired", {
      roadName: roadOf(best.linkIndex),
      switched: true,
      lateralM: best.distanceM,
    });
  }

  // 확정링크가 여전히 근처(관성) — 그대로 유지, 누적 리셋.
  const stillOn = cands.find((c) => c.linkIndex === prev.committedLink);
  if (stillOn && stillOn.distanceM <= TRACK_ON_ROAD_M) {
    return mk({ committedLink: prev.committedLink, deviationRunM: 0 }, "on-committed", {
      roadName: roadOf(prev.committedLink),
      lateralM: stillOn.distanceM,
    });
  }

  // 근처에 후보가 아예 없음 — 그래프 공백/이탈. 확정링크는 유지하되 누적만 쌓는다.
  if (!best) {
    return mk(
      { committedLink: prev.committedLink, deviationRunM: prev.deviationRunM + travelM },
      "no-link",
      { roadName: roadOf(prev.committedLink) },
    );
  }

  const hops = transitionHops(idx, prev.committedLink, best.linkIndex);
  // 연결된 링크(≤2홉) = 좌·우회전, 우측 램프, 직진 연속 – 지연 없이 즉시 전환.
  if (hops <= 2) {
    return mk({ committedLink: best.linkIndex, deviationRunM: 0 }, "connected", {
      roadName: roadOf(best.linkIndex),
      switched: best.linkIndex !== prev.committedLink,
      lateralM: best.distanceM,
    });
  }

  // 끊긴 후보(평행 도로 튐 후보) — 속도비례 지속창을 넘겨야 전환 확정.
  const runM = prev.deviationRunM + travelM;
  const threshold = Math.max(speedMps * TRACK_WINDOW_S, TRACK_FLOOR_M);
  if (best.distanceM > TRACK_FAR_M || runM >= threshold) {
    return mk({ committedLink: best.linkIndex, deviationRunM: 0 }, "switched-sustained", {
      roadName: roadOf(best.linkIndex),
      switched: true,
      departed: true,
      lateralM: best.distanceM,
    });
  }
  // 아직 지속 미달 — 튐으로 보고 확정링크 유지.
  return mk({ committedLink: prev.committedLink, deviationRunM: runM }, "held-jitter", {
    roadName: roadOf(prev.committedLink),
    lateralM: stillOn ? stillOn.distanceM : null,
  });
}

export interface NodelinkGeom {
  linkId: string;
  rank: number;
  /** [lat, lng, lat, lng, ...] — 단순화된 링크 폴리라인 */
  coords: number[];
}

/**
 * bbox와 겹치는 셀에 속한 링크들의 지오메트리를 반환한다(정체 레이어 렌더용).
 * maxRank로 축소(줌아웃 시 주요도로만), limit로 상한을 두되 낮은 rank(=주요도로)
 * 부터 채운다. 그리드 셀 단위라 bbox를 살짝 넘는 링크도 포함될 수 있다.
 */
export function linksInBounds(
  minLat: number,
  minLng: number,
  maxLat: number,
  maxLng: number,
  maxRank = 7,
  limit = 6000,
): NodelinkGeom[] {
  const idx = loadNodelink();
  if (!idx) return [];
  const cell = idx.meta.cellSizeDeg;
  const y0 = Math.floor(minLat / cell);
  const y1 = Math.floor(maxLat / cell);
  const x0 = Math.floor(minLng / cell);
  const x1 = Math.floor(maxLng / cell);
  // 너무 넓은 bbox는 비용 폭발 — 셀 수를 캡한다(줌아웃은 maxRank로 걸러짐).
  if ((y1 - y0 + 1) * (x1 - x0 + 1) > 40_000) return [];
  const seen = new Set<number>();
  const buckets: NodelinkGeom[][] = Array.from({ length: 8 }, () => []);
  let total = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const key = y * 100_000 + x;
      const ci = lowerBound(idx.gridKeys, key);
      if (ci >= idx.gridKeys.length || idx.gridKeys[ci] !== key) continue;
      for (let p = idx.gridOffsets[ci]; p < idx.gridOffsets[ci + 1]; p++) {
        const link = idx.gridLinks[p];
        if (seen.has(link)) continue;
        seen.add(link);
        const rank = idx.rank[link];
        if (rank > maxRank) continue;
        const off = idx.geomOff[link];
        const cnt = idx.geomCnt[link];
        const coords: number[] = new Array(cnt * 2);
        for (let i = 0; i < cnt; i++) {
          coords[i * 2] = idx.geom[(off + i) * 2];
          coords[i * 2 + 1] = idx.geom[(off + i) * 2 + 1];
        }
        buckets[rank].push({ linkId: idx.ids[link].toString(), rank, coords });
        total++;
      }
    }
  }
  // 상한 초과 시 주요도로(낮은 rank)부터 채운다.
  if (total <= limit) return buckets.flat();
  const out: NodelinkGeom[] = [];
  for (let r = 1; r <= 7 && out.length < limit; r++) {
    for (const g of buckets[r]) {
      if (out.length >= limit) break;
      out.push(g);
    }
  }
  return out;
}

// 목적지 없는 주행에서 "지금 도로를 자연스럽게 계속 가면 어디로 가나"를 링크
// 사슬로 만든다. 네이버 지도 SafeGuiding의 StraightRouteGenerator와 같은 규칙:
// 교차로마다 통행 가능한 연결 중 ① 이상한 길(유턴급 꺾임·넓은 길에서 1차로)
// 후순위 ② 같은 도로등급 유지 ③ 가장 직진에 가까운 것과 10° 이내 ④ 차로 많은
// 것 ⑤ 등급 높은 것 ⑥ 가장 직진 — 순으로 하나를 고른다. 예측이 아니라 규칙이다.
const CHAIN_BEARING_SPAN_M = 15; // 끝점 미세 꼬리 무시(nodelink-route와 같은 이유)
const CHAIN_STRAIGHT_TOL = 10;
const CHAIN_UTURNISH = 135;

let chainTurnForbid: Set<number> | null | undefined;
let chainUnused: Uint8Array | null | undefined;
function chainSidecars(idx: NodelinkIndex): { forbid: Set<number> | null; unused: Uint8Array | null } {
  if (chainTurnForbid === undefined) {
    try {
      const t = new Uint32Array(bytes(join(process.cwd(), "src/lib/data/roadgraph/nodelink-turn-forbid.bin")));
      chainTurnForbid = new Set();
      // 링크 수가 2^21 미만이라 두 인덱스를 한 double 키로 안전하게 묶는다.
      for (let i = 0; i + 1 < t.length; i += 2) chainTurnForbid.add(t[i] * 4_194_304 + t[i + 1]);
    } catch { chainTurnForbid = null; }
  }
  if (chainUnused === undefined) {
    try {
      const f = new Uint8Array(bytes(join(DIR, "link-flags.bin")));
      chainUnused = f.length === idx.meta.links ? f : null;
    } catch { chainUnused = null; }
  }
  return { forbid: chainTurnForbid, unused: chainUnused };
}

function chainPt(idx: NodelinkIndex, link: number, j: number): LatLng {
  const i = idx.geomOff[link] + j;
  return { lat: idx.geom[i * 2], lng: idx.geom[i * 2 + 1] };
}
function chainBearing(a: LatLng, b: LatLng): number {
  const k = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * 111_320;
  return (Math.atan2((b.lng - a.lng) * k, (b.lat - a.lat) * 110_540) * 180) / Math.PI;
}
function chainInBearing(idx: NodelinkIndex, link: number): number {
  const n = idx.geomCnt[link], b = chainPt(idx, link, n - 1);
  let a = chainPt(idx, link, Math.max(0, n - 2));
  for (let j = n - 2; j >= 0; j--) { a = chainPt(idx, link, j); if (trackPointDistM(a, b) >= CHAIN_BEARING_SPAN_M) break; }
  return chainBearing(a, b);
}
function chainOutBearing(idx: NodelinkIndex, link: number): number {
  const n = idx.geomCnt[link], a = chainPt(idx, link, 0);
  let b = chainPt(idx, link, Math.min(1, n - 1));
  for (let j = 1; j < n; j++) { b = chainPt(idx, link, j); if (trackPointDistM(a, b) >= CHAIN_BEARING_SPAN_M) break; }
  return chainBearing(a, b);
}

/** 현재 링크 끝 교차로에서 네이버식 규칙으로 다음 링크 하나를 고른다. 없으면 -1. */
/** 직전 링크에서 앞으로 도로 연결을 따라 닿는 링크들(최대 60개 링크·3km) — 층 추적용 */
function reachableLinks(idx: NodelinkIndex, startIdx: number): Set<number> | null {
  const off = idx.adjOffsets, links = idx.adjLinks;
  if (!off || !links) return null;
  const seen = new Set<number>([startIdx]);
  const dist = new Map<number, number>([[startIdx, 0]]);
  const queue = [startIdx];
  while (queue.length && seen.size < 60) {
    const cur = queue.shift()!;
    const d = dist.get(cur)! + linkLenM(idx, cur);
    if (d > 3000) continue;
    const node = idx.linkTo[cur];
    for (let p = off[node]; p < off[node + 1]; p++) {
      const l = links[p];
      if (seen.has(l)) continue;
      seen.add(l);
      dist.set(l, d);
      queue.push(l);
    }
  }
  return seen;
}
function linkLenM(idx: NodelinkIndex, link: number): number {
  const a = chainPt(idx, link, 0), b = chainPt(idx, link, idx.geomCnt[link] - 1);
  return trackPointDistM(a, b);
}
function chainNext(idx: NodelinkIndex, cur: number, visited: Set<number>): number {
  const off = idx.adjOffsets, links = idx.adjLinks;
  if (!off || !links) return -1;
  const { forbid, unused } = chainSidecars(idx);
  const node = idx.linkTo[cur];
  const inB = chainInBearing(idx, cur);
  type C = { link: number; dev: number; strange: boolean };
  let cands: C[] = [];
  for (let p = off[node]; p < off[node + 1]; p++) {
    const link = links[p];
    if (visited.has(link)) continue;
    if (unused && (unused[link] & 15) !== 0) continue;
    if (forbid && forbid.has(cur * 4_194_304 + link)) continue;
    // 같은 두 노드를 되짚는 역방향 링크 = 제자리 유턴
    if (idx.linkTo[link] === idx.linkFrom[cur] && idx.linkFrom[link] === idx.linkTo[cur]) continue;
    const dev = Math.abs(((chainOutBearing(idx, link) - inB + 540) % 360) - 180);
    const strange = dev >= CHAIN_UTURNISH || (idx.lanes[link] === 1 && idx.lanes[cur] > 1);
    cands.push({ link, dev, strange });
  }
  if (!cands.length) return -1;
  if (cands.some((c) => !c.strange)) cands = cands.filter((c) => !c.strange);
  const sameRank = cands.filter((c) => idx.rank[c.link] === idx.rank[cur]);
  if (sameRank.length) cands = sameRank;
  const minDev = Math.min(...cands.map((c) => c.dev));
  cands = cands.filter((c) => c.dev <= minDev + CHAIN_STRAIGHT_TOL);
  const maxLanes = Math.max(...cands.map((c) => idx.lanes[c.link]));
  cands = cands.filter((c) => idx.lanes[c.link] === maxLanes);
  const topRank = Math.min(...cands.map((c) => idx.rank[c.link]));
  cands = cands.filter((c) => idx.rank[c.link] === topRank);
  return cands.reduce((a, b) => (b.dev < a.dev ? b : a)).link;
}

/** 도로 층: 0=지상 1=위(고가·교량) 2=아래(지하차도·터널), 모르면 null */
export type RoadLevel = 0 | 1 | 2;
function levelOf(idx: NodelinkIndex, link: number): RoadLevel | null {
  const t = idx.roadType?.[link];
  if (t === undefined || t === 255) return null;
  return t === 0 ? 0 : t === 1 || t === 3 ? 1 : 2;
}

/**
 * 단속카메라가 놓인 도로의 층(표준노드링크 ROAD_TYPE). 카메라 35m 안 링크 중
 * 공식 찍는 방향(±45°)과 맞는 것들의 층이 하나로 모이면 그 층.
 * 신호 단속 장비는 교차로·횡단보도 정지선에 있으니 지상 링크가 있으면 지상.
 * 근거가 모자라거나 엇갈리면 null(층으로 경고를 막지 않음).
 */
export function cameraNationalLevel(c: LatLng, dirBrg: number | null, signal: boolean): RoadLevel | null {
  const idx = loadNodelink();
  if (!idx?.roadType) return null;
  const near = nearbyIndexedNodelinks(c, dirBrg, CAMERA_LEVEL_SNAP_M, dirBrg == null ? 180 : 45);
  const levels = new Set<RoadLevel | null>(near.map((m) => levelOf(idx, m.linkIndex)));
  if (!near.length || levels.has(null)) return null;
  if (signal && levels.has(0)) return 0;
  if (dirBrg == null || levels.size !== 1) return null;
  return [...levels][0];
}
const CAMERA_LEVEL_SNAP_M = 35;

export interface ForwardChain {
  /** 현재 위치(링크 투영점)부터 앞으로 이어진 폴리라인 */
  path: LatLng[];
  linkIds: string[];
  /** 시작 링크 LINK_ID — 다음 조회 때 prevLinkId로 돌려주면 평행도로 튐을 막는다. */
  startLinkId: string;
  /** linkIds와 같은 순서 — 각 링크의 층(모르면 null)과 path 위 시작 거리(m) */
  linkLevels: (RoadLevel | null)[];
  linkStartM: number[];
  /** 지금 위치 근처(30m)에 층이 다른 같은 방향 도로가 없어 시작 링크의 층이 확실한지.
   *  고가 진입로·지하차도 입구처럼 위아래 도로가 붙어 있으면 GPS로는 어느 쪽인지 모른다. */
  startLevelSure: boolean;
}

/**
 * 현재 위치·진행방향에서 앞쪽 임시경로를 만든다. prevLinkId(직전 조회의 시작
 * 링크)가 여전히 30m 안 후보면 그 링크를 유지한다(평행 도로로 튀는 것 방지).
 */
export function forwardChainAt(
  point: LatLng,
  headingDeg: number | null,
  maxM = 1500,
  prevLinkId?: string | null,
): ForwardChain | null {
  const idx = loadNodelink();
  if (!idx || headingDeg == null) return null;
  const cands = nearbyIndexedNodelinks(point, headingDeg, TRACK_SNAP_M, TRACK_HEADING_DIFF);
  if (!cands.length) return null;
  let start = cands[0];
  if (prevLinkId) {
    const keep = cands.find((c) => idx.ids[c.linkIndex].toString() === prevLinkId && c.distanceM <= TRACK_ON_ROAD_M);
    if (keep) start = keep;
    else {
      // 층 추적: 직전 링크에서 도로 연결을 따라 갈 수 있는 링크를 먼저 고른다.
      // GPS는 위아래를 구분 못 해서 고가 위에서도 바로 아래 지상 도로가 더 가까울 수 있다.
      // 고가로 올라탄 뒤엔 연결상 그 아래 도로로 갈 수 없으니 고가 링크가 유지된다.
      const prev = nearbyIndexedNodelinks(point, null, 600, 180).find((m) => m.linkId === prevLinkId);
      const reach = prev ? reachableLinks(idx, prev.linkIndex) : null;
      const linked = reach && cands.find((c) => reach.has(c.linkIndex) && c.distanceM <= TRACK_ON_ROAD_M);
      if (linked) start = linked;
    }
  }
  const s = start.linkIndex;
  // 시작 링크에서 투영 위치 이후 점만 쓴다
  const n = idx.geomCnt[s];
  let bestSeg = 0, bestD = Infinity, proj = chainPt(idx, s, 0);
  const k = Math.cos((point.lat * Math.PI) / 180) * 111_320;
  for (let j = 1; j < n; j++) {
    const a = chainPt(idx, s, j - 1), b = chainPt(idx, s, j);
    const dx = (b.lng - a.lng) * k, dy = (b.lat - a.lat) * 110_540;
    const px = (point.lng - a.lng) * k, py = (point.lat - a.lat) * 110_540, L = dx * dx + dy * dy;
    const t = L ? Math.max(0, Math.min(1, (px * dx + py * dy) / L)) : 0;
    const d = Math.hypot(px - t * dx, py - t * dy);
    if (d < bestD) { bestD = d; bestSeg = j - 1; proj = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t }; }
  }
  const path: LatLng[] = [proj];
  let total = 0;
  const push = (p: LatLng) => {
    const last = path[path.length - 1];
    const d = trackPointDistM(last, p);
    if (d > 0.2) { path.push(p); total += d; }
  };
  for (let j = bestSeg + 1; j < n; j++) push(chainPt(idx, s, j));
  const linkIds = [idx.ids[s].toString()];
  const linkLevels: (RoadLevel | null)[] = [levelOf(idx, s)];
  const linkStartM = [0];
  const visited = new Set<number>([s]);
  let cur = s;
  while (total < maxM) {
    const next = chainNext(idx, cur, visited);
    if (next < 0) break;
    visited.add(next);
    linkIds.push(idx.ids[next].toString());
    linkLevels.push(levelOf(idx, next));
    linkStartM.push(total);
    for (let j = 1; j < idx.geomCnt[next]; j++) push(chainPt(idx, next, j));
    cur = next;
  }
  const startLevel = levelOf(idx, s);
  const startLevelSure = startLevel != null && cands.every(
    (c) => c.distanceM > TRACK_ON_ROAD_M || levelOf(idx, c.linkIndex) === startLevel,
  );
  return { path, linkIds, startLinkId: linkIds[0], linkLevels, linkStartM, startLevelSure };
}
