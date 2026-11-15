import "server-only";

import { loopCount, startLoopStage } from "@/lib/loop-timing";

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readRoadBinary } from "@/lib/shared-road-binaries";

import { nearestLinkSpeedKmh, nodelinkSpeedKmh, trafficAvailable } from "@/lib/its-speed";
import { roadNameAt } from "@/lib/road-names";
import { CAMERA_ROAD_SNAP_M } from "@/lib/camera-road";
import { readRoadLevelMetadata } from "@/lib/road-level-metadata";
import type { RoadLevelEdge } from "@/lib/camera-road-level";
import { nodelinkAt } from "@/lib/nodelink";
import { accessLeg } from "./access-route";
import {
  EXPLORE_HEURISTIC_SCALE,
  exploreVisitLimit,
  nodelinkTargetConnected,
  nativeNodelinkRoutes,
  type NativeNodelinkRoute,
} from "@/lib/nodelink-route";
import type { LatLng } from "@/lib/types";

/**
 * 표준노드링크 방향 그래프를 우선하고 전국 OSM 그래프를 폴백으로 쓰는
 * 독립 로컬 라우터.
 *
 * 용도: 후보 "탐색" 단계의 연결다리(진입/복귀/gap) 라우팅을 카카오 대신
 * 로컬 A*로 처리해 API 호출을 최종 검증 몇 건으로 줄인다. 교통·신호가 없는
 * 추정치라 순위 비교용으로 쓰고, 사용자에게 보여줄 최종 후보만 카카오로
 * 실측한다 (쿼터 소진 시엔 로컬 추정치가 폴백이 된다).
 */

// build-road-graph.mjs의 CLASSES 순서와 일치
const SPEED_KMH = [90, 50, 80, 50, 65, 45, 55, 45, 45, 40, 35, 25, 15];
/** 신호·교차로 지체 보정 — A* 순수 주행시간에 곱한다 (카카오 실측 대비 보정) */
const DUR_CALIB = 1.25;

// 군사지역 회피 — landuse=military 폴리곤을 래스터화한 블록 셀
// (build-military-from-osm.mjs). A*가 이 셀의 노드를 통과하지 않게 해
// "군부대 안 도로"로 안내하는 걸 막는다.
const MIL_CELL = 0.0012; // build-military-from-osm.mjs의 MCELL과 일치해야 함
let milSet: Set<number> | null = null;
function milBlocked(lat: number, lng: number): boolean {
  if (milSet === null) {
    try {
      const arr: number[] = JSON.parse(
        readFileSync(join(process.cwd(), "src/lib/data/military-cells.json"), "utf8"),
      );
      milSet = new Set(arr);
    } catch {
      milSet = new Set();
    }
  }
  if (milSet.size === 0) return false;
  return milSet.has(
    Math.floor(lat / MIL_CELL) * 1_000_000 + Math.floor(lng / MIL_CELL),
  );
}
/**
 * 군사지역 셀 안 노드로 들어가는 간선인지. 3차로(tertiary) 이상 공공도로는
 * 부대 옆·위를 지나가도 막지 않는다 — 부대 안 도로는 unclassified 이하다.
 */
function milRoadBlocked(g: Graph, state: number): boolean {
  if ((g.eCls[g.adjEdge[state]] & 127) < 10) return false;
  const v = g.adjTo[state];
  return milBlocked(g.nLat[v], g.nLng[v]);
}

/**
 * 도심 정체 보정 — 카카오 없이 로컬 그래프만으로. 경로 200m 간격 샘플에서
 * 120m 안 실교차로 유무로 "교차로/km"를 재고, 높을수록 정체로 본다.
 * 카카오 실측 회귀(200m/120m 지표): 교외·산간 1.3~1.4/km–×1.0,
 * 서울역출발 1.9–×~1.2, 부산도심 3.4–×~1.8, 강남도심 2.4–×~1.4.
 * mul = 1 + K·max(jpk−D0, 0), 상한 CAP. 이 앱의 실사용(수시간 경치 루프)은
 * 대부분 교외·시골 주행이라 로컬이 이미 정확하고, 보정은 도심 진입/복귀
 * 구간에만 완만하게 작용한다. (짧은 도심 통근은 과소평가가 남지만 드라이브
 * 코스엔 거의 없음)
 */
const CONG_K = 0.38;
const CONG_D0 = 1.3; // 교차로/km, 이 이하(교외·산간)는 정체 페널티 없음
const CONG_CAP = 2.0;
const SAMPLE_STEP_M = 200; // 정체 노출 샘플 간격 (고정=측정 안정)

/**
 * 실측 피팅 보정 — scripts/calibrate-time.ts(표본 수집) – fit-time-calib.ts
 * (피팅)가 만든 time-calib.json이 있으면 위 기본 상수 대신 쓴다.
 * hourProfile은 (평일/주말, KST 시각)별 잔차 배율 — 표본이 쌓인 시간대만
 * 채워지고 나머지는 1.0. ※ 위 기본 상수를 바꾸면 fit-time-calib.ts의
 * OLD도 같이 바꿔야 한다 (rawDur 역산용).
 */
interface TimeCalib {
  calib: number;
  k: number;
  d0: number;
  cap: number;
  hourProfile: { weekday: Record<string, number>; weekend: Record<string, number> };
}
const CALIB_DEFAULTS: TimeCalib = {
  calib: DUR_CALIB,
  k: CONG_K,
  d0: CONG_D0,
  cap: CONG_CAP,
  hourProfile: { weekday: {}, weekend: {} },
};
const CALIB_PATH = join(process.cwd(), "src/lib/data/time-calib.json");
let calibCache: TimeCalib = CALIB_DEFAULTS;
let calibCheckedAt = 0;
let calibMtime = 0;

/**
 * 보정 상수 — 크론이 재피팅해도 서버 재시작 없이 반영되게 5분마다 mtime을
 * 확인해 핫리로드한다. 파일이 없으면 기본 상수.
 */
function timeCalib(): TimeCalib {
  const now = Date.now();
  if (now - calibCheckedAt > 300_000) {
    calibCheckedAt = now;
    try {
      const mt = statSync(CALIB_PATH).mtimeMs;
      if (mt !== calibMtime) {
        calibMtime = mt;
        calibCache = {
          ...CALIB_DEFAULTS,
          ...JSON.parse(readFileSync(CALIB_PATH, "utf8")),
        };
      }
    } catch {
      calibCache = CALIB_DEFAULTS;
    }
  }
  return calibCache;
}

/** 현재 KST 시각의 시간대 배율 — 그 시각 표본이 없으면 1.0 */
function hourMulNow(): number {
  const now = new Date();
  const kst = new Date(now.getTime() + (9 * 60 + now.getTimezoneOffset()) * 60_000);
  const day = kst.getDay() === 0 || kst.getDay() === 6 ? "weekend" : "weekday";
  return timeCalib().hourProfile[day]?.[String(kst.getHours())] ?? 1;
}

/**
 * ITS ETA 시간대별 보정 — ITS 구간 시간(native.itsSec)에 곱한다. itsSpeedScale은
 * 저교통 시간대(아침·심야)엔 ITS 순간속도를 과도하게 올려 ETA를 과소추정하므로
 * (실측: 저녁 -5%, 오전 -13.8%), KST 시각별 잔차 배율로 보정한다. 미측정 시각은
 * 1.0. scripts/nav-eval/fit-its-hour.mjs가 카카오 비교로 EWMA 갱신, 5분 핫리로드.
 */
const ITS_HOUR_PATH = join(process.cwd(), "src/lib/data/its-hour-calib.json");
let itsHourCache: { weekday: Record<string, number>; weekend: Record<string, number> } = {
  weekday: {},
  weekend: {},
};
let itsHourCheckedAt = 0;
let itsHourMtime = 0;
function itsHourMulNow(): number {
  const now = Date.now();
  if (now - itsHourCheckedAt > 300_000) {
    itsHourCheckedAt = now;
    try {
      const mt = statSync(ITS_HOUR_PATH).mtimeMs;
      if (mt !== itsHourMtime) {
        itsHourMtime = mt;
        const j = JSON.parse(readFileSync(ITS_HOUR_PATH, "utf8"));
        itsHourCache = { weekday: j.weekday ?? {}, weekend: j.weekend ?? {} };
      }
    } catch {
      itsHourCache = { weekday: {}, weekend: {} };
    }
  }
  const d = new Date();
  const kst = new Date(d.getTime() + (9 * 60 + d.getTimezoneOffset()) * 60_000);
  const day = kst.getDay() === 0 || kst.getDay() === 6 ? "weekend" : "weekday";
  const m = itsHourCache[day]?.[String(kst.getHours())];
  return Number.isFinite(m) && m > 0 ? m : 1;
}
// ITS 실측이 도로급 기본값보다 빠를 수도 있으므로 휴리스틱 상한을 넉넉히 둔다.
const MAX_SPEED_MPS = 130 / 3.6;

const DIR = join(process.cwd(), "src/lib/data/roadgraph");

interface Graph {
  nLat: Float64Array;
  nLng: Float64Array;
  // CSR 인접: adjOff[i]..adjOff[i+1] 구간의 adjEdge = 간선 인덱스, adjTo = 상대 노드
  adjOff: Uint32Array;
  adjFrom: Uint32Array;
  adjTo: Uint32Array;
  adjEdge: Uint32Array;
  eA: Uint32Array;
  eB: Uint32Array;
  eLen: Float32Array;
  eCls: Uint8Array;
  /** OSM maxspeed km/h (0=미태그) — 상시 제한속도 조회용 */
  eMax: Uint8Array;
  /** 단속카메라 제한속도 전파값 km/h (0=없음) — build-cam-limits.mjs 산출.
   *  경찰청 단속값이라 태그와 동급 신뢰의 "확정" 제한속도로 쓴다 */
  eCamLimit: Uint8Array;
  /** 자동차전용도로(motorroad=yes) 1/0 — trunk 올림픽대로 등 고속 취급 판정 */
  eMotor: Uint8Array;
  /** 구조물 — 1=고가도로(bridge), 2=지하차도/터널(tunnel), 0=없음. 진입 안내용 */
  eStruct: Uint8Array;
  eGeomOff: Uint32Array;
  eGeomCnt: Uint32Array;
  geom: Float32Array;
  /** 방향별 표준노드링크 index+1. mid=[a–b,b–a], turn=[fSrc,fDst,rSrc,rDst]. */
  eNlMidF: Uint32Array;
  eNlMidR: Uint32Array;
  eNlFSrc: Uint32Array;
  eNlFDst: Uint32Array;
  eNlRSrc: Uint32Array;
  eNlRDst: Uint32Array;
  /** 전일제 승용차 금지회전: (fromIndex << 32) | toIndex */
  forbiddenTurns: Set<bigint>;
  grid: Map<number, number[]>; // 노드 공간 색인
  /** 본선 SCC 소속 여부 — 일방통행 막다른 포켓 노드에 스냅하는 것을 막는다 */
  ok: Uint8Array | null;
  /** 간선 인덱스 – 분기·출구 방면(destination) — 램프 위주, 없으면 미포함 */
  dest: Map<number, { d?: string; r?: string }> | null;
}

const GRID_CELL = 0.005;
const gkey = (lat: number, lng: number) =>
  Math.floor(lat / GRID_CELL) * 100000 + Math.floor(lng / GRID_CELL) + 2_000_000_000;

