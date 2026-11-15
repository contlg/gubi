import "server-only";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { adminDongAt } from "@/lib/admdong";
import type { LatLng, Place, WaypointType } from "@/lib/types";

type PlaceTuple = [
  lat: number,
  lng: number,
  type: WaypointType,
  name: string,
  address: string,
  importance: number,
];

interface PlaceRow {
  coord: LatLng;
  type: WaypointType;
  name: string;
  address: string;
  importance: number;
}

interface PlaceData {
  version: number;
  source: string;
  sourceMtime: number;
  places: PlaceTuple[];
}

const DATA_PATH = join(process.cwd(), "src/lib/data/local-places.json");
const GRID_DEG = 0.05;
let grid: Map<number, PlaceRow[]> | null | undefined;

const keyOf = (lat: number, lng: number) =>
  Math.floor(lat / GRID_DEG) * 10_000 + Math.floor(lng / GRID_DEG);

function load(): Map<number, PlaceRow[]> | null {
  if (grid !== undefined) return grid;
  try {
    const data = JSON.parse(readFileSync(DATA_PATH, "utf8")) as PlaceData;
    if (data.version !== 1 || !Array.isArray(data.places)) {
      throw new Error("scripts/build-local-places-from-osm.mjs의 v1 산출물이 필요합니다.");
    }
    const next = new Map<number, PlaceRow[]>();
    for (const [lat, lng, type, name, address, importance] of data.places) {
      const k = keyOf(lat, lng);
      const list = next.get(k) ?? [];
      list.push({ coord: { lat, lng }, type, name, address, importance });
      next.set(k, list);
    }
    grid = next;
  } catch (error) {
    console.error("[local-places] OSM 장소 색인 로딩 실패:", error);
    grid = null;
  }
  return grid;
}

function haversineM(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.round(Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx));
}

/**
 * OSM 전국 스냅샷에서 주변 장소를 찾는다. 자동 코스 경유지 탐색 전용이며
 * 사용자 자유어 주소/상호 검색은 계속 카카오 로컬을 사용한다.
 */
export function searchLocalPlaces(
  center: LatLng,
  radiusM: number,
  type: WaypointType,
  sort: "accuracy" | "distance" = "accuracy",
): Place[] {
  const idx = load();
  if (!idx) return [];
  const radius = Math.max(100, Math.min(radiusM, 100_000));
  const latCells = Math.ceil(radius / 110_540 / GRID_DEG);
  const lngMeters = Math.max(30_000, 111_320 * Math.cos((center.lat * Math.PI) / 180));
  const lngCells = Math.ceil(radius / lngMeters / GRID_DEG);
  const cy = Math.floor(center.lat / GRID_DEG);
  const cx = Math.floor(center.lng / GRID_DEG);
  const found: (Place & { importance: number })[] = [];
  for (let y = cy - latCells; y <= cy + latCells; y++) {
    for (let x = cx - lngCells; x <= cx + lngCells; x++) {
      for (const row of idx.get(y * 10_000 + x) ?? []) {
        if (row.type !== type) continue;
        const distanceM = haversineM(center, row.coord);
        if (distanceM > radius) continue;
        const address = row.address || adminDongAt(row.coord)?.name || "";
        found.push({
          name: row.name,
          address,
          coord: row.coord,
          distanceM,
          importance: row.importance,
        });
      }
    }
  }
  found.sort((a, b) =>
    sort === "distance"
      ? (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity) || b.importance - a.importance
      : b.importance - a.importance || (a.distanceM ?? Infinity) - (b.distanceM ?? Infinity),
  );
  const seen = new Set<string>();
  const result: Place[] = [];
  for (const row of found) {
    const place: Place = {
      name: row.name,
      address: row.address,
      coord: row.coord,
      distanceM: row.distanceM,
    };
    const dedupe = `${place.name}|${place.coord.lat.toFixed(3)}|${place.coord.lng.toFixed(3)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    result.push(place);
    if (result.length >= 20) break;
  }
  return result;
}
