import type { NavCam, NavManeuver, NavNarrow } from "@/lib/navguide";
import type { LatLng } from "@/lib/types";

/**
 * 자체 내비 클라이언트 엔진 — GPS 픽스를 받아 경로 진행도를 스냅하고
 * 실제 내비처럼 안내 이벤트를 낸다. React 밖의 순수 로직 (테스트 용이).
 *
 * - 스냅: 전방 편향 윈도 + 진행방향 가중 — 같은 도로를 오가는 왕복 코스에서
 *   반대 방향 구간에 붙는 오스냅을 이중으로 막는다. 표시용 좌표는 경로 위
 *   투영점(실내비처럼 차가 선 위를 탄다).
 * - 회전 음성 3단계(고속 1km/원거리 550m/직전 150m) + 연속 회전 연결 멘트
 *   + 단속카메라(음성+비프) + 도착.
 * - 추측항법(coast): 터널 등 GPS 공백에도 마지막 속도로 경로를 따라 진행,
 *   안내는 누적거리 기반이라 그대로 나온다.
 * - 이탈: 45m 밖 연속 4픽스 – 재탐색 요청 이벤트 (호출은 화면 쪽이).
 * - ETA: 도로급 속도 프로파일 적분 × 서버 보정 × 실주행 페이스 보정(EMA).
 */

export interface NavGuidanceData {
  path: LatLng[];
  maneuvers: NavManeuver[];
  cams: NavCam[];
  narrows?: NavNarrow[];
  speeds: { i: number; kmh: number; its?: boolean }[];
  calibMul: number;
  /** 제한속도 런렝스 — [{i, kmh, tagged}] */
  limits?: { i: number; kmh: number; tagged: boolean }[];

  roadRuns?: { fromM: number; toM: number; roadName?: string; roadNo?: string }[];
  roadMatch?: { coverage: number; continuity: number; meanDistanceM: number };
  totalM: number;
}

export interface NavState {

  along: number;

  offM: number;
  offRoute: boolean;
  arrived: boolean;
  remainM: number;
  remainSec: number;
  /** 남은 구간의 실시간 지연(초) — 정체반영 ETA − 자유주행 ETA. 0=원활 */
  delaySec: number;
  /** 지도 표시용 위치 — 경로 위 스냅(이탈 시 원좌표, 코스트 시 경로 보간) */
  pos: LatLng;
  /** 현재 경로 세그먼트 방향(°) — GPS 공백 코스트 시 지도 회전용 */
  pathBearing: number | null;

  next: { m: NavManeuver; distM: number } | null;
  /** 다음 단속카메라 (1km 안일 때만) */
  cam: { c: NavCam; distM: number } | null;
  /** 구간단속 진행 중 — 실시간 평균속도 표시용 (밖이면 null) */
  section: { avgKmh: number; limitKmh: number } | null;

  currentRoad: { name?: string; no?: string } | null;
  /** 현재 도로 제한속도 km/h (0=미상) */
  limitKmh: number;
  /** 제한속도가 OSM 태그 확정값인지(true) 도로급 추정인지(false) */
  limitTagged: boolean;
  /** 이번 픽스에서 말할 멘트들 (순서대로) */
  speak: string[];

  beep: boolean;
  /** 이탈 확정 — 화면이 재탐색을 호출해야 함 (픽스당 1회만 true) */
  needReroute: boolean;
}

const OFF_ROUTE_M = 45;
const OFF_ROUTE_FIXES = 3;
/** 이만큼 크게 벗어나면 오스냅 여지가 없으니 더 빨리(2픽스) 재탐색 */
const OFF_ROUTE_FAR_M = 120;
const CHAIN_M = 350; // 이 안에 다음 회전이 또 있으면 연결 멘트("이어서 곧 …")
/** 회전 안내 거리 — 속도(도달시간)에 맞춰 스케일. [바닥, 천장] m */
const NEAR_S = 9, NEAR_MIN = 90, NEAR_MAX = 300; // "잠시 후" ≈ 9초 전
const FAR_S = 26, FAR_MIN = 280, FAR_MAX = 700; // " 앞" ≈ 26초 전
const FAR1K_S = 42, FAR1K_MIN = 760, FAR1K_MAX = 1300; // 고속 "1km 앞" ≈ 42초 전
/** 과속 경고 — 카메라 제한속도를 이만큼(km/h) 넘으면 "초과했습니다" */
const CAM_OVER_MARGIN = 10;
/** 상시 과속 경고 — 도로 제한속도(OSM 확정값)를 이만큼 넘으면. 반복은 45s 억제 */
const ARRIVE_M = 45;
const CAM_WARN_M = 650;
const CAM_BEEP_M = 320;
const NARROW_WARN_M = 250; // 도로 좁아짐 사전 안내 거리
/** 방향 불일치 스냅 페널티 최대치(m 환산) — 왕복 도로 반대편(180°)이면 +40m */
const HEADING_PEN_M = 40;
/** 이탈 재탐색을 허용하는 최소 실지면 속도(m/s ≈ 9km/h) — 이 이상이면 '주행 중'
 *  으로 보고 재탐색. 정차 지터는 벡터 EMA가 이보다 작게 나와 걸러진다. */
