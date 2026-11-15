// 부지 내 도로(진입로) 그래프로 출발·도착점과 본선 사이를 잇는다.
// 데이터: scripts/build-access-graph.mjs – src/lib/data/roadgraph/access-*.bin
//
// 리조트·관광지·단지 안에서 출발하면 본선 그래프엔 이어 줄 길이 없어 엉뚱한
// 도로(고속도로 램프 등)에 붙었다. 여기서는 끝점이 본선보다 진입로에 가까울 때만
// 진입로를 따라 본선과 만나는 관문까지 걸어 나간 경로를 돌려준다.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface LatLng { lat: number; lng: number }

interface AccessGraph {
  nodes: Float64Array;
  gate: Uint8Array;
  eA: Uint32Array; eB: Uint32Array; eOff: Uint32Array; eCnt: Uint32Array;
  len: Float32Array;
  geom: Float32Array;
  adjOff: Uint32Array; adjEdge: Uint32Array;
  grid: Map<number, number[]>;
}

const DIR = join(process.cwd(), "src/lib/data/roadgraph");
const CELL = 0.002;
/** 끝점에서 진입로까지 허용 거리(m). */
const ACCESS_SNAP_M = 150;
/** 진입로를 따라 관문을 찾는 최대 거리(m). */
const ACCESS_WALK_M = 3000;
const ACCESS_KMH = 15;
/** 관문 선택 시 남은 직선거리 환산 속도 — 목적지 쪽 출구를 고르게 한다. */
const REST_KMH = 50;
/** 고속도로·램프 관문 가산(초) — 휴게소처럼 그것밖에 없을 때만 쓰게. */
const MOTORWAY_GATE_S = 300;

const kx = (lat: number) => Math.cos((lat * Math.PI) / 180) * 111320;
const dM = (a: LatLng, b: LatLng) => Math.hypot((b.lng - a.lng) * kx(a.lat), (b.lat - a.lat) * 110540);
const cellKey = (lat: number, lng: number) => Math.floor(lat / CELL) * 1_000_000 + Math.floor(lng / CELL);

let graph: AccessGraph | null | undefined;
function load(): AccessGraph | null {
  if (graph !== undefined) return graph;
  try {
    const rb = (f: string) => {
      const b = readFileSync(join(DIR, f));
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    };
    const nodes = new Float64Array(rb("access-nodes.bin"));
    const e = new Uint32Array(rb("access-edges.bin"));
    const m = e.length / 4;
    const eA = e.subarray(0, m), eB = e.subarray(m, 2 * m), eOff = e.subarray(2 * m, 3 * m), eCnt = e.subarray(3 * m);
    const geom = new Float32Array(rb("access-geom.bin"));
    const n = nodes.length / 2;
    const deg = new Uint32Array(n + 1);
    for (let i = 0; i < m; i++) { deg[eA[i] + 1]++; deg[eB[i] + 1]++; }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    const adjEdge = new Uint32Array(deg[n]), cur = deg.slice(0, n);
    for (let i = 0; i < m; i++) { adjEdge[cur[eA[i]]++] = i; adjEdge[cur[eB[i]]++] = i; }
    const grid = new Map<number, number[]>();
    const put = (k: number, i: number) => {
      const a = grid.get(k);
      if (!a) grid.set(k, [i]); else if (a[a.length - 1] !== i) a.push(i);
    };
    for (let i = 0; i < m; i++) {
      put(cellKey(nodes[eA[i] * 2], nodes[eA[i] * 2 + 1]), i);
      for (let j = 0; j < eCnt[i]; j++) put(cellKey(geom[(eOff[i] + j) * 2], geom[(eOff[i] + j) * 2 + 1]), i);
      put(cellKey(nodes[eB[i] * 2], nodes[eB[i] * 2 + 1]), i);
    }
    graph = {
      nodes, gate: new Uint8Array(rb("access-gate.bin")), eA, eB, eOff, eCnt,
      len: new Float32Array(rb("access-len.bin")), geom, adjOff: deg, adjEdge, grid,
    };
  } catch {
    graph = null; // 사이드카가 없으면 진입로 연결 없이 기존 동작
  }
  return graph;
}

/** 간선 점열(eA–eB 순, 양 끝 포함) */
function edgePts(g: AccessGraph, e: number): LatLng[] {
  const pts: LatLng[] = [{ lat: g.nodes[g.eA[e] * 2], lng: g.nodes[g.eA[e] * 2 + 1] }];
  for (let j = 0; j < g.eCnt[e]; j++) pts.push({ lat: g.geom[(g.eOff[e] + j) * 2], lng: g.geom[(g.eOff[e] + j) * 2 + 1] });
  pts.push({ lat: g.nodes[g.eB[e] * 2], lng: g.nodes[g.eB[e] * 2 + 1] });
  return pts;
}

export interface AccessLeg {
  /** role=start: p–관문, role=end: 관문–p */
  path: LatLng[];
  gate: LatLng;
  distM: number;
  sec: number;
}

/**
 * p가 부지 안이면 진입로를 따라 본선 관문까지의 경로. mainM은 p에서 가장 가까운
 * 본선 간선까지 거리, mainMotorway는 그 간선이 고속도로·램프인지. 진입로가 본선보다
 * 확실히 가깝거나(10m+) 본선 최근접이 고속도로일 때만 쓴다.
 */
