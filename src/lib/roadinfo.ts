import "server-only";

import { readFileSync, statSync, mkdirSync } from "node:fs";

import { writeFileAtomic } from "@/lib/atomic-write";
import { join } from "node:path";

import { badgeStats } from "@/lib/badges";
import { junctionCountNear } from "@/lib/localroute";
import { curveMetrics, distanceM } from "@/lib/scoring/curvature";
import type { LatLng } from "@/lib/types";

/**
 * "이름 있는 도로" 조회 — 지도에서 도로를 클릭하면 그 도로 전체(영동고속도로면
 * 인천~강릉)를 하이라이트하고 특성·평점을 보여주는 기능의 서버 쪽.
 * 데이터: scripts/build-road-names-from-osm.mjs – named-roads.json
 * (이름+공간 클러스터링 완료 — 전국의 동명 "중앙로"는 별개 도로).
 */

interface NamedRoad {
  n: string;
  c: string;
  l: [number, number][][];
}

export interface RoadInfo {
  key: string;
  name: string;
  cls: string;
  clsLabel: string;
  lengthM: number;

  distM: number;
  lines: LatLng[][];
  stats: {
    degPerKm: number;
    hairpins: number;
    signalFreeM: number;
    coastM: number;
    maxEleM: number | null;
    camFixed: number;
    camSection: number;
    /** 교차로 인접 표본 비율 0~1 — 도심 관통 정도 */
    urbanRatio: number;
  };
  rating: { avg: number | null; count: number };
}

const ROADS_FILE = join(process.cwd(), "src/lib/data/named-roads.json");
const RATINGS_FILE = join(process.cwd(), "data/road-ratings.json");

const CLS_LABEL: Record<string, string> = {
  motorway: "고속도로",
  trunk: "자동차전용·간선",
  primary: "국도급",
  secondary: "지방도급",
  tertiary: "군도·시내 간선",
  unclassified: "로컬 도로",
};

const CELL = 0.005; // ~550m
const ckey = (lat: number, lng: number) =>
  Math.floor(lat / CELL) * 100000 + Math.floor(lng / CELL) + 2_000_000_000;

let roads: NamedRoad[] | null = null;
let grid: Map<number, number[]> | null = null;

function load(): { roads: NamedRoad[]; grid: Map<number, number[]> } {
  if (roads && grid) return { roads, grid };
  roads = JSON.parse(readFileSync(ROADS_FILE, "utf8")) as NamedRoad[];
  grid = new Map();
  const put = (lat: number, lng: number, ri: number) => {
    const k = ckey(lat, lng);
    const cell = grid!.get(k);
    if (!cell) grid!.set(k, [ri]);
    else if (cell[cell.length - 1] !== ri) cell.push(ri);
  };
  for (let ri = 0; ri < roads.length; ri++) {
    for (const line of roads[ri].l) {
      for (let i = 0; i < line.length; i++) {
        put(line[i][0], line[i][1], ri);
        // 단순화로 세그먼트가 길 수 있어 ~400m 간격으로 중간도 등록
        if (i > 0) {
          const d = distanceM(
            { lat: line[i - 1][0], lng: line[i - 1][1] },
            { lat: line[i][0], lng: line[i][1] },
          );
          const n = Math.floor(d / 400);
          for (let k = 1; k <= n; k++) {
            put(
              line[i - 1][0] + ((line[i][0] - line[i - 1][0]) * k) / (n + 1),
              line[i - 1][1] + ((line[i][1] - line[i - 1][1]) * k) / (n + 1),
              ri,
            );
          }
        }
      }
    }
  }
  return { roads, grid };
}

