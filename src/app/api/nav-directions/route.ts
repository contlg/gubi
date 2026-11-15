import { NextRequest, NextResponse } from "next/server";

import {
  getDirections,
  jamRatio,
  routePath,
  type NaviRoute,
  type RoutePriority,
} from "@/lib/kakao";
import { trafficAlongPath, type PathTrafficSummary } from "@/lib/its-speed";
import { estimateFuelCost } from "@/lib/scoring/cost";
import { curveMetrics } from "@/lib/scoring/curvature";
import { jsonBodyError, readJsonBody } from "@/lib/request-json";
import type { NavMode } from "@/lib/routing-jobs";
import {
  isRoutingBusyError,
  runNavFallbackRouting,
} from "@/lib/routing-worker-client";
import type { LatLng } from "@/lib/types";

/**
 * 자체 내비 경로 옵션 — 목적지까지 어떻게 갈지 선택해서 카카오 실측 경로를
 * 받는다. exploreLeg(로컬 A*)와 달리 우선순위·유료회피·실시간 정체를 반영.
 *   time     최단시간     priority=TIME
 *   distance 최단경로     priority=DISTANCE
 *   free     무료도로     priority=RECOMMEND + avoid toll
 *   nojam    안막히는도로  카카오 최선 vs 로컬 ITS 우회로 중 확실히 덜 막히는 쪽
 *
 * nojam은 카카오 대안이 모두 같은 큰길을 타서 함께 막히는 한계가 있어(대안=큰길
 * 위주), 로컬 ITS A*로 '정체 증폭 + 왕복1차선/이면도로 배제' 우회로를 따로 만든다.
 * 카카오 최선이 어느 정도 막힐 때만(NOJAM_MIN_JAM), 우회로가 확실히 덜 막히고
 * (NOJAM_MARGIN) 우회로 인한 시간 손해가 과하지 않을 때만(NOJAM_MAX_SLOWDOWN) 채택.
 */
// 카카오 최선의 정체비율이 이 미만이면 이미 원활 – 우회 시도 안 함.
const NOJAM_MIN_JAM = 0.15;
// 우회로가 카카오보다 최소 이만큼 덜 막혀야 채택(짧은 개선엔 안 바꿈).
const NOJAM_MARGIN = 0.12;
// 우회로 소요시간이 카카오의 이 배를 넘으면 너무 돌아가는 것 – 기각.
const NOJAM_MAX_SLOWDOWN = 1.6;

function isCoord(v: unknown): v is LatLng {
  const p = v as LatLng;
  return (
    typeof p?.lat === "number" &&
    typeof p?.lng === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lng) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lng >= -180 &&
    p.lng <= 180
  );
}