let graph: Graph | null = null;
function loadGraph(): Graph | null {
  if (graph) return graph;
  const endLoad = startLoopStage("local.osmGraphLoad");
  try {
    const nodes = new Float64Array(readRoadBinary(join(DIR, "nodes.bin")));
    const n = nodes.length / 2;
    const nLat = new Float64Array(n);
    const nLng = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      nLat[i] = nodes[i * 2];
      nLng[i] = nodes[i * 2 + 1];
    }
    const ab = new Uint32Array(readRoadBinary(join(DIR, "edges-ab.bin")));
    const m = ab.length / 2;
    const eA = ab.subarray(0, m);
    const eB = ab.subarray(m);
    const eLen = new Float32Array(readRoadBinary(join(DIR, "edges-len.bin")));
    const eCls = new Uint8Array(readRoadBinary(join(DIR, "edges-cls.bin")));
    // maxspeed 바이너리 (구버전 그래프엔 없을 수 있어 0 배열로 폴백)
    let eMax: Uint8Array;
    try {
      eMax = new Uint8Array(readRoadBinary(join(DIR, "edges-maxspeed.bin")));
      if (eMax.length !== eCls.length) eMax = new Uint8Array(eCls.length);
    } catch {
      eMax = new Uint8Array(eCls.length);
    }
    // 단속카메라 전파 제한속도 (없으면 0 배열 — 미빌드 그래프 호환)
    let eCamLimit: Uint8Array;
    try {
      eCamLimit = new Uint8Array(readRoadBinary(join(DIR, "edges-camlimit.bin")));
      if (eCamLimit.length !== eCls.length) eCamLimit = new Uint8Array(eCls.length);
    } catch {
      eCamLimit = new Uint8Array(eCls.length);
    }
    // 자동차전용도로 비트 (구버전 그래프엔 없을 수 있어 0 배열로 폴백)
    let eMotor: Uint8Array;
    try {
      eMotor = new Uint8Array(readRoadBinary(join(DIR, "edges-motorroad.bin")));
      if (eMotor.length !== eCls.length) eMotor = new Uint8Array(eCls.length);
    } catch {
      eMotor = new Uint8Array(eCls.length);
    }
    // 구조물 비트 (구버전 그래프엔 없을 수 있어 0 배열로 폴백)
    let eStruct: Uint8Array;
    try {
      eStruct = new Uint8Array(readRoadBinary(join(DIR, "edges-struct.bin")));
      if (eStruct.length !== eCls.length) eStruct = new Uint8Array(eCls.length);
    } catch {
      eStruct = new Uint8Array(eCls.length);
    }
    const gi = new Uint32Array(readRoadBinary(join(DIR, "edges-geom-idx.bin")));
    const eGeomOff = gi.subarray(0, m);
    const eGeomCnt = gi.subarray(m);
    const geom = new Float32Array(readRoadBinary(join(DIR, "geom.bin")));

    // CSR 인접 리스트 (oneway: 상위비트 128 – a–b만)
    const deg = new Uint32Array(n + 1);
    for (let e = 0; e < m; e++) {
      deg[eA[e] + 1]++;
      if (!(eCls[e] & 128)) deg[eB[e] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adjOff = deg;
    const total = adjOff[n];
    const adjFrom = new Uint32Array(total);
    const adjTo = new Uint32Array(total);
    const adjEdge = new Uint32Array(total);
    const cursor = new Uint32Array(n);
    for (let e = 0; e < m; e++) {
      const a = eA[e],
        b = eB[e];
      let p = adjOff[a] + cursor[a]++;
      adjFrom[p] = a;
      adjTo[p] = b;
      adjEdge[p] = e;
      if (!(eCls[e] & 128)) {
        p = adjOff[b] + cursor[b]++;
        adjFrom[p] = b;
        adjTo[p] = a;
        adjEdge[p] = e;
      }
    }

    // OSM 간선↔표준노드링크 방향별 crosswalk. 없으면 전부 0으로 폴백한다.
    let eNlMidF: Uint32Array<ArrayBufferLike> = new Uint32Array(m), eNlMidR: Uint32Array<ArrayBufferLike> = new Uint32Array(m);
    let eNlFSrc: Uint32Array<ArrayBufferLike> = new Uint32Array(m), eNlFDst: Uint32Array<ArrayBufferLike> = new Uint32Array(m);
    let eNlRSrc: Uint32Array<ArrayBufferLike> = new Uint32Array(m), eNlRDst: Uint32Array<ArrayBufferLike> = new Uint32Array(m);
    let forbiddenTurns = new Set<bigint>();
    try {
      const mid = new Uint32Array(readRoadBinary(join(DIR, "edges-nodelink-mid.bin")));
      const turn = new Uint32Array(readRoadBinary(join(DIR, "edges-nodelink-turn.bin")));
      if (mid.length === m * 2 && turn.length === m * 4) {
        eNlMidF = mid.subarray(0, m);
        eNlMidR = mid.subarray(m);
        eNlFSrc = turn.subarray(0, m);
        eNlFDst = turn.subarray(m, m * 2);
        eNlRSrc = turn.subarray(m * 2, m * 3);
        eNlRDst = turn.subarray(m * 3);
      }
      const pairs = new Uint32Array(
        readRoadBinary(join(DIR, "nodelink-turn-forbid.bin")),
      );
      forbiddenTurns = new Set();
      for (let i = 0; i + 1 < pairs.length; i += 2) {
        forbiddenTurns.add((BigInt(pairs[i]) << BigInt(32)) | BigInt(pairs[i + 1]));
      }
    } catch {
      // 사이드카 미빌드 환경은 기존 공간매칭/회전제약 없음으로 호환한다.
    }

    // 분기·출구 방면 사이드카 (없으면 null — 구버전 그래프 호환)
    let dest: Map<number, { d?: string; r?: string }> | null = null;
    try {
      const raw = JSON.parse(readFileSync(join(DIR, "edges-dest.json"), "utf8")) as Record<
        string,
        { d?: string; r?: string }
      >;
      dest = new Map();
      for (const k in raw) dest.set(+k, raw[k]);
    } catch {
      dest = null;
    }

    // 본선 SCC 플래그 (없으면 전 노드 허용 — 구버전 그래프 호환)
    let ok: Uint8Array | null = null;
    try {
      const okBuf = new Uint8Array(readRoadBinary(join(DIR, "nodes-ok.bin")));
      if (okBuf.length === n) ok = okBuf;
    } catch {
      ok = null;
    }

    // 공간 색인 (스냅 대상이 아닌 포켓 노드는 아예 넣지 않는다)
    const grid = new Map<number, number[]>();
    for (let i = 0; i < n; i++) {
      if (ok && !ok[i]) continue;
      const k = gkey(nLat[i], nLng[i]);
      let arr = grid.get(k);
      if (!arr) {
        arr = [];
        grid.set(k, arr);
      }
      arr.push(i);
    }

    graph = {
      nLat, nLng, adjOff, adjFrom, adjTo, adjEdge,
      eA, eB, eLen, eCls, eMax, eCamLimit, eMotor, eStruct,
      eGeomOff, eGeomCnt, geom,
      eNlMidF, eNlMidR, eNlFSrc, eNlFDst, eNlRSrc, eNlRDst, forbiddenTurns,
      grid, ok, dest,
    };
  } catch (e) {
    // 조용히 null만 돌려주면 전 탐색이 카카오 폴백으로 새는 걸 알아챌 수 없다
    console.error("[localroute] 도로 그래프 로딩 실패:", e);
    graph = null;
  } finally {
    endLoad?.({ available: !!graph, nodes: graph?.nLat.length ?? 0, edges: graph?.eA.length ?? 0 });
  }
  return graph;
}

const kx = (lat: number) => Math.cos((lat * Math.PI) / 180) * 111320;
function dM(aLat: number, aLng: number, bLat: number, bLng: number): number {
  return Math.hypot((bLng - aLng) * kx(aLat), (bLat - aLat) * 110540);
}

/** 좌표에서 가장 가까운 그래프 노드 (최대 ~2km 링 탐색) */
// 최근접 "노드"로 스냅 — 폴백 전용. 고속·간선은 간선이 길어 노드가
// 드문드문이라, 간선 중간의 점이 옆 골목의 촘촘한 노드로 튄다(올림픽대로가
// 잠원로로 스냅되던 치명버그). 라우팅 스냅은 아래 snap()(간선 기반)을 써라.
function snapNode(g: Graph, p: LatLng): number {
  const ci = Math.floor(p.lat / GRID_CELL);
  const cj = Math.floor(p.lng / GRID_CELL);
  let best = -1,
    bd = Infinity;
  for (let r = 0; r <= 4; r++) {
    for (let a = ci - r; a <= ci + r; a++) {
      for (let b = cj - r; b <= cj + r; b++) {
        if (Math.max(Math.abs(a - ci), Math.abs(b - cj)) !== r) continue;
        const arr = g.grid.get(a * 100000 + b + 2_000_000_000);
        if (!arr) continue;
        for (const i of arr) {
          const d = dM(p.lat, p.lng, g.nLat[i], g.nLng[i]);
          if (d < bd) {
            bd = d;
            best = i;
          }
        }
      }
    }
    if (best >= 0 && bd < (r + 0.5) * GRID_CELL * 111000 * 0.7) break;
  }
  return bd <= 2000 ? best : -1;
}

// 라우팅용 스냅 — 최근접 "간선"에 투영한 뒤 그 간선의 끝점 노드를 준다.
// 편도(oneway) 도로는 방향이 확정이므로 역할에 맞는 끝점을 고른다:
//   role "start"(출발/차 위치) – 진행 끝점(eB), "end"(도착) – 진입 끝점(eA).
// 양방향 도로는 가까운 끝점. 이래야 올림픽대로(긴 편도 간선) 위 점이 옆
// 골목이 아니라 그 도로 자신에 붙어, 재탐색이 로컬로 새며 폭주하지 않는다.
/**
 * 진행방향을 아는 출발점 스냅 — 최근접 간선에 투영한 뒤 **진행방향 쪽 끝점**을
 * 고른다. 방향을 무시하면 뒤 노드에 붙어 경로가 역주행으로 시작한다.
 */
function snapHeading(g: Graph, p: LatLng, heading: number): number {
  const { edge, d } = scanNearestEdge(g, p.lat, p.lng, heading);
  if (edge < 0 || d > SNAP_EDGE_MAX) return snapNode(g, p);
  const a = g.eA[edge];
  const b = g.eB[edge];
  if (g.eCls[edge] & 128) return b; // 편도 — 진행 끝점 확정
  const off = (n: number) => {
    const br =
      (Math.atan2(
        (g.nLng[n] - p.lng) * kx(p.lat),
        (g.nLat[n] - p.lat) * 110540,
      ) *
        180) /
      Math.PI;
    return Math.abs(((br - heading + 540) % 360) - 180);
  };
  return off(b) <= off(a) ? b : a;
}

const SNAP_EDGE_MAX = 120; // 이보다 멀면 간선 스냅 포기(노드 폴백)
function snap(g: Graph, p: LatLng, role: "start" | "end" | "any" = "any"): number {
  const { edge, d } = scanNearestEdge(g, p.lat, p.lng);
  if (edge < 0 || d > SNAP_EDGE_MAX) return snapNode(g, p);
  const a = g.eA[edge],
    b = g.eB[edge];
  if (g.eCls[edge] & 128) return role === "end" ? a : b; // 편도: 방향 확정
  const da = dM(p.lat, p.lng, g.nLat[a], g.nLng[a]);
  const db = dM(p.lat, p.lng, g.nLat[b], g.nLng[b]);
  return da <= db ? a : b;
}

class Heap {
  private d: number[] = [];
  private i: number[] = [];
  get size() {
    return this.d.length;
  }
  push(dist: number, idx: number) {
    const d = this.d,
      it = this.i;
    d.push(dist);
    it.push(idx);
    let c = d.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (d[p] <= d[c]) break;
      [d[p], d[c]] = [d[c], d[p]];
      [it[p], it[c]] = [it[c], it[p]];
      c = p;
    }
  }
  pop(): { dist: number; idx: number } {
    const d = this.d,
      it = this.i;
    const top = { dist: d[0], idx: it[0] };
    const ld = d.pop()!,
      li = it.pop()!;
    if (d.length) {
      d[0] = ld;
      it[0] = li;
      let p = 0;
      for (;;) {
        const l = 2 * p + 1,
          r = l + 1;
        let m2 = p;
        if (l < d.length && d[l] < d[m2]) m2 = l;
        if (r < d.length && d[r] < d[m2]) m2 = r;
        if (m2 === p) break;
        [d[p], d[m2]] = [d[m2], d[p]];
        [it[p], it[m2]] = [it[m2], it[p]];
        p = m2;
      }
    }
    return top;
  }
}

export interface LocalLeg {
  path: LatLng[];
  dur: number;
  dist: number;
  toll: number;
  /** 경로상 실교차로 밀도(개/km) — 정체 보정·도심 판별에 쓰인다 */
  juncPerKm: number;
  /** 벤치마크가 ETA 구성요소를 경로 재탐색 없이 피팅할 때만 사용한다. */
  etaParts?: {
    itsRawSec: number;
    itsCalibratedSec: number;
    itsScale: number;
    fallbackCalibratedSec: number;
    turnSec: number;
    connectorSec: number;
    itsCoverage: number;
  };
}

export interface LocalRouteOptions {
  objective?: "time" | "distance";
  avoidMotorway?: boolean;
  /** 표준노드링크 대안 수. OSM 폴백은 1개만 지원한다. */
  alternatives?: number;
  /**
   * 정체 회피 강화 — 관측속도가 기준속도보다 느린 만큼 간선 비용을 증폭해
   * 안 막히는 평행 도로로 실제 우회하고, 주택가·이면도로급 좁은 길은 통과로에서
   * 배제한다. '정체 회피' 내비 모드용.
   */
  avoidJam?: boolean;
  /** 출발 헤딩(°) — 이탈 재탐색이 뒤로 돌아가지 않게 역방향 시작을 페널티. */
  startHeading?: number;
  /** 코스 추천 탐색 전용 — 빠른 어림값과 방문 상한을 쓴다. 내비 안내 경로에는 켜지 않는다. */
  explore?: boolean;
}

export interface PathSpeed {
  i: number;
  kmh: number;
  /** true면 이미 실시간 통행속도이므로 시간대/교차로 freeflow 보정을 곱하지 않는다. */
  its?: boolean;
}

