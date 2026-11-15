"use client";

import { carAuthBody, carSessionChanged, confirmOfflineRecordingOwner, parseCarCredentials, readCarCredentials, ownedBy, queueOwner, UNASSIGNED, type CarCredentials } from "@/lib/car-auth";
import { sanitizeVehicleRecord, type VehicleRecord } from "@/lib/vehicle-trace";
import { BORROW_SERVER, LOCAL_RECORDS_KEY, LOCAL_USER_NAME, installBorrowFetchGuard, localOwnerSeed, withBasePath } from "@/lib/borrow-mode";
import { loadSecureJsonQueued, readSecureJson, sealJson, secureDepsFor, updateSecureJson, writeSecureJson } from "@/lib/secure-store";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  IconSound,
  IconManeuver,
  IconStar,
  IconCamera,
  IconArrowLeft,
  IconBolt,
  IconCheck,
  IconChevronRight,
  IconClock,
  IconClose,
  IconCompass,
  IconDownload,
  IconFuel,
  IconGauge,
  IconMap,
  IconNav,
  IconPause,
  IconPin,
  IconPlay,
  IconSettings,
  IconUser,
} from "@/components/icons";
import type { DrivePlan, DrivePlanVia } from "@/lib/drive-plan";
import {
  FREE_CAM_LIST_TIMEOUT_MS,
  sameFreeCameraCluster,
  selectForwardCam,
  withoutPositionJudgment,
  type ForwardCam,
  type FreeCam,
} from "@/lib/free-cam";
import { advanceFreeHeading } from "@/lib/free-heading";
import { MANEUVER_LABEL, NavEngine, type NavState } from "@/lib/nav-engine";
import { decodePolyline, encodePolyline } from "@/lib/polyline";
import { quickPosition } from "@/lib/quick-location";
import type { LatLng, Place } from "@/lib/types";

import { Planner } from "../page";
import { PleosSafetyCard, PleosVehicleCard } from "@/components/PleosInfo";
import { isPleosTripResult, pleosAvailable, pleosSupport, requestPleosCancel, requestPleosTrip, usePleosFeed } from "@/lib/pleos-feed";
import { AHEAD_STEPS_M, applyHyundaiAhead, legAhead } from "@/lib/hyundai-ahead";
import { courseStartDiagnostic, currentLocalSelection, guidedStartBlockMessage, needsGuideChoice, restoreGuideMode, localGuidanceAllowed, type GuideMode } from "@/lib/guided-start";
import { NAV_FOCUS_LOST_EVENT, NAV_FOCUS_LOST_TEXT, NAV_FOCUS_REFUSED_TEXT, createNavFocus } from "@/lib/nav-focus";
import { abortRecording, requestRecording } from "@/lib/recording-ack";
import { cleanLabel } from "@/lib/display-text";
import { recordingId } from "@/lib/recording-id";
import GuideChoice from "@/components/GuideChoice";
import { TripCard } from "./TripCard";
import GForcePanel, { G_BINS, GForceRecord, pushEnv, type GLive, type GPeaks } from "./GForcePanel";
import NavMap from "./NavMapKakao";
import NavMapNative, { useNativeNavMap } from "./NavMapNative";
import type { NativeNavMapBridge } from "@/lib/native-nav-map";
import dynamic from "next/dynamic";
// 개발 서버(NEXT_PUBLIC_MAP_GL=1 빌드)만 새 벡터 지도(MapLibre). 실제 서버 빌드엔 안 쓰인다.
const MAP_GL_BUILD = process.env.NEXT_PUBLIC_MAP_GL === "1";
const NavMapGL = dynamic(() => import("./NavMapGL"), { ssr: false });
const MAP_ENGINE_KEY = "drivelog-map-engine-v1";
import DevTools, { useDevCompare } from "./DevTools";
import MapPicker from "@/components/MapPicker";
import TripCharts from "./TripCharts";
import { devlog, devModeOn, devStats, setDevMode, setDevTrip } from "@/lib/devlog";
import { cancelSpeechWhenHidden, pageVisibleForGuidance } from "@/lib/foreground-guidance";
import { useUxRestricted } from "@/lib/ux-restriction";
import {
  prefetchRouteTiles,
  registerTileSW,
  type TileMode,
} from "./offline-tiles";
import LocationGate from "./LocationGate";
import RouteMap from "./RouteMap";

interface RecentDest {
  name: string;
  lat: number;
  lng: number;
}
const RECENT_KEY = "drivelog-nav-recent-v1";
const FAV_KEY = "drivelog-nav-fav-v1";

type NavMode = "time" | "distance" | "free" | "nojam";
const NAV_MODES: { mode: NavMode; label: string; desc: string; icon: React.ReactNode }[] = [
  { mode: "time", label: "최단시간", desc: "가장 빨리 도착", icon: <IconBolt /> },
  { mode: "distance", label: "최단경로", desc: "이동 거리 최소", icon: <IconNav /> },
  { mode: "free", label: "무료도로", desc: "유료도로 제외", icon: <IconMap /> },
  { mode: "nojam", label: "정체 회피", desc: "실시간 정체 회피", icon: <IconGauge /> },
];
type TripMode = "car";
const speedCap = (_mode: TripMode) => 400;
const isTripMode = (value: unknown): value is TripMode => value === "car";

