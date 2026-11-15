import { sameRoadName } from "./camera-road";

export interface RoadLevelEdge {
  edgeId: number;
  roadName: string;
  structure: 0 | 1 | 2;
  layer: number | null;
  distanceM: number;
  bearingDeg: number;
  nodelinkIds: string[];
}

export interface CameraRoadLevelAssessment {
  verdict: "different" | "compatible" | "unknown";
  reason: string;
  cameraStructure?: 0 | 1 | 2;
  routeStructure?: 0 | 1 | 2;
}

// 경로와 카메라 양쪽의 독립된 도로 식별자가 있어야 높이 차이를 인정한다. 경로는 카메라 투영 위치에서 비교한다.
export function assessCameraRoadLevel(input: {
  cameraRoadNames?: readonly string[];
  /** cameraEdges가 카메라의 공식 찍는 방향(±60°)으로 이미 걸러졌는지 */
  cameraDirStrong?: boolean;
  /** 신호(교차로·횡단보도 정지선) 단속 장비 */
  cameraSignal?: boolean;
  cameraEdges: readonly RoadLevelEdge[];
  routeEdges: readonly RoadLevelEdge[];
  routeEdgesAhead?: readonly RoadLevelEdge[];
  routeLinkIds: readonly string[];
}): CameraRoadLevelAssessment {
  const links = new Set(input.routeLinkIds);
  const route = input.routeEdges.filter((e) => e.nodelinkIds.some((id) => links.has(id)));
  let cameraStructure: 0 | 1 | 2;
  if (input.cameraRoadNames?.length === 1) {
    const camera = input.cameraEdges.filter((e) => sameRoadName(e.roadName, input.cameraRoadNames![0]));
    if (!camera.length || !route.length) {
      return { verdict: "unknown", reason: "missing-independent-road-evidence" };
    }
    if (new Set(camera.map((e) => e.structure)).size !== 1) {
      return { verdict: "unknown", reason: "overlapping-road-levels-ambiguous" };
    }
    cameraStructure = camera[0].structure;
  } else {
    // 공공 설치 도로명이 없는 장비(티맵 등). 이름 대신 두 근거 중 하나가 있을 때만 층을 정한다.
    //  - 공식 찍는 방향으로 걸러낸 주변 도로가 모두 같은 층이면 그 층.
    //  - 신호 단속 장비는 교차로·횡단보도 정지선에 있으니 평면(지상) 도로 — 같은 방향
    //    지상 도로가 실제로 있을 때만. 고가 위·지하차도 안에는 신호 정지선이 없다.
    // 그 밖(방향도 신호도 없음, 같은 방향 고가·지상이 겹친 고정식 장비)은 판단 보류.
    const cam = input.cameraEdges;
    const structures = new Set(cam.map((e) => e.structure));
    if (!cam.length || !route.length) {
      return { verdict: "unknown", reason: "camera-road-not-identified" };
    }
    if (input.cameraSignal && structures.has(0)) cameraStructure = 0;
    else if (input.cameraDirStrong && structures.size === 1) cameraStructure = cam[0].structure;
    else return { verdict: "unknown", reason: "camera-road-not-identified" };
  }
  if (new Set(route.map((e) => e.structure)).size !== 1) {
    return { verdict: "unknown", reason: "overlapping-road-levels-ambiguous" };
  }
  const routeStructure = route[0].structure;
  // OSM 층 번호는 교차점 안의 상대 순서이므로 다른 다리끼리 층 번호만 비교하지 않는다.
  if (cameraStructure === routeStructure) {
    return { verdict: "compatible", reason: "same-structure-class", cameraStructure, routeStructure };
  }

  // 한 지점의 높이 차이로 이후 같은 도로의 카메라를 숨기지 않는다.
  const ahead = (input.routeEdgesAhead ?? []).filter((e) => e.nodelinkIds.some((id) => links.has(id)));
  const aheadStructures = new Set(ahead.map((e) => e.structure));
  if (!ahead.length || aheadStructures.size !== 1 || ahead[0].structure !== routeStructure) {
    return { verdict: "unknown", reason: "structure-boundary-or-incomplete-path", cameraStructure, routeStructure };
  }
  return { verdict: "different", reason: "independently-identified-different-structures", cameraStructure, routeStructure };
}