const REROUTE_MIN_MPS = 2.5;

function distM(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * kx);
}
function bearing(a: LatLng, b: LatLng): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return (Math.atan2((b.lng - a.lng) * kx, (b.lat - a.lat) * 111_320) * 180) / Math.PI;
}
const angDiff = (a: number, b: number) => {
  const d = Math.abs(((a - b + 540) % 360) - 180);
  return d;
};

export const MANEUVER_LABEL: Record<NavManeuver["type"], string> = {
  left: "좌회전",
  right: "우회전",
  "slight-left": "좌측 방향",
  "slight-right": "우측 방향",
  "sharp-left": "좌회전",
  "sharp-right": "우회전",
  uturn: "유턴",
  "keep-left": "왼쪽 방향",
  "keep-right": "오른쪽 방향",
  "fork-left": "좌측 갈림길",
  "fork-right": "우측 갈림길",
  "roundabout-left": "회전교차로에서 좌측 출구",
  "roundabout-right": "회전교차로에서 우측 출구",
  overpass: "고가도로",
  underpass: "지하차도",
  tunnel: "터널",
  arrive: "목적지",
};

const STRUCT_TYPES = new Set<NavManeuver["type"]>(["overpass", "underpass", "tunnel"]);

/** 음성용 거리 — "300미터" / "1.2킬로미터" */
function speakDist(m: number): string {
  if (m >= 950) return `${(Math.round(m / 100) / 10).toFixed(1).replace(/\.0$/, "")}킬로미터`;
  return `${Math.round(m / 50) * 50}미터`;
}

export class NavEngine {
  path: LatLng[] = [];
  private cum: number[] = [];
  /** 자유주행(정체 미반영) 누적초 프리픽스 — 실시간 지연량 계산 기준 */
  private baseCum: number[] = [];
  /** 예상 누적 소요초 — 실시간 정체 배율이 반영된 유효값(ETA·pace 기준) */
  private secCum: number[] = [];
  /** 구간별 기본 소요초(정체 미반영) — 정체 갱신 시 여기에 배율만 곱해 재적분 */
  private segBaseSec: number[] = [];
  /** 직전 정체 배율 — 앵커만 갱신될 때 재적분에 재사용 */
  private lastFac: number[] | null = null;
  /** 카카오 실측 총 소요초 앵커 — secCum 총합을 이 값에 맞춰 균등 스케일해
   *  자체 속도모델의 ETA를 카카오 내비와 일치시킨다(없으면 모델값 그대로). */
  private anchorSec: number | null = null;
  maneuvers: NavManeuver[] = [];
  cams: NavCam[] = [];
  narrows: NavNarrow[] = [];
  limits: { i: number; kmh: number; tagged: boolean }[] = [];
  roadRuns: { fromM: number; toM: number; roadName?: string; roadNo?: string }[] = [];
  totalM = 0;

  private idx = 0; // 현재 스냅 세그먼트
  private along = 0;
  private offCount = 0;
  private offRoute = false;
  private arrived = false;
  private spoken = new Set<string>();
  private started = false;
  /** 시작 멘트를 카카오 앵커 확보까지 미룬 틱 수(최대 몇 틱 후 모델값으로 발화) */
  private startWait = 0;
  // 실주행 페이스 (추측항법·ETA 보정)
  private speedMps = 0;
  private lastTs = 0;
  private paceRatio = 1;
  // ETA 안정화 — 구간별 비(노이즈 큼) 대신 누적 실제/예상 시간의 비.
  // 감쇠 0.997로 오래된 구간을 천천히 잊어 ~수분 창처럼 동작(널뛰기 방지).
  private paceActual = 0;
  private paceExpect = 0;
  /** 마지막 실픽스 이후 추측항법으로 간 거리 — 폭주 방지 캡 */
  private coastedM = 0;
  /** 구간단속 진행 상태 — 시점 게이트 통과 시 시작, 종점에서 평균 계산 */
  private secStart: { along: number; ts: number; limit: number } | null = null;
  /** 상시 과속 경고 마지막 발화 시각(ms) — 반복 억제 */
  /** 실지면 속도 벡터 EMA(m/s) — 이탈 재탐색 게이트용. 경로 투영이 아닌 실
   *  GPS 변위라, 경로에서 갈라져 달릴 때도 살아있다. 벡터라서 정차 중 지터는
   *  상쇄되어 작게, 실주행은 방향이 지속돼 크게 나온다. */
  private lastRealPos: LatLng | null = null;
  private lastRealTs = 0;
  private velN = 0;
  private velE = 0;

  constructor(data: NavGuidanceData) {
    this.load(data);
  }

