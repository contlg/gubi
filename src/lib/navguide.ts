import "server-only";

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { GuidanceCache } from "@/lib/guidance-cache";

import {
  applyTimeCalib,
  destinationAt,
  dividedExpresswayNear,
  edgeBearingsAt,
  expresswayNear,
  junctionCountNear,
  localLeg,
  type LocalLeg,
  pathJuncPerKm,
  pathSpeedProfile,
  type PathSpeed,
  roadDirAt,
  roadClassAlong,
  speedLimitsAlong,
  structAlong,
} from "@/lib/localroute";
import { roadAtPoint } from "@/lib/roadinfo";
import { cameraRoadMatchesRoute, cameraRoadNameMatchesRoute, sameRoadName, CAMERA_ROAD_SNAP_M } from "@/lib/camera-road";
import { roadNameAt } from "@/lib/road-names";
import { cameraRoadLevelAtPoint } from "@/lib/camera-road-level-context";
import { matchPathNodelinks, nearbyNodelinks, type NodelinkPathMatch } from "@/lib/nodelink";
import type { LatLng } from "@/lib/types";

/**
 * 자체 내비 안내 엔진 (서버) — 코스 경로에서 실제 내비처럼 안내에 필요한
 * 것들을 미리 뽑는다:
 * - 회전 안내 지점: 베어링 변화 클러스터 + "실교차로 근처" 필터.
 *   와인딩 헤어핀은 갈림길이 없어 안내가 필요 없다 — 교차로 필터가
 *   커브 오탐을 걸러낸다. 회전 후 도로명(named-roads)을 멘트에 붙인다.
 * - 경로변 단속카메라(고정식·구간): 경찰청 데이터에서 경로 45m 안.
 * - 속도 프로파일: 도로급 속도 표본 — 남은 시간(ETA) 적분용.
 * 이탈 재탐색은 로컬 A*로 코스 전방 복귀점까지 잇고 안내를 다시 뽑는다.
 */

export type ManeuverType =
  | "left"
  | "right"
  | "slight-left"
  | "slight-right"
  | "sharp-left"
  | "sharp-right"
  | "uturn"
  // 고속도로·자동차전용도로 진출 램프/갈림길 — 회전이 아니라 "방향"
  | "keep-left"
  | "keep-right"
  // 일반도로 갈림길(Y분기) — 커브가 아니라 "갈림길에서 좌/우" (방면 이름 부착)
  | "fork-left"
  | "fork-right"
  // 회전교차로 — "우회전"이 아니라 회전교차로 안내
  | "roundabout-left"
  | "roundabout-right"
  // 구조물 진입 — 고가도로/지하차도/터널 (회전이 아닌 "진입" 안내)
  | "overpass"
  | "underpass"
  | "tunnel"
  | "arrive";

export interface NavManeuver {

  at: number;
  type: ManeuverType;
  /** 회전 후 진입 도로명 — 없으면 생략 */
  road?: string;
  /** 분기·출구 방면 "서울·대구·유성분기점" — 고속 진출/분기에만, 없으면 생략 */
  dest?: string;
  lat: number;
  lng: number;
}

export interface NavCam {
  at: number;
  lat: number;
  lng: number;
  kind: "fixed" | "section" | "signal";

  deviceId?: string;

  speed?: boolean;
  signal?: boolean;
  rear?: boolean;
  /** 제한속도 km/h — 0/미상이면 생략 */
  limitKmh?: number;
  /** 구간단속 게이트. inside-end는 경로가 구간 중간에 합류해 종점만 확인된 경우. */
  section?: "start" | "end" | "inside-end";
  /** 어린이보호구역 카메라(보호구역구분=1) */
  school?: boolean;
}

export interface NavNarrow {
  at: number;
  lat: number;
  lng: number;
}

export interface NavGuidance {
  maneuvers: NavManeuver[];
  cams: NavCam[];
  /** 도로 좁아짐(차로수 감소) 지점 — 주행 방향으로 넓은–좁은일 때만 */
  narrows: NavNarrow[];
  /** 경로 인덱스별 도로급 속도 표본(~400m 간격) — ETA 적분용 */
  speeds: PathSpeed[];
  /** 순수 주행시간 – 체감시간 배율 (지체·정체·시간대 보정) */
  calibMul: number;
  /** 제한속도 런렝스 — [{i, kmh, tagged}] (tagged=OSM 태그값, false=도로급 추정) */
  limits: { i: number; kmh: number; tagged: boolean }[];

  roadRuns: { fromM: number; toM: number; roadName?: string; roadNo?: string }[];

  roadMatch: { coverage: number; continuity: number; meanDistanceM: number };
  totalM: number;
}

const kx = (lat: number) => Math.cos((lat * Math.PI) / 180) * 111_320;
function dM(a: LatLng, b: LatLng): number {
  return Math.hypot((b.lng - a.lng) * kx(a.lat), (b.lat - a.lat) * 110_540);
}

function bearing(a: LatLng, b: LatLng): number {
  return (
    (Math.atan2((b.lng - a.lng) * kx(a.lat), (b.lat - a.lat) * 110_540) * 180) /
    Math.PI
  );
}

const norm = (deg: number) => ((((deg + 180) % 360) + 360) % 360) - 180;

function cumDist(path: LatLng[]): number[] {
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + dM(path[i - 1], path[i]));
  }
  return cum;
}

const LOOK_M = 26; // 진입/진출 베어링을 재는 창(완만한 커브형 회전 포착)
const CAND_DEG = 12; // 후보 최소 꺾임 (포크 검출까지 포함하는 낮은 문턱)
const CLUSTER_GAP_M = 60; // 이 안에서 이어지는 꺾임은 한 회전으로(커브 회전 병합)
const NET_MIN_DEG = 22; // 이 이상 순꺾임 = 일반 회전 (미만은 포크 검사)
const FORK_MIN_DEG = 8; // 포크 안내 최소 순꺾임
const JUNC_R = 58; // 실교차로 근접 판정 반경(그래프 스냅 오차 여유 포함)
const FORK_COMP_DEG = 50; // 진출 방위 ±이 안에 경쟁 간선이 있으면 포크
// 교차로가 없는 꺾임을 하드 턴("우회전")으로 부르는 최소 각. 미만은 그냥
// 휘는 길로 보고 "우측 방향"으로 낮춘다(실교차로 회전만 하드 턴). 이상(급커브·
// 헤어핀)은 교차로 없이도 실제로 급히 꺾이므로 원래 안내를 유지한다.
const JUNCTIONLESS_HARD_DEG = 80;

function classify(net: number): ManeuverType {
  const a = Math.abs(net);
  const side = net > 0 ? "right" : "left";
  if (a >= 165) return "uturn";
  if (a >= 125) return `sharp-${side}` as ManeuverType;
  if (a >= 40) return side as ManeuverType;
  return `slight-${side}` as ManeuverType;
}

/**
 * 갈림길(Y분기) 검출 — 각도가 아니라 노드 토폴로지로 잡는다. 교차로 노드가
 * 실제로 갈라지고(전방 간선 ≥2, 우리가 한 쪽을 택함) 안 탄 경쟁 가지가 우리
 * 진출 방위 ±FORK_COMP_DEG 안에 있으면 갈림길. 이렇게 하면 "우측방면"처럼
 * 각도가 작아 그냥 휘는 길로 오인되던 분기를 일관되게 잡는다.
 * side = 탄 가지가 경쟁 가지보다 오른쪽(시계방향)이면 "right".
 * dest = OSM destination 태그(있을 때) — 도로명 방면은 상위에서 m.road로 붙는다.
 */
function detectFork(
  apex: LatLng,
  exitB: number,
  inB: number,
): { side: "left" | "right"; dest?: string } | null {
  const edges = edgeBearingsAt(apex, 40);
  if (!edges || edges.length < 3) return null;
  const inRev = inB + 180;
  // 전방 간선 — 왔던 길(진입 반대) 제외, 진출 방위 ±100° 이내
  const fwd = edges.filter(
    (e) =>
      Math.abs(norm(e.deg - inRev)) > 30 && Math.abs(norm(e.deg - exitB)) < 100,
  );
  if (fwd.length < 2) return null;
  // 우리가 탄 간선 = 진출 방위에 가장 가까운 것
  let our = fwd[0];
  let od = Infinity;
  for (const e of fwd) {
    const d = Math.abs(norm(e.deg - exitB));
    if (d < od) {
      od = d;
      our = e;
    }
  }
  // 우리 경로가 어느 가지와도 잘 안 맞으면(스냅 오차·off-graph) 갈림길 판정 보류.
  if (od > 35) return null;
  // 경쟁 간선 = 안 탄 전방 간선 중 진출 방위에 가장 가깝고 급 충분(농로 배제)
  let comp: (typeof fwd)[number] | null = null;
  let cd = Infinity;
  for (const e of fwd) {
    if (e === our) continue;
    const d = Math.abs(norm(e.deg - exitB));
    if (d < cd && e.kmh >= Math.min(45, our.kmh)) {
      cd = d;
      comp = e;
    }
  }
  // 경쟁 가지가 진출과 너무 벌어지면(>FORK_COMP_DEG) 갈림길이 아니라 측면 교차로
  if (!comp || Math.abs(norm(comp.deg - exitB)) > FORK_COMP_DEG) return null;
  const side: "left" | "right" = norm(our.deg - comp.deg) > 0 ? "right" : "left";
  const dest = our.dest?.d ?? (our.dest?.r ? `${our.dest.r}번` : undefined);
  return { side, dest };
}

/**
 * 갈림길 별도 패스 — 회전 검출(꺾임 ≥CAND_DEG 후보)이 놓치는 "직진성 분기"를
 * 잡는다. 우리 가지가 거의 안 꺾이는 Y분기는 후보가 안 잡혀 detectFork가
 * 호출조차 안 되므로, 노드 토폴로지로 직접 스캔한다. 한 노드당 한 번(80m
 * 디듀프), 고속은 keep-*(램프 검출)가 담당하므로 제외, 큰 꺾임(≥40°)은 회전이라
 * 제외. 상위에서 기존 안내와 70m 안이면 버린다.
 */
