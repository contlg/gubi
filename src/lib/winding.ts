import "server-only";

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { speedCamCounts } from "@/lib/badges";
import { elevationAt } from "@/lib/elevation";
import { junctionCountNear } from "@/lib/localroute";
import { distanceM } from "@/lib/scoring/curvature";
import type { LatLng } from "@/lib/types";
import type { FitnessInventorySegment } from "@/lib/road-fitness";

/**
 * 와인딩(고갯길) 구간 — scripts/build-winding-from-osm.mjs 가 전국 OSM에서
 * 곡률 스캔으로 뽑은 로컬 데이터. pts는 기존 [lat,lng] 약 50m 샘플만 유지한다.
 * 노면·폭·방향 증거 경계는 pts를 늘리지 않고 evidence의 fromM/toM에
 * 별도 저장하며, fitness 색인이 이 폴리라인 거리에서 보간한다.
 */
export interface WindingSegment extends FitnessInventorySegment {
  name: string | null;
  hw: string;
  lenM: number;
  degPerKm: number;
  /** 경치 컨텍스트 — 물가(호수·강) 비율 0~1 */
  water?: number;
  /** 숲 비율 0~1 (한국 산길은 거의 1이라 변별력 낮음, 참고용) */
  forest?: number;
  /** 인근 전망대(tourism=viewpoint) 수 */
  view?: number;
  /** 1차선/폭 4.5m 미만 구간 비율 0~1 — 좁은 길 감점용 */
  narrow?: number;
  pts: [number, number][];
  /** 구간 최고 해발(m) — 런타임 DEM 조회 캐시 (segEleMax가 채움) */
  eleMax?: number;
  /** 실교차로 밀도(개/km) — 런타임 캐시 (segJuncPerKm이 채움) */
  juncPerKm?: number;
  /** 단속카메라 감점 배율 0~1 — 런타임 캐시 (segCamMul이 채움) */
  camMul?: number;
}

/** mtime 캐시 세그먼트 로더 — 와인딩/강변 재고가 같은 스키마를 쓴다 */
function segmentLoader(file: string): () => WindingSegment[] {
  let segs: WindingSegment[] | null = null;
  let mtimeSeen = -1;
  return () => {
    try {
      const mtime = statSync(file).mtimeMs;
      if (segs && mtime === mtimeSeen) return segs;
      segs = JSON.parse(readFileSync(file, "utf8")) as WindingSegment[];
      mtimeSeen = mtime;
    } catch {
      if (!segs) segs = [];
    }
    return segs;
  };
}

const loadSegments = segmentLoader(
  join(process.cwd(), "src/lib/data/winding-segments.json"),
);
/** 강변길 재고 — build-winding-from-osm.mjs --waterside 산출물 */
const loadRiverside = segmentLoader(
  join(process.cwd(), "src/lib/data/riverside-segments.json"),
);

/** 구간 중앙점 (폴리라인 중간 정점) */
export function segMid(s: WindingSegment): LatLng {
  const [lat, lng] = s.pts[Math.floor(s.pts.length / 2)];
  return { lat, lng };
}

/**
 * 도로급 신뢰도 — unclassified는 폭 좁은 농로·임도 가능성이 있어 감점.
 * (곡률 상위가 죄다 1차선 콘크리트길이면 드라이브 코스로 못 쓴다)
 */
const CLASS_WEIGHT: Record<string, number> = {
  primary: 1,
  secondary: 1,
  tertiary: 0.85,
  unclassified: 0.55,
};

/** 구간 최고 해발(m) — 폴리라인을 성기게 샘플해 DEM 조회, 결과는 캐시 */
function segEleMax(s: WindingSegment): number {
  if (s.eleMax !== undefined) return s.eleMax;
  let max = 0;
  const step = Math.max(1, Math.floor(s.pts.length / 8));
  for (let i = 0; i < s.pts.length; i += step) {
    const e = elevationAt({ lat: s.pts[i][0], lng: s.pts[i][1] });
    if (e !== null && e > max) max = e;
  }
  s.eleMax = max;
  return max;
}

/** 실교차로(차수≥3) 밀도(개/km) — 옆길·진입로가 많으면 흐름이 끊긴다 */
function segJuncPerKm(s: WindingSegment): number {
  if (s.juncPerKm !== undefined) return s.juncPerKm;
  let hits = 0;
  for (const [lat, lng] of s.pts) {
    if (junctionCountNear({ lat, lng }, 60) > 0) hits++;
  }
  s.juncPerKm = hits / Math.max(s.lenM / 1000, 0.1);
  return s.juncPerKm;
}

