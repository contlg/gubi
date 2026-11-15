/**
 * 자유주행(목적지 없는 기록 주행) 전방 단속카메라 선택 — 경로가 없으므로
 * 진행방향(heading)만으로 "전방"을 추정한다. page.tsx의 computeFreeWarnings와
 * scripts/nav-eval/cam-sim.mjs(가상주행 대조 하네스)가 **같은 로직**을 쓰도록
 * 순수 함수로 분리했다.
 *
 * 오탐 방지 핵심:
 *  - heading을 모르면(정지·출발직후) 무엇이 전방인지 알 수 없어 경고하지 않는다.
 *  - 각도 부채꼴만 보면 옆·교차 도로 카메라가 걸리므로, **진행선에서 옆으로
 *    벗어난 거리(lateral)** 로 '내가 달리는 길'의 카메라만 남긴다.
 */

export interface FreeCam {
  lat: number;
  lng: number;
  kind: string;

  deviceId?: string;
  speed?: boolean;
  signal?: boolean;
  rear?: boolean;
  limitKmh: number;
  school: boolean;
  /** 카메라가 선 도로의 진행방위(일방통행일 때만, 아니면 null/undefined) */
  dirBrg?: number | null;
  /** 서버가 그래프로 추종한 '앞 도로' 위 카메라인지(/api/free-drive). false면
   *  커브 앞 옆도로 카메라라 경고하지 않는다. undefined면 판정 보류(경고). */
  onRoad?: boolean;

  roadConflict?: boolean;

  currentRoadConflict?: boolean;

  currentRoadMatch?: boolean;

  dirStrong?: boolean;

  roadStrong?: boolean;

  branchConflict?: boolean;

  roadLevelConflict?: boolean;
  /** 서버 앞 도로 추적선까지 거리(m)·그 지점 추적선 방향(°) — 판정 근거 */
  traceDistM?: number;
  traceBrg?: number;
}

/** 일반 주행 카메라 목록을 다시 받는 이동 거리(m). 목록은 반경 2km라 경고 거리(최대 600m)를 넉넉히 덮는다. */
export const FREE_CAM_LIST_REFRESH_M = 1000;
/** 카메라 목록 요청을 기다리는 최대 시간(ms). */
export const FREE_CAM_LIST_TIMEOUT_MS = 15_000;

/**
 * 목록을 받은 지점 기준의 도로 판정을 뺀다. 목록은 최대 1km 전에 받은 것이라 이 값들은 낡았다.
 * 폰은 거리·각도·카메라 방향으로 경고한다. 헛경고보다 안 울리는 게 문제라 서버 재확인은 두지 않는다.
 * 실제 주행 591개 재생(티맵 기준, 찍는 방향으로 지나간 2,217개): 서버 요청 69,574→4,930,
 * 안 울림 87→1, 100m도 안 남기고 경고 83→19. 안 지나간 카메라 경고는 146→409로 는다.
 */
export function withoutPositionJudgment(cams: readonly FreeCam[]): FreeCam[] {
  return cams.map((cam) => {
    const copy = { ...cam };
    delete copy.onRoad;
    delete copy.roadConflict;
    delete copy.currentRoadConflict;
    delete copy.currentRoadMatch;
    delete copy.branchConflict;
    delete copy.roadLevelConflict;
    delete copy.traceDistM;
    delete copy.traceBrg;
    // 강한 방향 조건(60°)은 커브 앞에서 진짜 카메라를 막았다. 티맵 기준 안 울린 8개 중 7개가 이 조건 때문이었다.
    // 맞은편 카메라는 일반 방향 조건(100°)으로 계속 거른다.
    delete copy.dirStrong;
    return copy;
  });
}

export interface ForwardCam {
  kind: string;
  deviceId?: string;
  speed?: boolean;
  signal?: boolean;
  rear?: boolean;
  limitKmh: number;
  school: boolean;
  lat: number;
  lng: number;
  distM: number;
  /** 찍는 방향 — 같은 자리 중복 경고 억제(sameFreeCameraCluster)에 필요 */
  dirBrg?: number | null;
}

export interface ForwardCamOpts {
  /** 전방 판정 각도 반경(°). 이보다 옆·뒤면 제외 */
  coneDeg?: number;
  /** 진행선에서 옆으로 벗어난 최대 거리(m). 이보다 멀면 다른 도로로 보고 제외 */
  lateralMaxM?: number;

  rangeM?: number;
  /** 분리도로 반대차로 억제: dirBrg와 heading 차가 이 각(°) 넘으면 제외 */
  oppositeDeg?: number;
  /** heading이 없어도 근처 카메라를 잡을지(구버전 동작 재현용). 기본 false */
  matchWithoutHeading?: boolean;
  /** 이 옆거리(m) 이내면 '내 진행선 바로 위'로 보고 도로추종(onRoad) 판정을
   *  무시한다 — 추종이 교차로에서 새도 정면 카메라를 놓치지 않게. */
  straightM?: number;
  /** onRoad 판정을 통째로 무시 — 서버가 그 값을 계산할 때 쓴 진행방향과 지금
   *  진행방향이 크게 달라졌을 때(교차로에서 꺾은 직후) 쓴다. 낡은 판정으로
   *  진짜 카메라를 죽이는 것보다 각도·옆거리 게이트만으로 거르는 게 낫다. */
  ignoreOnRoad?: boolean;
}