/**
 * p 주변 radiusM 안의 실교차로(인접 차수 ≥3) 노드 수.
 * 신호등 태그가 OSM에 빠진 지역에서도 도로 토폴로지는 충실하므로,
 * 배지 계산의 "도시권/마을 구간" 판별에 쓴다. 그래프 없으면 0.
 */
export function junctionCountNear(p: LatLng, radiusM: number): number {
  const g = loadGraph();
  if (!g) return 0;
  const ci = Math.floor(p.lat / GRID_CELL);
  const cj = Math.floor(p.lng / GRID_CELL);
  let count = 0;
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const arr = g.grid.get(a * 100000 + b + 2_000_000_000);
      if (!arr) continue;
      for (const i of arr) {
        if (g.adjOff[i + 1] - g.adjOff[i] < 3) continue;
        if (dM(p.lat, p.lng, g.nLat[i], g.nLng[i]) <= radiusM) count++;
      }
    }
  }
  return count;
}

/**
 * p 인근 가장 빠른 도로급의 기본 속도(km/h) — 고속·자동차전용(80km/h급 이상)
 * 대로변은 방음벽·펜스가 많아 로드뷰 촬영지로 부적합, 그 판별용. 그래프
 * 없거나 반경 내 도로가 없으면 null.
 */
export function fastestRoadKmhNear(p: LatLng, radiusM = 80): number | null {
  const g = loadGraph();
  if (!g) return null;
  const ci = Math.floor(p.lat / GRID_CELL);
  const cj = Math.floor(p.lng / GRID_CELL);
  let best: number | null = null;
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const arr = g.grid.get(a * 100000 + b + 2_000_000_000);
      if (!arr) continue;
      for (const i of arr) {
        if (dM(p.lat, p.lng, g.nLat[i], g.nLng[i]) > radiusM) continue;
        for (let e = g.adjOff[i]; e < g.adjOff[i + 1]; e++) {
          const kmh = SPEED_KMH[g.eCls[g.adjEdge[e]]] ?? 0;
          if (best === null || kmh > best) best = kmh;
        }
      }
    }
  }
  return best;
}

/**
 * p 인근 가장 높은 도로급(가장 작은 클래스 인덱스, 0=motorway). 고속도로·
 * 자동차전용도로(0~3: motorway/motorway_link/trunk/trunk_link) 문맥 판별용.
 * 그래프 없거나 반경 내 도로 없으면 null. (oneway 상위비트 마스킹)
 */
export function fastestRoadClassNear(p: LatLng, radiusM = 30): number | null {
  const g = loadGraph();
  if (!g) return null;
  const ci = Math.floor(p.lat / GRID_CELL);
  const cj = Math.floor(p.lng / GRID_CELL);
  let best: number | null = null;
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const arr = g.grid.get(a * 100000 + b + 2_000_000_000);
      if (!arr) continue;
      for (const i of arr) {
        if (dM(p.lat, p.lng, g.nLat[i], g.nLng[i]) > radiusM) continue;
        for (let e = g.adjOff[i]; e < g.adjOff[i + 1]; e++) {
          const cls = g.eCls[g.adjEdge[e]] & 127;
          if (best === null || cls < best) best = cls;
        }
      }
    }
  }
  return best;
}

/**
 * p 인근에 "자동차전용도로 본선"이 있는가 — 고속도로(motorway·motorway_link,
 * 0~1) 또는 motorroad=yes인 trunk/trunk_link(올림픽대로·강변북로 등). 평면교차
 * 없이 램프로만 진출하므로, 이 문맥에선 완만한 꺾임을 실회전이 아니라 진출/
 * 분기 "방향" 안내로 다뤄야 한다. 일반 국도(trunk, motorroad 없음)는 제외.
 */
export function expresswayNear(p: LatLng, radiusM = 30): boolean {
  const g = loadGraph();
  if (!g) return false;
  const ci = Math.floor(p.lat / GRID_CELL);
  const cj = Math.floor(p.lng / GRID_CELL);
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const arr = g.grid.get(a * 100000 + b + 2_000_000_000);
      if (!arr) continue;
      for (const i of arr) {
        if (dM(p.lat, p.lng, g.nLat[i], g.nLng[i]) > radiusM) continue;
        for (let e = g.adjOff[i]; e < g.adjOff[i + 1]; e++) {
          const edge = g.adjEdge[e];
          const cls = g.eCls[edge] & 127;
          if (cls <= 1) return true;
          if ((cls === 2 || cls === 3) && g.eMotor[edge]) return true; // 자동차전용 trunk
        }
      }
    }
  }
  return false;
}

/**
 * 진출입이 램프로만 이뤄지는 "분리 자동차전용 본선"이 인근에 있는가 —
 * expresswayNear(고속·motorroad trunk)에 더해, **일방통행 간선(class ≤ primary)**
 * 까지 포함한다. 강변북로·자유로·공항고속처럼 실제론 자동차전용도로지만 이
 * OSM 추출본에 motorroad 태그가 빠진 채 oneway primary/trunk로만 들어온 도로를
 * 잡기 위함. 이런 도로는 차로 감소가 램프 테이퍼로 흔하고 표지로 안내되므로
 * "도로 좁아짐" 경고를 억제하는 데만 쓴다(회전 의미 판정엔 expresswayNear 유지).
 */
export function dividedExpresswayNear(p: LatLng, radiusM = 30): boolean {
  const g = loadGraph();
  if (!g) return false;
  const ci = Math.floor(p.lat / GRID_CELL);
  const cj = Math.floor(p.lng / GRID_CELL);
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const arr = g.grid.get(a * 100000 + b + 2_000_000_000);
      if (!arr) continue;
      for (const i of arr) {
        if (dM(p.lat, p.lng, g.nLat[i], g.nLng[i]) > radiusM) continue;
        for (let e = g.adjOff[i]; e < g.adjOff[i + 1]; e++) {
          const edge = g.adjEdge[e];
          const raw = g.eCls[edge];
          const cls = raw & 127;
          if (cls <= 1) return true; // 고속
          if (g.eMotor[edge]) return true; // motorroad=yes(태그 있는 경우)
          if (raw & 128 && cls <= 4) return true; // 일방통행 간선(≤primary)=분리 본선
        }
      }
    }
  }
  return false;
}

// 도로급별 법정 제한속도 기본값 km/h (OSM maxspeed 미태그 구간 폴백, 추정치).
// SPEED_KMH와 같은 클래스 순서: motorway/…/living_street.
const LEGAL_DEFAULT = [100, 80, 80, 60, 70, 60, 60, 50, 50, 40, 50, 40, 20];

/** 점–간선 폴리라인 최단거리(m)와 그 최근접 구간의 진행 방위(°) */
function distToEdge(
  g: Graph,
  e: number,
  lat: number,
  lng: number,
): { d: number; brg: number } {
  const a = g.eA[e],
    b = g.eB[e];
  const off = g.eGeomOff[e],
    cnt = g.eGeomCnt[e];
  let best = Infinity;
  // 제곱거리로 먼저 걸러 Math.hypot(느림)은 더 가까울 수 있는 구간에서만 부른다. 상한에 1e-9 여유를 둬서
  // 걸러진 구간은 항상 best보다 멀다 — 결과(거리·방위)는 예전 계산과 같다.
  let bestSq = Infinity;
  let bestBrg = 0;
  let prevLat = g.nLat[a],
    prevLng = g.nLng[a];
  const k = kx(lat);
  // 간선 시작 노드 → geometry 중간점들 → 끝 노드를 구간별로 훑는다(cnt+1개 구간).
  for (let k2 = 0; k2 <= cnt; k2++) {
    const curLat = k2 < cnt ? g.geom[(off + k2) * 2] : g.nLat[b];
    const curLng = k2 < cnt ? g.geom[(off + k2) * 2 + 1] : g.nLng[b];
    const ax = (prevLat - lat) * 110540,
      ay = (prevLng - lng) * k;
    const bx = (curLat - lat) * 110540,
      by = (curLng - lng) * k;
    const dx = bx - ax,
      dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + t * dx,
      py = ay + t * dy;
    if (px * px + py * py <= bestSq) {
      const d = Math.hypot(px, py);
      if (d < best) {
        best = d;
        bestSq = d * d * (1 + 1e-9);
        // metric 방위 (북=+위도, 동=+경도) — heading과 동일 기준
        bestBrg = (Math.atan2((curLng - prevLng) * k, (curLat - prevLat) * 110540) * 180) / Math.PI;
      }
    }
    prevLat = curLat;
    prevLng = curLng;
  }
  return { d: best, brg: bestBrg };
}

const angDiff180 = (a: number, b: number) =>
  Math.abs(((a - b + 540) % 360) - 180);

const HEADING_PEN = 35; // 방위 180° 어긋나면 +35m

export type LimitSource = "osm" | "camera" | "default";
export interface EdgeLimit {
  kmh: number;
  /** 확정 여부 — OSM 태그 또는 단속카메라값이면 true, 도로급 추정이면 false */
  tagged: boolean;
  source: LimitSource;
}

/**
 * 간선 – 제한속도. 우선순위: OSM maxspeed 태그 – 단속카메라 전파값 –
 * 도로급 법정 기본값(추정). 앞 둘은 확정(tagged=true), 마지막은 추정.
 */
function edgeLimit(g: Graph, edge: number): EdgeLimit {
  const tag = g.eMax[edge];
  if (tag) return { kmh: tag, tagged: true, source: "osm" };
  const cam = g.eCamLimit[edge];
  if (cam) return { kmh: cam, tagged: true, source: "camera" };
  const cls = g.eCls[edge] & 127;
  return { kmh: LEGAL_DEFAULT[cls] ?? 0, tagged: false, source: "default" };
}

// 간선 중복 방문 스킵용 세대 스탬프 — 호출마다 Set을 새로 할당하는 대신
// 배열 한 개를 재사용(gen 증가)해 GC·해시 비용을 없앤다(대량 조회 핫스팟).
let edgeSeen: Int32Array | null = null;
let scanGen = 0;

/** p 최근접 간선을 격자 스캔으로 (heading 정렬 페널티). {edge, d} 또는 edge<0 */
function scanNearestEdge(
  g: Graph,
  lat: number,
  lng: number,
  heading?: number | null,
): { edge: number; d: number } {
  if (!edgeSeen || edgeSeen.length < g.eA.length) {
    edgeSeen = new Int32Array(g.eA.length);
  }
  const seen = edgeSeen;
  const gen = ++scanGen;
  const ci = Math.floor(lat / GRID_CELL);
  const cj = Math.floor(lng / GRID_CELL);
  let bestScore = Infinity,
    bestD = Infinity,
    bestEdge = -1;
  const useHead = heading !== null && heading !== undefined;
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const arr = g.grid.get(a * 100000 + b + 2_000_000_000);
      if (!arr) continue;
      for (const node of arr) {
        for (let e = g.adjOff[node]; e < g.adjOff[node + 1]; e++) {
          const edge = g.adjEdge[e];
          if (seen[edge] === gen) continue;
          seen[edge] = gen;
          const { d, brg } = distToEdge(g, edge, lat, lng);
          let score = d;
          if (useHead) {
            const off = Math.min(
              angDiff180(heading as number, brg),
              angDiff180(heading as number, brg + 180),
            );
            score += (off / 180) * HEADING_PEN;
          }
          if (score < bestScore) {
            bestScore = score;
            bestD = d;
            bestEdge = edge;
          }
        }
      }
    }
  }
  return { edge: bestEdge, d: bestD };
}

/**
 * p가 놓인 도로의 제한속도 km/h. 최근접 간선을 투영으로 찾아 OSM maxspeed
 * 태그를 우선(tagged=true), 없으면 도로급 법정 기본값(tagged=false)을 준다.
 * heading(진행 방위)을 주면 방위가 어긋난 간선(교차하는 옆길)에 페널티를 줘
 * 교차로에서 옆길 제한속도로 튀는 걸 막는다. 반경 밖·그래프 없으면 null.
 */
export function speedLimitAt(
  p: LatLng,
  radiusM = 45,
  heading?: number | null,
): EdgeLimit | null {
  const g = loadGraph();
  if (!g) return null;
  const { edge, d } = scanNearestEdge(g, p.lat, p.lng, heading);
  if (edge < 0 || d > radiusM) return null;
  return edgeLimit(g, edge);
}

/**
 * p 최근접 도로의 진행 방향 정보 — 분리도로(일방통행) 반대차로 카메라를
 * 걸러내기 위함. {oneway, brg}: oneway면 그 도로의 유일 진행방위(A–B, °),
 * 양방향이면 oneway=false(방향 무의미). 반경(35m) 밖·그래프 없으면 null.
 */
// 카메라 지점마다 불린다(자유주행 요청마다 도심 카메라 70~80대). 카메라는 고정이고
// 그래프도 프로세스 수명 동안 불변이라, 한 번 구한 답을 모든 요청이 재사용한다.
const roadDirCache = new Map<string, { oneway: boolean; brg: number } | null>();
const ROAD_DIR_CACHE_MAX = 50_000;

