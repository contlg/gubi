import "server-only";

import { getPrefetchedPoints } from "@/lib/osm";
import { distanceM } from "@/lib/scoring/curvature";
import type { LatLng } from "@/lib/types";

/**
 * 바다쪽 선호 가중치. 해안선에서 먼(안쪽) 도로일수록 비용을 키워, 최단경로가
 * '가장 바다쪽 해안도로'를 타게 한다. dcoast 998(미상)은 중립(75)으로 본다.
 */
const SEAWARD_ALPHA = 2.5;
const seawardMul = (di: number, dj: number) => {
  const a = di >= 998 ? 75 : di;
  const b = dj >= 998 ? 75 : dj;
  return 1 + (SEAWARD_ALPHA * ((a + b) / 2)) / 150;
};

/**
 * 해안 관통선(coastal spine) 추출.
 *
 * 프리페치된 해안도로 정점들로 근접 그래프(kNN)를 만들고, 그 중 **가장 큰
 * 연결 컴포넌트(=본류 해안선)** 안에서 출발/도착에 가장 가까운 점을 잡아
 * 최단경로(Dijkstra)를 구한다. 이 경로가 곧 '해안을 따라 이어지는 관통도로'다.
 *  - 항만 둘레 도로는 루프라 최단경로가 짧은 쪽(관통)만 타고 안 감는다.
 *  - 막다른 지선(해변 진입로·부두)은 관통경로에 없어 자연히 빠진다.
 *  - 그래프에 해안도로만 있으니(7번국도는 해안선 150m 밖이라 미수록) 내륙으로
 *    새지 않는다.
 * 데이터가 부족하거나 본류가 OD를 못 덮으면 빈 배열 – 호출부가 폴백한다.
 */

class MinHeap {
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
        let m = p;
        if (l < d.length && d[l] < d[m]) m = l;
        if (r < d.length && d[r] < d[m]) m = r;
        if (m === p) break;
        [d[p], d[m]] = [d[m], d[p]];
        [it[p], it[m]] = [it[m], it[p]];
        p = m;
      }
    }
    return top;
  }
}

const CELL = 0.003; // ~330m 격자
const KNN = 8; // 정점당 이웃 수
const WIN = 6; // 이웃 탐색 격자 반경(≈2km) — 이 안의 작은 끊김은 kNN이 이어줌
const MAX_ENTRY_M = 15_000; // 본류 해안선이 출발/도착에서 이보다 멀면 해안 OD 아님