// cam-sim 하네스(scripts/nav-eval/cam-sim.mjs)로 17개 실경로를 가상주행해 튜닝한
// 값. 경로 없는 자유주행은 커브 앞 카메라를 "전방"으로 오인하기 쉬운데, 거리
// (650m)와 옆거리(55m)를 조이면 오탐이 OLD(±75°) 대비 88%(정답반경 50m 기준
// 오탐 364–42), 실카메라 누락은 +11만 증가(안전상 놓침<오탐이라 이 지점에서 멈춤).
// 2026-09-25: 표준노드링크 앞쪽 임시경로 도입 후 straightM 0·앞도로 폭 30m(엄격)를
// 시험했다. 가상주행 하네스는 오탐 −40~50%였지만 카카오 실측(locked-v4 후보
// 평가기)에선 실재 확인된 역삼역 J3194 경고가 사라지고 합정 신호·속도 카메라를
// 새로 놓쳤다 – 채택 안 함. 하네스의 "오탐"은 실제보다 부풀려져 있다.
const DEFAULTS: Required<ForwardCamOpts> = {
  coneDeg: 70,
  lateralMaxM: 55,
  rangeM: 650,
  oppositeDeg: 100,
  matchWithoutHeading: false,
  straightM: 25,
  ignoreOnRoad: false,
};

function distM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * kx);
}

function angleDiff(a: number, b: number): number {
  return Math.abs(((a - b + 540) % 360) - 180);
}

// 차로별 장비 식별자는 보존하고 위치와 기능이 같은 근접 장비만 음성 경고를 합친다.
export function sameFreeCameraCluster(
  a: Pick<FreeCam, "lat" | "lng" | "kind" | "deviceId" | "speed" | "signal" | "limitKmh" | "dirBrg">,
  b: Pick<FreeCam, "lat" | "lng" | "kind" | "deviceId" | "speed" | "signal" | "limitKmh" | "dirBrg">,
  legacyMaxM = 80,
): boolean {
  if (a.deviceId && b.deviceId) {
    if (a.deviceId === b.deviceId) return true;
    // Different canonical ids remain different physical devices.  They share a
    // warning site only when the public rows are virtually co-located and say
    // the same thing.  This catches lane-split rows without merging opposite
    // corners of an intersection.
    // 같은 방향을 찍는 장비가 80m 안이면 한 지점(같은 교차로의 차로별·신호/과속 장비)으로 본다.
    // 2026-10-19 채점 v5(113길): 같은 자리 두 번 경고가 80번 — 두 번째는 대부분 카메라 10~60m 앞에서
    // 나왔다(창원 G2763/G2764 13m, 서울 H1368 고정·G1953 신호 68m 등). 카카오는 한 번만 울린다.
    // 교차로 맞은편 장비는 방향이 달라 아래 30° 조건에서 갈린다. 구간단속은 따로 센다.
    const sameDir = a.dirBrg != null && b.dirBrg != null && angleDiff(a.dirBrg, b.dirBrg) <= 30;
    const pointKinds = a.kind !== "section" && b.kind !== "section";
    if (sameDir && pointKinds && distM(a, b) <= 80) {
      return !(a.limitKmh > 0 && b.limitKmh > 0 && a.limitKmh !== b.limitKmh);
    }
    if (a.kind !== b.kind || distM(a, b) > 1.5) return false;
    if (a.speed != null && b.speed != null && a.speed !== b.speed) return false;
    if (a.signal != null && b.signal != null && a.signal !== b.signal) return false;
    if (a.limitKmh > 0 && b.limitKmh > 0 && a.limitKmh !== b.limitKmh) return false;
    if (a.dirBrg != null && b.dirBrg != null && angleDiff(a.dirBrg, b.dirBrg) > 30) return false;
    return true;
  }
  // 구버전 데이터에는 장비 식별자가 없어 기존의 보수적인 거리·종류 기준을 유지한다.
  return a.kind === b.kind && distM(a, b) <= legacyMaxM;
}

/**
 * 진행방향 기준 가장 가까운 전방 카메라를 고른다. 없으면 null.
 * @param heading 진행방위(° 북기준). null이면(정지) 기본적으로 경고 안 함.
 */
