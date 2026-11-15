import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { LatLng } from "@/lib/types";

/**
 * 좌표 – 도로 이름만 가볍게 조회.
 *
 * roadinfo.roadAtPoint는 길이·헤어핀·단속캠 같은 통계까지 계산해 무겁고,
 * roadinfo가 localroute를 import하므로 localroute에서 쓰면 순환이 된다.
 * 그래서 **이름 조회만** 하는 독립 모듈로 분리했다(같은 named-roads.json 사용).
 *
 * 용도: 자유주행 도로추종(roadAhead)이 Y분기에서 어느 쪽이 본선인지 고를 때,
 * "도로 이름이 이어지는 쪽이 본선"이라는 실내비 관례를 적용한다. 각도만으로는
 * 같은 등급 Y분기를 못 가른다.
 */
interface NamedRoad {
  n: string;
  c: string;
  l: [number, number][][];
}

const ROADS_FILE = join(
  process.cwd(),
  "src/lib/data/named-roads.json",
);
const CELL = 0.005; // ~550m
const ckey = (lat: number, lng: number) =>
  Math.floor(lat / CELL) * 100000 + Math.floor(lng / CELL) + 2_000_000_000;

let roads: NamedRoad[] | null = null;
let grid: Map<number, number[]> | null = null;

function dM(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * kx);
}

function load(): { roads: NamedRoad[]; grid: Map<number, number[]> } | null {
  if (roads && grid) return { roads, grid };
  try {
    roads = JSON.parse(readFileSync(ROADS_FILE, "utf8")) as NamedRoad[];
  } catch {
    return null; // 데이터 없으면 이름 판정 없이 동작(호출부가 폴백)
  }
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
          const d = dM(
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
  const ax = (a[1] - p.lng) * kx;
  const ay = (a[0] - p.lat) * 111_320;
  const bx = (b[1] - p.lng) * kx;
  const by = (b[0] - p.lat) * 111_320;
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + t * dx, ay + t * dy);
}

/** 좌표에서 가장 가까운 이름 있는 도로의 **이름만** — 없으면 null */
// 같은 점을 반복해 묻는 경우가 많다 — 자유주행 한 요청에서 현위치 도로명을 카메라
// 수만큼(도심 70~80번), 고정된 카메라 지점의 도로명은 모든 사용자 요청마다. 도로
// 자료는 프로세스 수명 동안 바뀌지 않으므로 결과를 그대로 재사용한다(상한 넘으면 비움).
const nameCache = new Map<string, string | null>();
const NAME_CACHE_MAX = 50_000;

export function roadNameAt(p: LatLng, maxDistM = 30): string | null {
  const key = `${p.lat},${p.lng},${maxDistM}`;
  const hit = nameCache.get(key);
  if (hit !== undefined) return hit;
  const name = roadNameAtUncached(p, maxDistM);
  if (nameCache.size >= NAME_CACHE_MAX) nameCache.clear();
  nameCache.set(key, name);
  return name;
}

function roadNameAtUncached(p: LatLng, maxDistM: number): string | null {
  const data = load();
  if (!data) return null;
  const ci = Math.floor(p.lat / CELL);
  const cj = Math.floor(p.lng / CELL);
  let bestName: string | null = null;
  let bestD = Infinity;
  for (let a = ci - 1; a <= ci + 1; a++) {
    for (let b = cj - 1; b <= cj + 1; b++) {
      for (const ri of data.grid.get(a * 100000 + b + 2_000_000_000) ?? []) {
        const r = data.roads[ri];
        for (const line of r.l) {
          for (let i = 1; i < line.length; i++) {
            // 성긴 사전 필터 — 양끝 다 멀면 스킵
            if (
              Math.abs(line[i][0] - p.lat) > 0.01 &&
              Math.abs(line[i - 1][0] - p.lat) > 0.01
            )
              continue;
            const d = segDist(p, line[i - 1], line[i]);
            if (d < bestD) {
              bestD = d;
              bestName = r.n;
            }
          }
        }
      }
    }
  }
  return bestD <= maxDistM ? bestName : null;
}