/**
 * 단속카메라 감점 배율 — 고정식 1대당 ×0.9(최대 5대까지 누적),
 * 구간단속이 걸려 있으면 ×0.35 (구간 내내 제한속도 = 와인딩 재미 없음).
 * 구간단속은 시·종점 카메라 2대를 다 지나야 실제로 단속된다 — 1대만
 * 스치는 건 교차점 통과(미시령옛길 시작점이 터널 구간단속 시점과 겹치는
 * 케이스)라 페널티를 주지 않는다.
 */
function segCamMul(s: WindingSegment): number {
  if (s.camMul !== undefined) return s.camMul;
  const cams = speedCamCounts(s.pts.map(([lat, lng]) => ({ lat, lng })));
  s.camMul =
    Math.pow(0.9, Math.min(cams.fixed, 5)) * (cams.section >= 2 ? 0.35 : 1);
  return s.camMul;
}

/**
 * 드라이브 코스 가치 점수 — 곡률 × 길이 보너스 × 도로급 × 경치 × 도로폭.
 * 물가(호반·강변) 와인딩은 최대 +60%, 전망대 인근 +15%/개(최대 3),
 * 절반 이상이 1차선이면 반토막(교행 스트레스는 드라이브 재미를 죽인다).
 * 고도 보너스 최대 +25%: 같은 곡률이면 평지 커브길보다 진짜 고개가 낫다
 * (해발 300m부터 가산, 1,000m에서 만점 — DEM 없으면 0).
 * 교차로 밀도 페널티는 곱연산 — 컷오프로 하면 북악스카이웨이(5.4개/km,
 * 곡률 594°/km) 같은 도심 보석이 마을길과 같이 죽는다. 곡률이 압도적이면
 * 살아남고, 곡률까지 평범한 근교 생활도로(청군로류)만 가라앉는 구조.
 * 단속카메라 페널티: 경찰청 표준데이터 기준(구간단속은 사실상 배제급).
 */
export function segQuality(s: WindingSegment): number {
  const scenery =
    1 + 0.6 * (s.water ?? 0) + 0.15 * Math.min(s.view ?? 0, 3);
  const widthMul = (s.narrow ?? 0) > 0.5 ? 0.5 : 1;
  const eleMul =
    1 + 0.25 * Math.min(Math.max(segEleMax(s) - 300, 0) / 700, 1);
  const juncMul = 1 / (1 + segJuncPerKm(s) / 6);
  return (
    s.degPerKm *
    Math.log2(s.lenM / 1000 + 1) *
    (CLASS_WEIGHT[s.hw] ?? 0.5) *
    scenery *
    widthMul *
    eleMul *
    juncMul *
    segCamMul(s)
  );
}

/** 카드/라벨용 경치 태그 — "호반", "전망" 등 (숲은 전국 공통이라 물가 없을 때만) */
export function segSceneryTags(segs: WindingSegment[]): string[] {
  const avg = (f: (s: WindingSegment) => number) =>
    segs.reduce((a, s) => a + f(s), 0) / Math.max(segs.length, 1);
  const tags: string[] = [];
  if (avg((s) => s.water ?? 0) >= 0.25) tags.push("호반·물가");
  if (segs.some((s) => (s.view ?? 0) > 0)) tags.push("전망대");
  if (tags.length === 0 && avg((s) => s.forest ?? 0) >= 0.8) tags.push("숲길");
  return tags;
}

/**
 * 예산 반경 안의 구간을 골라 방향·위치가 겹치지 않게 최대 count개.
 * targetDistM: 루프 시간이 예산에 차도록 "이 정도 떨어진" 구간을 선호
 * (가까운 명품길만 고르면 3시간 예산에 1시간 반 루프가 나온다).
 */
