// 교차로에서는 최근접 도로만으로 카메라 소속을 알 수 없어 수직 도로 추정으로 경고를 숨기지 않는다.
export const CAMERA_ROAD_SNAP_M = 35;

// 도로와 경로를 구분할 수 없거나 교차로가 모호하면 판정을 보류한다.
export function cameraRoadMatchesRoute(
  road: { oneway: boolean; brg: number } | null,
  routeBearing: number,
  distanceToRouteM: number,
): boolean {
  if (!road || !Number.isFinite(road.brg) || !Number.isFinite(routeBearing)) return true;
  const difference = Math.abs(((road.brg - routeBearing + 540) % 360) - 180);
  const axisDifference = Math.min(difference, 180 - difference);

  if (distanceToRouteM > CAMERA_ROAD_SNAP_M && axisDifference > 60) return false;
  return !road.oneway || difference <= 100;
}

/** Public/map sources sometimes spell the same road with the suffix 도로 vs 로
 * (e.g. 동부간선도로 / 동부간선로). Keep normalization intentionally narrow:
 * fuzzy matching can merge genuinely different neighbouring roads.
 */
export function sameRoadName(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  if (!a || !b) return false;
  const norm = (s: string) => s.trim().replace(/\s+/g, "").replace(/도로$/, "로");
  return norm(a) === norm(b);
}

export function cameraRoadNameMatchesRoute(
  policeNames: readonly string[] | undefined,
  mappedCameraRoad: string | null,
  before: string | null,
  after: string | null,
): boolean {
  if (!policeNames || policeNames.length !== 1 || !before || !sameRoadName(before, after)) return true;
  const name = policeNames[0];
  return sameRoadName(name, before) || !sameRoadName(mappedCameraRoad, name);
}