export function coastalSpine(
  origin: LatLng,
  destination: LatLng,
  /**
   * 본류 해안선이 출발/도착에서 이보다 멀면 "해안 OD 아님"으로 포기.
   * 목적지형은 기본 15km(내륙 OD에 해안 우회를 강요하지 않음), 순환형은
   * 출발지가 내륙이어도 일부러 바다로 나가는 코스라 크게 허용한다.
   */
  maxEntryM = MAX_ENTRY_M,
): LatLng[] {
  const all = getPrefetchedPoints();
  if (all.length < 5) return [];

  // OD 주변 지역으로 한정(여유 0.15°)
  const s = Math.min(origin.lat, destination.lat) - 0.15;
  const n = Math.max(origin.lat, destination.lat) + 0.15;
  const w = Math.min(origin.lng, destination.lng) - 0.15;
  const e = Math.max(origin.lng, destination.lng) + 0.15;
  const pts = all.filter(
    (p) => p.lat >= s && p.lat <= n && p.lng >= w && p.lng <= e,
  );
  if (pts.length < 20) return [];

  // 격자 색인
  const grid = new Map<string, number[]>();
  const gk = (la: number, ln: number) =>
    `${Math.floor(la / CELL)},${Math.floor(ln / CELL)}`;
  pts.forEach((p, i) => {
    const k = gk(p.lat, p.lng);
    let arr = grid.get(k);
    if (!arr) {
      arr = [];
      grid.set(k, arr);
    }
    arr.push(i);
  });

  // kNN 인접 리스트 (가까운 정점 K개 = 도로를 따라가는 간선)
  const adj: { to: number; w: number }[][] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const ci = Math.floor(p.lat / CELL);
    const cj = Math.floor(p.lng / CELL);
    const cand: number[] = [];
    for (let a = ci - WIN; a <= ci + WIN; a++) {
      for (let b = cj - WIN; b <= cj + WIN; b++) {
        const arr = grid.get(`${a},${b}`);
        if (arr) for (const j of arr) if (j !== i) cand.push(j);
      }
    }
    // kNN은 기하 거리로 고르고(연결성), Dijkstra 비용은 바다쪽 선호로 가중
    const ds = cand
      .map((j) => ({ to: j, g: distanceM(p, pts[j]) }))
      .sort((x, y) => x.g - y.g)
      .slice(0, KNN)
      .map(({ to, g }) => ({ to, w: g * seawardMul(pts[i].d, pts[to].d) }));
    adj.push(ds);
  }

  // 무향화: kNN은 비대칭(i의 이웃에 j가 있어도 j의 이웃에 i가 없을 수 있다).
  // 그대로 두면 union-find는 연결됐다는데 Dijkstra는 유향 간선을 못 넘어
  // 안 닿는 버그가 난다. 역방향 간선을 채워 무향 그래프로 만든다.
  for (let i = 0; i < pts.length; i++) {
    for (const { to, w } of adj[i]) {
      if (!adj[to].some((e) => e.to === i)) adj[to].push({ to: i, w });
    }
  }

  // 연결 컴포넌트(union-find)
  const parent = new Int32Array(pts.length);
  for (let i = 0; i < pts.length; i++) parent[i] = i;
  const find = (x: number): number => {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]];
      x = parent[x];
    }
    return x;
  };
  const union = (a: number, b: number): boolean => {
    const ra = find(a),
      rb = find(b);
    if (ra === rb) return false;
    parent[ra] = rb;
    return true;
  };
  for (let i = 0; i < pts.length; i++)
    for (const { to } of adj[i]) union(i, to);

  // 끊긴 조각 잇기(bridging): 각 점의 '다른 컴포넌트 최근접(≤12km)' 후보를
  // 모아 Kruskal로 최소 다리만 추가한다. 만(灣)은 도로가 감아 돌아 같은
  // 컴포넌트라 안 건드리고, 진짜 gap(터널·산단·데이터 구멍)만 이어진다.
  const cands: { i: number; j: number; d: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const ci = Math.floor(p.lat / CELL);
    const cj = Math.floor(p.lng / CELL);
    const ri = find(i);
    let bj = -1,
      bd = Infinity;
    for (let r = WIN + 1; r <= 32; r++) {
      for (let a = ci - r; a <= ci + r; a++) {
        for (let b = cj - r; b <= cj + r; b++) {
          if (Math.max(Math.abs(a - ci), Math.abs(b - cj)) !== r) continue;
          const arr = grid.get(`${a},${b}`);
          if (!arr) continue;
          for (const j of arr) {
            if (find(j) === ri) continue;
            const d = distanceM(p, pts[j]);
            if (d < bd) {
              bd = d;
              bj = j;
            }
          }
        }
      }
      if (bj >= 0 && bd < r * CELL * 111000 * 0.8) break;
    }
    if (bj >= 0 && bd <= 12000) cands.push({ i, j: bj, d: bd });
  }
  cands.sort((a, b) => a.d - b.d);
  for (const c of cands) {
    if (union(c.i, c.j)) {
      const w = c.d * seawardMul(pts[c.i].d, pts[c.j].d);
      adj[c.i].push({ to: c.j, w });
      adj[c.j].push({ to: c.i, w });
    }
  }

  // 진입점 선택. '출발지 최근접'만 쓰면 목적지 반대편(강릉역–북쪽 송정)으로
  // 들어갔다 되돌아온다. 그렇다고 origin–p–dest 합 최소로 하면 직선상 먼 점을
  // 골라버린다(30km). 그래서 **출발지 근처(≤8km) 중 목적지에 가장 가까운 점**
  // = 전진쪽 진입부를 고른다. 근처에 없으면 최근접으로 폴백.
  const ENTRY_RADIUS = 8000;
  let sIdx = -1,
    sFwd = Infinity,
    sD = Infinity,
    sNear = -1,
    sNearD = Infinity,
    eIdx = -1,
    eD = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const dO = distanceM(pts[i], origin);
    const dE = distanceM(pts[i], destination);
    if (dO <= ENTRY_RADIUS && dE < sFwd) {
      sFwd = dE;
      sIdx = i;
      sD = dO;
    }
    if (dO < sNearD) {
      sNearD = dO;
      sNear = i;
    }
    if (dE < eD) {
      eD = dE;
      eIdx = i;
    }
  }
  if (sIdx < 0) {
    sIdx = sNear;
    sD = sNearD;
  }
  if (sIdx < 0 || eIdx < 0 || sIdx === eIdx) return [];
  // 진입(출발지쪽)은 maxEntryM까지 허용(순환형은 내륙에서 바다로 나감),
  // 회차(목적지쪽)는 해안 정점이라 항상 가깝다 — 기본 상한 유지.
  if (sD > maxEntryM || eD > MAX_ENTRY_M) return [];
  if (find(sIdx) !== find(eIdx)) return []; // 다리로도 못 이으면 폴백

  const dist = new Float64Array(pts.length).fill(Infinity);
  const prev = new Int32Array(pts.length).fill(-1);
  dist[sIdx] = 0;
  const heap = new MinHeap();
  heap.push(0, sIdx);
  while (heap.size) {
    const { dist: d, idx: i } = heap.pop();
    if (d > dist[i]) continue;
    if (i === eIdx) break;
    for (const { to, w } of adj[i]) {
      const nd = d + w;
      if (nd < dist[to]) {
        dist[to] = nd;
        prev[to] = i;
        heap.push(nd, to);
      }
    }
  }
  if (!Number.isFinite(dist[eIdx])) return [];

  const path: LatLng[] = [];
  for (let i = eIdx; i !== -1; i = prev[i]) path.push(pts[i]);
  path.reverse();
  return path;
}
