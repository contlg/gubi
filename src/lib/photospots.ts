import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { elevationAt } from "@/lib/elevation";
import { fastestRoadKmhNear, junctionCountNear } from "@/lib/localroute";
import { curvatureSegments, distanceM } from "@/lib/scoring/curvature";
import type { DriveStyle, LatLng } from "@/lib/types";

export interface PhotoSpot {
  name: string;
  coord: LatLng;
  /** 로드뷰 초기 시선 방향(도, 북=0) — 물 쪽. 없으면 도로 진행 방향 기본 */
  pan?: number;
  /** 물(바다·강) 지점 — 시선 검증된 도로점이라 로드뷰도 그 자리(30m)에서만 찾는다 */
  water?: boolean;
}

/** 이 반경 안 실교차로가 이 수 이상이면 도시/마을 — 촬영 제외 */
const URBAN_RADIUS_M = 250;
const URBAN_JUNCTIONS = 3;
/** 후보끼리 최소 간격 — 같은 풍경 두 장 방지 */
const DIVERSITY_M = 3000;

const WINDING_MIN_DEG = 80;

function bearingDeg(a: LatLng, b: LatLng): number {
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const la1 = (a.lat * Math.PI) / 180;
  const la2 = (b.lat * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos(la2);
  const x =
    Math.cos(la1) * Math.sin(la2) - Math.sin(la1) * Math.cos(la2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

const isUrban = (p: LatLng) =>
  junctionCountNear(p, URBAN_RADIUS_M) >= URBAN_JUNCTIONS;

/**
 * 전국 도로 터널 점 색인 (scripts/build-tunnels-from-osm.mjs 산출물, ~9만 점).
 * DEM은 지표 고도라 터널을 못 보고, 카카오 로드뷰는 터널 내부 파노라마도
 * 있어서(실측: 강변 코스 정상부가 터널 안으로 찍힘) 좌표로 직접 걸러야 한다.
 */
const TUNNEL_FILE = join(process.cwd(), "src/lib/data/tunnel-points.json");
const TCELL = 0.003; // ~330m 격자
const tkey = (lat: number, lng: number) =>
  Math.floor(lat / TCELL) * 100000 + Math.floor(lng / TCELL) + 2_000_000_000;
let tunnelGrid: Map<number, [number, number][]> | null = null;
function loadTunnelGrid(): Map<number, [number, number][]> {
  if (tunnelGrid) return tunnelGrid;
  tunnelGrid = new Map();
  try {
    const arr = JSON.parse(readFileSync(TUNNEL_FILE, "utf8")) as [number, number][];
    for (const [lat, lng] of arr) {
      const k = tkey(lat, lng);
      const cell = tunnelGrid.get(k);
      if (cell) cell.push([lat, lng]);
      else tunnelGrid.set(k, [[lat, lng]]);
    }
  } catch {
    // 데이터 없으면 터널 필터 없이 동작
  }
  return tunnelGrid;
}

function nearTunnel(p: LatLng, radiusM = 150): boolean {
  const g = loadTunnelGrid();
  if (g.size === 0) return false;
  const ci = Math.floor(p.lat / TCELL);
  const cj = Math.floor(p.lng / TCELL);
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const cell = g.get(a * 100000 + b + 2_000_000_000);
      if (!cell) continue;
      for (const [lat, lng] of cell) {
        if (distanceM(p, { lat, lng }) <= radiusM) return true;
      }
    }
  }
  return false;
}

/**
 * 물이 "실제로 보이는" 도로점 색인 (scripts/build-view-points-from-osm.mjs 산출물).
 * 항목 [lat, lng, pan, kind(0 바다·1 강/호수), openM(열린 물 길이), fgM(도로→물가 전경)].
 * 해안선까지 거리만 보고 고른 지점은 방음벽·숲·항만·아파트·나란한 큰길·둑에 가려
 * 물이 안 보였다(2026-11-14 실측) — 이제 지도 기하로 시선이 물까지 트인 점만 쓴다.
 */
const VIEW_FILE = join(process.cwd(), "src/lib/data/view-points.json");
const VCELL = 0.002; // ~220m 격자 (산출물을 다시 만들면 이 모듈을 다시 읽어야 반영 — 모듈 캐시)
type ViewPoint = [number, number, number, number, number, number];
let viewGrid: Map<number, ViewPoint[]> | null = null;
function loadViewGrid(): Map<number, ViewPoint[]> {
  if (viewGrid) return viewGrid;
  viewGrid = new Map();
  try {
    const arr = JSON.parse(readFileSync(VIEW_FILE, "utf8")) as ViewPoint[];
    for (const v of arr) {
      const k = Math.floor(v[0] / VCELL) * 1_000_000 + Math.floor(v[1] / VCELL);
      const cell = viewGrid.get(k);
      if (cell) cell.push(v);
      else viewGrid.set(k, [v]);
    }
  } catch {
    // 데이터 없으면 물 지점 없음 — 검증 안 된 지점으로 채우지 않는다
  }
  return viewGrid;
}

/**
 * 경로에서 이 거리 안 시선 검증 점만 — 코스가 실제로 달리는 그 길 위 점이어야 한다.
 * 30m로는 강화 초지진에서 해안동로 옆 샛길(서비스 도로) 점이 뽑혀 나무·갯벌이 찍혔다(2026-11-14).
 * 왕복 분리 차로(대부황금로 반대 차로 12~14m)는 들어오게 15m.
 */
const VIEW_ROUTE_M = 15;
/** 경로 촘촘 샘플 간격 — VIEW_ROUTE_M보다 충분히 작게 */
const VIEW_STEP_M = 5;

/** 경로를 따라 시선 검증 점을 모은다 (중복 제거) */
function viewPointsAlong(path: LatLng[]): ViewPoint[] {
  const g = loadViewGrid();
  if (g.size === 0) return [];
  const found = new Set<ViewPoint>();
  const visit = (p: LatLng) => {
    const ci = Math.floor(p.lat / VCELL);
    const cj = Math.floor(p.lng / VCELL);
    for (let a = ci - 1; a <= ci + 1; a++)
      for (let b = cj - 1; b <= cj + 1; b++)
        for (const v of g.get(a * 1_000_000 + b) ?? [])
          if (!found.has(v) && distanceM(p, { lat: v[0], lng: v[1] }) <= VIEW_ROUTE_M) found.add(v);
  };
  // 경로 꼭짓점 사이를 VIEW_STEP_M로 보간 — 꼭짓점이 듬성한 직선 구간도 빠짐없이
  for (let i = 0; i < path.length; i++) {
    visit(path[i]);
    if (i === 0) continue;
    const d = distanceM(path[i - 1], path[i]);
    const n = Math.floor(d / VIEW_STEP_M);
    for (let k = 1; k < n; k++) {
      const t = k / n;
      visit({
        lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t,
        lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * t,
      });
    }
  }
  return [...found];
}

/** 정렬 키 — 전경 짧을수록, 열린 물 길수록 좋다(열린 물 20m 차이 ≈ 전경 1m) */
const viewRank = (v: ViewPoint) => v[5] + (1500 - Math.min(v[4], 1500)) / 20;

/**
 * 촬영지 공통 결격 — 도시/마을(건물), 터널 안·위, 방음벽 낀 간선·전용도로
 * (80km/h급 이상). 셋 다 실측 스크린샷에서 확인된 불량 패턴이다.
 */
function badSpot(p: LatLng): boolean {
  if (isUrban(p)) return true;
  if (nearTunnel(p)) return true;
  // 방음벽 낀 간선이 옆에 나란히 달리는 경우도 잡게 반경을 넉넉히
  const kmh = fastestRoadKmhNear(p, 150);
  if (kmh !== null && kmh >= 80) return true;
  return false;
}

/** 물 지점 결격 — 터널 안·위, 방음벽 낀 80km/h급 간선 옆. 가림은 산출 때 기하로 봤다 */
function badWaterSpot(p: LatLng): boolean {
  if (nearTunnel(p)) return true;
  const kmh = fastestRoadKmhNear(p, 150);
  return kmh !== null && kmh >= 80;
}

interface Scored extends PhotoSpot {
  score: number;
}

/** 스타일 무관 후보 수집 — 종류별로 뽑고 스타일이 우선순위를 정한다 */
function collect(path: LatLng[]): Record<"coast" | "river" | "winding", Scored[]> {
  // 해안·강변: 시선 검증 점(view-points.json) 중 경로 30m 안인 것만. 방향(pan)도 그 점의 것 —
  // 도로→물가 전경이 짧고 가림(건물·벽·숲·항만·큰길·갯벌·지형)이 없고 물이 넓게 열린 방향이다.
  // 도시 판정(교차로 수)은 쓰지 않는다 — 기하로 이미 가림을 봤고, 송도 해변길처럼 시내여도
  // 바다가 트인 곳이 있다. 다리 판정(overWater)도 뺀다 — 산출 때 다리를 제외했고, 방조제처럼
  // 양쪽이 물인 길은 오히려 좋은 지점이다. 터널·고속 간선(방음벽) 결격만 남긴다.
  const views = viewPointsAlong(path)
    .filter((v) => !badWaterSpot({ lat: v[0], lng: v[1] }))
    .sort((a, b) => viewRank(a) - viewRank(b));
  const pick = (kind: number, name: string, score: number): Scored[] => {
    const out: Scored[] = [];
    for (const v of views) {
      if (v[3] !== kind) continue;
      const coord = { lat: v[0], lng: v[1] };
      if (out.every((q) => distanceM(q.coord, coord) > DIVERSITY_M))
        out.push({ name, coord, pan: v[2], water: true, score });
      if (out.length >= 3) break;
    }
    return out;
  };
  const coast = pick(0, "바닷가 구간", 100);
  const river = pick(1, "강변 구간", 90);

  const winding: Scored[] = curvatureSegments(path)
    .filter((s) => s.degPerKm >= WINDING_MIN_DEG && s.path.length > 1)
    .sort((a, b) => b.degPerKm - a.degPerKm)
    .slice(0, 6)
    .map((s) => {
      const mid = Math.floor(s.path.length / 2);
      const a = s.path[Math.max(0, mid - 1)];
      const b = s.path[Math.min(s.path.length - 1, mid + 1)];
      return {
        name: s.degPerKm >= 250 ? "헤어핀 구간" : "와인딩 구간",
        coord: s.path[mid],
        // 굽잇길을 따라 도로 진행 방향을 바라본다 (길이 보이게)
        pan: bearingDeg(a, b),
        score: 55 + Math.min(s.degPerKm / 4, 30),
      };
    })
    // 와인딩은 산길만(유저) — 평지 굽잇길 컷은 로드뷰 그림도 밋밋하다
    .filter((c) => !badSpot(c.coord) && (elevationAt(c.coord) ?? 0) >= 120);

  return { coast, river, winding };
}

/**
 * 스팟 선정 — 유저가 고른 스타일들이 곧 보고 싶은 풍경. 여러 개 골랐으면
 * 고정 우선순위: 해안(바다) > 강변(강) > 산길/와인딩(산). 고른 풍경이 이
 * 코스에 없으면 자연 우선순위로 폴백. 최대 2곳 (유저: 3개 말고 2개).
 */
export function photoSpots(path: LatLng[], styles: DriveStyle[] = []): PhotoSpot[] {
  if (path.length < 2) return [];
  const c = collect(path);

  // 강변·해안만 골랐으면 물이 보이는 지점만 — 다른 풍경(굽은 길)으로 채우지 않는다(유저, 2026-11-13)
  const waterOnly =
    (styles.includes("해안도로") || styles.includes("강변도로")) &&
    !styles.some((s) => s === "와인딩" || s === "산길" || s === "직선도로");
  if (waterOnly) {
    // 고른 물 종류만 — 해안 코스에 강 사진("근덕면 강변")이 뜨던 문제(2026-11-15). 없으면 비운다.
    const water = [
      ...(styles.includes("해안도로") ? c.coast : []),
      ...(styles.includes("강변도로") ? c.river : []),
    ];
    const outW: PhotoSpot[] = [];
    for (const p of water) {
      if (outW.every((q) => distanceM(q.coord, p.coord) > DIVERSITY_M))
        outW.push({ name: p.name, coord: p.coord, pan: p.pan, water: p.water });
      if (outW.length >= 2) break;
    }
    return outW;
  }

  const ordered: Scored[] = [];
  if (styles.includes("해안도로")) ordered.push(...c.coast);
  if (styles.includes("강변도로")) ordered.push(...c.river);
  // 정상부는 뺀다 — 차 높이 로드뷰라 정상에서도 절개지·나무·요금소만 찍혔다(2026-11-13 실측 9곳 중 0곳).
  if (styles.includes("산길") || styles.includes("와인딩")) ordered.push(...c.winding);
  // 폴백/보충 — 자연 우선순위 (바다 > 강 > 정상부 > 와인딩)
  ordered.push(
    ...[...c.coast, ...c.river, ...c.winding].sort(
      (a, b) => b.score - a.score,
    ),
  );

  const out: PhotoSpot[] = [];
  for (const p of ordered) {
    if (out.every((q) => distanceM(q.coord, p.coord) > DIVERSITY_M))
      out.push({ name: p.name, coord: p.coord, pan: p.pan, water: p.water });
    if (out.length >= 2) break;
  }
  // 볼 풍경이 없으면 빈 배열 — 코스 아무 지점(도로·절개지)을 채워 넣지 않는다(2026-11-13).
  return out;
}