export function selectForwardCam(
  pos: { lat: number; lng: number },
  heading: number | null,
  cams: readonly FreeCam[],
  opts: ForwardCamOpts = {},
): ForwardCam | null {
  const o = { ...DEFAULTS, ...opts };
  const hasHeading = heading !== null && Number.isFinite(heading);
  if (!hasHeading && !o.matchWithoutHeading) return null;

  const kxm = 111_320 * Math.cos((pos.lat * Math.PI) / 180);
  let best: ForwardCam | null = null;
  for (const c of cams) {
    // onRoad와 같이 서버의 앞길 추측에 기댄 값이다. 일반 주행은 이 값을 뺀 목록으로 판단한다.
    if (c.roadLevelConflict === true && !o.ignoreOnRoad) continue;
    const d = distM(pos, c);
    if (d > o.rangeM) continue;
    let lateral = 0;
    if (hasHeading) {
      // 분리도로(일방) 반대차로 카메라 억제
      if (c.dirBrg != null) {
        const maxDirDiff = c.dirStrong === true ? 60 : o.oppositeDeg;
        if (angleDiff(c.dirBrg, heading as number) > maxDirDiff) continue;
      }
      if (c.currentRoadConflict === true && c.dirBrg != null && d <= 100) {
        const dd = angleDiff(c.dirBrg, heading as number);
        const axisDiff = Math.min(dd, 180 - dd);
        if (axisDiff > 75) continue;
      }
      const brg =
        (Math.atan2((c.lng - pos.lng) * kxm, (c.lat - pos.lat) * 111_320) * 180) /
        Math.PI;
      const off = angleDiff(brg, heading as number);
      if (off > o.coneDeg) continue; // 뒤·옆 카메라 제외
      // 진행선 옆거리 — 교차·평행 도로 카메라 배제
      lateral = d * Math.sin((off * Math.PI) / 180);
      if (lateral > o.lateralMaxM) continue;
      // 아래 두 규칙은 서버 앞 도로 추적선 근거라, 그 판정이 낡았으면(ignoreOnRoad) 쓰지 않는다.
      // 2026-10-22 채점 v5(591길): 정상 경고(카카오와 맞춤 1,516) 손실 0, 진짜 헛경고 −22.
      if (!o.ignoreOnRoad && c.traceDistM != null) {
        // 교차·꺾여 들어가는 도로 카메라 — 공식 방향이 지금 진행방향과 40°, 카메라 지점의
        // 앞 도로 방향과도 60° 다르면 우리가 갈 도로를 찍는 장비가 아니다.
        if (
          c.dirStrong === true && c.dirBrg != null && c.traceBrg != null && c.traceDistM <= 50 &&
          angleDiff(c.dirBrg, heading as number) > 40 && angleDiff(c.dirBrg, c.traceBrg) > 60
        ) continue;
        // 나란한 옆길 카메라 — 앞 도로가 카메라에서 50m 넘게 떨어져 지나가고, 지금 도로와
        // 같은 도로라는 확인도 없으면, 정면 가까이(옆거리 15m)라도 경고하지 않는다.
        if (c.traceDistM > 50 && c.currentRoadMatch !== true && lateral > 15) continue;
      }
    }
    // 같은 합류점으로 들어가는 별도 incoming branch에 붙은 카메라.
    // 강한 경찰 방향 + 표준노드링크가 둘 다 확인될 때만 서버가 true를 준다.
    // 자유주행에서 미래 분기를 추측해 다른 갈래 카메라를 미리 울리지 않는다.
    if (c.branchConflict === true) continue;
    // 현재 regional police list가 방향 또는 도로명을 강하게 확정했고 현재 도로와
    // 다르면, 경로 없는 자유주행에서는 그 도로에 실제 진입한 뒤 경고한다.
    // 일반(약한) currentRoadConflict까지 hard reject하면 정상 카메라를 놓친 실측
    // 회귀가 있었으므로 강한 공식 근거가 있을 때만 적용한다.
    if ((c.dirStrong === true || c.roadStrong === true) && c.currentRoadConflict === true) continue;
    // 미래 roadAhead 추적은 교차로에서 잘못 샐 수 있다. 현재도로·경찰도로·
    // 지도상 카메라 도로가 모두 같고 카메라가 정면이면, 그 강한 현재 증거로
    // 잘못된 roadConflict를 override한다. 그 외 교차도로는 계속 제외한다.
    if (c.roadConflict === true && !(c.currentRoadMatch === true && hasHeading && lateral <= o.straightM))
      continue;
    // 서버의 '앞 도로 밖'(roadAhead) 판정으로 제외 — 단, **내 진행선 바로 위**
    // (옆거리 ≤ straightM)인 카메라는 예외로 살린다. 도로추종은 교차로에서
    // 가끔 다른 갈래로 새는데, 정면·직선상 카메라까지 죽여 실제 단속을 놓쳤다
    // (독산사거리 하행 50km 카메라: 전방각 0°·옆거리 1m인데 추종이 빗나가
    //  경고 소실). 추종은 '옆도로 배제'용이지 정면 카메라 거부용이 아니다.
    if (
      !o.ignoreOnRoad &&
      c.onRoad === false &&
      !(hasHeading && lateral <= o.straightM)
    )
      continue;
    if (!best || d < best.distM)
      best = {
        kind: c.kind,
        deviceId: c.deviceId,
        speed: c.speed,
        signal: c.signal,
        rear: c.rear,
        limitKmh: c.limitKmh,
        school: c.school,
        lat: c.lat,
        lng: c.lng,
        distM: Math.round(d),
        dirBrg: c.dirBrg ?? null,
      };
  }
  return best;
}