function forkManeuvers(path: LatLng[], cum: number[]): NavManeuver[] {
  const n = path.length;
  const total = cum[n - 1];
  const out: NavManeuver[] = [];
  let lastAt = -1e9;
  for (let i = 3; i < n - 3; i++) {
    const at = cum[i];
    if (at <= 60 || total - at <= 45) continue; // 출발 직후/도착 직전 제외
    if (at - lastAt < 80) continue; // 같은 노드 중복 방지
    if (expresswayNear(path[i], 30)) continue; // 고속 분기는 keep-*가 담당
    let b = i;
    while (b > 0 && cum[i] - cum[b] < 15) b--;
    let f = i;
    while (f < n - 1 && cum[f] - cum[i] < 20) f++;
    const inB = bearing(path[b], path[i]);
    const exitB = bearing(path[i], path[f]);
    if (Math.abs(norm(exitB - inB)) >= 40) continue; // 큰 꺾임 = 회전(별도)
    const fk = detectFork(path[i], exitB, inB);
    if (!fk) continue;
    out.push({
      at: Math.round(at),
      type: fk.side === "right" ? "fork-right" : "fork-left",
      dest: fk.dest,
      lat: path[i].lat,
      lng: path[i].lng,
    });
    lastAt = at;
  }
  return out;
}

function findManeuvers(path: LatLng[], cum: number[]): NavManeuver[] {
  const n = path.length;
  if (n < 3) return [];
  const total = cum[n - 1];

  // 각 점의 진입(뒤 LOOK_M)–진출(앞 LOOK_M) 꺾임각
  let back = 0;
  let fwd = 0;
  const deltas = new Float32Array(n);
  const inBs = new Float32Array(n);
  const outBs = new Float32Array(n);
  for (let i = 1; i < n - 1; i++) {
    while (back < i - 1 && cum[i] - cum[back + 1] > LOOK_M) back++;
    if (fwd < i) fwd = i;
    while (fwd < n - 1 && cum[fwd] - cum[i] < LOOK_M) fwd++;
    const inB = bearing(path[back], path[i]);
    const outB = bearing(path[i], path[fwd]);
    inBs[i] = inB;
    outBs[i] = outB;
    deltas[i] = norm(outB - inB);
  }

  // 후보 – 클러스터
  const out: NavManeuver[] = [];
  let i = 1;
  while (i < n - 1) {
    if (Math.abs(deltas[i]) < CAND_DEG) {
      i++;
      continue;
    }
    let last = i;
    let apex = i;
    let j = i + 1;
    while (j < n - 1) {
      if (cum[j] - cum[last] > CLUSTER_GAP_M) break;
      if (Math.abs(deltas[j]) >= CAND_DEG) {
        last = j;
        if (Math.abs(deltas[j]) > Math.abs(deltas[apex])) apex = j;
      }
      j++;
    }
    const net = norm(outBs[last] - inBs[i]);
    const at = cum[apex];
    // 출발 직후/도착 직전 회전은 안내 소음 — 도착 안내가 대신한다. 단 목적지
    // "진입 직전 회전"(마지막 골목 진입)은 카카오도 안내하므로 35m까지는 살린다.
    const inRange = at > 40 && total - at > 35;
    // 자동차전용도로(고속도로 + motorroad trunk=올림픽대로·강변북로) 문맥이면
    // 완만한 꺾임은 실회전이 아니라 진출/분기 "방향" 안내다. 일반 국도(trunk,
    // motorroad 없음)는 at-grade 실회전이 많아 제외 — 안 그러면 국도 우회전이
    // "오른쪽 방향"으로 오인된다.
    const isHwy = expresswayNear(path[apex], 30);
    // 회전교차로 위 회전은 "우회전"이 아니라 회전교차로 안내. 한 회전교차로에서
    // 여러 후보가 잡히면(진입 곡선·링 통과) 80m 안은 한 번만.
    const roundabout = onRoundabout(path[apex]);
    // 실교차로 근접 여부 — 하드 턴 승격/다운그레이드 판정에 재사용.
    const hasJunc = junctionCountNear(path[apex], JUNC_R) >= 1;
    const lastM = out[out.length - 1];
    if (
      roundabout &&
      lastM &&
      lastM.type.startsWith("roundabout") &&
      at - lastM.at < 80
    ) {
      i = last + 1;
      continue;
    }
    // 갈림길(Y분기) — 도심 완만 분기를 각도가 아니라 노드 토폴로지로 잡는다.
    // 큰 각(≥45°)의 명확한 회전은 갈림길로 오인하지 않게 제외한다. 고속도로는
    // 아래 keep-* 경로(램프·JC)가 따로 처리하므로 여기선 일반도로만.
    const fork =
      !roundabout && !isHwy && inRange && Math.abs(net) < 45
        ? detectFork(path[apex], outBs[last], inBs[i])
        : null;
    if (
      roundabout &&
      inRange &&
      Math.abs(net) >= FORK_MIN_DEG
    ) {
      out.push({
        at: Math.round(at),
        type: net > 0 ? "roundabout-right" : "roundabout-left",
        lat: path[apex].lat,
        lng: path[apex].lng,
      });
    } else if (fork) {
      // 갈림길에서 좌/우 — 방면(dest)은 아래에서 m.road/dest로 채워진다.
      out.push({
        at: Math.round(at),
        type: fork.side === "right" ? "fork-right" : "fork-left",
        dest: fork.dest,
        lat: path[apex].lat,
        lng: path[apex].lng,
      });
    } else if (
      Math.abs(net) >= NET_MIN_DEG &&
      inRange &&
      // 교차로 근접이면 회전. 교차로 노드가 반경 밖(스냅 오차)이어도 각도가
      // 아주 큰(≥45°) 명확한 꺾임은 실회전으로 인정한다. 산간도로의 완만한
      // 커브(≤45°)를 회전으로 오인하지 않도록 문턱을 높게 둔다.
      (hasJunc || Math.abs(net) >= 45)
    ) {
      // 고속도로(motorway·motorway_link) 위에선 실제 교차로 우회전이 없고
      // 전부 진출 램프·분기·합류다 — 각도와 무관하게 "방향" 안내로 (램프가
      // 급히 휘어도 "우회전"이 아니라 "오른쪽 방향"). 국도(trunk)는 위에서
      // isHwy로 제외했으니 여기 안 걸린다.
      // 교차로 없이 각도만으로(45~80°) 걸린 건 '그냥 휘는 길'일 확률이 높다 —
      // 하드 턴("우회전") 대신 "우측 방향"으로 낮춰 오안내를 막는다. 실교차로
      // 회전(hasJunc)이나 급커브·헤어핀(≥80°)은 원래대로 하드 턴으로 안내.
      const type: ManeuverType = isHwy
        ? net > 0
          ? "keep-right"
          : "keep-left"
        : !hasJunc && Math.abs(net) < JUNCTIONLESS_HARD_DEG
          ? net > 0
            ? "slight-right"
            : "slight-left"
          : classify(net);
      out.push({
        at: Math.round(at),
        type,
        lat: path[apex].lat,
        lng: path[apex].lng,
      });
    } else if (isHwy && Math.abs(net) >= 5 && inRange) {
      // 고속·자동차전용도로의 약한 꺾임 — 진출 램프·JC 분기. 진출 방위 근처
      // (±FORK_COMP_DEG)에 "안 탄" 경쟁 간선이 있으면 keep-* 방향 안내.
      // (일반도로 갈림길은 위 detectFork가 fork-*로 처리한다.)
      const edges = edgeBearingsAt(path[apex], 40);
      if (edges && edges.length >= 3) {
        const exitB = outBs[last];
        const inRev = inBs[i] + 180; // 왔던 길 되돌아가는 방위는 제외
        let ourDiff = Infinity;
        let ourKmh = 40;
        for (const e of edges) {
          const d = Math.abs(norm(e.deg - exitB));
          if (d < ourDiff) {
            ourDiff = d;
            ourKmh = e.kmh;
          }
        }
        const isFork = edges.some((e) => {
          const dExit = Math.abs(norm(e.deg - exitB));
          return (
            dExit > Math.max(ourDiff + 10, 8) && // 탄 간선 제외
            dExit < FORK_COMP_DEG &&
            Math.abs(norm(e.deg - inRev)) > 25 &&
            e.kmh >= Math.min(45, ourKmh) // 농로급 갈림길은 무시
          );
        });
        if (isFork) {
          out.push({
            at: Math.round(at),
            type: net > 0 ? "keep-right" : "keep-left",
            lat: path[apex].lat,
            lng: path[apex].lng,
          });
        }
      }
    }
    i = last + 1;
  }

  // 분기·진출 안내 — 두 검출을 병합한다:
  //  ① rampManeuvers: 연결로(_link) 진입 = 고속끼리 분기점(신갈JC 등)+나들목 진출.
  //  ② motorwayExits: 도로급 하락(연결로 태그 없이 바로 로컬로 빠지는 곳) 폴백.
  // 램프 검출을 우선하고, 진출검출은 램프와 300m 넘게 떨어진 것만 보탠다.
  const cls = roadClassAlong(path);
  const ramps = rampManeuvers(path, cum, cls);
  const branches = [...ramps];
  for (const ex of motorwayExits(path, cum)) {
    if (!ramps.some((r) => Math.abs(r.at - ex.at) < 300)) branches.push(ex);
  }
  for (const ex of branches) {
    // 같은 사건을 회전으로 이미(오)안내했으면 그걸 분기·진출 안내로 교체
    for (let k = out.length - 1; k >= 0; k--) {
      if (Math.abs(out[k].at - ex.at) < 200) out.splice(k, 1);
    }
    out.push(ex);
  }

  // 구조물 진입(고가도로·지하차도·터널) — 회전/분기와 150m 넘게 떨어진 것만
  // 보탠다(교차로 회전이 있으면 그게 우선, 구조물은 부수적). 스팸 방지를 위해
  // 주요도로·충분한 길이만.
  for (const st of structureManeuvers(path, cum, structAlong(path), cls)) {
    if (!out.some((m) => Math.abs(m.at - st.at) < 90)) out.push(st);
  }

  // 갈림길(Y분기) — 직진성 분기까지 잡는 별도 패스. 기존 안내(회전·램프·이미
  // 잡힌 분기)와 70m 안이면 버려 이중 안내를 막는다.
  for (const fk of forkManeuvers(path, cum)) {
    if (!out.some((m) => Math.abs(m.at - fk.at) < 70)) out.push(fk);
  }
  out.sort((a, b) => a.at - b.at);

  let p = 0;
  for (const m of out) {
    while (p < n - 1 && cum[p] < m.at + 70) p++;
    const road = roadAtPoint(path[p], 60);
    if (road?.name) m.road = road.name;
  }

  // 분기·출구 방면 — 고속 진출/분기(keep-*)는 진입 램프에 destination 태그가
  // 달려 있다. apex 주변 몇 지점을 램프 위 점으로 보고 스냅해 방면을 붙인다.
  for (const m of out) {
    if (m.type !== "keep-left" && m.type !== "keep-right") continue;
    const dest = destNear(path, cum, m.at);
    if (dest) m.dest = dest;
  }

  out.push({
    at: Math.round(total),
    type: "arrive",
    lat: path[n - 1].lat,
    lng: path[n - 1].lng,
  });
  return out;
}