export function accessLeg(
  p: LatLng,
  role: "start" | "end",
  other: LatLng,
  mainM: number,
  mainMotorway: boolean,
): AccessLeg | null {
  const g = load();
  if (!g) return null;
  // 최근접 진입로 간선과 투영점
  let bestD = Infinity, bestE = -1, bestSeg = 0, bestT = 0;
  const ci = Math.floor(p.lat / CELL), cj = Math.floor(p.lng / CELL);
  const seen = new Set<number>();
  for (let a = ci - 1; a <= ci + 1; a++) for (let b = cj - 1; b <= cj + 1; b++) {
    for (const e of g.grid.get(a * 1_000_000 + b) ?? []) {
      if (seen.has(e)) continue;
      seen.add(e);
      const pts = edgePts(g, e), mx = kx(p.lat);
      for (let i = 1; i < pts.length; i++) {
        const dx = (pts[i].lng - pts[i - 1].lng) * mx, dy = (pts[i].lat - pts[i - 1].lat) * 110540;
        const px = (p.lng - pts[i - 1].lng) * mx, py = (p.lat - pts[i - 1].lat) * 110540, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, (px * dx + py * dy) / L)) : 0;
        const d = Math.hypot(px - t * dx, py - t * dy);
        if (d < bestD) { bestD = d; bestE = e; bestSeg = i - 1; bestT = t; }
      }
    }
  }
  if (bestE < 0 || bestD > ACCESS_SNAP_M) return null;
  if (!(bestD + 10 < mainM || (mainMotorway && mainM > 25))) return null;

  // 투영점에서 양 끝 노드로 시작하는 다익스트라(무방향, 짧은 거리라 단순 배열 큐)
  const pts = edgePts(g, bestE);
  const proj = {
    lat: pts[bestSeg].lat + (pts[bestSeg + 1].lat - pts[bestSeg].lat) * bestT,
    lng: pts[bestSeg].lng + (pts[bestSeg + 1].lng - pts[bestSeg].lng) * bestT,
  };
  let toA = 0;
  for (let i = 1; i <= bestSeg; i++) toA += dM(pts[i - 1], pts[i]);
  toA += dM(pts[bestSeg], proj);
  const toB = Math.max(0, g.len[bestE] - toA);
  const dist = new Map<number, number>(), prevEdge = new Map<number, number>();
  const open: [number, number][] = [[toA, g.eA[bestE]], [toB, g.eB[bestE]]];
  dist.set(g.eA[bestE], toA); dist.set(g.eB[bestE], toB);
  prevEdge.set(g.eA[bestE], -1); prevEdge.set(g.eB[bestE], -1);
  const gates: number[] = [];
  while (open.length) {
    let k = 0;
    for (let i = 1; i < open.length; i++) if (open[i][0] < open[k][0]) k = i;
    const [d, u] = open.splice(k, 1)[0];
    if (d > (dist.get(u) ?? Infinity) || d > ACCESS_WALK_M) continue;
    if (g.gate[u] !== 255) { gates.push(u); continue; } // 관문에서 본선으로 넘어간다
    for (let q = g.adjOff[u]; q < g.adjOff[u + 1]; q++) {
      const e = g.adjEdge[q], v = g.eA[e] === u ? g.eB[e] : g.eA[e];
      const nd = d + g.len[e];
      if (nd < (dist.get(v) ?? Infinity)) { dist.set(v, nd); prevEdge.set(v, e); open.push([nd, v]); }
    }
  }
  if (!gates.length) return null;
  const nodeLL = (i: number) => ({ lat: g.nodes[i * 2], lng: g.nodes[i * 2 + 1] });
  const score = (u: number) =>
    dist.get(u)! / (ACCESS_KMH / 3.6) + dM(nodeLL(u), other) / (REST_KMH / 3.6) +
    (g.gate[u] <= 1 ? MOTORWAY_GATE_S : 0);
  const gateNode = gates.reduce((a, b) => (score(b) < score(a) ? b : a));

  // 관문 – 투영점으로 거슬러 올라가며 경로 복원
  const back: LatLng[] = [nodeLL(gateNode)];
  let u = gateNode;
  for (let e = prevEdge.get(u)!; e >= 0; e = prevEdge.get(u)!) {
    const ep = edgePts(g, e);
    const seq = g.eB[e] === u ? ep.slice(0, -1).reverse() : ep.slice(1);
    back.push(...seq);
    u = g.eA[e] === u ? g.eB[e] : g.eA[e];
  }
  // u는 시작 간선의 끝 노드 — 투영점까지 그 간선 일부를 붙인다
  const startSide = u === g.eA[bestE] ? pts.slice(1, bestSeg + 1) : pts.slice(bestSeg + 1, -1).reverse();
  back.push(...startSide, proj, p);
  const forward = back.reverse(); // p – 관문
  const distM = dist.get(gateNode)! + bestD;
  return {
    path: role === "start" ? forward : forward.slice().reverse(),
    gate: nodeLL(gateNode),
    distM,
    sec: distM / (ACCESS_KMH / 3.6),
  };
}
