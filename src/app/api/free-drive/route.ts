import { NextRequest, NextResponse } from "next/server";

import { cameraRoadNameMatchesRoute, sameRoadName, CAMERA_ROAD_SNAP_M } from "@/lib/camera-road";
import { mergeIncomingBranchConflict } from "@/lib/free-drive-branch";
import { cameraNationalLevel } from "@/lib/nodelink";
import { camsNear } from "@/lib/navguide";
import { limitAtPoint, roadAhead, roadDirAt } from "@/lib/localroute";
import { forwardChainAt } from "@/lib/nodelink";
import { roadNameAt } from "@/lib/road-names";
import type { LatLng } from "@/lib/types";

/** 점에서 앞도로 추적선까지 최단거리와 추적선 누적 위치를 구한다. */
function nearestOnTrace(
  p: LatLng,
  trace: LatLng[],
): { distM: number; atM: number; totalM: number } {
  let bestDist = Infinity;
  let bestAt = 0;
  let acc = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1];
    const b = trace[i];
    const kx = Math.cos((a.lat * Math.PI) / 180) * 111320;
    const ax = a.lng * kx;
    const ay = a.lat * 111320;
    const bx = b.lng * kx;
    const by = b.lat * 111320;
    const px = p.lng * kx;
    const py = p.lat * 111320;
    const dx = bx - ax;
    const dy = by - ay;
    const segM = Math.hypot(dx, dy);
    const l2 = dx * dx + dy * dy || 1;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
    const dist = Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
    if (dist < bestDist) {
      bestDist = dist;
      bestAt = acc + segM * t;
    }
    acc += segM;
  }
  return { distM: bestDist, atM: bestAt, totalM: acc };
}

function tracePointAt(trace: LatLng[], atM: number): LatLng {
  let acc = 0;
  for (let i = 1; i < trace.length; i++) {
    const a = trace[i - 1];
    const b = trace[i];
    const kx = Math.cos((a.lat * Math.PI) / 180) * 111320;
    const segM = Math.hypot((b.lng - a.lng) * kx, (b.lat - a.lat) * 111320);
    if (acc + segM >= atM) {
      const t = Math.max(0, Math.min(1, (atM - acc) / (segM || 1)));
      return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    }
    acc += segM;
  }
  return trace[trace.length - 1];
}

/**
 * 교차로에서는 횡단도로 카메라도 roadAhead 선 바로 옆에 놓일 수 있다.
 * 경찰청 도로명과 지도상 카메라 도로명이 일치하고, 카메라 전후의 추적선이
 * 같은 다른 도로로 확인될 때만 제외한다. 이름/끝점/회전이 애매하면 fail-open.
 */
function cameraRoadNameMatchesTrace(
  c: LatLng & { roadNames?: string[] },
  trace: LatLng[],
  hit: { atM: number; totalM: number },
): boolean {
  if (c.roadNames?.length !== 1) return true;
  const windowM = CAMERA_ROAD_SNAP_M * 2;
  if (hit.atM < windowM || hit.atM + windowM > hit.totalM) return true;
  return cameraRoadNameMatchesRoute(
    c.roadNames,
    roadNameAt(c, CAMERA_ROAD_SNAP_M),
    roadNameAt(tracePointAt(trace, hit.atM - windowM), CAMERA_ROAD_SNAP_M),
    roadNameAt(tracePointAt(trace, hit.atM + windowM), CAMERA_ROAD_SNAP_M),
  );
}