/**
 * 자동차전용도로 진출 지점 — 경로가 고속도로·자동차전용도로(motorway 0~1 또는
 * motorroad trunk=올림픽대로·강변북로) 본선에서 지속적으로 벗어나는 곳. 튐
 * 방지를 위해 진출 앞 120m는 대부분 본선, 뒤 120m는 대부분 벗어남일 때만 인정.
 * 방향은 우측 기본(한국 진출램프 관례).
 */
function motorwayExits(path: LatLng[], cum: number[]): NavManeuver[] {
  const n = path.length;
  if (n < 5) return [];
  const total = cum[n - 1];
  const isMw = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    isMw[i] = expresswayNear(path[i], 20) ? 1 : 0;
  }
  // 앞뒤 120m 다수결 비율
  const frac = (i: number, dir: 1 | -1) => {
    let cnt = 0;
    let mw = 0;
    let j = i;
    while (j >= 0 && j < n && Math.abs(cum[j] - cum[i]) < 120) {
      cnt++;
      mw += isMw[j];
      j += dir;
    }
    return cnt > 0 ? mw / cnt : 0;
  };
  const out: NavManeuver[] = [];
  let last = -1e9;
  for (let i = 2; i < n - 2; i++) {
    // 고속–비고속 경계
    if (isMw[i - 1] && !isMw[i]) {
      if (cum[i] < 60 || total - cum[i] < 80) continue;
      if (cum[i] - last < 800) continue; // 한 진출에 하나
      if (frac(i - 1, -1) > 0.6 && frac(i, 1) > 0.6) {
        // 카카오는 진출을 "분기점(경로가 본선에서 갈라지기 시작하는 곳)"에서
        // 안내한다 — 클래스가 하락하는 경계보다 앞이다. 경계 앞 350~600m
        // 본선 진행방위를 기준으로, 우리 경로가 15° 넘게 벌어지기 시작하는
        // 첫 지점(게이트)을 찾아 거기에 찍는다.
        let m0 = i;
        while (m0 > 0 && cum[i] - cum[m0] < 600) m0--;
        let m1 = i;
        while (m1 > 0 && cum[i] - cum[m1] < 350) m1--;
        const mainHead = bearing(path[m0], path[m1]);
        let gi = i;
        for (let j = m1; j <= i; j++) {
          const jb = Math.min(j + 1, n - 1);
          if (Math.abs(norm(bearing(path[j], path[jb]) - mainHead)) > 15) {
            gi = j;
            break;
          }
        }
        last = cum[i];
        out.push({
          at: Math.round(cum[gi]),
          type: "keep-right",
          lat: path[gi].lat,
          lng: path[gi].lng,
        });
      }
    }
  }
  return out;
}

/**
 * 구조물 진입 안내 — 고가도로(bridge)·지하차도(short tunnel)·터널(long tunnel).
 * 스팸 방지의 핵심: 고속도로 본선의 "연속 교량"은 교차로가 없으므로 억제하고,
 * **교차로(램프·분기·옆길)가 있는 결정지점**의 고가/지하차도만 안내한다 —
 * 카카오가 "고가도로 진입/지하차도 진입"을 내는 지점과 일치한다. 긴 터널은
 * 교차로와 무관하게 전조등·GPS 끊김 대비로 안내(인접 구조물은 한 존으로 병합).
 */
const TUNNEL_MIN_M = 600; // 이 이상 총연장이면 무조건 "터널" 안내(안전)
const TUNNEL_GAP_M = 150; // 이 미만 간격의 연속 구조물은 한 존으로 병합
const STRUCT_MIN_M = 25; // 초단구간 오탐만 배제(지하차도는 대개 40~120m)
function structureManeuvers(
  path: LatLng[],
  cum: number[],
  struct: number[],
  cls: number[],
): NavManeuver[] {
  const n = path.length;
  if (n < 5) return [];
  const total = cum[n - 1];
  const out: NavManeuver[] = [];
  let last = -1e9;
  let i = 1;
  while (i < n) {
    const s = struct[i];
    if (s <= 0 || struct[i - 1] === s) {
      i++;
      continue;
    }
    // 이 구조물 존 — 같은 종류가 짧은 간격으로 이어지면 하나로 병합
    let end = i;
    let k = i;
    while (k < n) {
      if (struct[k] === s) end = k;
      else if (cum[k] - cum[end] > TUNNEL_GAP_M) break;
      k++;
    }
    const entryAt = cum[i];
    const zoneLen = cum[Math.min(end, n - 1)] - entryAt;
    const okPos = entryAt > 80 && total - entryAt > 150 && entryAt - last > 300;
    if (okPos && zoneLen >= STRUCT_MIN_M) {
      // 긴 터널(≥600m)은 안전상 무조건(전조등·GPS 끊김).
      const longTunnel = s === 2 && zoneLen >= TUNNEL_MIN_M;
      // 짧은 고가·지하차도(≤300m)는 **일반 간선(cls 4~8=primary~tertiary)의
      // 입체교차**만 안내한다 — 카카오가 "고가/지하차도 진입"을 내는 지점.
      // 고속 본선(mw·mwL, cls 0~1)·국도(trunk, 2~3)의 장대·연속 교량과
      // 자동차전용도로(올림픽대로·강변북로 등)는 제외해 스팸을 막는다.
      const shortGradeSep = zoneLen <= 300 && cls[i] >= 4 && cls[i] <= 8;
      if (longTunnel || shortGradeSep) {
        const type: ManeuverType =
          s === 1 ? "overpass" : zoneLen >= TUNNEL_MIN_M ? "tunnel" : "underpass";
        out.push({ at: Math.round(entryAt), type, lat: path[i].lat, lng: path[i].lng });
        last = entryAt;
      }
    }
    i = end + 1;
  }
  return out;
}

/**
 * 연결로(_link) 진입 기반 분기·진출 안내 — 경로가 본선(motorway 0 / trunk 2)에서
 * 연결로(motorway_link 1 / trunk_link 3)로 들어가는 지점. 고속끼리 분기점(경부–
 * 영동 신갈JC 등)은 도로급이 motorway로 유지돼 motorwayExits(급하락)가 못 잡고,
 * 분기각도 완만해 각도 기반도 놓친다 — 연결로 진입은 그 모두를 잡는 신호다.
 * 방향은 연결로 진입 후 ~120m 순 베어링 변화(우측 관례가 아니라 실제 곡률).
 */
function rampManeuvers(path: LatLng[], cum: number[], cls: number[]): NavManeuver[] {
  const n = path.length;
  if (n < 5) return [];
  const total = cum[n - 1];
  const isLink = (c: number) => c === 1 || c === 3; // 연결로
  const isMain = (c: number) => c === 0 || c === 2; // 고속·자동차전용 본선
  const out: NavManeuver[] = [];
  let last = -1e9;
  for (let i = 2; i < n - 2; i++) {
    if (!isLink(cls[i]) || isLink(cls[i - 1])) continue; // 연결로 "진입" 순간만
    const at = cum[i];
    if (at < 60 || total - at < 80) continue;
    if (at - last < 250) continue; // 인터체인지 세부 결정점을 각각 살린다
    // 램프 문맥 확인 — 연결로 앞(진출·분기) 또는 뒤(진입) ~300m에 본선
    // (고속·자동차전용)이 있어야 한다. 진출/분기는 앞이 본선, 고속도로 진입은
    // 뒤가 본선이므로 양쪽을 본다. 앞뒤 모두 로컬이면 고속 램프가 아니다.
    let mainBefore = false;
    for (let j = i - 1; j >= 0 && cum[i] - cum[j] < 150; j--) {
      if (isMain(cls[j])) { mainBefore = true; break; }
      if (!isLink(cls[j]) && cls[j] >= 4) break;
    }
    let mainAfter = false;
    for (let j = i; j < n && cum[j] - cum[i] < 300; j++) {
      if (isMain(cls[j])) { mainAfter = true; break; }
    }
    if (!mainBefore && !mainAfter) continue;
    // 잡음(1~2점 오스냅) 배제 — 연결로가 이후 ~80m 이상 지속해야 진짜 램프.
    // 점 개수가 아니라 "거리"로 잰다: 램프는 긴 직선이라 점이 성겨(한 간선에
    // geometry 점 몇 개뿐) 100m 안에 2점만 잡히는 곳이 흔하다.
    let linkSpan = 0;
    for (let j = i; j < n && cum[j] - cum[i] < 300; j++) {
      if (isLink(cls[j])) linkSpan = cum[j] - cum[i];
    }
    if (linkSpan < 80) continue;
    // 방향: 진입 전 진행방위 – 진입 후 ~120m 진행방위의 순 변화
    let k = i;
    while (k < n - 1 && cum[k] - cum[i] < 120) k++;
    const inB = bearing(path[Math.max(0, i - 3)], path[i]);
    const outB = bearing(path[i], path[k]);
    const net = norm(outB - inB);
    last = at;
    out.push({
      at: Math.round(at),
      type: net >= 0 ? "keep-right" : "keep-left",
      lat: path[i].lat,
      lng: path[i].lng,
    });
  }
  return out;
}

/** destination 레코드 – 표시용 "서울·대구·유성분기점" (최대 3개, 순수 괄호 토큰 제외) */
function fmtDest(rec: { d?: string; r?: string }): string | undefined {
  if (!rec.d) return undefined;
  const parts = rec.d
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s && !/^\(.*\)$/.test(s)) // "(경부고속도로)" 같은 노선명-only 토큰 제외
    .slice(0, 3);
  return parts.length ? parts.join("·") : undefined;
}

/**
 * apex(진출/분기 지점) 주변 램프 위 점을 스냅해 방면(destination)을 찾는다.
 * 진출 경계 앞뒤 몇 지점을 램프로 보고 진행 방위와 함께 조회, 첫 히트를 쓴다.
 */
