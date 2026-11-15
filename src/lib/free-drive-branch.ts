import { nearbyNodelinks, type NodelinkMatch } from "@/lib/nodelink";
import type { LatLng } from "@/lib/types";

// 자유주행 한 요청에서 카메라마다 불린다(도심 70~80대). 현위치 링크는 요청 안에서
// 늘 같고, 카메라 링크는 고정 지점이라 모든 사용자에게 같다 — 둘 다 재계산이 서울
// 도심 요청 CPU의 약 36%였다. 도로 자료는 프로세스 수명 동안 바뀌지 않는다.
let lastCurrent: { key: string; link: NodelinkMatch | undefined } | null = null;
const cameraLinks = new Map<string, NodelinkMatch | undefined>();
const CAMERA_CACHE_MAX = 50_000;

function currentLink(pos: LatLng, heading: number): NodelinkMatch | undefined {
  const key = `${pos.lat},${pos.lng},${heading}`;
  if (lastCurrent?.key !== key) lastCurrent = { key, link: nearbyNodelinks(pos, heading, 35, 35)[0] };
  return lastCurrent.link;
}

function cameraLink(c: LatLng, dirBrg: number): NodelinkMatch | undefined {
  const key = `${c.lat},${c.lng},${dirBrg}`;
  if (cameraLinks.has(key)) return cameraLinks.get(key);
  const link = nearbyNodelinks(c, dirBrg, 60, 45)[0];
  if (cameraLinks.size >= CAMERA_CACHE_MAX) cameraLinks.clear();
  cameraLinks.set(key, link);
  return link;
}

// 합류부의 다른 진입 링크 카메라는 차량과 카메라가 서로 다른 링크로 매칭되고 도착 노드가 같을 때만 구분한다.
export function mergeIncomingBranchConflict(
  pos: LatLng,
  heading: number | null,
  c: LatLng & { kind: string; school?: boolean; dirStrong?: boolean },
  dirBrg: number | null,
): boolean {
  if (heading == null || dirBrg == null || c.dirStrong !== true || c.kind === "section" || c.school)
    return false;
  const current = currentLink(pos, heading);
  const camera = cameraLink(c, dirBrg);
  if (!current || !camera || current.distanceM > 15 || camera.distanceM > 15) return false;
  return current.linkId !== camera.linkId && current.toNodeIndex === camera.toNodeIndex;
}