  load(data: NavGuidanceData) {
    this.path = data.path;
    this.maneuvers = data.maneuvers;
    this.cams = data.cams;
    this.narrows = data.narrows ?? [];
    this.limits = data.limits ?? [];
    this.roadRuns = data.roadRuns ?? [];
    this.totalM = data.totalM;
    this.cum = [0];
    for (let i = 1; i < data.path.length; i++) {
      this.cum.push(this.cum[i - 1] + distM(data.path[i - 1], data.path[i]));
    }
    // 예상 소요시간 누적(초) — 속도 표본 구간별 적분 × 보정.
    // 구간별 기본 소요초를 따로 보관해, 실시간 정체는 setTraffic에서 배율만
    // 곱해 재적분한다(위치 스냅은 거리 cum 기반이라 영향 없음).
    const sp = data.speeds.length > 0 ? data.speeds : [{ i: 0, kmh: 50 }];
    // calibMul·kmh가 서버 응답에서 누락/비유한값으로 들어오면(무검증 any
    // 통과·구버전 세션 복원 등) seg가 NaN이 되어 ETA 전체가 "NaN분"으로
    // 오염된다. 단일 관문인 여기서 유한·양수로 소독한다.
    const calibMul =
      Number.isFinite(data.calibMul) && data.calibMul > 0 ? data.calibMul : 1;
    this.segBaseSec = [];
    let kmh = sp[0].kmh;
    for (let i = 1, p = 0; i < data.path.length; i++) {
      while (p < sp.length - 1 && sp[p + 1].i <= i - 1) {
        p++;
        kmh = sp[p].kmh;
      }
      // ITS 값은 이미 현재 통행속도다. 도로급 freeflow 표본에만 기존
      // 교차로/시간대 보정을 적용해 혼합 커버리지에서도 이중 보정을 피한다.
      const safeKmh = Number.isFinite(kmh) && kmh > 0 ? kmh : 50;
      const seg =
        ((this.cum[i] - this.cum[i - 1]) / (Math.max(safeKmh, 5) / 3.6)) *
        (sp[p].its ? 1 : calibMul);
      this.segBaseSec.push(seg);
    }
    // 자유주행 누적초 프리픽스(불변) — 실시간 지연 = 정체반영 ETA − 이것
    this.baseCum = [0];
    for (let i = 0; i < this.segBaseSec.length; i++)
      this.baseCum.push(this.baseCum[i] + this.segBaseSec[i]);
    // 새 경로 — 이전 앵커/배율 폐기(route-traffic가 현재 경로 실측값으로 재설정)
    this.anchorSec = null;
    this.lastFac = null;
    this.startWait = 0;
    this.rebuildSecCum(null);
    this.idx = 0;
    this.along = 0;
    this.offCount = 0;
    this.offRoute = false;
    this.spoken = new Set();
    this.lastTs = 0;
    this.coastedM = 0;
    this.secStart = null;
    // 새 경로(재탐색)는 아직 도착 전 — 도착 근처에서 이탈–재탐색 시 이전
    // arrived=true가 남아 새 경로를 즉시 "도착" 처리하던 버그 차단.
    this.arrived = false;
  }

  /** segBaseSec × 정체배율 – secCum 프리픽스 재적분 (fac 없으면 배율 1).
   *  anchorSec가 있으면 총합을 그 값(카카오 실측 소요초)에 맞춰 균등 스케일해
   *  구간별 형상은 유지한 채 ETA 총량을 카카오와 일치시킨다. */
  private rebuildSecCum(fac: number[] | null) {
    this.lastFac = fac;
    this.secCum = [0];
    for (let i = 0; i < this.segBaseSec.length; i++) {
      this.secCum.push(this.secCum[i] + this.segBaseSec[i] * (fac ? fac[i] : 1));
    }
    const total = this.secCum[this.secCum.length - 1];
    if (this.anchorSec != null && total > 0) {
      const k = this.anchorSec / total;
      for (let i = 0; i < this.secCum.length; i++) this.secCum[i] *= k;
    }
  }

  /** 카카오 실측 소요초로 ETA를 앵커링(재적분). null이면 모델값으로 되돌림. */
  setAnchor(sec: number | null | undefined) {
    this.anchorSec = typeof sec === "number" && sec > 0 ? sec : null;
    this.rebuildSecCum(this.lastFac);
  }