export function roadDirAt(
  lat: number,
  lng: number,
): { oneway: boolean; brg: number } | null {
  const key = `${lat},${lng}`;
  const hit = roadDirCache.get(key);
  if (hit !== undefined) return hit;
  const dir = roadDirAtUncached(lat, lng);
  if (roadDirCache.size >= ROAD_DIR_CACHE_MAX) roadDirCache.clear();
  roadDirCache.set(key, dir && Object.freeze(dir));
  return dir;
}

function roadDirAtUncached(
  lat: number,
  lng: number,
): { oneway: boolean; brg: number } | null {
  const g = loadGraph();
  if (!g) return null;
  const { edge, d } = scanNearestEdge(g, lat, lng);
  if (edge < 0 || d > CAMERA_ROAD_SNAP_M) return null;
  const { brg } = distToEdge(g, edge, lat, lng);
  return { oneway: !!(g.eCls[edge] & 128), brg };
}

// 입체 교차로에서는 최근접 도로 하나로 후보를 줄이지 않는다.
export function roadLevelEdgesNear(
  point: LatLng,
  heading: number | null,
): RoadLevelEdge[] {
  const g = loadGraph();
  if (!g) return [];
  const metadata = readRoadLevelMetadata(g.eA.length);
  if (!metadata) return [];
  const ci = Math.floor(point.lat / GRID_CELL), cj = Math.floor(point.lng / GRID_CELL);
  const seen = new Set<number>(), result: RoadLevelEdge[] = [];
  for (let x = ci - 1; x <= ci + 1; x++) for (let y = cj - 1; y <= cj + 1; y++) {
    for (const node of g.grid.get(x * 100000 + y + 2_000_000_000) ?? []) {
      for (let p = g.adjOff[node]; p < g.adjOff[node + 1]; p++) {
        const edge = g.adjEdge[p];
        if (seen.has(edge)) continue;
        seen.add(edge);
        const hit = distToEdge(g, edge, point.lat, point.lng);
        if (hit.d > CAMERA_ROAD_SNAP_M) continue;
        const forward = heading === null || angDiff180(heading, hit.brg) <= 60;
        const reverse = !(g.eCls[edge] & 128)
          && (heading === null || angDiff180(heading, hit.brg + 180) <= 60);
        if (!forward && !reverse) continue;
        const ids: string[] = [];
        if (forward && g.eNlMidF[edge]) {
          const link = nodelinkAt(g.eNlMidF[edge] - 1);
          if (link) ids.push(link.linkId);
        }
        if (reverse && g.eNlMidR[edge]) {
          const link = nodelinkAt(g.eNlMidR[edge] - 1);
          if (link) ids.push(link.linkId);
        }
        const structure = g.eStruct[edge];
        if (structure > 2) continue;
        result.push({ edgeId: edge, roadName: metadata.names[metadata.edgeNames[edge]],
          structure: structure as 0 | 1 | 2,
          layer: metadata.layers[edge] === 127 ? null : metadata.layers[edge],
          distanceM: hit.d, bearingDeg: hit.brg, nodelinkIds: ids });
      }
    }
  }
  return result.sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * p가 놓인 램프·분기 간선의 방면(destination) 정보 {d:"서울;대구", r:"251"}.
 * 진출 램프 위 점을 heading과 함께 넣어 조회한다. 반경 밖·미태그·그래프 없으면 null.
 */
export function destinationAt(
  p: LatLng,
  radiusM = 30,
  heading?: number | null,
): { d?: string; r?: string } | null {
  const g = loadGraph();
  if (!g || !g.dest) return null;
  const { edge, d } = scanNearestEdge(g, p.lat, p.lng, heading);
  if (edge < 0 || d > radiusM) return null;
  return g.dest.get(edge) ?? null;
}

/**
 * 경로를 따라 제한속도가 바뀌는 지점만 런렝스로 — [{i, kmh, tagged}].
 * 진행 방위로 옆길 오인을 줄이고, ~130m 미만 짧은 잡음 런은 앞 값으로 흡수해
 * 표시가 깜빡이지 않게 한다. buildGuidance가 안내에 실어 nav-engine이
 * 현재 위치 제한속도를 안다.
 */
/**
 * 현위치(진행방위 정렬) 도로의 제한속도 — 목적지 없는 "일반 주행" 상시 표시용.
 * 45m 안에 매칭 간선이 없으면 kmh=0(미상).
 */
export function limitAtPoint(
  lat: number,
  lng: number,
  heading?: number | null,
): EdgeLimit {
  const g = loadGraph();
  if (!g) return { kmh: 0, tagged: false, source: "default" };
  const r = scanNearestEdge(g, lat, lng, heading);
  return r.edge >= 0 && r.d <= 45
    ? edgeLimit(g, r.edge)
    : { kmh: 0, tagged: false, source: "default" };
}

export function speedLimitsAlong(
  path: LatLng[],
): { i: number; kmh: number; tagged: boolean; source: LimitSource }[] {
  const out: { i: number; kmh: number; tagged: boolean; source: LimitSource }[] = [];
  if (path.length < 2) return out;
  const g = loadGraph();
  if (!g) return out;
  // 1) 점별 원시 제한속도 (진행 방위 정렬)
  const raw: EdgeLimit[] = [];
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const heading =
      a === b
        ? null
        : (Math.atan2((b.lng - a.lng) * kx(p.lat), (b.lat - a.lat) * 110540) *
            180) /
          Math.PI;
    const r = scanNearestEdge(g, p.lat, p.lng, heading);
    raw.push(
      r.edge >= 0 && r.d <= 45
        ? edgeLimit(g, r.edge)
        : { kmh: 0, tagged: false, source: "default" },
    );
  }
  // 2) 짧은 잡음 런 제거 — 연속 MIN_RUN 미만 변화는 앞 값으로 흡수
  const MIN_RUN = 3; // 점 간격 ~40m – ~120m 미만은 무시
  for (let i = 1; i < raw.length; ) {
    let j = i;
    while (j < raw.length && raw[j].kmh === raw[i].kmh && raw[j].tagged === raw[i].tagged) j++;
    if (j - i < MIN_RUN) {
      for (let k = i; k < j; k++) raw[k] = raw[i - 1];
      i = j;
    } else i = j;
  }
  // 3) 런렝스 인코딩
  for (let i = 0; i < raw.length; i++) {
    const prev = out[out.length - 1];
    if (!prev || prev.kmh !== raw[i].kmh || prev.tagged !== raw[i].tagged) {
      out.push({ i, kmh: raw[i].kmh, tagged: raw[i].tagged, source: raw[i].source });
    }
  }
  return out;
}

/**
 * 경로 점별 최근접 간선의 도로급(class 0~12, 없으면 -1) — 진행 방위 정렬.
 * 고속도로/자동차전용도로에서 연결로(_link) 진입=분기·진출 지점을 잡는 데 쓴다
 * (도로급이 motorway 유지라 진출검출이 못 잡는 고속끼리 분기점 대응).
 */
export function roadClassAlong(path: LatLng[]): number[] {
  const out: number[] = new Array(path.length).fill(-1);
  const g = loadGraph();
  if (!g || path.length < 2) return out;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const heading =
      a === b
        ? null
        : (Math.atan2((b.lng - a.lng) * kx(p.lat), (b.lat - a.lat) * 110540) *
            180) /
          Math.PI;
    const r = scanNearestEdge(g, p.lat, p.lng, heading);
    out[i] = r.edge >= 0 && r.d <= SNAP_EDGE_MAX ? g.eCls[r.edge] & 127 : -1;
  }
  return out;
}

/**
 * 경로 점별 최근접 간선의 구조물 코드(0=없음 1=고가도로 2=지하차도/터널) —
 * 진행 방위 정렬. 고가도로·지하차도 진입 안내(navguide)에서 구조물 진입 경계를
 * 잡는 데 쓴다. 스냅 반경 밖은 0(구조물 없음으로 간주).
 */
export function structAlong(path: LatLng[]): number[] {
  const out: number[] = new Array(path.length).fill(0);
  const g = loadGraph();
  if (!g || path.length < 2) return out;
  for (let i = 0; i < path.length; i++) {
    const p = path[i];
    const a = path[Math.max(0, i - 1)];
    const b = path[Math.min(path.length - 1, i + 1)];
    const heading =
      a === b
        ? null
        : (Math.atan2((b.lng - a.lng) * kx(p.lat), (b.lat - a.lat) * 110540) *
            180) /
          Math.PI;
    const r = scanNearestEdge(g, p.lat, p.lng, heading);
    out[i] = r.edge >= 0 && r.d <= SNAP_EDGE_MAX ? g.eStruct[r.edge] : 0;
  }
  return out;
}

/**
 * 임의 경로(카카오 실측·해안 spine 포함)의 실교차로 밀도(개/km) —
 * localLeg 내부 계산과 같은 200m/120m 지표. "도심 비중" 판별용:
 * 피팅 d0(1.7) 미만이면 정체 보정이 0인 교외·시골 경로라 로컬 추정을
 * 신뢰해도 된다(실측 대비 ±9% 검증됨). 그래프 없으면 0(=시골 취급 주의).
 */