function pickSegments(
  candidates: WindingSegment[],
  quality: (s: WindingSegment) => number,
  origin: LatLng,
  maxDistM: number,
  targetDistM: number,
  count: number,
): WindingSegment[] {
  const MIN_APART_M = 8000; // 선택된 구간끼리 최소 이격 — 같은 길 중복 방지
  const pool = candidates
    .map((s) => ({ s, mid: segMid(s) }))
    .filter((e) => distanceM(origin, e.mid) <= maxDistM)
    .map((e) => {
      const d = distanceM(origin, e.mid);
      // 예산 적합도(0~1): 목표 거리에서 멀어질수록 감소
      const fit = 1 / (1 + Math.abs(d - targetDistM) / Math.max(targetDistM, 1));
      return { ...e, score: quality(e.s) * (0.4 + 0.6 * fit) };
    })
    .sort((a, b) => b.score - a.score);

  const picked: typeof pool = [];
  for (const e of pool) {
    if (picked.length >= count) break;
    if (picked.some((p) => distanceM(p.mid, e.mid) < MIN_APART_M)) continue;
    picked.push(e);
  }
  return picked.map((e) => e.s);
}

/**
 * 와인딩은 산길만 — 평지 굽잇길(간척지·논길·하천부지)은 곡률이 높아도
 * 와인딩의 맛이 없다 (유저 지시). 구간 최고 해발이 이 밑이면 제외.
 * 250m: 진짜 고개는 대부분 300m+, 도심 보석 북악스카이웨이(~290m)는 살고
 * 평야 굽잇길(<100m)은 확실히 죽는 선.
 */
const WINDING_MIN_ELE_M = 250;
const isMountain = (s: WindingSegment) => segEleMax(s) >= WINDING_MIN_ELE_M;

export function findWindingSegments(
  origin: LatLng,
  maxDistM: number,
  targetDistM: number,
  count: number,
): WindingSegment[] {
  return pickSegments(
    loadSegments().filter(
      (s) => s.lenM >= 3000 && s.degPerKm >= 150 && isMountain(s),
    ),
    segQuality,
    origin,
    maxDistM,
    targetDistM,
    count,
  );
}

/**
 * 강변길 가치 점수 — 곡률이 아니라 '물을 얼마나 오래 끼고 달리나'가 핵심.
 * 길이 주도 + 굽이치는 강길 보너스(최대 +50%), 도로급·폭·교차로 밀도·
 * 단속카메라 페널티는 와인딩과 공유. ×100은 와인딩 점수와 자릿수를 맞춰
 * 페어 스코어 등에서 섞여도 이상해지지 않게 하는 스케일.
 */
export function riversideQuality(s: WindingSegment): number {
  const curveBonus = 1 + Math.min(s.degPerKm / 300, 1) * 0.5;
  const widthMul = (s.narrow ?? 0) > 0.5 ? 0.5 : 1;
  const juncMul = 1 / (1 + segJuncPerKm(s) / 6);
  return (
    100 *
    Math.log2(s.lenM / 1000 + 1) *
    (CLASS_WEIGHT[s.hw] ?? 0.5) *
    curveBonus *
    widthMul *
    juncMul *
    segCamMul(s)
  );
}

/** 강변길 재고 원본 — 포토스팟 등 경로 근접 질의용 */
export function allRiversideSegments(): WindingSegment[] {
  return loadRiverside();
}

export function findRiversideSegments(
  origin: LatLng,
  maxDistM: number,
  targetDistM: number,
  count: number,
): WindingSegment[] {
  return pickSegments(
    loadRiverside(),
    riversideQuality,
    origin,
    maxDistM,
    targetDistM,
    count,
  );
}

/** 목적지형용: 경로 회랑(부풀린 bbox) 안의 좋은 구간 */
export function findWindingAlong(
  path: LatLng[],
  corridorM: number,
  count: number,
): WindingSegment[] {
  const MIN_LEN_M = 3000;
  const MIN_CURV = 150;
  const step = Math.max(1, Math.floor(path.length / 40));
  const picked: { s: WindingSegment; mid: LatLng }[] = [];
  const pool = loadSegments()
    .filter((s) => s.lenM >= MIN_LEN_M && s.degPerKm >= MIN_CURV && isMountain(s))
    .map((s) => ({ s, mid: segMid(s) }))
    .filter((e) => {
      for (let i = 0; i < path.length; i += step)
        if (distanceM(path[i], e.mid) <= corridorM) return true;
      return false;
    })
    .sort((a, b) => segQuality(b.s) - segQuality(a.s));
  for (const e of pool) {
    if (picked.length >= count) break;
    if (picked.some((p) => distanceM(p.mid, e.mid) < 8000)) continue;
    picked.push(e);
  }
  return picked.map((e) => e.s);
}
