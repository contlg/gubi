import "server-only";

import { searchLocalPlaces } from "@/lib/local-places";
import { distanceM, pointAtFraction } from "@/lib/scoring/curvature";
import type { DriveStyle, LatLng, Place, WaypointType } from "@/lib/types";

/** 이 드라이브 종류가 선택되면 해당 장소를 경유지로 박은 변형 후보를 추가 생성한다 */
export const STYLE_VARIANTS: {
  style: DriveStyle;
  type: WaypointType;
  label: string;
}[] = [
  { style: "해안도로", type: "해변", label: "해안도로 위주" },
  { style: "강변도로", type: "강/호수", label: "강변도로 위주" },
];

/** 경로 회랑을 따라 스타일 장소(해변 등)를 최대 3곳 찾는다 */
export async function styleAnchorsAlong(
  path: LatLng[],
  type: WaypointType,
  accept: (place: Place) => boolean = () => true,
): Promise<Place[]> {
  const anchors: Place[] = [];
  for (const f of [0.2, 0.45, 0.7]) {
    const center = pointAtFraction(path, f);
    try {
      const places = await searchByType(center, 10_000, type);
      const p = places.find((pl) => accept(pl) && !anchors.some((a) => a.name === pl.name));
      if (p) anchors.push(p);
    } catch {
      // 한 지점 실패는 무시
    }
  }
  return anchors;
}

/**
 * 경로 회랑을 ~12km 간격으로 훑어 스타일 장소를 촘촘히 찾는다.
 * 반경을 좁게(6km) 잡아 회랑에서 벗어난 곳으로 끌려가는 지그재그를 막고,
 * 결과는 경로 진행 순서대로라 그대로 경유지로 쓸 수 있다.
 */
export async function styleAnchorsDense(
  path: LatLng[],
  type: WaypointType,
): Promise<Place[]> {
  const STEP_M = 12_000;
  const RADIUS_M = 6_000;
  const MAX_ANCHORS = 12;

  let totalM = 0;
  for (let i = 1; i < path.length; i++) totalM += distanceM(path[i - 1], path[i]);
  const steps = Math.min(Math.max(Math.floor(totalM / STEP_M), 1), 24);

  const anchors: Place[] = [];
  for (let s = 1; s <= steps && anchors.length < MAX_ANCHORS; s++) {
    const center = pointAtFraction(path, s / (steps + 1));
    try {
      const places = await searchByType(center, RADIUS_M, type, "distance");
      const p = places.find((pl) => !anchors.some((a) => a.name === pl.name));
      if (p) anchors.push(p);
    } catch {
      // 한 지점 실패는 무시
    }
  }
  return anchors;
}

export async function searchByType(
  center: LatLng,
  radiusM: number,
  type: WaypointType,
  sort: "accuracy" | "distance" = "accuracy",
): Promise<Place[]> {
  return searchLocalPlaces(center, radiusM, type, sort);
}