export function pathJuncPerKm(path: LatLng[]): number {
  if (path.length < 2) return 0;
  let hits = 0;
  let totalM = 0;
  let acc = SAMPLE_STEP_M;
  for (let i = 1; i < path.length; i++) {
    const d = dM(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
    totalM += d;
    acc += d;
    if (acc >= SAMPLE_STEP_M) {
      acc = 0;
      if (junctionCountNear(path[i], 120) >= 1) hits++;
    }
  }
  return hits / Math.max(totalM / 1000, 0.1);
}

// 탐색 버퍼 재사용 — 호출마다 노드 수(107만)만큼 할당하면 GC 압박이 크다.
// generation 스탬프로 "이번 탐색에서 본 노드"만 유효 취급해 초기화를 생략한다.
let bufDist: Float64Array | null = null;
let bufPrevState: Int32Array | null = null;
let bufGen: Int32Array | null = null;
let curGen = 0;

const ROAD_PREF = [1, 1.02, 1, 1.03, 1, 1.05, 1.02, 1.06, 1.04, 1.08, 1.12, 1.25, 1.5];
/** avoidJam: 정체분(1−관측/기준)에 곱하는 우회 가중치. nodelink-route와 동일. */
const JAM_WEIGHT = 2.5;

/** 벤치마크에서만 환경변수로 탐색하고, 운영에서는 검증된 기본값을 쓴다. */
function etaParam(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function etaItsSpeedKmh(
  kmh: number,
  scaleName = "ETA_ITS_SPEED_SCALE",
  // OSM 경로도 같은 ITS를 쓰므로 표준노드링크와 같이 1.0(10-28, 연결표 적용 후)
  fallback = 1.0,
): number {
  return Math.min(
    130,
    // ITS 링크 평균속도를 간선 전체에 적용할 때 생기는 링크 경계 차이를 흡수한다.
    kmh * etaParam(scaleName, fallback, 0.7, 1.6),
  );
}

function directedNodelinkMid(g: Graph, edge: number, from: number): number {
  return from === g.eA[edge] ? g.eNlMidF[edge] : g.eNlMidR[edge];
}
function directedNodelinkSource(g: Graph, edge: number, from: number): number {
  return from === g.eA[edge] ? g.eNlFSrc[edge] : g.eNlRSrc[edge];
}
function directedNodelinkTarget(g: Graph, edge: number, from: number): number {
  return from === g.eA[edge] ? g.eNlFDst[edge] : g.eNlRDst[edge];
}
function isForbiddenTurn(g: Graph, incomingState: number, outgoingState: number): boolean {
  if (g.forbiddenTurns.size === 0) return false;
  const inEdge = g.adjEdge[incomingState], inFrom = g.adjFrom[incomingState];
  const outEdge = g.adjEdge[outgoingState], outFrom = g.adjFrom[outgoingState];
  const from = directedNodelinkTarget(g, inEdge, inFrom);
  const to = directedNodelinkSource(g, outEdge, outFrom);
  if (!from || !to) return false;
  return g.forbiddenTurns.has((BigInt(from - 1) << BigInt(32)) | BigInt(to - 1));
}

/** 방향 간선의 출발/도착 쪽 실제 진행 방위. */
function directedBearing(g: Graph, edge: number, from: number, atEnd: boolean): number {
  const forward = from === g.eA[edge], off = g.eGeomOff[edge], cnt = g.eGeomCnt[edge];
  let aLat: number, aLng: number, bLat: number, bLng: number;
  if (forward && !atEnd) {
    aLat = g.nLat[g.eA[edge]]; aLng = g.nLng[g.eA[edge]];
    bLat = cnt ? g.geom[off * 2] : g.nLat[g.eB[edge]];
    bLng = cnt ? g.geom[off * 2 + 1] : g.nLng[g.eB[edge]];
  } else if (forward) {
    aLat = cnt ? g.geom[(off + cnt - 1) * 2] : g.nLat[g.eA[edge]];
    aLng = cnt ? g.geom[(off + cnt - 1) * 2 + 1] : g.nLng[g.eA[edge]];
    bLat = g.nLat[g.eB[edge]]; bLng = g.nLng[g.eB[edge]];
  } else if (!atEnd) {
    aLat = g.nLat[g.eB[edge]]; aLng = g.nLng[g.eB[edge]];
    bLat = cnt ? g.geom[(off + cnt - 1) * 2] : g.nLat[g.eA[edge]];
    bLng = cnt ? g.geom[(off + cnt - 1) * 2 + 1] : g.nLng[g.eA[edge]];
  } else {
    aLat = cnt ? g.geom[off * 2] : g.nLat[g.eB[edge]];
    aLng = cnt ? g.geom[off * 2 + 1] : g.nLng[g.eB[edge]];
    bLat = g.nLat[g.eA[edge]]; bLng = g.nLng[g.eA[edge]];
  }
  return (Math.atan2((bLng - aLng) * kx(aLat), (bLat - aLat) * 110_540) * 180) / Math.PI;
}

/** 골목 지그재그를 억제하는 현실적 회전비용(초). 고속 본선/램프는 최소화. */
function turnPenaltySec(g: Graph, incomingState: number, outgoingState: number): number {
  const ie = g.adjEdge[incomingState], oe = g.adjEdge[outgoingState];
  if (ie === oe) return 55; // 즉시 되돌기
  const incoming = directedBearing(g, ie, g.adjFrom[incomingState], true);
  const outgoing = directedBearing(g, oe, g.adjFrom[outgoingState], false);
  const signed = ((outgoing - incoming + 540) % 360) - 180;
  const angle = Math.abs(signed);
  const fast = (g.eCls[ie] & 127) <= 3 || (g.eCls[oe] & 127) <= 3;
  if (angle < 25) return fast ? 0 : 2;
  if (angle >= 150) return 55;
  if (fast) return 2;
  return signed > 0 ? 7 : 15; // 우회전 / 좌회전(신호대기 포함)
}

/**
 * 큰길 유턴 추가 벌점(초, 탐색 전용) — OSM엔 유턴 허용 정보가 없어 금지 대신 크게 물린다.
 * 교차로 안 짧은 간선(≤30m)을 거쳐 두 번에 나뉜 유턴(좌90°+좌90°)도 잡는다 — 한 번 꺾임만 보면
 * 공짜라 목적지 앞 연결로가 큰길 한가운데서 돌았다(10-27 대전시청·대구시청 앞, 재탐색 유턴 대부분).
 */
const OSM_MAJOR_UTURN_S = 300;
function osmUturnExtraSec(g: Graph, prevState: Int32Array, state: number, next: number): number {
  const ie = g.adjEdge[state], oe = g.adjEdge[next];
  const major = (e: number) => (g.eCls[e] & 127) <= 9;
  const outB = directedBearing(g, oe, g.adjFrom[next], false);
  const rev = (inB: number) => Math.abs(((outB - inB + 540) % 360) - 180);
  if (ie === oe || rev(directedBearing(g, ie, g.adjFrom[state], true)) >= 150) {
    return major(ie) || major(oe) ? OSM_MAJOR_UTURN_S : 0;
  }
  if (g.eLen[ie] > 30) return 0;
  const back = prevState[state];
  if (back < 0) return 0;
  const be = g.adjEdge[back];
  if (rev(directedBearing(g, be, g.adjFrom[back], true)) < 165) return 0;
  return major(be) || major(oe) ? OSM_MAJOR_UTURN_S : 55;
}

/** 경로 안에 되돌아 나가는 곳(앞뒤 20m 진행방위가 150°+ 뒤집힘)이 있는지 */
function hasReversal(path: LatLng[]): boolean {
  if (path.length < 3) return false;
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + dM(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng));
  const total = cum[cum.length - 1];
  const at = (m: number): LatLng => {
    let i = 0;
    while (i + 1 < path.length && cum[i + 1] < m) i++;
    const a = path[i], b = path[Math.min(i + 1, path.length - 1)];
    const f = cum[i + 1] > cum[i] ? (m - cum[i]) / (cum[i + 1] - cum[i]) : 0;
    return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
  };
  const brg = (p: LatLng, q: LatLng) => Math.atan2((q.lng - p.lng) * kx(p.lat), (q.lat - p.lat) * 110540) * 180 / Math.PI;
  for (let m = 20; m < total - 20; m += 5) {
    const p = at(m);
    if (Math.abs(((brg(p, at(m + 20)) - brg(at(m - 20), p) + 540) % 360) - 180) >= 150) return true;
  }
  return false;
}

/** 경로 i번 점에서 dir 방향으로 최소 15m 떨어진 점까지의 진행 방위(°). */
function pathHeading(path: LatLng[], i: number, dir: 1 | -1): number {
  const a = path[i];
  let b = path[i + dir] ?? a;
  for (let j = i + dir; j >= 0 && j < path.length; j += dir) {
    b = path[j];
    if (dM(a.lat, a.lng, b.lat, b.lng) >= 15) break;
  }
  const [p, q] = dir > 0 ? [a, b] : [b, a];
  return Math.atan2((q.lng - p.lng) * kx(p.lat), (q.lat - p.lat) * 110540) * 180 / Math.PI;
}

/**
 * OSM 연결 구간이 본선 진입점 옆을 같은 방향으로 이미 지나가는데도 계속
 * 돌아서 그 점에 "정확히" 닿으려는 군더더기를 잘라낸다. OSM 스냅 노드가 진입점
 * 너머에 잡히면 회전교차로 한 바퀴+유턴 같은 헛돌기가 생긴다(강릉역: 직선
 * 75m 연결이 712m로 계산됨). 반대 차로를 지나는 경우는 방위로 걸러 자르지 않는다.
 */
function trimConnector(
  leg: LocalLeg | null,
  snap: LatLng,
  heading: number,
  side: "start" | "end",
): LocalLeg | null {
  if (!leg || leg.path.length < 3) return leg;
  const p = leg.path;
  const hits = (i: number) => {
    const a = p[i], b = p[i + 1], mx = kx(a.lat);
    const dx = (b.lng - a.lng) * mx, dy = (b.lat - a.lat) * 110540;
    const seg = Math.hypot(dx, dy);
    if (seg < 0.5) return false;
    const brg = Math.atan2(dx, dy) * 180 / Math.PI;
    if (Math.abs(((brg - heading + 540) % 360) - 180) > 60) return false;
    const sx = (snap.lng - a.lng) * mx, sy = (snap.lat - a.lat) * 110540;
    const t = Math.max(0, Math.min(1, (sx * dx + sy * dy) / (seg * seg)));
    return Math.hypot(sx - t * dx, sy - t * dy) <= 20;
  };
  let kept: LatLng[] | null = null;
  if (side === "start") {
    for (let i = 0; i < p.length - 1 && !kept; i++) if (hits(i)) kept = [...p.slice(0, i + 1), snap];
  } else {
    for (let i = p.length - 2; i >= 0 && !kept; i--) if (hits(i)) kept = [snap, ...p.slice(i + 1)];
  }
  if (!kept) return leg;
  let km = 0;
  for (let i = 1; i < kept.length; i++) km += dM(kept[i - 1].lat, kept[i - 1].lng, kept[i].lat, kept[i].lng);
  if (km > leg.dist - 30) return leg;
  const f = leg.dist > 0 ? km / leg.dist : 1;
  return { ...leg, path: kept, dist: Math.round(km), dur: Math.round(leg.dur * f) };
}

function nativeToLocalLeg(
  native: NativeNodelinkRoute,
  from: LatLng,
  to: LatLng,
  itsSpeedScale: number,
): LocalLeg {
  const startSnap = native.path[1];
  const endSnap = native.path[native.path.length - 2];
  const connector = (a: LatLng, b: LatLng, straightM: number, heading?: number) => {
    if (straightM <= 25) return null;
    // 도착 연결은 본선을 달려온 방향을 넘긴다 — 모르면 진입점 뒤쪽 노드에 붙어 되돌아가는
    // 유턴으로 목적지에 들어갔다(10-27 대전시청 앞 523m 전 좌좌 유턴, 전국 재탐색 유턴의 대부분)
    const leg = osmLocalLeg(a, b, heading == null ? {} : { startHeading: heading });
    // 가까운 단지·골목 연결만 허용한다. OSM 스냅이 엉뚱한 본선으로 튀면
    // 짧은 저속 직선 연결을 유지한다.
    if (!leg || leg.dist > Math.max(1_000, straightM * 4)) return null;
    return leg;
  };
  /**
   * 도착 연결로가 되돌아 나가는(유턴) 길이고 목적지가 직선 150m 안이면 — 분당구청 앞은 남은 70m를
   * 유턴 두 번으로 600m 돌았다(10-27) — 연결로를 버리고 **본선 위 지점에서 안내를 끝낸다**
   * ("목적지 부근" 도착). 직선을 그려 이으면 분리대를 가로지르는 가짜 길이 된다(검사 지적).
   */
  const arriveNear = (leg: LocalLeg | null, straightM: number) =>
    leg != null && straightM <= 150 && hasReversal(leg.path);
  const startLeg = trimConnector(
    connector(from, startSnap, native.startConnectorM), startSnap,
    pathHeading(native.path, 1, 1), "start");
  const arriveHeading = pathHeading(native.path, native.path.length - 2, -1);
  const rawEndLeg = connector(endSnap, to, native.endConnectorM, arriveHeading);
  const endAtRoad = arriveNear(rawEndLeg, native.endConnectorM);
  const endLeg = endAtRoad ? null : trimConnector(rawEndLeg, endSnap, arriveHeading, "end");
  const path: LatLng[] = [];
  const append = (points: LatLng[]) => {
    for (const point of points) {
      const last = path[path.length - 1];
      if (!last || dM(last.lat, last.lng, point.lat, point.lng) > 0.2) path.push(point);
    }
  };
  append(startLeg?.path ?? [from, startSnap]);
  append(native.path.slice(1, -1));
  append(endAtRoad ? [endSnap] : endLeg?.path ?? [endSnap, to]);
  const juncPerKm = pathJuncPerKm(path);
  const cal = timeCalib();
  const congMul = Math.min(1 + cal.k * Math.max(juncPerKm - cal.d0, 0), cal.cap);
  const fallbackMul = cal.calib * congMul * hourMulNow();
  const fallbackEtaScale = etaParam("NODELINK_ETA_FALLBACK_SCALE", 1, 0.5, 2);
  const turnEtaScale = etaParam("NODELINK_ETA_TURN_SCALE", 1, 0, 3);
  const startSec = startLeg?.dur ?? native.startConnectorM / (15 / 3.6) * fallbackMul;
  const endSec = endAtRoad ? 0 : endLeg?.dur ?? native.endConnectorM / (15 / 3.6) * fallbackMul;
  const fallbackCalibratedSec = native.fallbackSec * fallbackMul;
  const connectorSec = startSec + endSec;
  const roadDist = native.dist - native.startConnectorM - native.endConnectorM;
  const itsHourMul = itsHourMulNow();
  return {
    path,
    dur: Math.round(
      native.itsSec * itsHourMul + fallbackCalibratedSec * fallbackEtaScale +
        native.turnSec * turnEtaScale + connectorSec,
    ),
    dist: Math.round(roadDist + (startLeg?.dist ?? native.startConnectorM) +
      (endLeg?.dist ?? native.endConnectorM)),
    toll: 0,
    juncPerKm,
    etaParts: {
      itsRawSec: native.itsRawSec,
      itsCalibratedSec: native.itsSec,
      itsScale: itsSpeedScale,
      fallbackCalibratedSec,
      turnSec: native.turnSec,
      connectorSec,
      itsCoverage: native.itsCoverage,
    },
  };
}

/**
 * 로컬 A* 후보들. 표준노드링크에서는 ITS 시간/거리 목적과 고속도로 회피를
 * 직접 반영하고, 그래프·스냅 실패 시 전국 OSM 그래프로 한 번 폴백한다.
 */
export function localLegCandidates(
  from: LatLng,
  to: LatLng,
  options: LocalRouteOptions = {},
): LocalLeg[] {
  const endTiming = startLoopStage("local.leg");
  try {
  // 경로 선택에는 쓰지 않고 도착시간 적분에만 적용한다. 동일 경로 19건에서
  // 1.30 대비 MAPE 7.8%–7.5%, 전국 전체는 9.7%–9.5%로 검증됐다.
  // 1.35는 ITS가 링크 조각 일부에만 잡히던 때(직접 번호 56%) 맞춘 값 — 연결표로 92%가 되니
  // 덧곱이 오히려 짧게 만들었다. 카카오 TIME 51경로(10-28 15시) 평균오차 17.7%–10.6%로 1.0.
  const itsSpeedScale = etaParam("NODELINK_ETA_ITS_SPEED_SCALE", 1.0, 0.7, 1.6);
  const itsBlend = etaParam("ETA_ITS_SEARCH_BLEND", 0.75, 0, 1.5);
  const maxSpeedup = etaParam("ETA_ITS_MAX_SPEEDUP", 1 / 0.85, 0.8, 1.5);

  // v3 표준노드링크는 OSM 대비 전국 중첩 중앙값 72%–91%가 검증돼 기본값이다.
  // 산출물이 없거나 스냅/연결이 실패하면 OSM A*로 자동 폴백한다.
  if (process.env.NODELINK_NATIVE_ROUTE !== "0") {
    loopCount("nativeLegsTried");
    const baseFallbackMul = timeCalib().calib * hourMulNow();
    const natives = nativeNodelinkRoutes(from, to, {
      itsSpeedScale,
      searchBlend: itsBlend,
      maxSpeedup,
      roadPrefScale: etaParam("NODELINK_ROAD_PREF_SCALE", 0, 0, 2),
      turnScale: etaParam("NODELINK_TURN_SCALE", 0.75, 0, 2),
      fallbackMultiplier: baseFallbackMul,
      alternatives: options.alternatives ?? etaParam("NODELINK_ROUTE_ALTERNATIVES", 1, 1, 5),
      objective: options.objective ?? "time",
      avoidMotorway: options.avoidMotorway,
      avoidJam: options.avoidJam,
      startHeading: options.startHeading,
      explore: options.explore,
    });
    if (natives.length > 0) {
      return natives.map((native) => nativeToLocalLeg(native, from, to, itsSpeedScale));
    }
  }
  const fallback = osmLocalLeg(from, to, options);
  loopCount("osmFallbackLegs");
  return fallback ? [fallback] : [];
  } finally {
    endTiming?.();
  }
}

/** 첫 번째 로컬 후보를 돌려주는 기존 호출부 호환 래퍼. */
export function localLeg(
  from: LatLng,
  to: LatLng,
  options: LocalRouteOptions = {},
): LocalLeg | null {
  return localLegCandidates(from, to, { ...options, alternatives: options.alternatives ?? 1 })[0] ?? null;
}

/**
 * 표준노드링크 실패·라스트마일 연결에 쓰는 OSM 경로. 출발·도착점이 리조트·단지
 * 같은 부지 안이면 진입로(access-route)로 본선 관문까지 나간 뒤 본선 A*를 돈다.
 * 이탈 재탐색(startHeading 있음)은 이미 도로 위이므로 출발 쪽 진입로를 안 쓴다.
 */
function osmLocalLeg(
  from: LatLng,
  to: LatLng,
  options: LocalRouteOptions = {},
): LocalLeg | null {
  const g = loadGraph();
  if (!g) return null;
  const mainNear = (p: LatLng) => {
    const { edge, d } = scanNearestEdge(g, p.lat, p.lng);
    return { d: edge < 0 ? Infinity : d, motorway: edge >= 0 && (g.eCls[edge] & 127) <= 1 };
  };
  const ms = options.startHeading == null ? mainNear(from) : null;
  const me = mainNear(to);
  const sAcc = ms ? accessLeg(from, "start", to, ms.d, ms.motorway) : null;
  const eAcc = accessLeg(to, "end", from, me.d, me.motorway);
  if (!sAcc && !eAcc) return osmMainLeg(g, from, to, options);
  const core = osmMainLeg(g, sAcc?.gate ?? from, eAcc?.gate ?? to, options);
  // 코스 탐색: 진입로 관문이 끊긴 조각에 붙으면 진입로 없이 다시 찾는다. 내비는 그대로 둔다.
  if (!core) return options.explore ? osmMainLeg(g, from, to, options) : null;
  const path = [...(sAcc?.path ?? []), ...core.path, ...(eAcc?.path ?? [])];
  return {
    ...core,
    path,
    dist: Math.round(core.dist + (sAcc?.distM ?? 0) + (eAcc?.distM ?? 0)),
    dur: Math.round(core.dur + (sAcc?.sec ?? 0) + (eAcc?.sec ?? 0)),
  };
}

function osmMainLeg(
  g: Graph,
  from: LatLng,
  to: LatLng,
  options: LocalRouteOptions,
): LocalLeg | null {
  const endTiming = startLoopStage("local.osmSearch");
  try {
  // 카카오 경로와의 50m 중첩률까지 함께 최적화한 보수적 탐색값. ETA 적분은
  // 실시간 속도를 온전히 쓰되 A* 경로 선택에는 75%만 반영해 순간 노이즈로
  // 먼 우회로를 고르는 현상을 억제한다.
  const itsBlend = etaParam("ETA_ITS_SEARCH_BLEND", 0.75, 0, 1.5);
  const maxSpeedup = etaParam("ETA_ITS_MAX_SPEEDUP", 1 / 0.85, 0.8, 1.5);
  const roadPrefScale = etaParam("ETA_ROAD_PREF_SCALE", 0.25, 0, 2);
  const turnScale = etaParam("ETA_TURN_SCALE", 1, 0, 2);

  // 출발 스냅은 진행방향을 반영한다. heading 없이 최근접 끝점만 고르면 양방향
  //   도로에서 **내 뒤쪽 노드**에 붙어 경로가 뒤로 시작하고, 곧 유턴 안내가 된다
  //   (이탈 재탐색에서 특히 치명적). nodelink 엔진은 이미 heading을 쓰는데 이
  //   OSM 폴백만 무시하고 있었다.
  const s =
    options.startHeading != null
      ? snapHeading(g, from, options.startHeading)
      : options.explore
        ? snapUsable(g, from, "start")
        : snap(g, from, "start");
  const t = options.explore ? snapUsable(g, to, "end") : snap(g, to, "end");
  if (s < 0 || t < 0) return null;
  // 코스 탐색: 바다로 끊겼거나 들어오는 길이 없으면 지도 전체를 뒤지지 않고 바로 실패한다.
  if (options.explore && s !== t) {
    const comp = osmComponent(g);
    if (comp[s] !== comp[t] || !osmTargetReachable(g, t)) return null;
  }
  if (s === t) {
    return { path: [from, to], dur: 60, dist: dM(from.lat, from.lng, to.lat, to.lng), toll: 0, juncPerKm: 0 };
  }

  // 상태를 "노드"가 아니라 "방금 통과한 방향 간선(CSR slot)"으로 둔다.
  // 그래야 같은 교차로에 서로 다른 진입 링크로 온 경우를 구분해 TURNINFO를
  // 정확히 적용할 수 있다.
  const stateCount = g.adjTo.length;
  if (!bufDist || bufDist.length !== stateCount) {
    bufDist = new Float64Array(stateCount);
    bufPrevState = new Int32Array(stateCount);
    bufGen = new Int32Array(stateCount);
    curGen = 0;
  }
  curGen++;
  const gen = bufGen!;
  const distRaw = bufDist;
  const prevState = bufPrevState!;
  const dist = {
    get: (i: number) => (gen[i] === curGen ? distRaw[i] : Infinity),
    set: (i: number, v: number) => {
      distRaw[i] = v;
      gen[i] = curGen;
    },
  };
  const tLat = g.nLat[t],
    tLng = g.nLng[t];
  const heuristicScale = options.explore ? EXPLORE_HEURISTIC_SCALE : 1;
  const maxVisits = options.explore
    ? exploreVisitLimit(dM(from.lat, from.lng, to.lat, to.lng))
    : Infinity;
  // 간선마다 process.env를 읽지 않도록 탐색 시작 때 한 번 읽는다(튜닝 스크립트는 탐색 사이에 값을 바꾼다).
  const itsEtaScale = etaParam("ETA_ITS_SPEED_SCALE", 1.0, 0.7, 1.6);
  const h = (i: number) => {
    const direct = dM(g.nLat[i], g.nLng[i], tLat, tLng);
    return (options.objective === "distance" ? direct : direct / MAX_SPEED_MPS) * heuristicScale;
  };

  // 방향별 사전 crosswalk로 ITS 속도를 직접 읽는다. 공간 최근접 검색을 A*의
  // 핫루프에서 제거하고, 미커버 간선만 도로급 기본속도로 폴백한다.
  const useIts = trafficAvailable();
  const speedCache = new Map<number, number | null>();
  const edgeSpeed = (state: number): { kmh: number; its: boolean } => {
    const e = g.adjEdge[state], fromNode = g.adjFrom[state], cls = g.eCls[e] & 127;
    if (useIts) {
      const mapped = directedNodelinkMid(g, e, fromNode);
      if (mapped) {
        let speed = speedCache.get(mapped);
        if (speed === undefined) {
          speed = nodelinkSpeedKmh(mapped - 1);
          speedCache.set(mapped, speed);
        }
        if (speed && speed > 0) return { kmh: Math.min(130, speed * itsEtaScale), its: true };
      }
    }
    return { kmh: SPEED_KMH[cls] ?? 40, its: false };
  };
  const edgeSearchCost = (state: number) => {
    const e = g.adjEdge[state], cls = g.eCls[e] & 127, speed = edgeSpeed(state);
    if (options.objective === "distance") return g.eLen[e];
    const base = SPEED_KMH[cls] ?? 40;
    // 관측속도가 비정상적으로 높을 때 먼 우회로가 공짜처럼 보이지 않게
    // A* 선택용 속도 향상은 도로급 기준 +18%까지만 허용한다. 느린 값(정체)은
    // 그대로 반영한다. ETA 적분은 아래에서 검증된 ITS 속도 보정값을 사용한다.
    const cappedIts = Math.min(speed.kmh, base * maxSpeedup);
    const searchKmh = speed.its ? base + (cappedIts - base) * itsBlend : speed.kmh;
    const pref = 1 + ((ROAD_PREF[cls] ?? 1.2) - 1) * roadPrefScale;
    let jamMul = 1;
    if (options.avoidJam) {
      // 관측 통행속도가 도로급 기준보다 느린 만큼 비용 증폭 – 실제 우회.
      if (speed.its && speed.kmh < base) {
        jamMul += JAM_WEIGHT * Math.min(1, (base - speed.kmh) / base);
      }
      // unclassified(10) 이하 좁은 길은 통과로 기피(주택/이면도로는 아래 게이트에서 배제).
      if (cls >= 10) jamMul *= 1.5;
    }
    return (g.eLen[e] / (Math.max(searchKmh, 5) / 3.6)) * pref * jamMul;
  };

  const heap = new Heap();
  for (let state = g.adjOff[s]; state < g.adjOff[s + 1]; state++) {
    const v = g.adjTo[state];
    if (v !== t && milRoadBlocked(g, state)) continue;
    const d = edgeSearchCost(state);
    dist.set(state, d);
    prevState[state] = -1;
    heap.push(d + h(v), state);
  }
  let goalState = -1;
  let visits = 0;
  while (heap.size && visits++ < maxVisits) {
    const { dist: f, idx: state } = heap.pop();
    const u = g.adjTo[state];
    if (f > dist.get(state) + h(u) + 1e-6) continue;
    if (u === t) { goalState = state; break; }
    for (let next = g.adjOff[u]; next < g.adjOff[u + 1]; next++) {
      const v = g.adjTo[next];
      // 군사지역 노드는 통과 금지 (목적지가 그 안이면 예외 — 안 그러면 실패)
      if (v !== t && milRoadBlocked(g, next)) continue;
      const nextEdge = g.adjEdge[next], nextCls = g.eCls[nextEdge] & 127;
      const motorway = nextCls <= 1 || ((nextCls === 2 || nextCls === 3) && g.eMotor[nextEdge]);
      if (options.avoidMotorway && motorway && v !== t) continue;
      // 정체 회피 우회: 주택가·이면도로(residential 11·living_street 12)는 통과 금지(목적지 예외).
      if (options.avoidJam && nextCls >= 11 && v !== t) continue;
      if (isForbiddenTurn(g, state, next)) continue;
      const turnCost = options.objective === "distance"
        ? 0
        : turnPenaltySec(g, state, next) * turnScale + osmUturnExtraSec(g, prevState, state, next);
      const nd =
        dist.get(state) +
        turnCost +
        edgeSearchCost(next);
      if (nd < dist.get(next)) {
        dist.set(next, nd);
        prevState[next] = state;
        heap.push(nd + h(v), next);
      }
    }
  }
  if (goalState < 0) return null;

  // 경로 복원 (간선 geometry 포함, 방향 맞춰서)
  const path: LatLng[] = [to];
  const routeStates: number[] = [];
  let totalM = 0;
  let state = goalState;
  while (state >= 0) {
    routeStates.push(state);
    const e = g.adjEdge[state], u = g.adjFrom[state], cur = g.adjTo[state];
    totalM += g.eLen[e];
    const off = g.eGeomOff[e],
      cnt = g.eGeomCnt[e];
    path.push({ lat: g.nLat[cur], lng: g.nLng[cur] });
    // 간선 저장 방향은 eA–eB. u–cur 이동이 eA–eB면 geometry를 역순으로 담는다
    // (path를 도착–출발로 쌓는 중이라)
    const forward = g.eA[e] === u;
    if (forward) {
      for (let i = cnt - 1; i >= 0; i--)
        path.push({ lat: g.geom[(off + i) * 2], lng: g.geom[(off + i) * 2 + 1] });
    } else {
      for (let i = 0; i < cnt; i++)
        path.push({ lat: g.geom[(off + i) * 2], lng: g.geom[(off + i) * 2 + 1] });
    }
    state = prevState[state];
  }
  path.push({ lat: g.nLat[s], lng: g.nLng[s] }, from);
  path.reverse();
  routeStates.reverse();

  // 정체 노출도 — 경로를 ~200m 간격으로 훑어 각 점 120m 안에 실교차로가
  // 있는지 세고, km당 개수로 환산한다(고속·시골 ~0.3, 도심 그리드 ~4).
  // 카카오 없이 도심 정체를 반영하는 유일한 신호. (샘플 간격 고정=측정 안정)
  let hits = 0;
  let acc = SAMPLE_STEP_M;
  for (let i = 1; i < path.length; i++) {
    acc += dM(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
    if (acc >= SAMPLE_STEP_M) {
      acc = 0;
      if (junctionCountNear(path[i], 120) >= 1) hits++;
    }
  }
  const km = Math.max(totalM / 1000, 0.1);
  const juncPerKm = hits / km;
  const cal = timeCalib();
  const congMul = Math.min(1 + cal.k * Math.max(juncPerKm - cal.d0, 0), cal.cap);

  const calibMul = cal.calib * congMul * hourMulNow();
  // 로컬 경로는 400m 공간표본이 아니라 실제 A* 방향 간선마다 적분한다.
  // crosswalk+ITS가 있으면 현재속도 그대로, 없으면 도로급+기존 보정으로 계산.
  let routeSec = 0;
  for (let i = 0; i < routeStates.length; i++) {
    const routeState = routeStates[i], edge = g.adjEdge[routeState];
    const speed = edgeSpeed(routeState);
    routeSec +=
      (g.eLen[edge] / (Math.max(speed.kmh, 5) / 3.6)) *
      (speed.its ? 1 : calibMul);
    if (i > 0) {
      routeSec += turnPenaltySec(g, routeStates[i - 1], routeState) * turnScale;
    }
  }
  return {
    path,
    dur: Math.round(routeSec),
    dist: Math.round(totalM),
    toll: 0,
    juncPerKm,
  };
  } finally {
    endTiming?.();
  }
}

/**
 * 자체 내비 포크(Y분기) 안내용 — p에서 radiusM 안 가장 가까운 실교차로
 * (진출 차수 ≥3)의 진출 간선 방위 목록. 각 간선의 초기 진행 방위(° 북 기준
 * 시계)와 도로급 속도를 준다. 일방통행 진입 불가 간선은 인접 리스트에
 * 없으므로 자연히 빠진다. 그래프 없거나 교차로 없으면 null.
 */
export function edgeBearingsAt(
  p: LatLng,
  radiusM = 40,
): { deg: number; kmh: number; dest?: { d?: string; r?: string } }[] | null {
  const g = loadGraph();
  if (!g) return null;
  const ci = Math.floor(p.lat / GRID_CELL);
  const cj = Math.floor(p.lng / GRID_CELL);
  let node = -1;
  let bd = Infinity;
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const arr = g.grid.get(a * 100000 + b + 2_000_000_000);
      if (!arr) continue;
      for (const i of arr) {
        if (g.adjOff[i + 1] - g.adjOff[i] < 3) continue;
        const d = dM(p.lat, p.lng, g.nLat[i], g.nLng[i]);
        if (d <= radiusM && d < bd) {
          bd = d;
          node = i;
        }
      }
    }
  }
  if (node < 0) return null;
  const out: { deg: number; kmh: number; dest?: { d?: string; r?: string } }[] =
    [];
  const nLat = g.nLat[node];
  const nLng = g.nLng[node];
  for (let q = g.adjOff[node]; q < g.adjOff[node + 1]; q++) {
    const e = g.adjEdge[q];
    const other = g.adjTo[q];
    const cnt = g.eGeomCnt[e];
    // 간선의 첫 실제 꺾임점 방향 — geometry가 있으면 노드 쪽 첫 점
    let tLat: number;
    let tLng: number;
    if (cnt > 0) {
      const off = g.eGeomOff[e];
      const gi = g.eA[e] === node ? off : off + cnt - 1;
      tLat = g.geom[gi * 2];
      tLng = g.geom[gi * 2 + 1];
    } else {
      tLat = g.nLat[other];
      tLng = g.nLng[other];
    }
    const deg =
      (Math.atan2((tLng - nLng) * kx(nLat), (tLat - nLat) * 110_540) * 180) /
      Math.PI;
    out.push({
      deg,
      kmh: SPEED_KMH[g.eCls[e] & 127] ?? 40,
      dest: g.dest?.get(e) ?? undefined,
    });
  }
  return out;
}