function destNear(path: LatLng[], cum: number[], at: number): string | undefined {
  const n = path.length;
  for (const off of [0, 40, -30, 80, -60, 120]) {
    const target = at + off;
    if (target < 0 || target > cum[n - 1]) continue;
    let k = 1;
    while (k < n - 1 && cum[k] < target) k++;
    const heading = bearing(path[Math.max(0, k - 1)], path[Math.min(n - 1, k + 1)]);
    const rec = destinationAt(path[k], 30, heading);
    if (rec) {
      const s = fmtDest(rec);
      if (s) return s;
    }
  }
  return undefined;
}

// 경로─카메라 허용 거리. 45m는 중앙분리대 있는 분리도로(OSM 편도 지오메트리·
// 반대 차로에 달린 캠)나 코스 폴리라인 오차에서 온-로드 카메라의 ~15%를 놓쳤다.
// 70m로 넓히면 실측 매칭률 85%–~92% (45~70m 구간은 대부분 평행도로가 아닌
// 분리도로 오프셋이라 오탐 증가는 미미). 안전상 놓침<오탐.
const CAM_R = 70;
const CAM_REHIT_M = 500; // 같은 캠이 다시 잡히려면(왕복·재통과) 이만큼 지나야

interface PhysicalCamData {
  id: string;
  sourceId?: string;
  lat: number;
  lng: number;
  speed?: boolean;
  signal?: boolean;
  section?: boolean;
  limitKmh?: number;
  sectionPos?: number;
  school?: boolean;
  rear?: boolean;
  roadNames?: string[];
  roadStrong?: boolean;
  dirBrg?: number;
  dirStrong?: boolean;

  roadRouteDirection?: number;
  roadRouteNo?: string;
}

interface CamData {
  // 구버전 배열을 대체 경로로 유지하고 새 데이터는 물리 장비 단위로 읽는다.
  fixed: number[][];
  section: number[][];
  signal: number[][];
  devices?: PhysicalCamData[];
  /** 경찰청 원본 도로명. 같은 좌표에 서로 다른 이름이면 모두 보존한다. */
  roadNames?: Record<string, string[]>;

  strongRoads?: Record<string, number>;
  /** 공공 설치방향 문구 + OSM 지명/도로축으로 독립 복원한 진행방위. */
  directions?: Record<string, number>;

  strongDirections?: Record<string, number>;
}
// 단속카메라 — 런타임 캐시(scripts/fetch-speedcams.mjs가 data/에 주기 갱신)를
// 우선 읽고, 없으면 커밋된 baseline으로 폴백. 장기 실행 서버라 mtime 리로드로
// 재시작 없이 갱신을 반영한다.
const CAMS_CACHE = join(process.cwd(), "data/speedcams.json");
const CAMS_LAST_GOOD = join(process.cwd(), "data/speedcams.last-good.json");
const CAMS_BASE = join(process.cwd(), "src/lib/data/speedcams.json");
let camData: CamData | null = null;
let camDataKey = "";
function loadCams(): CamData {
  const files = [CAMS_CACHE, CAMS_LAST_GOOD, CAMS_BASE].filter((f) => existsSync(f));
  const key = files.map((f) => {
    try { return `${f}:${statSync(f).mtimeMs}`; } catch { return `${f}:missing`; }
  }).join("|");
  if (camData && key === camDataKey) return camData;
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      if (!Array.isArray(raw.fixed) || !Array.isArray(raw.section) || !Array.isArray(raw.signal)) continue;
      camData = {
        fixed: raw.fixed,
        section: raw.section,
        signal: raw.signal,
        devices: Array.isArray(raw.devices) && raw.devices.length ? raw.devices : undefined,
        roadNames: raw.roadNames ?? {},
        strongRoads: raw.strongRoads ?? {},
        directions: raw.directions ?? {},
        strongDirections: raw.strongDirections ?? {},
      };
      camDataKey = key;
      return camData;
    } catch {
      // 현재 캐시가 손상돼도 다음 정상 자료를 읽어 초기 구동을 유지한다.
    }
  }
  if (!camData) camData = { fixed: [], section: [], signal: [] };
  camDataKey = key;
  return camData;
}

const CELL = 0.005;
const ckey = (lat: number, lng: number) =>
  Math.floor(lat / CELL) * 100_000 + Math.floor(lng / CELL) + 2_000_000_000;

// junction=roundabout 링 정점 근접 판정 — 회전교차로 안 회전은 "우회전"이
// 아니라 회전교차로 안내로 (build-roundabouts-from-osm.mjs).
const RDBT_R = 28;
let rdbtGrid: Map<number, [number, number][]> | null = null;
function loadRoundabouts(): Map<number, [number, number][]> {
  if (rdbtGrid) return rdbtGrid;
  rdbtGrid = new Map();
  try {
    const raw: [number, number][] = JSON.parse(
      readFileSync(join(process.cwd(), "src/lib/data/roundabouts.json"), "utf8"),
    );
    for (const [lat, lng] of raw) {
      const k = ckey(lat, lng);
      const a = rdbtGrid.get(k);
      if (a) a.push([lat, lng]);
      else rdbtGrid.set(k, [[lat, lng]]);
    }
  } catch {
    // 데이터 없으면 회전교차로 안내만 생략
  }
  return rdbtGrid;
}
function onRoundabout(p: LatLng): boolean {
  const grid = loadRoundabouts();
  const ci = Math.floor(p.lat / CELL);
  const cj = Math.floor(p.lng / CELL);
  for (let x = ci - 1; x <= ci + 1; x++) {
    for (let y = cj - 1; y <= cj + 1; y++) {
      const arr = grid.get(x * 100_000 + y + 2_000_000_000);
      if (!arr) continue;
      for (const [lat, lng] of arr) {
        if (dM({ lat, lng }, p) < RDBT_R) return true;
      }
    }
  }
  return false;
}

export type CamPt = {
  lat: number;
  lng: number;
  kind: "fixed" | "section" | "signal";
  deviceId?: string;
  speed: boolean;
  signal: boolean;
  rear?: boolean;
  limitKmh: number;
  spos: number; // 구간: 1=시점 2=종점 0=미상, 고정식은 0
  school: boolean; // 어린이보호구역(고정식 4번째 원소=1)
  roadNames?: string[];
  roadStrong?: boolean;
  dirBrg?: number;
  dirStrong?: boolean;
  roadRouteDirection?: number;
  roadRouteNo?: string;
};
let camGrid: Map<number, number[]> | null = null;
let camPts: CamPt[] | null = null;
let camGridKey = "";

