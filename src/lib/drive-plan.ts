
/** 코스 추천에서 주행 화면으로 넘기는 이름 있는 경유지. */
export interface DrivePlanVia {
  name: string;
  lat: number;
  lng: number;
  /** 이 경유지에서 머무를 예정 시간(분). 0/생략은 체류 없음. */
  dwellMin?: number;
}

interface DrivePlanBase {
  label: string;
  /** 운전과 경유지 체류를 합친 전체 예상 시간(초). */
  durationSec: number;
  distanceM: number;
  /** 추천 경로 생성 엔진. local-its면 출발 시 카카오로 한 번 최종 확인한다. */
  routeSource?: "local-its" | "kakao";
}

/** 플래너가 Gubi에 넘기는 즉시 전달 객체. */
export interface DrivePlanHandoff extends DrivePlanBase {
  path: string;
  vias: DrivePlanVia[];
}

/** 서버 저장·Gubi 세션에서 사용하는 주행 계획. */
export interface DrivePlan extends DrivePlanBase {
  ts: number;
  path?: string;
  vias?: DrivePlanVia[];
  /** 목적지 길찾기로 만든 계획(추천 코스가 아님). */
  standalone?: boolean;
}