/**
 * 현재 위치·진행방향에서 **실제 도로를 따라** maxM 앞까지 이은 폴리라인.
 * 교차로마다 진행방향과 최소회전(직진에 가장 가까운) 간선을 골라 "지금 달리는
 * 길"을 잇는다. 경로가 없는 자유주행에서 '진짜 앞 도로 위 카메라'만 가려내는
 * 용도 — heading의 직선 연장이 아니라 도로 곡률을 따르므로, 커브 앞에서 직선
 * 연장선에 걸리던 옆 카메라 오탐을 없앤다. 스냅 실패/막다른 길이면 짧게 반환.
 */
export function roadAhead(
  lat: number,
  lng: number,
  heading: number,
  maxM = 650,
): LatLng[] {
  const g = loadGraph();
  if (!g) return [];
  // 시작점은 **간선 투영**으로 스냅한다(노드 스냅 금지). 간선이 길면 최근접
  //   노드가 수백 m 떨어진 옆길일 수 있어, 노드 스냅은 추적을 엉뚱한 방향으로
  //   시작하거나 즉시 죽인다(이 코드베이스에서 라우팅 오스냅으로 겪은 함정).
  //   진행방향 쪽 끝점(role="start")에서 추적을 시작한다.
  const { edge, d: edgeD } = scanNearestEdge(g, lat, lng, heading);
  let node = -1;
  if (edge >= 0 && edgeD <= SNAP_EDGE_MAX) {
    const a = g.eA[edge];
    const b = g.eB[edge];
    if (g.eCls[edge] & 128) {
      node = b; // 편도는 진행 끝점이 확정
    } else {
      // 양방향 — heading과 같은 방향의 끝점을 고른다
      const ba =
        (Math.atan2(
          (g.nLng[a] - lng) * kx(lat),
          (g.nLat[a] - lat) * 110540,
        ) *
          180) /
        Math.PI;
      const bb =
        (Math.atan2(
          (g.nLng[b] - lng) * kx(lat),
          (g.nLat[b] - lat) * 110540,
        ) *
          180) /
        Math.PI;
      const off = (x: number) => Math.abs(((x - heading + 540) % 360) - 180);
      node = off(bb) <= off(ba) ? b : a;
    }
  } else {
    node = snapNode(g, { lat, lng });
  }
  if (node < 0) return [];

  const norm = (x: number) => Math.abs(((x + 540) % 360) - 180);
  // 노드에서 간선으로 들어가는 방위 — 첫 지오메트리 점만 보면 짧은 첫 세그먼트에
  // 노이즈가 끼므로 ~25m 지점까지 따라가 안정화한다(분기점 오판 방지).
  const entryBrg = (e: number, from: number): number => {
    const cnt = g.eGeomCnt[e];
    const nLa = g.nLat[from];
    const nLo = g.nLng[from];
    let tLa = nLa;
    let tLo = nLo;
    if (cnt > 0) {
      const off = g.eGeomOff[e];
      const fwd = g.eA[e] === from;
      let pLa = nLa;
      let pLo = nLo;
      let a = 0;
      for (let k = 0; k < cnt; k++) {
        const gi = fwd ? off + k : off + (cnt - 1 - k);
        tLa = g.geom[gi * 2];
        tLo = g.geom[gi * 2 + 1];
        a += dM(pLa, pLo, tLa, tLo);
        pLa = tLa;
        pLo = tLo;
        if (a >= 25) break;
      }
    } else {
      const other = g.eA[e] === from ? g.eB[e] : g.eA[e];
      tLa = g.nLat[other];
      tLo = g.nLng[other];
    }
    return (Math.atan2((tLo - nLo) * kx(nLa), (tLa - nLa) * 110540) * 180) / Math.PI;
  };
  const out: LatLng[] = [{ lat, lng }];
  let curBrg = heading;
  let curClass = 99; // 현재 달리는 도로급(낮을수록 상위도로). 첫 홉은 방향만.
  let curName: string | null = null; // Y분기에서 이어갈 도로명(확정됐을 때만)
  let prevNode = -1;
  let acc = 0;
  for (let hop = 0; hop < 80 && acc < maxM; hop++) {
    // 진행방향 최소회전 + 도로급 유지 점수. 본선(낮은 cls)에서 램프·이면도로
    // (높은 cls)로 새면 벌점을 줘, 본선이 살짝 휘고 램프가 곧게 뻗어도 본선을
    // 유지한다(커브 앞 직선연장 옆도로 오탐의 주범 차단).
    const cands: { e: number; to: number; score: number }[] = [];
    for (let q = g.adjOff[node]; q < g.adjOff[node + 1]; q++) {
      const other = g.adjTo[q];
      if (other === prevNode) continue;
      const e = g.adjEdge[q];
      const turn = norm(entryBrg(e, node) - curBrg);
      if (turn > 80) continue; // 급회전 후보 배제
      const cls = g.eCls[e] & 127;
      // _link(램프)=홀수 클래스 1/3/5/7/9. 본선(비-link)에서 램프로 빠지는 건
      // 크게 벌점 — 곧게 뻗은 진출램프로 새는 오탐의 주범.
      const isLink = (c: number) => c <= 9 && c % 2 === 1;
      let penalty = curClass < 99 && cls > curClass ? (cls - curClass) * 28 : 0;
      if (curClass < 99 && !isLink(curClass) && isLink(cls)) penalty += 40;
      cands.push({ e, to: other, score: turn + penalty });
    }
    if (cands.length === 0) break; // 막다른 길·모두 급회전 = 직진 도로 끝
    cands.sort((a, b) => a.score - b.score);
    let pick = cands[0];

    // 각도·도로급이 비슷한 갈래가 둘 이상이면(같은 등급 Y분기) 각도만으로는
    // 본선을 못 가른다. ① 도로 이름이 이어지는 쪽을 본선으로(실내비 관례),
    // ② 이름으로도 못 가리면 **추적을 여기서 끊는다** — 모르는 갈래를 찍어
    //   그 앞 카메라를 "내 길"이라 우기는 게 남은 오탐의 정체라, 확신이 없으면
    //   주장하지 않는 편이 낫다(분기를 지나면 다음 폴링에서 자연히 풀린다).
    // 첫 홉은 애매성 검사를 건너뛴다 — 지금 달리는 도로는 heading으로 이미
    // 확정적이고, 여기서 끊으면 추적이 0점이 돼 필터가 통째로 사라진다.
    if (hop > 0 && cands.length > 1 && cands[1].score - cands[0].score < 20) {
      // named-roads는 주요 도로 위주라 이면도로엔 이름이 없다(정상).
      const nameHere: string | null =
        curName ?? roadNameAt({ lat: g.nLat[node], lng: g.nLng[node] }, 60);
      let matched: (typeof cands)[number] | null = null;
      let ties = 0;
      if (nameHere) {
        for (const c of cands.slice(0, 3)) {
          // 갈래로 ~30m 들어간 지점의 도로명
          const cnt = g.eGeomCnt[c.e];
          let pLat: number;
          let pLng: number;
          if (cnt > 0) {
            const off = g.eGeomOff[c.e];
            const fwd = g.eA[c.e] === node;
            const gi = fwd ? off + Math.min(1, cnt - 1) : off + cnt - 1 - Math.min(1, cnt - 1);
            pLat = g.geom[gi * 2];
            pLng = g.geom[gi * 2 + 1];
          } else {
            pLat = (g.nLat[node] + g.nLat[c.to]) / 2;
            pLng = (g.nLng[node] + g.nLng[c.to]) / 2;
          }
          if (roadNameAt({ lat: pLat, lng: pLng }, 60) === nameHere) {
            if (!matched) matched = c;
            ties++;
          }
        }
      }
      if (matched && ties === 1) {
        pick = matched;
        curName = nameHere;
      } else if (cands[1].score - cands[0].score < 8) {
        // 이름으로도 못 가리고 각도·등급도 사실상 동점 = 진짜 동전던지기.
        // 찍어서 그 앞 카메라를 "내 길"이라 우기느니 여기서 추적을 끊는다
        // (분기를 지나면 다음 폴링에서 자연히 풀린다).
        break;
      } else {
        curName = null; // 이름은 못 썼지만 점수차가 있으니 최선 후보로 진행
      }
    } else {
      curName = null; // 명확한 진행 — 이름 캐시는 다음 애매 분기에서 다시 조회
    }
    const bestE = pick.e;
    const bestTo = pick.to;
    curClass = g.eCls[bestE] & 127;
    const cnt = g.eGeomCnt[bestE];
    const off = g.eGeomOff[bestE];
    const forward = g.eA[bestE] === node;
    for (let k = 0; k < cnt; k++) {
      const gi = forward ? off + k : off + (cnt - 1 - k);
      const p = { lat: g.geom[gi * 2], lng: g.geom[gi * 2 + 1] };
      const last = out[out.length - 1];
      acc += dM(last.lat, last.lng, p.lat, p.lng);
      out.push(p);
      if (acc >= maxM) break;
    }
    if (acc < maxM) {
      const p = { lat: g.nLat[bestTo], lng: g.nLng[bestTo] };
      const last = out[out.length - 1];
      acc += dM(last.lat, last.lng, p.lat, p.lng);
      out.push(p);
    }
    const p1 = out[out.length - 2];
    const p2 = out[out.length - 1];
    curBrg =
      (Math.atan2(
        (p2.lng - p1.lng) * kx(p1.lat),
        (p2.lat - p1.lat) * 110540,
      ) *
        180) /
      Math.PI;
    prevNode = node;
    node = bestTo;
  }
  return out;
}

