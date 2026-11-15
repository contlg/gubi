import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { elevationAt } from "@/lib/elevation";
import { fastestRoadKmhNear, junctionCountNear } from "@/lib/localroute";
import { getPrefetchedPoints } from "@/lib/osm";
import { allRiversideSegments } from "@/lib/winding";
import { curvatureSegments, distanceM } from "@/lib/scoring/curvature";
import type { DriveStyle, LatLng } from "@/lib/types";

export interface PhotoSpot {
  name: string;
  coord: LatLng;
  /** 로드뷰 초기 시선 방향(도, 북=0) — 물 쪽. 없으면 도로 진행 방향 기본 */
  pan?: number;
}

/** 이 반경 안 실교차로가 이 수 이상이면 도시/마을 — 촬영 제외 */
const URBAN_RADIUS_M = 250;
const URBAN_JUNCTIONS = 3;
/** 후보끼리 최소 간격 — 같은 풍경 두 장 방지 */
const DIVERSITY_M = 3000;

const STEP_M = 500;

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
 * 강·호수·저수지 물 경계점 색인 (scripts/build-water-edges-from-osm.mjs 산출물).
 * 강 중심선만으로는 "한강처럼 넓어 물가는 가까운 곳"과 "숲·건물 너머 강"을 못 갈랐다
 * (2026-11-13 실측: 물가 49~102m는 로드뷰에 물이 보였고 166m 이상은 숲·건물에 가렸다).
 */
const WATER_FILE = join(process.cwd(), "src/lib/data/water-edge-points.json");
const WCELL = 0.002; // ~220m 격자
let waterGrid: Map<number, [number, number, number][]> | null = null;
function loadWaterGrid(): Map<number, [number, number, number][]> {
  if (waterGrid) return waterGrid;
  waterGrid = new Map();
  try {
    const arr = JSON.parse(readFileSync(WATER_FILE, "utf8")) as [number, number, number][];
    for (const [lat, lng, kind] of arr) {
      const k = Math.floor(lat / WCELL) * 1_000_000 + Math.floor(lng / WCELL);
      const cell = waterGrid.get(k);
      if (cell) cell.push([lat, lng, kind]);
      else waterGrid.set(k, [[lat, lng, kind]]);
    }
  } catch {
    // 데이터 없으면 물가 지점 없이 동작
  }
  return waterGrid;
}

/** 가장 가까운 물가(경계점) — 거리·방위·종류(0 강, 1 호수·저수지). 반경 밖이면 null */
function nearestWater(p: LatLng): { d: number; brg: number; kind: number } | null {
  const g = loadWaterGrid();
  if (g.size === 0) return null;
  const ci = Math.floor(p.lat / WCELL);
  const cj = Math.floor(p.lng / WCELL);
  let best: { d: number; at: LatLng; kind: number } | null = null;
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      const cell = g.get(a * 1_000_000 + b);
      if (!cell) continue;
      for (const [lat, lng, kind] of cell) {
        const d = distanceM(p, { lat, lng });
        if (!best || d < best.d) best = { d, at: { lat, lng }, kind };
      }
    }
  }
  return best ? { d: best.d, brg: bearingDeg(p, best.at), kind: best.kind } : null;
}

/**
 * 다리 위인가 — 도로 왼쪽과 오른쪽 모두 가까이(150m)에 물가가 있으면 물을 건너는 중이다.
 * 다리는 물가 거리가 가장 짧아 맨 먼저 뽑혔고, 로드뷰엔 난간·차선만 보였다(2026-11-13 실측).
 */
function overWater(p: LatLng, roadBrg: number): boolean {
  const g = loadWaterGrid();
  if (g.size === 0) return false;
  const ci = Math.floor(p.lat / WCELL);
  const cj = Math.floor(p.lng / WCELL);
  let left = false;
  let right = false;
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      for (const [lat, lng] of g.get(a * 1_000_000 + b) ?? []) {
        const q = { lat, lng };
        if (distanceM(p, q) > 150) continue;
        const rel = (bearingDeg(p, q) - roadBrg + 360) % 360;
        if (rel > 30 && rel < 150) right = true;
        else if (rel > 210 && rel < 330) left = true;
        if (left && right) return true;
      }
    }
  }
  return false;
}

/**
 * 물 쪽 방향 — 300m 안 물가점을 도로 왼쪽·오른쪽으로 나눠 더 많은 쪽(큰 물)의 평균 방위.
 * 가장 가까운 점 하나만 보면 반대편 작은 수로·웅덩이를 봤다(2026-11-13 실측).
 */
function waterSidePan(p: LatLng, roadBrg: number): number | undefined {
  const g = loadWaterGrid();
  const ci = Math.floor(p.lat / WCELL);
  const cj = Math.floor(p.lng / WCELL);
  const side = { left: [0, 0, 0], right: [0, 0, 0] }; // [개수, sin합, cos합]
  for (let a = ci - 2; a <= ci + 2; a++) {
    for (let b = cj - 2; b <= cj + 2; b++) {
      for (const [lat, lng] of g.get(a * 1_000_000 + b) ?? []) {
        const q = { lat, lng };
        if (distanceM(p, q) > 300) continue;
        const brg = bearingDeg(p, q);
        const rel = (brg - roadBrg + 360) % 360;
        const s = rel > 0 && rel < 180 ? side.right : rel > 180 ? side.left : null;
        if (!s) continue;
        s[0]++;
        s[1] += Math.sin((brg * Math.PI) / 180);
        s[2] += Math.cos((brg * Math.PI) / 180);
      }
    }
  }
  const s = side.left[0] >= side.right[0] ? side.left : side.right;
  if (s[0] === 0) return undefined;
  return ((Math.atan2(s[1], s[2]) * 180) / Math.PI + 360) % 360;
}