/** 지금부터 sec초 뒤 도착시각 — "오후 3:47 도착" */
function fmtArrival(sec: number): string {
  const d = new Date(Date.now() + sec * 1000);
  const h = d.getHours();
  const ap = h < 12 ? "오전" : "오후";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${ap} ${h12}:${String(d.getMinutes()).padStart(2, "0")} 도착`;
}
/** 소요시간(말) — "1시간 30분 소요" / "47분 소요" */
function fmtEtaDur(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60));
  if (min >= 60) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m > 0 ? `${h}시간 ${m}분 소요` : `${h}시간 소요`;
  }
  return `${min}분 소요`;
}

/** 로그인 표시용 로컬 정보. hash는 자격증명이 아닌 아이디 namespace 해시이고,
 * 실제 API 권한은 서버 HttpOnly 세션 쿠키가 검증한다. */
interface User {
  /** 빌려 쓰기 모드의 기기 전용 사용자 — 서버 계정이 없어 기록을 기기에만 둔다. */
  local?: boolean;
  autoCar?: boolean;
  vinHash?: string;
  hash: string;
  name: string;
}
const USER_KEY = "drivelog-user-v1";
/** 비보안 컨텍스트(http 로컬 등) 폴백 해시 — crypto.subtle이 없을 때 32 hex */
function cyrb(str: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed,
    h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const c = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, "0") +
    (h1 >>> 0).toString(16).padStart(8, "0")
  );
}
async function sha256Hex(s: string): Promise<string> {
  try {
    if (typeof crypto !== "undefined" && crypto.subtle) {
      const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
      return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    }
  } catch {
    // 폴백으로
  }
  return cyrb(s, 0) + cyrb(s, 0x9e3779b9);
}

/** 서브도메인(drive.·drivelog.) 간 로그인 공유 — 같은 상위 도메인이면 domain
 * 지정. 이러면 어느 쪽에서 로그인해도 다른 쪽에서 재로그인이 안 뜬다. */
/** 구버전이 상위 도메인(.homesev.duckdns.org)에 공유로 심었던 쿠키를 지우기
 *  위한 도메인 속성 — 새 쿠키엔 안 쓴다(서브도메인 간 자격증명 유출 방지). */
function legacyCookieDomainAttr(): string {
  // 빌려 쓰기 모드는 drivelog 주소에서 열린다 — 상위 도메인 쿠키를 건드리지 않는다.
  if (BORROW_SERVER) return "";
  try {
    const h = location.hostname;
    if (h === "homesev.duckdns.org" || h.endsWith(".homesev.duckdns.org"))
      return "; domain=.homesev.duckdns.org";
  } catch {}
  return "";
}
/** https에서만 전송되게 secure 부여(로컬 http 테스트에선 생략) */
function cookieSecureAttr(): string {
  try {
    return location.protocol === "https:" ? "; secure" : "";
  } catch {
    return "";
  }
}

/** 로그인 표시 유지 — WebView localStorage 폴백용 JS 쿠키. API 권한은 별도의
 * 서버 HttpOnly 쿠키만 가지므로 이 값은 변조돼도 기록 접근 권한이 생기지 않는다. */
function saveUser(u: User) {
  const raw = JSON.stringify(u);
  try {
    localStorage.setItem(USER_KEY, raw);
  } catch {}
  // 빌려 쓰기 모드: 쿠키는 drivelog 서버로 함께 전송되므로 심지 않는다.
  if (BORROW_SERVER) return;
  try {
    document.cookie = `${USER_KEY}=${encodeURIComponent(raw)}; path=/; max-age=31536000; samesite=lax${cookieSecureAttr()}`;
  } catch {}
}
function loadUser(): User | null {
  const tryParse = (raw: string | null): User | null => {
    if (!raw) return null;
    try {
      const u = JSON.parse(raw);
      return u?.hash && u?.name ? (u as User) : null;
    } catch {
      return null;
    }
  };
  try {
    const ls = tryParse(localStorage.getItem(USER_KEY));
    if (ls) return ls;
  } catch {}
  try {
    const m = document.cookie.match(new RegExp(`(?:^|; )${USER_KEY}=([^;]*)`));
    if (m) return tryParse(decodeURIComponent(m[1]));
  } catch {}
  return null;
}
function clearUser() {
  try {
    localStorage.removeItem(USER_KEY);
  } catch {}
  try {
    document.cookie = `${USER_KEY}=; path=/; max-age=0`;
    // 구버전 상위 도메인 공유 쿠키도 제거
    document.cookie = `${USER_KEY}=; path=/; max-age=0${legacyCookieDomainAttr()}`;
  } catch {}
}

/**
 * Gubi — 주행 기록 대시보드.
 * - 주행 시작 – 속도·현재 위치(동 단위)·거리 실시간, 일시중지/종료.
 * - 기록은 맥미니 서버(/api/drive-records)에 저장 — 폰·PC 어디서든 같은 목록.
 *   오프라인(산길)에서 끝나면 로컬 큐에 뒀다가 다음 접속 때 동기화.
 * - 안드로이드 앱(WebView)에서는 window.DriveNative 브리지가 있으면 GPS를
 *   네이티브 포그라운드 서비스가 잡는다 — 화면 꺼짐·백그라운드에서도 기록되고
 *   알림창에 속도/일시중지/종료가 뜬다. 웹(브리지 없음)은 Wake Lock 폴백.
 */

interface DriveRecord extends VehicleRecord {
  owner?: string;
  id: string;
  startTs: number;
  endTs: number;
  distanceM: number;
  maxKmh: number;
  avgKmh: number;
  movingSec: number;
  startAddr?: string;
  endAddr?: string;
  /** 플래너에서 물려받은 코스 (있으면 예상 vs 실제 비교) */
  courseLabel?: string;
  planSec?: number;
  planM?: number;
  /** 주행 궤적 (encoded polyline) — 기록 지도 표시용 */
  path?: string;
  /** 궤적 각 점의 속도(km/h) — path와 인덱스 일치. 속도 분포·색칠용 */
  speeds?: number[];

  /** 구버전 기록 분류값. 자동차 외 기록은 표시·복원하지 않는다. */
  mode?: string;
  /** 정지 출발 최고 기록 — 0–50, 0–100km/h 걸린 초 */
  zero50Sec?: number;
  zero100Sec?: number;
  /** 앱이 빠른 제로백(0–50 2초 미만 등)을 센서로 확인했음 — 서버 하한이 낮아진다 */
  zeroChecked?: boolean;
  /** 이번 주행 G — 네 방향 최고값 + 방향별(10°×36칸) 최대 도형 */
  gForce?: { accel: number; brake: number; left: number; right: number; env?: number[]; source?: "sensor" };
}

/** 방문한 행정구역 (로컬 행정동 경계 판정) */
interface Region {
  sido: string;
  sigungu: string;
}

interface NativeState {
  owner?: string;
  recordingId?: string;
  phase: "idle" | "driving" | "paused";
  kmh: number;
  distM: number;
  maxKmh: number;
  movingSec: number;
  startTs: number;
  endTs: number;
  lat: number;
  lng: number;
  /** GPS 진행방향(° 북 기준) — 없으면 -1 (신규 앱만) */
  brg?: number;
  /** 마지막 실제 GPS 픽스 시각(ms) — 폴링 반복값과 새 픽스를 구분. */
  fixTs?: number;
  /** 포그라운드 서비스 인스턴스 생존 여부(신규 앱). */
  alive?: boolean;

  mode?: string;
  /** 터널(GPS 끊김) 속 바퀴 진동 추정 속도인지 */
  kmhEst?: boolean;
  /** 표시용 위치(대략 위치 포함, 기록엔 안 씀) (1.6+) */
  dLat?: number;
  dLng?: number;
  dAcc?: number;
  dTs?: number;
  /** 이번 기록 최고 0–50 / 0–100 초, 없으면 -1 (1.4+) */
  z50?: number;
  z100?: number;
  /** 빠른 제로백을 센서로 확인하는 앱(1.8+) */
  zchk?: boolean;
}

declare global {
  interface Window {
    DriveNative?: NativeNavMapBridge & {
      start: () => string | null | void;
      pause: () => void;
      resume: () => void;
      stop: () => string | void;
      diag?: (message: string) => void;
      getState: () => string;
      /** 네이티브가 모은 궤적 [[lat,lng],...] — 구버전 앱엔 없다 */
      getPath?: () => string;
      /**
       * 현대 Pleos 차량 빌드 전용 — 코스 전체(DrivePlanHandoff JSON)를 현대 내비 연동
       * 모듈에 넘긴다. 넘기면 true: 길 안내(음성)는 현대 내비가 맡는다.
       */
      startPleosCourse?: (json: string) => boolean;
      resumePleosCourse?: (json: string) => boolean;
      canStartPleosCourse?: () => boolean;
      cancelPleosRoute?: () => string | null;
      pleosSupport?: () => import("@/lib/guided-start").PleosSupport;
      verifyPleosInactive?: () => string | null;
      holdLocalAudio?: () => void;
      abortProvisionalDrive?: (id?: string) => boolean | void;
      /** 현대 Pleos 차량 앱: 이 차 전용 자동 로그인 자격(JSON {id, secret}) */
      carCredentials?: () => string | null;
      requestCarCredentials?: (requestId: string) => void;
      setAuthenticatedOwner?: (owner: string, vinHash: string) => void;
      clearAuthenticatedOwner?: () => void;
      setOfflineRecordingOwner?: (owner: string) => void;
      getVehicleTrace?: () => string;
      setGForceOpen?: (open: boolean) => void;
      getUnassignedTripCount?: () => number;
      adoptUnassignedTrips?: (owner: string) => boolean;
      isPleosAudioOwned?: () => boolean;
      useLocalAudio?: () => boolean | void;
      /** 차 경로 안내 주인 자리 — 이 앱 안내 직전 요청, 끝나면 내려놓음. 뺏기면 drivenative-navfocus-lost */
      requestNavFocus?: () => boolean;
      abandonNavFocus?: () => void;
      hasNavFocus?: () => boolean;
      /** 자체 내비 음성 — 네이티브 TTS (WebView는 speechSynthesis가 안 됨) */
      speak?: (text: string) => void;
      /** 차량 UX 제한(주행 중) — 바뀌면 window 'drivenative-ux' 이벤트 */
      uxRestricted?: () => boolean;
      /** 위치 권한 보유 여부 — 안드로이드 런타임 권한(ACCESS_FINE_LOCATION) */
      hasLocationPermission?: () => boolean;
      notificationsAllowed?: () => boolean;
      /**
       * 위치 권한 요청 — 아직 물어본 적 없거나 재요청 가능하면 시스템
       * 다이얼로그를, "다시 묻지 않음"으로 영구 거부됐으면 앱 설정 화면을 연다.
       * 결과가 나오면 window 'drivenative-perm' 이벤트로 웹에 알린다.
       */
      requestLocation?: () => void;
      /** 센서 원본 기록(테스트) — 1.3 이상 앱에만 있다 */
      isRawLog?: () => boolean;
      setRawLog?: (on: boolean) => void;
      /** 이동수단 지정 시작 · 폰에 남은 마감 기록 (1.4+) */
      startMode?: (mode: string, id?: string) => string | null | void;
      getPendingTrips?: () => string;
      ackPendingTrip?: (startTs: string) => void;
      flushUploads?: () => void;
      /** 폰의 마지막 위치(JSON) / 지금 위치 새로 받기 – window.__driveLoc (1.5+) */
      getLastLocation?: () => string;
      requestCurrentLocation?: (id: string) => void;
      /** 앱 상세 설정 화면 열기 — 권한을 수동으로 켜게 유도 */
      openAppSettings?: () => void;
      /** 우리 주소를 외부 브라우저로 — 소셜 로그인은 WebView에서 막혀서 (1.7+) */
      openExternal?: (url: string) => void;
    };
  }
}

/**
 * 소셜 로그인/연동 시작. 앱(1.7+)에선 외부 브라우저로 열고 결과를 일회용 표로
 * 돌려받는다 — 구글은 WebView 로그인을 막고, 앱은 바깥 주소를 브라우저로 넘겨서
 * WebView 안에선 로그인이 끝나지 않는다(oauth-app-handoff).
 */
async function startSocial(provider: "kakao" | "google", link: boolean): Promise<string | null> {
  if (BORROW_SERVER) return "지금은 서버 점검 중이라 계정 기능을 쓸 수 없어요.";
  const native = window.DriveNative;
  if (!native?.openExternal) {
    window.location.href = `/api/auth/oauth/${provider}/start${link ? "?mode=link" : ""}`;
    return null;
  }
  const q = new URLSearchParams({ app: "1" });
  if (link) {
    q.set("mode", "link");
    try {
      const res = await fetch("/api/auth/oauth/app-ticket", { method: "POST" });
      const data = await res.json();
      if (!res.ok || typeof data.ticket !== "string") throw new Error(data.error);
      q.set("lt", data.ticket);
    } catch {
      return "연동을 시작하지 못했어요. 다시 시도해 주세요.";
    }
  }
  native.openExternal(`${location.origin}/api/auth/oauth/${provider}/start?${q}`);
  return null;
}

const fmtM = (m: number) =>
  m >= 950 ? `${(m / 1000).toFixed(1)}km` : `${Math.max(0, Math.round(m / 10) * 10)}m`;

/** 주행 화면 코스 진행 띠 — 다음 경유지 이름·거리, 남은 코스 거리·시간. */
function CourseStrip({ vias, pos, remainM, remainSec, fallbackM }: {
  vias: DrivePlanVia[]; pos: LatLng | null; remainM?: number; remainSec?: number; fallbackM?: number;
}) {
  const [passed, setPassed] = useState<number[]>([]);
  const lat = pos?.lat, lng = pos?.lng;
  useEffect(() => {
    if (lat == null || lng == null) return;
    const hit = vias.map((v, i) => (distanceM({ lat, lng }, v) <= 120 ? i : -1)).filter((i) => i >= 0);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPassed((prev) => (hit.every((i) => prev.includes(i)) ? prev : [...new Set([...prev, ...hit])]));
  }, [lat, lng, vias]);
  const nextIdx = vias.findIndex((_, i) => !passed.includes(i));
  const next = nextIdx >= 0 ? vias[nextIdx] : null;
  const toNext = next && pos ? distanceM(pos, next) : null;
  const remain = remainM ?? fallbackM;
  if (!next && remain == null) return null;
  return (
    <div data-over-map className="mt-2 flex items-center gap-3 rounded-md bg-panel px-4 py-2 text-primary">
      {next ? (
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">
          다음 경유 {next.name || `${nextIdx + 1}번`}
          {toNext != null && <span className="ml-2 tabular-nums text-secondary">{fmtM(toNext)}</span>}
        </span>
      ) : (
        <span className="min-w-0 flex-1 truncate text-[15px] font-semibold">마지막 구간</span>
      )}
      {remain != null && (
        <span className="shrink-0 text-[13px] tabular-nums text-secondary">
          남은 코스 {fmtM(Math.max(0, remain))}
          {remainSec != null && remainSec > 0 ? ` (${fmtEtaDur(remainSec)})` : ""}
        </span>
      )}
    </div>
  );
}

/**
 * 빌려 쓰기 모드 여부를 함수 본문에서 읽을 때 쓰는 상자. 테스트(tests/guided-start 등)는
 * 페이지 함수 본문만 떼어 실행하며 `이름.current` 참조를 기본값 null로 채워 주므로,
 * 이렇게 읽으면 그 테스트들은 기존(서버) 동작을 그대로 검사한다.
 */
const borrowMode = { current: BORROW_SERVER };

const OUTBOX_KEY = "drivelog-outbox-v1";
const NAV_SESSION_KEY = "drivelog-nav-session-v1";
const PENDING_PLAN_KEY = "drivelog-pending-plan-v1";
// 서버 JSON 상한(2MB)보다 여유 있게 작게 묶는다. 긴 polyline의 JSON escape와
// envelope 크기까지 포함해도 413이 나지 않게 실제 UTF-8 바이트로 계산한다.
const REQUEST_BATCH_BYTES = 1_500_000;
const MAX_ACCURACY_M = 80;
const MOVING_KMH = 3;
const MAX_JUMP_M = 500;

function jsonArrayBatches<T>(items: T[], maxItems = 100): T[][] {
  const encoder = new TextEncoder();
  const batches: T[][] = [];
  let batch: T[] = [];
  let bytes = 32;
  for (const item of items) {
    const itemBytes = encoder.encode(JSON.stringify(item)).byteLength + 1;
    if (
      batch.length > 0 &&
      (bytes + itemBytes > REQUEST_BATCH_BYTES || batch.length >= maxItems)
    ) {
      batches.push(batch);
      batch = [];
      bytes = 32;
    }
    batch.push(item);
    bytes += itemBytes;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

function distanceM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * kx);
}

function closestPathIndex(path: LatLng[], point: LatLng): number {
  let best = 0;
  let bestM = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = distanceM(path[i], point);
    if (d < bestM) {
      bestM = d;
      best = i;
    }
  }
  return best;
}

/** 현재 위치–목적지 8방위 (북/북동/…) — "목적지 검색" 방향 표시용 */
const DIR8 = ["북", "북동", "동", "남동", "남", "남서", "서", "북서"];
function bearing8(
  from: { lat: number; lng: number },
  to: { lat: number; lng: number },
): string {
  const kx = Math.cos((from.lat * Math.PI) / 180);
  const deg =
    (Math.atan2((to.lng - from.lng) * kx, to.lat - from.lat) * 180) / Math.PI;
  return DIR8[Math.round(((deg + 360) % 360) / 45) % 8];
}

function fmtSpeed(kmh: number, _mode?: string): string {
  return `${kmh}km/h`;
}

/** 목록 날짜 머리말 — 오늘·어제·올해는 "10월 19일 일요일", 지난해는 연도까지 */
function dayLabel(ts: number): string {
  const d = new Date(ts), now = new Date();
  const day0 = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diff = Math.round((day0(now) - day0(d)) / 86_400_000);
  if (diff === 0) return "오늘";
  if (diff === 1) return "어제";
  return d.toLocaleDateString("ko-KR", {
    ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
    month: "long",
    day: "numeric",
    weekday: "long",
  });
}

function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h > 0
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

function dwellStopsOf(vias?: DrivePlanVia[]): DrivePlanVia[] {
  return (vias ?? []).filter(
    (v) => typeof v.dwellMin === "number" && v.dwellMin > 0,
  );
}

function dwellSecOf(vias?: DrivePlanVia[]): number {
  return dwellStopsOf(vias).reduce((sum, v) => sum + (v.dwellMin ?? 0) * 60, 0);
}

/** 현재 경로 진행점 뒤에 남은 체류 경유지만 고른다. */
interface DwellProgress {
  arrivedAt?: number;
  completed?: boolean;
}

function dwellKey(via: DrivePlanVia, index: number): string {
  return `${index}|${via.name}|${via.lat.toFixed(5)}|${via.lng.toFixed(5)}`;
}

/**
 * 경유지 순서를 지키며 경로상의 위치를 찾는다. 순환 코스가 같은 도로를 두 번
 * 지나면 전역 최근접점은 앞쪽 통과를 골라 뒤 경유지를 이미 지났다고 오판한다.
 */
const dwellIndexCache = new WeakMap<
  LatLng[],
  { vias: DrivePlanVia[]; indices: number[] }
>();
function orderedDwellPathIndices(path: LatLng[], vias: DrivePlanVia[]): number[] {
  const cached = dwellIndexCache.get(path);
  if (cached?.vias === vias) return cached.indices;
  let from = 0;
  const indices = vias.map((via) => {
    let best = from;
    let bestDist = Infinity;
    for (let i = from; i < path.length; i++) {
      const d = distanceM(path[i], { lat: via.lat, lng: via.lng });
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    from = best;
    return best;
  });
  dwellIndexCache.set(path, { vias, indices });
  return indices;
}

function remainingDwellPlan(
  vias: DrivePlanVia[] | undefined,
  path: LatLng[] | undefined,
  progressIdx: number,
  progress: Record<string, DwellProgress>,
  now: number,
): { stops: DrivePlanVia[]; sec: number } {
  const stops = dwellStopsOf(vias);
  const pathIndices = path?.length ? orderedDwellPathIndices(path, vias ?? []) : [];
  let sec = 0;
  const remaining = stops.filter((via) => {
    const originalIndex = (vias ?? []).indexOf(via);
    const state = progress[dwellKey(via, originalIndex)];
    if (state?.completed) return false;
    if (state?.arrivedAt) {
      const left = Math.max(0, (via.dwellMin ?? 0) * 60 - (now - state.arrivedAt) / 1000);
      sec += left;
      return left > 0;
    }
    if (!path || path.length < 2) {
      sec += (via.dwellMin ?? 0) * 60;
      return true;
    }
    const viaIdx = pathIndices[originalIndex] ?? path.length - 1;
    // GPS 스냅이 경유지 바로 앞에서 몇 점 건너뛰는 오차를 허용한다.
    const future = progressIdx <= viaIdx + 5;
    if (future) sec += (via.dwellMin ?? 0) * 60;
    return future;
  });
  return { stops: remaining, sec: Math.round(sec) };
}

/** 주행 전·주행 중 어디서도 체류 일정이 사라지지 않게 같은 모양으로 표시한다. */
function DwellSchedule({
  vias,
  className = "",
}: {
  vias?: DrivePlanVia[];
  className?: string;
}) {
  const stops = dwellStopsOf(vias);
  if (stops.length === 0) return null;
  return (
    <div
      className={`flex items-center gap-2 overflow-x-auto whitespace-nowrap text-[12px] ${className}`}
    >
      <span className="shrink-0 font-semibold text-accent-text">체류</span>
      {stops.map((v, i) => (
        <span
          key={`${v.name}-${v.lat}-${v.lng}-${i}`}
          className="shrink-0 rounded-sm bg-accent-surface px-2 py-1 font-medium text-accent-text"
        >
          {v.name}에서 {v.dwellMin}분
        </span>
      ))}
    </div>
  );
}

const accountStorageKey = (base: string, userHash: string) => `${base}:${userHash}`;

const loadOutbox = (userHash: string): DriveRecord[] => {
  try {
    const arr = JSON.parse(
      localStorage.getItem(accountStorageKey(OUTBOX_KEY, userHash)) ?? "[]",
    );
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
};
const saveOutbox = (userHash: string, list: DriveRecord[]): boolean => {
  try {
    localStorage.setItem(
      accountStorageKey(OUTBOX_KEY, userHash),
      JSON.stringify(list),
    );
    return true;
  } catch {
    return false;
  }
};

/**
 * 빌려 쓰기 모드의 기기 보관함 — 서버 대신 여기에만 저장한다(최신 순).
 * 기기 안에서 AES-GCM으로 암호화해 둔다(src/lib/secure-store.ts). 예전 평문은 처음 읽을 때 암호화해 다시 저장한다.
 */
const validLocalRecords = (arr: unknown): DriveRecord[] =>
  Array.isArray(arr)
    ? arr.filter((r) => r && typeof r.id === "string" && typeof r.startTs === "number")
    : [];
/** 읽기 결과 — locked면 암호문을 지금 열 수 없으니 그 위에 덮어쓰지 않는다. */
const readLocalRecords = async (userHash: string): Promise<{ list: DriveRecord[]; locked: boolean }> => {
  const key = accountStorageKey(LOCAL_RECORDS_KEY, userHash);
  const got = await readSecureJson(key);
  if (got.ok) {
    const list = validLocalRecords(got.value);
    // 예전 평문 보관함 — 읽은 그대로 암호화해 다시 저장한다(내용은 그대로)
    if (!got.encrypted && Array.isArray(got.value) && got.value.length > 0) await writeSecureJson(key, got.value);
    return { list, locked: false };
  }
  if (got.reason === "corrupt") {
    // 열쇠가 바뀌었거나 손상 — 원본은 옆 키에 남겨 두고 새로 시작한다
    try {
      const raw = localStorage.getItem(key);
      if (raw != null) localStorage.setItem(`${key}:unreadable`, raw);
    } catch {}
    console.warn("[local-records] 기록 보관함을 열지 못해 새로 시작");
    return { list: [], locked: false };
  }
  return { list: [], locked: true };
};
/** 보관함 읽기·쓰기를 한 줄로 세운다(동시 저장이 서로 덮어쓰거나 늦은 읽기가 새 저장을 가리지 않게). */
let localRecordsQueue: Promise<unknown> = Promise.resolve();
const inLocalRecordsQueue = <T,>(job: () => Promise<T>): Promise<T> => {
  const run = localRecordsQueue.then(job);
  localRecordsQueue = run.catch(() => null);
  return run;
};
const loadLocalRecords = (userHash: string): Promise<DriveRecord[]> =>
  inLocalRecordsQueue(() => readLocalRecords(userHash)).then((r) => r.list, () => []);
const saveLocalRecords = async (userHash: string, list: DriveRecord[]): Promise<DriveRecord[] | null> => {
  // 같은 id는 앞(새 값)만 남기고, 최신 순으로 저장한다
  const seen = new Set<string>();
  const sorted = list
    .filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)))
    .sort((a, b) => b.startTs - a.startTs);
  return (await writeSecureJson(accountStorageKey(LOCAL_RECORDS_KEY, userHash), sorted)) ? sorted : null;
};
/** 읽고-고치고-쓰기. 보관함이 잠겼거나 저장에 실패하면 null. */
const updateLocalRecords = (
  userHash: string,
  change: (current: DriveRecord[]) => DriveRecord[],
): Promise<DriveRecord[] | null> =>
  inLocalRecordsQueue(async () => {
    const { list, locked } = await readLocalRecords(userHash);
    if (locked) return null;
    return saveLocalRecords(userHash, change(list));
  }).catch(() => null);

/** 서버 세션 도입 전 로컬 키를 같은 아이디로 재로그인한 경우에만 이관한다. */
function migrateLegacyAccountStorage(previous: User | null, next: User): void {
  if (!previous || previous.name !== next.name || previous.hash === next.hash) return;
  try {
    for (const base of [OUTBOX_KEY, RECENT_KEY, NAV_SESSION_KEY]) {
      const target = accountStorageKey(base, next.hash);
      if (localStorage.getItem(target)) continue;
      const oldScoped = localStorage.getItem(accountStorageKey(base, previous.hash));
      const oldGlobal = localStorage.getItem(base);
      const value = oldScoped ?? oldGlobal;
      if (!value) continue;
      if (base === NAV_SESSION_KEY) {
        const session = JSON.parse(value);
        localStorage.setItem(target, JSON.stringify({ ...session, userHash: next.hash }));
      } else {
        localStorage.setItem(target, value);
      }
    }
    localStorage.removeItem(OUTBOX_KEY);
    localStorage.removeItem(RECENT_KEY);
    localStorage.removeItem(NAV_SESSION_KEY);
  } catch {
    // 로컬 저장소 사용 불가 — 서버 기록에는 영향 없음
  }
}

/** 주소를 동 단위까지만 — 번지수는 뗀다 */
const coarse = (addr: string) =>
  addr
    .split(" ")
    .filter((t) => !/^\d/.test(t))
    .slice(0, 4)
    .join(" ");

/** 지도 위에 얹힌 띠(위 안내·아래 정보바)의 실제 높이(px). 재기 전·화면에서 빠진 뒤엔 null.
 *  단추가 커지거나 줄이 늘어도 지도 단추가 띠 밑으로 들어가지 않게 지도 여백으로 넘긴다. */
function useMeasuredHeight(): [(el: HTMLDivElement | null) => void, number | null] {
  const [height, setHeight] = useState<number | null>(null);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) {
      setHeight(null);
      return;
    }
    const measure = () => {
      const next = Math.round(el.offsetHeight);
      setHeight((prev) => (prev === next ? prev : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    observer.current = new ResizeObserver(measure);
    observer.current.observe(el);
  }, []);
  return [ref, height];
}

export default function FundrivePage() {
  const pleos = usePleosFeed();
  const pleosCamera = pleos.feed?.cameras[0];
  const [phase, setPhase] = useState<"idle" | "driving" | "paused" | "done">(
    "idle",
  );
  /** 차가 움직이는 중(차량 UX 제한) + 주행 기록 전 — 코스 찾기·목록·하위 화면을 막고 단순 화면만 */
  const uxRestricted = useUxRestricted();
  const uxBlocked = uxRestricted && phase === "idle";
  /** 코스추천과 주행 시작을 한 화면에 두고 프로필만 별도 탭으로 둔다. */
  const [tab, setTab] = useState<
    "course" | "places" | "gas" | "conquest" | "profile"
  >("course");
  /** 장소 탭 — 현재 위치 주변 드라이브 명소 (null=미조회) */
  const [placeList, setPlaceList] = useState<
    (Place & { type?: string })[] | null
  >(null);
  const [placesLoading, setPlacesLoading] = useState(false);
  /** 서버/네트워크 오류를 "없음"과 구분 — 오류는 재시도 안내로 표시 */
  const [placesError, setPlacesError] = useState(false);
  /** 주유소 탭 — 오피넷 주변 주유소·유가 */
  const [gasList, setGasList] = useState<
    | null
    | {
        id: string;
        name: string;
        brand: string;
        price: number;
        distanceM: number;
        offM?: number;
        coord: LatLng;
      }[]
  >(null);
  const [gasLoading, setGasLoading] = useState(false);
  const [gasError, setGasError] = useState(false);
  /** 조회 이펙트를 강제로 다시 돌리는 재시도 카운터 */
  const [gasReload, setGasReload] = useState(0);
  const [gasSort, setGasSort] = useState<"price" | "distance">("price");
  const [gasFuel, setGasFuel] = useState<"gasoline" | "diesel">("gasoline");
  /** 주유소 범위 — 내 주변 vs 가는 길(현재 코스 경로) */
  const [gasMode, setGasMode] = useState<"near" | "route">("near");
  const [kmh, setKmh] = useState(0);
  // G-Force 패널은 정차 중에만 연다(Pleos 정책: 주행 중 애니메이션·게임 요소 금지).
  // 정차 = 차량 주행 제한이 없고 시속 3km 미만. 출발하면 열려 있던 패널도 닫는다.
  const gStopped = !uxRestricted && kmh < 3;
  useEffect(() => {
    if (!gStopped) setGOpen(false);
  }, [gStopped]);
  /** 화면 속도가 터널 속 추정값인지(바퀴 진동) — 단위 옆에 '추정' 표시 */
  const [kmhEst, setKmhEst] = useState(false);
  const [maxKmh, setMaxKmh] = useState(0);
  const [distM, setDistM] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [addr, setAddr] = useState("");
  /** 지금 한국 밖인지 — 해외면 카카오 기반 길찾기를 숨기고 기록만 지원 */
  const [abroad, setAbroad] = useState(false);
  const [gpsErr, setGpsErr] = useState<string | null>(null);
  /**
   * 위치 권한 게이트 상태 — 권한 없이는 내비/기록이 사실상 동작 못 하므로
   * 로그인 다음 단계로 권한을 확인해 막는다. "checking"=조회 중(깜빡임 방지),
   * "granted"=통과, "prompt"=아직 안 물음(요청 버튼), "denied"=거부됨(웹은
   * 브라우저 설정 안내, 앱은 설정 점프), "unsupported"=geolocation 미지원.
   */
  const [geoPerm, setGeoPerm] = useState<
    "checking" | "granted" | "prompt" | "denied" | "unsupported"
  >("checking");
  const [records, setRecords] = useState<DriveRecord[]>([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [liveTripOwner, setLiveTripOwner] = useState<string | null>(null);
  const [recordSaveNotice, setRecordSaveNotice] = useState<string | null>(null);
  /** 삭제 오터치 방지 — 한 번 누르면 '삭제?' 확인 상태, 다시 누르면 실제 삭제 */
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [summary, setSummary] = useState<DriveRecord | null>(null);

  /** 트립 상세 — TripRank 스타일 전체화면(지도·속도분포·스탯) */
  const [tripDetail, setTripDetail] = useState<DriveRecord | null>(null);
  /** 프로필 '지난 주행' 목록 — 기본은 최근 날짜 몇 개만, '더 보기'로 펼친다 */
  const [recordsExpanded, setRecordsExpanded] = useState(false);
  /** 날짜 묶음 접기 — 누른 적 없는 날짜는 맨 위(가장 최근)만 펼친다 */
  const [openDays, setOpenDays] = useState<Record<string, boolean>>({});
  // 지나온/방문한 시·군·구 — null=미조회/로딩, []=조회했으나 없음
  const [tripRegions, setTripRegions] = useState<Region[] | null>(null);
  const [conquestRegions, setConquestRegions] = useState<Region[] | null>(null);
  /** 정복한 행정동 폴리곤 — 정복 지도에 반투명 칠 */
  const [conquestDongs, setConquestDongs] = useState<{ rings: number[][] }[]>([]);
  const [isNative, setIsNative] = useState(false);
  // 오프라인 지도 저장 — null=대기, {done,total}=진행중, "done"=완료
  /** 오프라인 지도 저장 — 진행 중 {done,total}, 끝나면 {saved,total}(전부 못 받았으면 일부/실패 표시) */
  const [offlineDL, setOfflineDL] = useState<
    { done: number; total: number } | { saved: number; total: number } | null
  >(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const [backupMsg, setBackupMsg] = useState<string | null>(null);
  // 소셜 연동 완료 안내(콜백 ?linked=…) — 몇 초 뒤 자동으로 사라지는 토스트
  const [linkedMsg, setLinkedMsg] = useState<string | null>(null);
  // 이 계정에 이미 연결된 소셜 provider — 연동 버튼을 숨기는 데 쓴다
  const [linkedProviders, setLinkedProviders] = useState<string[]>([]);
  // 프로필 우측 상단에서 여는 설정 패널
  const [settingsOpen, setSettingsOpen] = useState(false);
  // 계정 삭제 — 되돌릴 수 없어 2단계 확인 후에만 실행한다
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deletingAccount, setDeletingAccount] = useState(false);
  /**
   * 코스 추천 탭 링크 — 렌더 중 location 분기로 href를 만들면 SSR
   * HTML("/")과 hydration 결과가 어긋나고, React는 속성 불일치를 패치하지
   * 않아 drivelog 도메인(앱 WebView)에서 눌러도 같은 페이지만 다시 열렸다.
   * 마운트 후 setState로 바꿔야 실제 DOM에 반영된다.
   */
  const [courseHref, setCourseHref] = useState("/");
  /**
   * 설정: 내비(코스 안내) 주행 자동 기록 — 끄면 안내만 받고 저장 안 함.
   * localStorage lazy-init은 SSR HTML과 어긋나면 React가 DOM 속성을 패치하지
   * 않아 저장값이 off여도 토글이 켜져 보인다 — 마운트 후 setState로 읽는다.
   */
  const [navRecordOn, setNavRecordOn] = useState(true);
  const navRecordOnRef = useRef(navRecordOn);
  navRecordOnRef.current = navRecordOn;
  /** 설정: 자동 기록 시작 — 앱이 떠 있을 때 지속 이동 감지 시 알아서 기록 시작 */
  const [autoStartOn, setAutoStartOn] = useState(true);
  /** 설정: 자동 일시중지 — 주행 중 5분 정차 시 자동 일시중지(재출발 시 자동 재개) */
  const [autoPauseOn, setAutoPauseOn] = useState(true);
  /** 설정: 일반 주행(기록만) 전방 단속카메라 경고 — 끄면 배너·음성 모두 안 뜬다.
   *  computeFreeWarnings가 렌더 밖 콜백에서 읽으므로 stale 방지로 ref로 참조. */
  const [camWarnOn, setCamWarnOn] = useState(true);
  const camWarnOnRef = useRef(camWarnOn);
  camWarnOnRef.current = camWarnOn;
  /** 앱(네이티브)이 백그라운드까지 모은 지나온 경로 — 지도 표시용 */
  const [nativeTrace, setNativeTrace] = useState<LatLng[] | null>(null);
  const nativeTraceAt = useRef(0);
  /** 설정: 코스 주행 시작 시 오프라인 지도 자동 저장 */
  const [offlineAutoOn, setOfflineAutoOn] = useState(false);
  /** 센서 원본 기록 — null이면 앱이 이 기능을 모름(웹·구버전 앱) */
  const [rawLogOn, setRawLogOn] = useState<boolean | null>(null);
  /** 개발자 옵션 — 앱 판단 기록 업로드 + 주행 화면 "다름"·"비교" 버튼 */
  const [devOn, setDevOn] = useState(false);
  const [compareOn, setCompareOn] = useState(false);
  const offlineAutoOnRef = useRef(offlineAutoOn);
  offlineAutoOnRef.current = offlineAutoOn;
  /** 이번 주행이 설정 때문에 저장 생략됐는지 — 요약 화면 안내용 */
  const [recordSkipped, setRecordSkipped] = useState(false);

  const [plan, setPlan] = useState<DrivePlan | null>(null);
  // 저장된 안내 소유권과 별개로 자체 안내에는 명시적인 허용이 필요하다.
  const guideModeRef = useRef<GuideMode>("none");
  // 차 경로 안내 주인 자리 — "local"(이 앱 안내)일 때만 잡는다
  // 주행 스냅샷 저장 순번 — 늦게 끝난 암호화가 새 값을 덮지 않게
  const navSessionSeq = useRef(0);
  const navFocus = useRef(createNavFocus(() => (typeof window === "undefined" ? null : window.DriveNative)));
  const [guideMode, setGuideMode] = useState<GuideMode>("none");
  const recordingIdRef = useRef<string | null>(null);
  const recordingAckRef = useRef(false);
  const recoveryPendingRef = useRef<string | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const notificationNoticeShownRef = useRef(false);
  const [notificationNotice, setNotificationNotice] = useState<string | null>(null);
  const recordingDeniedRef = useRef(false);
  const cancelRequestIdRef = useRef<string | null>(null);
  const restoredGuidanceRef = useRef<{ recordingId: string | null; guidance: unknown; idx: number } | null>(null);
  const [guideFailure, setGuideFailure] = useState<string | null>(null);
  // 키보드가 올라오면(입력창 포커스 + 화면 높이 축소) 하단 탭바를 숨긴다
  const [kbOpen, setKbOpen] = useState(false);
  useEffect(() => {
    const vv = window.visualViewport;
    const check = () => {
      const el = document.activeElement;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA");
      const shrunk = vv ? vv.height < window.screen.height * 0.75 || vv.height < window.innerHeight - 80 : false;
      setKbOpen(typing && shrunk);
    };
    const onOut = () => setTimeout(check, 50);
    vv?.addEventListener("resize", check);
    window.addEventListener("resize", check);
    document.addEventListener("focusin", check);
    document.addEventListener("focusout", onOut);
    return () => {
      vv?.removeEventListener("resize", check);
      window.removeEventListener("resize", check);
      document.removeEventListener("focusin", check);
      document.removeEventListener("focusout", onOut);
    };
  }, []);

  useEffect(() => {
    window.__pleosNativeActive = onNativeGuideActive;
    return () => { delete window.__pleosNativeActive; };
  }, []);

  /**
   * 현대 Pleos 차량 앱(복사본 셸)에서만 true — 셸에만 있는 startPleosCourse 다리로 판별.
   * 차에서 의미 없는 기능(주유소)을 숨긴다. 휴대폰·웹은 그대로.
   */
  const [carBuild, setCarBuild] = useState(false);
  const guideSelectionGen = useRef(0);
  const guideRequest = useRef<{ plan: DrivePlan; mode: TripMode; onStarted?: () => void } | null>(null);
  const guideDecisionBusy = useRef(false);
  const provisionalPendingPlan = useRef<{ value: string | null } | null>(null);
  const [guideChoice, setGuideChoice] = useState(false);
  const [guideBusy, setGuideBusy] = useState(false);
  const [guideMessage, setGuideMessage] = useState<string | null>(null);
  useEffect(() => {
    setCarBuild(typeof window.DriveNative?.startPleosCourse === "function");
    try { window.DriveNative?.diag?.(`startup webRevision=${process.env.NEXT_PUBLIC_WEB_REVISION ?? "unknown"}`); } catch {}
  }, []);
  const planRef = useRef<DrivePlan | null>(null);
  planRef.current = plan;
  /**
   * 이번 주행에 적용된 계획 — planRef는 매 렌더 plan 상태로 덮어써지므로
   * (독립 내비처럼 상태 없이 시작하는 경우) 시작 시점에 확정해 finalize까지
   * 유지하는 별도 ref.
   */
  const activePlanRef = useRef<DrivePlan | null>(null);
  /** 자체 내비 — 회전·단속캠 안내 (플래너 코스가 물려 있을 때) */
  const navEng = useRef<NavEngine | null>(null);
  const [navReady, setNavReady] = useState(false);
  const [navSt, setNavSt] = useState<NavState | null>(null);
  const [navPos, setNavPos] = useState<LatLng | null>(null);
  const [navHeading, setNavHeading] = useState<number | null>(null);
  /** 실시간 위치 — 경로 안내 없이 기록만 할 때 지도 중심(현위치) 표시용 */
  const [livePos, setLivePos] = useState<LatLng | null>(null);
  // 일반 주행(목적지 없음) 상시 안내 — 현위치 제한속도 + 전방 단속카메라 경고
  // tagged=확정(OSM 태그·단속카메라), false=도로급 법정 추정. source로 세부 구분.
  const [freeLimit, setFreeLimit] = useState<{
    kmh: number;
    tagged: boolean;
    source: "osm" | "camera" | "default";
  } | null>(null);
  const freeLimitRef = useRef<typeof freeLimit>(null);
  freeLimitRef.current = freeLimit;
  const [freeCamWarn, setFreeCamWarn] = useState<{
    kind: string;
    limitKmh: number;
    school: boolean;
    distM: number;
  } | null>(null);
  const freeCamsRef = useRef<FreeCam[]>([]);
  /** 직전 /api/free-drive 응답의 앞쪽 임시경로 시작 링크 — 다음 조회에 돌려줘 평행도로 튐 방지 */
  const freeChainLink = useRef<string | null>(null);
  const freeFetchPos = useRef<LatLng | null>(null);
  // 방금 음성으로 말한 카메라. 화면 배너가 말한 카메라를 먼저 보여 주게 한다.
  const freeSpokenFocus = useRef<string | null>(null);
  /** 마지막으로 성공한 free-drive 요청의 진행방향 — 크게 꺾으면 제한속도를 바로 다시 받는다 */
  const freeFetchHd = useRef<number | null>(null);
  const freeFetchAt = useRef(0);
  // 이미 울린 카메라(키 – 카메라). 서버 목록은 지나친 카메라를 빼므로, 같은 자리
  // 중복 억제·1km 지나 재경고 판단은 이 저장본으로 한다(2026-10-19 채점 v5: 같은 교차로 두 번 경고 80회).
  const freeCamSpoke = useRef<Map<string, FreeCam>>(new Map());
  // 마지막 유효 진행방위 — 정차 중(순간 heading=null)에도 전방 카메라 판정 유지
  const freeHeadingRef = useRef<number | null>(null);
  // 위치/속도용 lastFix와 분리한 heading 전용 누적 anchor. 4m 문턱은 그대로 둔다.
  const freeHeadingAnchor = useRef<LatLng | null>(null);
  const navEncRef = useRef(""); // 현재 안내 경로(encoded) — 재탐색 요청용
  const navModeRef = useRef<NavMode>("time"); // 이번 길찾기의 경로 옵션 — 경유지 추가에 재사용
  // 마지막 적용 안내 원본 — 앱을 껐다 켜 세션을 복원할 때 그대로 재적용
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const lastGuidanceRef = useRef<any>(null);
  const sessionRestored = useRef<string | null>(null);
  const navLastFix = useRef<LatLng | null>(null);
  /** 목적지 검색 기준 현재 위치 — "목적지 검색"에서 가까운 순·거리 표시용 */
  const searchOrigin = useRef<LatLng | null>(null);
  const lastNavFeedAt = useRef(0);
  const lastNativeFixTs = useRef(0);
  const lastRerouteAt = useRef(0);
  const [voiceOn, setVoiceOn] = useState(true); // 마운트 후 localStorage 반영
  const voiceOnRef = useRef(voiceOn);
  voiceOnRef.current = voiceOn;
  const audioCtxRef = useRef<AudioContext | null>(null);
  /** 첫 실측 GPS 픽스가 들어왔는지 — "위치 확인 중" 오표시 방지 */
  const [gpsFixed, setGpsFixed] = useState(false);
  // 확정 GPS(정밀 위성 위치) — gpsFixed는 경로 탐색용 대략 위치(와이파이·기지국·최근 위치)로도
  // 켜지지만, 안내는 확정 위치로만 한다. 확정이 처음 잡히거나 2분 넘게 끊겼다 다시 잡히면
  // 길안내 중에 "GPS가 연결되었습니다"(카카오·티맵처럼).
  const gpsConfirmedRef = useRef(false);
  const lastConfirmedAt = useRef(0);
  /** GPS 잡기 전 대략 위치 정확도(m) — 카카오맵처럼 위치를 먼저 보여줄 때 */
  const [approxAcc, setApproxAcc] = useState<number | null>(null);
  const approxAddrAt = useRef(0);

  const [navPicker, setNavPicker] = useState(false);
  /** 검색 화면 열기/닫기 애니메이션 — 마운트(pickerMounted)와 표시(pickerIn)를
   * 분리해 닫힐 때 슬라이드아웃이 끝난 뒤 언마운트한다. transform/opacity만 써서 랙 없음 */
  const [pickerMounted, setPickerMounted] = useState(false);
  const [pickerIn, setPickerIn] = useState(false);
  /** 검색 화면이 주행 중 경유지 추가 모드인지 (아니면 새 목적지) */
  const [viaMode, setViaMode] = useState(false);
  const [destQuery, setDestQuery] = useState("");
  const [destResults, setDestResults] = useState<Place[]>([]);
  const [destSearching, setDestSearching] = useState(false);
  const [destErr, setDestErr] = useState<string | null>(null);
  const destSearchSeq = useRef(0);
  const destSearchAbort = useRef<AbortController | null>(null);
  /** 주행 종료 오터치 방지 — 한 번 누르면 무장, 3초 내 재탭해야 실제 종료 */
  const [stopArm, setStopArm] = useState(false);
  const stopArmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 경로 탐색 중 상태 문구 (null이면 아님) */
  const [navPrep, setNavPrep] = useState<string | null>(null);
  /** 경로 옵션 선택창 — initial=처음 탐색(4개), reroute=재탐색(2개) */
  const [routePick, setRoutePick] = useState<
    { kind: "initial"; dest: RecentDest } | { kind: "reroute" } | null
  >(null);
  /** 길찾기 출발지 — null이면 현재 위치. 코스추천처럼 출발지도 고를 수 있게. */
  const [navOrigin, setNavOrigin] = useState<RecentDest | null>(null);
  /** 검색창이 지금 출발지를 고르는 중인지(아니면 목적지) */
  const [originPick, setOriginPick] = useState(false);
  /** 길찾기 경유지 — 출발–목적지 사이 들를 곳(순서 유지, 카카오 상한 5). */
  const [navVias, setNavVias] = useState<RecentDest[]>([]);
  /** 검색창이 지금 경유지를 고르는 중인지 */
  const [viaPick, setViaPick] = useState(false);
  /** 경로 선택 미리보기 — 모드별 후보(경로·소요·정체샘플) 캐시(눌러본 것만) */
  type NavCand = {
    enc: string;
    durationSec: number;
    distanceM: number;
    tollFare?: number;
    trafficSamples: { lat: number; lng: number; state: number }[];
  };
  const [pickCands, setPickCands] = useState<Partial<Record<NavMode, NavCand>>>(
    {},
  );
  const pickCandsRef = useRef<Partial<Record<NavMode, NavCand>>>({});
  const pickDestRef = useRef<RecentDest | null>(null);
  const pickRequestSeq = useRef(0);
  const pickAbort = useRef<AbortController | null>(null);

  const [pickMode, setPickMode] = useState<NavMode>("time");

  const [pickLoading, setPickLoading] = useState<NavMode | null>(null);
  /** 도착시각(false) – 소요시간(true) 토글 */
  const [pickShowDur, setPickShowDur] = useState(false);
  /** 미리보기 출발지(한 번만 해석해 캐시) */
  const pickOriginRef = useRef<LatLng | null>(null);
  const [recentDests, setRecentDests] = useState<RecentDest[]>([]);
  /** 즐겨찾기 목적지(계정별 localStorage) */
  const [favDests, setFavDests] = useState<RecentDest[]>([]);
  /** 지도에서 고르기 — pick=지금 고르는 칸(출발·경유·목적지)에, fav=즐겨찾기에 추가 */
  const [mapPick, setMapPick] = useState<null | "pick" | "fav">(null);
  /** 자체 내비 실시간 소통 — 남은 경로 색칠용 (초록/노랑/빨강) */
  const [navTraffic, setNavTraffic] = useState<
    { lat: number; lng: number; state: number; speed?: number }[] | null
  >(null);
  const trafficRequestSeq = useRef(0);
  const trafficAbort = useRef<AbortController | null>(null);
  const freeRequestSeq = useRef(0);
  const freeAbort = useRef<AbortController | null>(null);
  const guidanceRequestSeq = useRef(0);
  const guidanceAbort = useRef<AbortController | null>(null);
  const navigationRequestSeq = useRef(0);
  const navigationAbort = useRef<AbortController | null>(null);
  const gasViaRequestSeq = useRef(0);
  const gasViaAbort = useRef<AbortController | null>(null);
  const planConfirmRequestSeq = useRef(0);
  const planConfirmAbort = useRef<AbortController | null>(null);
  /** 최초 선택 계획 — 자동 우회 뒤에도 "원래 코스"로 정확히 돌아가기 위해 보존. */
  const originalPlanRef = useRef<DrivePlan | null>(null);
  const dwellProgressRef = useRef<Record<string, DwellProgress>>({});
  /** 로그인 — 기록을 유저별로 분리. 해시만 서버로 전송. */
  const [user, setUser] = useState<User | null>(null);
  const userRef = useRef<User | null>(null);
  userRef.current = user;
  const [authChecked, setAuthChecked] = useState(false);
  const [loginId, setLoginId] = useState("");
  const [loginPw, setLoginPw] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginErr, setLoginErr] = useState<string | null>(null);
  /** 세션 만료 뒤 남은 구버전 로컬 사용자 — 같은 아이디 재로그인 시 키 이관용. */
  const previousLocalUser = useRef<User | null>(null);
  const recordsSyncSeq = useRef(0);

  const watchRef = useRef<number | null>(null);
  const lastFix = useRef<{ lat: number; lng: number; t: number } | null>(null);
  /** 궤적 — 20m 간격으로 모으고, 너무 길어지면 절반 솎아 간격 2배 */
  const pathRef = useRef<[number, number][]>([]);
  const pathMinM = useRef(20);
  const startTs = useRef(0);
  const movingSec = useRef(0);
  const distRef = useRef(0);
  const maxRef = useRef(0);
  const startAddr = useRef<string | undefined>(undefined);
  const lastAddrAt = useRef(0);
  const lastAddrPos = useRef<{ lat: number; lng: number } | null>(null);
  const addrRef = useRef("");
  const wakeLock = useRef<WakeLockSentinel | null>(null);
  // 자동 기록 시작 — idle 상태에서 지속 이동 감지용
  const autoWatch = useRef<number | null>(null);
  const autoStreak = useRef(0);
  const autoMoveStart = useRef(0);
  const autoLastFix = useRef<{ lat: number; lng: number; ts: number } | null>(null);
  // 자동 일시중지 — 주행 중 N분 정차 시 자동 일시중지, 재출발 감지 시 자동 재개
  const autoPauseOnRef = useRef(true);
  const stationarySince = useRef(0); // 정차 시작 시각(0=이동 중)
  const autoPaused = useRef(false); // 이번 일시중지가 자동인지(수동은 자동재개 안 함)
  const resumeWatch = useRef<number | null>(null); // 자동일시중지 중 재출발 감시
  const resumeStreak = useRef(0);
  const resumeMoveStart = useRef(0);
  const resumeLastFix = useRef<{ lat: number; lng: number; ts: number } | null>(null);
  const resumeVisRef = useRef(() => {});
  autoPauseOnRef.current = autoPauseOn;
  const tickTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const nativePoll = useRef<ReturnType<typeof setInterval> | null>(null);
  const nativeRecovery = useRef<{
    distM: number;
    maxKmh: number;
    movingSec: number;
    startTs: number;
    basePath: [number, number][];
  } | null>(null);
  const nativeRecoveryRequestedAt = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  /** 정지 출발 최고 0–50/0–100(초) — 웹 GPS 모드에서 직접 잰다(앱은 네이티브가) */
  const zeroRef = useRef<{ z50: number | null; z100: number | null }>({ z50: null, z100: null });

  const [gOpen, setGOpen] = useState(false);
  /** 앱이 다시 켜진 뒤 "현대 내비로 코스 안내를 다시 켤까요?"를 묻는 중 */
  const [resumeAsk, setResumeAsk] = useState(false);
  useEffect(() => {
    if (phase === "idle" || phase === "done") setResumeAsk(false);
  }, [phase]);
  // 주행 화면 위·아래 띠의 실제 높이 — 안내/기록 두 화면은 동시에 뜨지 않아 함께 쓴다
  const [overTopRef, overTopH] = useMeasuredHeight();
  const [overBottomRef, overBottomH] = useMeasuredHeight();
  // 개발 서버: 새 지도(기본) – 옛 지도
  const [glMap, setGlMap] = useState(MAP_GL_BUILD);
  useEffect(() => {
    if (!MAP_GL_BUILD) return;
    try {
      if (localStorage.getItem(MAP_ENGINE_KEY) === "classic") setGlMap(false);
    } catch {}
  }, []);
  const nativeMap = useNativeNavMap(phase === "driving" || phase === "paused");
  const NavMapAny = nativeMap.enabled && (!MAP_GL_BUILD || glMap) ? NavMapNative : MAP_GL_BUILD && glMap ? NavMapGL : NavMap;
  const engineToggle = MAP_GL_BUILD
    ? {
        label: glMap ? "옛 지도" : "새 지도",
        onClick: () =>
          setGlMap((v) => {
            try {
              localStorage.setItem(MAP_ENGINE_KEY, v ? "classic" : "gl");
            } catch {}
            return !v;
          }),
      }
    : undefined;

  // 화면(탭·기록 상세·설정·G 패널)이 바뀔 때마다 history에 한 칸 쌓고, 뒤로가기면 그 칸의 화면으로 되돌린다.
  // 화면 버튼으로 바로 앞 화면에 돌아간 경우는 쌓지 않고 history.back() — 칸이 왕복마다 늘지 않게.
  type View = { tab: typeof tab; detail: DriveRecord | null; settings: boolean; g: boolean };
  const viewStack = useRef<View[]>([]);
  const viewIdx = useRef(0);
  const recordsRef = useRef(records);
  useEffect(() => {
    recordsRef.current = records;
  }, [records]);
  useEffect(() => {
    const v: View = { tab, detail: tripDetail, settings: settingsOpen, g: gOpen };
    const same = (a: View, b: View) =>
      a.tab === b.tab && a.detail?.id === b.detail?.id && a.settings === b.settings && a.g === b.g;
    const st = viewStack.current;
    const i = viewIdx.current;
    if (!st.length) {
      st.push(v);
      history.replaceState({ ...history.state, view: 0 }, "");
    } else if (same(v, st[i])) {
      st[i] = v;
    } else if (i > 0 && same(v, st[i - 1])) {
      st[i - 1] = v;
      viewIdx.current = i - 1;
      history.back();
    } else {
      st.length = i + 1;
      st.push(v);
      viewIdx.current = i + 1;
      history.pushState({ view: i + 1 }, "");
    }
  }, [tab, tripDetail, settingsOpen, gOpen]);
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const i = (e.state as { view?: unknown } | null)?.view;
      const v = typeof i === "number" ? viewStack.current[i] : undefined;
      if (!v) return;
      viewIdx.current = i as number;
      setTab(v.tab);
      // 그사이 고쳐진 기록(비행 정보 저장 등)이면 최신 것으로
      setTripDetail(v.detail ? (recordsRef.current.find((r) => r.id === v.detail!.id) ?? v.detail) : null);
      setSettingsOpen(v.settings);
      setGOpen(v.g);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [gLive, setGLive] = useState<GLive | null>(null);
  const ZERO_PEAKS: GPeaks = { accel: 0, brake: 0, left: 0, right: 0 };
  const [gPeaks, setGPeaks] = useState<GPeaks>(ZERO_PEAKS);
  const [liveZ50, setLiveZ50] = useState<number | null>(null);
  // 기록에 남길 G — 화면 상태(gPeaks)와 별개로 ref에 누적(finalize에서 읽음)
  const gRecRef = useRef<{ peaks: GPeaks; env: number[] }>({
    peaks: { accel: 0, brake: 0, left: 0, right: 0 },
    env: new Array(G_BINS).fill(0),
  });
  const gCalcRef = useRef<{ t: number; v: number; brg: number | null; e: GLive }>({
    t: 0,
    v: 0,
    brg: null,
    e: { lat: 0, lon: 0 },
  });
  const launchRef = useRef<{ still: boolean; t0: number; pv: number; pt: number }>({
    still: false,
    t0: -1,
    pv: -1,
    pt: -1,
  });
  /** 진행 중 기록의 이동수단 (차가 아니면 단속카메라·제한속도 안내를 끈다) */
  const modeRef = useRef<TripMode>("car");
  const [activeMode, setActiveMode] = useState<TripMode>("car");

  async function syncRecords() {
    const userHash = userRef.current?.hash;
    if (!userHash) return;
    const request = ++recordsSyncSeq.current;
    const stillCurrent = () =>
      request === recordsSyncSeq.current && userRef.current?.hash === userHash;
    if (userRef.current?.local) {
      // 빌려 쓰기 모드(기기 전용 사용자): 기록은 기기에만 있다. drivelog로 올리거나 받지 않는다.
      const list = await loadLocalRecords(userHash);
      if (stillCurrent()) setRecords(list);
      setPendingCount(0);
      return;
    }
    const outbox = loadOutbox(userHash).map((record) => ({ ...record, owner: userHash }));
    try {
      if (outbox.length > 0) {
        let latestRecords: DriveRecord[] | null = null;
        for (const batch of jsonArrayBatches(outbox)) {
          if (!stillCurrent()) return;
          const res = await fetch("/api/drive-records", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(batch),
          });
          if (!res.ok) throw new Error("기록 동기화 실패");
          const data = await res.json();
          // 보낸 것만 '지금의' 큐에서 뺀다. 시작 때 복사본으로 덮어쓰면 동기화 도중
          // 새로 쌓인 기록이 지워져 서버에도 큐에도 없이 사라졌다. 큐는 계정별
          // 키라 계정이 바뀌었어도 A 큐 정리는 해 둔다(안 하면 다음에 중복 전송).
          const sent = new Set(batch.map((record) => record.id));
          saveOutbox(userHash, loadOutbox(userHash).filter((record) => !sent.has(record.id)));
          if (!stillCurrent()) return;
          latestRecords = Array.isArray(data.records) ? data.records : latestRecords;
        }
        const left = loadOutbox(userHash);
        if (latestRecords) {
          const ids = new Set(latestRecords.map((r) => r.id));
          setRecords([...left.filter((r) => !ids.has(r.id)), ...latestRecords]);
        }
        setPendingCount(left.length);
        return;
      }
      const res = await fetch("/api/drive-records");
      const data = res.ok ? await res.json() : null;
      if (!stillCurrent()) return;
      if (data) setRecords(data.records);
      setPendingCount(loadOutbox(userHash).length);
    } catch {
      if (!stillCurrent()) return;
      // 오프라인 — 큐에 있는 것만 표시용으로 합쳐 보여준다
      const pending = loadOutbox(userHash);
      setPendingCount(pending.length);
      setRecords((prev) => {
        const ids = new Set(prev.map((r) => r.id));
        return [...pending.filter((r) => !ids.has(r.id)), ...prev];
      });
    }
  }
  useEffect(() => {
    setIsNative(!!window.DriveNative);
    installBorrowFetchGuard(window);
    registerTileSW(); // 지도 타일 오프라인 캐시(신호 끊겨도 지도 유지)
    if (!BORROW_SERVER && location.hostname.startsWith("drivelog.")) {
      setCourseHref("https://drive.homesev.duckdns.org");
    }
    try {
      setNavRecordOn(localStorage.getItem("drivelog-nav-record-v1") !== "off");
      setVoiceOn(localStorage.getItem("drivelog-nav-voice-v1") !== "off");
      setAutoStartOn(localStorage.getItem("drivelog-auto-start-v1") !== "off");
      setAutoPauseOn(localStorage.getItem("drivelog-auto-pause-v1") !== "off");
      setCamWarnOn(localStorage.getItem("drivelog-cam-warn-v1") !== "off");
      setOfflineAutoOn(localStorage.getItem("drivelog-offline-auto-v1") === "on");

      if (BORROW_SERVER) {
        // 빌려 쓰기 모드: 센서 원본은 drivelog로 올리지 않는다 — 켜져 있으면 끄고 스위치를 숨긴다.
        if (window.DriveNative?.isRawLog?.()) window.DriveNative.setRawLog?.(false);
      } else if (window.DriveNative?.isRawLog) setRawLogOn(window.DriveNative.isRawLog());
      setDevOn(devModeOn());
    } catch {}
    if (BORROW_SERVER) {
      // 빌려 쓰기 모드: 로그인 없이 이 기기 전용 로컬 사용자로 바로 시작한다.
      // /api/auth·차량 자동 로그인은 부르지 않는다(drivelog에 계정을 만들지 않는다).
      void (async () => {
        let storage: Storage | null = null;
        try { storage = localStorage; } catch {}
        const hash = await sha256Hex(localOwnerSeed(storage));
        const local: User = { hash, name: LOCAL_USER_NAME, local: true };
        try { window.DriveNative?.setAuthenticatedOwner?.(hash, ""); } catch {}
        previousLocalUser.current = local;
        userRef.current = local;
        setUser(local);
        setLoginId(local.name);
        reloadPlaces();
        setAuthChecked(true);
      })();
    }
    const savedUser = BORROW_SERVER ? null : loadUser();
    previousLocalUser.current = savedUser;
    if (savedUser?.name) setLoginId(savedUser.name);
    // 소셜 로그인 콜백이 남긴 welcome(표시 이름)·authError를 읽고 URL을 정리한다.
    const authParams = new URLSearchParams(window.location.search);
    const welcome = authParams.get("welcome");
    const authError = authParams.get("authError");
    const linked = authParams.get("linked");
    if (authError) setLoginErr(authError);
    if (linked) {
      setLinkedMsg(`${linked} 계정이 연동됐어요. 이제 ${linked}로도 로그인할 수 있어요.`);
      window.setTimeout(() => setLinkedMsg(null), 5000);
    }
    if (welcome || authError || linked) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    // UI의 로컬 표시가 아니라 서버의 HttpOnly 세션을 기준으로 로그인 복원.
    if (!BORROW_SERVER) fetch("/api/auth")
      .then(async (r) => {
        if (r.status >= 500) {
          await confirmOfflineRecordingOwner(window, savedUser ? {
            idHash: savedUser.hash, autoCar: savedUser.autoCar, vinHash: savedUser.vinHash,
          } : null, sha256Hex);
          return null;
        }
        if (!r.ok) return null;
        const data = await r.json();
        return typeof data.idHash === "string" ? data : null;
      }, async () => {
        await confirmOfflineRecordingOwner(window, savedUser ? {
          idHash: savedUser.hash, autoCar: savedUser.autoCar, vinHash: savedUser.vinHash,
        } : null, sha256Hex);
        return null;
      })
      .then(async (data) => {
        if (!data) return;
        let credentials: CarCredentials | null = null;
        let credentialsReady = true;
        try { credentials = await readCarCredentials(window); }
        catch {
          credentialsReady = false;
          // 수동 계정은 유지하되 기기 계정의 미확인 복원은 막는다.
          try { credentials = parseCarCredentials(window.DriveNative?.carCredentials?.()); } catch { }
        }
        // 이전 차량 세션에는 autoCar 표시가 없으므로 이 기기의 파생 아이디로 확인한다.
        const autoCar = data.autoCar === true || (!!credentials && (
          data.idHash === await sha256Hex(credentials.id) ||
          (!!credentials.carId && data.idHash === await sha256Hex(credentials.carId))
        ));
        if (autoCar && !credentialsReady) throw new Error("차량 로그인 확인 실패");
        if (autoCar) {
          if (credentials?.vinHash && !data.vinHash) {
            await autoCarAuth(credentials);
            return;
          }
          if (carSessionChanged({ ...data, autoCar: true }, credentials)) {
            // Do not publish A or begin its sync until the current car is reconciled.
            const signedOut = await fetch("/api/auth", { method: "DELETE" });
            if (!signedOut.ok) throw new Error("차량 로그인 확인 실패");
            await autoCarAuth(credentials);
            return;
          }
        }
        const idHash = data.idHash as string;
        if (Array.isArray(data.linkedProviders)) {
          setLinkedProviders(data.linkedProviders.filter((p: unknown) => typeof p === "string"));
        }
        const restored: User = {
          hash: idHash, autoCar, vinHash: data.vinHash,
          // 소셜 로그인 직후면 provider 닉네임(welcome)을 우선 쓰고, 아니면 이
          // 기기에 저장된 이름을 잇는다(공용 기기에서 B 이름으로 A 기록을 보는
          // 혼동은 hash 일치로 막는다).
          name:
            welcome ||
            (savedUser && savedUser.hash === idHash ? savedUser.name : "사용자"),
        };
        window.DriveNative?.setAuthenticatedOwner?.(restored.hash, restored.autoCar ? restored.vinHash ?? "" : "");
        saveUser(restored);
        setUser(restored);
      })
      .catch(() => {})
      .finally(() => setAuthChecked(true));
    reloadPlaces();
    // 다른 도메인의 플래너가 준 일회용 plan id만 읽는다. 성공 즉시 서버에서
    // 소비되며 주소에서도 지워 재사용·리퍼러 노출을 막는다.
    const planId = new URLSearchParams(location.search).get("plan");
    // 플래너가 넘긴 코스(세션 보관함, 기기 안 암호문 — 예전 평문도 읽는다)
    try {
      void readSecureJson(PENDING_PLAN_KEY, secureDepsFor(sessionStorage)).then((got) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pending: any = got.ok ? got.value : null;
        if (
          !(planId && !BORROW_SERVER) &&
          pending &&
          typeof pending.label === "string" &&
          typeof pending.durationSec === "number" &&
          typeof pending.distanceM === "number" &&
          typeof pending.path === "string"
        ) {
          setPlan((current) => current ?? (pending as DrivePlan));
        }
      }, () => {});
    } catch {}
    // 기록은 로그인 후 유저 헤더로 불러온다 (아래 user 의존 effect)
    if (planId && BORROW_SERVER) {
      // 빌려 쓰기 모드: 코스 전달함(/api/drive-plan)은 쓰지 않는다 — 주소만 정리.
      const url = new URL(location.href);
      url.searchParams.delete("plan");
      history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
    } else if (planId) {
      try {
        sessionStorage.removeItem(PENDING_PLAN_KEY);
      } catch {}
      setPlan(null);
      fetch(`/api/drive-plan?id=${encodeURIComponent(planId)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d?.plan) return;
          setPlan(d.plan);
          try {
            void writeSecureJson(PENDING_PLAN_KEY, d.plan, secureDepsFor(sessionStorage));
          } catch {}
        })
        .catch(() => {})
        .finally(() => {
          const url = new URL(location.href);
          url.searchParams.delete("plan");
          history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
        });
    }
    const onOnline = () => syncRecords();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 로그인 계정이 바뀌면 그 계정의 최근 목적지로 다시 로드(로그아웃 시 비움).
  useEffect(() => {
    recordsSyncSeq.current++;
    reloadPlaces();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // 목록에는 요약만 받고 차량 추적은 상세를 열 때 해당 계정에서 조회한다.
  useEffect(() => {
    const id = tripDetail?.id, owner = user?.hash;
    // 기기 전용 사용자(빌려 쓰기 모드): 기기 보관함의 기록이 이미 전체 자료라 서버에 묻지 않는다.
    if (!id || !owner || user?.local) return;
    const ctl = new AbortController();
    fetch(`/api/drive-records?id=${encodeURIComponent(id)}`, { signal: ctl.signal })
      .then((r) => r.ok ? r.json() : null)
      .then((data) => {
        if (ctl.signal.aborted || userRef.current?.hash !== owner || data?.record?.id !== id) return;
        setTripDetail((current) => current?.id === id ? { ...current,
          ...sanitizeVehicleRecord(data.record, current.endTs - current.startTs) } : current);
      })
      .catch(() => {});
    return () => ctl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tripDetail?.id, user?.hash]);

  // 트립 상세 — 지나온 시·군·구 (순서 유지). 경계 판정 실패 시 조용히 빈 목록.
  useEffect(() => {
    if (!tripDetail?.path) {
      setTripRegions(null);
      return;
    }
    let cancelled = false;
    setTripRegions(null);
    fetch("/api/regions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: tripDetail.path }),
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && d && setTripRegions(d.regions ?? []))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [tripDetail]);

  // 정복 지도 — 방문한 시·군·구 유일 집합. 정복 탭을 열 때만 조회.
  useEffect(() => {
    if (tab !== "conquest") return;
    const encs = records.filter((r) => r.path && (r.mode == null || r.mode === "car")).map((r) => r.path!);
    if (encs.length === 0) {
      setConquestRegions([]);
      setConquestDongs([]);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    void (async () => {
      const regionMap = new Map<string, Region>();
      const dongMap = new Map<string, { rings: number[][] }>();
      for (const paths of jsonArrayBatches(encs, 50)) {
        const response = await fetch("/api/regions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("정복 지역 조회 실패");
        const data = (await response.json()) as {
          regions?: Region[];
          dongs?: { rings: number[][] }[];
        };
        for (const region of data.regions ?? []) {
          regionMap.set(`${region.sido}|${region.sigungu}`, region);
        }
        for (const dong of data.dongs ?? []) {
          dongMap.set(JSON.stringify(dong.rings), dong);
        }
      }
      if (cancelled) return;
      setConquestRegions(
        [...regionMap.values()].sort(
          (a, b) =>
            a.sido.localeCompare(b.sido) || a.sigungu.localeCompare(b.sigungu),
        ),
      );
      setConquestDongs([...dongMap.values()]);
    })().catch(() => {});
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [tab, records]);

  function clearPlan() {
    setPlan(null);
    try {
      sessionStorage.removeItem(PENDING_PLAN_KEY);
    } catch {}
  }

  /** 코스 주변 지도 타일을 미리 받아 오프라인(약전파)에서도 지도가 뜨게 한다 */
  async function saveOfflineTiles(pathOverride?: string) {
    const path = pathOverride ?? plan?.path;
    // 진행 중이거나 이미 전부 받았으면 건너뛴다(일부·실패는 다음 코스 시작 때 다시 시도)
    if (!path || (offlineDL && ("done" in offlineDL || offlineDL.saved >= offlineDL.total))) return;
    const pts = decodePolyline(path).map(([lat, lng]) => ({ lat, lng }));
    if (pts.length < 2) return;
    let mode: TileMode = "road";
    try {
      if (localStorage.getItem("drivelog-navmap-mode-v1") === "sat") mode = "sat";
    } catch {}
    setOfflineDL({ done: 0, total: 0 });
    try {
      const r = await prefetchRouteTiles(pts, mode, (done, total) =>
        setOfflineDL({ done, total }),
      );
      setOfflineDL({ saved: r.saved, total: r.total });
    } catch {
      setOfflineDL(null);
    }
  }

  // 로그인이 확정되면 그 유저의 기록을 불러온다
  useEffect(() => {
    if (user) {
      window.DriveNative?.setAuthenticatedOwner?.(user.hash, user.autoCar ? user.vinHash ?? "" : "");
      syncRecords();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // 백업/복구 안내 문구는 4초 뒤 자동으로 사라진다
  useEffect(() => {
    if (!backupMsg) return;
    const t = setTimeout(() => setBackupMsg(null), 4000);
    return () => clearTimeout(t);
  }, [backupMsg]);

  /**
   * 차량 앱 자동 로그인 — 셸이 만든 이 차 전용 아이디·비밀 키로 기존 로그인/가입 API를 그대로
   * 쓴다. 기기 인증 뒤 VIN을 연결하고 차량이 바뀌면 별도 계정을 쓴다.
   */
  const carAuthTried = useRef(false);
  const [carAuthBusy, setCarAuthBusy] = useState(false);
  const [unassignedCount, setUnassignedCount] = useState(0);
  useEffect(() => {
    if (!user || !window.DriveNative) return;
    const refresh = () => {
      if (document.visibilityState === "visible") {
        importPendingTrips();
        if (!BORROW_SERVER) window.DriveNative?.flushUploads?.();
      }
    };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.hash]);
  async function autoCarAuth(credentials?: CarCredentials | null): Promise<boolean> {
    try {
      const cred = credentials ?? await readCarCredentials(window);
      if (!cred) return false;
      const body = await carAuthBody(cred, sha256Hex);
      const res = await fetch("/api/auth", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      if (!res.ok) return false;
      const data = await res.json();
      if (!data || typeof data.idHash !== "string") return false;
      const u: User = { hash: data.idHash, name: "내 차", autoCar: true, vinHash: data.vinHash };
      window.DriveNative?.setAuthenticatedOwner?.(u.hash, cred.vinHash ?? "");
      saveUser(u);
      previousLocalUser.current = u;
      setUser(u);
      return true;
    } catch { return false; }
  }
  useEffect(() => {
    if (BORROW_SERVER || !authChecked || user || carAuthTried.current) return;
    if (typeof window.DriveNative?.requestCarCredentials !== "function" &&
        typeof window.DriveNative?.carCredentials !== "function") return;
    carAuthTried.current = true;
    setCarAuthBusy(true);
    void autoCarAuth().finally(() => setCarAuthBusy(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, user]);

  async function doAuth(mode: "login" | "signup") {
    const id = loginId.trim();
    if (!id || !loginPw) {
      setLoginErr("아이디와 비밀번호를 입력해 주세요.");
      return;
    }
    if (mode === "signup" && loginPw.length < 4) {
      setLoginErr("비밀번호는 4자 이상 입력해 주세요.");
      return;
    }
    setLoginBusy(true);
    setLoginErr(null);
    try {
      // 구분자는 U+0000 — 기존 로그인 버킷과 해시가 동일하게 유지되도록
      // (소스엔 이스케이프로 두어 리터럴 널 바이트가 파일에 안 들어가게).
      const hash = await sha256Hex(id + String.fromCharCode(0) + loginPw);
      const idHash = await sha256Hex(id);
      // 서버 검증 게이트 — 비번 불일치/미가입/중복을 명확히 거부한다.
      const res = await fetch("/api/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mode, idHash, credHash: hash }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setLoginErr(
          j.error || (mode === "signup" ? "가입에 실패했어요" : "로그인에 실패했어요"),
        );
        return;
      }
      const data = await res.json();
      if (typeof data.idHash !== "string") throw new Error("세션 발급 실패");
      const u: User = { hash: data.idHash, name: id, vinHash: data.vinHash };
      migrateLegacyAccountStorage(previousLocalUser.current, u);
      saveUser(u);
      previousLocalUser.current = u;
      setLoginPw("");
      setUser(u);
    } catch {
      setLoginErr("처리 중 오류가 났어요");
    } finally {
      setLoginBusy(false);
    }
  }
  function doLogin(e?: React.FormEvent) {
    e?.preventDefault();
    void doAuth("login");
  }

  /** 기록 전체를 JSON 파일로 내려받는다 — 로그인 분실 대비 백업 */
  function exportRecords() {
    if (records.length === 0) {
      setBackupMsg("내보낼 기록이 없어요");
      return;
    }
    const blob = new Blob([JSON.stringify(records)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `gubi-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setBackupMsg(`${records.length}개 기록을 파일로 저장했어요`);
  }

  /** 백업 파일을 지금 로그인한 계정으로 복원(병합) — 새 계정으로도 복구 가능 */
  async function importRecords(file: File) {
    try {
      const arr = JSON.parse(await file.text());
      if (!Array.isArray(arr) || arr.length === 0) throw new Error("형식 오류");
      if (BORROW_SERVER) {
        // 빌려 쓰기 모드: 서버 대신 이 기기 보관함에 합친다.
        const owner = userRef.current?.hash;
        if (!owner) throw new Error("사용자 없음");
        let added = 0;
        const saved = await updateLocalRecords(owner, (current) => {
          const have = new Set(current.map((r) => r.id));
          const incoming = (arr.slice(0, 500) as DriveRecord[])
            .filter((r) => r && typeof r.id === "string" && typeof r.startTs === "number" && !have.has(r.id))
            .map((r) => ({ ...r, owner }));
          added = incoming.length;
          return [...incoming, ...current];
        });
        if (!saved) throw new Error("저장 공간 부족");
        if (userRef.current?.hash === owner) setRecords(saved);
        setBackupMsg(`${added}개 기록을 복원했어요`);
        return;
      }
      let added = 0;
      let latestRecords: DriveRecord[] | null = null;
      for (const batch of jsonArrayBatches(arr.slice(0, 500))) {
        const res = await fetch("/api/drive-records", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(batch),
        });
        if (!res.ok) throw new Error("서버 오류");
        const data = await res.json();
        added += Number(data.added) || 0;
        if (Array.isArray(data.records)) latestRecords = data.records;
      }
      if (latestRecords) setRecords(latestRecords);
      setBackupMsg(`${added}개 기록을 복원했어요`);
    } catch {
      setBackupMsg("백업 파일을 확인해 주세요.");
    }
  }

  function logout() {
    if (BORROW_SERVER) return;
    carAuthTried.current = true;
    recordsSyncSeq.current++;
    clearNavSession();
    void fetch("/api/auth", { method: "DELETE" }).catch(() => {});
    clearUser();
    clearPlan();
    previousLocalUser.current = null;
    sessionRestored.current = null;
    userRef.current = null;
    window.DriveNative?.clearAuthenticatedOwner?.();
    setUser(null);
    setRecords([]);
    setPendingCount(0);
  }

  /**
   * 계정 삭제 — 서버가 기록 버킷·로그인 자격·모든 세션을 지운다(유저 지시:
   * 계정 삭제 시 기록까지 함께 삭제). 서버 삭제가 성공해야 로컬을 비우고,
   * 아직 동기화 안 된 로컬 큐(outbox)도 지워 다른 계정에 새지 않게 한다.
   */
  async function deleteAccount() {
    const current = user;
    if (BORROW_SERVER || !current || deletingAccount) return;
    setDeletingAccount(true);
    // 진행 중 동기화가 삭제된 버킷을 되살리지 않게 먼저 중단한다
    recordsSyncSeq.current++;
    try {
      const res = await fetch("/api/auth?action=delete-account", {
        method: "DELETE",
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "계정 삭제에 실패했어요");
      }
    } catch (e) {
      setDeletingAccount(false);
      setDeleteConfirm(false);
      setBackupMsg(e instanceof Error ? e.message : "계정 삭제에 실패했어요");
      return;
    }
    // 로컬 잔여 데이터 정리 — 이 계정의 미동기화 큐까지 함께 비운다
    try {
      saveOutbox(current.hash, []);
    } catch {
      // 로컬 저장소 접근 실패는 무시 — 서버에서 이미 지워졌다
    }
    clearNavSession();
    clearUser();
    clearPlan();
    previousLocalUser.current = null;
    sessionRestored.current = null;
    userRef.current = null;
    window.DriveNative?.clearAuthenticatedOwner?.();
    setUser(null);
    setRecords([]);
    setPendingCount(0);
    setDeleteConfirm(false);
    setDeletingAccount(false);
  }

  useEffect(() => {
    if (phase !== "driving" && phase !== "paused") return;
    const acquire = async () => {
      try {
        wakeLock.current = (await navigator.wakeLock?.request("screen")) ?? null;
      } catch {
        // 미지원 — 무시
      }
    };
    acquire();
    const onVis = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      wakeLock.current?.release?.().catch(() => {});
      wakeLock.current = null;
    };
  }, [phase]);

  // 앱이 앞에 떠 있는 idle 상태에서 지속 이동(≈15km/h·12초·5픽스)을 감지하면
  // 버튼 없이 알아서 일반 기록을 시작한다. 순간 이동·정차엔 반응 안 하고,
  // 앱이 백그라운드면 감시 안 함(배터리). 설정에서 끌 수 있다.
  useEffect(() => {
    if (phase !== "idle" || guideChoice || !user || !autoStartOn || !navigator.geolocation) {
      return;
    }
    const clear = () => {
      if (autoWatch.current !== null) {
        navigator.geolocation.clearWatch(autoWatch.current);
        autoWatch.current = null;
      }
      autoStreak.current = 0;
      autoLastFix.current = null;
    };
    const arm = () => {
      if (autoWatch.current !== null || document.visibilityState !== "visible") {
        return;
      }
      autoWatch.current = navigator.geolocation.watchPosition(
        (pos) => {
          if (phaseRef.current !== "idle") return;
          const { latitude: lat, longitude: lng, speed } = pos.coords;
          const ts = pos.timestamp;
          // 속도(m/s): 기기 제공값 우선, 없으면 직전 픽스와의 거리/시간
          let mps = typeof speed === "number" && speed >= 0 ? speed : -1;
          const prev = autoLastFix.current;
          if (mps < 0 && prev) {
            const dm = distanceM({ lat, lng }, { lat: prev.lat, lng: prev.lng });
            const dt = (ts - prev.ts) / 1000;
            if (dt > 0 && dm < 500) mps = dm / dt; // 점프(500m+) 제외
          }
          autoLastFix.current = { lat, lng, ts };
          if (mps * 3.6 > 15) {
            if (autoStreak.current === 0) autoMoveStart.current = ts;
            autoStreak.current++;
            // 5픽스 이상 + 12초 이상 지속 이동이면 진짜 주행 – 자동 시작
            if (autoStreak.current >= 5 && ts - autoMoveStart.current >= 12_000) {
              clear();
              start(undefined, "car", false, { recordingOnly: true }); // 계획 없이 일반 기록
            }
          } else {
            autoStreak.current = 0;
          }
        },
        () => {}, // 오류는 무시 — 다음 기회에 다시
        { enableHighAccuracy: false, maximumAge: 5_000, timeout: 20_000 },
      );
    };
    arm();
    const onVis = () => {
      if (document.visibilityState === "visible") arm();
      else clear();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, user, autoStartOn, guideChoice]);

  // 대기 화면에선 주소 조회가 안 돌아 해외인지 모른다 — 들어올 때 한 번 위치로 판정.
  // 권한이 이미 있을 때만: 웹은 버튼(클릭) 없이 물었다 거부되면 다시 못 묻는다.
  useEffect(() => {
    if (phase !== "idle" || !user || geoPerm !== "granted") return;
    let alive = true;
    quickPosition()
      .then((p) => fetch(`/api/revgeocode?coord=${p.lng},${p.lat}`))
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (alive && data) setAbroad(data.abroad === true);
      })
      .catch(() => {}); // 위치를 못 받으면 국내로 두고 넘어간다
    return () => {
      alive = false;
    };
  }, [phase, user, geoPerm]);

  /** approx=true: GPS 전 대략 위치 — 화면 표시만, 기록의 출발지 주소로는 안 남긴다 */
  async function updateAddr(lat: number, lng: number, approx = false) {
    const now = Date.now();
    const moved =
      !lastAddrPos.current || distanceM(lastAddrPos.current, { lat, lng }) > 700;
    if (now - lastAddrAt.current < 30_000 && !moved) return;
    if (now - lastAddrAt.current < 10_000) return;
    lastAddrAt.current = now;
    lastAddrPos.current = { lat, lng };
    try {
      const res = await fetch(`/api/revgeocode?coord=${lng},${lat}`);
      if (!res.ok) return;
      const data = await res.json();
      setAbroad(data.abroad === true);
      if (data.place?.address) {
        const c = coarse(data.place.address);
        addrRef.current = c;
        setAddr(c);
        // 출발 직후 찾은 주소만 출발지로 사용한다.
        if (!startAddr.current && !approx && Date.now() - startTs.current < 5 * 60_000) startAddr.current = c;
      } else if (!approx) {
        // 주소를 못 찾는 곳(해외·바다) — 예전 주소가 남아 도착지로 잘못 저장되지 않게 지운다
        addrRef.current = "";
        setAddr("");
      }
    } catch {
      // 주소는 장식
    }
  }

  // 앱이 뒤로 가면 말하던 웹 음성도 끊는다(네이티브 음성은 안드로이드 쪽이 막는다)
  useEffect(() => cancelSpeechWhenHidden(), []);

  function speakNav(texts: string[]) {
    if (texts.length > 0) devlog("say", { text: texts.join(" "), muted: !voiceOnRef.current });
    // 현대 내비가 안내 중이면 안내 음성은 한 곳(순정)만 — 단일 활성 내비 원칙
    if (!localGuidanceAllowed(guideModeRef.current)) return;
    // 앱이 뒤에 있으면 안내하지 않는다(놓친 안내는 나중에 다시 말하지 않는다)
    if (!pageVisibleForGuidance()) return;
    if (!voiceOnRef.current || texts.length === 0) return;
    const text = texts.join(" ");
    if (window.DriveNative?.speak) {
      try {
        window.DriveNative.speak(text);
        return;
      } catch {
        // 구버전 앱 — 웹 폴백
      }
    }
    try {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ko-KR";
      u.rate = 1.05;
      speechSynthesis.cancel(); // 새 안내가 묵은 안내를 끊는다
      speechSynthesis.speak(u);
    } catch {
      // 미지원 — 화면 배너로 충분
    }
  }

  function beepNav() {
    if (!localGuidanceAllowed(guideModeRef.current) || !voiceOnRef.current) return; // 현대 내비 안내 중에는 비프도 끈다
    if (!pageVisibleForGuidance()) return;
    try {
      audioCtxRef.current ??= new AudioContext();
      const ctx = audioCtxRef.current;
      const t = ctx.currentTime;
      for (const start of [0, 0.22]) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = 1250;
        o.connect(g);
        g.connect(ctx.destination);
        g.gain.setValueAtTime(0.22, t + start);
        g.gain.exponentialRampToValueAtTime(0.01, t + start + 0.13);
        o.start(t + start);
        o.stop(t + start + 0.14);
      }
    } catch {
      // 오디오 불가 — 음성/화면으로 충분
    }
  }

  /* eslint-disable @typescript-eslint/no-explicit-any */
  function applyGuidance(d: any) {
    if (!localGuidanceAllowed(guideModeRef.current)) return;
    // 경로 취소로 내려놓은 뒤 새 목적지를 받으면 자리를 다시 요청한다
    if (!navFocus.current.held()) {
      setGuidanceMode("local");
      if (!localGuidanceAllowed(guideModeRef.current)) return;
    }
    const pts = decodePolyline(d.path).map(([lat, lng]) => ({ lat, lng }));
    if (pts.length < 2) throw new Error("안내 경로가 비어 있습니다");
    navEncRef.current = d.path;
    const data = {
      path: pts,
      maneuvers: d.maneuvers,
      cams: d.cams,
      narrows: d.narrows,
      speeds: d.speeds,
      calibMul: d.calibMul,
      limits: d.limits,
      totalM: d.totalM,
    };
    const firstLoad = !navEng.current;
    if (navEng.current) navEng.current.load(data);
    else navEng.current = new NavEngine(data);
    setNavReady(true);
    // 안내를 시작했는데 아직 확정 GPS가 없으면(대략 위치로 경로만 찾은 상태) 알려 두고,
    // 확정이 잡히면 markGpsConfirmed가 "GPS가 연결되었습니다"
    if (firstLoad && phaseRef.current === "driving" && !gpsConfirmedRef.current) {
      speakNav(["GPS 신호를 찾고 있습니다."]);
    }
    fetchNavTraffic(pts, d.path);
    // 안내가 바뀌면 세션 스냅샷도 갱신 — 재실행 시 이 경로로 이어가게
    lastGuidanceRef.current = d;
    saveNavSession();
  }
  /* eslint-enable @typescript-eslint/no-explicit-any */

  /** nav-route 요청은 한 번에 하나만 유효하다. 늦은 옛 응답이 새 경로를 덮지 않는다. */
  async function fetchAndApplyGuidance(
    payload: { path: string; from?: LatLng; idx?: number; heading?: number },
  ): Promise<boolean> {
    if (!localGuidanceAllowed(guideModeRef.current)) return false;
    const request = ++guidanceRequestSeq.current;
    guidanceAbort.current?.abort();
    const controller = new AbortController();
    guidanceAbort.current = controller;
    try {
      const res = await fetch("/api/nav-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await res.json();
      if (request !== guidanceRequestSeq.current || controller.signal.aborted || !localGuidanceAllowed(guideModeRef.current))
        return false;
      if (!res.ok || typeof data.path !== "string") return false;
      applyGuidance(data);
      return true;
    } catch {
      return false;
    }
  }

  /** 남은 경로의 실시간 소통 — 카카오 길찾기 소통 상태로 색칠(실패 시 서버가 ITS로 대신) */
  async function fetchNavTraffic(pts: LatLng[], routeId = navEncRef.current) {
    // 빌려 쓰기 모드: drivelog엔 이 API가 없다(404). 색칠은 장식이라 부르지 않는다.
    if (pts.length < 2 || borrowMode.current) return;
    const request = ++trafficRequestSeq.current;
    trafficAbort.current?.abort();
    const controller = new AbortController();
    trafficAbort.current = controller;
    try {
      const res = await fetch("/api/route-traffic-kakao", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: pts }),
        signal: controller.signal,
      });
      if (!res.ok) return;
      const data = await res.json();
      if (
        request !== trafficRequestSeq.current ||
        controller.signal.aborted ||
        routeId !== navEncRef.current
      )
        return;
      if (Array.isArray(data.samples)) {
        setNavTraffic(data.samples);
        // 실시간 정체를 ETA 적분에 반영하고 카카오(또는 ITS) 총 소요초로 앵커링한다.
        navEng.current?.setTraffic(
          data.samples,
          typeof data.durationSec === "number" ? data.durationSec : undefined,
        );
        void applyHyundaiAheadTraffic(pts, data.samples, request, routeId);
      }
    } catch {
      // 소통 색칠은 장식 — 실패해도 안내는 그대로
    }
  }

  /**
   * 차 앱이면 앞 구간을 현대 예상 경로 소통으로 덮어쓴다(현대 예상은 출발지가 지금 차 위치).
   * 20km→10km→5km→2.5km→1km 앞 지점을 차례로 물어, 현대 거리와 맞는 가장 먼 구간까지만 쓴다.
   * 모두 다르면(드라이브 코스가 빠른 길과 다른 경우) 카카오 색을 그대로 둔다.
   */
  async function applyHyundaiAheadTraffic(
    pts: LatLng[],
    samples: { lat: number; lng: number; state: number }[],
    request: number,
    routeId: string | null | undefined,
  ) {
    if (!pleosAvailable()) return;
    const from = navEng.current?.progress.idx ?? 0;
    for (const aheadM of AHEAD_STEPS_M) {
      const leg = legAhead(pts, from, aheadM);
      if (leg.lengthM < 500) continue;
      const trip = await requestPleosTrip(`ahead:${aheadM}:${Date.now()}`, leg.end, "앞 구간");
      if (request !== trafficRequestSeq.current || routeId !== navEncRef.current) return;
      if (!isPleosTripResult(trip)) return;
      const merged = applyHyundaiAhead(samples, leg, trip.distanceM, trip.traffic);
      if (merged === samples) continue;
      setNavTraffic(merged);
      navEng.current?.setTraffic(merged);
      return;
    }
  }

  async function requestReroute(
    lat: number,
    lng: number,
    sourcePath = navEncRef.current,
    sourceIdx = navEng.current?.progress.idx ?? 0,
    announce = true,
    heading: number | null = navHeading,
  ): Promise<boolean> {
    const now = Date.now();
    if (now - lastRerouteAt.current < 6_000) return false;
    lastRerouteAt.current = now;
    devlog("reroute", { lat, lng, heading, announce });
    const ok = await fetchAndApplyGuidance({
      path: sourcePath,
      from: { lat, lng },
      idx: sourceIdx,
      // 진행 방위 — 복귀 경로가 뒤로 돌아가지 않게 역방향 시작을 페널티.
      heading: heading ?? undefined,
    });
    if (ok && announce) {
      speakNav(["새로운 경로로 안내합니다."]);
    }
    return ok;
  }

  /** 수동 재탐색 — keep=원래 코스로 복귀, time=목적지까지 최단시간 새 경로 */
  async function runReroute(mode: "keep" | "time") {
    closeRoutePick();
    const eng = navEng.current;
    const cur = navLastFix.current ?? navPos;
    if (!eng || eng.path.length < 2 || !cur) {
      setDestErr("현재 위치를 확인할 수 없어요");
      return;
    }
    if (mode === "keep") {
      const original = originalPlanRef.current;
      if (!original?.path) {
        setDestErr("복귀할 원래 경로가 없어요");
        return;
      }
      const originalPts = decodePolyline(original.path).map(([lat, lng]) => ({
        lat,
        lng,
      }));
      lastRerouteAt.current = 0; // 수동 요청은 스로틀 무시하고 즉시
      const ok = await requestReroute(
        cur.lat,
        cur.lng,
        original.path,
        closestPathIndex(originalPts, cur),
        false,
      );
      if (ok) {
        activePlanRef.current = original;
        setPlan(original);
        speakNav(["원래 코스로 돌아갑니다."]);
        saveNavSession();
      } else {
        setDestErr("원래 경로 재탐색에 실패했어요");
      }
      return;
    }
    // 최단시간 — 원래 코스를 버리고 현위치–목적지 새 경로
    navigationAbort.current?.abort();
    const controller = new AbortController();
    navigationAbort.current = controller;
    const request = ++navigationRequestSeq.current;
    setNavPrep("경로 탐색 중…");
    try {
      const dest = eng.path[eng.path.length - 1];
      const res = await fetch("/api/nav-directions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: { lat: cur.lat, lng: cur.lng },
          destination: { lat: dest.lat, lng: dest.lng },
          mode: "time",
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (request !== navigationRequestSeq.current) return;
      if (!res.ok || !data.candidate?.path?.length) {
        throw new Error(data.error ?? "경로를 찾지 못했어요");
      }
      const c = data.candidate;
      const enc = encodePolyline(
        data.candidate.path.map((p: LatLng): [number, number] => [p.lat, p.lng]),
      );
      if (!(await fetchAndApplyGuidance({ path: enc })))
        throw new Error("안내 생성 실패");
      lastRerouteAt.current = Date.now();
      const previous = activePlanRef.current;
      const rerouted: DrivePlan = {
        label: previous?.label ? `${previous.label} · 최단시간` : "최단시간 경로",
        durationSec: c.durationSec,
        distanceM: c.distanceM,
        path: enc,
        standalone: true,
        ts: Date.now(),
      };
      activePlanRef.current = rerouted;
      setPlan(rerouted);
      speakNav(["최단 시간 경로로 다시 안내합니다."]);
      setNavPrep(null);
    } catch (e) {
      if (controller.signal.aborted || request !== navigationRequestSeq.current) return;
      setNavPrep(null);
      setDestErr(e instanceof Error ? e.message : "재탐색 실패");
    }
  }

  /** 경로 취소 — 목적지 안내를 끄고 기록만 이어간다(기록 모드: 단속·제한속도 안내도 끔) */
  function cancelRoute() {
    planConfirmRequestSeq.current++;
    planConfirmAbort.current?.abort();
    navigationRequestSeq.current++;
    navigationAbort.current?.abort();
    guidanceRequestSeq.current++;
    guidanceAbort.current?.abort();
    trafficRequestSeq.current++;
    trafficAbort.current?.abort();
    navEng.current = null;
    navEncRef.current = "";
    setNavReady(false);
    setNavSt(null);
    setNavPos(null);
    setNavTraffic(null);
    setNavPrep(null);
    lastGuidanceRef.current = null;
    // 안내를 접었으니 이 주행은 더 이상 '내비 주행'이 아니다 — 계획 태그를 지워
    // 내비 자동기록 OFF 설정이라도 자유 주행으로 기록되게(취소 안내 멘트와 일치).
    activePlanRef.current = null;
    originalPlanRef.current = null;
    // 경로 안내를 끝내면 기록 모드로 — 자리를 내려놓고(setGuidanceMode가 반납) 음성·단속 안내도 멈춘다.
    navFocus.current.release();
    setGuidanceMode("none");
    saveNavSession();
  }

  function feedNav(lat: number, lng: number, brg?: number) {
    const eng = navEng.current;
    if (!eng || phaseRef.current !== "driving") return;
    const prev = navLastFix.current;
    let heading: number | null = null;
    if (typeof brg === "number" && brg >= 0) {
      heading = brg; // GPS 칩 방위가 픽스 간 계산보다 정확
    } else if (prev && distanceM(prev, { lat, lng }) > 4) {
      const kx = 111_320 * Math.cos((lat * Math.PI) / 180);
      heading =
        (Math.atan2((lng - prev.lng) * kx, (lat - prev.lat) * 111_320) * 180) /
        Math.PI;
    }
    if (heading !== null) setNavHeading(heading);
    navLastFix.current = { lat, lng };
    lastNavFeedAt.current = Date.now();
    const st = eng.update(lat, lng, heading);
    devlog("nav", {
      lat, lng, hd: heading, along: Math.round(st.along), offM: Math.round(st.offM), offRoute: st.offRoute,
      next: st.next ? { d: Math.round(st.next.distM), type: st.next.m.type } : null,
      cam: st.cam ? { d: Math.round(st.cam.distM), lat: st.cam.c.lat, lng: st.cam.c.lng, limit: st.cam.c.limitKmh } : null,
      limit: st.limitKmh, reroute: st.needReroute, speak: st.speak.length ? st.speak : undefined,
    });
    updateDwellProgress(lat, lng, eng, st);
    setNavPos(st.pos); // 경로 위 스냅 좌표 — 차가 선 위를 탄다
    setNavSt(st);
    if (st.speak.length > 0) speakNav(st.speak);
    if (st.beep) beepNav();
    if (st.needReroute) requestReroute(lat, lng, undefined, undefined, true, heading);
  }

  function updateDwellProgress(
    lat: number,
    lng: number,
    eng: NavEngine,
    st: NavState,
  ) {
    const vias = activePlanRef.current?.vias ?? [];
    if (vias.length === 0) return;
    const viaPathIndices = orderedDwellPathIndices(eng.path, vias);
    const now = Date.now();
    for (let i = 0; i < vias.length; i++) {
      const via = vias[i];
      if (!via.dwellMin || via.dwellMin <= 0) continue;
      const key = dwellKey(via, i);
      const state = dwellProgressRef.current[key] ?? {};
      if (state.completed) continue;
      if (state.arrivedAt) {
        if (now - state.arrivedAt >= via.dwellMin * 60_000) {
          dwellProgressRef.current[key] = { ...state, completed: true };
        }
        continue;
      }
      const viaIdx = viaPathIndices[i] ?? eng.path.length - 1;
      const nearRouteProgress = st.pos
        ? Math.abs(eng.progress.idx - viaIdx) <= 80
        : false;
      if (nearRouteProgress && distanceM({ lat, lng }, via) <= 100) {
        dwellProgressRef.current[key] = { arrivedAt: now };
      } else if (eng.progress.idx > viaIdx + 5) {
        // 실제로 들르지 않고 지나친 경유지는 이후 ETA에서 제외한다.
        dwellProgressRef.current[key] = { completed: true };
      }
    }
  }

  // 반경 2km 카메라 목록은 1km마다 천천히 받고, 경고는 매 픽스마다 폰이 판단한다.
  // 헛경고보다 안 울리는 게 문제라 서버 재확인으로 막지 않는다. 경로 안내(navEng)가
  // 있을 땐 NavEngine이 처리하므로 동작 안 함.
  async function refreshFreeDrive(lat: number, lng: number, heading: number | null) {
    if (modeRef.current !== "car") return;
    // 이 앱이 안내하지 않으면(기록만·현대 내비 안내) 단속·제한속도를 보이지 않으니 위치도 보내지 않는다
    if (!localGuidanceAllowed(guideModeRef.current)) return;
    const now = Date.now();
    const moved = freeFetchPos.current
      ? distanceM(freeFetchPos.current, { lat, lng })
      : Infinity;
    // Gubi: 제한속도 표시가 도로 바뀔 때 빨리 갱신되도록 200m/8초마다 받는다(원본은 카메라만 1km마다).
    // 교차로에서 40도 넘게 꺾으면 거리·시간과 무관하게 바로 다시 받는다(꺾은 도로의 제한속도).
    // 기준 방향은 성공한 응답의 요청 방향이라, 요청 중에 꺾었으면 끝난 뒤 다음 픽스에서 다시 받는다.
    const turned =
      freeFetchHd.current != null &&
      heading != null &&
      Math.abs(((heading - freeFetchHd.current + 540) % 360) - 180) > 40;
    if (!turned && moved < 200 && now - freeFetchAt.current < 8_000) return;
    // 진행 중인 요청은 취소하지 않는다. 응답이 5초보다 느릴 때 다시 보내며 취소하면 목록을 영영 못 받는다.
    if (freeAbort.current) return;
    // 위치는 성공했을 때만 옮기므로, 실패하면 5초 뒤 다시 받는다(꺾었을 때는 2초).
    if (now - freeFetchAt.current < (turned ? 2_000 : 5_000)) return;
    freeFetchAt.current = now;
    const request = ++freeRequestSeq.current;
    const controller = new AbortController();
    freeAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(), FREE_CAM_LIST_TIMEOUT_MS);
    try {
      const res = await fetch("/api/free-drive", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat, lng, heading, prevLinkId: freeChainLink.current }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error("free-camera verification failed");
      const d = await res.json();
      if (request !== freeRequestSeq.current || controller.signal.aborted) return;
      // tagged=확정(OSM·카메라). 표지판은 확정만 그린다(추정은 표시 안 함).
      setFreeLimit(
        d.limitKmh > 0
          ? { kmh: d.limitKmh, tagged: d.source !== "default", source: d.source }
          : null,
      );
      freeCamsRef.current = Array.isArray(d.cams) ? d.cams : [];
      freeChainLink.current = typeof d.chainLinkId === "string" ? d.chainLinkId : null;
      freeFetchPos.current = { lat, lng };
      freeFetchHd.current = heading;
    } catch {
      // 조회 실패 — 이전 목록을 유지하고 5초 뒤 다시 받는다
      if (request === freeRequestSeq.current) freeFetchAt.current = Date.now();
    } finally {
      clearTimeout(timeout);
      if (freeAbort.current === controller) freeAbort.current = null;
    }
  }

  function speakFreeCamCandidate(candidate: ForwardCam, cams: readonly FreeCam[]) {
    const key = candidate.deviceId ?? `${candidate.lat.toFixed(4)},${candidate.lng.toFixed(4)}`;
    if (freeCamSpoke.current.has(key)) return;
    const clusterSpoken = [...freeCamSpoke.current.values()].some((c) => sameFreeCameraCluster(c, candidate));
    if (clusterSpoken) return;

    freeSpokenFocus.current = key;
    freeCamSpoke.current.set(key, cams.find((c) => (c.deviceId ?? `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`) === key) ?? (candidate as FreeCam));
    beepNav();
    const what = candidate.school
      ? "어린이보호구역, 단속카메라"
      : candidate.kind === "section"
        ? "구간단속 구간"
        : candidate.kind === "signal"
          ? "전방 신호 단속카메라"
          : "전방 단속카메라";
    speakNav([
      candidate.limitKmh ? `${what}, 제한속도 ${candidate.limitKmh}.` : `${what}.`,
    ]);
  }

  function computeFreeWarnings(
    lat: number,
    lng: number,
    heading: number | null,
    curKmh: number,
  ) {
    // 전방 단속카메라 — 경로가 없는 자유주행이라 "전방"을 진행방향으로만 추정한다.
    // 정차로 순간 heading이 없어도 마지막 진행방위로 판정(뒤쪽 오경보 방지).
    // 선택 로직은 selectForwardCam(src/lib/free-cam.ts)에 순수 함수로 분리 —
    // cam-sim 하네스가 같은 코드를 가상주행으로 검증한다. 설정에서 카메라 경고를
    // 끄면(camWarnOn=off) 통째로 건너뛴다.
    const hd = heading ?? freeHeadingRef.current;
    // 목록의 도로 판정은 받은 지점 기준이라 낡았다. 폰은 거리·각도·카메라 방향만 본다.
    const freeList = withoutPositionJudgment(freeCamsRef.current);
    const best = camWarnOnRef.current
      ? selectForwardCam({ lat, lng }, hd, freeList, { ignoreOnRoad: true })
      : null;
    // 한 번 지나쳐 1km 넘게 멀어진 카메라는 발화 기록에서 지운다 — 순환·왕복
    // 코스에서 되돌아와 다시 접근하면 재경고되게(안 그러면 복귀 차로 카메라를
    // 통째로 놓쳐 과속 위험). 접근 중(≤900m)엔 유지해 중복 억제.
    for (const [key, c] of freeCamSpoke.current) {
      if (distanceM({ lat, lng }, { lat: c.lat, lng: c.lng }) > 1000) freeCamSpoke.current.delete(key);
    }
    // 발화 거리는 속도에 맞춘다 — 13초 앞. 고정 600m는 저속에서 너무 이르다.
    // 그 사이 다른 길로 빠지는 경우가 많아 그대로 헛경고가 된다.
    // 너무 촉박해지지 않게 140m 아래로는 안 내려간다(상한은 종전과 같은 600m).
    // 2026-10-07: 최소 250m→140m. 71개 실경로 재생(티맵 장비 포함)에서 카카오 정답과
    // 맞춤 143→142(−1), 헛경고 143→129(−14). 헛경고 대부분이 시속 54km 안팎에서
    // 최소값 250m에 걸려 너무 일찍 울린 뒤 앞 교차로에서 꺾은 경우였다.
    const voiceGateM = Math.max(140, Math.min(600, (curKmh / 3.6) * 13));
    devlog("cam", {
      lat, lng, hd, kmh: Math.round(curKmh), stale: true, gate: Math.round(voiceGateM), n: freeCamsRef.current.length,
      best: best ? { id: best.deviceId, d: Math.round(best.distM), lat: best.lat, lng: best.lng, limit: best.limitKmh, kind: best.kind } : null,
      off: !camWarnOnRef.current || undefined,
    });
    // 이미 말한 앞 카메라가 바로 뒤 카메라를 가리지 않게, 말할 후보는 말한 카메라를 빼고 고른다.
    const spokenList = [...freeCamSpoke.current.values()];
    const unspoken = camWarnOnRef.current
      ? selectForwardCam(
          { lat, lng },
          hd,
          freeList.filter(
            (c) =>
              !freeCamSpoke.current.has(c.deviceId ?? `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`) &&
              !spokenList.some((s) => sameFreeCameraCluster(s, c)),
          ),
          { ignoreOnRoad: true },
        )
      : null;
    if (unspoken && unspoken.distM <= voiceGateM) speakFreeCamCandidate(unspoken, freeList);
    // 화면은 방금 말한 카메라가 아직 앞에 있으면 그 카메라를, 아니면 가장 가까운 카메라를 보여 준다.
    const focusCam = freeList.find(
      (c) => (c.deviceId ?? `${c.lat.toFixed(4)},${c.lng.toFixed(4)}`) === freeSpokenFocus.current,
    );
    const focused =
      focusCam && camWarnOnRef.current
        ? selectForwardCam({ lat, lng }, hd, [focusCam], { ignoreOnRoad: true })
        : null;
    // 더 이상 앞에 없으면 초점을 푼다. 나중에 되돌아와도 옛 카메라가 다시 앞서지 않게 한다.
    if (!focused) freeSpokenFocus.current = null;
    const shown = focused ?? best;
    setFreeCamWarn(
      shown
        ? { kind: shown.kind, limitKmh: shown.limitKmh, school: shown.school, distM: shown.distM }
        : null,
    );
  }

  // 추측항법 — GPS 공백(터널) 동안에도 마지막 속도로 경로를 따라
  // 안내를 이어간다 (안내는 누적거리 기반이라 그대로 나온다)
  useEffect(() => {
    if (phase !== "driving" || !navReady) return;
    const t = setInterval(() => {
      if (Date.now() - lastNavFeedAt.current < 2500) return;
      const st = navEng.current?.coast(1);
      if (!st) return;
      setNavPos(st.pos);
      if (st.pathBearing !== null) setNavHeading(st.pathBearing);
      setNavSt(st);
      if (st.speak.length > 0) speakNav(st.speak);
      if (st.beep) beepNav();
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, navReady]);

  // 실시간 소통 주기 갱신 — 2분마다 남은 경로 색칠을 새로 받는다
  useEffect(() => {
    if (phase !== "driving" || !navReady) return;
    const t = setInterval(() => {
      const eng = navEng.current;
      if (eng?.path?.length) fetchNavTraffic(eng.path);
    }, 120_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, navReady]);

  const jumpCand = useRef<[number, number] | null>(null);
  /** 궤적 각 점의 속도(km/h) — pathRef와 인덱스 일치 */
  const speedsRef = useRef<number[]>([]);
  function addPathPt(lat: number, lng: number, kmh = 0) {
    const pts = pathRef.current;
    const last = pts[pts.length - 1];
    if (last) {
      const d = distanceM({ lat: last[0], lng: last[1] }, { lat, lng });
      if (d < pathMinM.current) return;
      if (d > MAX_JUMP_M) {
        // 단발 점프(위성 튐)는 버리되, 다음 픽스가 같은 곳이면 진짜 이동
        // (터널 통과 등)으로 보고 받는다 — 아니면 궤적이 영영 끊긴다
        const c = jumpCand.current;
        jumpCand.current = [lat, lng];
        if (!c || distanceM({ lat: c[0], lng: c[1] }, { lat, lng }) > 200) return;
      }
    }
    jumpCand.current = null;
    pts.push([Math.round(lat * 1e5) / 1e5, Math.round(lng * 1e5) / 1e5]);
    speedsRef.current.push(Math.round(kmh));
    if (pts.length > 4000) {
      pathRef.current = pts.filter((_, i) => i % 2 === 0 || i === pts.length - 1);
      speedsRef.current = speedsRef.current.filter(
        (_, i) => i % 2 === 0 || i === speedsRef.current.length - 1,
      );
      pathMinM.current *= 2;
    }
  }

  // 주행 안내 중 앱을 껐다 켜도 같은 경로 안내를 이어가게 localStorage에 스냅샷.
  // 경로·회전·단속캠(안내 원본)과 진행 위치(idx), 기록 누적값을 함께 담는다.
  function navSessionKey(): string | null {
    const userHash = userRef.current?.hash;
    return userHash ? accountStorageKey(NAV_SESSION_KEY, userHash) : null;
  }
  /**
   * 저장은 기기 안 암호문으로 한다. 페이지가 숨겨지거나 닫히는 순간(urgent)엔 기다릴 수 없으니
   * 평문으로 바로 한 번 쓰고, 이어서 같은 내용을 암호문으로 덮어쓴다. 프로세스가 그 사이 죽어
   * 평문이 남아도 다음 실행의 복원 직후 저장(3초마다)에서 암호문으로 바뀐다.
   * 늦게 끝난 옛 암호화가 더 새 값(또는 지운 세션)을 덮지 않게 순번을 확인한다.
   */
  function saveNavSession(urgent = false) {
    const ph = phaseRef.current;
    if (ph !== "driving" && ph !== "paused") return;
    const key = navSessionKey();
    const userHash = userRef.current?.hash;
    if (!key || !userHash) return;
    const seq = ++navSessionSeq.current;
    try {
      const snapshot = {
        v: 1,
        userHash,
        phase: ph,
        guideMode: guideModeRef.current,
        recordingId: recordingIdRef.current,
        notificationNoticeShown: notificationNoticeShownRef.current,
        cancelRequestId: cancelRequestIdRef.current,
        guidance: lastGuidanceRef.current ?? restoredGuidanceRef.current?.guidance,
        plan: activePlanRef.current,
        originalPlan: originalPlanRef.current,
        startTs: startTs.current,
        distM: distRef.current,
        maxKmh: maxRef.current,
        movingSec: movingSec.current,
        startAddr: startAddr.current,
        path: pathRef.current,
        speeds: speedsRef.current,
        dwellProgress: dwellProgressRef.current,
        idx: navEng.current?.progress.idx ?? restoredGuidanceRef.current?.idx ?? 0,

        mode: modeRef.current,
        savedAt: Date.now(),
      };
      if (urgent) localStorage.setItem(key, JSON.stringify(snapshot));
      void sealJson(snapshot).then((text) => {
        if (seq !== navSessionSeq.current) return;
        try {
          localStorage.setItem(key, text);
        } catch {}
      }, () => {});
    } catch {
      // 용량 초과 등 — 안내는 계속되므로 조용히 무시
    }
  }
  function clearNavSession() {
    navSessionSeq.current++; // 진행 중인 암호화 저장이 지운 세션을 되살리지 않게
    const key = navSessionKey();
    if (!key) return;
    try {
      localStorage.removeItem(key);
    } catch {}
  }

  // 주행 중 주기적 + 백그라운드 진입 직전 스냅샷 — 하드킬에도 최신 진행 보존
  useEffect(() => {
    if (phase !== "driving" && phase !== "paused") return;
    saveNavSession();
    const iv = setInterval(() => saveNavSession(), 3000);
    const onHide = () => saveNavSession(true);
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("pagehide", onHide);
    return () => {
      clearInterval(iv);
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("pagehide", onHide);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  // 차의 안내 주인 자리 — 뺏김 알림, 화면 복귀 때 놓친 뺏김 확인, 페이지 닫힘 때 내려놓기.
  useEffect(() => {
    const focus = navFocus.current;
    const onLost = () => onNavFocusLost();
    const onVisible = () => {
      if (document.visibilityState === "visible" && focus.lostSilently()) onNavFocusLost();
    };
    const onHide = (e: PageTransitionEvent) => {
      if (!e.persisted) focus.release();
    };
    window.addEventListener(NAV_FOCUS_LOST_EVENT, onLost);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", onHide);
    return () => {
      window.removeEventListener(NAV_FOCUS_LOST_EVENT, onLost);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", onHide);
      focus.release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // 주행이 끝나면(앱 밖 종료 포함) 이 앱 안내도 끝 — 자리를 내려놓는다
  useEffect(() => {
    if (phase !== "driving" && phase !== "paused") navFocus.current.release();
  }, [phase]);

  // 로그인 계정별로 저장된 활성 세션이 있으면 안내·기록을 이어서 복원한다.
  useEffect(() => {
    if (!authChecked || !user || sessionRestored.current === user.hash) return;
    sessionRestored.current = user.hash;
    // 웹 없이 끝난 기록부터 가져온다(앱 꺼진 채 알림창 종료·오프라인 화면 종료)
    const imported = window.DriveNative ? importPendingTrips() : [];
    // 로그인 전이라 못 올린 센서 원본 기록도 지금 올린다(빌려 쓰기 모드는 올리지 않음)
    if (!BORROW_SERVER) window.DriveNative?.flushUploads?.();
    const sessionHash = user.hash;
    // 주행 스냅샷은 기기 안에서 암호화돼 있다 — 풀어 읽은 뒤 이어서 복원한다(예전 평문도 읽는다).
    void readSecureJson(accountStorageKey(NAV_SESSION_KEY, sessionHash)).then((got) => {
      if (sessionRestored.current !== sessionHash || userRef.current?.hash !== sessionHash) return;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const s: any = got.ok ? got.value : null;
      if (!s || (s.phase !== "driving" && s.phase !== "paused")) {
        adoptNativeTrip();
        return;
      }
      if (s.mode != null && !isTripMode(s.mode)) return;
      if (s.userHash !== sessionHash) {
        clearNavSession();
        return;
      }
      // 이 세션의 기록이 이미 네이티브에서 끝나 방금 가져왔다면 되살리지 않는다
      // (예전엔 "서비스가 죽었다"로 오인해 끝난 기록을 새로 이어 시작했다)
      if (imported.some((ts) => Math.abs(ts - (s.startTs || 0)) < 15_000)) {
        clearNavSession();
        return;
      }
      // 잊고 안 끈 오래된 세션(12h+)은 무시 — 유령 주행 복원 방지
      if (Date.now() - (s.savedAt || 0) > 12 * 3600 * 1000) {
        clearNavSession();
        return;
      }
      if (window.DriveNative) {
        try {
          const live: NativeState = JSON.parse(window.DriveNative.getState());
          if (live.alive && live.phase !== "idle" && s.recordingId && live.recordingId && live.recordingId !== s.recordingId) {
            clearNavSession();adoptNativeTrip();return;
          }
          if (!s.recordingId && live.recordingId) s.recordingId = live.recordingId;
        } catch {
          // 네이티브 상태를 읽지 못하면 저장된 세션으로 복원한다.
        }
      }
      notificationNoticeShownRef.current = s.notificationNoticeShown === true;
      // 기록 누적값 복원
      activePlanRef.current = s.plan ? s.plan as DrivePlan : null;
      originalPlanRef.current =
        (s.originalPlan as DrivePlan | null) ?? activePlanRef.current;
      startTs.current = s.startTs || Date.now();
      modeRef.current = isTripMode(s.mode) ? s.mode : "car";
      setActiveMode(modeRef.current);
      distRef.current = s.distM || 0;
      maxRef.current = s.maxKmh || 0;
      movingSec.current = s.movingSec || 0;
      startAddr.current = s.startAddr;
      pathRef.current = Array.isArray(s.path) ? s.path : [];
      speedsRef.current = Array.isArray(s.speeds) ? s.speeds : [];
      dwellProgressRef.current =
        s.dwellProgress && typeof s.dwellProgress === "object"
          ? s.dwellProgress
          : {};
      setDistM(Math.round(distRef.current));
      setMaxKmh(Math.round(maxRef.current));
      // 경과시간 — 실제 출발시각 기준으로 복원(웹 모드 0:00부터 재시작 버그 방지)
      setElapsed(Math.floor((Date.now() - startTs.current) / 1000));
      loadSavedGuidance(s);
      const p = (s.plan as DrivePlan | null) ?? null;
      if (p) setPlan(p); // 안내바·코스 표시 복구
      // phaseRef를 먼저 반영 — onFix/feedNav가 즉시 동작하게(리렌더 전 1프레임 공백 방지)
      phaseRef.current = s.phase;
      setPhase(s.phase);
      setTab("course");
      // 추적 재개 — 네이티브는 서비스가 살아있으면 이어 읽고(재start 아님),
      // 웹은 watchPosition을 다시 건다.
      if (window.DriveNative) {
        try {
          const nativeState: NativeState = JSON.parse(window.DriveNative.getState());
          recordingAckRef.current = nativeState.alive === true && nativeState.phase !== "idle" && nativeState.recordingId === recordingIdRef.current;
        } catch { recordingAckRef.current = false; }
        startNativePoll(s.phase);
        if (guideModeRef.current === "local-pending" && recordingAckRef.current) void verifyRestoredGuidance();
      } else if (navigator.geolocation) {
        if (s.phase === "driving") startWebWatch();
        tickTimer.current = setInterval(() => {
          setElapsed(Math.max(0, Math.floor((Date.now() - startTs.current) / 1000)));
        }, 1000);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [authChecked, user?.hash]);

  // 언마운트 시 모든 추적 자원 해제 — /log를 떠나거나 StrictMode 재마운트 시
  // GPS watch·인터벌이 남아 배터리를 먹는 걸 막는다(정상 PWA 사용 중엔 /log가
  // 언마운트되지 않아 실발동은 드물지만, 생명주기 정확성상 필요).
  useEffect(() => {
    const selection = guideSelectionGen;
    const request = guideRequest;
    return () => {
      if (watchRef.current !== null) navigator.geolocation.clearWatch(watchRef.current);
      if (resumeWatch.current !== null) navigator.geolocation.clearWatch(resumeWatch.current);
      if (autoWatch.current !== null) navigator.geolocation.clearWatch(autoWatch.current);
      if (tickTimer.current) clearInterval(tickTimer.current);
      if (nativePoll.current) clearInterval(nativePoll.current);
      planConfirmAbort.current?.abort();
      selection.current++;
      request.current = null;
    };
  }, []);

  function finalize(rec: DriveRecord, nativeStartTs?: number, snapshot?: { path: [number, number][] }): boolean {
    if (!snapshot && window.DriveNative) {
      if (typeof window.DriveNative.setAuthenticatedOwner === "function") {
        // 추적 조회 실패가 이미 확인한 소유자를 바꾸지 않게 따로 읽는다.
        rec = { ...rec, owner: queueOwner(rec.owner) };
        try {
          const state: NativeState = JSON.parse(window.DriveNative.getState());
          rec = { ...rec, owner: queueOwner(state.owner) };
        } catch { /* 소유자를 확인하지 못한 기록은 기기에 보관 */ }
      }
      if (modeRef.current === "car") {
        try {
          rec = { ...rec, ...sanitizeVehicleRecord(JSON.parse(window.DriveNative.getVehicleTrace?.() ?? "{}"), rec.endTs - rec.startTs) };
        } catch { /* 추적이 없어도 기록과 소유자는 유지 */ }
      }
    }
    invalidateGuideSession();
    planConfirmRequestSeq.current++;
    planConfirmAbort.current?.abort();
    clearNavSession(); // 주행 종료 — 복원 세션 폐기
    stopResumeWatch(); // 자동재개 감시 종료
    autoPaused.current = false;
    stationarySince.current = 0;
    // 궤적 — 앱 모드면 네이티브가 백그라운드 포함 전체를 갖고 있다
    let pts = snapshot?.path ?? pathRef.current;
    if (!snapshot && window.DriveNative?.getPath) {
      try {
        const np = JSON.parse(window.DriveNative.getPath());
        const recovery = nativeRecovery.current;
        if (recovery && Array.isArray(np)) {
          const base = recovery.basePath;
          const first = np[0];
          const last = base[base.length - 1];
          const skipFirst =
            first &&
            last &&
            distanceM(
              { lat: last[0], lng: last[1] },
              { lat: first[0], lng: first[1] },
            ) < 20;
          pts = [...base, ...np.slice(skipFirst ? 1 : 0)];
        } else if (Array.isArray(np) && np.length >= 2) {
          // 점 개수가 아니라 실제로 덮은 거리로 고른다. 네이티브는 4,000점을 넘으면
          // 점을 솎아내 개수가 줄어서, 끝까지 다 가진 네이티브 궤적 대신 화면이
          // 꺼져 중간이 빈 웹 궤적이 뽑혀 마지막 구간이 잘렸다(80km 재현에서 2km).
          const lenM = (path: number[][]) => {
            let m = 0;
            for (let i = 1; i < path.length; i++) {
              m += distanceM(
                { lat: path[i - 1][0], lng: path[i - 1][1] },
                { lat: path[i][0], lng: path[i][1] },
              );
            }
            return m;
          };
          // 네이티브가 원본(화면 꺼짐 구간 포함)이라 기본은 네이티브. 솎아낸 궤적은 굽은
          // 길이 곧게 펴져 짧아지는데, 실제 차 기록 34개를 8배 솎으면 최대 9.5% 줄었다
          // – 웹보다 15% 넘게 짧을 때(네이티브가 데이터를 잃은 경우)만 웹을 쓴다.
          if (pts.length < 2 || lenM(np) >= lenM(pts as number[][]) * 0.85) pts = np;
        }
      } catch {
        // 구버전 앱 — 웹에서 모은 걸로
      }
    }
    if (pts.length >= 2) rec = { ...rec, path: encodePolyline(pts) };
    // 지점별 속도(기록 지도 속도색용). 웹 수집 경로면 speedsRef가 정렬돼 있고,
    // 네이티브 경로(앱)면 각 점의 3번째 원소가 속도다(신형 앱). 예전엔 웹
    // 경로일 때만 붙여서 앱 주행 기록엔 속도색이 통째로 빠졌다.
    if (pts === pathRef.current && speedsRef.current.length === pts.length) {
      rec = { ...rec, speeds: speedsRef.current.slice() };
    } else if (
      pts.length >= 2 &&
      pts.every((p) => Array.isArray(p) && p.length > 2)
    ) {
      rec = { ...rec, speeds: pts.map((p) => Math.round((p as number[])[2])) };
    }
    // 제로백 — 앱은 네이티브 값이 이미 rec에 있고, 웹 모드는 여기서 붙인다
    const z = zeroRef.current;
    if (rec.zero50Sec == null && z.z50 != null) rec = { ...rec, zero50Sec: Math.round(z.z50 * 10) / 10 };
    if (rec.zero100Sec == null && z.z100 != null) rec = { ...rec, zero100Sec: Math.round(z.z100 * 10) / 10 };
    // G — 차 기록이고 의미 있게 움직였을 때만(0.05G 이상)
    {
      const { peaks: gp, env } = gRecRef.current;
      const r2 = (v: number) => Math.round(Math.max(0, v) * 100) / 100;
      if (modeRef.current === "car" && Math.max(gp.accel, gp.brake, gp.left, gp.right) >= 0.05)
        rec = {
          ...rec,
          gForce: { accel: r2(gp.accel), brake: r2(gp.brake), left: r2(gp.left), right: r2(gp.right), env: env.map(r2) },
        };
    }
    // 네이티브가 폰에 남긴 같은 기록(pending)은 저장이 확정되면 지운다
    const ack = () => {
      if (nativeStartTs && (rec.owner === undefined || ownedBy(rec.owner, userRef.current?.hash))) {
        window.DriveNative?.ackPendingTrip?.(String(nativeStartTs));
      }
    };
    // 이번 주행 계획(코스 or 독립 내비 목적지)을 기록에 붙인다
    const p = activePlanRef.current;
    const navDrive = !!p?.path; // 내비 안내를 받은 주행인지
    if (p) {
      rec = {
        ...rec,
        courseLabel: p.label,
        planSec: p.durationSec,
        planM: p.distanceM,
      };
    }
    activePlanRef.current = null;
    originalPlanRef.current = null;
    nativeRecovery.current = null;
    nativeRecoveryRequestedAt.current = 0;
    dwellProgressRef.current = {};
    // 주행이 끝났으면 예정 코스는 소비 — 종료 후 idle이 "코스 주행 시작/다른
    // 목적지"로 남지 않고 깨끗한 "길찾기" 상태로 돌아가게(서버 핸드오프도 삭제).
    clearPlan();
    setSummary(rec);
    phaseRef.current = "done";
    setPhase("done");
    // 설정: 내비 주행 자동 기록 꺼짐 — 요약만 보여주고 저장은 생략
    // (빌려 쓰기 모드는 서버 대신 기기 보관함에 저장한다 — saveRecord)
    const skip = navDrive && !navRecordOnRef.current;
    setRecordSkipped(skip);
    if (skip || rec.distanceM < 100) {
      ack(); // 저장 안 하기로 한 기록 — 폰 사본도 정리
      return false;
    }
    saveRecord(rec, ack);
    return true;
  }

  /**
   * 웹 세션 없이 네이티브만 기록 중일 때(오프라인 비상 화면에서 시작) 화면이
   * 그 기록을 이어받는다.
   */
  function adoptNativeTrip() {
    if (!window.DriveNative) return;
    let st: NativeState;
    try {
      st = JSON.parse(window.DriveNative.getState());
    } catch {
      return;
    }
    if (st.mode != null && !isTripMode(st.mode)) return;
    if (st.phase !== "driving" && st.phase !== "paused") return;
    setLiveTripOwner(typeof window.DriveNative.setAuthenticatedOwner === "function" ? queueOwner(st.owner) : null);
    recordingIdRef.current = st.recordingId ?? null;recordingAckRef.current = st.alive !== false;
    setGuidanceMode("none");
    modeRef.current = isTripMode(st.mode) ? st.mode : "car";
    setActiveMode(modeRef.current);
    if (st.startTs > 0) startTs.current = st.startTs;
    phaseRef.current = st.phase;
    setPhase(st.phase);
    setTab("course");
    startNativePoll();
  }

  /** 서버 저장, 실패하면 오프라인 큐. 어느 쪽이든 확정되면 onSaved */
  function saveRecord(rec: DriveRecord, onSaved?: () => void) {
    // 요청 시작 때 계정을 고정한다. 응답 전에 다른 계정으로 바뀌면 A 기록이 B의
    // 오프라인 큐로 들어가거나, 늦은 응답이 B 화면을 A 기록으로 덮어썼다.
    const userHash = userRef.current?.hash;
    if (!userHash || (rec.owner !== undefined && !ownedBy(rec.owner, userHash))) {
      setRecordSaveNotice(!userHash ? "로그인 후 기록을 저장해 주세요" :
        rec.owner === UNASSIGNED ? "주인이 정해지지 않은 기록을 기기에 보관했어요" : "다른 계정의 기록을 기기에 보관했어요");
      return;
    }
    rec = { ...rec, owner: userHash };
    const sameUser = () => !!userHash && userRef.current?.hash === userHash;
    if (userRef.current?.local) {
      // 빌려 쓰기 모드(기기 전용 사용자): 서버로 보내지 않고 이 기기 보관함에만 저장한다.
      const local = rec;
      void updateLocalRecords(userHash, (current) => [local, ...current.filter((r) => r.id !== local.id)]).then((saved) => {
        if (!saved) {
          // 저장 공간 부족(또는 보관함 잠김) — 앱 쪽 사본(onSaved로 지워짐)을 남겨 둔다
          setRecordSaveNotice("기기 저장 공간이 부족해 기록을 저장하지 못했어요");
          return;
        }
        if (sameUser()) setRecords(saved);
        onSaved?.();
      });
      return;
    }
    fetch("/api/drive-records", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rec),
    })
      .then(async (res) => {
        if (!res.ok) throw new Error();
        const data = await res.json();
        if (sameUser()) setRecords(data.records);
        onSaved?.();
      })
      .catch(() => {
        if (userHash) {
          const queued = [rec, ...loadOutbox(userHash).filter((r) => r.id !== rec.id)];
          if (saveOutbox(userHash, queued)) {
            if (sameUser()) setPendingCount(queued.length);
            onSaved?.();
          }
        }
        if (sameUser()) setRecords((prev) => [rec, ...prev.filter((r) => r.id !== rec.id)]);
      });
  }

  /**
   * 웹 없이 끝난 기록(앱 꺼짐·오프라인 비상 화면에서 종료) — 네이티브가 폰에
   * 남긴 것을 가져와 서버/오프라인 큐로 넘긴다. 가져간 기록의 시작 시각 목록 반환.
   */
  function importPendingTrips(): number[] {
    let list: unknown;
    try {
      list = JSON.parse(window.DriveNative?.getPendingTrips?.() ?? "[]");
    } catch {
      return [];
    }
    if (!Array.isArray(list)) return [];
    const ownershipSupported = typeof window.DriveNative?.setAuthenticatedOwner === "function";
    setUnassignedCount(ownershipSupported ? (window.DriveNative?.getUnassignedTripCount?.() ?? list.filter((p) => queueOwner(p?.owner) === UNASSIGNED).length) : 0);
    const done: number[] = [];
    for (const raw of list) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = raw as any;
      if (!p || typeof p.startTs !== "number" || !userRef.current?.hash ||
          (ownershipSupported && !ownedBy(p.owner, userRef.current.hash))) continue;
      if (p.mode != null && !isTripMode(p.mode)) continue;
      const ack = () => window.DriveNative?.ackPendingTrip?.(String(p.startTs));
      done.push(p.startTs);
      const pts: number[][] = Array.isArray(p.path) ? p.path : [];
      let rec: DriveRecord = {
        ...sanitizeVehicleRecord(p, p.endTs - p.startTs),
        owner: ownershipSupported ? queueOwner(p.owner) : userRef.current.hash,
        id: String(p.id ?? p.endTs),
        startTs: p.startTs,
        endTs: p.endTs,
        distanceM: p.distanceM ?? 0,
        maxKmh: p.maxKmh ?? 0,
        avgKmh: p.avgKmh ?? 0,
        movingSec: p.movingSec ?? 0,
      };
      if (typeof p.zero50Sec === "number") rec.zero50Sec = p.zero50Sec;
      if (typeof p.zero100Sec === "number") rec.zero100Sec = p.zero100Sec;
      if (p.zeroChecked === true) rec.zeroChecked = true;
      if (pts.length >= 2) {
        rec = {
          ...rec,
          path: encodePolyline(pts.map((q) => [q[0], q[1]] as [number, number])),
          speeds: pts.map((q) => Math.round(q[2] ?? 0)),
        };
      }
      if (rec.distanceM < 100) ack();
      else saveRecord(rec, ack);
    }
    return done;
  }

  /**
   * G-Force 패널용 G 계산 — 새 GPS 픽스마다. 앞뒤 = 속도 변화/시간, 좌우 =
   * 평균속도 × 진행방향 변화율(rad/s). 1g = 9.81m/s². 실주행 분석에서 이 GPS
   * 방식이 자이로와 0.008g 차이(중앙값)였다. 튐(앞뒤 1.2g·좌우 1.5g 초과)은
   * 버리고, 0.6 가중 평균으로 살짝 부드럽게 한다. 3초 넘게 끊기면 0부터.
   */
  function feedG(t: number, kmh: number, brg: number | null) {
    const c = gCalcRef.current;
    const v = kmh / 3.6;
    if (c.t > 0) {
      const dt = (t - c.t) / 1000;
      if (dt >= 0.5 && dt <= 3) {
        const lon = (v - c.v) / dt / 9.81;
        let lat = 0;
        // 좌우 G — 시속 약 22km(6m/s) 넘을 때만, 방향이 초당 30° 넘게 확 바뀐 픽스는 버린다.
        // 느릴 때·교차로에서 GPS 진행방향이 순간 튀어 가짜 G(실측 0.63G, 센서는 0.29G)가 났다.
        if (brg != null && c.brg != null && v > 6 && c.v > 6) {
          const dDeg = ((brg - c.brg + 540) % 360) - 180;
          if (Math.abs(dDeg) / dt <= 30) lat = (((v + c.v) / 2) * ((dDeg * Math.PI) / 180)) / dt / 9.81;
        }
        // 앞뒤 0.9G·좌우 1.2G 넘으면 GPS 튐 — 일반 차는 0.3~0.5G(10-24 멈춘 채 0.72G가 찍혔다)
        if (Math.abs(lon) < 0.9 && Math.abs(lat) < 1.2) {
          const a = 0.6;
          const e = { lat: c.e.lat + a * (lat - c.e.lat), lon: c.e.lon + a * (lon - c.e.lon) };
          c.e = e;
          setGLive({ ...e, t }); // t(시각)가 있어야 패널이 센서–GPS 방향을 맞춘다
          {
            const r = gRecRef.current;
            r.peaks = {
              accel: Math.max(r.peaks.accel, e.lon),
              brake: Math.max(r.peaks.brake, -e.lon),
              left: Math.max(r.peaks.left, -e.lat),
              right: Math.max(r.peaks.right, e.lat),
            };
            pushEnv(r.env, e.lat, e.lon);
          }
          setGPeaks((p) => ({
            accel: Math.max(p.accel, e.lon),
            brake: Math.max(p.brake, -e.lon),
            left: Math.max(p.left, -e.lat),
            right: Math.max(p.right, e.lat),
          }));
        }
      } else if (dt > 3) {
        c.e = { lat: 0, lon: 0 };
      }
    }
    c.t = t;
    c.v = v;
    c.brg = brg;
  }

  /**
   * 정지 출발 0–50·0–100 (TrackService.trackLaunch와 같은 규칙). 2km/h 미만에서
   * 출발해 연속 픽스(≤2초)로 목표 속도를 넘는 순간을 보간. 0.7g 넘는 변화·끊김은 무효.
   */
  function trackLaunch(t: number, v: number) {
    const L = launchRef.current;
    const { pv, pt } = L;
    L.pv = v;
    L.pt = t;
    if (pt < 0) {
      L.still = v < 2;
      return;
    }
    const dt = (t - pt) / 1000;
    if (dt <= 0) return;
    if (dt > 2 || Math.abs(v - pv) / 3.6 / dt > 7) {
      L.t0 = -1;
      L.still = v < 2;
      return;
    }
    if (v < 2) {
      L.still = true;
      L.t0 = -1;
      return;
    }
    if (L.still && pv < 2) {
      L.t0 = pt + ((2 - pv) / (v - pv)) * (t - pt);
      L.still = false;
    }
    if (L.t0 < 0) return;
    const z = zeroRef.current;
    for (const target of [50, 100] as const) {
      if (pv < target && v >= target) {
        const sec = (pt + ((target - pv) / (v - pv)) * (t - pt) - L.t0) / 1000;
        if (target === 50 && sec >= 2 && (z.z50 == null || sec < z.z50)) z.z50 = sec;
        if (target === 100 && sec >= 3 && (z.z100 == null || sec < z.z100)) z.z100 = sec;
      }
    }
    if (v >= 100) L.t0 = -1;
  }

  /** 확정 GPS 픽스마다 — 처음 잡혔거나 2분 넘게 끊겼다 돌아오면 길안내 중 음성 안내 */
  function markGpsConfirmed() {
    const now = Date.now();
    const regained = !gpsConfirmedRef.current || now - lastConfirmedAt.current > 120_000;
    gpsConfirmedRef.current = true;
    lastConfirmedAt.current = now;
    if (regained && phaseRef.current === "driving" && navEng.current) {
      speakNav(["GPS가 연결되었습니다."]);
      devlog("gps-confirmed", {});
    }
  }

  function onFix(pos: GeolocationPosition) {
    if (phaseRef.current !== "driving") return;
    setGpsErr(null);
    const { latitude: lat, longitude: lng, speed, accuracy } = pos.coords;
    if (accuracy > MAX_ACCURACY_M) return;
    setGpsFixed(true);
    markGpsConfirmed();
    const t = pos.timestamp;
    const prev = lastFix.current;
    let v = speed;
    if ((v === null || Number.isNaN(v) || v < 0.15) && prev && t > prev.t) {
      const dJump = distanceM(prev, { lat, lng });
      // 점프(500m+)는 속도 계산 제외 — 가짜 최고속도 방지
      if (dJump < MAX_JUMP_M) {
        const calc = dJump / ((t - prev.t) / 1000);
        if (calc < 55) v = Math.max(v ?? 0, calc);
      }
    }
    const curKmh = Math.max(0, (v ?? 0) * 3.6);
    setKmh(Math.round(curKmh));
    trackStationary(curKmh); // 5분 정차 시 자동 일시중지
    trackLaunch(t, curKmh);
    if (zeroRef.current.z50 != null) setLiveZ50(zeroRef.current.z50);
    {
      // 진행방향 — 기기 값이 있으면 그것, 없으면 직전 픽스에서 계산
      const devHd = pos.coords.heading;
      let hdG: number | null =
        typeof devHd === "number" && !Number.isNaN(devHd) && curKmh > 3 ? devHd : null;
      if (hdG == null && prev && distanceM(prev, { lat, lng }) > 3) {
        const kx = Math.cos((lat * Math.PI) / 180);
        hdG = ((Math.atan2((lng - prev.lng) * kx, lat - prev.lat) * 180) / Math.PI + 360) % 360;
      }
      feedG(t, curKmh, hdG);
      devlog("gps", {
        lat, lng, kmh: Math.round(curKmh * 10) / 10, hd: hdG == null ? null : Math.round(hdG),
        acc: Math.round(pos.coords.accuracy), ft: t, nav: !!navEng.current,
      });
    }
    if (curKmh > maxRef.current && curKmh < speedCap(modeRef.current)) {
      maxRef.current = curKmh;
      setMaxKmh(Math.round(curKmh));
    }
    if (prev && t > prev.t) {
      const d = distanceM(prev, { lat, lng });
      const dt = (t - prev.t) / 1000;
      if (d < MAX_JUMP_M && curKmh >= MOVING_KMH) {
        distRef.current += d;
        movingSec.current += dt;
        setDistM(Math.round(distRef.current));
      }
    }
    // 기록 지도(경로 안내 없을 때) — 현위치·진행방향을 갱신해 회전 지도로 따라간다
    setLivePos({ lat, lng });
    let freeHd: number | null = null;
    if (!navEng.current) {
      const nextHeading = advanceFreeHeading(freeHeadingAnchor.current, { lat, lng });
      freeHeadingAnchor.current = nextHeading.anchor;
      freeHd = nextHeading.heading;
      if (freeHd !== null) {
        freeHeadingRef.current = freeHd;
        setNavHeading(freeHd);
      }
    }
    // 일반 주행 상시 안내 — 경로 없을 때만(제한속도·과속·전방카메라)
    if (!navEng.current) {
      // 서버 도로/분기 판정도 클라이언트 경고와 같은 마지막 안정 heading을 쓴다.
      // 새 anchor heading이 이번 픽스에 없다는 이유만으로 null을 보내 fail-open하지 않는다.
      const stableFreeHd = freeHd ?? freeHeadingRef.current;
      refreshFreeDrive(lat, lng, stableFreeHd);
      computeFreeWarnings(lat, lng, freeHd, curKmh);
    }
    lastFix.current = { lat, lng, t };
    addPathPt(lat, lng, curKmh);
    updateAddr(lat, lng);
    feedNav(lat, lng);
  }

  /**
   * 프롬프트를 띄우지 않고 현재 위치 권한 상태만 읽는다.
   * - 앱(WebView): 네이티브 브리지로 런타임 권한 보유 여부 확인.
   * - 웹: Permissions API로 granted/prompt/denied 조회(팝업 없음). 구형
   *   사파리처럼 Permissions API가 없으면 낙관적으로 prompt로 두고, 실제
   *   요청은 버튼 클릭(제스처) 안에서 한다.
   */
  const readGeoPerm = useCallback(async () => {
    if (typeof window !== "undefined" && window.DriveNative) {
      // 구버전 앱엔 hasLocationPermission이 없다 — 있으면 신뢰, 없으면
      // 네이티브가 시작 시 권한을 받으므로 granted로 통과시킨다.
      // 브리지 메서드는 반드시 window.DriveNative 위에서 직접 호출해야 한다.
      //   const f = window.DriveNative.method; f() 처럼 떼어내 부르면 WebView가
      //   "Java bridge method can't be invoked on a non-injected object"를
      //   던진다(receiver가 주입 객체가 아니게 됨).
      setGeoPerm(
        window.DriveNative.hasLocationPermission
          ? window.DriveNative.hasLocationPermission()
            ? "granted"
            : "denied"
          : "granted",
      );
      return;
    }
    if (typeof navigator === "undefined" || !navigator.geolocation) {
      setGeoPerm("unsupported");
      return;
    }
    if (navigator.permissions?.query) {
      try {
        const st = await navigator.permissions.query({
          name: "geolocation" as PermissionName,
        });
        setGeoPerm(st.state as "granted" | "prompt" | "denied");
        return;
      } catch {
        // 일부 브라우저는 geolocation 쿼리를 거부 — 아래 폴백
      }
    }
    setGeoPerm("prompt");
  }, []);

  /**
   * 권한 요청 — 게이트의 "위치 권한 허용" 버튼에서 부른다.
   * - 앱: 네이티브가 시스템 다이얼로그(가능하면)나 앱 설정으로 안내.
   * - 웹: 반드시 클릭 제스처 안에서 getCurrentPosition을 호출해야 OS
   *   프롬프트가 뜬다. 거부되면(code 1) denied로 전환 — 웹은 재요청 불가라
   *   이후엔 브라우저 설정 안내만 가능하다.
   */
  function requestGeo() {
    if (window.DriveNative?.requestLocation) {
      window.DriveNative.requestLocation();
      return;
    }
    if (!navigator.geolocation) {
      setGeoPerm("unsupported");
      return;
    }
    setGeoPerm("checking");
    navigator.geolocation.getCurrentPosition(
      () => setGeoPerm("granted"),
      (e) => setGeoPerm(e.code === 1 ? "denied" : "prompt"),
      { enableHighAccuracy: false, timeout: 12000, maximumAge: 60000 },
    );
  }

  /**
   * 권한 상태 감시 — 마운트 시 1회 조회하고, 사용자가 설정에서 켜고 돌아오면
   * 자동으로 게이트를 푼다. 회복 신호: Permissions API onchange, 화면 복귀
   * (visibilitychange), 네이티브 권한 결과(drivenative-perm).
   */
  useEffect(() => {
    let cancelled = false;
    let permStatus: PermissionStatus | null = null;
    const reread = () => {
      if (!cancelled) void readGeoPerm();
    };
    reread();
    if (!window.DriveNative && navigator.permissions?.query) {
      navigator.permissions
        .query({ name: "geolocation" as PermissionName })
        .then((st) => {
          if (cancelled) return;
          permStatus = st;
          st.onchange = reread;
        })
        .catch(() => {});
    }
    const onVis = () => {
      if (document.visibilityState === "visible") reread();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("drivenative-perm", reread);
    return () => {
      cancelled = true;
      if (permStatus) permStatus.onchange = null;
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("drivenative-perm", reread);
    };
  }, [readGeoPerm]);

  function startWebWatch() {
    watchRef.current = navigator.geolocation.watchPosition(
      onFix,
      (e) =>
        setGpsErr(
          e.code === 1
            ? "위치 권한이 거부됐어요. 설정에서 허용해 주세요."
            : "GPS 신호를 찾는 중…",
        ),
      { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
    );
  }

  /**
   * 위치 권한 거부 후 회복 — 한 번 더 위치를 요청한다. 사용자가 설정에서
   * 방금 허용했으면 바로 잡히고, 여전히 거부면 안내 문구를 다시 채운다.
   * 각 화면의 "다시 시도" 버튼에서 부른다(막다른 길 방지).
   */
  function retryGps() {
    setGpsErr("위치를 다시 확인하는 중…");
    currentPosition()
      .then((p) => {
        navLastFix.current = p;
        setNavPos(p);
        setGpsErr(null);
      })
      .catch((e) =>
        setGpsErr(
          e instanceof Error
            ? e.message
            : "위치를 가져오지 못했어요 — 설정에서 위치 권한을 켜주세요",
        ),
      );
  }

  function showNotificationNotice() {
    if (notificationNoticeShownRef.current) return;
    try {
      if (window.DriveNative?.notificationsAllowed?.() === false) {
        notificationNoticeShownRef.current = true;
        setNotificationNotice("알림 권한이 꺼져 있어요. 기록은 계속돼요");
      }
    } catch {
      // 알림 권한 조회 실패는 기록 시작을 막지 않는다.
    }
  }

  async function recoverNativeRecording(id: string, generation: number, resumePhase: "driving" | "paused") {
    const recovery = nativeRecovery.current;
    const recoveryPlan = activePlanRef.current;
    const recoveryMode = modeRef.current;
    let ok = false;
    try {
      ok = (await requestRecording(modeRef.current, id)).ok;
    } catch {
      // 승인 실패로 처리해 아래에서 임시 기록을 정리한다.
    }
    if (recoveryPendingRef.current !== id) return;
    if (!ok) {
      abortRecording(id);
      const snapshot = recovery ? { ...recovery, basePath: recovery.basePath.map(p => [...p] as [number, number]) } : null;
      const hasData = !!snapshot && (snapshot.distM > 0 || snapshot.basePath.length >= 2);
      const ownsRecording = recordingIdRef.current === id || recordingIdRef.current === null;
      let saved = false;
      if (snapshot) {
        const endTs = Date.now();
        const rec: DriveRecord = {
          id: String(endTs), startTs: snapshot.startTs, endTs,
          distanceM: Math.round(snapshot.distM), maxKmh: Math.round(snapshot.maxKmh),
          movingSec: Math.round(snapshot.movingSec),
          avgKmh: snapshot.movingSec > 10 ? Math.round(snapshot.distM / snapshot.movingSec * 3.6) : 0,
          ...(snapshot.basePath.length >= 2 ? { path: encodePolyline(snapshot.basePath) } : {}),
        };
        if (ownsRecording) saved = finalize(rec, undefined, { path: snapshot.basePath });
        else if (hasData && rec.distanceM >= 100 && !(recoveryPlan?.path && !navRecordOnRef.current)) {
          // 이전 기록의 저장 규칙을 적용하되 새 기록 세션은 바꾸지 않는다.
          saveRecord({ ...rec, ...(recoveryMode !== "car" ? { mode: recoveryMode } : {}),
            ...(recoveryPlan ? { courseLabel: recoveryPlan.label, planSec: recoveryPlan.durationSec, planM: recoveryPlan.distanceM } : {}) });
        }
      }
      if (ownsRecording) {
        invalidateGuideSession();clearNavSession();
        if (nativePoll.current) clearInterval(nativePoll.current);
        nativePoll.current = null;nativeRecovery.current = null;
        nativeRecoveryRequestedAt.current = 0;
        if (!snapshot) {
          activePlanRef.current = null;originalPlanRef.current = null;clearPlan();
        }
        if (!saved) { phaseRef.current = "idle";setPhase("idle"); }
        setGuideFailure(saved ? "기록을 이어가지 못해 지금까지 기록을 저장했어요" : "기록을 이어가지 못했어요");
      }
      recoveryPendingRef.current = null;setRecoveryPending(false);
      return;
    }
    recoveryPendingRef.current = null;setRecoveryPending(false);
    if (recordingIdRef.current !== id) return;
    recordingAckRef.current = true;
    showNotificationNotice();
    phaseRef.current = resumePhase;setPhase(resumePhase);
    if (resumePhase === "paused") window.DriveNative?.pause();
    if (generation !== guideSelectionGen.current) { saveNavSession();return; }
    if (guideModeRef.current === "native" && activePlanRef.current?.path) {
      // 앱이 다시 켜졌을 때 묻지 않고 순정 내비에 코스를 다시 보내지 않는다.
      // 그사이 운전자가 순정 내비에서 안내를 끄거나 목적지를 바꿨을 수 있다(Pleos 정책: 동의 없는 경로 전환 금지).
      setResumeAsk(true);
    } else if (guideModeRef.current === "local-pending") {
      await verifyRestoredGuidance();
    }
    saveNavSession();
  }

  function startNativePoll(restoringPhase?: "driving" | "paused") {
    if (nativePoll.current) clearInterval(nativePoll.current);
    let restorePending = restoringPhase ?? null;
    nativePoll.current = setInterval(() => {
      try {
        if (recoveryPendingRef.current) return;
        const s: NativeState = JSON.parse(window.DriveNative!.getState());
        setLiveTripOwner(typeof window.DriveNative?.setAuthenticatedOwner === "function" ? queueOwner(s.owner) : null);
        // 서비스 프로세스가 죽은 뒤 웹 세션만 복원된 경우: 유령 종료 기록을
        // 만들지 않고 네이티브 측정을 새로 시작하되, 저장된 누적값을 offset으로 잇는다.
        if (
          (restorePending && s.phase === "idle") ||
          (s.alive === false &&
            (s.phase === "driving" || s.phase === "paused") &&
            Date.now() - nativeRecoveryRequestedAt.current > 5_000 &&
            (phaseRef.current === "driving" || phaseRef.current === "paused"))
        ) {
          let recoveryPath = pathRef.current.slice();
          try {
            const nativePath = JSON.parse(window.DriveNative!.getPath?.() ?? "[]");
            if (Array.isArray(nativePath) && nativePath.length > 0) {
              recoveryPath = nativeRecovery.current
                ? [...nativeRecovery.current.basePath, ...nativePath]
                : nativePath;
            }
          } catch {}
          nativeRecovery.current = {
            distM: distRef.current,
            maxKmh: maxRef.current,
            movingSec: movingSec.current,
            startTs: startTs.current,
            basePath: recoveryPath,
          };
          nativeRecoveryRequestedAt.current = Date.now();
          // 같은 기록 식별자로 자동차 측정을 다시 시작한다.
          const id = recordingId();
          const resumePhase = restorePending ?? phaseRef.current;
          recordingIdRef.current = id;recordingAckRef.current = false;cancelRequestIdRef.current = null;
          if (guideModeRef.current === "local" || guideModeRef.current === "local-pending") setGuidanceMode("local-pending");
          const generation = ++guideSelectionGen.current;
          phaseRef.current = "idle";setPhase("idle");
          recoveryPendingRef.current = id;setRecoveryPending(true);
          void recoverNativeRecording(id, generation, resumePhase === "paused" ? "paused" : "driving");
          restorePending = null;
          return;
        }
        restorePending = null;
        const offset = nativeRecovery.current;
        const totalDist = (offset?.distM ?? 0) + s.distM;
        const totalMoving = (offset?.movingSec ?? 0) + s.movingSec;
        const totalMax = Math.max(offset?.maxKmh ?? 0, s.maxKmh);
        const totalStartTs = offset?.startTs ?? s.startTs ?? startTs.current;
        distRef.current = totalDist;
        movingSec.current = totalMoving;
        maxRef.current = totalMax;
        if (totalStartTs > 0) startTs.current = totalStartTs;
        setKmh(Math.round(s.kmh));
        setKmhEst(s.kmhEst === true);
        setMaxKmh(Math.round(totalMax));
        setDistM(Math.round(totalDist));
        setElapsed(
          totalStartTs > 0
            ? Math.max(0, Math.floor((Date.now() - totalStartTs) / 1000))
            : 0,
        );
        trackStationary(s.kmh); // 5분 정차 시 자동 일시중지(재개는 웹 GPS가 감지)
        // 정확한 GPS 전: 표시용(대략) 위치로 지도·주소만 먼저 — 기록·안내엔 안 씀
        if (!s.lat && s.dTs && s.dLat) {
          setLivePos({ lat: s.dLat, lng: s.dLng! });
          setApproxAcc(Math.round(s.dAcc ?? 0));
          if (Date.now() - approxAddrAt.current > 15_000) {
            approxAddrAt.current = Date.now();
            updateAddr(s.dLat, s.dLng!, true);
          }
        }
        if (s.lat) {
          const sBrg =
            typeof s.brg === "number" && s.brg >= 0 ? s.brg : null;
          const coordChanged =
            !navLastFix.current ||
            Math.abs(navLastFix.current.lat - s.lat) >= 1e-7 ||
            Math.abs(navLastFix.current.lng - s.lng) >= 1e-7;
          const freshFix =
            typeof s.fixTs === "number" && s.fixTs > 0
              ? s.fixTs !== lastNativeFixTs.current
              : coordChanged || s.kmh < 1;
          if (freshFix) {
            if (typeof s.fixTs === "number") lastNativeFixTs.current = s.fixTs;
            const movement = advanceFreeHeading(freeHeadingAnchor.current, { lat: s.lat, lng: s.lng });
            freeHeadingAnchor.current = movement.anchor;
            // Some emulator/GPS providers report a permanently zero bearing.
            // Prefer actual displacement; preserve the last direction while stopped.
            const driveHeading = s.kmh >= 3
              ? movement.heading ?? freeHeadingRef.current ?? sBrg
              : freeHeadingRef.current;
            if (s.kmh >= 3 && driveHeading !== null) freeHeadingRef.current = driveHeading;
            if (s.phase === "driving") feedG(s.fixTs || Date.now(), s.kmh, driveHeading);
            if (s.z50 && s.z50 > 0) setLiveZ50(s.z50);
            setGpsFixed(true);
            markGpsConfirmed();
            setApproxAcc(null);
            updateAddr(s.lat, s.lng);
            // 기록 지도 — 현위치·진행방향(회전) 갱신
            setLivePos({ lat: s.lat, lng: s.lng });
            if (!navEng.current && driveHeading !== null) {
              setNavHeading(driveHeading);
            }
            // 일반 주행 상시 안내 — 경로 없을 때만(제한속도·과속·전방카메라)
            if (!navEng.current && s.phase === "driving") {
              refreshFreeDrive(s.lat, s.lng, driveHeading);
              computeFreeWarnings(s.lat, s.lng, driveHeading, s.kmh);
            }
            // 구버전 앱(getPath 없음) 폴백 — 화면 켜진 동안이라도 모은다
            if (s.phase === "driving") {
              addPathPt(s.lat, s.lng, s.kmh);
              // 지도에 그릴 '지나온 경로'는 네이티브 궤적을 우선 쓴다 — 웹
              // pathRef는 화면이 꺼진 동안 폴링이 멈춰 비고, 앱을 다시 열면
              // 아예 비어 있어 지나온 길이 사라진다. 네이티브는 백그라운드까지
              // 모으므로 완전하다. 파싱 비용이 있어 ~4초에 한 번만 읽는다.
              if (Date.now() - nativeTraceAt.current > 4000) {
                nativeTraceAt.current = Date.now();
                try {
                  const np = JSON.parse(window.DriveNative!.getPath?.() ?? "[]");
                  if (Array.isArray(np) && np.length > 1) {
                    const base = nativeRecovery.current?.basePath ?? [];
                    const pts = [...base, ...np];
                    setNativeTrace(
                      pts.map((p: number[]) => ({ lat: p[0], lng: p[1] })),
                    );
                  }
                } catch {
                  // 구버전 앱(getPath 없음) — 웹 pathRef로 폴백
                }
              }
              feedNav(s.lat, s.lng, driveHeading ?? undefined);
            }
          }
        }
        if (s.phase === "paused" && phaseRef.current === "driving") {
          phaseRef.current = "paused";
          setPhase("paused");
        }
        if (s.phase === "driving" && phaseRef.current === "paused") {
          phaseRef.current = "driving";
          setPhase("driving");
        }
        // 알림창에서 종료를 눌렀으면 여기서 마무리
        if (s.phase === "idle" && phaseRef.current !== "idle") {
          if (nativePoll.current) clearInterval(nativePoll.current);
          finalize({
            id: String(s.endTs || Date.now()),
            ...(typeof window.DriveNative?.setAuthenticatedOwner === "function" ? { owner: queueOwner(s.owner) } : {}),
            startTs: totalStartTs,
            endTs: s.endTs || Date.now(),
            distanceM: Math.round(totalDist),
            maxKmh: Math.round(totalMax),
            avgKmh:
              totalMoving > 10 ? Math.round((totalDist / totalMoving) * 3.6) : 0,
            movingSec: Math.round(totalMoving),
            startAddr: startAddr.current,
            endAddr: addrRef.current || undefined,
            ...(s.z50 && s.z50 > 0 ? { zero50Sec: Math.round(s.z50 * 10) / 10 } : {}),
            ...(s.z100 && s.z100 > 0 ? { zero100Sec: Math.round(s.z100 * 10) / 10 } : {}),
            ...(s.zchk ? { zeroChecked: true } : {}),
          }, s.startTs);
        }
      } catch {
        // 브리지 오류 — 다음 틱에 재시도
      }
    }, 1000);
  }

  // 최근 목적지는 로그인 계정별로 분리한다(공용 기기에서 이전 유저 노출 방지).
  function recentKey(): string {
    const h = userRef.current?.hash;
    return h ? `${RECENT_KEY}:${h}` : RECENT_KEY;
  }
  // 최근 목적지·즐겨찾기는 기기 안에서 암호화해 둔다(secure-store.ts). 읽기·쓰기가 비동기라
  // 계정이 바뀐 뒤 도착한 늦은 결과는 버린다.
  const asPlaces = (value: unknown, max: number): RecentDest[] =>
    Array.isArray(value) ? (value as RecentDest[]).slice(0, max) : [];
  const placesKeyRef = useRef<string | null>(null);
  function reloadPlaces() {
    const rk = recentKey(), fk = favKey();
    // 다른 계정으로 바뀌었으면 풀어 읽는 동안 이전 목록이 보이지 않게 비운다(같은 계정이면 그대로 둬 깜빡임 없음)
    if (placesKeyRef.current !== rk) {
      placesKeyRef.current = rk;
      setRecentDests([]);
      setFavDests([]);
    }
    void loadSecureJsonQueued(rk).then(({ value }) => { if (recentKey() === rk) setRecentDests(asPlaces(value, 8)); });
    void loadSecureJsonQueued(fk).then(({ value }) => { if (favKey() === fk) setFavDests(asPlaces(value, 30)); });
  }
  function favKey(): string {
    const h = userRef.current?.hash;
    return h ? `${FAV_KEY}:${h}` : FAV_KEY;
  }
  const isFav = (d: RecentDest) => favDests.some((f) => f.lat === d.lat && f.lng === d.lng);
  function toggleFav(d: RecentDest) {
    const fk = favKey();
    const adding = !isFav(d);
    const change = (list: RecentDest[]) => adding
      ? [{ name: d.name, lat: d.lat, lng: d.lng }, ...list.filter((f) => !(f.lat === d.lat && f.lng === d.lng))].slice(0, 30)
      : list.filter((f) => !(f.lat === d.lat && f.lng === d.lng));
    setFavDests((list) => change(list));
    void updateSecureJson(fk, (current) => change(asPlaces(current, 30))).then((list) => {
      if (list && favKey() === fk) setFavDests(list);
    });
  }
  /** 검색 결과·최근·즐겨찾기·지도 선택 공통 — 지금 고르는 칸에 넣거나 바로 안내 시작 */
  function choosePlace(place: RecentDest) {
    if (originPick) {
      setNavOrigin(place);
      setOriginPick(false);
      setDestResults([]);
      setDestQuery("");
    } else if (viaPick) {
      setNavVias((vs) =>
        vs.length >= 5 || vs.some((v) => v.lat === place.lat && v.lng === place.lng) ? vs : [...vs, place],
      );
      setViaPick(false);
      setDestResults([]);
      setDestQuery("");
    } else if (viaMode) addViaDuringDrive(place);
    else startNavTo(place);
  }

  /** 즐겨찾기·최근 목적지 한 줄 — 누르면 고르고, 저장 버튼으로 즐겨찾기 넣고 빼기 */
  function placeRow(d: RecentDest, key: string) {
    const org = navLastFix.current ?? navPos ?? searchOrigin.current;
    const to = { lat: d.lat, lng: d.lng };
    return (
      <li key={key} className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => choosePlace(d)}
          className="flex min-w-0 flex-1 items-center gap-3 rounded-md border border-line bg-raised px-4 py-3 text-left transition-colors"
        >
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-primary">{d.name}</span>
          {org && d.lat != null && (
            <span className="shrink-0 text-[12px] font-medium text-secondary">
              {bearing8(org, to)} {fmtM(distanceM(org, to))}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={() => toggleFav(d)}
          aria-label={isFav(d) ? "즐겨찾기 빼기" : "즐겨찾기 추가"}
          className={`grid h-11 w-10 shrink-0 place-items-center rounded-md text-[18px] ${isFav(d) ? "text-warn" : "text-disabled hover:text-secondary"}`}
        >
          <IconStar filled={isFav(d)} />
        </button>
      </li>
    );
  }

  function pushRecent(d: RecentDest) {
    const rk = recentKey();
    const change = (list: RecentDest[]) => [d, ...list.filter((r) => r.name !== d.name)].slice(0, 8);
    setRecentDests((list) => change(list));
    void updateSecureJson(rk, (current) => change(asPlaces(current, 8))).then((list) => {
      if (list && recentKey() === rk) setRecentDests(list);
    });
  }

  async function searchDest(q: string) {
    const query = q.trim();
    if (!query) return;
    const request = ++destSearchSeq.current;
    destSearchAbort.current?.abort();
    const controller = new AbortController();
    destSearchAbort.current = controller;
    setDestSearching(true);
    setDestErr(null);
    try {
      // 현재 위치 기준으로 검색 — 주행 중이면 실시간 위치, 아니면 확보한 위치
      const origin = navLastFix.current ?? navPos ?? searchOrigin.current;
      const loc = origin ? `&x=${origin.lng}&y=${origin.lat}` : "";
      const res = await fetch(
        `/api/geocode?q=${encodeURIComponent(query)}${loc}`,
        { signal: controller.signal },
      );
      const data = await res.json();
      if (request !== destSearchSeq.current) return;
      if (!res.ok) throw new Error(data.error ?? "검색 실패");
      setDestResults(data.places ?? []);
      if ((data.places ?? []).length === 0) setDestErr("검색 결과가 없어요");
    } catch (e) {
      if (controller.signal.aborted || request !== destSearchSeq.current) return;
      setDestErr(e instanceof Error ? e.message : "검색 실패");
      setDestResults([]);
    } finally {
      if (request === destSearchSeq.current) setDestSearching(false);
    }
  }

  // 목적지 검색 화면을 열면 현재 위치를 미리 확보한다 (가까운 순·거리 표시).
  useEffect(() => {
    if (!navPicker) return;
    if (navLastFix.current || navPos || searchOrigin.current) return;
    currentPosition()
      .then((p) => {
        searchOrigin.current = p;
      })
      .catch(() => {});
  }, [navPicker, navPos]);

  // 장소 탭을 처음 열면 현재 위치 주변 명소를 불러온다.
  useEffect(() => {
    if (tab !== "places" || placeList !== null || placesLoading || placesError)
      return;
    // 위치 획득(지오로케이션) 대기 중에도 스켈레톤이 보이게 로딩을 먼저 켠다 —
    // 안 그러면 재시도를 눌러도 아무 반응 없이 같은 화면처럼 보인다(스샷 45).
    setPlacesLoading(true);
    setPlacesError(false);
    const load = (p: LatLng) => {
      fetch("/api/places-near", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: p.lat, lng: p.lng }),
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("server"))))
        .then((d) => setPlaceList(d?.places ?? []))
        .catch(() => setPlacesError(true))
        .finally(() => setPlacesLoading(false));
    };
    const org = navLastFix.current ?? navPos ?? searchOrigin.current;
    if (org) load(org);
    else
      currentPosition()
        .then(load)
        .catch(() => {
          setPlacesError(true);
          setPlacesLoading(false);
        });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, placeList, placesLoading, placesError, navPos]);

  // 주유소 탭 — 진입/유종·정렬·범위 변경 시 조회.
  //  · 가는 길: 현재 코스(plan.path)를 따라  · 내 주변: 현재 위치 반경
  useEffect(() => {
    if (tab !== "gas") return;
    let cancelled = false;
    const controller = new AbortController();
    setGasLoading(true);
    setGasError(false);
    const done = (d: { stations?: unknown } | null) =>
      !cancelled && setGasList((d?.stations as typeof gasList) ?? []);
    // 취소(cancelled)가 아닌 실제 실패만 오류로 표시한다 — "없음"과 구분
    const fail = () => {
      if (cancelled) return;
      setGasError(true);
      setGasLoading(false);
    };
    if (gasMode === "route" && plan?.path) {
      fetch("/api/gas-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: plan.path, fuel: gasFuel, sort: gasSort }),
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("server"))))
        .then(done)
        .catch(fail)
        .finally(() => !cancelled && setGasLoading(false));
      return () => {
        cancelled = true;
        controller.abort();
      };
    }
    const load = (p: LatLng) => {
      fetch("/api/gas-near", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ lat: p.lat, lng: p.lng, fuel: gasFuel, sort: gasSort }),
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error("server"))))
        .then(done)
        .catch(fail)
        .finally(() => !cancelled && setGasLoading(false));
    };
    const org = navLastFix.current ?? navPos ?? searchOrigin.current;
    if (org) load(org);
    else currentPosition().then(load).catch(fail);
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, gasSort, gasFuel, gasMode, gasReload]);

  // 검색 화면 열기/닫기 트랜지션 — 열 때 다음 프레임에 표시(진입 트랜지션),
  // 닫을 때 표시만 끄고 200ms 뒤 언마운트(슬라이드아웃 재생).
  useEffect(() => {
    if (navPicker) {
      setPickerMounted(true);
      const r = requestAnimationFrame(() => setPickerIn(true));
      return () => cancelAnimationFrame(r);
    }
    setPickerIn(false);
    const t = setTimeout(() => setPickerMounted(false), 200);
    return () => clearTimeout(t);
  }, [navPicker]);

  /** 현재 위치를 한 번 빨리 얻는다 — src/lib/quick-location.ts (코스추천과 공용) */
  function currentPosition(): Promise<LatLng> {
    return quickPosition();
  }

  /** 목적지를 고르면 먼저 경로 옵션(최단시간/최단경로/무료/안막힘)을 묻는다 */
  function closeRoutePick() {
    setRoutePick(null);
    pickDestRef.current = null;
    pickAbort.current?.abort();
    pickRequestSeq.current++;
    setPickLoading(null);
  }

  // 차가 움직이기 시작하면 열려 있던 상세·설정·경로 고르기 창을 닫는다(재탐색 창은 그대로)
  useEffect(() => {
    if (!uxBlocked) return;
    setTripDetail(null);
    setSettingsOpen(false);
    if (routePick?.kind === "initial" && !guideChoice) closeRoutePick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uxBlocked]);

  function startNavTo(dest: RecentDest) {
    pickAbort.current?.abort();
    pickRequestSeq.current++;
    setDestErr(null);
    setPickCands({});
    pickCandsRef.current = {};
    pickDestRef.current = dest;
    setPickMode("time");
    setPickShowDur(false);
    pickOriginRef.current = null;
    setRoutePick({ kind: "initial", dest });
    // 기본 옵션(최단시간)을 바로 불러와 지도에 정체색으로 미리보기
    loadCand("time", dest);
  }

  /** 옵션 하나의 경로·소요·정체 미리보기를 불러온다(캐시된 건 재사용). */
  async function loadCand(mode: NavMode, dest: RecentDest) {
    setPickMode(mode);
    const activeDest = pickDestRef.current;
    if (
      !activeDest ||
      activeDest.lat !== dest.lat ||
      activeDest.lng !== dest.lng
    )
      return;
    if (pickCandsRef.current[mode]) return;
    pickAbort.current?.abort();
    const controller = new AbortController();
    pickAbort.current = controller;
    const request = ++pickRequestSeq.current;
    setPickLoading(mode);
    setDestErr(null);
    try {
      let origin = pickOriginRef.current;
      if (!origin) {
        origin = navOrigin
          ? { lat: navOrigin.lat, lng: navOrigin.lng }
          : await currentPosition();
        pickOriginRef.current = origin;
        if (!navOrigin) setGpsFixed(true);
      }
      const res = await fetch("/api/nav-directions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin,
          destination: { lat: dest.lat, lng: dest.lng },
          mode,
          ...(navVias.length
            ? { waypoints: navVias.map((v) => ({ lat: v.lat, lng: v.lng })) }
            : {}),
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      const currentDest = pickDestRef.current;
      if (
        request !== pickRequestSeq.current ||
        !currentDest ||
        currentDest.lat !== dest.lat ||
        currentDest.lng !== dest.lng
      )
        return;
      if (!res.ok || !data.candidate?.path?.length) {
        throw new Error(data.error ?? "경로를 찾지 못했어요");
      }
      const c = data.candidate;
      const candidate: NavCand = {
          enc: encodePolyline(
            c.path.map((p: LatLng): [number, number] => [p.lat, p.lng]),
          ),
          durationSec: c.durationSec,
          distanceM: c.distanceM,
          tollFare: c.tollFare,
          trafficSamples: Array.isArray(c.trafficSamples)
            ? c.trafficSamples
            : [],
      };
      pickCandsRef.current = { ...pickCandsRef.current, [mode]: candidate };
      setPickCands(pickCandsRef.current);
    } catch (e) {
      if (controller.signal.aborted || request !== pickRequestSeq.current) return;
      setDestErr(e instanceof Error ? e.message : "경로 탐색 실패");
    } finally {
      if (request === pickRequestSeq.current) setPickLoading(null);
    }
  }

  /** 미리 받아둔 후보로 바로 안내 시작(재요청 없이). */
  function startPickedNav(dest: RecentDest) {
    const mode = pickMode;
    const c = pickCandsRef.current[mode];
    if (!c) {
      runInitialNav(dest, mode);
      return;
    }
    const navPlan: DrivePlan = {
      label: dest.name,
      durationSec: c.durationSec,
      distanceM: c.distanceM,
      ts: Date.now(),
      path: c.enc,
      standalone: true,
    };
    beginGuided(navPlan, { onStarted: () => {
      navModeRef.current = mode;
      pushRecent(dest);
      setRoutePick(null);
      pickDestRef.current = null;
      pickAbort.current?.abort();
      pickRequestSeq.current++;
      setNavPicker(false);
      setNavPrep(null);
      setDestQuery("");
      setDestResults([]);
      setNavOrigin(null);
      setOriginPick(false);
      setNavVias([]);
      setViaPick(false);
      setPickCands({});
      pickCandsRef.current = {};
    } });
  }

  /** 고른 옵션(mode)으로 출발지–목적지 실측 경로를 받아 자체 내비 시작.
   *  출발지는 navOrigin(고른 곳) 우선, 없으면 현재 위치. */
  async function runInitialNav(dest: RecentDest, mode: NavMode) {
    if (!window.DriveNative?.startPleosCourse) closeRoutePick();
    navigationAbort.current?.abort();
    const controller = new AbortController();
    navigationAbort.current = controller;
    const request = ++navigationRequestSeq.current;
    setDestErr(null);
    navModeRef.current = mode;
    try {
      let origin: LatLng;
      if (navOrigin) {
        origin = { lat: navOrigin.lat, lng: navOrigin.lng };
      } else {
        setNavPrep("현재 위치 확인 중…");
        origin = await currentPosition();
        if (request !== navigationRequestSeq.current) return;
        setGpsFixed(true);
      }
      setNavPrep("경로 탐색 중…");
      const res = await fetch("/api/nav-directions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin,
          destination: { lat: dest.lat, lng: dest.lng },
          mode,
          ...(navVias.length
            ? { waypoints: navVias.map((v) => ({ lat: v.lat, lng: v.lng })) }
            : {}),
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (request !== navigationRequestSeq.current) return;
      if (!res.ok || !data.candidate?.path?.length) {
        throw new Error(data.error ?? "경로를 찾지 못했어요");
      }
      const c = data.candidate;
      const enc = encodePolyline(
        c.path.map((p: LatLng): [number, number] => [p.lat, p.lng]),
      );
      const navPlan: DrivePlan = {
        label: dest.name,
        durationSec: c.durationSec,
        distanceM: c.distanceM,
        ts: Date.now(),
        path: enc,
        standalone: true,
      };
      setNavPrep(null);
      beginGuided(navPlan, { onStarted: () => {
        navModeRef.current = mode;
        pushRecent(dest);
        setRoutePick(null);
        pickDestRef.current = null;
        pickAbort.current?.abort();
        pickRequestSeq.current++;
        setNavPicker(false);
        setNavPrep(null);
        setDestQuery("");
        setDestResults([]);
        setNavOrigin(null);
        setOriginPick(false);
        setNavVias([]);
        setViaPick(false);
      } });
    } catch (e) {
      if (controller.signal.aborted || request !== navigationRequestSeq.current) return;
      setNavPrep(null);
      setDestErr(e instanceof Error ? e.message : "경로 탐색 실패");
    }
  }

  /** 주행 중 경유지 추가 — 현위치–경유지–(기존)목적지로 경로를 다시 짜고
   *  자체 내비 안내를 새로 받는다. 목적지는 현재 안내 경로의 끝점. */
  async function addViaDuringDrive(via: RecentDest) {
    const eng = navEng.current;
    if (!eng || eng.path.length < 2) {
      setDestErr("주행 중에만 경유지를 추가할 수 있어요");
      return;
    }
    setNavPrep("경유지 반영 중…");
    setDestErr(null);
    navigationAbort.current?.abort();
    const controller = new AbortController();
    navigationAbort.current = controller;
    const request = ++navigationRequestSeq.current;
    try {
      const cur = navLastFix.current ??
        navPos ?? { lat: eng.path[0].lat, lng: eng.path[0].lng };
      const dest = eng.path[eng.path.length - 1];
      // 카카오 실경로로 뽑는다(로컬 A* 대신) — 안내가 실제 도로와 어긋나지 않게.
      // 원래 길찾기에서 고른 옵션(navModeRef)을 그대로 유지.
      const res = await fetch("/api/nav-directions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin: { lat: cur.lat, lng: cur.lng },
          destination: { lat: dest.lat, lng: dest.lng },
          waypoints: [{ lat: via.lat, lng: via.lng }],
          mode: navModeRef.current,
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (request !== navigationRequestSeq.current) return;
      if (!res.ok || !data.candidate?.path?.length) {
        throw new Error(data.error ?? "경로를 찾지 못했어요");
      }
      const enc = encodePolyline(
        data.candidate.path.map((p: LatLng): [number, number] => [p.lat, p.lng]),
      );
      const previous = activePlanRef.current;
      const updated: DrivePlan = {
        label: previous?.label ?? eng.path[eng.path.length - 1].lat.toFixed(5),
        durationSec: data.candidate.durationSec,
        distanceM: data.candidate.distanceM,
        path: enc,
        vias: [...(previous?.vias ?? []), { ...via, dwellMin: 0 }],
        standalone: previous?.standalone ?? true,
        ts: Date.now(),
      };
      // 새 경로로 안내 갱신 (nav-route가 회전·캠·좁아짐 다시 뽑는다)
      if (!(await fetchAndApplyGuidance({ path: enc })))
        throw new Error("안내 생성 실패");
      activePlanRef.current = updated;
      originalPlanRef.current = {
        ...updated,
        vias: updated.vias?.map((v) => ({ ...v })),
      };
      setPlan(updated);
      saveNavSession();
      pushRecent(via);
      lastRerouteAt.current = Date.now(); // 직후 자동 재탐색 억제
      setNavPicker(false);
      setViaMode(false);
      setNavPrep(null);
      setDestQuery("");
      setDestResults([]);
      speakNav([`경유지를 추가했습니다. ${via.name} 방면으로 안내합니다.`]);
    } catch (e) {
      if (controller.signal.aborted || request !== navigationRequestSeq.current) return;
      setNavPrep(null);
      setDestErr(e instanceof Error ? e.message : "경유지 추가 실패");
    }
  }

  /** 예정 코스(plan)에 주유소를 경유지로 끼운다 — 출발–주유소–도착으로 재탐색 */
  const [gasViaBusy, setGasViaBusy] = useState<string | null>(null);
  async function addGasVia(via: {
    name: string;
    lat: number;
    lng: number;
  }) {
    if (!plan?.path) return;
    const basePlan = plan;
    const request = ++gasViaRequestSeq.current;
    gasViaAbort.current?.abort();
    const controller = new AbortController();
    gasViaAbort.current = controller;
    setGasViaBusy(via.name);
    try {
      const pts = decodePolyline(plan.path).map(([lat, lng]) => ({ lat, lng }));
      const origin = pts[0];
      const destination = pts[pts.length - 1];
      const res = await fetch("/api/local-route", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin,
          destination,
          waypoints: [{ lat: via.lat, lng: via.lng }],
        }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (request !== gasViaRequestSeq.current) return;
      if (!res.ok || !data.candidate?.path?.length)
        throw new Error(data.error ?? "경로를 찾지 못했어요");
      const enc = encodePolyline(
        data.candidate.path.map((p: LatLng): [number, number] => [
          p.lat,
          p.lng,
        ]),
      );
      const updatedPlan: DrivePlan = {
        ...basePlan,
        path: enc,
        distanceM: data.candidate.distanceM ?? basePlan.distanceM,
        // 재탐색 응답은 순수 운전시간이다. 기존 카페·맛집 체류를 다시 더해
        // 추천 화면에서 정한 전체 일정이 주유소 추가 뒤에도 사라지지 않게 한다.
        durationSec:
          (data.candidate.durationSec ??
            Math.max(0, basePlan.durationSec - dwellSecOf(basePlan.vias))) +
          dwellSecOf(basePlan.vias),
        label: basePlan.label.includes("주유")
          ? basePlan.label
          : `${basePlan.label} · 주유 경유`,
        vias: [...(basePlan.vias ?? []), via],
      };
      setPlan(updatedPlan);
      setTab("course");
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e) {
      if (controller.signal.aborted || request !== gasViaRequestSeq.current) return;
      setDestErr(e instanceof Error ? e.message : "경유지 추가 실패");
    } finally {
      if (request === gasViaRequestSeq.current) setGasViaBusy(null);
    }
  }

  /**
   * 로컬/ITS 추천은 출발 순간에만 카카오 도로망으로 확인한다. 카카오가 원래
   * 풍경 코스와 다른 길을 만들거나 호출이 실패하면 원본으로 바로 안내한다.
   */
  async function preparePlanGuidance(initial: DrivePlan) {
    if (!localGuidanceAllowed(guideModeRef.current)) return;
    if (!initial.path) return;
    planConfirmAbort.current?.abort();
    const controller = new AbortController();
    planConfirmAbort.current = controller;
    const request = ++planConfirmRequestSeq.current;
    let selected = initial;
    const stillDriving = () =>
      phaseRef.current === "driving" || phaseRef.current === "paused";
    // 빌려 쓰기 모드: drivelog의 확인 API는 로그인이 필요해 부르지 않고 원본 경로로 바로 안내한다.
    if (initial.routeSource === "local-its" && !borrowMode.current) {
      setNavPrep("카카오 도로로 최종 확인 중…");
      try {
        const res = await fetch("/api/route-confirm", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            path: initial.path,
            vias: (initial.vias ?? []).map((via) => ({
              lat: via.lat,
              lng: via.lng,
            })),
          }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (
          controller.signal.aborted ||
          request !== planConfirmRequestSeq.current ||
          activePlanRef.current !== initial ||
          !stillDriving()
        )
          return;
        if (
          res.ok &&
          data.confirmed === true &&
          typeof data.path === "string" &&
          typeof data.durationSec === "number" &&
          typeof data.distanceM === "number"
        ) {
          selected = {
            ...initial,
            path: data.path,
            // 확인 API 시간은 순수 운전시간. 추천에서 정한 체류를 다시 합친다.
            durationSec: data.durationSec + dwellSecOf(initial.vias),
            distanceM: data.distanceM,
            routeSource: "kakao",
          };
          activePlanRef.current = selected;
          originalPlanRef.current = {
            ...selected,
            vias: selected.vias?.map((via) => ({ ...via })),
          };
          setPlan(selected);
        }
      } catch {
        if (controller.signal.aborted || request !== planConfirmRequestSeq.current) return;
        // 카카오 장애/쿼터 초과 — 추천 때 검증된 로컬 경로로 계속한다.
      }
    }
    if (
      controller.signal.aborted ||
      request !== planConfirmRequestSeq.current ||
      activePlanRef.current !== selected ||
      !stillDriving()
    )
      return;
    setNavPrep(null);
    const ok = await fetchAndApplyGuidance({ path: selected.path! });
    if (!ok && selected !== initial && activePlanRef.current === selected) {
      // 확인 경로 안내 생성만 실패한 이례 상황에서도 원본 안내를 한 번 더 시도.
      activePlanRef.current = initial;
      originalPlanRef.current = {
        ...initial,
        vias: initial.vias?.map((via) => ({ ...via })),
      };
      setPlan(initial);
      await fetchAndApplyGuidance({ path: initial.path! });
    }
  }

  function beginGuided(p: DrivePlan, opts: { mode?: TripMode; onAccepted?: () => void; onStarted?: () => void } = {}) {
    courseStartDiagnostic("beginGuided", { recovery: !!recoveryPendingRef.current,
      phase: phaseRef.current, carBuild: typeof window.DriveNative?.startPleosCourse === "function",
      path: !!p?.path, mode: opts.mode ?? "car", support: pleosSupport() });
    if (recoveryPendingRef.current) {
      courseStartDiagnostic("beginGuided.skip", { reason: "recovery-pending" });
      return;
    }
    const mode = opts.mode ?? "car";
    const isCarBuild = typeof window.DriveNative?.startPleosCourse === "function";
    const blocked = isCarBuild ? guidedStartBlockMessage(phaseRef.current) : null;
    if (blocked) {
      courseStartDiagnostic("beginGuided.skip", { reason: "active-recording" });
      setLinkedMsg(blocked);
      window.setTimeout(() => setLinkedMsg(null), 7000);
      return;
    }
    opts.onAccepted?.();
    const support = pleosSupport();
    courseStartDiagnostic("beginGuided.decision", { carBuild: isCarBuild, path: !!p?.path,
      mode, support, chooser: needsGuideChoice(isCarBuild, p, mode, false, support) });
    if (!needsGuideChoice(isCarBuild, p, mode, false, support)) {
      start(p, mode, false, { guideSelected: true, onAcknowledged: ok => { if(ok)opts.onStarted?.(); } });
      return;
    }
    guideSelectionGen.current++;
    guideRequest.current = { plan: p, mode, onStarted: opts.onStarted };
    guideDecisionBusy.current = false;
    setGuideBusy(false);
    setGuideMessage(null);
    setGuideChoice(true);
  }

  function cancelGuideChoice() {
    if (recoveryPendingRef.current) return;
    if (guideDecisionBusy.current) return;
    guideSelectionGen.current++;
    guideRequest.current = null;
    guideDecisionBusy.current = false;
    setGuideChoice(false);
    setGuideBusy(false);
    setGuideMessage(null);
  }

  function completeGuideStart(request: NonNullable<typeof guideRequest.current>) {
    guideRequest.current = null;
    guideDecisionBusy.current = false;
    setGuideBusy(false);
    setGuideChoice(false);
    if (request.onStarted) request.onStarted();
    else {
      pickAbort.current?.abort();
      pickRequestSeq.current++;
      pickDestRef.current = null;
    }
  }

  function onNativeGuideActive() {
    if (guideModeRef.current !== "local" && guideModeRef.current !== "local-pending") return;
    guideSelectionGen.current++;cancelRequestIdRef.current = null;
    setGuidanceMode("local-failed");
    setGuideFailure("현대 내비 안내가 다시 켜졌어요. 이 앱 안내를 멈췄어요");
    saveNavSession();
  }

  /** 다른 내비가 안내 주인 자리를 가져감 — 이 앱 안내를 바로 멈추고 기록만 이어간다(되찾지 않는다). */
  function onNavFocusLost() {
    navFocus.current.markLost();
    if (guideModeRef.current !== "local") return;
    guideSelectionGen.current++;cancelRequestIdRef.current = null;
    setGuidanceMode("none");
    setGuideFailure(NAV_FOCUS_LOST_TEXT);
    saveNavSession();
  }

  function loadSavedGuidance(s: { recordingId?: string; guideMode?: GuideMode; guidance?: unknown; idx?: number }) {
    recordingIdRef.current = typeof s.recordingId === "string" ? s.recordingId : null;
    recordingAckRef.current = false;
    cancelRequestIdRef.current = null;
    const savedMode: GuideMode = ["native", "local", "local-pending", "local-failed", "none"].includes(s.guideMode ?? "")
      ? s.guideMode! : (window.DriveNative?.isPleosAudioOwned?.() ? "native" : "local");
    setGuidanceMode(restoreGuideMode(savedMode, pleosSupport()));
    restoredGuidanceRef.current = s.guidance && guideModeRef.current === "local-pending"
      ? { recordingId: recordingIdRef.current, guidance: s.guidance, idx: s.idx || 0 } : null;
    if(guideModeRef.current === "local-failed")setGuideFailure("현대 내비 안내를 끄지 못했어요. 현대 내비에서 안내를 끝내면 이 앱 안내로 바꿀 수 있어요");
    // 안내 복원 — 원본 재적용 후 진행 위치(idx)를 되돌린다
    if (localGuidanceAllowed(guideModeRef.current) && s.guidance) {
      lastGuidanceRef.current = s.guidance;
      applyGuidance(s.guidance);
      navEng.current?.restoreProgress(s.idx || 0);
    } else if (localGuidanceAllowed(guideModeRef.current) && activePlanRef.current?.path) {
      // 안내 스냅샷 없이 복원(출발 직후 nav-route 응답 전에 백그라운드 전환된
      // 세션) — 원본 경로로 안내를 다시 받아 회전·단속캠이 먹통이 되지 않게.
      const savedIdx = s.idx || 0;
      const src = activePlanRef.current.path;
      void fetchAndApplyGuidance({ path: src }).then((ok) => {
        if (ok) navEng.current?.restoreProgress(savedIdx);
      });
    }
  }

  function setGuidanceMode(mode: GuideMode) {
    // 이 앱이 안내하기 직전에 차의 안내 주인 자리를 받는다. 거절되면 안내 없이 기록만.
    if (mode === "local" && !navFocus.current.acquire()) {
      mode = "none";setGuideFailure(NAV_FOCUS_REFUSED_TEXT);
    }
    if (mode === "local" && window.DriveNative?.useLocalAudio?.() === false) {
      mode = "local-failed";setGuideFailure("현대 내비 안내가 다시 켜졌어요. 이 앱 안내를 멈췄어요");
    }
    guideModeRef.current = mode;
    setGuideMode(mode);
    if (mode === "local") {
      void audioCtxRef.current?.resume();
    } else {
      navFocus.current.release();
      guidanceRequestSeq.current++;guidanceAbort.current?.abort();
      planConfirmRequestSeq.current++;planConfirmAbort.current?.abort();
      navEng.current = null;setNavReady(false);setNavSt(null);setNavPrep(null);
      window.DriveNative?.holdLocalAudio?.();
      window.speechSynthesis?.cancel?.();void audioCtxRef.current?.suspend();
    }
  }

  function invalidateGuideSession() {
    guideSelectionGen.current++;recordingIdRef.current = null;recordingAckRef.current = false;
    cancelRequestIdRef.current = null;restoredGuidanceRef.current = null;setGuideFailure(null);setGuidanceMode("none");
  }

  function startAcknowledged(p: DrivePlan, mode: TripMode, target: GuideMode): Promise<boolean> {
    return new Promise(resolve => {
      if (!start(p, mode, target === "native", { guideSelected: true, preservePicker: true,
        initialGuideMode: target, onAcknowledged: resolve })) resolve(false);
    });
  }

  async function chooseNativeGuide() {
    const request = guideRequest.current;
    if (!request || guideDecisionBusy.current) return;
    const generation = ++guideSelectionGen.current;
    try {
      if (window.DriveNative?.canStartPleosCourse?.() !== true || !window.DriveNative.abortProvisionalDrive) {
        setGuideMessage("지금은 현대 내비로 넘길 수 없어요");return;
      }
      guideDecisionBusy.current = true;setGuideBusy(true);setGuideMessage("기록 시작 중…");
      const handed = await startCourse(request.plan);
      if (guideSelectionGen.current !== generation || guideRequest.current !== request) return;
      if (handed) completeGuideStart(request);
      else setGuideMessage(recordingDeniedRef.current ? "기록을 시작하지 못했어요" : "지금은 현대 내비로 넘길 수 없어요");
    } catch {
      if (guideSelectionGen.current === generation && guideRequest.current === request) {
        try {
          abortProvisionalDrive();
        } catch {
          // 정리 실패와 관계없이 시작 실패를 표시한다.
        }
        setGuideMessage("기록을 시작하지 못했어요");
      }
    } finally {
      if (guideSelectionGen.current === generation && guideRequest.current === request) {
        guideDecisionBusy.current = false;setGuideBusy(false);
      }
    }
  }

  async function chooseLocalGuide() {
    const request = guideRequest.current;
    if (!request || guideDecisionBusy.current) return;
    guideDecisionBusy.current = true;setGuideBusy(true);setGuideMessage("기록 시작 중…");
    const generation = ++guideSelectionGen.current;

    try {
      if (!await startAcknowledged(request.plan, request.mode, "local-pending")) {
        if (guideSelectionGen.current === generation && guideRequest.current === request) setGuideMessage("기록을 시작하지 못했어요");
        return;
      }
    } catch {
      if (guideSelectionGen.current === generation && guideRequest.current === request) {
        if (!recordingAckRef.current) {
          try {
            abortProvisionalDrive();
          } catch {
            // 정리 실패와 관계없이 시작 실패를 표시한다.
          }
        }
        setGuideMessage("기록을 시작하지 못했어요");
      }
      return;
    } finally {
      if (guideSelectionGen.current === generation && guideRequest.current === request) {
        guideDecisionBusy.current = false;setGuideBusy(false);
      }
    }
    if (guideSelectionGen.current !== generation || guideRequest.current !== request) return;
    completeGuideStart(request);
    await confirmLocalGuide(false, generation);
  }

  async function confirmLocalGuide(verifyOnly: boolean, generation = ++guideSelectionGen.current) {
    const id = recordingIdRef.current;
    if (!id || !recordingAckRef.current) return;
    setGuidanceMode("local-pending");
    const cancellation = requestPleosCancel(verifyOnly);
    setGuideFailure("현대 내비 안내 끄는 중… 12~20초 소요");
    cancelRequestIdRef.current = cancellation.requestId;saveNavSession();
    const result = await cancellation;
    if (recordingIdRef.current !== id || !recordingAckRef.current || cancelRequestIdRef.current !== cancellation.requestId ||
        guideSelectionGen.current !== generation || (phaseRef.current !== "driving" && phaseRef.current !== "paused")) return;
    if (!currentLocalSelection(generation, guideSelectionGen.current, cancellation.requestId, result)) {
      setGuidanceMode("local-failed");
      setGuideFailure("현대 내비 안내를 끄지 못했어요. 현대 내비에서 안내를 끝내면 이 앱 안내로 바꿀 수 있어요");
    } else {
      setGuidanceMode("local");if(guideModeRef.current === "local")setGuideFailure(null);
      if (guideModeRef.current === "local") {
        const restored = restoredGuidanceRef.current;
        restoredGuidanceRef.current = null;
        if(restored && restored.recordingId === id) {
          applyGuidance(restored.guidance);navEng.current?.restoreProgress(restored.idx);
        } else if(activePlanRef.current?.path)void preparePlanGuidance(activePlanRef.current);
      }
    }
    saveNavSession();
  }

  async function verifyRestoredGuidance() {
    if (pleosSupport() === "unsupported") {
      setGuidanceMode("local");
      if(activePlanRef.current?.path)void preparePlanGuidance(activePlanRef.current);
      return;
    }
    await confirmLocalGuide(true);
  }

  async function startCourse(p: DrivePlan): Promise<boolean> {
    try { provisionalPendingPlan.current = { value: sessionStorage.getItem(PENDING_PLAN_KEY) }; }
    catch { provisionalPendingPlan.current = null; }
    const generation = guideSelectionGen.current;
    if (!await startAcknowledged(p, "car", "native")) {
      if(generation === guideSelectionGen.current)abortProvisionalDrive();
      return false;
    }
    if(generation !== guideSelectionGen.current)return false;
    let handed = false;
    try {
      handed = window.DriveNative?.startPleosCourse?.(JSON.stringify({
        label: p.label, durationSec: p.durationSec, distanceM: p.distanceM,
        routeSource: p.routeSource, path: p.path, vias: p.vias ?? [],
      })) === true;
    } catch { handed = false; }
    if (!handed) { abortProvisionalDrive(); return false; }
    provisionalPendingPlan.current = null;saveNavSession();return true;
  }

  function abortProvisionalDrive() {
    const id = recordingIdRef.current;
    restoredGuidanceRef.current = null;
    recordingIdRef.current = null;recordingAckRef.current = false;cancelRequestIdRef.current = null;setGuidanceMode("none");

    const pending = provisionalPendingPlan.current;
    provisionalPendingPlan.current = null;
    if (pending) {
      try {
        if (pending.value === null) sessionStorage.removeItem(PENDING_PLAN_KEY);
        else sessionStorage.setItem(PENDING_PLAN_KEY, pending.value);
      } catch {}
    }
    planConfirmRequestSeq.current++;
    planConfirmAbort.current?.abort();
    if (nativePoll.current) { clearInterval(nativePoll.current); nativePoll.current = null; }
    if (tickTimer.current) { clearInterval(tickTimer.current); tickTimer.current = null; }
    if (watchRef.current !== null) { navigator.geolocation.clearWatch(watchRef.current); watchRef.current = null; }
    stopResumeWatch();
    guidanceRequestSeq.current++;
    guidanceAbort.current?.abort();
    trafficRequestSeq.current++;
    trafficAbort.current?.abort();
    navigationRequestSeq.current++;
    navigationAbort.current?.abort();
    freeAbort.current?.abort();
    if(id)abortRecording(id);
    window.speechSynthesis?.cancel?.();
    navEng.current = null;
    navEncRef.current = "";
    lastGuidanceRef.current = null;
    activePlanRef.current = null;
    originalPlanRef.current = null;
    nativeRecovery.current = null;
    nativeRecoveryRequestedAt.current = 0;
    lastNativeFixTs.current = 0;
    navLastFix.current = null;
    lastFix.current = null;
    gpsConfirmedRef.current = false;
    pathRef.current = [];
    speedsRef.current = [];
    distRef.current = 0; maxRef.current = 0; movingSec.current = 0;
    startTs.current = 0;
    phaseRef.current = "idle";
    setPhase("idle");
    setSummary(null);
    setNavReady(false); setNavSt(null); setNavPos(null); setNavTraffic(null);
    setNavPrep(null);
    setNavHeading(null); setGpsFixed(false); setNativeTrace(null);
    setKmh(0); setDistM(0); setMaxKmh(0); setElapsed(0); setLivePos(null);
    clearNavSession();
  }

  function start(planOverride?: DrivePlan, mode: TripMode = "car", pleosOwned = false,
    opts: { guideSelected?: boolean; recordingOnly?: boolean; preservePicker?: boolean; initialGuideMode?: GuideMode; onAcknowledged?: (ok: boolean) => void } = {}): boolean {
    courseStartDiagnostic("start", { recovery: !!recoveryPendingRef.current, pendingChoice: !!guideRequest.current,
      guideSelected: !!opts.guideSelected, recordingOnly: !!opts.recordingOnly, phase: phaseRef.current });
    if (recoveryPendingRef.current) {
      courseStartDiagnostic("start.skip", { reason: "recovery-pending" });
      return false;
    }
    if (guideRequest.current && !opts.guideSelected) {
      courseStartDiagnostic("start.skip", { reason: "choice-pending" });
      return false;
    }
    const resolved = planOverride ?? planRef.current;
    const isCarBuild = typeof window.DriveNative?.startPleosCourse === "function";
    const recordingOnly = isCarBuild && opts.recordingOnly === true;
    const resolvedMode = resolved && !recordingOnly ? "car" : mode;
    const support = pleosSupport();
    courseStartDiagnostic("start.decision", { carBuild: isCarBuild, path: !!resolved?.path, mode: resolvedMode,
      recordingOnly, guideSelected: !!opts.guideSelected, support,
      chooser: !opts.guideSelected && needsGuideChoice(isCarBuild, resolved, resolvedMode, recordingOnly, support) });
    if (!opts.guideSelected && needsGuideChoice(isCarBuild, resolved, resolvedMode, recordingOnly, support)) {
      beginGuided(resolved!, { mode: resolvedMode });
      return false;
    }
    if (recordingIdRef.current && !recordingAckRef.current) return false;
    const id = recordingId();
    const generation = guideSelectionGen.current;
    recordingIdRef.current = id;recordingAckRef.current = false;cancelRequestIdRef.current = null;
    notificationNoticeShownRef.current = false;setNotificationNotice(null);
    restoredGuidanceRef.current = null;
    const initialGuideMode = opts.initialGuideMode ?? (pleosOwned ? "native" : pleosSupport() === "unsupported" ? "local" : "none");
    setGuideFailure(null);setGuidanceMode("none");
    planConfirmRequestSeq.current++;
    planConfirmAbort.current?.abort();
    navigationRequestSeq.current++;
    navigationAbort.current?.abort();
    if (!opts.preservePicker) {
      pickAbort.current?.abort();
      pickRequestSeq.current++;
      pickDestRef.current = null;
    }
    // 이번 주행 계획 확정 — 독립 내비는 인자로 넘어오고, 코스는 planRef에서
    const p = recordingOnly ? null : resolved;
    modeRef.current = p ? "car" : mode;
    setActiveMode(modeRef.current);
    zeroRef.current = { z50: null, z100: null };
    launchRef.current = { still: false, t0: -1, pv: -1, pt: -1 };
    gCalcRef.current = { t: 0, v: 0, brg: null, e: { lat: 0, lon: 0 } };
    setGLive(null);
    setGPeaks(ZERO_PEAKS);
    gRecRef.current = { peaks: { accel: 0, brake: 0, left: 0, right: 0 }, env: new Array(G_BINS).fill(0) };
    setLiveZ50(null);
    try {
      sessionStorage.removeItem(PENDING_PLAN_KEY);
    } catch {}
    clearNavSession(); // 새 주행 — 이전 복원 세션 폐기
    stopResumeWatch(); // 이전 주행의 자동재개 감시 잔여 제거
    autoPaused.current = false;
    stationarySince.current = 0;
    lastGuidanceRef.current = null;
    activePlanRef.current = p ?? null;
    originalPlanRef.current = p ? { ...p, vias: p.vias?.map((v) => ({ ...v })) } : null;
    nativeRecovery.current = null;
    nativeRecoveryRequestedAt.current = 0;
    lastNativeFixTs.current = 0;
    dwellProgressRef.current = {};
    lastFix.current = null;
    freeHeadingAnchor.current = null;
    pathRef.current = [];
    speedsRef.current = [];
    setNativeTrace(null); // 새 주행 — 이전 주행의 지나온 경로 지우기
    nativeTraceAt.current = 0;
    pathMinM.current = 20;
    distRef.current = 0;
    maxRef.current = 0;
    movingSec.current = 0;
    startAddr.current = undefined;
    lastAddrAt.current = 0;
    lastAddrPos.current = null;
    addrRef.current = "";
    setKmh(0);
    setMaxKmh(0);
    setDistM(0);
    setElapsed(0);
    setAddr("");
    setSummary(null);
    setGpsErr(null);
    setGpsFixed(false);
    gpsConfirmedRef.current = false;
    lastConfirmedAt.current = 0;
    startTs.current = Date.now();
    // 기록 시작 승인을 받은 뒤에만 주행 상태로 전환한다.

    // 자체 내비 — 경로가 있으면 서버에서 회전·단속캠 안내를 받아온다
    navEng.current = null;
    setNavReady(false);
    setNavSt(null);
    setNavPos(null);
    setNavHeading(null);
    setNavTraffic(null);
    setNavPrep(null);
    navLastFix.current = null;
    lastRerouteAt.current = 0;
    // 일반 주행 상시 안내 초기화
    setFreeLimit(null);
    setFreeCamWarn(null);
    freeCamsRef.current = [];
    freeFetchPos.current = null;
    freeFetchAt.current = 0;
    freeSpokenFocus.current = null;
    freeFetchHd.current = null;
    freeRequestSeq.current++;
    freeAbort.current?.abort();
    freeAbort.current = null;
    freeChainLink.current = null;
    freeCamSpoke.current.clear();
    freeHeadingRef.current = null;
    setLivePos(null);
    // 설정이 켜져 있으면 코스 시작 시 오프라인 지도를 백그라운드로 미리 받는다
    if (offlineAutoOnRef.current && p?.path) void saveOfflineTiles(p.path);
    guidanceRequestSeq.current++;
    guidanceAbort.current?.abort();

    const activate = (ok: boolean) => {
      if (recordingIdRef.current !== id || generation !== guideSelectionGen.current) {
        abortRecording(id);
        if(recordingIdRef.current === id){recordingIdRef.current = null;recordingAckRef.current = false;}
        opts.onAcknowledged?.(false);return;
      }
      if (!ok) {
        recordingDeniedRef.current = true;
        recordingAckRef.current = false;
        abortRecording(id);
        recordingIdRef.current = null;
        setGuidanceMode("none");setGuideFailure("기록을 시작하지 못했어요");
        phaseRef.current = "idle";setPhase("idle");
        opts.onAcknowledged?.(false);return;
      }
      recordingDeniedRef.current = false;recordingAckRef.current = true;
      showNotificationNotice();
      phaseRef.current = "driving";setPhase("driving");
      setGuidanceMode(initialGuideMode);
      if(p?.path && !recordingOnly && guideModeRef.current === "local")void preparePlanGuidance(p);
      if(window.DriveNative)startNativePoll();
      saveNavSession();opts.onAcknowledged?.(true);
    };
    if (window.DriveNative) {
      void requestRecording(modeRef.current, id).then(result => activate(result.ok));
      return true;
    }
    if (!navigator.geolocation) {
      setGpsErr("이 브라우저는 위치를 지원하지 않아요");activate(false);return false;
    }
    activate(true);startWebWatch();
    tickTimer.current = setInterval(() => {
      setElapsed(Math.max(0, Math.floor((Date.now() - startTs.current) / 1000)));
    }, 1000);
    return true;
  }

  const AUTOPAUSE_MS = 5 * 60_000; // 5분 정차 시 자동 일시중지
  const STOP_KMH = 3; // 이 미만이면 정차로 본다

  /** 매 픽스마다 정차 시간 누적 — 5분 넘게 서 있으면 자동 일시중지 */
  function trackStationary(curKmh: number) {
    if (phaseRef.current !== "driving" || !autoPauseOnRef.current) {
      stationarySince.current = 0;
      return;
    }
    const now = Date.now();
    if (curKmh < STOP_KMH) {
      if (stationarySince.current === 0) stationarySince.current = now;
      else if (now - stationarySince.current >= AUTOPAUSE_MS) autoDoPause();
    } else {
      stationarySince.current = 0;
    }
  }

  function stopResumeWatch() {
    if (resumeWatch.current !== null) {
      navigator.geolocation.clearWatch(resumeWatch.current);
      resumeWatch.current = null;
    }
    document.removeEventListener("visibilitychange", resumeVisRef.current);
    resumeStreak.current = 0;
    resumeLastFix.current = null;
  }

  /** 자동 일시중지 중 재출발 감시 — 저전력 GPS로 지속 이동(≈12km/h·6초) 감지 */
  function startResumeWatch() {
    const arm = () => {
      if (resumeWatch.current !== null || document.visibilityState !== "visible") return;
      resumeWatch.current = navigator.geolocation.watchPosition(
        (pos) => {
          if (!autoPaused.current) return;
          const { latitude: lat, longitude: lng, speed } = pos.coords;
          const ts = pos.timestamp;
          let mps = typeof speed === "number" && speed >= 0 ? speed : -1;
          const prev = resumeLastFix.current;
          if (mps < 0 && prev) {
            const dm = distanceM({ lat, lng }, { lat: prev.lat, lng: prev.lng });
            const dt = (ts - prev.ts) / 1000;
            if (dt > 0 && dm < 500) mps = dm / dt;
          }
          resumeLastFix.current = { lat, lng, ts };
          if (mps * 3.6 > 12) {
            if (resumeStreak.current === 0) resumeMoveStart.current = ts;
            resumeStreak.current++;
            if (resumeStreak.current >= 3 && ts - resumeMoveStart.current >= 5_000) {
              autoDoResume();
            }
          } else resumeStreak.current = 0;
        },
        () => {},
        { enableHighAccuracy: false, maximumAge: 5_000, timeout: 20_000 },
      );
    };
    // 앱을 백그라운드에 뒀다 다시 열면(포그라운드 복귀) 즉시 재무장 — 재개 지연 최소화
    resumeVisRef.current = () => {
      if (document.visibilityState === "visible") arm();
    };
    document.addEventListener("visibilitychange", resumeVisRef.current);
    arm();
  }

  function autoDoPause() {
    autoPaused.current = true;
    stationarySince.current = 0;
    phaseRef.current = "paused";
    setPhase("paused");
    if (window.DriveNative) window.DriveNative.pause();
    else if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
      lastFix.current = null;
      freeHeadingAnchor.current = null;
      setKmh(0);
    }
    startResumeWatch(); // 재출발 감지
  }

  function autoDoResume() {
    stopResumeWatch();
    autoPaused.current = false;
    phaseRef.current = "driving";
    setPhase("driving");
    if (window.DriveNative) window.DriveNative.resume();
    else {
      startWebWatch();
      if (!tickTimer.current) {
        tickTimer.current = setInterval(() => {
          setElapsed(Math.max(0, Math.floor((Date.now() - startTs.current) / 1000)));
        }, 1000);
      }
    }
  }

  function pauseResume() {
    // 수동 조작이면 자동 일시중지 상태를 해제(수동 재개를 자동재개가 덮지 않게)
    autoPaused.current = false;
    stopResumeWatch();
    stationarySince.current = 0;
    if (phase === "driving") {
      phaseRef.current = "paused";
      setPhase("paused");
      if (window.DriveNative) window.DriveNative.pause();
      else if (watchRef.current !== null) {
        navigator.geolocation.clearWatch(watchRef.current);
        watchRef.current = null;
        lastFix.current = null;
        freeHeadingAnchor.current = null;
        setKmh(0);
      }
    } else if (phase === "paused") {
      phaseRef.current = "driving";
      setPhase("driving");
      if (window.DriveNative) window.DriveNative.resume();
      else {
        startWebWatch();
        // 일시중지 상태로 복원된 세션은 tick 타이머가 없다 — 재개 시 없으면
        // 새로 걸어 경과시간이 이어서 흐르게 한다(멈춘 시계 방지).
        if (!tickTimer.current) {
          tickTimer.current = setInterval(() => {
            setElapsed(Math.max(0, Math.floor((Date.now() - startTs.current) / 1000)));
          }, 1000);
        }
      }
    }
  }

  /** 종료 버튼 — 첫 탭은 무장(3초), 무장 상태에서 재탭해야 실제 종료 */
  function armStop() {
    if (stopArm) {
      if (stopArmTimer.current) clearTimeout(stopArmTimer.current);
      setStopArm(false);
      stop();
      return;
    }
    setStopArm(true);
    if (stopArmTimer.current) clearTimeout(stopArmTimer.current);
    stopArmTimer.current = setTimeout(() => setStopArm(false), 3000);
  }
  function stop() {
    invalidateGuideSession();
    stopResumeWatch(); // 자동재개 감시 종료
    autoPaused.current = false;
    if (window.DriveNative) {
      try {
        const result = window.DriveNative.stop(); // Idle polling finalizes only after native persistence succeeds.
        if (typeof result === "string" && JSON.parse(result).ok !== true) {
          setLinkedMsg("주행 종료를 저장하지 못했어요. 다시 종료해 주세요.");
        }
      } catch {
        setLinkedMsg("주행 종료를 확인하지 못했어요. 다시 종료해 주세요.");
      }
      return;
    }
    if (watchRef.current !== null) {
      navigator.geolocation.clearWatch(watchRef.current);
      watchRef.current = null;
    }
    if (tickTimer.current) {
      clearInterval(tickTimer.current);
      tickTimer.current = null;
    }
    const endTs = Date.now();
    finalize({
      id: String(endTs),
      startTs: startTs.current,
      endTs,
      distanceM: Math.round(distRef.current),
      maxKmh: Math.round(maxRef.current),
      avgKmh:
        movingSec.current > 10
          ? Math.round((distRef.current / movingSec.current) * 3.6)
          : 0,
      movingSec: Math.round(movingSec.current),
      startAddr: startAddr.current,
      endAddr: addrRef.current || undefined,
    });
  }

  async function removeRecord(id: string) {
    setConfirmDeleteId(null);
    if (BORROW_SERVER) {
      const userHash = userRef.current?.hash;
      if (!userHash) return;
      const saved = await updateLocalRecords(userHash, (current) => current.filter((r) => r.id !== id));
      if (saved && userRef.current?.hash === userHash) setRecords(saved);
      return;
    }
    // 아직 서버로 못 올라간 큐(outbox)에서도 지운다 — 안 그러면 다음 syncRecords()가
    // 삭제한 기록을 그대로 다시 POST해서 되살린다(부활 버그).
    const userHash = userRef.current?.hash;
    let wasPending = false;
    if (userHash) {
      const outbox = loadOutbox(userHash).map((record) => ({ ...record, owner: userHash }));
      if (outbox.some((r) => r.id === id)) {
        wasPending = true;
        const remaining = outbox.filter((r) => r.id !== id);
        saveOutbox(userHash, remaining);
        setPendingCount(remaining.length);
      }
    }
    try {
      const res = await fetch(`/api/drive-records?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setRecords((await res.json()).records);
        return;
      }
    } catch {
      // 오프라인 — 서버엔 못 지웠다(아래에서 큐 기록만 화면에서 정리)
    }
    // 서버 삭제 실패: 큐에만 있던(아직 서버에 없는) 기록은 화면에서도 빼준다.
    // 서버에 이미 저장된 기록은 온라인일 때만 지워지므로 목록을 건드리지 않는다.
    if (wasPending) setRecords((prev) => prev.filter((r) => r.id !== id));
  }

  // 확인 상태로 둔 삭제 버튼은 몇 초 뒤 자동으로 원상복귀(실수로 켠 채 방치 방지)
  useEffect(() => {
    if (!confirmDeleteId) return;
    const t = setTimeout(() => setConfirmDeleteId(null), 3500);
    return () => clearTimeout(t);
  }, [confirmDeleteId]);

  const fmtDate = (ts: number) =>
    new Date(ts).toLocaleString("ko-KR", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });

  const driving = phase === "driving" || phase === "paused";
  // 현대 내비가 안내 중이면(native) 이 앱은 안내 없이 "기록만 시작"과 같은 기록 화면을 보인다
  const recordOnlyScreen = guideMode === "native";
  // 경로·회전·단속·제한속도 안내는 이 앱이 안내 주인일 때("local")만 보인다.
  // 기록만 시작·현대 내비 안내·준비/실패 중에는 현대 회전 배너·단속 카드도 띄우지 않는다.
  const routeGuideShown = guideMode === "local";
  const devCompare = useDevCompare(
    devOn && compareOn && driving,
    navReady && navEng.current ? navPos : livePos,
    navReady && navEng.current ? navEng.current.path : null,
  );
  // 개발자 기록의 주행 번호 = 주행 시작 시각(센서 원본 data/rawlog/<버킷>/<시작ms>와 같은 기준)
  useEffect(() => {
    setDevTrip(driving ? startTs.current : 0);
    if (driving) devlog("trip", { startTs: startTs.current, mode: activeMode, nav: !!navEng.current });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [driving]);
  const remainingDwell = remainingDwellPlan(
    activePlanRef.current?.vias,
    navEng.current?.path,
    navEng.current?.progress.idx ?? 0,
    dwellProgressRef.current,
    startTs.current + elapsed * 1000,
  );
  const activeDwellVias = remainingDwell.stops;
  const remainingDwellSec = remainingDwell.sec;
  const hasActiveDwell = dwellStopsOf(activeDwellVias).length > 0;
  // 지도에 그릴 '지나온 경로' — 앱이면 네이티브 궤적(백그라운드·화면꺼짐 포함
  // 완전본)을 우선, 없으면(웹·구버전 앱) 웹이 모은 pathRef로 폴백.
  const recTrace =
    nativeTrace && nativeTrace.length > 1
      ? nativeTrace
      : pathRef.current.length > 1
        ? pathRef.current.map(([la, ln]) => ({ lat: la, lng: ln }))
        : undefined;

  // 로그인 게이트 — 기록을 유저별로 분리하려면 먼저 로그인해야 한다.
  // authChecked 전엔 빈 화면(SSR/hydration 일치)으로 깜빡임을 막는다.
  if (!authChecked) return <div className="min-h-screen bg-bg" />;
  if (!user && carAuthBusy) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-bg text-[15px] text-secondary">
        차량 자동 로그인 중…
      </div>
    );
  }
  if (!user) {
    return (
      <div className="min-h-screen bg-bg text-primary">
        <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 px-7 py-10">
          <div>
            <h1 className="text-[2.5rem] font-semibold leading-[1.05] tracking-[-0.035em] text-primary">
              Gubi
            </h1>
          </div>
          <form onSubmit={doLogin} className="flex flex-col gap-3">
            <input
              value={loginId}
              onChange={(e) => setLoginId(e.target.value)}
              placeholder="아이디"
              autoCapitalize="none"
              autoCorrect="off"
              className="rounded-md border border-line bg-raised px-4 py-4 text-[15px] text-primary outline-none transition-colors placeholder:text-secondary focus:border-line"
            />
            <input
              value={loginPw}
              onChange={(e) => setLoginPw(e.target.value)}
              type="password"
              placeholder="비밀번호"
              className="rounded-md border border-line bg-raised px-4 py-4 text-[15px] text-primary outline-none transition-colors placeholder:text-secondary focus:border-line"
            />
            {loginErr && (
              <p className="px-1 pt-1 text-xs text-warn">{loginErr}</p>
            )}
            <button
              type="submit"
              disabled={loginBusy}
              className="mt-2 rounded-md bg-accent py-4 text-[15px] font-semibold text-primary transition-colors disabled:opacity-50"
            >
              {loginBusy ? "확인 중" : "로그인"}
            </button>
            <button
              type="button"
              onClick={() => void doAuth("signup")}
              disabled={loginBusy}
              className="rounded-md border border-line bg-raised py-4 text-[15px] font-semibold text-primary transition-colors disabled:opacity-50"
            >
              회원가입
            </button>
          </form>

          <div className="flex items-center gap-3">
            <span className="h-px flex-1 bg-raised" />
            <span className="text-[12px] text-secondary">또는</span>
            <span className="h-px flex-1 bg-raised" />
          </div>

          <div className="flex flex-col gap-3">
            <button
              type="button"
              onClick={() => {
                void startSocial("kakao", false).then((err) => err && setLoginErr(err));
              }}
              className="rounded-md bg-[#FEE500] py-4 text-[15px] font-semibold text-[#191600] transition-transform"
            >
              카카오로 시작하기
            </button>
            <button
              type="button"
              onClick={() => {
                void startSocial("google", false).then((err) => err && setLoginErr(err));
              }}
              className="rounded-md border border-line bg-panel py-4 text-[15px] font-semibold text-primary transition-transform"
            >
              구글로 시작하기
            </button>
          </div>

          <p className="text-center text-[13px] leading-relaxed text-secondary">
            처음이면 <span className="text-secondary">회원가입</span>, 기존 계정은{" "}
            <span className="text-secondary">로그인</span>. 비밀번호는 이 기기에서
            해시(SHA-256)로 바뀌어 전송되고 서버는 원문을 저장하지 않아요.
          </p>
        </div>
      </div>
    );
  }

  // 위치 권한 게이트 — 권한 없이는 내비·기록이 동작 못 하므로, 로그인 다음
  // 관문으로 막고 회복 경로를 안내한다. "checking"은 조회 중 깜빡임 방지용
  // 빈 화면(로그인 게이트와 동일 패턴).
  if (geoPerm === "checking") return <div className="min-h-screen bg-bg" />;
  if (geoPerm !== "granted") {
    return (
      <LocationGate
        geoPerm={geoPerm}
        isNative={isNative}
        onRequest={requestGeo}
        onRecheck={() => void readGeoPerm()}
      />
    );
  }

  // 구버전의 자동차 외 기록은 목록에 섞지 않는다.
  const carRecords = records.filter((r) => r.mode == null || r.mode === "car");
  const deleteButton = (r: DriveRecord) =>
    confirmDeleteId === r.id ? (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          removeRecord(r.id);
        }}
        aria-label="삭제 확인"
        className="shrink-0 rounded-sm bg-danger-surface px-3 py-1 text-[12px] font-semibold text-danger transition-colors"
      >
        삭제?
      </button>
    ) : (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setConfirmDeleteId(r.id);
        }}
        aria-label="기록 삭제"
        className="grid h-7 w-7 shrink-0 place-items-center rounded-sm text-disabled transition-colors hover:bg-raised hover:text-secondary"
      >
        <IconClose className="h-4 w-4" />
      </button>
    );
  const recordRow = (r: DriveRecord) => (
    <li key={r.id} className="py-2">
      {(
        <TripCard r={r} onClick={() => setTripDetail(r)} action={deleteButton(r)} />
      )}
    </li>
  );

  /** 기록을 날짜별로 묶어 '오늘·어제·10월 19일 일요일' 머리말 아래 줄 세운다 */
  const recordGroups = (list: DriveRecord[]) => {
    const groups: { label: string; items: DriveRecord[] }[] = [];
    for (const r of list) {
      const label = dayLabel(r.startTs);
      if (groups[groups.length - 1]?.label !== label) groups.push({ label, items: [] });
      groups[groups.length - 1].items.push(r);
    }
    return groups;
  };
  const recordList = (groups: { label: string; items: DriveRecord[] }[]) => (
    <div className="flex flex-col gap-1">
      {groups.map((g, i) => {
        const open = openDays[g.label] ?? i === 0;
        const km = g.items.reduce((sum, r) => sum + r.distanceM, 0) / 1000;
        return (
          <section key={g.label}>
            <button
              type="button"
              onClick={() => setOpenDays((o) => ({ ...o, [g.label]: !open }))}
              aria-expanded={open}
              className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-md px-3 py-3 text-left transition-colors active:bg-raised"
            >
              <span className="text-[13px] font-semibold text-secondary">{g.label}</span>
              <span className="ml-auto text-[12px] tabular-nums text-secondary">
                {km.toFixed(1)}km ({g.items.length}회)
              </span>
              <IconChevronRight
                className={`h-4 w-4 shrink-0 text-disabled transition-transform ${open ? "rotate-90" : ""}`}
              />
            </button>
            {open && <ul>{g.items.map(recordRow)}</ul>}
          </section>
        );
      })}
    </div>
  );

  return (
    <div data-native-nav-page data-vehicle-touch data-vehicle-home={phase === "idle" && tab === "course" ? "" : undefined} className="min-h-screen bg-bg text-primary">
      {nativeMap.notice && <div data-over-map role="status" className="fixed inset-x-4 top-4 z-[120] rounded-md bg-panel px-4 py-3 text-sm text-primary">카카오 지도를 못 불러와 기본 지도로 보여요</div>}
      {notificationNotice && <div data-over-map role="status" className="fixed inset-x-4 top-4 z-[90] rounded-md bg-panel p-4 text-primary">
        <p>{notificationNotice}</p>
        <button type="button" className="mt-2 text-sm" onClick={() => setNotificationNotice(null)}>닫기</button>
      </div>}
      {/* 주행 중엔 아래 단추 줄(재탐색·경로 취소·일시중지·주행 종료) 위에 띄운다 — 덮으면 주행을 끝낼 수 없다. */}
      {resumeAsk && driving && <div data-over-map role="status" className="fixed left-4 right-4 z-[91] rounded-md bg-panel p-4 text-primary"
        style={{ bottom: overBottomH ? overBottomH + 8 : 16 }}>
        <p>앱이 다시 켜졌어요. 이 코스를 현대 내비로 다시 안내할까요?</p>
        <div className="mt-2 flex gap-2">
          <button type="button" className="rounded-md bg-accent px-4 py-2" onClick={() => {
            setResumeAsk(false);
            let resumed = false;
            try {
              resumed = !!activePlanRef.current?.path
                && window.DriveNative?.resumePleosCourse?.(JSON.stringify(activePlanRef.current)) === true;
            } catch {
              // 아래에서 안내한다.
            }
            if (!resumed) setGuideFailure("현대 내비 안내를 다시 시작하지 못했어요");
          }}>다시 안내</button>
          <button type="button" className="rounded-md bg-raised px-4 py-2" onClick={() => {
            setResumeAsk(false);setGuidanceMode("none");saveNavSession();
          }}>기록만 계속</button>
        </div>
      </div>}
      {guideFailure && <div data-over-map role="status" className="fixed left-4 right-4 z-[90] rounded-md bg-panel p-4 text-primary"
        style={{ bottom: driving && overBottomH ? overBottomH + 8 : 16 }}>
        <p>{guideFailure}</p>
        <div className="mt-2 flex gap-2">
          {guideModeRef.current === "local-failed" && <button type="button" className="rounded-md bg-accent px-4 py-2"
            onClick={() => { void confirmLocalGuide(false); }}>다시 시도</button>}
          <button type="button" className="rounded-md bg-raised px-4 py-2" onClick={() => setGuideFailure(null)}>닫기</button>
        </div>
      </div>}
      {carBuild && guideChoice && <GuideChoice busy={guideBusy} message={guideMessage}
        onNative={chooseNativeGuide} onLocal={() => { void chooseLocalGuide(); }} onCancel={cancelGuideChoice} />}
      {linkedMsg && (
        <div data-over-map role="status" className="pointer-events-none fixed inset-x-0 top-4 z-[110] flex justify-center px-4">
          <div className="max-w-md rounded-md border border-accent bg-accent-surface px-4 py-3 text-center text-[13px] font-medium text-accent-text">
            {linkedMsg}
          </div>
        </div>
      )}
      {recordSaveNotice && (
        <div role="status" className="relative z-50 flex items-center justify-center gap-3 border-b border-line bg-panel px-4 py-3 text-[12px] text-primary">
          <span>{recordSaveNotice}</span>
          <button type="button" onClick={() => setRecordSaveNotice(null)}>닫기</button>
        </div>
      )}
      {(phase === "driving" || phase === "paused") && liveTripOwner && !ownedBy(liveTripOwner, user?.hash) && (
        <div role="status" className="relative z-50 border-b border-line bg-panel px-4 py-3 text-center text-[12px] text-primary">
          {liveTripOwner === UNASSIGNED ? "주인이 정해지지 않은 주행을 기록 중이에요" : "다른 계정의 주행을 기록 중이에요"}
        </div>
      )}
      {unassignedCount > 0 && user && (
        <div className="relative z-50 flex items-center justify-center gap-3 border-b border-line bg-panel px-4 py-3 text-[12px] text-primary">
          <span>주인 없는 주행 {unassignedCount}개 (이 계정에 저장)</span>
          <button type="button" className="rounded-sm bg-accent px-3 py-2 text-on-accent" onClick={() => {
            if (window.DriveNative?.adoptUnassignedTrips?.(user.hash)) {
              importPendingTrips();
              if (!BORROW_SERVER) window.DriveNative?.flushUploads?.();
            }
          }}>확인</button>
        </div>
      )}
      <div data-app-frame className="mx-auto flex min-h-screen log-content-width flex-col px-6 py-8">
        <header>
          <h1 className="text-[1.9rem] font-bold leading-none tracking-[-0.03em] text-primary">
            {phase !== "idle" || uxBlocked
              ? "Gubi"
              : tab === "course"
                  ? "코스 추천"
                  : tab === "places"
                    ? "근처 장소"
                    : tab === "gas"
                      ? "주변 주유소"
                      : tab === "conquest"
                        ? "내가 달린 지도"
                        : "프로필"}
          </h1>
        </header>

        {driving && !recordOnlyScreen && navReady && navEng.current && (
          <div data-native-driving className="fixed inset-0 z-40 bg-bg">
            {/* 전체화면 지도 — 컨트롤은 배너/정보바에 안 가리게 밀어둔다 */}
            <div className="absolute inset-0">
              <NavMapAny
                engineToggle={engineToggle}
                path={navEng.current.path}
                pos={navPos}
                kmh={kmh}
                heading={navHeading}
                alongIdx={navEng.current.progress.idx}
                nextAt={navSt?.next ? navSt.next.m.at : null}
                maneuvers={navEng.current.maneuvers}
                cams={navEng.current.cams}
                compare={devCompare}
                offRoute={!!navSt?.offRoute}
                traffic={navTraffic ?? undefined}
                // 안내 중에도 '실제로 달려온 길'을 함께 그린다 — 경로에서
                // 벗어났을 때 어디로 왔는지 보인다(경로가 위에 덧그려짐).
                trace={recTrace}
                insetTop={overTopH ?? (activePlanRef.current?.vias?.length ? 140 : 84)}
                insetBottom={overBottomH ?? (hasActiveDwell ? 190 : 150)}
                fullBleed
              />
            </div>

            {/* 상단 회전 안내 배너 (오버레이) */}
            <div ref={overTopRef} data-over-map className="absolute inset-x-0 top-0 p-3">
              <div
                className={`flex items-center gap-3 rounded-md px-4 py-3 text-primary  ${
                  navSt?.arrived
                    ? "bg-ok-surface"
                    : navSt?.offRoute
                      ? "bg-warn-surface"
                      : "bg-panel"
                }`}
              >
                <button
                  type="button"
                  onClick={() =>
                    setVoiceOn((v) => {
                      try {
                        localStorage.setItem(
                          "drivelog-nav-voice-v1",
                          v ? "off" : "on",
                        );
                      } catch {}
                      if (v) window.speechSynthesis?.cancel?.();
                      return !v;
                    })
                  }
                  className="shrink-0 rounded-md bg-overlay px-2 py-1 text-lg"
                  aria-label={voiceOn ? "음성 안내 끄기" : "음성 안내 켜기"}
                  aria-pressed={voiceOn}
                >
                  <IconSound on={voiceOn} />
                </button>
                {navSt?.arrived ? (
                  <p className="text-xl font-extrabold">
                    {remainingDwellSec > 0 ? "목적지 도착 (체류 중)" : "목적지 도착"}
                  </p>
                ) : navSt?.offRoute ? (
                  <p className="text-lg font-extrabold">경로 재탐색 중…</p>
                ) : navSt?.next ? (
                  <>
                    <span className="shrink-0 text-4xl font-black leading-none">
                      <IconManeuver type={navSt.next.m.type} className="h-6 w-6" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-2xl font-extrabold leading-tight tabular-nums">
                        {fmtM(navSt.next.distM)}
                      </p>
                      <p className="truncate text-[13px] text-accent-text">
                        {navSt.next.m.type === "arrive"
                          ? "목적지"
                          : MANEUVER_LABEL[navSt.next.m.type]}
                        {navSt.next.m.dest
                          ? ` (${navSt.next.m.dest} 방면)`
                          : navSt.next.m.road
                            ? ` (${navSt.next.m.road})`
                            : ""}
                      </p>
                    </div>
                    {navSt.cam && !pleosCamera && (
                      <span className="shrink-0 rounded-md bg-danger-strong px-3 py-2 text-center text-sm font-bold leading-tight tabular-nums">
                        {navSt.cam.c.limitKmh ? (
                          <span className="block rounded-sm bg-panel px-1 text-[13px] font-black text-danger">
                            {navSt.cam.c.limitKmh}
                          </span>
                        ) : null}
                        <span className="mt-1 block">
                          {navSt.cam.c.kind === "section" ? "구간" : "단속"}{" "}
                          {fmtM(navSt.cam.distM)}
                        </span>
                      </span>
                    )}
                  </>
                ) : (
                  <p className="text-base font-bold">
                    {phase === "paused"
                      ? "일시중지"
                      : gpsFixed
                        ? "안내 준비 중…"
                        : gpsErr?.includes("거부") || gpsErr?.includes("필요")
                          ? "위치 권한 꺼짐"
                          : "GPS 신호 찾는 중…"}
                  </p>
                )}
              </div>
              {activePlanRef.current?.vias && activePlanRef.current.vias.length > 0 && (
                <CourseStrip vias={activePlanRef.current.vias} pos={navPos ?? livePos} remainM={navSt?.remainM} remainSec={navSt?.remainSec} fallbackM={activePlanRef.current.distanceM} />
              )}
              <PleosSafetyCard />
              {navSt?.section && !pleosCamera && !navSt.arrived && (
                <div
                  className={`mt-2 flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-bold text-primary  ${
                    navSt.section.limitKmh &&
                    navSt.section.avgKmh > navSt.section.limitKmh
                      ? "bg-danger-surface"
                      : "bg-raised"
                  }`}
                >
                  <span>구간단속</span>
                  <span className="tabular-nums">
                    평균 {navSt.section.avgKmh}
                    {navSt.section.limitKmh
                      ? ` / 제한 ${navSt.section.limitKmh}`
                      : ""}{" "}
                    km/h
                  </span>
                </div>
              )}
            </div>

            {/* 하단 정보바 + 컨트롤 (오버레이) */}
            <div ref={overBottomRef} data-over-map className="absolute inset-x-0 bottom-0 space-y-2 p-3">
              {hasActiveDwell && (
                <DwellSchedule
                  vias={activeDwellVias}
                  className="rounded-md bg-bg px-3 py-2"
                />
              )}

              <div className="flex items-stretch gap-2 rounded-md bg-bg p-2">
                <div className="flex flex-1 items-center justify-center gap-2 rounded-md bg-accent-surface px-1 py-2">
                  <div className="flex flex-col items-center justify-center">
                    <span
                      className={`text-3xl font-extrabold leading-none tabular-nums ${
                        (!!pleosCamera || !!navSt?.cam) &&
                        (pleos.feed?.speedLimitKmh ?? (navSt?.limitTagged ? navSt.limitKmh : null)) != null &&
                        kmh > (pleos.feed?.speedLimitKmh ?? navSt?.limitKmh ?? Infinity)
                          ? "text-danger"
                          : "text-primary"
                      }`}
                    >
                      {kmh}
                    </span>
                    <span className="text-[10px] text-secondary">{kmhEst ? "km/h 추정" : "km/h"}</span>
                  </div>
                  {/* 확정(OSM 태그·단속카메라) 제한속도만 표시 — 도로급 추정치는
                      오차가 커서 아예 표시하지 않는다(틀린 표지판보다 없는 게 낫다). */}
                  {/* 앞에 단속카메라가 있을 때만 제한속도 표지를 보인다(사용자 요청). */}
                  {(!!pleosCamera || !!navSt?.cam) && (pleos.feed?.speedLimitKmh != null || (navSt?.limitKmh && navSt.limitTagged)) ? (
                    <div
                      className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-[50%] border-4 border-danger bg-signal leading-none"
                      title="제한속도"
                    >
                      <span className="text-lg font-black tabular-nums text-signal-ink">
                        {pleos.feed?.speedLimitKmh ?? navSt?.limitKmh}
                      </span>
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-1 flex-col items-center justify-center px-1">
                  <span className="text-xl font-bold tabular-nums text-primary">
                    {navSt ? (navSt.remainM / 1000).toFixed(1) : "–"}
                  </span>
                  <span className="text-[10px] text-secondary">남은 km</span>
                </div>
                <div className="flex flex-1 flex-col items-center justify-center px-1">
                  <span className="text-xl font-bold tabular-nums text-primary">
                    {navSt
                      ? new Date(
                          Date.now() + (navSt.remainSec + remainingDwellSec) * 1000,
                        ).toLocaleTimeString("ko-KR", {
                          hour: "2-digit",
                          minute: "2-digit",
                        })
                      : "–"}
                  </span>
                  <span className="text-[10px] text-secondary">
                    {navSt && navSt.delaySec >= 60 ? (
                      <span
                        className={
                          navSt.delaySec >= 600
                            ? "font-bold text-danger"
                            : "font-bold text-warn"
                        }
                      >
                        정체 +{Math.round(navSt.delaySec / 60)}분
                        {remainingDwellSec > 0
                          ? ` (체류 ${Math.round(remainingDwellSec / 60)}분)`
                          : ""}
                      </span>
                    ) : (
                      remainingDwellSec > 0 ? "체류 포함 일정 종료" : "도착"
                    )}
                  </span>
                </div>
              </div>
              {gpsErr && (
                <div className="flex items-center justify-center gap-2">
                  <p className="text-xs text-warn">{gpsErr}</p>
                  {(gpsErr.includes("거부") || gpsErr.includes("필요")) && (
                    <button
                      type="button"
                      onClick={retryGps}
                      className="rounded-sm bg-warn-surface px-3 py-1 text-xs font-semibold text-warn"
                    >
                      다시 시도
                    </button>
                  )}
                </div>
              )}
              <div className="flex w-full gap-2">
                <button
                  type="button"
                  onClick={() => setRoutePick({ kind: "reroute" })}
                  className="flex-1 rounded-md bg-raised py-3 text-base font-bold text-accent-text transition-transform"
                >
                  재탐색
                </button>
                <button
                  type="button"
                  onClick={cancelRoute}
                  className="flex-1 rounded-md bg-raised py-3 text-base font-bold text-warn transition-transform"
                >
                  경로 취소
                </button>
              </div>
              <div className="flex w-full gap-2">
                <button
                  type="button"
                  onClick={pauseResume}
                  className="min-h-touch min-w-touch border border-line flex-1 rounded-md bg-raised py-3 text-base font-bold text-primary transition-transform"
                >
                  {phase === "paused" ? "재개" : "일시중지"}
                </button>
                <button
                  type="button"
                  onClick={armStop}
                  className={`min-h-touch min-w-touch border border-line flex-1 rounded-md py-3 text-base font-bold text-primary transition-transform  ${
                    stopArm ? "bg-warn-strong text-primary" : "bg-danger-strong"
                  }`}
                >
                  {stopArm ? "한 번 더 눌러 종료" : "주행 종료"}
                </button>
              </div>
            </div>
          </div>
        )}

        {driving && (recordOnlyScreen || !navReady) && (
          <div data-native-driving data-record-only={recordOnlyScreen || undefined} className="fixed inset-0 z-40 bg-bg">
            {/* 전체화면 지도 — 현위치·진행방향(회전)·지나온 궤적 */}
            <div className="absolute inset-0">
              <NavMapAny
                engineToggle={engineToggle}
                path={[]}
                pos={livePos}
                kmh={kmh}
                heading={navHeading}
                alongIdx={0}
                nextAt={null}
                maneuvers={[]}
                cams={[]}
                compare={devCompare}
                offRoute={false}
                trace={recTrace}
                insetTop={overTopH ?? (routeGuideShown && activePlanRef.current?.vias?.length ? 136 : 80)}
                insetBottom={
                  overBottomH ??
                  (hasActiveDwell && routeGuideShown
                      ? 250
                      : 210)
                }
                fullBleed
              />
            </div>

            {/* 상단 — 현재 속도 + 제한속도 표지 + 상태 */}
            <div ref={overTopRef} data-over-map className="absolute inset-x-0 top-0 p-3">
              <div className="flex items-center gap-3 rounded-md bg-panel px-4 py-3">
                {(() => {
                  const limit = pleos.feed?.speedLimitKmh ?? (freeLimit?.tagged ? freeLimit.kmh : null);
                  const over = routeGuideShown && (!!pleosCamera || !!freeCamWarn) && limit != null && phase !== "paused" && kmh > limit + Math.max(5, limit * 0.08);
                  return (
                    <>
                      <span
                        className={`text-3xl font-black tabular-nums leading-none ${
                          phase === "paused"
                            ? "text-disabled"
                            : over
                              ? "text-danger"
                              : "text-primary"
                        }`}
                      >
                        {kmh}
                      </span>
                      <span className="text-xs font-medium text-secondary">
                        {kmhEst ? "km/h 추정" : "km/h"}
                      </span>
                    </>
                  );
                })()}

                {/* 제한속도 표지 — 확정(OSM 태그·단속카메라)만 표시. 도로급
                    추정치는 오차가 커서 표시하지 않는다(틀린 표지판보다 없는 게 낫다). */}
                {/* 앞에 단속카메라가 있을 때만(사용자 요청) */}
                {routeGuideShown && (!!pleosCamera || !!freeCamWarn) && (pleos.feed?.speedLimitKmh != null || freeLimit?.tagged) && (
                  <div className="flex flex-col items-center leading-none">
                    <div className="flex h-11 w-11 items-center justify-center rounded-[50%] border-[3px] border-danger bg-signal">
                      <span className="text-base font-black tabular-nums text-signal-ink">
                        {pleos.feed?.speedLimitKmh ?? freeLimit?.kmh}
                      </span>
                    </div>
                  </div>
                )}
                <span className="ml-auto truncate text-[13px] text-secondary">
                  {phase === "paused"
                    ? "일시중지"
                    : gpsFixed
                      ? `${addr || "GPS 연결됨"}${abroad ? " (해외, 기록만)" : ""}`
                      : gpsErr?.includes("거부") || gpsErr?.includes("필요")
                        ? "위치 권한 꺼짐"
                        : approxAcc != null
                          ? `${addr ? `${addr} ` : ""}(GPS 잡는 중)`
                          : "GPS 신호 찾는 중…"}
                </span>
              </div>
              {guideMode === "native" && activePlanRef.current && pleos.feed?.courseStatus?.paused && (
                <p data-over-map role="status" className="mt-2 truncate rounded-md border border-line bg-panel px-4 py-2 text-sm text-warn" title={pleos.feed.courseStatus.reason}>{pleos.feed.courseStatus.reason}</p>
              )}
              {/* 이 앱 안내(local)가 아니면 기록 화면만 — 코스 줄·회전·단속·도착 배터리 안내를 띄우지 않는다 */}
              {routeGuideShown && activePlanRef.current?.vias && activePlanRef.current.vias.length > 0 && (
                <CourseStrip vias={activePlanRef.current.vias} pos={navPos ?? livePos} remainM={navSt?.remainM} remainSec={navSt?.remainSec} fallbackM={activePlanRef.current.distanceM} />
              )}
              {routeGuideShown && <PleosSafetyCard />}
              {/* 전방 단속카메라 경고 배너 */}
              {routeGuideShown && freeCamWarn && !pleosCamera && phase !== "paused" && (
                <div className="mt-2 flex items-center gap-3 rounded-md bg-danger-surface px-4 py-3 text-primary">
                  <IconCamera className="h-6 w-6" />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-extrabold leading-tight">
                      {freeCamWarn.school
                        ? "어린이보호구역 단속"
                        : freeCamWarn.kind === "section"
                          ? "구간단속 구간"
                          : "전방 단속카메라"}
                      {freeCamWarn.limitKmh ? ` (제한 ${freeCamWarn.limitKmh})` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 text-lg font-black tabular-nums">
                    {freeCamWarn.distM >= 1000
                      ? `${(freeCamWarn.distM / 1000).toFixed(1)}km`
                      : `${freeCamWarn.distM}m`}
                  </span>
                </div>
              )}
              {gpsErr && (
                <div className="mt-1 flex items-center gap-2 px-1">
                  <p className="text-xs text-warn">{gpsErr}</p>
                  {(gpsErr.includes("거부") || gpsErr.includes("필요")) && (
                    <button
                      type="button"
                      onClick={retryGps}
                      className="rounded-sm bg-warn-surface px-3 py-1 text-xs font-semibold text-warn"
                    >
                      다시 시도
                    </button>
                  )}
                </div>
              )}
            </div>

            {/* 하단 — 스탯 + 릴레이 + 컨트롤 */}
            <div ref={overBottomRef} data-over-map className="absolute inset-x-0 bottom-0 space-y-3 p-3">
              {hasActiveDwell && routeGuideShown && (
                <DwellSchedule
                  vias={activeDwellVias}
                  className="rounded-md bg-bg px-3 py-2"
                />
              )}

              <div className="grid grid-cols-3 gap-2 rounded-md bg-panel p-3 text-center">
                <div>
                  <div className="text-xl font-bold tabular-nums">
                    {(distM / 1000).toFixed(1)}
                  </div>
                  <div className="text-[11px] text-secondary">
                    {"주행 km"}
                  </div>
                </div>
                <div>
                  <div className="text-xl font-bold tabular-nums">
                    {fmtDur(elapsed)}
                  </div>
                  <div className="text-[11px] text-secondary">경과</div>
                </div>
                <div>
                  <div className="text-xl font-bold tabular-nums">
                    {maxKmh}
                  </div>
                  <div className="text-[11px] text-secondary">
                    {"최고 km/h"}
                  </div>
                </div>
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={pauseResume}
                  className="min-h-touch min-w-touch border border-line flex-1 rounded-md bg-raised py-4 text-base font-bold text-primary transition-transform"
                >
                  {phase === "paused" ? "재개" : "일시중지"}
                </button>
                <button
                  type="button"
                  onClick={armStop}
                  className={`min-h-touch min-w-touch border border-line flex-1 rounded-md py-4 text-base font-bold text-primary transition-transform  ${
                    stopArm ? "bg-warn-strong text-primary" : "bg-danger-strong"
                  }`}
                >
                  {stopArm ? "한 번 더 눌러 종료" : "주행 종료"}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 개발자 옵션 — 주행 화면 왼쪽 "다름"·"비교" */}
        {driving && devOn && (
          <DevTools
            pos={navReady && navEng.current ? navPos : livePos}
            kmh={kmh}
            heading={navHeading}
            mode={navReady && navEng.current ? "nav" : "free"}
            compareOn={compareOn}
            onCompare={setCompareOn}
            top={navReady && navEng.current ? 300 : 220}
          />
        )}

        {/* G-Force — 오른쪽 가장자리 탭을 누르면 꺼내진다. 달리는 동안엔 탭도 숨긴다 */}
        {driving && gStopped && (
          <GForcePanel
            open={gOpen}
            onToggle={() => setGOpen((o) => !o)}
            g={gLive}
            peaks={gPeaks}
            zero50Sec={liveZ50}
            maxKmh={maxKmh}
            kmh={kmh}
            gpsEnv={gPeaks && gRecRef.current.env}
          />
        )}

        {/* 경로 옵션 선택 — 처음 탐색(4개) / 재탐색(2개) */}
        {routePick && (routePick.kind === "reroute" || !uxBlocked) && (
          <div
            data-map-block
            className={routePick.kind === "reroute"
              // 주행 중 재탐색: 화면 전체를 덮지 않는다(정책: 주행 중 전체 화면 팝업 금지).
              // 가운데 카드만 띄워 위 회전 안내·아래 속도 줄이 계속 보이게 한다.
              ? "pointer-events-none fixed inset-x-0 top-1/2 z-[80] flex -translate-y-1/2 justify-center px-4"
              : "fixed inset-0 z-[80] flex items-end justify-center bg-bg sm:items-center"}
            onClick={closeRoutePick}
          >
            <div
              onClick={(e) => e.stopPropagation()}
              className={routePick.kind === "reroute"
                ? "pointer-events-auto max-h-[45vh] w-full max-w-md overflow-y-auto rounded-md border border-line bg-panel p-5 shadow-lg"
                : "max-h-[92vh] w-full max-w-md overflow-y-auto rounded-t-lg border border-line bg-panel p-5 pb-8 sm:rounded-md"}
            >
              <h2 className="mb-1 text-lg font-bold text-primary">
                {routePick.kind === "initial" ? "경로 선택" : "재탐색"}
              </h2>
              {routePick.kind === "initial" && (
                <p className="mb-4 text-[13px] text-secondary">
                  {routePick.dest.name}
                </p>
              )}
              {routePick.kind === "initial" ? (
                (() => {
                  const dest = routePick.dest;
                  const cand = pickCands[pickMode];
                  return (
                    <div className="flex flex-col gap-3">
                      {/* 지도 미리보기 — OSM 타일(앱 WebView 호환) + 실시간 정체 색칠 */}
                      {cand ? (
                        <div className="flex flex-col gap-2">
                          <RouteMap
                            enc={cand.enc}
                            trafficSamples={cand.trafficSamples}
                            className="h-52"
                          />
                          <div className="flex items-center gap-2 px-1 text-[10px] text-secondary">
                            <span className="inline-flex items-center gap-1">
                              <span className="h-1.5 w-3 rounded-sm bg-danger-strong" />
                              정체
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <span className="h-1.5 w-3 rounded-sm bg-warn-strong" />
                              지체
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <span className="h-1.5 w-3 rounded-sm bg-warn-strong" />
                              서행
                            </span>
                            <span className="inline-flex items-center gap-1">
                              <span className="h-1.5 w-3 rounded-sm bg-ok-strong" />
                              원활
                            </span>
                          </div>
                        </div>
                      ) : destErr ? (
                        <div className="flex h-52 flex-col items-center justify-center gap-3 rounded-md border border-line bg-raised px-5 text-center">
                          <p className="text-[14px] text-warn">{destErr}</p>
                          <button
                            type="button"
                            onClick={() => loadCand(pickMode, dest)}
                            className="rounded-md bg-accent px-4 py-3 text-[14px] font-semibold text-primary"
                          >
                            다시 시도
                          </button>
                        </div>
                      ) : (
                        <div className="flex h-52 items-center justify-center rounded-md border border-line bg-raised">
                          <div className="h-7 w-7 animate-spin rounded-[50%] border-2 border-line border-t-accent" />
                        </div>
                      )}
                      {/* 옵션 4개 — 눌러본 것만 로드, 선택된 것 강조 */}
                      <div className="flex flex-col gap-2">
                        {NAV_MODES.map((m) => {
                          const c = pickCands[m.mode];
                          const sel = pickMode === m.mode;
                          const busy = pickLoading === m.mode;
                          return (
                            <button
                              key={m.mode}
                              type="button"
                              onClick={() => loadCand(m.mode, dest)}
                              className={`flex items-center gap-3 rounded-md border px-4 py-3 text-left transition-colors  ${
                                sel
                                  ? "border-accent bg-accent-surface"
                                  : "border-line bg-raised"
                              }`}
                            >
                              <span className="shrink-0">{m.icon}</span>
                              <span className="min-w-0 flex-1">
                                <span className="block text-[14px] font-bold text-primary">
                                  {m.label}
                                </span>
                                <span className="block truncate text-[11px] text-secondary">
                                  {m.desc}
                                </span>
                              </span>
                              {busy ? (
                                <span className="h-4 w-4 shrink-0 animate-spin rounded-[50%] border-2 border-line border-t-accent" />
                              ) : c ? (
                                <span
                                  role="button"
                                  tabIndex={0}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setPickShowDur((v) => !v);
                                  }}
                                  className="shrink-0 text-right text-[13px] font-semibold text-accent-text"
                                >
                                  {pickShowDur
                                    ? fmtEtaDur(c.durationSec)
                                    : fmtArrival(c.durationSec)}
                                  <span className="block text-[10px] font-normal text-secondary">
                                    {fmtM(c.distanceM)}
                                    {m.mode === "free" || (c.tollFare ?? 0) === 0
                                      ? ""
                                      : ` (통행료 ${c.tollFare!.toLocaleString()}원)`}
                                  </span>
                                </span>
                              ) : (
                                <span className="shrink-0 text-[11px] text-disabled">
                                  경로 확인
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                      <button
                        type="button"
                        disabled={!cand}
                        onClick={() => startPickedNav(dest)}
                        className="mt-1 w-full rounded-md bg-accent py-4 text-[15px] font-bold text-primary transition-transform disabled:opacity-40"
                      >
                        이 경로로 안내 시작
                      </button>
                    </div>
                  );
                })()
              ) : (
                <div className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => runReroute("keep")}
                    className="flex flex-col items-start gap-1 rounded-md border border-line bg-raised p-4 text-left transition-transform"
                  >
                    <span className="text-[15px] font-bold text-primary">
                      원래 가던 길로
                    </span>
                    <span className="text-[12px] text-secondary">
                      선택한 코스로 복귀
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => runReroute("time")}
                    className="flex flex-col items-start gap-1 rounded-md border border-line bg-raised p-4 text-left transition-transform"
                  >
                    <span className="text-[15px] font-bold text-primary">
                      최단시간으로
                    </span>
                    <span className="text-[12px] text-secondary">
                      원래 코스를 버리고 목적지까지 가장 빠르게
                    </span>
                  </button>
                </div>
              )}
              <button
                type="button"
                onClick={closeRoutePick}
                className="mt-4 w-full rounded-md bg-raised py-3 text-sm font-semibold text-secondary"
              >
                닫기
              </button>
            </div>
          </div>
        )}

        {phase === "done" && summary && (
          <div className="flex flex-1 flex-col justify-center gap-4 py-8">
            <h2 className="text-center text-xl font-bold">
              {"주행 완료"}
            </h2>
            {summary.startAddr && (
              <p className="text-center text-xs text-secondary">
                {summary.startAddr}
                {summary.endAddr && summary.endAddr !== summary.startAddr
                  ? ` – ${summary.endAddr}`
                  : ""}
              </p>
            )}
            {summary.path && <RouteMap enc={summary.path} className="h-52" />}
            {/* 플래너 코스로 달렸으면 예상 vs 실제 — 단, 실제로 달린(100m 이상)
                기록만. 0km·수십초짜리 유령 주행에서 "-4:27:54" 같은 무의미한
                음수 델타가 뜨던 문제(스샷 25)를 막는다. */}
            {summary.courseLabel && summary.planSec && summary.distanceM >= 100 && (
              <div className="rounded-md border border-ok bg-ok-surface p-4">
                <p className="truncate text-xs font-semibold text-ok">
                  {cleanLabel(summary.courseLabel)}
                </p>
                <div className="mt-2 space-y-1 text-sm">
                  <div className="flex items-baseline justify-between">
                    <span className="text-secondary">시간</span>
                    <span>
                      {fmtDur(summary.planSec)}
                      <span className="mx-2 text-disabled">–</span>
                      <b>{fmtDur((summary.endTs - summary.startTs) / 1000)}</b>
                      <span
                        className={`ml-2 text-xs ${
                          (summary.endTs - summary.startTs) / 1000 <=
                          summary.planSec
                            ? "text-ok"
                            : "text-warn"
                        }`}
                      >
                        {(summary.endTs - summary.startTs) / 1000 <=
                        summary.planSec
                          ? "-"
                          : "+"}
                        {fmtDur(
                          Math.abs(
                            (summary.endTs - summary.startTs) / 1000 -
                              summary.planSec,
                          ),
                        )}
                      </span>
                    </span>
                  </div>
                  <div className="flex items-baseline justify-between">
                    <span className="text-secondary">거리</span>
                    <span>
                      {((summary.planM ?? 0) / 1000).toFixed(0)}km
                      <span className="mx-2 text-disabled">–</span>
                      <b>{(summary.distanceM / 1000).toFixed(1)}km</b>
                    </span>
                  </div>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              {[
                ["이동거리", `${(summary.distanceM / 1000).toFixed(1)}km`],
                ["총 시간", fmtDur((summary.endTs - summary.startTs) / 1000)],
                ["최고 속도", fmtSpeed(summary.maxKmh, summary.mode)],
                ["평균 속도", fmtSpeed(summary.avgKmh, summary.mode)],
              ].map(([label, v]) => (
                <div
                  key={label}
                  className="rounded-md bg-panel p-4 text-center"
                >
                  <div className="text-2xl font-bold tabular-nums">{v}</div>
                  <div className="mt-1 text-xs text-secondary">{label}</div>
                </div>
              ))}
            </div>
            {recordSkipped ? (
              <p className="text-center text-xs text-secondary">
                내비 주행 자동 기록이 꺼져 있어 저장 안 함
              </p>
            ) : (
              summary.distanceM < 100 && (
                <p className="text-center text-xs text-secondary">
                  100m 미만이라 기록엔 저장 안 했어요
                </p>
              )
            )}
            <button
              type="button"
              onClick={() => start(undefined, "car")}
              className="mt-2 w-full rounded-md bg-ok-strong py-4 text-lg font-bold text-primary transition-transform"
            >
              새 주행 시작
            </button>
            <button
              type="button"
              onClick={() => {
                setPhase("idle");
              }}
              className="w-full rounded-md bg-raised py-3 text-sm font-medium text-secondary"
            >
              기록 목록으로
            </button>
          </div>
        )}

        {/* 주행 중(차량 UX 제한)에는 한 번 누르는 시작 버튼만 */}
        {uxBlocked && (
          <div data-ux-restricted className="flex flex-1 flex-col justify-center gap-3 py-8">
            <p className="text-center text-sm text-secondary">주행 중에는 쓸 수 없어요</p>
            {recoveryPending ? (
              <button type="button" disabled className="w-full rounded-md bg-accent py-4 text-[15px] font-semibold text-primary">
                기록 복구 중…
              </button>
            ) : (
              <>
                {plan && (
                  <button type="button" onClick={() => start()}
                    className="flex w-full items-center justify-center gap-3 rounded-md bg-accent py-4 text-[15px] font-semibold text-primary">
                    <IconPlay className="h-5 w-5" />
                    <span className="truncate">코스 주행 시작 ({cleanLabel(plan.label)})</span>
                  </button>
                )}
                <button type="button" onClick={() => start(undefined, "car", false, { recordingOnly: true })}
                  className={`flex w-full items-center justify-center gap-3 rounded-md py-4 text-[15px] font-semibold text-primary ${plan ? "border border-line bg-raised" : "bg-accent"}`}>
                  <IconPlay className="h-5 w-5" />
                  {abroad ? "해외 기록 시작" : "기록만 시작"}
                </button>
              </>
            )}
            {gpsErr && <p className="text-center text-xs text-warn">{gpsErr}</p>}
          </div>
        )}

        {phase === "idle" && (
          <div data-idle-content className="flex flex-1 flex-col pb-28 pt-6" style={uxBlocked ? { display: "none" } : undefined}>
            {tab === "course" && (
            <div data-course-home className="flex flex-col gap-7">
              <div className="flex flex-col gap-5">
                <div className="min-w-0">
                <Planner
                  embedded
                  restricted={uxBlocked}
                  userKey={user?.hash}
                  onDrive={(p) => {
                    // "이 코스로 주행" — 선택한 코스의 주행 안내를 바로 시작
                    const planWithTs = { ...p, ts: Date.now() };
                    beginGuided(planWithTs, { onAccepted: () => {
                      setPlan(planWithTs);
                      setTab("course");
                      window.scrollTo({ top: 0, behavior: "auto" });
                    } });
                  }}
                />
                </div>
                <section data-home-drive-actions aria-label="주행 시작" className="rounded-md border border-line bg-raised p-4">
                  <h2 className="mb-4 text-base font-semibold text-primary">바로 주행</h2>
            {/* 주요 동작 — 하나의 흰색 primary + 고스트 secondary */}
            <div className="flex flex-col gap-3">
              {recoveryPending ? (
                <button type="button" disabled className="w-full rounded-md bg-accent py-4 text-[15px] font-semibold text-primary">
                  기록 복구 중…
                </button>
              ) : plan ? (
                <button type="button" onClick={() => start()}
                  className="flex w-full items-center justify-center gap-3 rounded-md bg-accent py-4 text-[15px] font-semibold text-primary">
                  <IconPlay className="h-5 w-5" />
                  코스 주행 시작
                </button>
              ) : (
                <button type="button" onClick={() => start(undefined, "car", false, { recordingOnly: true })}
                  className="flex w-full items-center justify-center gap-3 rounded-md border border-line bg-raised py-4 text-[15px] font-semibold text-primary">
                  <IconPlay className="h-5 w-5" />
                  {abroad ? "해외 기록 시작" : "기록만 시작"}
                </button>
              )}
              {gpsErr && (
                <div className="flex items-center justify-center gap-2">
                  <p className="text-xs text-warn">{gpsErr}</p>
                  {(gpsErr.includes("거부") || gpsErr.includes("필요")) && (
                    <button
                      type="button"
                      onClick={retryGps}
                      className="rounded-sm bg-warn-surface px-3 py-1 text-xs font-semibold text-warn"
                    >
                      다시 시도
                    </button>
                  )}
                </div>
              )}
            </div>
                </section>
              </div>
            {/* 현대 내비의 단속·도착 안내는 이 앱이 안내 주인일 때만 */}
            {routeGuideShown && <PleosSafetyCard />}
            <PleosVehicleCard />
            {/* 최근 코스 — 경로가 있는 지난 주행을 카드 카러셀로. 탭하면 다시 주행 */}
            {carRecords.some((r) => r.path) && (
              <div>
                <p className="mb-2 px-1 text-[11px] font-medium uppercase tracking-wide text-secondary">
                  최근 코스
                </p>
                <div className="-mx-6 overflow-x-auto px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                  <div className="flex gap-3">
                    {carRecords
                      .filter((r) => r.path)
                      .slice(0, 8)
                      .map((r) => (
                        <button
                          key={r.id}
                          type="button"
                          onClick={() => setTripDetail(r)}
                          className="w-60 shrink-0 overflow-hidden rounded-md border border-line bg-raised text-left transition-colors"
                        >
                          <RouteMap enc={r.path!} className="h-32" modeToggle={false} />
                          <div className="px-4 py-3">
                            <p className="truncate text-[14px] font-semibold text-primary">
                              {(r.courseLabel != null ? cleanLabel(r.courseLabel) : undefined) ??
                                r.startAddr ??
                                `${(r.distanceM / 1000).toFixed(1)}km 주행`}
                            </p>
                            <p className="mt-1 text-[12px] tabular-nums text-secondary">
                              {(r.distanceM / 1000).toFixed(1)}km ·{" "}
                              {fmtDur((r.endTs - r.startTs) / 1000)}
                            </p>
                          </div>
                        </button>
                      ))}
                  </div>
                </div>
              </div>
            )}
            {/* 플래너에서 넘어온 예정 코스 — 주행 시작하면 기록에 물린다 */}
            {plan && (
              <div className="flex items-center gap-3 rounded-md border border-line bg-raised px-4 py-4">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-primary">
                    {cleanLabel(plan.label)}
                  </p>
                  <p className="mt-1 text-[12px] text-secondary">
                    예상 총 {fmtDur(plan.durationSec)} ·{" "}
                    {(plan.distanceM / 1000).toFixed(0)}km
                    {plan.path ? " (음성 안내)" : ""}
                  </p>
                  <DwellSchedule vias={plan.vias} className="mt-2" />
                </div>
                <button
                  type="button"
                  onClick={clearPlan}
                  aria-label="예정 코스 해제"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-sm text-secondary transition-colors hover:bg-raised hover:text-primary"
                >
                  <IconClose className="h-4 w-4" />
                </button>
              </div>
            )}

            {plan?.path && !carBuild && (
              <button
                type="button"
                onClick={() => {
                  setGasMode("route");
                  setTab("gas");
                }}
                className="flex items-center gap-3 rounded-md border border-line bg-raised px-4 py-3 text-left transition-colors"
              >
                <span className="grid h-9 w-9 shrink-0 place-items-center rounded-md bg-accent-surface text-accent-text">
                  <IconFuel className="h-[18px] w-[18px]" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-semibold text-primary">
                    가는 길 주유소
                  </span>
                  <span className="block text-[12px] text-secondary">
                    이 코스 경로의 주유소를 최저가순으로
                  </span>
                </span>
                <IconChevronRight className="h-4 w-4 shrink-0 text-disabled" />
              </button>
            )}


            </div>
            )}

            {!uxBlocked && tab === "places" && (
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => setTab("profile")}
                  className="-ml-2 mb-1 flex items-center gap-1 self-start rounded-sm py-1 pl-2 pr-3 text-[13px] font-medium text-secondary transition-colors hover:text-primary"
                >
                  <IconArrowLeft className="h-4 w-4" />
                  프로필
                </button>
                {placesLoading && placeList === null && (
                  <>
                    {[0, 1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className="h-[68px] animate-pulse rounded-md bg-raised"
                      />
                    ))}
                  </>
                )}
                {placesError && !placesLoading && (
                  <div className="flex flex-col items-center gap-4 py-24 text-center">
                    <span className="grid h-14 w-14 place-items-center rounded-md bg-raised text-disabled">
                      <IconPin className="h-7 w-7" />
                    </span>
                    <p className="text-[13px] leading-relaxed text-secondary">
                      명소를 불러오지 못했어요.
                    </p>
                    <button
                      type="button"
                      onClick={() => setPlacesError(false)}
                      className="rounded-sm bg-raised px-4 py-2 text-[13px] font-medium text-secondary transition-colors"
                    >
                      다시 시도
                    </button>
                  </div>
                )}
                {!placesError && placeList !== null && placeList.length === 0 && (
                  <div className="flex flex-col items-center gap-4 py-24 text-center">
                    <span className="grid h-14 w-14 place-items-center rounded-md bg-raised text-disabled">
                      <IconPin className="h-7 w-7" />
                    </span>
                    <p className="text-[13px] leading-relaxed text-secondary">
                      근처에서 찾은 명소가 없어요.
                      <br />
                      위치 권한을 켜고 다시 열어보세요.
                    </p>
                  </div>
                )}
                {placeList?.map((p, i) => (
                  <button
                    key={`${p.name}|${i}`}
                    type="button"
                    onClick={() =>
                      startNavTo({
                        name: p.name,
                        lat: p.coord.lat,
                        lng: p.coord.lng,
                      })
                    }
                    className="flex items-center gap-4 rounded-md border border-line bg-raised px-4 py-3 text-left transition-colors"
                  >
                    <span className="grid h-11 w-11 shrink-0 place-items-center rounded-md bg-accent-surface text-accent-text">
                      <IconPin className="h-[22px] w-[22px]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-semibold text-primary">
                        {p.name}
                      </span>
                      {p.rating != null && (p.ratingCount ?? 0) >= 5 ? (
                        <span className="mt-1 flex items-center gap-2 truncate text-[12px]">
                          <span className="font-semibold text-warn">
                            평점 {p.rating.toFixed(1)}
                          </span>
                          <span className="tabular-nums text-secondary">
                            후기 {p.ratingCount?.toLocaleString()}
                          </span>
                          {p.type && (
                            <span className="text-disabled">({p.type})</span>
                          )}
                        </span>
                      ) : (
                        <span className="block truncate text-[12px] text-secondary">
                          {p.type ? `${p.type} ` : ""}
                          {p.address}
                        </span>
                      )}
                    </span>
                    {p.distanceM != null && (
                      <span className="shrink-0 text-[13px] font-medium tabular-nums text-secondary">
                        {fmtM(p.distanceM)}
                      </span>
                    )}
                    <IconChevronRight className="h-4 w-4 shrink-0 text-disabled" />
                  </button>
                ))}
              </div>
            )}

            {!uxBlocked && tab === "gas" && !carBuild && (
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => setTab("profile")}
                  className="-ml-2 mb-1 flex items-center gap-1 self-start rounded-sm py-1 pl-2 pr-3 text-[13px] font-medium text-secondary transition-colors hover:text-primary"
                >
                  <IconArrowLeft className="h-4 w-4" />
                  프로필
                </button>
                {/* 범위 — 내 주변 / 가는 길(현재 코스가 있을 때만) */}
                {plan?.path && (
                  <div className="inline-flex self-start rounded-md bg-raised p-1 ring-1 ring-inset ring-line">
                    {(
                      [
                        ["near", "내 주변"],
                        ["route", "가는 길"],
                      ] as ["near" | "route", string][]
                    ).map(([m, label]) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => {
                          setGasMode(m);
                          setGasList(null);
                        }}
                        className={`rounded-md px-4 py-2 text-[13px] font-semibold transition-colors ${
                          gasMode === m
                            ? "bg-accent text-primary"
                            : "bg-raised text-secondary ring-1 ring-inset ring-line hover:text-primary"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
                {/* 유종 · 정렬 토글 */}
                <div className="flex flex-wrap items-center gap-2">
                  <div className="inline-flex rounded-md bg-raised p-1 ring-1 ring-inset ring-line">
                    {(
                      [
                        ["gasoline", "휘발유"],
                        ["diesel", "경유"],
                      ] as ["gasoline" | "diesel", string][]
                    ).map(([f, label]) => (
                      <button
                        key={f}
                        type="button"
                        onClick={() => {
                          setGasFuel(f);
                          setGasList(null);
                        }}
                        className={`rounded-md px-4 py-2 text-[13px] font-semibold transition-colors ${
                          gasFuel === f
                            ? "bg-accent text-primary"
                            : "bg-raised text-secondary ring-1 ring-inset ring-line hover:text-primary"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <div className="inline-flex rounded-md bg-raised p-1 ring-1 ring-inset ring-line">
                    {(
                      [
                        ["price", "최저가순"],
                        ["distance", "가까운순"],
                      ] as ["price" | "distance", string][]
                    ).map(([skey, label]) => (
                      <button
                        key={skey}
                        type="button"
                        onClick={() => {
                          setGasSort(skey);
                          setGasList(null);
                        }}
                        className={`rounded-md px-4 py-2 text-[13px] font-semibold transition-colors ${
                          gasSort === skey
                            ? "bg-accent text-primary"
                            : "bg-raised text-secondary ring-1 ring-inset ring-line hover:text-primary"
                        }`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                </div>

                {gasLoading && gasList === null && (
                  <div className="flex flex-col gap-3 pt-1">
                    {[0, 1, 2, 3, 4].map((i) => (
                      <div
                        key={i}
                        className="h-[60px] animate-pulse rounded-md bg-raised"
                      />
                    ))}
                  </div>
                )}
                {gasError && !gasLoading && (
                  <div className="flex flex-col items-center gap-3 py-16 text-center">
                    <p className="text-[13px] leading-relaxed text-secondary">
                      주유소 정보를 불러오지 못했어요.
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        setGasError(false);
                        setGasList(null);
                        setGasReload((n) => n + 1); // 조회 이펙트 재실행 트리거
                      }}
                      className="rounded-sm bg-raised px-4 py-2 text-[13px] font-medium text-secondary transition-colors"
                    >
                      다시 시도
                    </button>
                  </div>
                )}
                {!gasError && gasList !== null && gasList.length === 0 && (
                  <p className="py-16 text-center text-[13px] leading-relaxed text-secondary">
                    근처 주유소를 못 찾았어요.
                    <br />
                    위치 권한을 켜고 다시 열어보세요.
                  </p>
                )}
                {!gasError && gasList?.map((s, i) => (
                  <div
                    key={s.id}
                    className={`flex items-center gap-2 rounded-md border px-4 py-3 transition-colors ${
                      i === 0 && gasSort === "price"
                        ? "border-accent bg-accent-surface"
                        : "border-line bg-raised"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() =>
                        startNavTo({
                          name: s.name,
                          lat: s.coord.lat,
                          lng: s.coord.lng,
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-3 text-left"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[15px] font-semibold text-primary">
                          {s.name}
                        </span>
                        <span className="block truncate text-[12px] text-secondary">
                          {s.brand} ·{" "}
                          {s.offM != null
                            ? `경로에서 ${fmtM(s.offM)}`
                            : fmtM(s.distanceM)}
                        </span>
                      </span>
                      <span
                        className={`shrink-0 text-[17px] font-bold tabular-nums ${
                          i === 0 && gasSort === "price"
                            ? "text-accent-text"
                            : "text-primary"
                        }`}
                      >
                        {s.price.toLocaleString()}
                        <span className="ml-1 text-[11px] font-normal text-secondary">
                          원
                        </span>
                      </span>
                    </button>
                    {plan?.path && (
                      <button
                        type="button"
                        onClick={() =>
                          addGasVia({
                            name: s.name,
                            lat: s.coord.lat,
                            lng: s.coord.lng,
                          })
                        }
                        disabled={gasViaBusy !== null}
                        className="shrink-0 rounded-sm bg-accent px-3 py-2 text-[12px] font-semibold text-primary transition-colors disabled:opacity-50"
                      >
                        {gasViaBusy === s.name ? "…" : "경유"}
                      </button>
                    )}
                  </div>
                ))}
                {gasList && gasList.length > 0 && (
                  <p className="pt-1 text-center text-[11px] text-disabled">
                    오피넷 기준
                  </p>
                )}
              </div>
            )}

            {!uxBlocked && tab === "conquest" &&
              (() => {
                const driven = records.filter((r) => r.path && (r.mode == null || r.mode === "car"));
                const totalKm =
                  driven.reduce((s, r) => s + r.distanceM, 0) / 1000;
                return (
                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={() => setTab("profile")}
                      className="-ml-2 mb-1 flex items-center gap-1 self-start rounded-sm py-1 pl-2 pr-3 text-[13px] font-medium text-secondary transition-colors hover:text-primary"
                    >
                      <IconArrowLeft className="h-4 w-4" />
                      프로필
                    </button>
                    <RouteMap
                      paths={driven.map((r) => r.path!)}
                      className="h-[460px]"
                      interactive
                      trafficToggle
                      dongFills={conquestDongs}
                    />
                    {conquestDongs.length > 0 && (
                      <div className="flex items-center justify-between rounded-md border border-line px-4 py-4">
                        <span className="inline-flex items-center gap-2 text-[13px] text-secondary">
                          <span className="h-3 w-4 rounded-sm bg-accent-surface ring-1 ring-accent" />
                          지나간 동
                        </span>
                        <span className="text-[15px] font-bold text-primary">
                          {conquestDongs.length}
                          <span className="ml-1 text-[12px] font-normal text-secondary">
                            개 정복
                          </span>
                        </span>
                      </div>
                    )}
                    <div className="grid grid-cols-2 divide-x divide-line rounded-md border border-line py-4">
                      <div className="px-1 text-center">
                        <div className="text-[22px] font-bold tabular-nums text-primary">
                          {driven.length}
                          <span className="ml-1 text-xs font-normal text-secondary">
                            개
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-secondary">
                          달린 코스
                        </div>
                      </div>
                      <div className="px-1 text-center">
                        <div className="text-[22px] font-bold tabular-nums text-primary">
                          {totalKm.toFixed(0)}
                          <span className="ml-1 text-xs font-normal text-secondary">
                            km
                          </span>
                        </div>
                        <div className="mt-1 text-[11px] text-secondary">
                          총 거리
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}

            {!uxBlocked && tab === "profile" && (
            <div className="flex flex-col gap-7">
              {/* 프로필 헤더 — 아바타·아이디·설정 */}
              <div className="relative flex flex-col items-center gap-3 pt-2">
                <span className="grid h-20 w-20 place-items-center rounded-sm bg-raised text-secondary ring-1 ring-inset ring-line">
                  <IconUser className="h-9 w-9" />
                </span>
                <p className="text-lg font-semibold text-primary">{user.name}</p>
                <p className="text-[12px] text-secondary">{user.vinHash ? "이 차량으로 로그인" : "이 기기로 로그인"}</p>
              </div>

            {/* 통계 대시보드 — 이번 달 + 월별 그래프 + 스탯 벤토 */}
            {carRecords.length > 0 &&
              (() => {
                const now = new Date();
                const months = Array.from({ length: 6 }, (_, k) => {
                  const d = new Date(now.getFullYear(), now.getMonth() - 5 + k, 1);
                  return { y: d.getFullYear(), m: d.getMonth(), km: 0 };
                });
                let totalMoving = 0;
                let totalSec = 0;
                let maxSpeed = 0;
                let totalM = 0;
                for (const r of carRecords) {
                  totalM += r.distanceM;
                  totalMoving += r.movingSec || 0;
                  totalSec += (r.endTs - r.startTs) / 1000;
                  maxSpeed = Math.max(maxSpeed, r.maxKmh);
                  const d = new Date(r.startTs);
                  const idx = months.findIndex(
                    (mm) => mm.y === d.getFullYear() && mm.m === d.getMonth(),
                  );
                  if (idx >= 0) months[idx].km += r.distanceM / 1000;
                }
                const totalKm = totalM / 1000;
                const stoppedSec = Math.max(0, totalSec - totalMoving);
                const avgAll =
                  totalMoving > 0
                    ? Math.round(totalKm / (totalMoving / 3600))
                    : 0;
                const thisMo = months[5].km;
                const lastMo = months[4].km;
                const pct =
                  lastMo > 0 ? Math.round(((thisMo - lastMo) / lastMo) * 100) : null;
                const maxKm = Math.max(...months.map((mm) => mm.km), 1);
                const W = 320,
                  H = 88,
                  pad = 6;
                const xs = (i: number) => pad + (i / 5) * (W - pad * 2);
                const ys = (km: number) =>
                  H - 8 - (km / maxKm) * (H - 20);
                const line = months
                  .map((mm, i) => `${i === 0 ? "M" : "L"}${xs(i)} ${ys(mm.km)}`)
                  .join(" ");
                const area = `${line} L${xs(5)} ${H} L${xs(0)} ${H} Z`;
                const stats: {
                  Icon: typeof IconNav;
                  color: string;
                  label: string;
                  val: string;
                  unit: string;
                }[] = [
                  { Icon: IconNav, color: "text-accent-text", label: "총 거리", val: totalKm.toFixed(1), unit: "km" },
                  { Icon: IconClock, color: "text-warn", label: "총 시간", val: fmtDur(totalSec), unit: "" },
                  { Icon: IconPause, color: "text-accent-text", label: "정지 시간", val: fmtDur(stoppedSec), unit: "" },
                  { Icon: IconCompass, color: "text-ok", label: "주행 횟수", val: String(carRecords.length), unit: "회" },
                  { Icon: IconGauge, color: "text-warn", label: "평균 속도", val: String(avgAll), unit: "km/h" },
                  { Icon: IconBolt, color: "text-danger", label: "최고 속도", val: String(maxSpeed), unit: "km/h" },
                  // 내 최고 제로백 — 차 기록 중 가장 빠른 0–100 / 0–50
                  ...(([["zero100Sec", "최고 제로백 0–100"], ["zero50Sec", "최고 0–50"]] as const).flatMap(
                    ([k, label]) => {
                      const best = Math.min(
                        ...carRecords.map((r) => r[k] ?? Infinity),
                      );
                      return Number.isFinite(best)
                        ? [{ Icon: IconBolt, color: "text-warn", label, val: best.toFixed(1), unit: "초" }]
                        : [];
                    },
                  )),
                ];
                return (
                  <div className="flex flex-col gap-3">
                    {/* 이번 달 카드 + 월별 그래프 */}
                    <div className="rounded-md border border-line bg-raised p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <p className="text-[12px] text-secondary">이번 달</p>
                          <p className="mt-1 text-[26px] font-bold leading-none tabular-nums text-primary">
                            {thisMo.toFixed(1)}
                            <span className="ml-1 text-[13px] font-normal text-secondary">
                              km
                            </span>
                          </p>
                        </div>
                        {pct !== null && (
                          <div className="text-right">
                            <p
                              className={`text-[13px] font-bold tabular-nums ${
                                pct >= 0 ? "text-ok" : "text-danger"
                              }`}
                            >
                              {pct >= 0 ? "+" : "−"} {Math.abs(pct)}%
                            </p>
                            <p className="text-[11px] text-disabled">
                              지난달 대비
                            </p>
                          </div>
                        )}
                      </div>
                      <svg
                        viewBox={`0 0 ${W} ${H}`}
                        preserveAspectRatio="none"
                        className="mt-3 h-20 w-full"
                      >
                        <defs>
                          <linearGradient id="mchart" x1="0" y1="0" x2="0" y2="1">
                            <stop offset="0%" stopColor="#34d399" stopOpacity="0.28" />
                            <stop offset="100%" stopColor="#34d399" stopOpacity="0" />
                          </linearGradient>
                        </defs>
                        <path d={area} fill="url(#mchart)" />
                        <path
                          d={line}
                          fill="none"
                          stroke="#34d399"
                          strokeWidth="2"
                          strokeLinejoin="round"
                          strokeLinecap="round"
                          vectorEffect="non-scaling-stroke"
                        />
                        <circle cx={xs(5)} cy={ys(months[5].km)} r="3.5" fill="#34d399" />
                      </svg>
                      <div className="mt-1 flex justify-between px-1 text-[10px] text-disabled">
                        {months.map((mm, i) => (
                          <span key={i}>{mm.m + 1}월</span>
                        ))}
                      </div>
                    </div>
                    {/* 스탯 벤토 */}
                    <div className="grid grid-cols-2 gap-3">
                      {stats.map(({ Icon, color, label, val, unit }) => (
                        <div
                          key={label}
                          className="rounded-md border border-line bg-raised p-4"
                        >
                          <Icon className={`h-5 w-5 ${color}`} />
                          <div className="mt-3 text-[13px] text-secondary">
                            {label}
                          </div>
                          <div className="mt-1 text-[19px] font-bold tabular-nums text-primary">
                            {val}
                            {unit && (
                              <span className="ml-1 text-[12px] font-normal text-secondary">
                                {unit}
                              </span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })()}

            <div className="divide-y divide-line overflow-hidden rounded-md border border-line">

              <button
                type="button"
                onClick={() => {
                  setDeleteConfirm(false);
                  setSettingsOpen(true);
                }}
                className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-raised"
              >
                <IconSettings className="h-[18px] w-[18px] shrink-0 text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-primary">
                    설정
                  </span>
                </span>
                <IconChevronRight className="h-4 w-4 shrink-0 text-disabled" />
              </button>
              <button
                type="button"
                onClick={() => setTab("places")}
                className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-raised"
              >
                <IconPin className="h-[18px] w-[18px] shrink-0 text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-primary">
                    근처 장소
                  </span>
                </span>
                <IconChevronRight className="h-4 w-4 shrink-0 text-disabled" />
              </button>
              {/* Pleos 정책: 개인정보 처리방침을 앱 안에서 볼 수 있어야 한다 */}
              <button
                type="button"
                onClick={() => location.assign(withBasePath("/privacy"))}
                className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-raised"
              >
                <IconUser className="h-[18px] w-[18px] shrink-0 text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-primary">
                    개인정보 처리방침
                  </span>
                </span>
                <IconChevronRight className="h-4 w-4 shrink-0 text-disabled" />
              </button>
              {!carBuild && (
              <button
                type="button"
                onClick={() => {
                  setGasMode("near");
                  setGasList(null);
                  setTab("gas");
                }}
                className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-raised"
              >
                <IconFuel className="h-[18px] w-[18px] shrink-0 text-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[14px] font-medium text-primary">
                    주변 주유소
                  </span>
                </span>
                <IconChevronRight className="h-4 w-4 shrink-0 text-disabled" />
              </button>
              )}
              {carRecords.some((r) => r.path) && (
                <button
                  type="button"
                  onClick={() => setTab("conquest")}
                  className="flex w-full items-center gap-3 px-4 py-4 text-left transition-colors hover:bg-raised"
                >
                  <IconMap className="h-[18px] w-[18px] shrink-0 text-secondary" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[14px] font-medium text-primary">
                      내가 달린 지도
                    </span>
                  </span>
                  <IconChevronRight className="h-4 w-4 shrink-0 text-disabled" />
                </button>
              )}
            </div>
            {settingsOpen && (
              <div data-map-block className="fixed inset-0 z-[70] overflow-y-auto bg-bg">
                <div className="mx-auto flex w-full log-content-width flex-col gap-4 px-6 py-8">
                  <div className="flex items-center justify-between">
                    <button
                      type="button"
                      onClick={() => setSettingsOpen(false)}
                      className="-ml-2 flex items-center gap-1 rounded-sm py-1 pl-2 pr-3 text-[13px] font-medium text-secondary transition-colors hover:text-primary"
                    >
                      <IconArrowLeft className="h-4 w-4" />
                      프로필
                    </button>
                    <h2 className="text-[15px] font-semibold text-primary">설정</h2>
                    <span className="w-14" />
                  </div>
                  <div className="divide-y divide-line overflow-hidden rounded-md border border-line">
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-primary">
                    자동 기록 (코스 안내 주행)
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="자동 기록"
                  aria-checked={navRecordOn}
                  onClick={() =>
                    setNavRecordOn((v) => {
                      try {
                        localStorage.setItem(
                          "drivelog-nav-record-v1",
                          v ? "off" : "on",
                        );
                      } catch {}
                      return !v;
                    })
                  }
                  className={`relative h-[30px] w-[50px] shrink-0 rounded-sm transition-colors ${
                    navRecordOn ? "bg-accent" : "bg-raised ring-1 ring-inset ring-line"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-6 w-6 rounded-sm bg-signal transition-all ${
                      navRecordOn ? "left-[23px]" : "left-[3px]"
                    }`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-primary">
                    자동 기록 시작 (출발 감지)
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="자동 기록 시작"
                  aria-checked={autoStartOn}
                  onClick={() =>
                    setAutoStartOn((v) => {
                      try {
                        localStorage.setItem(
                          "drivelog-auto-start-v1",
                          v ? "off" : "on",
                        );
                      } catch {}
                      return !v;
                    })
                  }
                  className={`relative h-[30px] w-[50px] shrink-0 rounded-sm transition-colors ${
                    autoStartOn ? "bg-accent" : "bg-raised ring-1 ring-inset ring-line"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-6 w-6 rounded-sm bg-signal transition-all ${
                      autoStartOn ? "left-[23px]" : "left-[3px]"
                    }`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-primary">
                    자동 일시중지 (5분 정차)
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="자동 일시중지"
                  aria-checked={autoPauseOn}
                  onClick={() =>
                    setAutoPauseOn((v) => {
                      try {
                        localStorage.setItem(
                          "drivelog-auto-pause-v1",
                          v ? "off" : "on",
                        );
                      } catch {}
                      return !v;
                    })
                  }
                  className={`relative h-[30px] w-[50px] shrink-0 rounded-sm transition-colors ${
                    autoPauseOn ? "bg-accent" : "bg-raised ring-1 ring-inset ring-line"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-6 w-6 rounded-sm bg-signal transition-all ${
                      autoPauseOn ? "left-[23px]" : "left-[3px]"
                    }`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-primary">
                    기록 주행 카메라 경고
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="기록 주행 카메라 경고"
                  aria-checked={camWarnOn}
                  onClick={() =>
                    setCamWarnOn((v) => {
                      try {
                        localStorage.setItem(
                          "drivelog-cam-warn-v1",
                          v ? "off" : "on",
                        );
                      } catch {}
                      return !v;
                    })
                  }
                  className={`relative h-[30px] w-[50px] shrink-0 rounded-sm transition-colors ${
                    camWarnOn ? "bg-accent" : "bg-raised ring-1 ring-inset ring-line"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-6 w-6 rounded-sm bg-signal transition-all ${
                      camWarnOn ? "left-[23px]" : "left-[3px]"
                    }`}
                  />
                </button>
              </div>
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-primary">
                    오프라인 지도
                  </p>
                  <p className="mt-1 text-[12px] leading-snug text-secondary">
                    {!offlineDL
                      ? ""
                      : "saved" in offlineDL
                        ? offlineDL.saved >= offlineDL.total
                          ? " (저장됨)"
                          : offlineDL.saved === 0
                            ? " (저장 실패)"
                            : ` (일부만 저장 ${offlineDL.saved}/${offlineDL.total})`
                        : offlineDL.total
                          ? ` (저장 중 ${Math.round((offlineDL.done / offlineDL.total) * 100)}%)`
                          : " (계산 중)"}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="오프라인 지도 저장"
                  aria-checked={offlineAutoOn}
                  onClick={() =>
                    setOfflineAutoOn((v) => {
                      try {
                        localStorage.setItem(
                          "drivelog-offline-auto-v1",
                          v ? "off" : "on",
                        );
                      } catch {}
                      return !v;
                    })
                  }
                  className={`relative h-[30px] w-[50px] shrink-0 rounded-sm transition-colors ${
                    offlineAutoOn ? "bg-accent" : "bg-raised ring-1 ring-inset ring-line"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-6 w-6 rounded-sm bg-signal transition-all ${
                      offlineAutoOn ? "left-[23px]" : "left-[3px]"
                    }`}
                  />
                </button>
              </div>
              {rawLogOn !== null && (
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-primary">
                    테스트: 센서 원본 기록
                  </p>
                  <p className="mt-1 text-[12px] leading-snug text-secondary">
                    (시간당 약 5 MB 전송)
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="센서 원본 기록"
                  aria-checked={rawLogOn}
                  onClick={() => {
                    const next = !rawLogOn;
                    window.DriveNative?.setRawLog?.(next);
                    setRawLogOn(next);
                  }}
                  className={`relative h-[30px] w-[50px] shrink-0 rounded-sm transition-colors ${
                    rawLogOn ? "bg-accent" : "bg-raised ring-1 ring-inset ring-line"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-6 w-6 rounded-sm bg-signal transition-all ${
                      rawLogOn ? "left-[23px]" : "left-[3px]"
                    }`}
                  />
                </button>
              </div>
              )}
              {!BORROW_SERVER && (
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-primary">개발자 옵션</p>
                  <p className="mt-1 text-[12px] leading-snug text-secondary">
                    {devOn
                      ? `기록 전송 중 · ${devStats.sent}줄 · 다름 ${devStats.marks}`
                      : "(판정 기록 전송)"}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-label="개발자 옵션"
                  aria-checked={devOn}
                  onClick={() => {
                    const next = !devOn;
                    setDevMode(next);
                    setDevOn(next);
                    if (!next) setCompareOn(false);
                  }}
                  className={`relative h-[30px] w-[50px] shrink-0 rounded-sm transition-colors ${
                    devOn ? "bg-accent" : "bg-raised ring-1 ring-inset ring-line"
                  }`}
                >
                  <span
                    className={`absolute top-[3px] h-6 w-6 rounded-sm bg-signal transition-all ${
                      devOn ? "left-[23px]" : "left-[3px]"
                    }`}
                  />
                </button>
              </div>
              )}
              <div className="flex items-center gap-3 px-4 py-4">
                <IconDownload className="h-[18px] w-[18px] shrink-0 text-secondary" />
                <div className="min-w-0 flex-1">
                  <p className="text-[14px] font-medium text-primary">
                    기록 백업
                  </p>
                  <p className="mt-1 text-[12px] leading-snug text-secondary">
                    {BORROW_SERVER
                      ? "(이 기기에만 저장)"
                      : ""}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={exportRecords}
                    className="rounded-md bg-raised px-3 py-2 text-[13px] font-medium text-primary transition-colors"
                  >
                    내보내기
                  </button>
                  <button
                    type="button"
                    onClick={() => importInputRef.current?.click()}
                    className="rounded-md bg-raised px-3 py-2 text-[13px] font-medium text-primary transition-colors"
                  >
                    가져오기
                  </button>
                  <input
                    ref={importInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) importRecords(f);
                      e.target.value = "";
                    }}
                  />
                </div>
              </div>
              {backupMsg && (
                <p className="bg-raised px-4 py-3 text-[12px] text-accent-text">
                  {backupMsg}
                </p>
              )}
              <div className="flex items-center justify-between gap-3 px-4 py-4">
                <div className="flex min-w-0 items-center gap-3">
                  <IconUser className="h-4 w-4 shrink-0 text-secondary" />
                  <div className="min-w-0">
                    <p className="truncate text-[14px] font-medium text-primary">
                      {user.name}
                    </p>
                    <p className="text-[12px] text-secondary">
                      {BORROW_SERVER ? "이 기기 전용" : "내 기록만 표시"}
                    </p>
                  </div>
                </div>
                {!BORROW_SERVER && (
                <button
                  type="button"
                  onClick={logout}
                  className="shrink-0 rounded-md px-3 py-2 text-[13px] font-medium text-secondary transition-colors hover:text-primary"
                >
                  로그아웃
                </button>
                )}
              </div>
              {!BORROW_SERVER && (<>
              <div className="border-t border-line px-4 py-4">
                <div className="min-w-0">
                  <p className="text-[14px] font-medium text-primary">
                    소셜 계정 연동
                  </p>
                </div>
                {linkedProviders.length > 0 && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    {linkedProviders.includes("kakao") && (
                      <span className="rounded-sm bg-[#FEE500]/15 px-3 py-1 text-[12px] font-medium text-[#FEE500]">
                        카카오 연동됨
                      </span>
                    )}
                    {linkedProviders.includes("google") && (
                      <span className="rounded-sm bg-raised px-3 py-1 text-[12px] font-medium text-primary">
                        구글 연동됨
                      </span>
                    )}
                  </div>
                )}
                {(!linkedProviders.includes("kakao") ||
                  !linkedProviders.includes("google")) && (
                  <div className="mt-3 flex gap-2">
                    {!linkedProviders.includes("kakao") && (
                      <button
                        type="button"
                        onClick={() => {
                          void startSocial("kakao", true).then((err) => err && setBackupMsg(err));
                        }}
                        className="flex-1 rounded-md bg-[#FEE500] py-2 text-[13px] font-semibold text-[#191600] transition-transform"
                      >
                        카카오 연동
                      </button>
                    )}
                    {!linkedProviders.includes("google") && (
                      <button
                        type="button"
                        onClick={() => {
                          void startSocial("google", true).then((err) => err && setBackupMsg(err));
                        }}
                        className="flex-1 rounded-md border border-line bg-panel py-2 text-[13px] font-semibold text-primary transition-transform"
                      >
                        구글 연동
                      </button>
                    )}
                  </div>
                )}
              </div>
              {!deleteConfirm ? (
                <div className="flex items-center justify-between gap-3 border-t border-line px-4 py-4">
                  <div className="min-w-0">
                    <p className="text-[14px] font-medium text-primary">
                      계정 삭제
                    </p>
                    <p className="text-[12px] text-secondary">
                      계정과 모든 주행 기록이 함께 삭제돼요
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirm(true)}
                    className="shrink-0 rounded-md px-3 py-2 text-[13px] font-medium text-danger transition-colors"
                  >
                    삭제
                  </button>
                </div>
              ) : (
                <div className="border-t border-danger bg-danger-surface px-4 py-4">
                  <p className="text-[13px] font-medium text-danger">
                    계정 삭제 확인
                  </p>
                  <p className="mt-1 text-[12px] text-danger">
                    {records.length > 0
                      ? `주행 기록 ${records.length}개를 포함해 모두 지워지며 되돌릴 수 없어요.`
                      : "이 작업은 되돌릴 수 없어요."}
                  </p>
                  <div className="mt-3 flex items-center gap-2">
                    <button
                      type="button"
                      onClick={deleteAccount}
                      disabled={deletingAccount}
                      className="rounded-md bg-danger-strong px-4 py-2 text-[13px] font-semibold text-primary transition-colors disabled:opacity-50"
                    >
                      {deletingAccount ? "삭제 중…" : "계정 영구 삭제"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setDeleteConfirm(false)}
                      disabled={deletingAccount}
                      className="rounded-md px-4 py-2 text-[13px] font-medium text-secondary transition-colors hover:text-primary disabled:opacity-50"
                    >
                      취소
                    </button>
                  </div>
                </div>
              )}
              </>)}
                  </div>
                </div>
              </div>
            )}
            <div>
              <h2 className="mb-1 flex items-baseline gap-2 px-1 text-[11px] font-medium uppercase tracking-wide text-secondary">
                지난 주행 {carRecords.length > 0 && carRecords.length}
                {pendingCount > 0 && (
                  <span className="font-normal normal-case text-warn">
                    동기화 대기 {pendingCount}
                  </span>
                )}
              </h2>
              {carRecords.length === 0 ? (
                <p className="py-10 text-center text-sm text-secondary">
                  아직 기록이 없어요. 첫 주행을 시작해보세요.
                </p>
              ) : (
                recordList(
                  recordsExpanded ? recordGroups(carRecords) : recordGroups(carRecords).slice(0, 7),
                )
              )}
              {recordGroups(carRecords).length > 7 && (
                <button
                  type="button"
                  onClick={() => setRecordsExpanded((v) => !v)}
                  className="mt-2 w-full rounded-md border border-line py-3 text-[13px] font-medium text-secondary transition-colors hover:bg-raised hover:text-primary"
                >
                  {recordsExpanded
                    ? "접기"
                    : `이전 날짜 ${recordGroups(carRecords).length - 7}일 더 보기`}
                </button>
              )}
            </div>
            {!isNative && !BORROW_SERVER && (
              <a
                href={withBasePath("/gubi-pleos.apk")}
                download
                className="flex w-full items-center justify-center gap-2 rounded-md border border-line py-4 text-[14px] font-medium text-secondary transition-colors hover:bg-raised"
              >
                <IconDownload className="h-4 w-4" />
                안드로이드 앱 설치
              </a>
            )}
            <p className="pt-2 text-center text-[11px] leading-relaxed text-disabled">
              {isNative
                ? "화면이 꺼져도 기록 계속"
                : "웹은 화면을 켜 둬야 기록됨"}
            </p>
            </div>
            )}
          </div>
        )}

        {/* 트립 상세 — TripRank 스타일(지도·속도분포·스탯), 한국어·km/h */}
        {tripDetail && !uxBlocked && (
          <div data-map-block className="fixed inset-0 z-[60] overflow-y-auto bg-bg">
            <div className="mx-auto w-full log-content-width px-6 py-8">
              <button
                type="button"
                onClick={() => setTripDetail(null)}
                className="-ml-2 mb-4 flex items-center gap-1 self-start rounded-sm py-1 pl-2 pr-3 text-[13px] font-medium text-secondary transition-colors hover:text-primary"
              >
                <IconArrowLeft className="h-4 w-4" />
                기록
              </button>

              {tripDetail.path && (
                <RouteMap
                  enc={tripDetail.path}
                  speeds={tripDetail.speeds}
                  speedBins={[60, 90, 120]}
                  className="h-60 rounded-md"
                  interactive
                />
              )}

              {tripDetail.path && (
                <button
                  type="button"
                  onClick={() => {
                    const rec = tripDetail;
                    const planWithTs = {
                      label: rec.courseLabel ?? "내 코스",
                      durationSec: Math.round((rec.endTs - rec.startTs) / 1000),
                      distanceM: rec.distanceM,
                      path: rec.path,
                      vias: [],
                      ts: Date.now(),
                    };
                    beginGuided(planWithTs, { onAccepted: () => {
                      setTripDetail(null);
                      setPlan(planWithTs);
                      setTab("course");
                      window.scrollTo({ top: 0, behavior: "auto" });
                    } });
                  }}
                  className="mt-3 flex w-full items-center justify-center gap-2 rounded-md bg-accent py-4 text-[15px] font-semibold text-primary transition-colors"
                >
                  <IconPlay className="h-5 w-5" />이 코스로 주행
                </button>
              )}
              {tripRegions && tripRegions.length > 0 && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="text-[12px] text-secondary">지나온 지역</span>
                  {tripRegions.map((rg, i) => (
                    <span
                      key={`${rg.sigungu}-${i}`}
                      className="flex items-center gap-2 text-[13px] text-primary"
                    >
                      {i > 0 && <span className="text-disabled">›</span>}
                      {rg.sigungu}
                    </span>
                  ))}
                </div>
              )}
              {(
                <>
                  <div className="mt-4 flex items-center gap-2 text-[13px] text-secondary">
                    <span>{fmtDate(tripDetail.startTs)}</span>
                    <span className="text-disabled">·</span>
                    <span className="tabular-nums">
                      {new Date(tripDetail.startTs).toLocaleTimeString("ko-KR", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}{" "}
                      -{" "}
                      {new Date(tripDetail.endTs).toLocaleTimeString("ko-KR", {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      })}
                    </span>
                  </div>

                  {/* 스탯 3열 */}
                  <div className="mt-4 grid grid-cols-3 divide-x divide-line rounded-md border border-line py-4">
                    {[
                      {
                        Icon: IconNav,
                        color: "text-accent-text",
                        label: "거리",
                        val: (tripDetail.distanceM / 1000).toFixed(1),
                        unit: "km",
                      },
                      {
                        Icon: IconClock,
                        color: "text-warn",
                        label: "시간",
                        val: fmtDur((tripDetail.endTs - tripDetail.startTs) / 1000),
                        unit: "",
                      },
                      {
                        Icon: IconBolt,
                        color: "text-danger",
                        label: "최고",
                        val:
                          String(tripDetail.maxKmh),
                        unit: "km/h",
                      },
                    ].map(({ Icon, color, label, val, unit }) => (
                      <div
                        key={label}
                        className="flex flex-col items-center gap-2 px-1"
                      >
                        <Icon className={`h-4 w-4 ${color}`} />
                        <div className="text-[18px] font-bold tabular-nums text-primary">
                          {val}
                          {unit && (
                            <span className="ml-1 text-[11px] font-normal text-secondary">
                              {unit}
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-secondary">{label}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {/* 속도 분포 — 지점별 속도가 기록된 주행만 */}
              {tripDetail.speeds &&
                tripDetail.speeds.length > 3 &&
                (() => {

                  const [b1, b2, b3] = [60, 90, 120];
                  const u = (v: number) => v;
                  const bands = [
                    { label: `${u(b1)} 미만`, lo: 0, hi: b1, color: "#22d3ee" },
                    { label: `${u(b1)}–${u(b2)}`, lo: b1, hi: b2, color: "#34d399" },
                    { label: `${u(b2)}–${u(b3)}`, lo: b2, hi: b3, color: "#fbbf24" },
                    { label: `${u(b3)}+`, lo: b3, hi: Infinity, color: "#f87171" },
                  ];
                  const sp = tripDetail.speeds!;
                  const total = sp.length || 1;
                  const pcts = bands.map((b) =>
                    Math.round(
                      (sp.filter((v) => v >= b.lo && v < b.hi).length / total) *
                        100,
                    ),
                  );
                  return (
                    <div className="mt-6">
                      <div className="mb-2 flex items-baseline justify-between px-1">
                        <p className="text-[11px] font-medium uppercase tracking-wide text-secondary">
                          속도 분포
                        </p>
                        <p className="text-[11px] text-disabled">{"km/h"}</p>
                      </div>
                      <div className="flex h-2.5 overflow-hidden rounded-sm bg-raised">
                        {bands.map(
                          (b, i) =>
                            pcts[i] > 0 && (
                              <div
                                key={b.label}
                                style={{
                                  width: `${pcts[i]}%`,
                                  background: b.color,
                                }}
                              />
                            ),
                        )}
                      </div>
                      <div className="mt-3 grid grid-cols-4 gap-2">
                        {bands.map((b, i) => (
                          <div key={b.label}>
                            <div className="flex items-center gap-1 text-[11px] text-secondary">
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-sm"
                                style={{ background: b.color }}
                              />
                              {b.label}
                            </div>
                            <div className="mt-1 text-[15px] font-bold tabular-nums text-primary">
                              {pcts[i]}%
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })()}

              {tripDetail.vehicleTrace && (
                <TripCharts
                  vehicleTrace={tripDetail.vehicleTrace}
                  path={tripDetail.path}
                  speeds={tripDetail.speeds}

                />
              )}

              {(!tripDetail.speeds || tripDetail.speeds.length <= 3) && (
                <p className="mt-6 rounded-md border border-line bg-raised px-4 py-3 text-center text-[12px] leading-relaxed text-secondary">
                  속도 기록 없음
                </p>
              )}

              {/* 주행 통계 */}
              <p className="mb-3 mt-7 text-[15px] font-bold text-primary">
                {"주행 통계"}
              </p>
              <div className="grid grid-cols-2 gap-3">
                {(() => {
                  const totalSec =
                    (tripDetail.endTs - tripDetail.startTs) / 1000;
                  const stopped = Math.max(0, totalSec - tripDetail.movingSec);

                  const spd = (v: number) => String(v);
                  const unitSpd = "km/h";

                  return [
                    {
                      Icon: IconGauge,
                      color: "text-warn",
                      label: "평균 속도",
                      val: spd(tripDetail.avgKmh),
                      unit: unitSpd,
                    },
                    {
                      Icon: IconPause,
                      color: "text-accent-text",
                      label: "정지 시간",
                      val: fmtDur(stopped),
                      unit: "",
                    },
                    {
                      Icon: IconNav,
                      color: "text-accent-text",
                      label: "이동 시간",
                      val: fmtDur(tripDetail.movingSec),
                      unit: "",
                    },
                    {
                      Icon: IconBolt,
                      color: "text-danger",
                      label: "최고 속도",
                      val: spd(tripDetail.maxKmh),
                      unit: unitSpd,
                    },
                    ...(([["zero100Sec", "제로백 0–100"], ["zero50Sec", "0–50"]] as const).flatMap(
                      ([k, label]) =>
                        tripDetail[k] != null
                          ? [
                              {
                                Icon: IconBolt,
                                color: "text-warn",
                                label,
                                val: tripDetail[k]!.toFixed(1),
                                unit: "초",
                              },
                            ]
                          : [],
                    )),
                    ...([]),
                    ...([]),
                  ].map(({ Icon, color, label, val, unit }) => (
                    <div
                      key={label}
                      className="rounded-md border border-line bg-raised p-4"
                    >
                      <Icon className={`h-5 w-5 ${color}`} />
                      <div className="mt-3 text-[13px] text-secondary">
                        {label}
                      </div>
                      <div className="mt-1 text-[20px] font-bold tabular-nums text-primary">
                        {val}
                        {unit && (
                          <span className="ml-1 text-[12px] font-normal text-secondary">
                            {unit}
                          </span>
                        )}
                      </div>
                    </div>
                  ));
                })()}
              </div>
              {tripDetail.gForce && (
                <div className="mt-3">
                  <GForceRecord g={tripDetail.gForce} />
                </div>
              )}
              {tripDetail.courseLabel && (
                <p className="mt-5 text-center text-[12px] text-disabled">
                  {cleanLabel(tripDetail.courseLabel)}
                </p>
              )}
              {/* 삭제는 목록 대신 여기서 — 한 번 더 눌러야 지워진다 */}
              <button
                type="button"
                onClick={() => {
                  if (confirmDeleteId !== tripDetail.id) return setConfirmDeleteId(tripDetail.id);
                  removeRecord(tripDetail.id);
                  setTripDetail(null);
                }}
                className={`mt-8 w-full rounded-md py-3 text-[14px] font-medium transition-colors ${
                  confirmDeleteId === tripDetail.id
                    ? "bg-danger-surface text-danger"
                    : "text-secondary"
                }`}
              >
                {confirmDeleteId === tripDetail.id ? "한 번 더 누르면 삭제돼요" : "이 기록 삭제"}
              </button>
            </div>
          </div>
        )}

        {/* 하단 탭바 — 코스추천(주행 포함) · 프로필 (장소는 프로필 안으로) */}
        {phase === "idle" && !kbOpen && !uxBlocked && (
          <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg">
            <div className="mx-auto flex log-content-width items-stretch justify-around px-2 pb-[calc(env(safe-area-inset-bottom)+6px)] pt-2">
              {(
                [
                  ["course", "코스추천", IconCompass],
                  ["profile", "프로필", IconUser],
                ] as ["course" | "profile", string, typeof IconNav][]
              ).map(([id, label, Icon]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setTab(id)}
                  className={`flex flex-1 flex-col items-center gap-1 rounded-md py-2 text-[11px] font-medium transition-colors ${
                    tab === id ||
                    (id === "profile" &&
                      (tab === "places" || tab === "gas" || tab === "conquest"))
                      ? "text-accent-text"
                      : "text-secondary"
                  }`}
                >
                  <Icon className="h-[22px] w-[22px]" />
                  {label}
                </button>
              ))}
            </div>
          </nav>
        )}
      </div>
    </div>
  );
}
