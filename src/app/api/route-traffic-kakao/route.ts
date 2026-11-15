import { NextRequest, NextResponse } from "next/server";

import { trafficAlongPath } from "@/lib/its-speed";
import {
  detoured,
  pathLengthM,
  pickWaypoints,
  trafficFromKakaoRoads,
  waypointCount,
  type KakaoRoad,
} from "@/lib/kakao-traffic";
import {
  applyTimeCalib,
  pathJuncPerKm,
} from "@/lib/localroute";
import { pathEtaSec } from "@/lib/path-eta";
import type { LatLng } from "@/lib/types";

/**
 * 경로 실시간 색칠 + 소요시간을 카카오 길찾기로 받는다(ITS 대신).
 * 우리 경로를 따라 경유지 30개를 찍어 카카오가 같은 길을 타게 하고, 카카오 도로별
 * 소통 상태를 우리 경로 표본점에 옮긴다. 응답 형태는 route-traffic-its와 같다.
 * 카카오 실패·키 없음·겹치는 구간이 너무 적으면 ITS 결과로 대신한다(source로 구분).
 */

const KAKAO_URL = "https://apis-navi.kakaomobility.com/v1/waypoints/directions";
const CACHE_MS = 5 * 60_000;
const cache = new Map<string, { at: number; body: unknown }>();

function isValidPath(v: unknown): v is LatLng[] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    v.length <= 20_000 &&
    v.every(
      (p) =>
        typeof p?.lat === "number" &&
        typeof p?.lng === "number" &&
        Number.isFinite(p.lat) &&
        Number.isFinite(p.lng) &&
        p.lat >= -90 &&
        p.lat <= 90 &&
        p.lng >= -180 &&
        p.lng <= 180,
    )
  );
}

function cacheKey(path: LatLng[]): string {
  const step = Math.max(1, Math.floor(path.length / 64));
  const parts: string[] = [String(path.length)];
  for (let i = 0; i < path.length; i += step) {
    parts.push(`${path[i].lat.toFixed(4)},${path[i].lng.toFixed(4)}`);
  }
  const end = path[path.length - 1];
  parts.push(`${end.lat.toFixed(4)},${end.lng.toFixed(4)}`);
  return parts.join(";");
}

function itsResult(path: LatLng[]) {
  const traffic = trafficAlongPath(path);
  const sec = pathEtaSec(path, applyTimeCalib(1, pathJuncPerKm(path)));
  return {
    samples: traffic.samples,
    durationSec: sec != null ? Math.round(sec) : null,
    distanceM: Math.round(traffic.distanceM),
    jamRatio: traffic.jamRatio,
    coverage: traffic.coverage,
    source: "its",
  };
}

interface KakaoDirections {
  routes?: {
    result_code?: number;
    summary?: { duration?: number; distance?: number };
    sections?: { roads?: KakaoRoad[] }[];
  }[];
}

async function kakaoRoute(path: LatLng[], count: number, key: string, signal: AbortSignal) {
  const xy = (p: LatLng) => ({ x: p.lng, y: p.lat });
  const res = await fetch(KAKAO_URL, {
    method: "POST",
    headers: { Authorization: `KakaoAK ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      origin: xy(path[0]),
      destination: xy(path[path.length - 1]),
      waypoints: pickWaypoints(path, count).map(xy),
      priority: "RECOMMEND",
      summary: false,
    }),
    signal,
  });
  if (!res.ok) return null;
  const route = ((await res.json()) as KakaoDirections).routes?.[0];
  return route && route.result_code === 0 ? route : null;
}

async function kakaoResult(path: LatLng[], signal: AbortSignal) {
  const key = process.env.KAKAO_REST_API_KEY;
  if (!key) return null;
  const pathM = pathLengthM(path);
  // 경유지 때문에 카카오가 돌아가면 경유지를 절반으로 줄여 다시 묻는다(최대 3번).
  let count = waypointCount(pathM);
  let route: Awaited<ReturnType<typeof kakaoRoute>> = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    route = await kakaoRoute(path, count, key, signal);
    if (!route) return null;
    if (!detoured(route.summary?.distance ?? 0, pathM) || count === 0) break;
    count = Math.floor(count / 2);
  }
  if (!route) return null;
  const roads = (route.sections ?? []).flatMap((s) => s.roads ?? []);
  const traffic = trafficFromKakaoRoads(path, roads);
  // 카카오 길과 겹치는 표본은 카카오 소통 상태, 안 겹치는 표본은 ITS 상태로 채운다(2026-11-14).
  // 경유지 30개여도 카카오가 우리 코스의 약 10%는 다른 길로 가서, 그 구간은 ITS가 더 맞다.
  const its = itsResult(path);
  const itsAt = (p: LatLng) => {
    let best = 0;
    let bd = Infinity;
    for (const s of its.samples) {
      const d = (s.lat - p.lat) ** 2 + (s.lng - p.lng) ** 2;
      if (d < bd) {
        bd = d;
        best = s.state;
      }
    }
    return best;
  };
  const samples = traffic.samples.map((s) => (s.state > 0 ? s : { ...s, state: itsAt(s) }));
  const known = samples.filter((s) => s.state > 0).length;
  const jam = samples.filter((s) => s.state === 1 || s.state === 2).length;
  const coverage = samples.length ? known / samples.length : 0;
  // 소요시간: 카카오 경로가 우리 코스와 거의 같으면(겹침 90% 이상, 거리 차 5% 이내) 카카오 실시간 시간을 쓴다.
  // 카카오 시간은 도로별 시간의 합이라 경유지 덧붙임이 없다. 다른 길이면 시간도 다른 길의 것이라 ITS 계산을 쓴다.
  // 근거(2026-11-14 토 11시): 같은 204km 코스에서 교통 없음 187분, 굽이 계산 211분, 카카오 실시간 281분.
  const kakaoM = route.summary?.distance ?? 0;
  const kakaoSec = route.summary?.duration;
  const sameRoute = traffic.coverage >= 0.9 && pathM > 0 && Math.abs(kakaoM - pathM) / pathM <= 0.05;
  return {
    samples,
    durationSec: sameRoute && typeof kakaoSec === "number" ? Math.round(kakaoSec) : its.durationSec,
    durationSource: sameRoute && typeof kakaoSec === "number" ? "kakao" : "its",
    distanceM: Math.round(traffic.distanceM),
    jamRatio: coverage >= 0.3 ? jam / samples.length : null,
    coverage,
    kakaoCoverage: traffic.coverage,
    source: "kakao+its",
  };
}

export async function POST(req: NextRequest) {
  let body: { path?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  if (!isValidPath(body.path)) {
    return NextResponse.json({ error: "path({lat,lng} 배열)가 필요합니다" }, { status: 400 });
  }
  const path = body.path;
  const keyOf = cacheKey(path);
  const hit = cache.get(keyOf);
  if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json(hit.body);

  let result: unknown = null;
  try {
    result = await kakaoResult(path, req.signal);
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      return new NextResponse(null, { status: 499 });
    }
    result = null;
  }
  if (!result) result = itsResult(path);
  if (cache.size > 500) cache.clear();
  cache.set(keyOf, { at: Date.now(), body: result });
  return NextResponse.json(result);
}