export async function POST(req: NextRequest) {
  let body: {
    origin?: unknown;
    destination?: unknown;
    mode?: unknown;
    waypoints?: unknown;
  };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const detail = jsonBodyError(error);
    return NextResponse.json({ error: detail.message }, { status: detail.status });
  }
  const { origin, destination } = body;
  if (!isCoord(origin) || !isCoord(destination)) {
    return NextResponse.json(
      { error: "origin/destination 좌표가 필요합니다" },
      { status: 400 },
    );
  }
  // 경유지 — 카카오 하드 제한 5개. 경유지 추가 안내에 쓴다(로컬 A* 대신 카카오
  // 실경로로 뽑아 안내가 실제 도로와 어긋나는 걸 방지).
  const waypoints = (Array.isArray(body.waypoints) ? body.waypoints : [])
    .filter(isCoord)
    .slice(0, 5);
  const mode: NavMode = ["time", "distance", "free", "nojam"].includes(
    body.mode as string,
  )
    ? (body.mode as NavMode)
    : "time";

  const priority: RoutePriority =
    mode === "distance" ? "DISTANCE" : mode === "time" ? "TIME" : "RECOMMEND";
  const avoid: ("toll" | "motorway")[] = mode === "free" ? ["toll"] : [];

  try {
    const routes = await getDirections(origin, destination, priority, {
      avoid,
      alternatives: mode === "nojam", // 안막힘은 대안 비교가 필요
      ...(waypoints.length ? { waypoints } : {}),
    });
    if (routes.length === 0) {
      const { candidate } = await runNavFallbackRouting(
        { origin, destination, waypoints, mode },
        req.signal,
      );
      if (candidate) return NextResponse.json({ candidate });
      return NextResponse.json(
        { error: "경로를 찾지 못했어요" },
        { status: 502 },
      );
    }
    // 안막힘: 카카오가 준 실제 주행 가능 대안의 geometry를 5분 ITS로 다시
    // 평가한다. ITS 커버리지가 부족한 후보만 카카오 road_details를 폴백으로 쓴다.
    const itsByRoute = new Map<NaviRoute, PathTrafficSummary>();
    if (mode === "nojam") {
      for (const route of routes) {
        itsByRoute.set(route, trafficAlongPath(routePath(route)));
      }
    }
    const best =
      mode === "nojam"
        ? [...routes].sort((a, b) => {
            const ja = itsByRoute.get(a)?.jamRatio ?? jamRatio(a) ?? 1;
            const jb = itsByRoute.get(b)?.jamRatio ?? jamRatio(b) ?? 1;
            return ja - jb || a.summary.duration - b.summary.duration;
          })[0]
        : routes[0];

    const path = routePath(best);
    if (path.length < 2) {
      return NextResponse.json(
        { error: "경로가 너무 짧습니다" },
        { status: 502 },
      );
    }
    // 경로 미리보기 정체 색칠용 샘플 — road_details의 traffic_state를 ~350m
    // 간격으로 뽑는다(0정보없음 1정체 2지체 3서행 4원활). 별도 콜 없이 재사용.
    const rawItsTraffic = mode === "nojam" ? itsByRoute.get(best) : undefined;
    // trafficAlongPath는 커버리지가 부족해도 빈 summary 객체를 돌려준다.
    // jamRatio=null이면 ITS를 썼다고 표시하지 말고 카카오 road_details로 폴백.
    const itsTraffic = rawItsTraffic?.jamRatio != null ? rawItsTraffic : undefined;

    // 안막힘: 카카오 최선이 막히면 로컬 ITS 우회로(정체 증폭+좁은길 배제)를 만들어
    // 확실히 덜 막힐 때만 교체한다. 로컬은 카카오 호출 0건(무료)이라 항상 시도해도 안전.
    if (mode === "nojam") {
      const kakaoJam = itsTraffic?.jamRatio ?? jamRatio(best) ?? 1;
      if (kakaoJam > NOJAM_MIN_JAM) {
        try {
          const { candidate: detour } = await runNavFallbackRouting(
            { origin, destination, waypoints, mode: "nojam" },
            req.signal,
          );
          const detourJam = detour?.jamRatio ?? 1;
          if (
            detour &&
            detourJam <= kakaoJam - NOJAM_MARGIN &&
            detour.durationSec <= best.summary.duration * NOJAM_MAX_SLOWDOWN
          ) {
            return NextResponse.json({
              candidate: detour,
              detour: true,
              note: "실시간 정체를 피해 우회로로 안내해요(추정 경로).",
            });
          }
        } catch (detourErr) {
          // 우회로 탐색 실패·바쁨은 무시하고 카카오 최선을 그대로 쓴다.
          if (detourErr instanceof DOMException && detourErr.name === "AbortError") {
            return new NextResponse(null, { status: 499 });
          }
        }
      }
    }

    const trafficSamples: { lat: number; lng: number; state: number }[] =
      itsTraffic?.samples ? [...itsTraffic.samples] : [];
    if (!itsTraffic) {
      const SAMPLE_M = 350;
      for (const section of best.sections) {
        for (const road of section.roads) {
          const state = road.traffic_state ?? 0;
          const v = road.vertexes;
          let acc = SAMPLE_M;
          for (let i = 0; i + 3 < v.length; i += 2) {
            const dx = (v[i + 2] - v[i]) * 88_000;
            const dy = (v[i + 3] - v[i + 1]) * 111_000;
            acc += Math.hypot(dx, dy);
            if (acc >= SAMPLE_M) {
              acc = 0;
              trafficSamples.push({ lat: v[i + 1], lng: v[i], state });
            }
          }
        }
      }
    }
    return NextResponse.json({
      candidate: {
        durationSec: Math.round(best.summary.duration),
        distanceM: Math.round(best.summary.distance),
        tollFare: best.summary.fare?.toll ?? 0,
        fuelCost: estimateFuelCost(best.summary.distance),
        curve: curveMetrics(path),
        path,
        jamRatio: itsTraffic?.jamRatio ?? jamRatio(best),
        trafficSamples,
        source: "kakao",
        trafficSource: itsTraffic ? "its" : "kakao",
      },
    });
  } catch (e) {
    if (isRoutingBusyError(e)) {
      return NextResponse.json(
        { error: e.message },
        { status: 429, headers: { "Retry-After": "2" } },
      );
    }
    if (e instanceof DOMException && e.name === "AbortError") {
      return new NextResponse(null, { status: 499 });
    }
    try {
      const { candidate } = await runNavFallbackRouting(
        { origin, destination, waypoints, mode },
        req.signal,
      );
      if (candidate) {
        return NextResponse.json({
          candidate,
          warning: "카카오 최종 확인 실패 — ITS 로컬 경로",
        });
      }
    } catch (fallbackError) {
      if (isRoutingBusyError(fallbackError)) {
        return NextResponse.json(
          { error: fallbackError.message },
          { status: 429, headers: { "Retry-After": "2" } },
        );
      }
      if (fallbackError instanceof DOMException && fallbackError.name === "AbortError") {
        return new NextResponse(null, { status: 499 });
      }
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "경로 탐색 실패" },
      { status: 502 },
    );
  }
}