// 2026-10-06 사용자 지시로 "정답지를 실제 경고에 써 본다". 원칙(공공 자료만
// 제품에)과 다른 실험 모드라 기본은 꺼짐이고, 끄면 즉시 원래대로.
//   CAMS_REF      = kakao | tmap | both   (없으면 꺼짐)
//   CAMS_REF_MODE = add(기본) | strict
// 파일: data/kakao-cams.json(scripts/build-kakao-cams.mjs), data/tmap-cams.json
// (scripts/build-tmap-cams.mjs). 둘 다 git 제외.
//  - 공공 장비 50m 안에 정답지 카메라가 있으면: 제한속도·후면·과속 여부를
//    정답지 값으로. 정답지에 찍는 방향(티맵)이 있으면 그 방향을 확정값으로 쓰고,
//    방향이 다른 기록이 둘 이상이면 방향별로 나눠 둔다.
//  - strict: 정답지가 전부다. 정답지 50m 안에 없는 공공 장비는 빼고(어린이보호
//    구역 포함), 구간단속도 공공 대신 정답지(카카오) 게이트를 쓴다.
//  - 정답지에만 있는 카메라는 새 장비로 넣는다.
type RefCam = { id: string; lat: number; lng: number; limit: number; dir?: number; signal?: number; rear?: number; sec?: number };
const REF_FILES = {
  kakao: join(process.cwd(), "data/kakao-cams.json"),
  tmap: join(process.cwd(), "data/tmap-cams.json"),
};
const REF_MATCH_M = 50;
function refSources(): ("kakao" | "tmap")[] {
  const v = process.env.CAMS_REF;
  return v === "both" ? ["tmap", "kakao"] : v === "kakao" || v === "tmap" ? [v] : [];
}
const refStrict = () => process.env.CAMS_REF_MODE === "strict";
function kakaoKey(): string {
  const src = refSources();
  if (!src.length) return "off";
  try {
    return `${src.join("+")}:${refStrict() ? "strict" : "add"}:` +
      src.map((s) => statSync(REF_FILES[s]).mtimeMs).join(",");
  } catch {
    return "missing";
  }
}
function loadRefCams(): RefCam[] {
  const G = 0.002;
  const gk = (lat: number, lng: number) => `${Math.floor(lat / G)},${Math.floor(lng / G)}`;
  const out: RefCam[] = [];
  const grid = new Map<string, RefCam[]>();
  for (const src of refSources()) {
    let rows: RefCam[];
    try {
      rows = JSON.parse(readFileSync(REF_FILES[src], "utf8")).cams;
      if (!Array.isArray(rows)) continue;
    } catch {
      continue;
    }
    const first = out.length === 0;
    for (const r of rows) {
      const row = { ...r, id: `${src}:${r.id}` };
      // 두 번째 출처(카카오)는 첫 출처(티맵) 50m 안이면 같은 장비로 보고 버린다
      if (!first) {
        const ci = Math.floor(r.lat / G), cj = Math.floor(r.lng / G);
        let dup = false;
        for (let a = ci - 1; a <= ci + 1 && !dup; a++)
          for (let b = cj - 1; b <= cj + 1 && !dup; b++)
            for (const q of grid.get(`${a},${b}`) ?? []) if (dM(q, r) <= REF_MATCH_M) { dup = true; break; }
        if (dup) continue;
      }
      out.push(row);
      if (first) {
        const k = gk(r.lat, r.lng);
        const arr = grid.get(k);
        if (arr) arr.push(row);
        else grid.set(k, [row]);
      }
    }
  }
  return out;
}
function applyKakaoOverlay(pts: CamPt[]): CamPt[] {
  if (kakaoKey() === "off" || kakaoKey() === "missing") return pts;
  const all = loadRefCams();
  // 구간단속 게이트 — strict에서는 공공 대신 전용, add에서는 공공 유지 + 누락 게이트 보강
  const secRows = all.filter((r) => r.sec === 1 || r.sec === 2);
  const rows = all.filter((r) => r.sec == null);
  if (rows.length === 0 && secRows.length === 0) return pts;
  const G = 0.002;
  const gk = (lat: number, lng: number) => `${Math.floor(lat / G)},${Math.floor(lng / G)}`;
  const grid = new Map<string, number[]>();
  rows.forEach((r, i) => {
    const k = gk(r.lat, r.lng);
    const a = grid.get(k);
    if (a) a.push(i);
    else grid.set(k, [i]);
  });
  const within = (p: LatLng): number[] => {
    const ci = Math.floor(p.lat / G), cj = Math.floor(p.lng / G);
    const hits: number[] = [];
    for (let a = ci - 1; a <= ci + 1; a++)
      for (let b = cj - 1; b <= cj + 1; b++)
        for (const i of grid.get(`${a},${b}`) ?? []) if (dM(p, rows[i]) <= REF_MATCH_M) hits.push(i);
    return hits.sort((x, y) => dM(p, rows[x]) - dM(p, rows[y]));
  };
  const angle = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  const toPt = (base: CamPt, r: RefCam, suffix: string): CamPt => {
    const signal = base.signal || r.signal === 1;
    return {
      ...base,
      ...(suffix ? { deviceId: `${base.deviceId ?? `${base.lat},${base.lng}`}${suffix}` } : {}),
      kind: signal ? "signal" : "fixed",
      speed: true,
      signal,
      ...(r.rear === 1 || base.rear ? { rear: true } : {}),
      limitKmh: r.limit > 0 ? r.limit : base.limitKmh,
      ...(r.dir != null ? { dirBrg: r.dir, dirStrong: true } : {}),
    };
  };
  const out: CamPt[] = [];
  const matched = new Set<number>();
  for (const p of pts) {
    if (p.kind === "section") {
      if (!refStrict()) {
        const hit = secRows.find((r) => dM(p, r) <= REF_MATCH_M && r.sec === p.spos);
        if (hit) {
          out.push({
            ...p,
            limitKmh: hit.limit > 0 ? hit.limit : p.limitKmh,
            ...(hit.dir != null ? { dirBrg: hit.dir, dirStrong: true } : {}),
          });
        } else {
          out.push(p);
        }
      }
      continue;
    }
    const hits = within(p);
    if (hits.length === 0) {
      if (!refStrict()) out.push(p);
      continue;
    }
    hits.forEach((i) => matched.add(i));
    // 방향별로 하나씩(30° 안은 같은 방향). 방향 없는 기록은 가장 가까운 것 하나만.
    const dirs: RefCam[] = [];
    for (const i of hits) {
      const r = rows[i];
      if (r.dir == null) continue;
      if (!dirs.some((d) => angle(d.dir!, r.dir!) <= 30)) dirs.push(r);
    }
    if (dirs.length === 0) out.push(toPt(p, rows[hits[0]], ""));
    else dirs.forEach((r, k) => out.push(toPt(p, r, dirs.length > 1 ? `#d${k}` : "")));
  }
  const keptGrid = new Map<string, CamPt[]>();
  for (const p of out) {
    const k = gk(p.lat, p.lng);
    const a = keptGrid.get(k);
    if (a) a.push(p);
    else keptGrid.set(k, [p]);
  }
  const nearKept = (r: RefCam) => {
    const ci = Math.floor(r.lat / G), cj = Math.floor(r.lng / G);
    for (let a = ci - 1; a <= ci + 1; a++)
      for (let b = cj - 1; b <= cj + 1; b++)
        for (const p of keptGrid.get(`${a},${b}`) ?? []) {
          if (dM(p, r) > REF_MATCH_M) continue;
          // 방향이 있으면 같은 방향(30° 안)으로 이미 남긴 장비가 있을 때만 중복
          if (r.dir == null || p.dirBrg == null || angle(p.dirBrg, r.dir) <= 30) return true;
        }
    return false;
  };
  rows.forEach((r, i) => {
    if (matched.has(i) || nearKept(r)) return;
    out.push({
      lat: r.lat,
      lng: r.lng,
      kind: r.signal === 1 ? "signal" : "fixed",
      deviceId: r.id,
      speed: true,
      signal: r.signal === 1,
      ...(r.rear === 1 ? { rear: true } : {}),
      limitKmh: r.limit,
      spos: 0,
      school: false,
      ...(r.dir != null ? { dirBrg: r.dir, dirStrong: true } : {}),
    });
  });
  for (const r of secRows) {
    if (!refStrict() && nearKept(r)) continue;
    out.push({
      lat: r.lat,
      lng: r.lng,
      kind: "section",
      deviceId: r.id,
      speed: false,
      signal: false,
      limitKmh: r.limit,
      spos: r.sec!,
      school: false,
      ...(r.dir != null ? { dirBrg: r.dir, dirStrong: true } : {}),
    });
  }
  return out;
}

function loadCamGrid() {
  const d = loadCams();
  const gridKey = `${camDataKey}|${kakaoKey()}`;
  if (camGrid && camPts && camGridKey === gridKey) return { camGrid, camPts };
  if (d.devices?.length) {
    // 속도·신호 복합 장비도 물리 장비 단위로 한 번만 처리한다.
    camPts = d.devices
      .filter((x) => !(x.section && (x.limitKmh ?? 0) <= 0 && (x.sectionPos ?? 0) === 0))
      .map((x) => ({
        lat: x.lat,
        lng: x.lng,
        kind: x.section ? "section" as const : x.signal ? "signal" as const : "fixed" as const,
        deviceId: x.id,
        speed: !!x.speed,
        signal: !!x.signal,
        ...(x.rear ? { rear: true } : {}),
        limitKmh: x.limitKmh ?? 0,
        spos: x.section ? (x.sectionPos ?? 0) : 0,
        school: !!x.school,
        roadNames: x.roadNames,
        roadStrong: x.roadStrong,
        dirBrg: x.dirBrg,
        dirStrong: x.dirStrong,
        roadRouteDirection: x.roadRouteDirection,
        roadRouteNo: x.roadRouteNo,
      }));
  } else {
    // 구버전 파일에서는 복합 장비가 중복될 수 있어 기존 대체 경로를 유지한다.
    camPts = [
      ...d.fixed.map(([lat, lng, lim, school]) => ({
        lat, lng, kind: "fixed" as const, speed: true, signal: false,
        limitKmh: lim ?? 0, spos: 0, school: school === 1,
      })),
      ...d.section
        .filter(([, , lim, pos]) => (lim ?? 0) > 0 || (pos ?? 0) !== 0)
        .map(([lat, lng, lim, pos]) => ({
          lat, lng, kind: "section" as const, speed: false, signal: false,
          limitKmh: lim ?? 0, spos: pos ?? 0, school: false,
        })),
      ...d.signal.map(([lat, lng, lim, school]) => ({
        lat, lng, kind: "signal" as const, speed: false, signal: true,
        limitKmh: lim ?? 0, spos: 0, school: school === 1,
      })),
    ].map((c) => ({
      ...c,
      roadNames: d.roadNames?.[`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`],
      roadStrong: d.strongRoads?.[`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`] === 1,
      dirBrg: d.directions?.[`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`],
      dirStrong: d.strongDirections?.[`${c.lat.toFixed(5)},${c.lng.toFixed(5)}`] === 1,
    }));
  }
  camPts = applyKakaoOverlay(camPts);
  camGridKey = gridKey;
  camGrid = new Map();
  for (let i = 0; i < camPts.length; i++) {
    const k = ckey(camPts[i].lat, camPts[i].lng);
    const arr = camGrid.get(k);
    if (arr) arr.push(i);
    else camGrid.set(k, [i]);
  }
  return { camGrid, camPts };
}

/** 현위치 반경 내 단속카메라 — 목적지 없는 "일반 주행" 경고용 */
export function camsNear(lat: number, lng: number, radiusM = 2000): CamPt[] {
  const { camGrid: grid, camPts: pts } = loadCamGrid();
  if (pts.length === 0) return [];
  const span = Math.ceil(radiusM / (CELL * 111_000)) + 1;
  const ci = Math.floor(lat / CELL);
  const cj = Math.floor(lng / CELL);
  const kxm = Math.cos((lat * Math.PI) / 180) * 111_320;
  const r2 = radiusM * radiusM;
  const out: CamPt[] = [];
  const seen = new Set<number>();
  for (let a = ci - span; a <= ci + span; a++) {
    for (let b = cj - span; b <= cj + span; b++) {
      for (const idx of grid.get(a * 100_000 + b + 2_000_000_000) ?? []) {
        if (seen.has(idx)) continue;
        seen.add(idx);
        const c = pts[idx];
        const dx = (c.lng - lng) * kxm;
        const dy = (c.lat - lat) * 110_540;
        if (dx * dx + dy * dy <= r2) out.push(c);
      }
    }
  }
  return out;
}

// 반대편 차로 병합 — 물리적으로 붙어있고(≤80m) 경로상 위치도 가까운(≤90m)
// 카메라 쌍은 분리도로 양방향 게이트라, 경로에 더 가까운(내 차로) 것만 남긴다.
const TWIN_PHYS_M = 80;
const TWIN_AT_M = 90;
type RawCam = NavCam & { d: number; routeBearing: number; roadNames?: string[]; roadStrong?: boolean; dirBrg?: number; dirStrong?: boolean; roadRouteDirection?: number; roadRouteNo?: string; outsideRoute?: boolean };