/**
 * 자체 내비 ETA용 시간 보정 — 도로급 속도로 적분한 순수 주행시간(rawSec)에
 * localLeg과 같은 보정(지체 계수 × 교차로밀도 정체 × 시간대)을 적용한다.
 */
export function applyTimeCalib(rawSec: number, juncPerKm: number): number {
  const cal = timeCalib();
  const congMul = Math.min(1 + cal.k * Math.max(juncPerKm - cal.d0, 0), cal.cap);
  return rawSec * cal.calib * congMul * hourMulNow();
}

/**
 * 경로를 ~400m 간격으로 훑어 각 지점의 도로종류 기반 속도(km/h)를 낸다.
 * 각 점을 그래프 노드에 스냅한 뒤 인접 간선 중 가장 빠른 도로급(=관통 도로)의
 * 기본 속도를 쓴다. 실제 제한속도 표지판(maxspeed)이 아니라 도로종류 기반
 * 추정 — 지도 '속도' 색칠용. 그래프 없으면 빈 배열.
 */
export function pathSpeedSamples(
  path: LatLng[],
): { lat: number; lng: number; kmh: number }[] {
  return pathSpeedProfile(path).map(({ i, kmh }) => ({
    lat: path[i].lat,
    lng: path[i].lng,
    kmh,
  }));
}