  /**
   * 실시간 교통 반영 — 카카오 traffic_state 샘플({lat,lng,state})을 받아
   * 경로 구간별 통행시간 배율로 환산해 ETA에 녹인다. 앞쪽 정체를 미리 반영해
   * paceRatio(현재까지의 실측 페이스)만으로는 못 보던 "전방 밀림"을 예측한다.
   * state: 1정체 2지체 3서행 4원활 0정보없음.
   */
  setTraffic(
    samples:
      | { lat: number; lng: number; state: number; speed?: number }[]
      | null
      | undefined,
    kakaoSec?: number,
  ) {
    // 카카오 실측 총 소요초를 함께 주면 ETA 앵커를 갱신(현재 경로 기준 정확값)
    if (typeof kakaoSec === "number" && kakaoSec > 0) this.anchorSec = kakaoSec;
    const n = this.path.length;
    if (!samples || samples.length === 0 || n < 2) {
      this.rebuildSecCum(null);
      return;
    }
    // 샘플 공간 해시(~300m 셀) — 구간 중점 최근접을 3×3 셀에서만 탐색
    const CELL = 0.003;
    const key = (la: number, lo: number) =>
      Math.floor(la / CELL) * 1_000_000 + Math.floor(lo / CELL);
    const grid = new Map<number, number[]>();
    for (let s = 0; s < samples.length; s++) {
      const k = key(samples[s].lat, samples[s].lng);
      const a = grid.get(k);
      if (a) a.push(s);
      else grid.set(k, [s]);
    }
    // traffic_speed(실제 km/h)가 없을 때만 쓰는 대략 배율(정체/지체/서행/원활)
    const TRAF_FAC: Record<number, number> = { 1: 3.0, 2: 2.0, 3: 1.4, 4: 1.0 };
    const MATCH_M = 160; // 이 밖이면 정보 없음(배율 1)
    const fac: number[] = new Array(n - 1);
    for (let i = 1; i < n; i++) {
      const mLat = (this.path[i - 1].lat + this.path[i].lat) / 2;
      const mLng = (this.path[i - 1].lng + this.path[i].lng) / 2;
      const ci = Math.floor(mLat / CELL);
      const cj = Math.floor(mLng / CELL);
      let bestD = Infinity;
      let best: { state: number; speed?: number } | null = null;
      for (let x = ci - 1; x <= ci + 1; x++) {
        for (let y = cj - 1; y <= cj + 1; y++) {
          for (const s of grid.get(x * 1_000_000 + y) ?? []) {
            const d = distM({ lat: mLat, lng: mLng }, samples[s]);
            if (d < bestD) {
              bestD = d;
              best = samples[s];
            }
          }
        }
      }
      if (!best || bestD > MATCH_M) {
        fac[i - 1] = 1; // 정보 없음
      } else if (best.speed && best.speed > 0) {
        // 실제 현재속도 – 정확한 구간 소요시간 배율 (자유주행 대비)
        const lenM = this.cum[i] - this.cum[i - 1];
        const actualSec = lenM / (best.speed / 3.6);
        const baseSec = this.segBaseSec[i - 1];
        fac[i - 1] = baseSec > 0.3
          ? Math.max(0.8, Math.min(6, actualSec / baseSec))
          : 1;
      } else {
        // 실제속도 없음 – 상태 버킷 대략 배율로 폴백
        fac[i - 1] = TRAF_FAC[best.state] ?? 1;
      }
    }
    this.rebuildSecCum(fac);
  }

  /** 경로 위 현재 스냅 위치 (지도 중심용) */
  get progress(): { idx: number; along: number } {
    return { idx: this.idx, along: this.along };
  }

  /**
   * 세션 복원 — 저장된 진행 위치로 스냅 지점을 되돌린다(load() 뒤 호출).
   * update()가 idx±좁은 창에서만 재스냅하므로, 앱을 껐다 켜 이어할 때
   * 이 값이 없으면 초반 지점에 잘못 붙는다. 이미 지나온 안내는 발화 억제.
   */
  restoreProgress(idx: number) {
    const n = this.path.length;
    if (n < 2) return;
    this.idx = Math.max(0, Math.min(idx, n - 2));
    this.along = this.cum[this.idx];
    this.started = true;
    // 이미 지나온 회전·안내(m.at ≤ 현재 진행)는 재발화하지 않게 완료 표시.
    // 발화 키는 `m{i}` + 접미사(near/far/far1k) 조합이라 모두 눌러둔다.
    for (let i = 0; i < this.maneuvers.length; i++) {
      if (this.maneuvers[i].at <= this.along) {
        for (const s of ["", "near", "far", "far1k"]) this.spoken.add(`m${i}${s}`);
      }
    }
    // 이미 지나온 단속카메라·구간단속 게이트도 눌러둔다 — 안 그러면 세션 복원
    // 시 지나온 구간단속에서 "구간단속이 끝났습니다"가 엉뚱한 평균과 함께 재발화.
    for (let i = 0; i < this.cams.length; i++) {
      if (this.cams[i].at <= this.along) {
        for (const s of ["w", "b", "o", "sIn", "sOut"]) this.spoken.add(`c${i}${s}`);
      }
    }
    for (let i = 0; i < this.narrows.length; i++) {
      if (this.narrows[i].at <= this.along) this.spoken.add(`nw${i}`);
    }
  }

  /** p–세그먼트 j 최단거리와 투영 위치 */
  private seg(p: LatLng, j: number): { d: number; t: number } {
    const a = this.path[j];
    const b = this.path[j + 1];
    const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
    const ax = (a.lng - p.lng) * kx;
    const ay = (a.lat - p.lat) * 111_320;
    const dx = (b.lng - p.lng) * kx - ax;
    const dy = (b.lat - p.lat) * 111_320 - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { d: Math.hypot(ax + t * dx, ay + t * dy), t };
  }