export function findRouteCams(
  path: LatLng[],
  cum: number[] = cumDist(path),
  routeMatch: NodelinkPathMatch = matchPathNodelinks(path),
): NavCam[] {
  const { camGrid: grid, camPts: pts } = loadCamGrid();
  if (pts.length === 0 || path.length < 2) return [];
  const encounters = new Map<number, { lastAt: number; index: number }>();
  const raw: RawCam[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const ci = Math.floor((a.lat + b.lat) / 2 / CELL);
    const cj = Math.floor((a.lng + b.lng) / 2 / CELL);
    for (let x = ci - 1; x <= ci + 1; x++) {
      for (let y = cj - 1; y <= cj + 1; y++) {
        for (const idx of grid.get(x * 100_000 + y + 2_000_000_000) ?? []) {
          const c = pts[idx];
          // 점–세그먼트 거리
          const k = kx(c.lat);
          const ax = (a.lng - c.lng) * k;
          const ay = (a.lat - c.lat) * 110_540;
          const bx2 = (b.lng - c.lng) * k;
          const by2 = (b.lat - c.lat) * 110_540;
          const dx = bx2 - ax;
          const dy = by2 - ay;
          const len2 = dx * dx + dy * dy;
          const rawT = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
          const outsideRoute = (i === 1 && rawT < 0)
            || (i === path.length - 1 && rawT > 1);
          const t = Math.max(0, Math.min(1, rawT));
          const d = Math.hypot(ax + t * dx, ay + t * dy);
          if (d > CAM_R) continue;
          if (len2 === 0) continue; // 정차·중복 좌표에는 진행방향이 없다
          const at = cum[i - 1] + (cum[i] - cum[i - 1]) * t;
          const candidate: RawCam = {
            at: Math.round(at),
            lat: c.lat,
            lng: c.lng,
            kind: c.kind,
            deviceId: c.deviceId,
            speed: c.speed,
            signal: c.signal,
            rear: c.rear,
            d,
            routeBearing: bearing(a, b),
            roadNames: c.roadNames,
            roadStrong: c.roadStrong,
            dirBrg: c.dirBrg,
            dirStrong: c.dirStrong,
            roadRouteDirection: c.roadRouteDirection,
            roadRouteNo: c.roadRouteNo,
            ...(outsideRoute ? { outsideRoute: true } : {}),
            ...(c.limitKmh ? { limitKmh: c.limitKmh } : {}),
            ...(c.spos === 1
              ? { section: "start" as const }
              : c.spos === 2
                ? { section: "end" as const }
                : {}),
            ...(c.school ? { school: true } : {}),
          };
          const prev = encounters.get(idx);
          if (prev && at - prev.lastAt < CAM_REHIT_M) {
            // 첫 70m 진입점이 아니라 실제로 가장 가까운 선분에 붙인다.
            // 그래야 통과 위치·교차로 이후 방향·양쪽 카메라 중 가까운 쪽이
            // 경로 점 간격과 무관하게 결정된다.
            prev.lastAt = at;
            if (d < raw[prev.index].d) raw[prev.index] = candidate;
          } else {
            encounters.set(idx, { lastAt: at, index: raw.length });
            raw.push(candidate);
          }
        }
      }
    }
  }
  // 방향은 가장 가까운 선분에서 검사한다. 먼저 만난 교차로 진입 선분의
  // 방향으로 검사하면 실제 통과 방향과 반대인 카메라까지 살아남을 수 있다.
  const pointAt = (at: number): LatLng => {
    let lo = 1, hi = path.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < at) lo = mid + 1; else hi = mid;
    }
    const t = Math.max(0, Math.min(1, (at - cum[lo - 1]) / (cum[lo] - cum[lo - 1] || 1)));
    return { lat: path[lo - 1].lat + (path[lo].lat - path[lo - 1].lat) * t,
      lng: path[lo - 1].lng + (path[lo].lng - path[lo - 1].lng) * t };
  };
  const roadNameWindowM = CAMERA_ROAD_SNAP_M * 2;
  const routeLinkAt = (at: number) => {
    let best: NodelinkPathMatch["linkRuns"][number] | undefined;
    let bestGap = Infinity;
    for (const run of routeMatch.linkRuns) {
      if (run.fromM <= at && at <= run.toM) return run;
      const gap = at < run.fromM ? run.fromM - at : at - run.toM;
      if (gap < bestGap) { bestGap = gap; best = run; }
    }
    // 25m 표본 간의 작은 틈만 잇고 실제 지도 매칭 공백은 유지한다.
    return bestGap <= 35 ? best : undefined;
  };

  // 합류부에서는 공식 방향·진입 링크·속도 메타데이터가 모두 일치해야 이웃 분기 카메라로 판정한다. 근거가 부족하면 경고를 유지한다.
  const mergeBranchConflict = (c: RawCam): boolean => {
    if (c.kind === "section" || c.school || c.dirStrong !== true || c.dirBrg == null
        || !(c.limitKmh && c.limitKmh > 0) || c.at < 130) return false;
    const cameraLinks = nearbyNodelinks(c, c.dirBrg, 60, 45);
    const cameraLink = cameraLinks[0];
    if (!cameraLink || cameraLink.distanceM > 15) return false;
    const speedEvidence = cameraLinks.filter((l) => l.maxSpeedKmh > 0);
    if (!speedEvidence.length || speedEvidence.some((l) => l.maxSpeedKmh === c.limitKmh)) return false;

    const approachAt = c.at - 100;
    const matchedRouteLink = routeLinkAt(approachAt);
    if (matchedRouteLink) {
      if (matchedRouteLink.linkId === cameraLink.linkId) return false;
      return matchedRouteLink.toNodeIndex === cameraLink.toNodeIndex
        && matchedRouteLink.fromNodeIndex !== cameraLink.fromNodeIndex;
    }
    // 표준 그래프 밖에서는 기존 경고 판정을 유지한다.
    const approach = pointAt(approachAt);
    const h0 = pointAt(Math.max(0, approachAt - 15));
    const h1 = pointAt(Math.min(cum[cum.length - 1], approachAt + 15));
    const routeBearing = bearing(h0, h1);
    const routeLink = nearbyNodelinks(approach, routeBearing, 35, 35)[0];
    if (!routeLink || routeLink.distanceM > 15 || routeLink.linkId === cameraLink.linkId) return false;
    return routeLink.toNodeIndex === cameraLink.toNodeIndex
      && routeLink.fromNodeIndex !== cameraLink.fromNodeIndex;
  };

  const routeRoadIdentityConflict = (c: RawCam): boolean => {
    const routeLink = routeLinkAt(c.at);
    if (!routeLink?.roadName || c.roadNames?.length !== 1) return false;
    if (sameRoadName(c.roadNames[0], routeLink.roadName)) return false;
    // 경로 위 20m 안이고 경찰청 방향이 경로 방향과 20° 안이면 도로명이 달라도(별칭·
    // 고가/지하도로 이름 등) 같은 길 카메라로 본다. 반대·교차 도로 카메라는 방향이 크게
    // 어긋나 이 조건에 안 걸린다. 2026-10-07: 정답 경로 계산이 이 거부권 때문에 놓치던
    // 카메라 약 12곳(서울 화랑로·대구 통학로 등, 카카오·티맵 앱도 경고)을 살린다.
    if (c.d <= 20 && c.dirBrg != null && Math.abs(norm(c.dirBrg - c.routeBearing)) <= 20) return false;

    // 도로명 오기나 별칭만으로 경고를 숨기지 않는다. 공식 방향이나 도로 이격 근거가 함께 있어야 한다.
    if (!(c.dirStrong === true && c.dirBrg != null) && c.d <= CAMERA_ROAD_SNAP_M) return false;

    // 독립된 두 자료의 도로 번호가 일치하면 도로명 별칭을 허용한다.
    const cameraRoadNo = String(c.roadRouteNo ?? "").replace(/\D/g, "");
    const routedRoadNo = String(routeLink.roadNo ?? "").replace(/\D/g, "");
    if (cameraRoadNo && routedRoadNo && cameraRoadNo === routedRoadNo) return false;
    return true;
  };

  const aligned = raw.filter((c) => {

    // 출발지 뒤나 목적지 너머의 카메라는 전방 경고 대상에서 제외한다.
    if (c.outsideRoute) return false;
    if (routeRoadIdentityConflict(c)) return false;
    if (c.dirBrg != null) {
      const maxDirDiff = c.dirStrong ? 60 : 100;
      if (Math.abs(norm(c.dirBrg - c.routeBearing)) > maxDirDiff) return false;
    }
    // 들어오는 방향 — 공식 방향이 확실한 장비는 카메라 지점 직전 40m의 경로 방향과도 맞아야 한다.
    // 그 교차로에서 꺾어 들어가면 카메라 지점의 경로 방향은 맞아도 정지선은 지나지 않는다.
    // 2026-10-22 채점 v5(591길) 길안내 진짜 헛경고 141 중 "꺾어 들어감" 32·"어느 방향과도 안 맞음" 17.
    if (c.dirStrong === true && c.dirBrg != null && c.at >= 40) {
      const approachBrg = bearing(pointAt(c.at - 40), pointAt(c.at));
      if (Math.abs(norm(c.dirBrg - approachBrg)) > 60) return false;
    }
    const levelLink = routeLinkAt(c.at);
    if (levelLink && (c.roadNames?.length === 1 || (c.dirStrong === true && c.dirBrg != null) || c.signal === true)) {
      const aheadAt = c.at + roadNameWindowM;
      const aheadLink = aheadAt <= cum[cum.length - 1] ? routeLinkAt(aheadAt) : undefined;
      const ahead = aheadLink ? {
        point: pointAt(aheadAt),
        heading: bearing(pointAt(Math.max(0, aheadAt - 15)), pointAt(Math.min(cum[cum.length - 1], aheadAt + 15))),
      } : undefined;
      const level = cameraRoadLevelAtPoint(c, pointAt(c.at), c.routeBearing,
        [levelLink.linkId, ...(aheadLink ? [aheadLink.linkId] : [])], ahead);
      if (level.verdict === "different") return false;
    }

    // 공식 방향과 정확히 일치하는 경로 링크는 근접도에 따른 분기 추정보다 우선한다.
    let exactDirectedLinkMatch = false;
    let exactDirectedRoadMatch = false;
    if (c.dirStrong === true && c.dirBrg != null) {
      const routeLink = routeLinkAt(c.at);
      // 교차로나 분리도로에서는 최근접 링크만 고르지 않고 방향이 맞는 후보 중 실제 주행 링크를 우선한다.
      const cameraLinks = nearbyNodelinks(c, c.dirBrg, 35, 20);
      const cameraLink = routeLink
        ? cameraLinks.find((x) => x.linkId === routeLink.linkId
          && x.distanceM <= 25 && (x.headingDiffDeg ?? Infinity) <= 20)
        : undefined;
      exactDirectedLinkMatch = !!cameraLink;
      exactDirectedRoadMatch = exactDirectedLinkMatch
        && c.roadNames?.length === 1 && !!cameraLink?.roadName
        && sameRoadName(c.roadNames[0], cameraLink.roadName);
    }
    // 주행 링크 일치는 약한 도로축 추정보다 우선하지만 그래프와 속도 근거로 확인된 다른 분기는 제외한다.
    if (mergeBranchConflict(c)) return false;
    const dir = roadDirAt(c.lat, c.lng);
    if (!exactDirectedLinkMatch && !cameraRoadMatchesRoute(dir, c.routeBearing, c.d)) return false;
    // 교차로 한가운데의 이름은 옆길로 붙을 수 있어 경로 앞뒤도 확인한다.
    if (exactDirectedRoadMatch || c.roadNames?.length !== 1 || c.at < roadNameWindowM
        || c.at + roadNameWindowM > cum[cum.length - 1]) return true;
    const beforeRoad = roadNameAt(pointAt(c.at - roadNameWindowM));
    const afterRoad = roadNameAt(pointAt(c.at + roadNameWindowM));

    // 지도 매칭이 없어도 공식 도로명과 이격 거리가 충분하면 다른 도로로 판단한다. 모호하면 기존 경고를 유지한다.
    if (c.roadStrong && c.d > CAMERA_ROAD_SNAP_M
        && sameRoadName(beforeRoad, afterRoad)
        && !sameRoadName(c.roadNames[0], beforeRoad)) return false;
    return cameraRoadNameMatchesRoute(c.roadNames, roadNameAt(c, CAMERA_ROAD_SNAP_M),
      beforeRoad, afterRoad);
  }).sort((a, b) => a.at - b.at);

  // 쌍둥이 후보가 둘 다 방향 필터를 통과하면 단순 0.xm 거리 차이보다
  // "경찰청 도로명 – 실제 경로 도로명"이 맞는 후보를 우선한다. 이름 근거가
  // 없거나 교차로에서 경로명이 바뀌면 기존처럼 거리만 사용한다.
  const roadEvidence = (c: RawCam): number => {
    if (c.roadNames?.length !== 1 || c.at < roadNameWindowM
        || c.at + roadNameWindowM > cum[cum.length - 1]) return 0;
    const before = roadNameAt(pointAt(c.at - roadNameWindowM));
    const after = roadNameAt(pointAt(c.at + roadNameWindowM));
    if (!sameRoadName(before, after)) return 0;
    const police = c.roadNames[0];
    const mapped = roadNameAt(c, CAMERA_ROAD_SNAP_M);
    if (sameRoadName(police, before)) return sameRoadName(mapped, police) ? 3 : 2;
    return sameRoadName(mapped, before) ? 1 : 0;
  };

  // 반대편 차로 쌍 병합 (구간단속 게이트는 시/종점이 별개라 제외)
  const kept: RawCam[] = [];
  for (const c of aligned) {
    let twin = -1;
    for (let j = kept.length - 1; j >= 0; j--) {
      const p = kept[j];
      if (c.at - p.at > TWIN_AT_M) break; // at 오름차순이라 더 볼 필요 없음
      // 같은 교차로의 같은 방향 장비(차로별·신호/과속)는 경로상 80m 안이면 한 번만 안내.
      // 2026-10-19 채점 v5(113길): 길안내에서 같은 자리 두 번 경고 52번(두 번째는 카메라 0~8m 앞).
      if (
        c.kind !== "section" && p.kind !== "section" &&
        c.dirBrg != null && p.dirBrg != null && Math.abs(norm(c.dirBrg - p.dirBrg)) <= 30 &&
        c.at - p.at <= 80 &&
        !(c.limitKmh && p.limitKmh && c.limitKmh !== p.limitKmh)
      ) { twin = j; break; }
      if (p.kind !== c.kind) continue;
      if (c.kind === "section" || p.kind === "section") continue;
      // 같은 교차로 안에서도 식별자가 다르면 별도 설치 장비로 유지한다.

      if (p.deviceId && c.deviceId) {
        if (p.deviceId === c.deviceId) { twin = j; break; }
        continue;
      }
      if (dM({ lat: p.lat, lng: p.lng }, { lat: c.lat, lng: c.lng }) <= TWIN_PHYS_M) {
        twin = j;
        break;
      }
    }
    if (twin >= 0) {
      const prev = kept[twin];
      const prevEvidence = roadEvidence(prev);
      const nextEvidence = roadEvidence(c);
      if (nextEvidence > prevEvidence || (nextEvidence === prevEvidence && c.d < prev.d))
        kept[twin] = c;
    } else {
      kept.push(c);
    }
  }

  // 구간단속 존 재구성 — 시점(start)에서 열고 종점(end)에서 닫아 쌍으로 만든다.
  // 하나의 구간단속이 여러 점(반대차로 중복·연속 시점·spos=0 미상)으로 들어와
  // 각각 "구간단속 구간" 경고를 내던 스팸을 없앤다. 열린 존이 있는 동안의
  // 시점/미상은 같은 존으로 흡수하고, 매칭 없는 종점은 버린다. 존 내 최대
  // 제한속도를 양끝에 전파(미상 카메라의 "제한 속도 미상" 안내 감소).
  const sections = kept.filter((c) => c.kind === "section").sort((a, b) => a.at - b.at);
  const fixedCams = kept.filter((c) => c.kind !== "section");
  const mergedSec: RawCam[] = [];
  const emitZone = (s: RawCam, e: RawCam | null, lim: number) => {
    mergedSec.push({ ...s, section: "start", ...(lim ? { limitKmh: lim } : {}) });
    // 종점이 충분히 떨어져 있을 때만 종료 안내(단일 점 존은 시점만)
    if (e && e.at - s.at >= 300)
      mergedSec.push({ ...e, section: "end", ...(lim ? { limitKmh: lim } : {}) });
  };
  const sectionRoadConfirmed = (c: RawCam): boolean => {
    if (c.roadNames?.length !== 1 || c.at < roadNameWindowM) return false;
    const police = c.roadNames[0];
    return sameRoadName(police, roadNameAt(c, CAMERA_ROAD_SNAP_M))
      && sameRoadName(police, roadNameAt(pointAt(c.at - roadNameWindowM), CAMERA_ROAD_SNAP_M));
  };
  const emitInsideEnd = (c: RawCam) => {
    const prev = mergedSec[mergedSec.length - 1];
    if (prev?.section === "inside-end" && c.at - prev.at <= TWIN_AT_M && dM(prev, c) <= TWIN_PHYS_M) {
      if (c.d < prev.d) mergedSec[mergedSec.length - 1] = { ...c, section: "inside-end" };
    } else mergedSec.push({ ...c, section: "inside-end" });
  };
  let open: RawCam | null = null;
  let openLim = 0;
  for (const c of sections) {
    const lim = c.limitKmh ?? 0;
    if (c.section === "end") {
      if (open) {
        emitZone(open, c, Math.max(openLim, lim));
        open = null;
        openLim = 0;
      } else if (sectionRoadConfirmed(c)) emitInsideEnd(c);
    } else {
      if (!open) {
        open = c;
        openLim = lim;
      } else openLim = Math.max(openLim, lim);
    }
  }
  if (open) emitZone(open, null, openLim); // 종점 없는 존 — 시점만(종료 안내 없음)
  const all = [...fixedCams, ...mergedSec].sort((a, b) => a.at - b.at);
  return all.map((rawCam) => {
    const { d, routeBearing, roadNames, outsideRoute, ...c } = rawCam;

    void d; void routeBearing; void roadNames; void outsideRoute;
    return c;
  });
}