/**
 * pathSpeedSamples의 인덱스 버전 — 자체 내비가 경로 진행도(누적거리)에
 * 속도를 붙여 남은 시간(ETA)을 적분할 수 있게 경로 인덱스를 준다.
 */
export function pathSpeedProfile(path: LatLng[]): PathSpeed[] {
  const g = loadGraph();
  if (path.length < 2) return [];
  const STEP = 400;
  const out: PathSpeed[] = [];
  let acc = STEP;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) acc += dM(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
    const last = i === path.length - 1;
    if (acc < STEP && i !== 0 && !last) continue;
    acc = 0;
    // 최근접 간선의 도로급 속도 — 노드 스냅은 긴 고속 간선에서 옆 골목으로
    // 튀어 ETA가 느려지므로, 간선 투영으로 실제 주행 도로의 급을 읽는다.
    const before = path[Math.max(0, i - 1)];
    const after = path[Math.min(path.length - 1, i + 1)];
    const heading =
      before !== after
        ? (Math.atan2(
            (after.lng - before.lng) * kx(path[i].lat),
            (after.lat - before.lat) * 110540,
          ) *
            180) /
          Math.PI
        : null;
    const itsKmh = nearestLinkSpeedKmh(path[i], heading);
    if (itsKmh !== null) {
      // 네이티브 localLeg ETA와 같은 보정값을 써 카카오 앵커가 없을 때도
      // 안내용 속도 적분과 최초 표시 ETA가 서로 어긋나지 않게 한다.
      out.push({
        i,
        kmh: etaItsSpeedKmh(itsKmh, "NODELINK_ETA_ITS_SPEED_SCALE", 1.0),
        its: true,
      });
      continue;
    }
    if (!g) continue;
    const { edge, d } = scanNearestEdge(g, path[i].lat, path[i].lng, heading);
    if (edge < 0 || d > SNAP_EDGE_MAX) continue;
    const kmh = SPEED_KMH[g.eCls[edge] & 127] ?? 50;
    out.push({ i, kmh });
  }
  return out;
}

/** 속도 런렝스를 세그먼트별 적분. ITS가 아닌 구간에만 기존 보정 배율을 적용한다. */
export function integrateSpeedProfile(
  path: LatLng[],
  profile: PathSpeed[],
  fallbackCalibMul: number,
): number | null {
  if (path.length < 2 || profile.length === 0) return null;
  const itsHourMul = itsHourMulNow();
  let sec = 0;
  let p = 0;
  let speed = profile[0];
  for (let i = 1; i < path.length; i++) {
    while (p < profile.length - 1 && profile[p + 1].i <= i - 1) {
      speed = profile[++p];
    }
    const len = dM(path[i - 1].lat, path[i - 1].lng, path[i].lat, path[i].lng);
    sec +=
      (len / (Math.max(speed.kmh, 5) / 3.6)) *
      (speed.its ? itsHourMul : fallbackCalibMul);
  }
  return sec;
}

/** OSM 도로망 조각 번호. 뜻은 표준노드링크의 nodeComponents와 같다. 처음 쓸 때 한 번 만든다. */
let osmComponentsOf: Graph | null = null;
let osmComponents = new Uint32Array(0);
let osmComponentSizes = new Uint32Array(0);
function osmComponent(g: Graph): Uint32Array {
  if (osmComponentsOf === g) return osmComponents;
  const parent = new Uint32Array(g.nLat.length);
  for (let i = 0; i < parent.length; i++) parent[i] = i;
  const find = (x: number) => {
    while (parent[x] !== x) x = parent[x] = parent[parent[x]];
    return x;
  };
  for (let e = 0; e < g.eA.length; e++) {
    const a = find(g.eA[e]), b = find(g.eB[e]);
    if (a !== b) parent[a] = b;
  }
  for (let i = 0; i < parent.length; i++) parent[i] = find(i);
  const sizes = new Uint32Array(parent.length);
  for (let i = 0; i < parent.length; i++) sizes[parent[i]]++;
  osmComponentsOf = g;
  osmComponents = parent;
  osmComponentSizes = sizes;
  return parent;
}

const OSM_REACH_NODES = 3000;
let osmInOf: Graph | null = null;
let osmInOff = new Uint32Array(0);
let osmInStates = new Uint32Array(0);
/** OSM에서 이 노드에서 나가는 길이 충분한지. 일방통행 골목 끝처럼 막힌 출발점을 가려낸다. */
function osmSourceReachable(g: Graph, s: number): boolean {
  const seen = new Set<number>([s]), queue = [s];
  for (let i = 0; i < queue.length && seen.size < OSM_REACH_NODES; i++) {
    const node = queue[i];
    for (let k = g.adjOff[node]; k < g.adjOff[node + 1]; k++) {
      const next = g.adjTo[k];
      if (seen.has(next) || milRoadBlocked(g, k)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return reachEnough(g, s, seen.size);
}

/**
 * 충분히 뻗어 나갔는지. 울릉도처럼 도로망 전체가 작으면 그 조각을 거의 다 돌았는지로 본다.
 * 큰 도로망의 막다른 곳만 걸러내고, 작지만 이어진 섬이나 마을은 거르지 않는다.
 */
function reachEnough(g: Graph, node: number, reached: number): boolean {
  if (reached >= OSM_REACH_NODES) return true;
  const comp = osmComponent(g);
  return reached >= osmComponentSizes[comp[node]] * 0.5;
}

// 기존 도로 붙이기 한계와 같다. 더 멀면 강이나 방음벽 건너 도로에 붙을 위험이 커진다.
const SNAP_USABLE_MAX_M = SNAP_EDGE_MAX;
const SNAP_USABLE_TRIES = 20;
/**
 * 코스 탐색용 도로 붙이기 — 가장 가까운 도로가 막다른 곳이거나 끊긴 조각이면 옆 도로를 본다.
 * 이천향교는 2칸 가면 끝나는 일방통행 골목에, 강릉 진입로 관문은 나가는 길이 없는 점에 붙어
 * 옆에 큰길이 있어도 길찾기가 바로 실패했다. 쓸 만한 곳이 없으면 원래 결과를 돌려준다.
 */
function snapUsable(g: Graph, p: LatLng, role: "start" | "end"): number {
  const usable = (node: number) =>
    role === "start" ? osmSourceReachable(g, node) : osmTargetReachable(g, node);
  const nearest = snap(g, p, role);
  if (nearest >= 0 && usable(nearest)) return nearest;
  const near: { edge: number; d: number }[] = [];
  const seenEdges = new Set<number>();
  const ci = Math.floor(p.lat / GRID_CELL), cj = Math.floor(p.lng / GRID_CELL);
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      for (const node of g.grid.get(a * 100000 + b + 2_000_000_000) ?? []) {
        for (let k = g.adjOff[node]; k < g.adjOff[node + 1]; k++) {
          const edge = g.adjEdge[k];
          if (seenEdges.has(edge)) continue;
          seenEdges.add(edge);
          const { d } = distToEdge(g, edge, p.lat, p.lng);
          if (d <= SNAP_USABLE_MAX_M) near.push({ edge, d });
        }
      }
    }
  }
  near.sort((x, y) => x.d - y.d);
  const tried = new Set<number>([nearest]);
  for (const { edge } of near.slice(0, SNAP_USABLE_TRIES)) {
    const ends = g.eCls[edge] & 128
      ? [role === "end" ? g.eA[edge] : g.eB[edge]]
      : [g.eA[edge], g.eB[edge]];
    for (const node of ends) {
      if (tried.has(node)) continue;
      tried.add(node);
      if (usable(node)) return node;
    }
  }
  return nearest;
}

/**
 * OSM에서 이 노드로 들어오는 길이 충분한지 — 거꾸로 따라가 노드가 충분히 나오면 이어진 것이다.
 * 탐색과 같게 군사 구역의 작은 길은 지나가지 않는다(마지막 도착 간선은 예외).
 */
function osmTargetReachable(g: Graph, t: number): boolean {
  if (osmInOf !== g) {
    const nodes = g.nLat.length, total = g.adjTo.length, off = new Uint32Array(nodes + 1);
    for (let i = 0; i < total; i++) off[g.adjTo[i] + 1]++;
    for (let i = 0; i < nodes; i++) off[i + 1] += off[i];
    const pos = off.slice(), states = new Uint32Array(total);
    for (let i = 0; i < total; i++) states[pos[g.adjTo[i]]++] = i;
    osmInOf = g;
    osmInOff = off;
    osmInStates = states;
  }
  const seen = new Set<number>([t]), queue = [t];
  for (let i = 0; i < queue.length && seen.size < OSM_REACH_NODES; i++) {
    const node = queue[i];
    for (let k = osmInOff[node]; k < osmInOff[node + 1]; k++) {
      const state = osmInStates[k], prev = g.adjFrom[state];
      if (seen.has(prev) || (node !== t && milRoadBlocked(g, state))) continue;
      seen.add(prev);
      queue.push(prev);
    }
  }
  return reachEnough(g, t, seen.size);
}

/** 길찾기 규칙이 막는 군사 구역 안인지. */
export function isMilitaryAnchor(p: LatLng): boolean {
  return milBlocked(p.lat, p.lng);
}

/**
 * 코스 경유지로 쓸 수 있는 곳인지 — 길찾기 전에 거른다. 사용자가 직접 넣은 경유지엔 쓰지 않는다.
 * 군사 구역(길찾기 규칙이 막음)과, 두 도로망 어디로도 들어갈 수 없는 곳(바다, 끊긴 조각)을 뺀다.
 */
export function isRoutableAnchor(p: LatLng): boolean {
  if (milBlocked(p.lat, p.lng)) return false;
  if (nodelinkTargetConnected(p)) return true;
  const g = loadGraph();
  if (!g) return true;
  const t = snapUsable(g, p, "end");
  return t >= 0 && osmTargetReachable(g, t);
}