function segDist(p: LatLng, a: [number, number], b: [number, number]): number {
  const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
  const ax = (a[1] - p.lng) * kx, ay = (a[0] - p.lat) * 111_320;
  const bx = (b[1] - p.lng) * kx, by = (b[0] - p.lat) * 111_320;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

function roadKey(r: NamedRoad): string {
  // 이름 + 대략적 중심 — 재빌드에도 안정적인 키
  let sLat = 0, sLng = 0, n = 0;
  for (const line of r.l) for (const p of line) { sLat += p[0]; sLng += p[1]; n++; }
  return `${r.n}|${(sLat / n).toFixed(1)},${(sLng / n).toFixed(1)}`;
}

interface Ratings { [key: string]: { sum: number; count: number } }
function loadRatings(): Ratings {
  try { return JSON.parse(readFileSync(RATINGS_FILE, "utf8")); } catch { return {}; }
}
export function addRating(key: string, stars: number, prev?: number): { avg: number; count: number } {
  const r = loadRatings();
  if (!r[key]) r[key] = { sum: 0, count: 0 };
  if (prev && prev >= 1 && prev <= 5 && r[key].count > 0) {
    r[key].sum += stars - prev; // 재평가 — 개수 유지
  } else {
    r[key].sum += stars;
    r[key].count++;
  }
  // 불변식: 평균은 1~5. 무인증 엔드포인트라 클라가 위조한 prev로 sum이 범위를
  // 벗어나(평균 47 같은) 표시되는 걸 막는다(정상 재평가는 이 범위 안이라 무영향).
  r[key].sum = Math.max(r[key].count, Math.min(r[key].count * 5, r[key].sum));
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileAtomic(RATINGS_FILE, JSON.stringify(r, null, 1));
  return { avg: r[key].sum / r[key].count, count: r[key].count };
}

/** 좌표에서 가장 가까운 이름 있는 도로 — maxDistM 안에 없으면 null */
export function roadAtPoint(p: LatLng, maxDistM = 120): RoadInfo | null {
  const { roads, grid } = load();
  const ci = Math.floor(p.lat / CELL);
  const cj = Math.floor(p.lng / CELL);
  const cand = new Set<number>();
  for (let a = ci - 1; a <= ci + 1; a++)
    for (let b = cj - 1; b <= cj + 1; b++)
      for (const ri of grid.get(a * 100000 + b + 2_000_000_000) ?? []) cand.add(ri);
  let best: { ri: number; d: number } | null = null;
  for (const ri of cand) {
    for (const line of roads[ri].l) {
      for (let i = 1; i < line.length; i++) {
        // 성긴 사전 필터 — 양끝 다 3km 밖이면 스킵
        if (
          Math.abs(line[i][0] - p.lat) > 0.03 &&
          Math.abs(line[i - 1][0] - p.lat) > 0.03
        )
          continue;
        const d = segDist(p, line[i - 1], line[i]);
        if (!best || d < best.d) best = { ri, d };
      }
    }
  }
  if (!best || best.d > maxDistM) return null;

  const r = roads[best.ri];
  // 길이 — 고속도로·간선은 상/하행이 별도 way라 합산이 2배로 잡힌다.
  // 왕복 분리 도로는 절반을 "연장"으로 보고한다 (영동고속 480–240km ≈ 실제 234).
  const lineLen = (line: [number, number][]) => {
    let lm = 0;
    for (let i = 1; i < line.length; i++)
      lm += distanceM(
        { lat: line[i - 1][0], lng: line[i - 1][1] },
        { lat: line[i][0], lng: line[i][1] },
      );
    return lm;
  };
  const lens = r.l.map(lineLen);
  const totalM = lens.reduce((a, b) => a + b, 0);
  const dual = r.c === "motorway" || r.c === "trunk";
  const lengthM = dual ? totalM / 2 : totalM;

  // 특성 — 조각(왕복 분리·구간 단절)이 많아 한 라인만 보면 왜곡된다.
  // 긴 라인부터 누적 60% 또는 20개까지 각각 계산해 집계한다.
  const order = r.l.map((_, i) => i).sort((a, b) => lens[b] - lens[a]);
  const statLines: LatLng[][] = [];
  let acc = 0;
  for (const i of order) {
    if (r.l[i].length < 3) continue;
    statLines.push(r.l[i].map(([lat, lng]) => ({ lat, lng })));
    acc += lens[i];
    if (acc >= totalM * 0.6 || statLines.length >= 20) break;
  }
  let hairpins = 0, coastM = 0, camFixed = 0, camSection = 0;
  let signalFreeM = 0;
  let maxEleM: number | null = null;
  let degSum = 0, degLen = 0;
  let hits = 0, samples = 0;
  for (const path of statLines) {
    const st = badgeStats(path);
    hairpins += st.hairpins;
    coastM += st.coastM;
    camFixed += st.camFixed;
    camSection += st.camSection;
    if (st.signalFreeQuantM > signalFreeM) signalFreeM = st.signalFreeQuantM;
    if (st.maxEleM !== null && (maxEleM === null || st.maxEleM > maxEleM))
      maxEleM = st.maxEleM;
    const lm = st.totalM;
    degSum += curveMetrics(path).degPerKm * lm;
    degLen += lm;
    // 교차로 인접 표본 — 도심 관통 정도
    for (let i = 0; i < path.length; i += Math.max(1, Math.floor(path.length / 30))) {
      samples++;
      if (junctionCountNear(path[i], 120) >= 1) hits++;
    }
  }
  // 왕복 분리 도로는 양방향을 다 세니 개수형 지표도 절반으로
  if (dual) {
    hairpins = Math.round(hairpins / 2);
    coastM = Math.round(coastM / 2);
    camFixed = Math.round(camFixed / 2);
    camSection = Math.round(camSection / 2);
  }
  const key = roadKey(r);
  const rating = loadRatings()[key];

  return {
    key,
    name: r.n,
    cls: r.c,
    clsLabel: CLS_LABEL[r.c] ?? r.c,
    lengthM: Math.round(lengthM),
    distM: Math.round(best.d),
    lines: r.l.map((line) => line.map(([lat, lng]) => ({ lat, lng }))),
    stats: {
      degPerKm: degLen > 0 ? Math.round(degSum / degLen) : 0,
      hairpins,
      signalFreeM,
      coastM,
      maxEleM,
      camFixed,
      camSection,
      urbanRatio: samples ? Number((hits / samples).toFixed(2)) : 0,
    },
    rating: rating
      ? { avg: Number((rating.sum / rating.count).toFixed(2)), count: rating.count }
      : { avg: null, count: 0 },
  };
}
