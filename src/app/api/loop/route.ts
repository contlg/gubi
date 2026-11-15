import { NextRequest, NextResponse } from "next/server";

import {
  parseAvoid,
  parseCoord,
  parseDriveStyles,
  parseWaypointTypes,
} from "@/lib/params";
import {
  getCachedLoop,
  loopCacheKey,
  setCachedLoop,
} from "@/lib/loop-cache";
import {
  isRoutingBusyError,
  runLoopRouting,
} from "@/lib/routing-worker-client";
import type { Place } from "@/lib/types";
import { fitnessGenerationId } from "@/lib/road-fitness-data";
import { loopCount, startLoopStage, withLoopTiming } from "@/lib/loop-timing";

/**
 * 고정(필수) 경유지 파싱. 신형은 JSON 배열 [{lng,lat,name,dwellMin}] — 이름의
 * 특수문자에 안전하고 체류시간(dwellMin)을 보존한다. 구형 "경도,위도,이름|…"
 * 문자열도 폴백 지원(북마크·구버전 호환). dwellMin은 candidate.waypoints까지
 * 그대로 흘러가 총 시간·예산 판정에 반영된다.
 */
function parseFixed(value: string | null): Place[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as {
        lng: number;
        lat: number;
        name?: string;
        dwellMin?: number;
      }[];
      const places: Place[] = [];
      for (const w of arr) {
        const lng = Number(w?.lng);
        const lat = Number(w?.lat);
        if (
          !Number.isFinite(lng) ||
          !Number.isFinite(lat) ||
          lng < -180 ||
          lng > 180 ||
          lat < -90 ||
          lat > 90
        )
          continue;
        const dwellMin = Number.isFinite(w.dwellMin)
          ? Math.min(24 * 60, Math.max(0, Math.round(w.dwellMin!)))
          : 30;
        places.push({
          name: String(w.name || "경유지").slice(0, 60),
          address: "",
          coord: { lat, lng },
          dwellMin,
        });
      }
      return places.slice(0, 3);
    } catch {
      // 손상 JSON — 아래 구형 파서로 폴백
    }
  }
  const places: Place[] = [];
  for (const part of value.split("|")) {
    const [lngStr, latStr, ...nameParts] = part.split(",");
    const lng = Number(lngStr);
    const lat = Number(latStr);
    if (
      !Number.isFinite(lng) ||
      !Number.isFinite(lat) ||
      lng < -180 ||
      lng > 180 ||
      lat < -90 ||
      lat > 90
    )
      continue;
    places.push({
      name: (nameParts.join(",") || "경유지").slice(0, 60),
      address: "",
      coord: { lat, lng },
      dwellMin: 30,
    });
  }
  return places.slice(0, 3);
}

export async function GET(req: NextRequest) {
  return withLoopTiming(req.headers.get("x-fundrive-loop-timing-id"), "http", async () => {
    const end = startLoopStage("http.total");
    try {
      const response = await handleGet(req);
      end?.({ status: response.status });
      return response;
    } finally {
      end?.();
    }
  });
}

async function handleGet(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const origin = parseCoord(params.get("origin"));
  const budgetSec = Number(params.get("budget"));
  if (!origin || !Number.isFinite(budgetSec) || budgetSec <= 0 || budgetSec > 24 * 3600) {
    return NextResponse.json(
      { error: "origin(경도,위도), budget(초) 파라미터가 필요합니다" },
      { status: 400 },
    );
  }

  try {
    const styles = parseDriveStyles(params.get("styles"));
    const fixed = parseFixed(params.get("waypoints"));
    const dwellSec = fixed.reduce(
      (sum, place) => sum + Math.max(0, place.dwellMin ?? 0) * 60,
      0,
    );
    const drivingBudgetSec = budgetSec - dwellSec;
    if (drivingBudgetSec < 30 * 60) {
      return NextResponse.json(
        {
          error:
            dwellSec >= budgetSec
              ? "경유지 체류시간이 전체 시간 예산보다 길어요. 체류시간을 줄이거나 예산을 늘려주세요."
              : "체류시간을 빼면 운전 시간이 30분보다 짧아요. 예산을 늘려주세요.",
        },
        { status: 400 },
      );
    }
    const avoid = parseAvoid(params.get("avoid"));
    const waypointTypes = parseWaypointTypes(params.get("types"));

    // 지역 결과 캐시 — 같은 셀·예산/스타일 요청은 워커(CPU 2~7s)를 건너뛴다.
    // 고정 경유지가 있으면 loopCacheKey가 null을 돌려 캐시를 건너뛴다.
    const bypassCache = process.env.NODE_ENV !== "production" &&
      req.headers.get("x-fundrive-cache-bypass") === "1";
    const cacheKey = bypassCache ? null : loopCacheKey({
      origin,
      budgetSec,
      styles,
      waypointTypes,
      avoid,
      hasFixed: fixed.length > 0,
    });
    const endCache = startLoopStage("http.cache", { budgetSec });
    const entry = cacheKey ? getCachedLoop(cacheKey) : undefined;
    // A worker can finish with an older data snapshot after the HTTP cache key
    // was generated. Reject such entries even if they were stored under this key.
    const currentGeneration = entry ? fitnessGenerationId() : undefined;
    const cached = entry?.candidates.every((c) => c.fitness?.generationId === currentGeneration)
      ? entry : undefined;
    loopCount(cached ? "loopCacheHit" : cacheKey ? "loopCacheMiss" : "loopCacheBypass");
    endCache?.({ hit: !!cached, bypass: !cacheKey });
    const { candidates, notes } =
      cached ??
      (await runLoopRouting(
        {
          origin,
          drivingBudgetSec,
          totalBudgetSec: budgetSec,
          dwellSec,
          options: { avoid, waypointTypes, fixed, styles },
        },
        req.signal,
      ));
    if (candidates.length === 0) {
      return NextResponse.json(
        { error: "조건에 맞는 루프를 찾지 못했습니다. 시간이나 필터를 조절해보세요." },
        { status: 404 },
      );
    }
    // 성공 결과만 캐시(빈 결과는 쿼터·일시장애일 수 있어 저장 안 함).
    // 캐시 히트였으면 다시 쓰지 않는다.
    if (cacheKey && !cached) setCachedLoop(cacheKey, { candidates, notes });
    // 예전엔 "추정 과반이면 신뢰도 낮음" 배너를 띄웠지만, 이제 교외·시골
    //   경로는 실측 피팅된 로컬 추정(±9%)을 일부러 신뢰하고 검증을 생략한다
    //   (카카오 절약 + 검색 즉답). 추정이 기본 상태가 됐으므로 배너는 노이즈
    //   — 카드의 '추정' 칩으로 충분하다.
    return NextResponse.json({ candidates, notes });
  } catch (e) {
    if (isRoutingBusyError(e)) {
      return NextResponse.json(
        { error: e.message },
        { status: 429, headers: { "Retry-After": "3" } },
      );
    }
    if (e instanceof DOMException && e.name === "AbortError") {
      return new NextResponse(null, { status: 499 });
    }
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "루프 생성 실패" },
      { status: 502 },
    );
  }
}