/** 로드뷰에 물이 실제로 보이는 도로-물가 거리 상한 (위 실측 근거) */
const WATER_VISIBLE_M = 120;

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

/** 경로를 ~stepM 간격으로 샘플 (인덱스 유지용으로 좌표만) */
function samplePts(path: LatLng[], stepM: number): LatLng[] {
  const out: LatLng[] = [];
  let acc = stepM;
  for (let i = 0; i < path.length; i++) {
    if (i > 0) acc += distanceM(path[i - 1], path[i]);
    if (acc >= stepM || i === 0) {
      acc = 0;
      out.push(path[i]);
    }
  }
  return out;
}

interface Scored extends PhotoSpot {
  score: number;
}

/** 스타일 무관 후보 수집 — 종류별로 뽑고 스타일이 우선순위를 정한다 */
function collect(path: LatLng[]): Record<"coast" | "river" | "winding", Scored[]> {
  const pts = samplePts(path, STEP_M);

  //    벽·먼바다·나무 가림이 없다 (유저: "바다가 너무 멀리 보이고 벽에 막힘").
  //    d 오름차순으로 훑으며 3km 간격으로 뽑는다.
  const allShore = getPrefetchedPoints().filter((c) => c.d <= 250);
  const coastCand: { i: number; d: number; shore: LatLng }[] = [];
  for (let i = 0; i < pts.length; i++) {
    // 성긴 사전 필터(위도 ~0.005 ≈ 550m) 후 정밀 거리, 최근접 해안 정점
    let best = Infinity;
    let bestShore: LatLng | null = null;
    for (const c of allShore) {
      if (
        Math.abs(c.lat - pts[i].lat) < 0.005 &&
        Math.abs(c.lng - pts[i].lng) < 0.007 &&
        distanceM(pts[i], c) < 100 &&
        c.d < best
      ) {
        best = c.d;
        bestShore = { lat: c.lat, lng: c.lng };
      }
    }
    if (best < Infinity && bestShore && !badSpot(pts[i]))
      coastCand.push({ i, d: best, shore: bestShore });
  }
  coastCand.sort((a, b) => a.d - b.d);
  const coast: Scored[] = [];
  for (const cand of coastCand) {
    const i = cand.i;
    if (coast.every((q) => distanceM(q.coord, pts[i]) > DIVERSITY_M)) {
      coast.push({
        name: "바닷가 구간",
        coord: pts[i],
        // 최근접 해안 정점을 정확히 바라본다 (좌우 추정보다 정확 — 바다를 봄)
        pan: bearingDeg(pts[i], cand.shore),
        score: 100,
      });
    }
    if (coast.length >= 3) break;
  }

  // 강변: 강변길 재고(고속도로·시내 제외된 강변 도로) 위이면서 물가가 정말 바로 옆(120m 안)이고
  // 다리 위가 아닌 지점만, 물가에 가까운 순으로. 방향은 가장 가까운 물가를 정확히 바라본다
  // (예전 좌우 추정은 식당·주차장을 봤고, 재고만 쓰면 숲 너머 강을 골랐다 — 2026-11-13 실측).
  const riverSegPts: LatLng[] = [];
  for (const seg of allRiversideSegments())
    for (let k = 0; k < seg.pts.length; k += 3)
      riverSegPts.push({ lat: seg.pts[k][0], lng: seg.pts[k][1] });
  const fine = samplePts(path, 200);
  const waterCand: { p: LatLng; d: number; brg: number; kind: number }[] = [];
  for (let i = 0; i < fine.length; i++) {
    const p = fine[i];
    // 80m — 200m로 잡으면 강 건너편 대로(방음벽·트럭)가 강변길로 매칭된다
    const onRiverside = riverSegPts.some(
      (c) =>
        Math.abs(c.lat - p.lat) < 0.003 &&
        Math.abs(c.lng - p.lng) < 0.004 &&
        distanceM(p, c) < 80,
    );
    if (!onRiverside) continue;
    const w = nearestWater(p);
    if (!w || w.d > WATER_VISIBLE_M || badSpot(p)) continue;
    const brg = bearingDeg(fine[Math.max(0, i - 1)], fine[Math.min(fine.length - 1, i + 1)]);
    if (overWater(p, brg)) continue;
    waterCand.push({ p, ...w, brg: waterSidePan(p, brg) ?? w.brg });
  }
  waterCand.sort((a, b) => a.d - b.d);
  const river: Scored[] = [];
  for (const c of waterCand) {
    if (river.every((q) => distanceM(q.coord, c.p) > DIVERSITY_M)) {
      river.push({
        name: "강변 구간",
        coord: c.p,
        pan: c.brg,
        score: 90,
      });
    }
    if (river.length >= 3) break;
  }

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
    const water = [
      ...(styles.includes("해안도로") ? c.coast : []),
      ...(styles.includes("강변도로") ? c.river : []),
      ...c.coast,
      ...c.river,
    ];
    const outW: PhotoSpot[] = [];
    for (const p of water) {
      if (outW.every((q) => distanceM(q.coord, p.coord) > DIVERSITY_M))
        outW.push({ name: p.name, coord: p.coord, pan: p.pan });
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
      out.push({ name: p.name, coord: p.coord, pan: p.pan });
    if (out.length >= 2) break;
  }
  // 볼 풍경이 없으면 빈 배열 — 코스 아무 지점(도로·절개지)을 채워 넣지 않는다(2026-11-13).
  return out;
}