const NARROW_R = 30; // 경로─경계점 허용 거리
const NARROW_REHIT_M = 800;
// [lat, lng, wideBearing] — wideBearing은 넓은 차로 쪽 방위. 주행 진행 방위가
// 이와 반대(넓은–좁은)일 때만 안내.
let narrowGrid: Map<number, number[]> | null = null;
let narrowPts: [number, number, number][] | null = null;
function loadNarrowGrid() {
  if (narrowGrid && narrowPts) return { narrowGrid, narrowPts };
  narrowGrid = new Map();
  try {
    narrowPts = JSON.parse(
      readFileSync(join(process.cwd(), "src/lib/data/narrows.json"), "utf8"),
    );
  } catch {
    narrowPts = [];
  }
  for (let i = 0; i < narrowPts!.length; i++) {
    const [lat, lng] = narrowPts![i];
    const k = ckey(lat, lng);
    const a = narrowGrid.get(k);
    if (a) a.push(i);
    else narrowGrid.set(k, [i]);
  }
  return { narrowGrid, narrowPts: narrowPts! };
}

function findNarrows(path: LatLng[], cum: number[]): NavNarrow[] {
  const { narrowGrid: grid, narrowPts: pts } = loadNarrowGrid();
  if (pts.length === 0 || path.length < 2) return [];
  const lastAt = new Map<number, number>();
  const out: NavNarrow[] = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1];
    const b = path[i];
    const heading = bearing(a, b); // 진행 방위
    const ci = Math.floor((a.lat + b.lat) / 2 / CELL);
    const cj = Math.floor((a.lng + b.lng) / 2 / CELL);
    for (let x = ci - 1; x <= ci + 1; x++) {
      for (let y = cj - 1; y <= cj + 1; y++) {
        for (const idx of grid.get(x * 100_000 + y + 2_000_000_000) ?? []) {
          const [clat, clng, wideB] = pts[idx];
          const k = kx(clat);
          const ax = (a.lng - clng) * k;
          const ay = (a.lat - clat) * 110_540;
          const bx2 = (b.lng - clng) * k;
          const by2 = (b.lat - clat) * 110_540;
          const dx = bx2 - ax;
          const dy = by2 - ay;
          const len2 = dx * dx + dy * dy;
          let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
          t = Math.max(0, Math.min(1, t));
          if (Math.hypot(ax + t * dx, ay + t * dy) > NARROW_R) continue;
          // 넓은 쪽에서 진입할 때만(진행 방위가 wideBearing과 100° 넘게 벌어짐)
          if (Math.abs(norm(heading - wideB)) < 100) continue;
          // 고속도로·자동차전용도로는 차로 감소가 진출·합류마다 일상이고 표지로
          // 안내되므로 "도로 좁아짐 주의"를 울리지 않는다(고속 주행 중 스팸 방지).
          // motorroad 태그가 빠진 강변북로·자유로·공항고속(oneway 간선)까지 포함.
          if (dividedExpresswayNear({ lat: clat, lng: clng }, 30)) continue;
          const at = cum[i - 1] + (cum[i] - cum[i - 1]) * t;
          const prev = lastAt.get(idx);
          if (prev !== undefined && at - prev < NARROW_REHIT_M) {
            lastAt.set(idx, at);
            continue;
          }
          lastAt.set(idx, at);
          out.push({ at: Math.round(at), lat: clat, lng: clng });
        }
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

type FixedGuidance = Omit<NavGuidance, "speeds" | "calibMul">;
const fixedGuidanceCache = new GuidanceCache<FixedGuidance>();

function buildFixedGuidance(path: LatLng[]): FixedGuidance {
  const cum = cumDist(path);
  const routeMatch = matchPathNodelinks(path);
  return {
    maneuvers: findManeuvers(path, cum),
    cams: findRouteCams(path, cum, routeMatch),
    narrows: findNarrows(path, cum),
    limits: speedLimitsAlong(path),
    roadRuns: routeMatch.roadRuns,
    roadMatch: {
      coverage: Number(routeMatch.coverage.toFixed(4)),
      continuity: Number(routeMatch.continuity.toFixed(4)),
      meanDistanceM: Number(routeMatch.meanDistanceM.toFixed(1)),
    },
    totalM: Math.round(cum[cum.length - 1]),
  };
}

/** 경로 고정 안내를 재사용하고 현재 교통속도·시간 보정은 매번 갱신한다. */
export function buildGuidance(path: LatLng[]): NavGuidance {
  // 카메라는 런타임 갱신되므로 기존 mtime 리로드를 건너뛰지 않는다.
  // 도로 그래프·도로명은 기존과 같이 워커 재시작 때 교체된다.
  loadCams();
  const key = createHash("sha256")
    .update(`${camDataKey}|${kakaoKey()}|`)
    .update(JSON.stringify(path)).digest("hex");
  let fixed = fixedGuidanceCache.get(key);
  if (!fixed) {
    fixed = buildFixedGuidance(path);
    fixedGuidanceCache.set(key, fixed);
  }
  return {
    ...fixed,
    speeds: pathSpeedProfile(path),
    calibMul: Number(applyTimeCalib(1, pathJuncPerKm(path)).toFixed(3)),
  };
}

/**
 * 이탈 재탐색 — 현위치에서 코스 전방 복귀점(이탈 지점보다 앞)까지 로컬 A*로
 * 잇고, 이후 코스는 그대로. 복귀점은 800m–2km–4km 앞 순서로 시도한다
 * (너무 가까우면 복귀 직후 또 회전 폭탄, 너무 멀면 코스를 건너뛴다).
 */
export function reroute(
  from: LatLng,
  path: LatLng[],
  fromIdx: number,
  heading?: number,
): { path: LatLng[]; guidance: NavGuidance } | null {
  const cum = cumDist(path);
  const total = cum[cum.length - 1];
  const destPt = path[path.length - 1];
  // 목적지 안내(A–B)에서는 **원래 경로를 버리고 목적지로 새 경로를 짠다.**
  //   예전엔 원래 경로의 앞쪽 점으로 '복귀'하는 걸 목표로 삼아, 놓친 회전
  //   지점이 꼭 지나야 할 경유지처럼 취급됐고 그래서 되돌아가는(유턴) 안내가
  //   나왔다. 실제 내비는 목적지만 유지하고 현재 위치에서 새로 계산한다.
  //   ※ 순환 코스(출발≈도착)는 예외 — 목적지로 직행하면 주행이 그냥 끝나버려
  //     기존 복귀 로직을 그대로 쓴다.
  //   ※ 경치 코스(남은 경로가 목적지 직선거리보다 훨씬 김)도 예외 — 일부러
  //     돌아가는 길이라 목적지 직행은 코스를 통째로 건너뛴다.
  const isLoop = dM(path[0], destPt) < 300;
  let nearestD = Infinity;
  let nearestI = 0;
  for (let k = 0; k < path.length; k++) {
    const d = dM(from, path[k]);
    if (d < nearestD) {
      nearestD = d;
      nearestI = k;
    }
  }
  const remainM = total - cum[nearestI];
  const directM = dM(from, destPt);
  const scenic = remainM > Math.max(directM * 1.6, directM + 3000);
  const freshOk = !isLoop && !scenic;
  // 복귀 기준점 — 이탈 중 앞으로 달렸으면 진행 idx가 얼어붙어 복귀점이 뒤에
  // 잡힐 수 있다. 현재 위치에 가장 가까운 코스 점을 함께 보고 더 앞을 기준으로.
  const fi = Math.min(Math.max(fromIdx, 0), path.length - 1);
  let nearIdx = fi;
  let nearD = Infinity;
  for (let k = 0; k < path.length; k++) {
    const d = dM(from, path[k]);
    if (d < nearD) {
      nearD = d;
      nearIdx = k;
    }
  }
  // 최근접이 진행 idx보다 앞이면 그걸 복귀 기준으로 — 이탈 중 코스를 앞질러
  // 달려 진행 idx가 뒤에 얼어붙어도 운전자 실제 위치를 따라간다. 6km까지
  // 허용해 2~5km짜리 실제 이탈에서도 복귀점이 뒤에 잡혀 "거꾸로" 안내되던
  // 문제를 막는다(과거 3km 캡은 3km 이탈에서 이미 뒤로 안내). loop형 코스에서
  // 다른 랩으로 과도히(>6km) 튀는 오매칭은 여전히 배제.
  const startIdx =
    cum[nearIdx] > cum[fi] && cum[nearIdx] - cum[fi] <= 6000 ? nearIdx : fi;
  const base = cum[startIdx];
  const destD = dM(from, path[path.length - 1]); // 목적지 직선거리
  // 복귀 leg가 운전자 헤딩과 반대로(즉시 역주행) 시작하면 복귀점이 뒤에 잡힌
  // 신호 — 절대 채택하지 않는다. 헤딩을 알 때만 판정. (기준점을 잘 잡으면
  // 정상적으로 안 걸리고, 걸리면 실패로 알려 6초 뒤 재시도가 낫다.)
  // 80m만 보면 "조금 가다 유턴"을 못 잡는다 — 회전을 놓쳤을 때 복귀 경로가
  //   100~200m 앞 교차로에서 되돌리는 경우가 흔하고, 운전자에겐 그게 곧 유턴이다.
  //   300m 창으로 넓혀 지연 유턴까지 역주행으로 판정한다.
  const startsBackward = (leg: LocalLeg): boolean => {
    if (heading == null) return false;
    let acc = 0;
    let end = leg.path[0];
    for (let i = 1; i < leg.path.length && acc < 300; i++) {
      acc += dM(leg.path[i - 1], leg.path[i]);
      end = leg.path[i];
    }
    if (acc < 5) return false;
    return Math.abs(norm(bearing(leg.path[0], end) - heading)) > 110;
  };

  // 현재 위치·진행방향에서 목적지로 새로 계산한 경로를 그대로 쓴다.
  // ※ "뒤로 시작하면 일단 앞으로 350m 간 뒤 다시 계산"하는 보정을 넣어봤으나
  //   **더 나빴다**(초반 1.5km 유턴 0%–50%, 평균 우회 1.39x–2.32x). 억지로
  //   앞으로 밀면 그 앞에서 되돌아오게 돼 유턴이 미뤄질 뿐이고 경로만 길어진다.
  //   되돌아가는 게 실제로 맞는 상황(목적지가 뒤)도 있으므로, 엔진 판단을
  //   startHeading(출발 역주행 페널티)로만 눌러주고 그대로 채택한다.
  if (freshOk) {
    // ※ 후보를 3개 받아 "앞으로 시작하는 것"을 고르는 방식도 재봤으나 결과가
    //   완전히 동일했다 — 되돌아가는 케이스는 대안 경로도 전부 되돌아간다
    //   (일방통행·중앙분리대 구간이라 물리적으로 그 방법뿐). 연산만 늘어 되돌림.
    const fresh = localLeg(from, destPt, { startHeading: heading });
    if (fresh?.path && fresh.path.length > 1) {
      return { path: fresh.path, guidance: buildGuidance(fresh.path) };
    }
  }
  // 정상 복귀점을 못 찾을 때(강 건너·일방통행 함정 등)의 최선책 — 총거리 최소.
  // 역주행 후보는 크게 감점해 최후에도 뒤로는 안 보낸다.
  let fallback: { leg: LocalLeg; j: number } | null = null;
  let fallbackTotal = Infinity;
  let fallbackScore = Infinity;
  const REVERSE_PENALTY = 1_000_000;
  for (const aheadM of [800, 2000, 4000, Infinity]) {
    const target = Math.min(base + aheadM, total);
    let j = path.length - 1;
    if (target < total) {
      j = startIdx;
      while (j < path.length - 1 && cum[j] < target) j++;
    }
    const leg = localLeg(from, path[j], { startHeading: heading });
    if (!leg) continue;
    const backward = startsBackward(leg);
    // 정방향 + 직선거리 대비 정상(루프 아님)이면 즉시 채택 — 가까운 복귀점일수록
    // 원래 코스를 더 많이 유지한다. 역주행 후보는 절대 즉시 채택하지 않고,
    // 더 먼 복귀점(계속 전진해서 합류)을 마저 시도한다.
    if (!backward && leg.dist <= Math.max(dM(from, path[j]) * 3, 2000)) {
      const newPath = [...leg.path, ...path.slice(j + 1)];
      return { path: newPath, guidance: buildGuidance(newPath) };
    }
    // 루프성/역주행 후보 — 버리지 말고 총거리 최소인 것만 보관하고 더 먼 복귀점 시도.
    const legTotal = leg.dist + (total - cum[j]);
    const score = legTotal + (backward ? REVERSE_PENALTY : 0);
    if (score < fallbackScore) {
      fallbackScore = score;
      fallbackTotal = legTotal;
      fallback = { leg, j };
    }
  }
  // 최선책이 역주행이 아니고(뒤로 안 보냄) 목적지 직선의 3배 이내면 채택. 모든
  // 복귀가 역주행이거나(REVERSE_PENALTY 반영) 진짜 함정이면 억지로 보내지 말고 실패.
  if (
    fallback &&
    fallbackScore < REVERSE_PENALTY &&
    fallbackTotal <= Math.max(destD * 3, 4000)
  ) {
    const newPath = [...fallback.leg.path, ...path.slice(fallback.j + 1)];
    return { path: newPath, guidance: buildGuidance(newPath) };
  }
  // 여기까지 왔다 = 원래 코스로 되돌아가는 복귀점이 전부 역주행이거나 함정.
  //   예전엔 null로 실패시켜 클라가 "경로 재탐색 중"에 갇히고, 6초 뒤 재시도해도
  //   같은 결과라 사실상 안내가 멎었다. 실내비처럼 **원래 코스를 버리고 목적지로
  //   직행**하는 새 경로를 만든다 — 회전을 놓쳤을 때 되돌리지 않고 앞으로 가며
  //   다시 붙는 게 정상 동작이다. 이것도 전진 우선(startHeading)으로 구한다.
  const dest = path[path.length - 1];
  const direct = localLeg(from, dest, { startHeading: heading });
  if (direct?.path && direct.path.length > 1) {
    return { path: direct.path, guidance: buildGuidance(direct.path) };
  }
  // 목적지 직행조차 실패(그래프 밖 등) — 이때만 실패로 알려 재시도하게 한다.
  return null;
}
