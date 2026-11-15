import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { decodePolyline } from "@/lib/polyline";
import type { LatLng } from "@/lib/types";

/**
 * 행정동(읍면동) 경계 — 주행 궤적이 지나간 동을 point-in-polygon으로 판정해
 * "정복한 동" 폴리곤을 반환한다(지도에 반투명 칠용). 전부 로컬 데이터라 카카오
 * 호출 없음. scripts/build-admdong.mjs 산출물.
 */

interface Meta {
  version: number;
  cellDeg: number;
  dongs: number;
  points: number;
  gridCells: number;
}

interface Index {
  meta: Meta;
  names: { id: string; name: string }[];
  geom: Float32Array;
  ringIndex: Uint32Array;
  dongIndex: Uint32Array;
  gridKeys: Int32Array;
  gridOffsets: Uint32Array;
  gridDongs: Uint32Array;
}

const DIR = join(process.cwd(), "src/lib/data/admdong");
let index: Index | null | undefined;

function bytes(path: string): ArrayBuffer {
  const b = readFileSync(path);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function load(): Index | null {
  if (index !== undefined) return index;
  try {
    const meta = JSON.parse(readFileSync(join(DIR, "meta.json"), "utf8")) as Meta;
    if (meta.version !== 1) throw new Error(`지원하지 않는 버전 ${meta.version}`);
    index = {
      meta,
      names: JSON.parse(readFileSync(join(DIR, "dongs.json"), "utf8")),
      geom: new Float32Array(bytes(join(DIR, "geom.bin"))),
      ringIndex: new Uint32Array(bytes(join(DIR, "ring-index.bin"))),
      dongIndex: new Uint32Array(bytes(join(DIR, "dong-index.bin"))),
      gridKeys: new Int32Array(bytes(join(DIR, "grid-keys.bin"))),
      gridOffsets: new Uint32Array(bytes(join(DIR, "grid-offsets.bin"))),
      gridDongs: new Uint32Array(bytes(join(DIR, "grid-dongs.bin"))),
    };
  } catch (error) {
    console.error("[admdong] 인덱스 로딩 실패:", error);
    index = null;
  }
  return index;
}

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

/** 동의 모든 링에 대한 even-odd 광선교차(홀/멀티폴리곤 포함). */
function pointInDong(idx: Index, lng: number, lat: number, dong: number): boolean {
  const fr = idx.dongIndex[dong * 2];
  const rc = idx.dongIndex[dong * 2 + 1];
  const g = idx.geom;
  let inside = false;
  for (let r = fr; r < fr + rc; r++) {
    const off = idx.ringIndex[r * 2];
    const cnt = idx.ringIndex[r * 2 + 1];
    let j = cnt - 1;
    for (let i = 0; i < cnt; i++) {
      const xi = g[(off + i) * 2];
      const yi = g[(off + i) * 2 + 1];
      const xj = g[(off + j) * 2];
      const yj = g[(off + j) * 2 + 1];
      if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
      j = i;
    }
  }
  return inside;
}

function dongAt(idx: Index, lng: number, lat: number): number {
  const cell = idx.meta.cellDeg;
  const key = Math.floor(lat / cell) * 100_000 + Math.floor(lng / cell);
  const ci = lowerBound(idx.gridKeys, key);
  if (ci >= idx.gridKeys.length || idx.gridKeys[ci] !== key) return -1;
  for (let p = idx.gridOffsets[ci]; p < idx.gridOffsets[ci + 1]; p++) {
    const d = idx.gridDongs[p];
    if (pointInDong(idx, lng, lat, d)) return d;
  }
  return -1;
}

export interface AdminDong {
  id: string;
  /** 시/도·시/군/구·읍/면/동을 합친 로컬 경계 데이터의 전체 이름 */
  name: string;
  sido: string;
  sigungu: string;
  dong: string;
}

const GWANGJU_DISTRICTS = new Set(["동구", "서구", "남구", "북구", "광산구"]);

/**
 * 좌표 한 점을 로컬 행정동 경계에 대입한다. 외부 지오코딩 API 호출은 없다.
 * 원천 경계의 광주·전남 통합 표기는 시/군/구를 기준으로 실제 시/도로 복원한다.
 */
export function adminDongAt(coord: LatLng): AdminDong | null {
  const idx = load();
  if (!idx) return null;
  const found = dongAt(idx, coord.lng, coord.lat);
  if (found < 0) return null;
  const item = idx.names[found];
  const [rawSido = "", sigungu = "", dong = ""] = item.name.split(" ");
  const sido =
    rawSido === "전남광주통합특별시"
      ? GWANGJU_DISTRICTS.has(sigungu)
        ? "광주광역시"
        : "전라남도"
      : rawSido;
  return {
    id: item.id,
    name: [sido, sigungu, dong].filter(Boolean).join(" "),
    sido,
    sigungu: sigungu || sido,
    dong,
  };
}

export interface DongFill {
  id: string;
  name: string;
  /** 링 목록 — 각 링은 [lat, lng, lat, lng, ...] (RouteMap 좌표계) */
  rings: number[][];
}

function dongFill(idx: Index, dong: number): DongFill {
  const fr = idx.dongIndex[dong * 2];
  const rc = idx.dongIndex[dong * 2 + 1];
  const rings: number[][] = [];
  for (let r = fr; r < fr + rc; r++) {
    const off = idx.ringIndex[r * 2];
    const cnt = idx.ringIndex[r * 2 + 1];
    const arr = new Array<number>(cnt * 2);
    for (let i = 0; i < cnt; i++) {
      arr[i * 2] = idx.geom[(off + i) * 2 + 1];
      arr[i * 2 + 1] = idx.geom[(off + i) * 2];
    }
    rings.push(arr);
  }
  return { id: idx.names[dong].id, name: idx.names[dong].name, rings };
}

const haversineM = (a: LatLng, b: LatLng) => {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx);
};

/** 궤적들을 ~300m 간격 표본으로 훑어 지나간 동 폴리곤 집합을 반환한다. */
export function visitedDongs(encs: string[]): DongFill[] {
  const idx = load();
  if (!idx) return [];
  const seen = new Set<number>();
  for (const enc of encs) {
    const pts = decodePolyline(enc);
    if (pts.length === 0) continue;
    let last: LatLng | null = null;
    for (const [lat, lng] of pts) {
      const p = { lat, lng };
      if (last && haversineM(last, p) < 300) continue;
      last = p;
      const d = dongAt(idx, lng, lat);
      if (d >= 0) seen.add(d);
    }
  }
  return [...seen].map((d) => dongFill(idx, d));
}
