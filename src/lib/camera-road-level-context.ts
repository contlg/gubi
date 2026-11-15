import "server-only";

import { assessCameraRoadLevel, type CameraRoadLevelAssessment } from "./camera-road-level";
import { roadLevelEdgesNear } from "./localroute";
import { CAMERA_ROAD_SNAP_M } from "./camera-road";
import type { LatLng } from "./types";

type Camera = LatLng & { roadNames?: readonly string[]; dirBrg?: number | null; dirStrong?: boolean; signal?: boolean };
/** 층을 정할 근거가 하나라도 있는 장비 — 공공 도로명, 공식 찍는 방향, 신호 단속 */
const hasLevelEvidence = (c: Camera) =>
  c.roadNames?.length === 1 || (c.dirStrong === true && c.dirBrg != null) || c.signal === true;

export function cameraRoadLevelAtPoint(
  camera: Camera,
  routePoint: LatLng,
  routeHeading: number,
  routeLinkIds: readonly string[],
  ahead?: { point: LatLng; heading: number },
): CameraRoadLevelAssessment {
  if (!hasLevelEvidence(camera) || !routeLinkIds.length) {
    return { verdict: "unknown", reason: "missing-independent-road-evidence" };
  }
  return assessCameraRoadLevel({
    cameraRoadNames: camera.roadNames,
    cameraDirStrong: camera.dirStrong === true && camera.dirBrg != null,
    cameraSignal: camera.signal === true,
    cameraEdges: roadLevelEdgesNear(camera, camera.dirStrong && camera.dirBrg != null ? camera.dirBrg : null),
    routeEdges: roadLevelEdgesNear(routePoint, routeHeading),
    routeEdgesAhead: ahead ? roadLevelEdgesNear(ahead.point, ahead.heading) : [],
    routeLinkIds,
  });
}

export function cameraRoadLevelOnPath(
  camera: Camera,
  path: readonly LatLng[],
  routeLinkIds: readonly string[],
): CameraRoadLevelAssessment {
  if (!hasLevelEvidence(camera) || !routeLinkIds.length || path.length < 2) {
    return { verdict: "unknown", reason: "missing-independent-road-evidence" };
  }
  let best: { distanceM: number; point: LatLng; heading: number; alongM: number } | null = null;
  const cum = [0];
  const k = 111320 * Math.cos(camera.lat * Math.PI / 180);
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const ax = (a.lng - camera.lng) * k, ay = (a.lat - camera.lat) * 110540;
    const dx = (b.lng - a.lng) * k, dy = (b.lat - a.lat) * 110540;
    const len2 = dx * dx + dy * dy;
    const len = Math.sqrt(len2);
    cum.push(cum[cum.length - 1] + len);
    if (!len2) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    const distanceM = Math.hypot(ax + t * dx, ay + t * dy);
    if (!best || distanceM < best.distanceM) {
      best = { distanceM, point: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) },
        heading: Math.atan2(dx, dy) * 180 / Math.PI, alongM: cum[i - 1] + t * len };
    }
  }
  if (!best) return { verdict: "unknown", reason: "degenerate-path" };
  // 경고 거리가 아닌 기존 도로명 검증 범위를 사용한다. 실제 미래 위치 대신 계획 경로로 비교한다.
  const aheadM = best.alongM + CAMERA_ROAD_SNAP_M * 2;
  let ahead: { point: LatLng; heading: number } | undefined;
  if (aheadM <= cum[cum.length - 1]) {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < aheadM) i++;
    const a = path[i - 1], b = path[i];
    const t = (aheadM - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    ahead = { point: { lat: a.lat + t * (b.lat - a.lat), lng: a.lng + t * (b.lng - a.lng) },
      heading: Math.atan2((b.lng - a.lng) * k, (b.lat - a.lat) * 110540) * 180 / Math.PI };
  }
  return cameraRoadLevelAtPoint(camera, best.point, best.heading, routeLinkIds, ahead);
}