  private segBearing(j: number): number {
    return bearing(this.path[j], this.path[Math.min(j + 1, this.path.length - 1)]);
  }

  /** 누적거리 – 예상 누적 소요초 (선형 보간) */
  /** along 지점의 누적초 — cum(거리) 프리픽스에서 보간. base=true면 자유주행 기준 */
  private secAt(along: number, hintIdx: number, base = false): number {
    const cumSec = base ? this.baseCum : this.secCum;
    let i = Math.min(Math.max(hintIdx, 0), this.path.length - 2);
    while (i > 0 && this.cum[i] > along) i--;
    while (i < this.path.length - 2 && this.cum[i + 1] < along) i++;
    const span = this.cum[i + 1] - this.cum[i];
    const t = span > 0 ? (along - this.cum[i]) / span : 0;
    return cumSec[i] + (cumSec[i + 1] - cumSec[i]) * Math.max(0, Math.min(1, t));
  }

  update(lat: number, lng: number, heading?: number | null): NavState {
    const p = { lat, lng };
    const n = this.path.length;
    const speak: string[] = [];
    let needReroute = false;
    const prevAlong = this.along;

    // 실지면 속도 벡터 EMA — 이탈 재탐색 게이트용(경로 투영과 무관).
    // 투영 speedMps는 경로에서 갈라져 달리면 진행이 멈춰 0으로 붕괴하므로
    // 재탐색을 못 걸었다. 실 GPS 변위 벡터를 감쇠 평균해, 정차 지터(방향이
    // 매번 뒤집혀 상쇄)와 이탈 주행(방향 지속)을 구분한다.
    const nowG = Date.now();
    if (this.lastRealPos && this.lastRealTs > 0) {
      const dtG = (nowG - this.lastRealTs) / 1000;
      if (dtG >= 0.3 && dtG <= 6) {
        const kx = 111_320 * Math.cos((p.lat * Math.PI) / 180);
        const vN = ((p.lat - this.lastRealPos.lat) * 111_320) / dtG;
        const vE = ((p.lng - this.lastRealPos.lng) * kx) / dtG;
        this.velN = 0.6 * this.velN + 0.4 * vN;
        this.velE = 0.6 * this.velE + 0.4 * vE;
      }
    }
    this.lastRealPos = p;
    this.lastRealTs = nowG;
    const groundMps = Math.hypot(this.velN, this.velE);

    let best = { j: this.idx, d: Infinity, t: 0, score: Infinity };
    const consider = (j: number) => {
      const r = this.seg(p, j);
      let score = r.d;
      if (heading !== null && heading !== undefined && this.speedMps > 1) {
        // 저속일수록 GPS 방위각 신뢰가 낮아 가중을 줄이되(정차 노이즈 방지),
        // 서행 헤어핀(5~7km/h)에서도 상시 적용해 반대 차선 오스냅을 막는다.
        // (예전엔 speedMps>2에서만 걸려 저속 헤어핀에서 반대편으로 튀었다)
        const w = Math.min(1, this.speedMps / 3);
        score += (angDiff(heading, this.segBearing(j)) / 180) * HEADING_PEN_M * w;
      }
      if (score < best.score) best = { j, d: r.d, t: r.t, score };
    };
    const lo = Math.max(0, this.idx - 10);
    const hi = Math.min(n - 2, this.idx + 200);
    for (let j = lo; j <= hi; j++) consider(j);
    // 윈도 안에서 못 찾으면(터널·GPS 공백 후 멀리 진행) 남은 경로 전체에서
    if (best.d > 200) {
      for (let j = hi + 1; j < n - 1; j++) consider(j);
    }
    const cand = this.cum[best.j] + (this.cum[best.j + 1] - this.cum[best.j]) * best.t;
    // 큰 후진은 무시(왕복 구간 반대편 오스냅 방지) — 확실히 붙었을 땐 수용
    if (cand >= this.along - 250 || best.d < 15) {
      this.idx = best.j;
      this.along = cand;
    }
    const offM = best.d;
    this.coastedM = 0; // 실픽스 도착 — 추측항법 캡 리셋

    const now = Date.now();
    if (this.lastTs > 0) {
      const dt = (now - this.lastTs) / 1000;
      const dAlong = this.along - prevAlong;
      if (dt >= 0.3 && dt <= 6 && dAlong >= 0) {
        this.speedMps = 0.7 * this.speedMps + 0.3 * (dAlong / dt);
        const expSec = this.secAt(this.along, this.idx) - this.secAt(prevAlong, this.idx);
        // 누적 실제/예상 시간을 감쇠 합산 – 비율. 큰 구간(>10m)만 반영해
        // 작은 분모 노이즈를 배제하고, 정지·서행이 창 전체에 녹아 완만하게.
        if (dAlong > 10 && expSec > 0.3) {
          const decay = 0.997;
          this.paceActual = this.paceActual * decay + dt;
          this.paceExpect = this.paceExpect * decay + expSec;
          if (this.paceExpect > 25) {
            this.paceRatio = Math.max(
              0.6,
              Math.min(1.6, this.paceActual / this.paceExpect),
            );
          }
        }
      }
    }
    this.lastTs = now;

    // 카카오 실측 ETA 앵커가 붙을 때까지 잠깐(최대 3틱) 미뤄 발화 ETA가
    // 카카오 내비와 어긋나지 않게 한다. 앵커가 끝내 없으면 모델값으로 발화.
    if (!this.started && this.anchorSec == null && this.startWait < 3) {
      this.startWait++;
    } else if (!this.started) {
      this.started = true;
      const etaSec = Math.max(
        0,
        Math.round(
          (this.secCum[this.secCum.length - 1] -
            this.secAt(this.along, this.idx)) *
            this.paceRatio,
        ),
      );
      const min = Math.max(1, Math.round(etaSec / 60));
      let etaTxt: string;
      if (min >= 60) {
        const h = Math.floor(min / 60);
        const m = min % 60;
        etaTxt = m > 0 ? `${h}시간 ${m}분` : `${h}시간`;
      } else {
        etaTxt = `${min}분`;
      }
      speak.push(`경로 안내를 시작합니다. 예상 소요 시간은 약 ${etaTxt}입니다.`);
    }

    if (offM > OFF_ROUTE_M) {
      this.offCount++;
      const need = offM > OFF_ROUTE_FAR_M ? 2 : OFF_ROUTE_FIXES;
      // 정차(신호대기 등) 중 GPS 난반사로는 재탐색하지 않는다 — 움직이지
      // 않았는데 '경로 이탈'일 수 없다. 실지면 속도(벡터 EMA)로 판정해,
      // 경로에서 갈라져 달릴 때도(투영 speedMps는 0이어도) 재탐색을 건다.
      if (this.offCount >= need && groundMps > REROUTE_MIN_MPS) {
        // 이탈 중엔 매 픽스 재탐색을 요청한다 — 첫 요청이 실패(오프라인
        // 등)해도 화면 쪽 스로틀(15s) 간격으로 재시도된다
        needReroute = true;
        if (!this.offRoute) {
          this.offRoute = true;
          speak.push("경로를 벗어났습니다. 경로를 다시 탐색합니다.");
        }
      }
    } else {
      if (this.offRoute) speak.push("경로로 복귀했습니다.");
      this.offCount = 0;
      this.offRoute = false;
    }

    // 표시용 위치 — 경로에 붙어 있으면 투영점 (차가 선 위를 탄다)
    let pos: LatLng = p;
    if (!this.offRoute && offM <= 35) {
      const a = this.path[this.idx];
      const b = this.path[Math.min(this.idx + 1, n - 1)];
      pos = {
        lat: a.lat + (b.lat - a.lat) * best.t,
        lng: a.lng + (b.lng - a.lng) * best.t,
      };
    }

    return this.buildState(pos, offM, speak, needReroute);
  }

