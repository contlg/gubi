import type { CourseFitness } from "@/lib/road-fitness";

export interface LatLng {
  lat: number;
  lng: number;
}

export interface Place {
  name: string;
  address: string;
  coord: LatLng;
  /** 경유지 체류 시간(분) — 총 소요시간·예산 판정에 반영. 없으면 0 */
  dwellMin?: number;
  /** 현재 위치–이 장소 직선거리(m) — 위치 기준 검색일 때만 채워진다 */
  distanceM?: number;
  /** 구글 평점(1~5) — 장소 탭에서 별점 표시용 */
  rating?: number;

  ratingCount?: number;
}

export interface CurveMetrics {
  /** 구간 전체 방위각 변화 누적(도) / km — 와인딩 지수 */
  degPerKm: number;

  hardCorners: number;
}

export const WAYPOINT_TYPES = [
  "관광명소",
  "전망대",
  "해변",
  "강/호수",
  "카페",
  "맛집",
  "휴게소",
] as const;
export type WaypointType = (typeof WAYPOINT_TYPES)[number];

/** 드라이브 종류 — 선택하면 해당 성격의 경로에 가중치가 실린다 */
export const DRIVE_STYLES = [
  "와인딩",
  "산길",
  "해안도로",
  "강변도로",
  "직선도로",
] as const;
export type DriveStyle = (typeof DRIVE_STYLES)[number];

export const AVOID_OPTIONS = ["toll", "motorway"] as const;
export type AvoidOption = (typeof AVOID_OPTIONS)[number];

/**
 * 해안도로 우회 강도 — 해안을 타려고 기준(최적) 경로 대비 얼마나 더
 * 돌아가도 되는지. 목적지형에서 해안 변형 후보의 시간 상한으로 쓰인다.
 */
export const COAST_INTENSITIES = ["light", "medium", "max"] as const;
export type CoastIntensity = (typeof COAST_INTENSITIES)[number];
/**
 * 강도별 허용 우회 배율 — 기준(최적) 시간 × (1 + 값)까지만 해안 우회 허용.
 * 한국 해안도로는 최적 경로보다 원래 +70~130% 느린 지방도라, 상한을
 * 현실값으로 잡아야 슬라이더가 의미가 있다(너무 빡빡하면 항상 제외됨).
 */
export const COAST_DETOUR_CAP: Record<CoastIntensity, number> = {
  light: 0.4,
  medium: 0.8,
  max: Infinity,
};

/** 날씨/노을 조건이 점수 가중치에 주는 보정 계수 */
export interface ConditionAdjustments {
  /** 와인딩(재미) 가중치 배율 — 비/결빙이면 < 1 */
  funMul: number;
  /** 산길(봉우리) 가점 배율 — 안개/결빙이면 0 */
  mountainMul: number;
  /** 바다 가점 배율 — 노을 시간대면 > 1 */
  seaMul: number;
}

/** 해안 구간 샘플 — tier 2: 바닷가(해안선 250m 이내), tier 1: 바다뷰(250~800m) */
export interface CoastSample {
  lat: number;
  lng: number;
  tier: 1 | 2;
}

export interface RouteMetrics {
  /** 바닷가에 붙은(해안선 250m 이내) 구간 비율 (0~1) */
  seaShoreRatio: number;
  /** 바다가 보이는(해안선 250~800m) 구간 비율 (0~1) */
  seaViewRatio: number;
  /** 해안 구간 샘플 좌표 — 지도 색칠용 */
  coast: CoastSample[];
  /** 강 300m 이내 구간 비율 (0~1) */
  riverRatio: number;
  /** 경로 주변 산봉우리 수 / 경로 km */
  peaksPerKm: number;

  signalsPerKm: number;
  /** 터널 구간 길이 / 경로 길이 (0~1 근사) */
  tunnelRatio: number;

  bridgeCount: number;
}

export interface RouteCandidate {
  fitness?: CourseFitness;
  /** OSM 기반 도로/풍경 지표 — 비동기 로딩이라 없을 수 있음 */
  metrics?: RouteMetrics;
  /** 스타일 변형으로 생성된 후보 표시 (지표 로딩 전 점수 선반영 + 지도 색상) */
  styleTag?: DriveStyle;
  /** 이 경로가 경유하는 장소들 (순환형 앵커, 사용자가 추가한 경유지) */
  waypoints?: Place[];

  label: string;
  durationSec: number;
  distanceM: number;
  tollFare: number;

  fuelCost: number;
  curve: CurveMetrics;

  path: LatLng[];
  /** 지도 강조용 명품 구간(와인딩 고갯길 등) — 이름 배지 + 강조선 */
  highlights?: { name: string; path: LatLng[] }[];
  /** 시간·거리가 로컬 OSM 추정치 (카카오 실측 검증 실패/생략) */
  estimated?: boolean;
  /** 후보 경로를 만든 엔진 — 실제 주행 시작 시 카카오 최종 경로로 다시 확인한다. */
  routeSource?: "local-its" | "kakao";
  /** 로컬 도로 데이터에 통행료 속성이 없어 아직 금액을 확정하지 못한 후보 */
  tollUnknown?: boolean;
  /** 로컬 OSM 실측 배지 ("무신호 약 23km 연속" 등) — 특별한 코스에만 */
  badges?: string[];
  /** 검색 시점 실시간 정체(정체+지체) 구간 비율 0~1 — ITS 또는 카카오 */
  jamRatio?: number;
  /** 종단면(고도 그래프) — DEM 데이터가 있을 때만 */
  elevation?: {
    samples: number[];
    stepM: number;
    maxEle: number;
    minEle: number;
    gainM: number;
  };
}
