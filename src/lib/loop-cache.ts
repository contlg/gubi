import "server-only";

import { join } from "node:path";

import { PersistCache } from "@/lib/persist-cache";
import type { LatLng, RouteCandidate } from "@/lib/types";
import { fitnessGenerationId } from "@/lib/road-fitness-data";
import { FITNESS_SCHEMA_VERSION } from "@/lib/road-fitness";

/**
 * 코스추천(loop) 결과 캐시 — 확장(유저 증가) 대비 서버 CPU 절약이 목적.
 *
 * 코스추천 1건은 로컬 A*로 CPU 2~7초를 쓰는데(스케줄러가 동시 3건만 처리),
 * 결과인 "어느 명품길을 달릴까"는 시간대별로 거의 안 변한다. 유저는 위치·
 * 예산·스타일이 지역 단위로 뭉치므로, 출발지 좌표를 ~1km 셀로 스냅해 **이웃
 * 요청끼리 계산을 공유**한다. 같은 셀·같은 예산/스타일이면 워커를 안 거치고
 * 즉답 – 서버 한 대로 훨씬 많은 유저를 받는다.
 *
 * 고정 경유지(fixed)가 있는 개인화 요청은 캐시하지 않는다(적중률이 낮고 키가
 * 복잡해진다) — 대다수인 무-고정 요청만 캐시한다.
 */
export interface LoopCacheValue {
  candidates: RouteCandidate[];
  notes: string[];
}

const TTL_MS = 60 * 60 * 1000; // 1시간 — ETA 신선도와 적중률의 절충
const CELL = 0.01; // ≈1.1km 격자 — 이 안에선 도달 가능한 명품길이 사실상 동일
const BUDGET_BUCKET_SEC = 600; // 10분 버킷 — 유저는 대개 라운드 예산을 고른다

const cache = new PersistCache<LoopCacheValue>(
  join(process.cwd(), "data/cache/loop.json"),
  TTL_MS,
  3000,
);

const snap = (v: number) => (Math.round(v / CELL) * CELL).toFixed(2);

/**
 * 캐시 키 — 출력에 영향 주는 입력을 정규화해 이웃끼리 공유되게 한다.
 * fixed가 있으면 null을 돌려 캐시를 건너뛰게 한다.
 */
export function loopCacheKey(input: {
  origin: LatLng;
  budgetSec: number;
  styles: string[];
  waypointTypes: string[];
  avoid: string[];
  hasFixed: boolean;
}): string | null {
  if (input.hasFixed) return null;
  const o = `${snap(input.origin.lat)},${snap(input.origin.lng)}`;
  const b = Math.round(input.budgetSec / BUDGET_BUCKET_SEC) * BUDGET_BUCKET_SEC;
  const s = [...input.styles].sort().join("|");
  const t = [...input.waypointTypes].sort().join("|");
  const a = [...input.avoid].sort().join("|");
  return `v3|fitness-${FITNESS_SCHEMA_VERSION}|${fitnessGenerationId()}|${o}|${b}|${s}|${t}|${a}`;
}

export function getCachedLoop(key: string): LoopCacheValue | undefined {
  return cache.get(key);
}

export function setCachedLoop(key: string, value: LoopCacheValue): void {
  cache.set(key, value);
}