/**
 * 일반 주행(목적지 없음) 상시 안내 — 현위치 도로 제한속도 + 반경 내 단속카메라.
 * 카카오맵·티맵처럼 경로 없이도 제한속도 표시·과속경고·카메라 경고를 하려는 용도.
 * 클라이언트가 이동 500m 또는 15초마다 폴링하고, 경고 판정은 클라에서 매 픽스.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const { lat, lng, heading, prevLinkId } = (body ?? {}) as {
    lat?: number;
    lng?: number;
    heading?: number | null;
    prevLinkId?: string | null;
  };
  if (
    typeof lat !== "number" ||
    typeof lng !== "number" ||
    !Number.isFinite(lat) ||
    !Number.isFinite(lng) ||
    lat < -90 ||
    lat > 90 ||
    lng < -180 ||
    lng > 180
  ) {
    return NextResponse.json({ error: "lat/lng가 필요합니다" }, { status: 400 });
  }
  const hd =
    typeof heading === "number" && Number.isFinite(heading)
      ? ((heading % 360) + 360) % 360
      : null;
  const near = camsNear(lat, lng, 2000);

  // 제한속도 — OSM maxspeed 태그 – 단속카메라 전파값(둘 다 확정) – 도로급
  // 법정 기본값(추정) 순. 추정도 숨기지 않고 그대로 내려 클라가 "추정" 표식과
  // 함께 항상 표시한다(빈칸 방지). 확정/추정 구분은 source로.
  const limit = limitAtPoint(lat, lng, hd);
  const limitKmh = limit.kmh;
  const source = limit.source;

  // 실제 앞 도로를 그래프로 추종(교차로마다 최소회전 = 직진). 경로 없는
  // 자유주행에서 "지금 달리는 길"을 추정해, 진행방향 직선 연장선에 걸리는 커브
  // 앞 옆도로 카메라 오탐을 없앤다. heading이 있을 때만. (cam-sim 하네스로
  // 튜닝: 앞도로 50m + 기존 게이트면 오탐 OLD 대비 93%.)
  //
  // 1순위는 표준노드링크 앞쪽 임시경로(네이버 SafeGuiding과 같은 규칙: 통행가능 –
  // 같은 등급 – 직진 ±10° – 넓은 차로 – 높은 등급). 직전 조회의 시작 링크를
  // 유지해 평행도로 튐을 막는다. 실주행 하네스(58경로)에서 배포본 대비 오탐
  // 3~4%·누락 동일. 표준링크가 없는 곳은 기존 OSM roadAhead로 폴백한다.
  const chain = hd !== null
    ? forwardChainAt({ lat, lng }, hd, 700, typeof prevLinkId === "string" ? prevLinkId : null)
    : null;
  const trace = chain && chain.path.length >= 2
    ? chain.path
    : hd !== null ? roadAhead(lat, lng, hd, 700) : [];
  // 50m. 35m로 조여봤지만 카카오 대비 실측에서 놓침만 늘고 헛경고는 별로 안 줄었다.
  // 헛경고는 발화 거리(log/page.tsx)를 속도에 맞추는 쪽이 훨씬 효과가 컸다.
  const ROAD_M = 50;

  // 각 카메라에 그 도로의 진행 방향(dirBrg)을 붙인다 — 분리도로(일방통행)에서
  // 반대차로 카메라를 클라이언트가 걸러낼 수 있게. 양방향 도로면 dirBrg=null
  // (방향 무의미 → 항상 경고). 목록을 1km마다 받으므로 목록 반경 2km 전체에 붙인다.
  //
  // 신호카메라(signal)도 반드시 포함해야 한다. 여기서 빼두면 반대차로·옆길
  // 카메라까지 그대로 경고가 된다 — 실측: 카카오는 침묵하는데 우리만 경고한
  // 14곳 중 9곳이 반대방향(5) 또는 옆길(4)이었고, 반대방향 5곳은 전부 일방통행이었다.
  // 국가표준 도로 구조(고가·지하차도) 층 비교 — 예상 경로가 카메라 지점과 그 뒤 70m까지
  // 같은 층으로 이어지는데 카메라 도로 층과 다르면 그 카메라 앞을 지나지 않는다.
  // 예상 경로의 층은 prevLinkId 연결 추적으로 유지된다(nodelink.forwardChainAt).
  // 차가 "지금 이미" 올라탄 층 — 지금 링크부터 카메라 뒤 70m까지 예상 경로가 전부 같은
  // 층일 때만 그 층(아니면 null). 갈림길 앞에서 "고가로 갈 것"이라는 예측만으로 막으면
  // 실제로 아래 지상 도로로 간 차의 정상 경고를 잃는다(72길 재생: 6건 확인).
  const committedLevel = (hit: { distM: number; atM: number; totalM: number } | null) => {
    if (!chain || trace !== chain.path || !chain.startLevelSure || !hit || hit.distM > ROAD_M || hit.atM + 70 > hit.totalM) return null;
    const lv = chain.linkLevels[0];
    if (lv == null) return null;
    for (let i = 1; i < chain.linkLevels.length && chain.linkStartM[i] <= hit.atM + 70; i++) {
      if (chain.linkLevels[i] !== lv) return null;
    }
    return lv;
  };
  const nationalLevelConflict = (
    c: (typeof near)[number], dirBrg: number | null, hit: { distM: number; atM: number; totalM: number } | null,
  ): boolean => {
    const here = committedLevel(hit);
    if (here == null) return false;
    const camLevel = cameraNationalLevel(c, c.dirStrong ? dirBrg : null, c.signal === true);
    return camLevel != null && here !== camLevel;
  };
  const cams = near.map((c) => {
    let dirBrg: number | null = c.dirBrg ?? null;
    if (c.kind === "fixed" || c.kind === "signal") {
      const dx = (c.lng - lng) * Math.cos((lat * Math.PI) / 180) * 111_320;
      const dy = (c.lat - lat) * 110_540;
      if (Math.hypot(dx, dy) <= 2000) {
        const dir = roadDirAt(c.lat, c.lng);
        if (!c.dirStrong && dir?.oneway) dirBrg = dir.brg;
      }
    }
    // 앞 도로 추적선 50m 이내 + 도로명 근거가 모순되지 않으면 onRoad.
    // 추적/도로명 판정이 불충분하면 fail-open 해 실제 경고를 잃지 않는다.
    const traceHit = trace.length >= 2 ? nearestOnTrace(c, trace) : null;
    const roadNameMatch = traceHit ? cameraRoadNameMatchesTrace(c, trace, traceHit) : true;
    const roadConflict = !!traceHit && !roadNameMatch;
    const currentRoad = roadNameAt({ lat, lng }, CAMERA_ROAD_SNAP_M);
    const mappedCameraRoad = roadNameAt(c, CAMERA_ROAD_SNAP_M);
    const policeRoad = c.roadNames?.length === 1 ? c.roadNames[0] : null;
    const cameraRoadCorroborated = !!policeRoad
      && (c.roadStrong === true || sameRoadName(mappedCameraRoad, policeRoad));
    const currentRoadMatch = !!currentRoad && cameraRoadCorroborated
      && sameRoadName(currentRoad, policeRoad);
    const currentRoadConflict = !!currentRoad && cameraRoadCorroborated
      && !sameRoadName(currentRoad, policeRoad);
    const onRoad = traceHit ? traceHit.distM <= ROAD_M && roadNameMatch : true;
    const branchConflict = mergeIncomingBranchConflict({ lat, lng }, hd, c, dirBrg);
    // Compare the road at the camera with a corroborated OSM road identity.
    // Unknown camera roads/graph gaps/bridge exits preserve the old decision.
    // 자유주행은 국가표준 층 판정만 쓴다. OSM 도로명 판정은 72길 재생에서 북부간선 고가 위
    // 70km 카메라(공공 도로명은 아래 지상 도로)를 막아 카카오도 울린 정상 경고를 잃었다.
    // (길안내는 경로를 알고 있어 navguide에서 OSM 판정을 계속 쓴다.)
    const osmLevel = false;
    const nationalLevel = nationalLevelConflict(c, dirBrg, traceHit);
    const roadLevelConflict = nationalLevel;
    return {
      lat: c.lat,
      lng: c.lng,
      kind: c.kind,
      deviceId: c.deviceId,
      speed: c.speed,
      signal: c.signal,
      rear: c.rear,
      limitKmh: c.limitKmh,
      spos: c.spos,
      school: c.school,
      dirBrg,
      dirStrong: c.dirStrong === true,
      roadStrong: c.roadStrong === true,
      onRoad,
      roadConflict,
      currentRoadConflict,
      currentRoadMatch,
      branchConflict,
      roadLevelConflict,
      ...(roadLevelConflict ? { roadLevelBy: osmLevel ? (nationalLevel ? "both" : "osm") : "national" } : {}),
      // 판정 근거(평가·개발자 기록용): 앞 도로 추적선까지 거리, 그 지점 추적선 방향
      ...(traceHit ? {
        traceDistM: Math.round(traceHit.distM),
        traceBrg: Math.round(
          ((Math.atan2(
            (tracePointAt(trace, Math.min(traceHit.totalM, traceHit.atM + 15)).lng - tracePointAt(trace, Math.max(0, traceHit.atM - 15)).lng) *
              Math.cos((c.lat * Math.PI) / 180),
            tracePointAt(trace, Math.min(traceHit.totalM, traceHit.atM + 15)).lat - tracePointAt(trace, Math.max(0, traceHit.atM - 15)).lat,
          ) * 180) / Math.PI + 360) % 360,
        ),
      } : {}),
    };
  });
  return NextResponse.json({ limitKmh, source, cams, chainLinkId: chain?.startLinkId ?? null });
}