  /**
   * 추측항법 — GPS 공백(터널) 동안 1초마다 호출하면 마지막 속도로 경로를
   * 따라 전진시킨다. 이탈·정지·도착 상태면 null.
   */
  coast(dtSec: number): NavState | null {
    if (!this.started || this.offRoute || this.arrived || this.speedMps < 3) return null;
    // 장기 GPS 소실 폭주 방지 — 픽스 없이 최대 2.5km까지만 (긴 터널 커버)
    if (this.coastedM >= 2500) return null;
    this.coastedM += this.speedMps * dtSec;
    this.along = Math.min(this.along + this.speedMps * dtSec, this.totalM);
    const n = this.path.length;
    while (this.idx < n - 2 && this.cum[this.idx + 1] < this.along) this.idx++;
    const a = this.path[this.idx];
    const b = this.path[Math.min(this.idx + 1, n - 1)];
    const span = this.cum[this.idx + 1] - this.cum[this.idx];
    const t = span > 0 ? (this.along - this.cum[this.idx]) / span : 0;
    const pos = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    return this.buildState(pos, 0, [], false);
  }

  private buildState(
    pos: LatLng,
    offM: number,
    speak: string[],
    needReroute: boolean,
  ): NavState {
    let beep = false;
    const speedKmh = this.speedMps * 3.6;
    // 속도 적응 회전 안내 거리 — 고속은 더 일찍, 저속은 더 늦게(도달시간 기준).
    // 정지·서행 시 바닥 속도(6m/s)로 계산해 최소 거리를 보장한다.
    const sp = Math.max(this.speedMps, 6);
    const nearM = Math.min(NEAR_MAX, Math.max(NEAR_MIN, sp * NEAR_S));
    const farM = Math.min(FAR_MAX, Math.max(FAR_MIN, sp * FAR_S));
    const far1kM = Math.min(FAR1K_MAX, Math.max(FAR1K_MIN, sp * FAR1K_S));

    let next: NavState["next"] = null;
    if (!this.offRoute) {
      for (let i = 0; i < this.maneuvers.length; i++) {
        const m = this.maneuvers[i];
        if (m.at < this.along - 25) continue;
        const dist = m.at - this.along;
        next = { m, distM: Math.max(0, Math.round(dist)) };
        const key = `m${i}`;
        if (m.type === "arrive") {
          if (dist <= 300 && !this.spoken.has(key + "near")) {
            this.spoken.add(key + "near");
            speak.push("곧 목적지에 도착합니다.");
          }
          if (dist <= ARRIVE_M && !this.arrived) {
            this.arrived = true;
            speak.push("목적지에 도착했습니다. 안내를 종료합니다.");
          }
        } else if (STRUCT_TYPES.has(m.type)) {
          // 구조물 진입(고가도로·지하차도·터널) — 회전과 달리 "진입" 문구,
          // 방면은 앞에 붙인다("한남대교 방면 고가도로 진입입니다"). 놓칠 수
          // 없는 안내라 far 1회 + near 1회로 간결히.
          const label = MANEUVER_LABEL[m.type];
          const pre = m.dest ? `${m.dest} 방면 ` : "";
          if (dist <= farM && dist > nearM + 50 && !this.spoken.has(key + "far")) {
            this.spoken.add(key + "far");
            speak.push(`${speakDist(dist)} 앞 ${pre}${label} 진입입니다.`);
          }
          if (dist <= nearM && !this.spoken.has(key + "near")) {
            this.spoken.add(key + "near");
            this.spoken.add(key + "far");
            speak.push(`잠시 후 ${pre}${label} 진입입니다.`);
          }
        } else {
          const label = MANEUVER_LABEL[m.type];
          // 방면: 고속 진출/분기는 destination(서울·대구)을 도로명보다 우선.
          const dir = m.dest ?? m.road;
          const dirTxt = dir ? `, ${dir} 방면` : "";
          // 갈림길·방향 안내(fork/keep)는 어느 길인지가 핵심이라 근접에서도 방면을
          // 붙인다(일반 회전은 근접에선 간결하게 방면 생략).
          const dirType = m.type.startsWith("fork") || m.type.startsWith("keep");
          // 연속 회전이면 연결 멘트 ("… 이어서 곧 우회전입니다")
          const m2 = this.maneuvers[i + 1];
          const chain =
            m2 && m2.type !== "arrive" && m2.at - m.at < CHAIN_M
              ? ` 이어서 곧 ${MANEUVER_LABEL[m2.type]}입니다.`
              : "";
          if (
            speedKmh >= 70 &&
            dist <= far1kM &&
            dist > farM + 150 &&
            !this.spoken.has(key + "far1k")
          ) {
            this.spoken.add(key + "far1k");
            speak.push(`${speakDist(dist)} 앞에서 ${label}${dirTxt}입니다.`);
          }
          if (dist <= farM && dist > nearM + 50 && !this.spoken.has(key + "far")) {
            this.spoken.add(key + "far");
            speak.push(`${speakDist(dist)} 앞에서 ${label}${dirTxt}입니다.${chain}`);
          }
          if (dist <= nearM && !this.spoken.has(key + "near")) {
            this.spoken.add(key + "near");
            this.spoken.add(key + "far");
            speak.push(`잠시 후 ${label}${m.dest || dirType ? dirTxt : ""}입니다.${chain}`);
          }
        }
        break;
      }
    }

    let section: NavState["section"] = null;
    if (!this.offRoute) {
      for (let i = 0; i < this.cams.length; i++) {
        const c = this.cams[i];
        if (c.kind !== "section") continue;
        if (c.section === "start" && this.along >= c.at) {
          const key = `c${i}sIn`;
          if (!this.spoken.has(key)) {
            this.spoken.add(key);
            // 시점 게이트 통과 — 이 순간부터 평균속도 누적 시작
            this.secStart = { along: this.along, ts: Date.now(), limit: c.limitKmh ?? 0 };
          }
        } else if (c.section === "end" && this.along >= c.at) {
          const key = `c${i}sOut`;
          if (!this.spoken.has(key)) {
            this.spoken.add(key);
            if (this.secStart) {
              const s = this.secStart;
              const dt = (Date.now() - s.ts) / 1000;
              const avg = dt > 1 ? Math.round(((this.along - s.along) / dt) * 3.6) : 0;
              const lim = s.limit || c.limitKmh || 0;
              speak.push(
                avg > 0
                  ? `구간 단속이 끝났습니다. 평균 시속 ${avg}킬로미터입니다.` +
                      (lim && avg > lim ? " 제한 속도를 초과했습니다." : "")
                  : "구간 단속이 끝났습니다.",
              );
              this.secStart = null;
            }
          }
        }
      }
      if (this.secStart) {
        const dt = (Date.now() - this.secStart.ts) / 1000;
        const dAlong = this.along - this.secStart.along;
        // 30km 넘게 종점 못 만나면 미아 상태 정리(경로 밖 등)
        if (dAlong > 30_000) this.secStart = null;
        else
          section = {
            avgKmh: dt > 3 ? Math.round((dAlong / dt) * 3.6) : Math.round(speedKmh),
            limitKmh: this.secStart.limit,
          };
      }
    }

    let limitKmh = 0;
    let limitTagged = false;
    for (const L of this.limits) {
      if (L.i <= this.idx) {
        limitKmh = L.kmh;
        limitTagged = L.tagged;
      } else break;
    }
    // 도로 제한속도만으로 울리는 과속 음성은 없앴다(2026-10-06 사용자 요청 —
    // 카메라도 없는데 울려서 성가심). 제한속도는 화면 표시에만 쓰고, 소리는
    // 아래 단속카메라 접근 과속·구간단속 평균 초과에서만 낸다.

    let cam: NavState["cam"] = null;
    if (!this.offRoute) {
      for (let i = 0; i < this.cams.length; i++) {
        const c = this.cams[i];
        if (c.at < this.along - 30) continue;
        const dist = c.at - this.along;
        if (dist > 1000) break;
        cam = { c, distM: Math.max(0, Math.round(dist)) };
        const key = `c${i}`;
        const limTxt = c.limitKmh ? `제한 속도 시속 ${c.limitKmh}킬로미터, ` : "";
        if (dist <= CAM_WARN_M && !this.spoken.has(key + "w")) {
          this.spoken.add(key + "w");
          if (c.kind === "section") {
            // 정상 종점은 위에서 종료 멘트를 낸다. 경로가 단속 구간 중간에 합류해
            // 시점을 못 지난 inside-end는 평균 계산 없이 종점 접근만 알린다.
            if (c.section === "inside-end")
              speak.push(`전방에 단속 구간 종점이 있습니다. ${limTxt}제한 속도를 지켜주세요.`);
            else if (c.section !== "end")
              speak.push(
                `전방에 구간 단속 구간입니다. ${limTxt}제한 속도를 지켜주세요.`,
              );
          } else if (c.school) {
            speak.push(
              `전방에 어린이 보호구역입니다. ${limTxt || "제한 속도 시속 30킬로미터, "}서행하세요.`,
            );
          } else {
            speak.push(`전방에 ${limTxt}과속 단속 카메라가 있습니다.`);
          }
        }
        if (dist <= CAM_BEEP_M) {
          if (!this.spoken.has(key + "b")) {
            this.spoken.add(key + "b");
            beep = true;
          }
          // 과속 경고 — 제한속도를 여유 이상 넘겨 접근 중이면 1회
          if (
            c.limitKmh &&
            c.section !== "end" &&
            speedKmh > c.limitKmh + CAM_OVER_MARGIN &&
            !this.spoken.has(key + "o")
          ) {
            this.spoken.add(key + "o");
            speak.push("제한 속도를 초과했습니다. 감속하세요.");
            beep = true;
          }
        }
        break;
      }
    }

    // 도로 좁아짐 — 250m 전 1회
    if (!this.offRoute) {
      for (let i = 0; i < this.narrows.length; i++) {
        const nw = this.narrows[i];
        if (nw.at < this.along - 30) continue;
        const dist = nw.at - this.along;
        if (dist > NARROW_WARN_M) break;
        if (!this.spoken.has(`nw${i}`)) {
          this.spoken.add(`nw${i}`);
          speak.push("전방에 도로가 좁아집니다. 주의하세요.");
        }
        break;
      }
    }

    const remainM = Math.max(0, Math.round(this.totalM - this.along));
    const trafficRemain =
      this.secCum[this.secCum.length - 1] - this.secAt(this.along, this.idx);
    const remainSec = Math.max(0, Math.round(trafficRemain * this.paceRatio));
    // 실시간 지연 = 정체반영 남은시간 − 자유주행 남은시간 (paceRatio 제외해 순수 교통 영향만)
    const freeflowRemain =
      this.baseCum[this.baseCum.length - 1] - this.secAt(this.along, this.idx, true);
    const delaySec = Math.max(0, Math.round(trafficRemain - freeflowRemain));
    let currentRoad: { name?: string; no?: string } | null = null;
    if (!this.offRoute && this.roadRuns.length) {
      let nearest: (typeof this.roadRuns)[number] | undefined;
      let gap = Infinity;
      for (const run of this.roadRuns) {
        if (run.fromM <= this.along && this.along <= run.toM) { nearest = run; gap = 0; break; }
        const d = this.along < run.fromM ? run.fromM - this.along : this.along - run.toM;
        if (d < gap) { gap = d; nearest = run; }
      }
      if (nearest && gap <= 35 && (nearest.roadName || nearest.roadNo)) {
        currentRoad = {
          ...(nearest.roadName ? { name: nearest.roadName } : {}),
          ...(nearest.roadNo ? { no: nearest.roadNo } : {}),
        };
      }
    }

    return {
      along: this.along,
      offM: Math.round(offM),
      offRoute: this.offRoute,
      arrived: this.arrived,
      remainM,
      remainSec,
      delaySec,
      pos,
      pathBearing: this.offRoute ? null : this.segBearing(this.idx),
      next,
      cam,
      section,
      currentRoad,
      limitKmh,
      limitTagged,
      speak,
      beep,
      needReroute,
    };
  }
}
