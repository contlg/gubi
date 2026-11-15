"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { PleosCourseEstimate } from "@/components/PleosInfo";
import { BORROW_SERVER, withBasePath } from "@/lib/borrow-mode";
import CourseDetails from "@/components/CourseDetails";
import PoiCard from "@/components/PoiCard";
import RoadviewStrip from "@/components/RoadviewStrip";
import StyleHighlights from "@/components/StyleHighlights";
import RouteMapOSM from "@/components/RouteMapOSM";
import {
  IconChevronRight,
  IconClose,
  IconCompass,
  IconLoop,
  IconMap,
  IconPin,
  IconSearch,
  IconTarget,
  IconWheel,
} from "@/components/icons";
import {
  addHistory,
  clearHistory,
  loadHistory,
  relTime,
  removeHistory,
  setHistoryNamespace,
  historyKey,
  type SearchRecord,
} from "@/lib/history";
import type { DrivePlanHandoff } from "@/lib/drive-plan";
import { secureDepsFor, writeSecureJson } from "@/lib/secure-store";
import { encodePolyline } from "@/lib/polyline";
import { cleanLabel } from "@/lib/display-text";
import { buildReason } from "@/lib/reason";
import { distanceM } from "@/lib/scoring/curvature";
import MapPicker from "@/components/MapPicker";
import { LOCATION_DENIED, quickPosition } from "@/lib/quick-location";
import { scoreCandidates, type PresetId } from "@/lib/scoring/score";
import {
  COAST_INTENSITIES,
  DRIVE_STYLES,
  WAYPOINT_TYPES,
  type AvoidOption,
  type CoastIntensity,
  type ConditionAdjustments,
  type DriveStyle,
  type Place,
  type RouteCandidate,
  type RouteMetrics,
  type WaypointType,
} from "@/lib/types";

async function geocodePlaces(query: string, signal?: AbortSignal): Promise<Place[]> {
  const res = await fetch(`/api/geocode?q=${encodeURIComponent(query)}`, { signal });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return (data.places ?? []) as Place[];
}

/**
 * 같은 이름의 장소가 여러 곳일 때 첫 결과를 조용히 쓰지 않게 하는 신호. 이 오류가
 * 나면 검색을 멈추고 사용자가 목록에서 정확한 장소를 고르게 한다(원치 않는
 * 출발지·목적지로 긴 경로를 만들던 버그 방지).
 */
class AmbiguousPlaceError extends Error {
  constructor(public field: "origin" | "dest", label: string) {
    super(`"${label}" 검색 결과가 여러 곳이에요. 장소를 선택해 주세요.`);
    this.name = "AmbiguousPlaceError";
  }
}

function formatDuration(sec: number): string {
  const totalMin = Math.round(Math.max(0, sec) / 60);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}시간 ${m}분` : `${m}분`;
}

/** 예산 대비 차이를 "+1시간 20분" 형태로 */
function formatDiff(sec: number): string {
  const sign = sec >= 0 ? "+" : "-";
  return `${sign}${formatDuration(Math.abs(sec))}`;
}

/** 예산과 이 이상 차이 나면 "예산에 안 맞는" 코스로 표시 */
const BUDGET_TOLERANCE_SEC = 1800;

/** 경유지 종류별 기본 체류 시간(분) — 추가 시 자동 배정, 칩에서 조절 */
const DEFAULT_DWELL_MIN: Record<string, number> = {
  관광명소: 30,
  전망대: 15,
  해변: 30,
  "강/호수": 15,
  카페: 30,
  맛집: 60,
  휴게소: 15,
  주유소: 10,
};
/** 체류 시간 칩 클릭 시 순환하는 값들(분) */
const DWELL_CYCLE = [0, 15, 30, 60, 90];

// 결과 화면·시간 제한·주행 전달은 주행 시간만 사용한다. 체류 시간은 경유지 칩에만 표시한다.

/**
 * 경로의 안정적 식별자 — 지표 캐시 키. label은 검색마다 재사용/재정렬되어
 * 이전 후보의 지표가 새 후보에 섞일 수 있으므로, 경로 형태(길이+시작·중간·끝
 * 좌표)로 키를 만든다. 서로 다른 경로가 같은 해시를 가질 확률은 무시 가능.
 */
function pathHash(path: { lat: number; lng: number }[]): string {
  if (path.length === 0) return "0";
  const r = (p: { lat: number; lng: number }) =>
    `${p.lat.toFixed(4)},${p.lng.toFixed(4)}`;
  const mid = path[Math.floor(path.length / 2)];
  return `${path.length}|${r(path[0])}|${r(mid)}|${r(path[path.length - 1])}`;
}

type Mode = "loop" | "dest";

const BUDGET_OPTIONS = [1, 2, 3, 4, 5, 6, 7, 8];
const DURATION_CAPS = [0, 1, 2, 3, 4, 6, 8]; // 시간, 0 = 제한 없음
const DURATION_MINS = [0, 1, 2, 3, 4, 5, 6]; // 시간, 0 = 제한 없음
const COST_CAPS = [0, 10000, 20000, 30000, 50000, 100000]; // 원, 0 = 제한 없음

interface Conditions {
  tempC: number;
  adjustments: ConditionAdjustments;
  notes: string[];
}

type NearbyPlace = Place & {
  type: WaypointType | "주유소";
  offRouteM?: number;
  kakaoId?: string;
  category?: string;
  phone?: string;
  /** 주유소만 — 오피넷 원/L·상표·유종 */
  price?: number;
  brand?: string;
  fuel?: string;
};

/** 새 경유지를 기존 경유 순서 중 우회가 가장 적은 위치에 끼워넣는다 */
function bestInsertIndex(
  existing: Place[],
  origin: Place,
  dest: Place | null,
  p: Place,
): number {
  const pts = [
    origin.coord,
    ...existing.map((w) => w.coord),
    (dest ?? origin).coord,
  ];
  let best = 0;
  let bestCost = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const cost =
      distanceM(pts[i], p.coord) +
      distanceM(p.coord, pts[i + 1]) -
      distanceM(pts[i], pts[i + 1]);
    if (cost < bestCost) {
      bestCost = cost;
      best = i;
    }
  }
  return best;
}

function Chip({
  active,
  onClick,
  children,
  tone = "blue",
  title,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  /** 호출부 호환용 — 강조색은 공통 토큰을 따른다. */
  tone?: "blue" | "orange" | "emerald";
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={active}
      className={`rounded-sm border px-4 py-2 text-[13px] font-medium transition-all duration-200 ease-out  ${
        active
          ? "border-accent bg-accent text-primary"
          : "border-line bg-raised text-secondary  hover:text-primary"
      }`}
    >
      {children}
    </button>
  );
}

/** 자동완성 장소 입력 — 타이핑하면 후보 드롭다운, 선택하면 좌표 확정 */
function PlaceInput({
  value,
  selectedName,
  onChange,
  onSelect,
  placeholder,
  onLocate,
  locating,
  onMapPick,
}: {
  value: string;
  /** 이미 선택된 장소 이름 — 입력값과 같으면 재검색하지 않는다 */
  selectedName?: string;
  onChange: (v: string) => void;
  onSelect: (p: Place) => void;
  placeholder: string;
  onLocate?: () => void;
  locating?: boolean;

  onMapPick?: () => void;
}) {
  const [options, setOptions] = useState<Place[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const q = value.trim();
    if (q.length < 2 || q === selectedName) {
      setOptions([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
          signal: controller.signal,
        });
        if (!res.ok) return;
        const data = await res.json();
        setOptions(data.places ?? []);
        setOpen((data.places ?? []).length > 0);
      } catch {
        // 자동완성 실패는 조용히 무시
      }
    }, 300);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [value, selectedName]);

  return (
    <div data-place-input data-place-actions={Number(!!onLocate) + Number(!!onMapPick)} className="relative flex-1">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onFocus={() => options.length > 0 && setOpen(true)}
        placeholder={placeholder}
        className={`w-full rounded-md border border-line bg-raised px-4 py-3 text-sm text-primary outline-none transition-colors placeholder:text-secondary focus:border-line focus:ring-2 focus:ring-line ${
          onLocate && onMapPick ? "pr-[4.5rem]" : onLocate || onMapPick ? "pr-10" : ""
        }`}
      />
      {onMapPick && (
        <button
          type="button"
          onClick={onMapPick}
          title="지도에서 선택"
          aria-label="지도에서 선택"
          data-place-map
          className={`absolute top-1/2 -translate-y-1/2 rounded-sm p-2 text-[15px] leading-none text-secondary transition-colors hover:bg-raised hover:text-primary ${onLocate ? "right-9" : "right-2"}`}
        >
          <IconMap size={16} />
        </button>
      )}
      {onLocate && (
        <button
          type="button"
          onClick={onLocate}
          disabled={locating}
          title="현재 위치 사용"
          aria-label="현재 위치 사용"
          data-place-locate
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-sm p-2 text-secondary transition-colors hover:bg-raised hover:text-primary disabled:opacity-40"
        >
          <IconTarget className={`h-4 w-4 ${locating ? "animate-spin" : ""}`} />
        </button>
      )}
      {open && (
        <ul className="absolute z-20 mt-2 max-h-64 w-full overflow-auto rounded-md border border-line bg-panel">
          {options.map((p) => (
            <li key={`${p.name}|${p.address}`}>
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onSelect(p);
                  setOpen(false);
                }}
                className="w-full px-4 py-3 text-left transition-colors hover:bg-raised"
              >
                <span className="block truncate text-sm font-medium text-primary">
                  {cleanLabel(p.name)}
                </span>
                <span className="block truncate text-xs text-secondary">
                  {p.address && cleanLabel(p.address)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function FilterRow({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div data-filter-heading className="mb-3 flex items-baseline gap-2">
        <span data-filter-title className="flex items-center gap-2 text-[13px] font-semibold text-primary">
          <span className="h-3.5 w-0.5 rounded-sm bg-accent" />
          {label}
        </span>
        {hint && <span className="text-[11px] text-secondary">{hint}</span>}
      </div>
      <div data-filter-buttons className="flex flex-wrap items-center gap-2">{children}</div>
    </div>
  );
}

export type { DrivePlanHandoff } from "@/lib/drive-plan";

export function Planner({
  embedded = false,
  onDrive,
  userKey,
  restricted = false,
}: {
  embedded?: boolean;
  /** 주행 중(차량 UX 제한) — 상위가 화면을 가리고, 여기선 열린 창(세부 설정·결과·지도 고르기)을 닫는다 */
  restricted?: boolean;
  /** 임베드 시 "이 코스로 주행" — 리로드 없이 상위(Gubi)가 바로 주행 시작 */
  onDrive?: (plan: DrivePlanHandoff) => void;
  /** 로그인 계정 키 — 검색 기록을 계정별로 분리(공용 기기 노출 방지) */
  userKey?: string;
}) {
  const [mode, setMode] = useState<Mode>("loop");
  const [showAdvanced, setShowAdvanced] = useState(false);
  useEffect(() => {
    if (!embedded || !showAdvanced) return;
    const previous = document.activeElement as HTMLElement | null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const frame = requestAnimationFrame(() => document.querySelector<HTMLButtonElement>("[data-planner-options] button")?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); setShowAdvanced(false); }
      if (event.key !== "Tab") return;
      const targets = Array.from(document.querySelectorAll<HTMLElement>("[data-planner-options] button:not(:disabled), [data-planner-options] input:not(:disabled), [data-planner-options] select:not(:disabled)"))
        .filter(element => element.getClientRects().length > 0);
      const first = targets[0], last = targets[targets.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { cancelAnimationFrame(frame); document.removeEventListener("keydown", onKey); document.body.style.overflow = overflow; previous?.focus(); };
  }, [embedded, showAdvanced]);
  const [budgetH, setBudgetH] = useState(4);
  const [avoid, setAvoid] = useState<AvoidOption[]>([]);
  const [waypointTypes, setWaypointTypes] = useState<WaypointType[]>(["관광명소"]);
  const [origin, setOrigin] = useState("");
  const [originPlace, setOriginPlace] = useState<Place | null>(null);
  const [destination, setDestination] = useState("");
  const [destPlace, setDestPlace] = useState<Place | null>(null);
  const [locating, setLocating] = useState(false);
  const [loading, setLoading] = useState(false);
  // 검색 경과 초 — 장시간 대기(수십 초)가 "멈춘 것"처럼 보이지 않게 살아있는
  // 진행 표시에 쓴다(스샷 17·18: 정적 스켈레톤만 보여 멈춘 줄 앎).
  const [searchElapsed, setSearchElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [resolved, setResolved] = useState<{ from: Place; to: Place | null } | null>(null);
  const [searchedBudgetH, setSearchedBudgetH] = useState(4);
  const [candidates, setCandidates] = useState<RouteCandidate[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  // 지표는 경로 해시로 키를 잡는다(label 재사용에 따른 stale 방지).
  const [metricsMap, setMetricsMap] = useState<Record<string, RouteMetrics>>({});
  // 후보별 조회 상태 — 성공(ok)/실패(err) 둘 다 "정착"으로 보고 로딩을 끝낸다.
  const [metricsStatus, setMetricsStatus] = useState<Record<string, "ok" | "err">>(
    {},
  );
  const [preset, setPreset] = useState<PresetId>("fun");
  const [driveStyles, setDriveStyles] = useState<DriveStyle[]>([]);
  const [coastIntensity, setCoastIntensity] = useState<CoastIntensity>("medium");
  const [motionSickness, setMotionSickness] = useState(false);
  const [preferFewSignals, setPreferFewSignals] = useState(false);
  // 정체 회피 — 실시간이라 저장하지 않는 매 트립 의도
  const [avoidJam, setAvoidJam] = useState(false);
  const [avoidTunnels, setAvoidTunnels] = useState(false);
  const [maxDurationH, setMaxDurationH] = useState(0);
  const [minDurationH, setMinDurationH] = useState(0);
  const [maxCost, setMaxCost] = useState(0);
  const [conditions, setConditions] = useState<Conditions | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [resultsOpen, setResultsOpen] = useState(false);
  const [trafficCache, setTrafficCache] = useState<
    Record<
      string,
      {
        samples: { lat: number; lng: number; state: number }[];
        durationSec: number | null;
        /** "kakao"면 카카오 경로가 이 코스와 같아 실시간 소요시간을 그대로 믿는다 */
        durationSource?: "kakao" | "its";
        distanceM: number;
        jamRatio: number | null;
        coverage: number;
        fetchedAt: number;
      }
    >
  >({});
  const [nearbyTypes, setNearbyTypes] = useState<WaypointType[]>(["관광명소"]);
  const [nearby, setNearby] = useState<NearbyPlace[] | null>(null);
  const [nearbyLoading, setNearbyLoading] = useState(false);
  const [nearbyRouteKey, setNearbyRouteKey] = useState("");
  /** 선택 코스 주변 별점순 추천 — 지도에 핀으로 표시 */
  const [courseSpots, setCourseSpots] = useState<NearbyPlace[] | null>(null);
  const [courseSpotsIdentity, setCourseSpotsIdentity] = useState("");
  const [resultMapMode, setResultMapMode] = useState<"traffic" | "winding" | "coast">("traffic");
  const [courseSpotsLoading, setCourseSpotsLoading] = useState(false);
  // 서버/네트워크 오류를 "추천할 곳 없음"과 구분한다 — 오류는 재시도 안내로 표시
  const [courseSpotsError, setCourseSpotsError] = useState(false);
  /** 지도에서 누른 추천 핀 — 카드로 보여주고 경유지로 넣을 수 있게 */
  const [pickedPoi, setPickedPoi] = useState<{ identity: string; place: NearbyPlace } | null>(null);
  /** 추천 명소 종류 필터 — all/cafe/food/sight */
  const [courseSpotFilter, setCourseSpotFilter] = useState<"all" | "cafe" | "food" | "sight" | "gas">("all");
  const [wpQuery, setWpQuery] = useState("");
  const [wpResults, setWpResults] = useState<Place[] | null>(null);
  const [wpSearching, setWpSearching] = useState(false);
  const [pinned, setPinned] = useState<Place[]>([]);
  const [pinQuery, setPinQuery] = useState("");
  /** 지도에서 고르기 — 출발지·목적지·꼭 들를 곳 */
  const [mapPickFor, setMapPickFor] = useState<null | "origin" | "dest" | "pin">(null);
  useEffect(() => {
    if (!restricted) return;
    setShowAdvanced(false);
    setResultsOpen(false);
    setMapPickFor(null);
  }, [restricted]);
  const [pinResults, setPinResults] = useState<Place[] | null>(null);
  const [pinSearching, setPinSearching] = useState(false);
  const [rerouting, setRerouting] = useState(false);
  const [history, setHistory] = useState<SearchRecord[]>([]);
  /** 검색 기록 한 개 삭제 — 화면에서 먼저 빼고, 암호화 저장이 끝나면 저장된 목록으로 맞춘다. */
  function removeHistoryNow(id: string) {
    const key = historyKey();
    setHistory((list) => list.filter((r) => r.id !== id));
    void removeHistory(id, key).then((list) => {
      if (historyKey() === key) setHistory(list);
    });
  }
  const metricsInFlight = useRef<Set<string>>(new Set());
  const trafficInFlight = useRef<Set<string>>(new Set());
  const searchRequest = useRef(0);
  const searchAbort = useRef<AbortController | null>(null);
  const courseSpotsRequest = useRef(0);
  const courseSpotsAbort = useRef<AbortController | null>(null);
  const nearbyRequest = useRef(0);
  const nearbyAbort = useRef<AbortController | null>(null);
  const pinRequest = useRef(0);
  const pinAbort = useRef<AbortController | null>(null);
  const waypointRequest = useRef(0);
  const waypointAbort = useRef<AbortController | null>(null);
  const rerouteRequest = useRef(0);
  const rerouteAbort = useRef<AbortController | null>(null);
  const locationRequest = useRef(0);
  const locationAbort = useRef<AbortController | null>(null);
  const resultsDialogRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      searchAbort.current?.abort();
      courseSpotsAbort.current?.abort();
      nearbyAbort.current?.abort();
      pinAbort.current?.abort();
      waypointAbort.current?.abort();
      rerouteAbort.current?.abort();
      locationAbort.current?.abort();
      locationRequest.current++;
    },
    [],
  );

  const merged = candidates.map((c) => {
    const traffic = trafficCache[pathHash(c.path)];
    return {
      ...c,
      metrics: metricsMap[pathHash(c.path)],
      jamRatio: traffic?.jamRatio ?? c.jamRatio,
      // 카카오가 같은 길로 확인한 실시간 시간이 있으면 그것을 쓴다(굽이 계산은 교통을 덜 반영했다, 2026-11-14)
      ...(traffic?.durationSource === "kakao" && traffic.durationSec ? { durationSec: traffic.durationSec } : {}),
    };
  });

  const capped = merged.filter(
    (c) =>
      (maxDurationH === 0 || c.durationSec <= maxDurationH * 3600) &&
      (mode !== "dest" ||
        minDurationH === 0 ||
        c.durationSec >= minDurationH * 3600) &&
      (maxCost === 0 || c.tollUnknown || c.tollFare + c.fuelCost <= maxCost),
  );
  const excludedCount = merged.length - capped.length;

  const excludedList = merged.filter((c) => !capped.includes(c));
  const exCost = excludedList.filter(
    (c) => maxCost > 0 && !c.tollUnknown && c.tollFare + c.fuelCost > maxCost,
  ).length;
  const exTime = excludedList.filter(
    (c) => maxDurationH > 0 && c.durationSec > maxDurationH * 3600,
  ).length;
  const exMin = excludedList.filter(
    (c) => mode === "dest" && minDurationH > 0 && c.durationSec < minDurationH * 3600,
  ).length;
  const excludeSummary = [
    exCost > 0 && `비용 상한 초과 ${exCost}개`,
    exTime > 0 && `시간 상한 초과 ${exTime}개`,
    exMin > 0 && `최소 시간 미달 ${exMin}개`,
  ]
    .filter(Boolean)
    .join(", ");
  const hasCaps = maxCost > 0 || maxDurationH > 0 || minDurationH > 0;
  const resetCaps = () => {
    setMaxCost(0);
    setMaxDurationH(0);
    setMinDurationH(0);
  };
  const scoredRaw = scoreCandidates(capped, preset, {
    motionSickness,
    preferFewSignals,
    avoidTunnels,
    driveStyles,
    adjustments: conditions?.adjustments,
  });

  const isLoopResult = resolved !== null && resolved.to === null;
  const budgetSec = searchedBudgetH * 3600;

  // 정체 버킷 — '덜 막히는 길 우선' 정렬용. 실시간 정체(jamRatio)가 있는 후보만
  // 실제 값으로 버킷을 매기고, 데이터 없는 후보는 중립(1)으로 둔다. 신호 밀도를
  // 정체로 위장하지 않는다(실측이 아니면 정체라고 말하지 않는다). 0=원활 1=미상/지체 2=정체.
  const jamBucket = (c: (typeof scoredRaw)[number]) => {
    if (typeof c.jamRatio !== "number") return 1;
    return c.jamRatio >= 0.15 ? 2 : c.jamRatio >= 0.05 ? 1 : 0;
  };

  // 예산 안(시간)이 1순위. 순환형은 세 단계로 나눠 정렬한다:
  //   0=예산 이하, 1=예산+허용오차(±30분) 이내, 2=그 이상. "2시간 코스"인데
  //   2시간 20분(버킷1)이 1시간 41분(버킷0)보다 위로 오던 문제를 막는다 —
  //   예산 이하 코스가 있으면 초과 코스보다 항상 먼저 보인다. 같은 버킷 안에서만
  //   취향 점수순. '정체 회피'가 켜지면 버킷 다음으로 안 막히는 코스를 올린다.
  const budgetBucket = (c: (typeof scoredRaw)[number]) => {
    const t = c.durationSec;
    if (t <= budgetSec) return 0;
    if (t <= budgetSec + BUDGET_TOLERANCE_SEC) return 1;
    return 2;
  };
  const scored = isLoopResult
    ? [...scoredRaw].sort(
        (a, b) =>
          budgetBucket(a) - budgetBucket(b) ||
          (avoidJam ? jamBucket(a) - jamBucket(b) : 0) ||
          b.score.total - a.score.total,
      )
    : avoidJam
      ? [...scoredRaw].sort((a, b) => jamBucket(a) - jamBucket(b))
      : scoredRaw;

  // 이 결과가 어떤 검색으로 나온 건지 — 결과 팝업·다시보기 버튼에 표시해 화면의
  // 현재 조건과 헷갈리지 않게 한다.
  const resultMode: Mode = resolved?.to ? "dest" : "loop";
  const resultRouteText = resolved
    ? resolved.to
      ? `${resolved.from.name} – ${resolved.to.name}`
      : `${resolved.from.name} 출발 (${searchedBudgetH}시간 순환)`
    : "";
  // 결과를 만든 뒤 모드·출발지·목적지·예산을 바꾸면 그 결과는 현재 조건과
  // 어긋난다(stale). 이때 열린 결과가 현재 조건인 것처럼 보이지 않게 표시하고,
  // 다시 검색을 권한다 — 바뀐 조건으로 잘못된 코스를 주행 시작하는 것 방지.
  const resultsStale =
    resolved !== null &&
    candidates.length > 0 &&
    (mode !== resultMode ||
      origin.trim() !== resolved.from.name ||
      (resultMode === "dest"
        ? destination.trim() !== (resolved.to?.name ?? "")
        : budgetH !== searchedBudgetH));

  const selectedLabel =
    selected && scored.some((c) => c.label === selected)
      ? selected
      : scored[0]?.label;
  const selectedCandidate = scored.find((c) => c.label === selectedLabel);
  const selectedPathKey = selectedCandidate ? pathHash(selectedCandidate.path) : "";
  const courseSpotIdentity = `${selectedPathKey}|${courseSpotFilter}`;
  const nearbyIdentity = `${selectedPathKey}|${[...nearbyTypes].sort().join(",")}`;
  const poiIdentity = `${courseSpotIdentity}|${nearbyIdentity}`;
  const currentPoiIdentity = useRef(poiIdentity);
  currentPoiIdentity.current = poiIdentity;
  const currentCourseSpotIdentity = useRef(courseSpotIdentity);
  currentCourseSpotIdentity.current = courseSpotIdentity;
  const currentNearbyIdentity = useRef(nearbyIdentity);
  currentNearbyIdentity.current = nearbyIdentity;
  const visibleCourseSpots = courseSpotsIdentity === courseSpotIdentity ? courseSpots : null;
  const visibleCourseSpotsLoading = courseSpotsIdentity === courseSpotIdentity && courseSpotsLoading;
  const visibleCourseSpotsError = courseSpotsIdentity === courseSpotIdentity && courseSpotsError;
  const visibleNearby = nearbyRouteKey === nearbyIdentity ? nearby : null;
  const visibleNearbyLoading = nearbyRouteKey === nearbyIdentity && nearbyLoading;
  const visiblePickedPoi = pickedPoi?.identity === poiIdentity ? pickedPoi.place : null;
  const hasTraffic = !!trafficCache[selectedPathKey]?.samples.length;
  const hasWinding = !!selectedCandidate && selectedCandidate.path.length >= 2 && Number.isFinite(selectedCandidate.curve.degPerKm);
  const hasCoast = !!selectedCandidate?.metrics?.coast.length;
  const effectiveMapMode = (resultMapMode === "coast" && !hasCoast) || (resultMapMode === "winding" && !hasWinding)
    ? "traffic" : resultMapMode;

  useEffect(() => {
    setPickedPoi(null);
  }, [poiIdentity]);
  // 아직 정착(성공·실패)하지 않은 후보가 있으면 로딩 — 실패해도 로딩은 끝난다.
  const metricsLoading =
    candidates.length > 0 &&
    candidates.some((c) => !metricsStatus[pathHash(c.path)]);

  const minDurationSec =
    candidates.length > 0
      ? Math.min(...candidates.map((c) => c.durationSec))
      : 0;
  const budgetMiss =
    isLoopResult &&
    candidates.length > 0 &&
    minDurationSec > budgetSec + BUDGET_TOLERANCE_SEC;
  const suggestedBudgetH =
    BUDGET_OPTIONS.find((h) => h * 3600 + BUDGET_TOLERANCE_SEC >= minDurationSec) ??
    BUDGET_OPTIONS[BUDGET_OPTIONS.length - 1];

  // 경로가 확정되면 아직 정착 안 된 후보들의 로컬 지표를 한 번의 배치 요청으로
  // 계산한다(Overpass 0콜이라 서버가 여러 경로를 동기 처리). 결과는 경로 해시로
  // 저장해 후보가 재정렬/교체돼도 이전 응답이 새 후보에 섞이지 않는다.
  useEffect(() => {
    if (candidates.length === 0) return;
    const missing = candidates.filter((c) => {
      const h = pathHash(c.path);
      return !metricsStatus[h] && !metricsInFlight.current.has(h);
    });
    if (missing.length === 0) return;
    const hashes = missing.map((c) => pathHash(c.path));
    hashes.forEach((h) => metricsInFlight.current.add(h));
    let cancelled = false;
    (async () => {
      let list: (RouteMetrics | null)[] = [];
      try {
        const res = await fetch("/api/route-metrics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paths: missing.map((c) => c.path) }),
        });
        if (res.ok) {
          const data = await res.json();
          list = Array.isArray(data?.metrics) ? data.metrics : [];
        }
      } catch {
        // 네트워크 실패 — 아래에서 전부 err로 정착시켜 로딩을 끝낸다
      } finally {
        hashes.forEach((h) => metricsInFlight.current.delete(h));
      }
      if (cancelled) return;
      setMetricsMap((prev) => {
        const next = { ...prev };
        hashes.forEach((h, i) => {
          if (list[i]) next[h] = list[i] as RouteMetrics;
        });
        return next;
      });
      setMetricsStatus((prev) => {
        const next = { ...prev };
        hashes.forEach((h, i) => {
          next[h] = list[i] ? "ok" : "err";
        });
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [candidates, metricsStatus]);

  // '속도' 색칠 선택 시, 선택된 경로의 도로종류 기반 속도를 로컬 그래프에서
  // 가져온다 (카카오 X, 로컬이라 빠름). 선택 경로만·한 번만 받아 캐시한다.
  // 카드 지도 기본 색칠 = 실시간 정체. 후보마다 ITS 캐시로 소통을 받는다
  // (카카오 콜 0, 후보 경로 그대로 색칠). 5분 캐시. metrics 조회처럼 순차·1회.
  // 검색 경과 초 카운터 — loading 동안 1초마다 증가, 끝나면 0으로.
  useEffect(() => {
    if (!loading) {
      setSearchElapsed(0);
      return;
    }
    const started = Date.now();
    const id = setInterval(
      () => setSearchElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(id);
  }, [loading]);

  useEffect(() => {
    if (!resolved || candidates.length === 0) return;
    const now = Date.now();
    // 후보별 정체를 순차로 기다리면 카드가 하나씩 늦게 색칠된다 – 전부 병렬로
    // 쏘고, 인플라이트 집합으로 중복 요청만 막는다(캐시 갱신마다 재실행돼도).
    for (const cand of candidates) {
      const key = pathHash(cand.path);
      const cached = trafficCache[key];
      if (cached && now - cached.fetchedAt < 300_000) continue;
      if (trafficInFlight.current.has(key)) continue;
      trafficInFlight.current.add(key);
      // 카카오 교통이 1순위(2026-11-14 결정: ITS와 카카오는 같은 도로를 다르게 본다). 카카오가 안 되면
      // (오라클에 아직 기능이 없어 404, IP 막힘 등) 같은 응답 모양의 ITS 교통으로 받는다.
      const post = (url: string) =>
        fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: cand.path }),
        }).then((res) => (res.ok ? res.json() : null));
      post("/api/route-traffic-kakao")
        .catch(() => null)
        .then((data) => data ?? post("/api/route-traffic-its"))
        .then((data) => {
          if (data)
            setTrafficCache((prev) => ({
              ...prev,
              [key]: { ...data, fetchedAt: Date.now() },
            }));
        })
        .catch(() => {
          // 실시간 조회 실패는 조용히 (기본색 유지)
        })
        .finally(() => trafficInFlight.current.delete(key));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, trafficCache, resolved]);

  // 결과 팝업이 열려 있으면 Esc로 닫고 배경 스크롤을 잠근다. 접근성: 열릴 때
  // 초점을 팝업 안으로 옮기고 Tab 초점을 팝업에 가두며, 닫을 때 이전 초점을
  // 되돌린다(키보드·스크린리더 사용자가 배경 컨트롤로 새지 않게).
  useEffect(() => {
    if (!resultsOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const dialog = resultsDialogRef.current;
    const focusFirst = () => {
      const focusables = dialog?.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusables?.[0] ?? dialog)?.focus();
    };
    focusFirst();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setResultsOpen(false);
        return;
      }
      if (e.key !== "Tab" || !dialog) return;
      const nodes = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => !el.hasAttribute("disabled") && el.offsetParent !== null);
      if (nodes.length === 0) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey && (active === first || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [resultsOpen]);

  // 필터 선호 복원 — 매번 종류/제약/성향을 다시 고르지 않게. 출발지·목적지는
  // 매 트립이라 저장하지 않는다. localStorage는 마운트 후에만 읽어 SSR 불일치 회피.
  // 복원 완료 표시는 상태로 둔다 — ref면 같은 효과 묶음에서 저장 효과가 아직
  // 기본값인 상태로 돌아 저장값을 기본값으로 덮어쓴다(StrictMode 재실행 포함).
  const [prefsReady, setPrefsReady] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem("drive-planner-prefs-v1");
      if (raw) {
        const p = JSON.parse(raw);
        // driveStyles·coastIntensity는 매 트립 의도라 복원하지 않는다.
        //   저장하면 와인딩이 딱 붙어 "뭘 골라도 와인딩"이 되는 버그가 난다.
        if (typeof p.budgetH === "number") setBudgetH(p.budgetH);
        if (Array.isArray(p.avoid)) setAvoid(p.avoid);
        if (Array.isArray(p.waypointTypes)) setWaypointTypes(p.waypointTypes);
        if (typeof p.motionSickness === "boolean") setMotionSickness(p.motionSickness);
        if (typeof p.preferFewSignals === "boolean")
          setPreferFewSignals(p.preferFewSignals);
        if (typeof p.avoidTunnels === "boolean") setAvoidTunnels(p.avoidTunnels);
        if (p.mode) setMode(p.mode);
        if (p.preset) setPreset(p.preset);
      }
    } catch {
      // 손상된 저장값은 무시
    }
    setPrefsReady(true);
  }, []);

  // 로그인 계정별로 검색 기록 분리 — userKey가 바뀌면 네임스페이스 전환 후 재로드.
  useEffect(() => {
    // 계정 전환 중 도착한 이전 계정의 검색 결과/기록이 새 네임스페이스에
    // 저장되지 않게 진행 중인 플래너 요청을 모두 취소한다.
    searchAbort.current?.abort();
    searchRequest.current++;
    nearbyAbort.current?.abort();
    nearbyRequest.current++;
    courseSpotsAbort.current?.abort();
    courseSpotsRequest.current++;
    rerouteAbort.current?.abort();
    rerouteRequest.current++;
    setHistoryNamespace(userKey);
    // 암호화된 기록을 풀어 읽는 동안 이전 계정 기록이 보이지 않게 비우고, 늦은 응답은 버린다.
    const key = historyKey();
    setHistory([]);
    void loadHistory(key).then((list) => {
      if (historyKey() === key) setHistory(list);
    });
  }, [userKey]);

  // 필터가 바뀔 때마다 저장 (복원 완료 후에만 — 초기 기본값이 저장을 덮지 않게)
  useEffect(() => {
    if (!prefsReady) return;
    try {
      localStorage.setItem(
        "drive-planner-prefs-v1",
        JSON.stringify({
          budgetH,
          avoid,
          waypointTypes,
          motionSickness,
          preferFewSignals,
          avoidTunnels,
          mode,
          preset,
        }),
      );
    } catch {
      // 저장 실패(용량·프라이빗 모드)는 조용히 무시
    }
  }, [
    prefsReady,
    budgetH,
    avoid,
    waypointTypes,
    motionSickness,
    preferFewSignals,
    avoidTunnels,
    mode,
    preset,
  ]);

  async function search(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 한글 IME: 마지막 글자가 조합 중일 때 엔터를 누르면 상태(origin/destination)에
    // 아직 그 글자가 안 들어와 잘린 질의로 검색돼 0건이 된다. 폼 input DOM의 실제
    // 값(조합 확정본)을 읽어 넘긴다. 첫 input=출발지, 둘째 input=목적지(dest 모드).
    const inputs = e.currentTarget.querySelectorAll("input");
    const originLive = inputs[0]?.value || origin;
    const destLive = mode === "dest" ? inputs[1]?.value || destination : destination;
    await doSearch({ originQuery: originLive, destQuery: destLive });
  }

  /** 검색 중 조건을 바꾸면 이전 조건의 늦은 응답을 결과로 쓰지 않는다. */
  function invalidatePrimarySearch() {
    if (!searchAbort.current || searchAbort.current.signal.aborted) return;
    searchAbort.current.abort();
    searchRequest.current++;
    setLoading(false);
  }

  /** 기록 항목을 눌러 조건 복원 + 즉시 재검색 (엔진이 결정론적이라 같은 결과) */
  function rerunHistory(r: SearchRecord) {
    setMode(r.mode);
    setOrigin(r.from.name);
    setOriginPlace(r.from);
    if (r.to) {
      setDestination(r.to.name);
      setDestPlace(r.to);
    }
    setBudgetH(r.budgetH);
    setDriveStyles(r.styles);
    setCoastIntensity(r.coastIntensity);
    setAvoid(r.avoid);
    setWaypointTypes(r.waypointTypes);
    setPinned(r.pinned);
    // 성향·상한도 그대로 복원 — "같은 조건으로 다시 찾기"가 실제로 같은 조건이게.
    setMotionSickness(r.motionSickness ?? false);
    setPreferFewSignals(r.preferFewSignals ?? false);
    setAvoidTunnels(r.avoidTunnels ?? false);
    setAvoidJam(r.avoidJam ?? false);
    setMinDurationH(r.minDurationH ?? 0);
    setMaxDurationH(r.maxDurationH ?? 0);
    setMaxCost(r.maxCost ?? 0);
    doSearch({
      mode: r.mode,
      from: r.from,
      to: r.to ?? undefined,
      budgetH: r.budgetH,
      styles: r.styles,
      coast: r.coastIntensity,
      avoid: r.avoid,
      waypointTypes: r.waypointTypes,
      pinned: r.pinned,
      motionSickness: r.motionSickness ?? false,
      preferFewSignals: r.preferFewSignals ?? false,
      avoidTunnels: r.avoidTunnels ?? false,
      avoidJam: r.avoidJam ?? false,
      minDurationH: r.minDurationH ?? 0,
      maxDurationH: r.maxDurationH ?? 0,
      maxCost: r.maxCost ?? 0,
    });
  }

  /** 검색 파라미터 오버라이드 — 기록 재실행처럼 state 반영 전에 즉시 써야 할 때 */
  interface SearchOverrides {
    budgetH?: number;
    coast?: CoastIntensity;
    mode?: Mode;
    from?: Place;
    to?: Place;
    /** 폼 제출 시 input DOM의 실제 값 — 한글 IME 조합 중 엔터로 상태가 잘려도
     *  확정본으로 지오코딩하게 한다(originPlace/destPlace 선택은 여전히 우선). */
    originQuery?: string;
    destQuery?: string;
    styles?: DriveStyle[];
    avoid?: AvoidOption[];
    waypointTypes?: WaypointType[];
    pinned?: Place[];
    motionSickness?: boolean;
    preferFewSignals?: boolean;
    avoidTunnels?: boolean;
    avoidJam?: boolean;
    minDurationH?: number;
    maxDurationH?: number;
    maxCost?: number;
  }

  async function doSearch(over: SearchOverrides = {}) {
    searchAbort.current?.abort();
    // 이전 결과에 딸린 보조 요청이 새 검색 결과를 뒤늦게 덮지 않게 모두 무효화한다.
    nearbyAbort.current?.abort();
    nearbyRequest.current++;
    courseSpotsAbort.current?.abort();
    courseSpotsRequest.current++;
    rerouteAbort.current?.abort();
    rerouteRequest.current++;
    const controller = new AbortController();
    searchAbort.current = controller;
    const request = ++searchRequest.current;
    const isCurrent = () => request === searchRequest.current && !controller.signal.aborted;
    // 명시 선택(originPlace/destPlace)이 없으면 지오코딩으로 확정한다. 결과가
    // 여러 곳이면 첫 결과를 조용히 쓰지 않고 사용자에게 선택을 요구하고, 정확히
    // 한 곳이면 자동 확정해 주소까지 저장한다(다음 검색은 즉시).
    const resolvePlace = async (
      field: "origin" | "dest",
      query: string,
    ): Promise<Place> => {
      if (!query.trim()) {
        if (field === "dest") throw new Error("목적지를 입력해 주세요");
        // 출발지를 비우면 현재 위치(십자선 버튼과 같은 방식)
        let coord;
        try {
          coord = await quickPosition();
        } catch (err) {
          throw new Error(
            err instanceof Error && err.message === LOCATION_DENIED
              ? "위치 권한이 거부됐어요. 설정에서 허용해 주세요."
              : "현재 위치를 찾지 못했어요. 출발지를 입력하거나 다시 시도해 주세요.",
          );
        }
        const here: Place = { name: "현재 위치", address: "", coord };
        if (isCurrent()) {
          setOriginPlace(here);
          setOrigin(here.name);
        }
        return here;
      }
      const list = await geocodePlaces(query, controller.signal);
      if (list.length === 0) throw new Error(`"${query}" 검색 결과가 없습니다`);
      if (list.length > 1) throw new AmbiguousPlaceError(field, query);
      const only = list[0];
      if (isCurrent()) {
        if (field === "origin") {
          setOriginPlace(only);
          setOrigin(only.name);
        } else {
          setDestPlace(only);
          setDestination(only.name);
        }
      }
      return only;
    };
    const m = over.mode ?? mode;
    const coast = over.coast ?? coastIntensity;
    const bh = over.budgetH ?? budgetH;
    const st = over.styles ?? driveStyles;
    const av = over.avoid ?? avoid;
    const wt = over.waypointTypes ?? waypointTypes;
    const pn = over.pinned ?? pinned;
    const motion = over.motionSickness ?? motionSickness;
    const fewSignals = over.preferFewSignals ?? preferFewSignals;
    const tunnels = over.avoidTunnels ?? avoidTunnels;
    const jam = over.avoidJam ?? avoidJam;
    const minH = over.minDurationH ?? minDurationH;
    const maxH = over.maxDurationH ?? maxDurationH;
    const costCap = over.maxCost ?? maxCost;
    const originQ = over.originQuery ?? origin;
    const destQ = over.destQuery ?? destination;
    if (over.budgetH !== undefined) setBudgetH(over.budgetH);
    setLoading(true);
    setError(null);
    setCandidates([]);
    setNotes([]);
    setMetricsMap({});
    setMetricsStatus({});
    setTrafficCache({});
    setConditions(null);
    setSelected(null);
    setNearby(null);
    setCourseSpots(null);
    setWpResults(null);
    try {
      let url: string;
      let from: Place;
      let to: Place | null = null;
      if (m === "loop") {
        from = over.from ?? originPlace ?? (await resolvePlace("origin", originQ));
        if (!isCurrent()) return;
        setResolved({ from, to: null });
        setSearchedBudgetH(bh);
        const params = new URLSearchParams({
          origin: `${from.coord.lng},${from.coord.lat}`,
          budget: String(bh * 3600),
        });
        if (av.length) params.set("avoid", av.join(","));
        if (wt.length) params.set("types", wt.join(","));
        if (st.length) params.set("styles", st.join(","));
        if (pn.length) {
          // JSON 직렬화 — 이름의 쉼표·파이프·한글에 안전하고 dwellMin을 손실
          // 없이 전달한다(순환형에서 체류시간이 0분으로 유실되던 버그 수정).
          params.set(
            "waypoints",
            JSON.stringify(
              pn.map((p) => ({
                lng: p.coord.lng,
                lat: p.coord.lat,
                name: p.name,
                dwellMin: p.dwellMin ?? 30,
              })),
            ),
          );
        }
        url = `/api/loop?${params}`;
      } else {
        const [f, t] = await Promise.all([
          over.from ?? originPlace ?? resolvePlace("origin", originQ),
          over.to ?? destPlace ?? resolvePlace("dest", destQ),
        ]);
        if (!isCurrent()) return;
        from = f;
        to = t;
        setResolved({ from, to });
        const params = new URLSearchParams({
          origin: `${from.coord.lng},${from.coord.lat}`,
          destination: `${to.coord.lng},${to.coord.lat}`,
        });
        if (av.length) params.set("avoid", av.join(","));
        if (st.length) params.set("styles", st.join(","));
        if (st.includes("해안도로")) params.set("coast", coast);
        if (costCap > 0) params.set("maxCost", String(costCap));
        if (pn.length) {
          params.set(
            "waypoints",
            pn.map((p) => `${p.coord.lng},${p.coord.lat}`).join("|"),
          );
        }
        url = `/api/directions?${params}`;
      }

      // 날씨/노을 조건은 실패해도 검색을 막지 않는다
      fetch(`/api/conditions?origin=${from.coord.lng},${from.coord.lat}`, {
        signal: controller.signal,
      })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => isCurrent() && d && setConditions(d))
        .catch(() => {});

      const res = await fetch(url, { signal: controller.signal });
      const data = await res.json();
      if (!isCurrent()) return;
      if (!res.ok) throw new Error(data.error);
      // 목적지형은 서버가 경유지 이름을 모르므로 클라이언트에서 붙인다
      const storedCands: RouteCandidate[] =
        m === "dest" && pn.length
          ? data.candidates.map((c: RouteCandidate) => ({ ...c, waypoints: pn }))
          : data.candidates;
      setCandidates(storedCands);
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      // 검색 결과는 팝업(모달)으로 띄운다 — 필터는 뒤에 남는다
      if (storedCands.length > 0) setResultsOpen(true);
      // 검색 기록에 남긴다 — 결과 수는 상한(시간·비용) 통과분 기준으로 저장해
      // "최근 검색 3개인데 화면엔 0개" 불일치를 없앤다(생성 수가 아니라 본 수).
      if (storedCands.length > 0) {
        const shown = storedCands.filter(
          (c) =>
            (maxH === 0 || c.durationSec <= maxH * 3600) &&
            (m !== "dest" || minH === 0 || c.durationSec >= minH * 3600) &&
            (costCap === 0 || c.tollUnknown || c.tollFare + c.fuelCost <= costCap),
        );
        const historyAt = historyKey();
        void addHistory({
            mode: m,
            from,
            to,
            budgetH: bh,
            styles: st,
            coastIntensity: coast,
            avoid: av,
            waypointTypes: wt,
            pinned: pn,
            motionSickness: motion,
            preferFewSignals: fewSignals,
            avoidTunnels: tunnels,
            avoidJam: jam,
            minDurationH: minH,
            maxDurationH: maxH,
            maxCost: costCap,
            results: shown.map((c) => ({
              label: c.label,
              // 카드와 기록 요약 모두 주행 시간만 표시한다.
              durationSec: c.durationSec,
              distanceM: c.distanceM,
            })),
          }, historyAt).then((list) => {
            if (historyKey() === historyAt) setHistory(list);
          });
      }
    } catch (e) {
      if (!isCurrent()) return;
      setError(e instanceof Error ? e.message : "오류가 발생했습니다");
    } finally {
      if (request === searchRequest.current) setLoading(false);
    }
  }

  /** 경로 주변 별점순 추천을 받아 지도에 핀으로 띄운다(자동 + "다시 받기"). */
  async function loadCourseSpots() {
    const cand = scored.find((c) => c.label === selectedLabel);
    if (!cand?.path || cand.path.length < 2) return;
    const selectedPathHash = pathHash(cand.path);
    const identity = courseSpotIdentity;
    const request = ++courseSpotsRequest.current;
    courseSpotsAbort.current?.abort();
    const controller = new AbortController();
    courseSpotsAbort.current = controller;
    setCourseSpotsIdentity(identity);
    setCourseSpots(null);
    setCourseSpotsLoading(true);
    setCourseSpotsError(false);
    try {
      const res = await fetch("/api/course-spots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: cand.path, filter: courseSpotFilter }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (
        controller.signal.aborted ||
        currentCourseSpotIdentity.current !== identity ||
        request !== courseSpotsRequest.current ||
        pathHash(
          scored.find((c) => c.label === selectedLabel)?.path ?? [],
        ) !== selectedPathHash
      )
        return;
      setCourseSpots(data.places ?? []);
    } catch {
      // 취소가 아닌 실제 실패(서버 500·오프라인)는 "없음"이 아니라 오류로 구분한다
      if (!controller.signal.aborted && request === courseSpotsRequest.current && currentCourseSpotIdentity.current === identity)
        setCourseSpotsError(true);
    } finally {
      if (request === courseSpotsRequest.current) setCourseSpotsLoading(false);
    }
  }

  // 코스를 고르면 추천 명소를 자동으로 받아 지도에 핀으로 띄운다(버튼 없이).
  // 서버가 경로-격자로 캐싱하므로 같은 코스/지역 재선택은 API를 안 쓴다.
  useEffect(() => {
    const cand = scored.find((c) => c.label === selectedLabel);
    if (cand?.path && cand.path.length >= 2) void loadCourseSpots();
    else {
      setCourseSpots(null);
      setCourseSpotsError(false);
    }
    return () => {
      courseSpotsRequest.current++;
      courseSpotsAbort.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedLabel, selectedPathKey, courseSpotFilter]);

  async function searchNearby() {
    if (!selectedCandidate || nearbyTypes.length === 0) return;
    nearbyAbort.current?.abort();
    const controller = new AbortController();
    nearbyAbort.current = controller;
    const request = ++nearbyRequest.current;
    const routeKey = pathHash(selectedCandidate.path);
    const types = [...nearbyTypes];
    const identity = nearbyIdentity;
    setNearbyRouteKey(identity);
    setNearbyLoading(true);
    setNearby(null);
    try {
      const res = await fetch("/api/nearby", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: selectedCandidate.path, types }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (
        controller.signal.aborted ||
        currentNearbyIdentity.current !== identity ||
        request !== nearbyRequest.current ||
        pathHash(
          scored.find((c) => c.label === selectedLabel)?.path ?? [],
        ) !== routeKey
      )
        return;
      setNearby(data.places);
    } catch (e) {
      if (controller.signal.aborted || request !== nearbyRequest.current || currentNearbyIdentity.current !== identity) return;
      setError(e instanceof Error ? e.message : "주변 검색 실패");
    } finally {
      if (request === nearbyRequest.current) setNearbyLoading(false);
    }
  }

  function locateMe() {
    locationAbort.current?.abort();
    const request = ++locationRequest.current;
    setLocating(true);
    // Gubi와 같은 빠른 위치(앱이면 폰에 직접, 웹이면 정밀–대략 순)
    quickPosition().then(
      async (coord) => {
        if (request !== locationRequest.current) return;
        let place: Place = { name: "현재 위치", address: "", coord };
        // 좌표부터 바로 반영하고, 주소는 받아지면 이름만 바꾼다
        setOriginPlace(place);
        setOrigin(place.name);
        setLocating(false);
        const controller = new AbortController();
        locationAbort.current = controller;
        try {
          const res = await fetch(`/api/revgeocode?coord=${coord.lng},${coord.lat}`, {
            signal: controller.signal,
          });
          if (res.ok) place = (await res.json()).place;
        } catch {
          // 주소 변환 실패해도 좌표는 쓸 수 있다
        }
        if (controller.signal.aborted || request !== locationRequest.current) return;
        setOriginPlace(place);
        setOrigin(place.name);
      },
      (e: Error) => {
        if (request !== locationRequest.current) return;
        setError(
          e.message === LOCATION_DENIED
            ? "위치 권한이 거부됐어요. 설정에서 허용해 주세요."
            : "현재 위치를 찾지 못했어요. 다시 시도해 주세요.",
        );
        setLocating(false);
      },
    );
  }

  async function searchPin(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 한글 IME 조합 중 엔터 대비 — input DOM 실제값(확정본) 우선(잘린 질의 방지)
    const live = e.currentTarget.querySelector("input")?.value ?? pinQuery;
    if (live !== pinQuery) setPinQuery(live);
    const q = live.trim();
    if (!q) return;
    pinAbort.current?.abort();
    const controller = new AbortController();
    pinAbort.current = controller;
    const request = ++pinRequest.current;
    setPinSearching(true);
    setPinResults(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (controller.signal.aborted || request !== pinRequest.current) return;
      setPinResults(data.places);
    } catch (e) {
      if (controller.signal.aborted || request !== pinRequest.current) return;
      setError(e instanceof Error ? e.message : "장소 검색 실패");
    } finally {
      if (request === pinRequest.current) setPinSearching(false);
    }
  }

  function addPin(place: Place) {
    if (pinned.length >= 3) return;
    if (pinned.some((p) => p.name === place.name && p.address === place.address))
      return;
    setPinned((prev) => [...prev, { ...place, dwellMin: place.dwellMin ?? 30 }]);
    setPinResults(null);
    setPinQuery("");
  }

  async function searchWaypoint(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    // 한글 IME 조합 중 엔터 대비 — input DOM 실제값(확정본) 우선(잘린 질의 방지)
    const live = e.currentTarget.querySelector("input")?.value ?? wpQuery;
    if (live !== wpQuery) setWpQuery(live);
    const q = live.trim();
    if (!q) return;
    waypointAbort.current?.abort();
    const controller = new AbortController();
    waypointAbort.current = controller;
    const request = ++waypointRequest.current;
    setWpSearching(true);
    setWpResults(null);
    try {
      const res = await fetch(`/api/geocode?q=${encodeURIComponent(q)}`, {
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      if (controller.signal.aborted || request !== waypointRequest.current) return;
      setWpResults(data.places);
    } catch (e) {
      if (controller.signal.aborted || request !== waypointRequest.current) return;
      setError(e instanceof Error ? e.message : "장소 검색 실패");
    } finally {
      if (request === waypointRequest.current) setWpSearching(false);
    }
  }

  /** 주어진 경유지 목록으로 커스텀 코스를 재탐색해 후보에 추가한다 */
  async function rerouteWith(waypoints: Place[]) {
    if (!resolved) return;
    if (mode === "loop" && waypoints.length === 0) {
      setError("순환형은 경유지가 최소 1개 필요해요.");
      return;
    }
    rerouteAbort.current?.abort();
    const controller = new AbortController();
    rerouteAbort.current = controller;
    const request = ++rerouteRequest.current;
    setRerouting(true);
    setError(null);
    try {
      const from = resolved.from;
      const to = resolved.to ?? resolved.from;
      let base: RouteCandidate;
      if (waypoints.length > 5) {
        // 카카오 길찾기는 경유지 5개 하드 제한 — 6개 이상은 보정된 로컬 A*로
        const res = await fetch("/api/local-route", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            origin: from.coord,
            destination: to.coord,
            waypoints: waypoints.map((w) => w.coord),
            avoid,
          }),
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (!data?.candidate) throw new Error("재탐색 가능한 경로를 찾지 못했어요.");
        base = data.candidate;
      } else {
        const params = new URLSearchParams({
          origin: `${from.coord.lng},${from.coord.lat}`,
          destination: `${to.coord.lng},${to.coord.lat}`,
          waypoints: waypoints
            .map((w) => `${w.coord.lng},${w.coord.lat}`)
            .join("|"),
        });
        if (avoid.length) params.set("avoid", avoid.join(","));
        if (maxCost > 0) params.set("maxCost", String(maxCost));
        const res = await fetch(`/api/directions?${params}`, {
          signal: controller.signal,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        if (!Array.isArray(data.candidates) || !data.candidates[0]) {
          throw new Error("재탐색 가능한 경로를 찾지 못했어요.");
        }
        base = data.candidates[0];
      }

      if (controller.signal.aborted || request !== rerouteRequest.current) return;

      let label = waypoints.length
        ? `커스텀: ${waypoints.map((w) => w.name).join(" – ")}`
        : "커스텀: 직행";
      while (candidates.some((c) => c.label === label)) label += " *";
      // 재탐색 커스텀 후보도 원본 코스의 스타일 정체성(styleTag)을 유지한다 —
      // 경유지 하나 추가했다고 "강변도로"가 일반 코스로 바뀌지 않게.
      const candidate: RouteCandidate = {
        ...base,
        label,
        waypoints,
        styleTag: selectedCandidate?.styleTag ?? base.styleTag,
      };
      setCandidates((prev) => [...prev, candidate]);
      setSelected(label);
    } catch (e) {
      if (controller.signal.aborted || request !== rerouteRequest.current) return;
      setError(e instanceof Error ? e.message : "재탐색 실패");
    } finally {
      if (request === rerouteRequest.current) setRerouting(false);
    }
  }

  function addWaypoint(place: Place & { type?: WaypointType | "주유소" }) {
    if (!selectedCandidate || !resolved) return;
    const existing = selectedCandidate.waypoints ?? [];
    if (existing.length >= 10) {
      setError("경유지는 최대 10개까지 넣을 수 있어요.");
      return;
    }
    if (existing.some((w) => w.name === place.name && w.address === place.address)) {
      return;
    }
    // 종류별 기본 체류 시간 자동 배정 — 칩의 시간로 조절 가능
    const withDwell: Place = {
      ...place,
      dwellMin:
        place.dwellMin ?? (place.type ? (DEFAULT_DWELL_MIN[place.type] ?? 30) : 30),
    };
    const idx = bestInsertIndex(existing, resolved.from, resolved.to, withDwell);
    rerouteWith([...existing.slice(0, idx), withDwell, ...existing.slice(idx)]);
  }

  /** 경유지 체류 시간 순환 (0–15–30–60–90–0분) */
  function cycleDwell(label: string, idx: number) {
    setCandidates((prev) =>
      prev.map((c) => {
        if (c.label !== label || !c.waypoints?.[idx]) return c;
        const cur = c.waypoints[idx].dwellMin ?? 0;
        const next =
          DWELL_CYCLE[(DWELL_CYCLE.indexOf(cur) + 1) % DWELL_CYCLE.length];
        return {
          ...c,
          waypoints: c.waypoints.map((w, j) =>
            j === idx ? { ...w, dwellMin: next } : w,
          ),
        };
      }),
    );
  }

  function removeWaypoint(candidate: RouteCandidate, index: number) {
    const waypoints = candidate.waypoints ?? [];
    const target = waypoints[index];
    // 필수 경유(pinned)를 결과 카드에서 지우는 건 "필수 조건 해제"다 — 조용히
    // 빼지 말고 알리고, pinned에서도 실제로 해제해 다음 검색에 유령으로 남지 않게.
    if (target && pinned.some((p) => p.name === target.name)) {
      setPinned((prev) => prev.filter((p) => p.name !== target.name));
      setNotes((n) => [
        `${target.name} 경유지를 제거해 필수 조건을 해제했어요.`,
        ...n,
      ]);
    }
    rerouteWith(waypoints.filter((_, i) => i !== index));
  }

  return (
    <div className="flex-1">
      {!embedded && (
      <header className="sticky top-0 z-20 border-b border-line bg-bg">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-3">
          <span className="grid h-9 w-9 place-items-center rounded-md bg-accent text-primary">
            <IconWheel className="h-5 w-5" />
          </span>
          <div className="flex items-baseline gap-2">
            <h1 className="text-lg font-bold tracking-tight">Gubi</h1>
            <span className="hidden text-xs text-secondary sm:inline">
              검색하지 말고, 설계하자
            </span>
          </div>
          <a
            href={withBasePath("/log")}
            onClick={(e) => {
              // 로그인·기록이 사는 drivelog. 서브도메인으로 — 현재(drive.) /log로
              // 가면 오리진이 달라 로그인이 없어 로그인창이 다시 뜬다.
              // 빌려 쓰기 모드는 이미 drivelog 주소 아래(/gubi)라 그대로 둔다.
              const h = location.hostname;
              if (!BORROW_SERVER && h.startsWith("drive.")) {
                e.preventDefault();
                location.href = `${location.protocol}//drivelog.${h.slice(6)}/log`;
              }
            }}
            className="ml-auto rounded-sm border border-line bg-raised px-4 py-2 text-xs font-medium text-secondary transition-colors hover:text-primary"
          >
            주행 기록
          </a>
        </div>
      </header>
      )}

      <main
        className={
          embedded ? "w-full" : "mx-auto max-w-3xl px-4 pb-10"
        }
      >
        {/* 인트로 — 임베드(드라이브 탭)일 땐 상위가 타이틀을 그리므로 생략 */}
        {!embedded && (
        <div className="pb-7 pt-10 sm:pt-14">
          <h2 className="text-[2.25rem] font-semibold leading-[1.05] tracking-[-0.03em] text-primary sm:text-[3.25rem]">
            드라이브 코스
          </h2>
        </div>
        )}

        <div className="">
          <section
            data-planner-controls
            onClickCapture={invalidatePrimarySearch}
            onChangeCapture={invalidatePrimarySearch}
            className="rounded-md border border-line bg-raised p-5 sm:p-6"
          >

          <div data-planner-mode className="relative inline-grid grid-cols-2 rounded-md bg-raised p-1 ring-1 ring-inset ring-line">
            <span
              aria-hidden
              className="pointer-events-none absolute bottom-1 left-1 top-1 w-[calc((100%-0.5rem)/2)] rounded-md bg-accent"
              style={{
                transform: mode === "dest" ? "translateX(100%)" : "translateX(0)",
                transition: "transform 0.34s ease-out",
                willChange: "transform",
              }}
            />
            {(
              [
                ["loop", "순환형", IconLoop],
                ["dest", "목적지형", IconPin],
              ] as [Mode, string, typeof IconLoop][]
            ).map(([id, label, Icon]) => (
              <button
                key={id}
                onClick={() => setMode(id)}
                className={`relative z-10 inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-semibold transition-colors duration-200 ${
                  mode === id ? "text-primary" : "text-secondary hover:text-primary"
                }`}
              >
                <Icon className="h-4 w-4" />
                {label}
              </button>
            ))}
          </div>

          <form data-planner-form onSubmit={search} className="mt-5 flex flex-col gap-3">
            <div data-planner-places className="flex flex-col gap-3 sm:flex-row">
              <PlaceInput
                value={origin}
                selectedName={originPlace?.name}
                onChange={(v) => {
                  locationAbort.current?.abort();
                  locationRequest.current++;
                  setLocating(false);
                  setOrigin(v);
                  setOriginPlace(null);
                }}
                onSelect={(p) => {
                  locationAbort.current?.abort();
                  locationRequest.current++;
                  setLocating(false);
                  setOriginPlace(p);
                  setOrigin(p.name);
                }}
                placeholder="출발지 (예: 서울역)"
                onMapPick={() => setMapPickFor("origin")}
                onLocate={locateMe}
                locating={locating}
              />
              {mode === "dest" ? (
                <PlaceInput
                  value={destination}
                  selectedName={destPlace?.name}
                  onChange={(v) => {
                    setDestination(v);
                    setDestPlace(null);
                  }}
                  onSelect={(p) => {
                    setDestPlace(p);
                    setDestination(p.name);
                  }}
                  placeholder="목적지 (예: 강릉역)"
                  onMapPick={() => setMapPickFor("dest")}
                />
              ) : (
                <select
                  value={budgetH}
                  onChange={(e) => setBudgetH(Number(e.target.value))}
                  className="shrink-0 rounded-md border border-line bg-raised px-4 py-3 text-sm text-primary outline-none transition-colors focus:border-line sm:w-40"
                >
                  {BUDGET_OPTIONS.map((h) => (
                    <option key={h} value={h}>
                      {h}시간 코스
                    </option>
                  ))}
                </select>
              )}
            </div>
            <button
              type="submit"
              disabled={loading}
              className="flex w-full items-center justify-center gap-2 rounded-md bg-accent py-4 text-[15px] font-semibold text-primary transition-colors disabled:opacity-50"
            >
              <IconSearch className="h-[18px] w-[18px]" />
              {loading ? "코스 찾는 중" : "코스 추천"}
            </button>
          </form>

          <div data-planner-filters className="mt-6 border-t border-line pt-6">
            {/* 드라이브 종류 — 이 앱의 핵심이라 항상 보인다 */}
            <FilterRow label="드라이브 종류">
              {DRIVE_STYLES.map((s) => (
                <Chip
                  key={s}
                  active={driveStyles.includes(s)}
                  onClick={() =>
                    setDriveStyles((prev) =>
                      prev.includes(s)
                        ? prev.filter((v) => v !== s)
                        : [...prev, s],
                    )
                  }
                >
                  {s}
                </Chip>
              ))}
            </FilterRow>

            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              aria-expanded={showAdvanced}
              data-planner-advanced
              className="mt-4 flex w-full items-center justify-between rounded-md px-1 py-2 text-[13px] font-medium text-secondary transition-colors hover:text-primary"
            >
              세부 설정
              <IconChevronRight
                className={`h-4 w-4 transition-transform duration-200 ${
                  showAdvanced ? "rotate-90" : ""
                }`}
              />
            </button>

            {showAdvanced && !restricted && (
              <div data-planner-options data-map-block={embedded ? "" : undefined}
                role={embedded ? "dialog" : undefined} aria-modal={embedded ? true : undefined}
                aria-label={embedded ? "코스 세부 설정" : undefined}
                className={embedded ? "fixed inset-0 z-[80] flex flex-col gap-5 overflow-y-auto bg-bg p-6" : "mt-2 flex flex-col gap-5"}>
              {embedded && (
                <div className="mb-6 flex items-center justify-between border-b border-line pb-4">
                  <h2 className="text-2xl font-bold">코스 세부 설정</h2>
                  <button type="button" onClick={() => setShowAdvanced(false)}
                    className="rounded-md border border-line bg-raised px-6 font-semibold">설정 완료</button>
                </div>
              )}
            <FilterRow label="필수 경유" hint="최대 3개">
              {pinned.map((p, i) => (
                <span
                  key={`${p.name}|${i}`}
                  className="flex items-center gap-2 rounded-sm border border-line bg-raised px-3 py-2 text-xs font-medium text-primary"
                >
                  {p.name}
                  <button
                    type="button"
                    onClick={() =>
                      setPinned((prev) => prev.filter((_, j) => j !== i))
                    }
                    className="text-secondary transition-colors hover:text-primary"
                    aria-label={`${p.name} 제거`}
                  >
                    <IconClose className="h-3.5 w-3.5" />
                  </button>
                </span>
              ))}
              {pinned.length < 3 ? (
                <form onSubmit={searchPin} className="flex w-full min-w-0 items-center gap-2">
                  <input
                    value={pinQuery}
                    onChange={(e) => {
                      pinAbort.current?.abort();
                      pinRequest.current++;
                      setPinSearching(false);
                      setPinResults(null);
                      setPinQuery(e.target.value);
                    }}
                    placeholder="꼭 들를 곳 검색 (예: 남이섬)"
                    className="min-w-0 flex-1 rounded-sm border border-line bg-raised px-4 py-3 text-sm outline-none transition-colors placeholder:text-secondary focus:border-line focus:ring-2 focus:ring-line dark:border-line dark:bg-raised dark:placeholder:text-secondary dark:focus:ring-line"
                  />
                  <button
                    type="submit"
                    disabled={pinSearching || !pinQuery.trim()}
                    className="min-h-11 shrink-0 rounded-sm bg-accent px-4 text-xs font-medium text-primary transition-colors disabled:cursor-not-allowed disabled:bg-raised disabled:text-disabled disabled:ring-1 disabled:ring-inset disabled:ring-line"
                  >
                    {pinSearching ? "…" : "검색"}
                  </button>
                  <button
                    type="button"
                    onClick={() => setMapPickFor("pin")}
                    title="지도에서 선택"
                    aria-label="지도에서 선택"
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-sm border border-line bg-raised text-secondary transition-colors hover:text-primary"
                  >
                    <IconMap size={20} />
                  </button>
                </form>
              ) : (
                <span className="text-xs text-secondary dark:text-secondary">최대 3개</span>
              )}
            </FilterRow>


            {pinResults && (
              <div className="-mt-1 flex flex-wrap gap-2">
                {pinResults.length === 0 && (
                  <span className="text-xs text-secondary dark:text-secondary">
                    검색 결과가 없어요.
                  </span>
                )}
                {pinResults.map((p) => (
                  <button
                    key={`${p.name}|${p.address}`}
                    type="button"
                    onClick={() => addPin(p)}
                    className="rounded-md border border-line bg-panel px-3 py-1 text-left text-xs transition-colors"
                  >
                    <span className="font-medium">{cleanLabel(p.name)}</span>
                    <span className="ml-1 text-secondary dark:text-secondary">{p.address && cleanLabel(p.address)}</span>
                  </button>
                ))}
              </div>
            )}

            <FilterRow label="제약">
              {(
                [
                  ["toll", "유료도로 제외"],
                  ["motorway", "고속도로 제외"],
                ] as [AvoidOption, string][]
              ).map(([opt, label]) => (
                <Chip
                  key={opt}
                  active={avoid.includes(opt)}
                  onClick={() =>
                    setAvoid((prev) =>
                      prev.includes(opt)
                        ? prev.filter((v) => v !== opt)
                        : [...prev, opt],
                    )
                  }
                >
                  {label}
                </Chip>
              ))}
              <Chip
                active={avoidJam}
                onClick={() => setAvoidJam((v) => !v)}
                title="실시간 정체 데이터가 있는 후보를 덜 막히는 순으로 올려요(새 우회 경로를 만들진 않아요)"
              >
                덜 막히는 길 우선
              </Chip>
              {mode === "dest" && (
                <select
                  value={minDurationH}
                  onChange={(e) => setMinDurationH(Number(e.target.value))}
                  className="rounded-sm border border-line bg-raised px-3 py-2 text-xs text-disabled outline-none transition-colors focus:border-line dark:border-line dark:bg-raised dark:text-secondary"
                >
                  {DURATION_MINS.map((h) => (
                    <option key={h} value={h}>
                      {h === 0 ? "최소 시간 없음" : `${h}시간 이상`}
                    </option>
                  ))}
                </select>
              )}
              <select
                aria-label="최대 운전시간(이보다 긴 코스는 결과에서 제외)"
                title="위의 코스 시간(예: 4시간 코스)은 만들 코스의 목표 길이이고, 이 값은 결과에서 이보다 오래 걸리는 코스를 빼는 상한이에요"
                value={maxDurationH}
                onChange={(e) => setMaxDurationH(Number(e.target.value))}
                className="rounded-sm border border-line bg-raised px-3 py-2 text-xs text-disabled outline-none transition-colors focus:border-line dark:border-line dark:bg-raised dark:text-secondary"
              >
                {DURATION_CAPS.map((h) => (
                  <option key={h} value={h}>
                    {h === 0 ? "최대 운전시간 제한 없음" : `최대 운전 ${h}시간`}
                  </option>
                ))}
              </select>
              <select
                value={maxCost}
                onChange={(e) => setMaxCost(Number(e.target.value))}
                className="rounded-sm border border-line bg-raised px-3 py-2 text-xs text-disabled outline-none transition-colors focus:border-line dark:border-line dark:bg-raised dark:text-secondary"
              >
                {COST_CAPS.map((v) => (
                  <option key={v} value={v}>
                    {v === 0
                      ? "예산 제한 없음"
                      : `${(v / 10000).toLocaleString()}만원 이내`}
                  </option>
                ))}
              </select>
            </FilterRow>

            <FilterRow label="성향">
              <Chip
                active={motionSickness}
                onClick={() => setMotionSickness((v) => !v)}
              >
                멀미 배려
              </Chip>
              <Chip
                active={preferFewSignals}
                onClick={() => setPreferFewSignals((v) => !v)}
              >
                신호 적은 길
              </Chip>
              <Chip active={avoidTunnels} onClick={() => setAvoidTunnels((v) => !v)}>
                터널 기피
              </Chip>
            </FilterRow>

            {mode === "dest" && driveStyles.includes("해안도로") && (
              <FilterRow label="해안 강도">
                <input
                  type="range"
                  min={0}
                  max={COAST_INTENSITIES.length - 1}
                  step={1}
                  value={COAST_INTENSITIES.indexOf(coastIntensity)}
                  onChange={(e) =>
                    setCoastIntensity(COAST_INTENSITIES[Number(e.target.value)])
                  }
                  aria-label="해안도로 우회 강도"
                  className="max-w-[160px] flex-1 accent-accent"
                />
                <span className="w-8 shrink-0 text-xs font-semibold text-accent-text">
                  {coastIntensity === "light"
                    ? "살짝"
                    : coastIntensity === "medium"
                      ? "보통"
                      : "최대"}
                </span>
                <span className="text-[11px] text-secondary dark:text-secondary">
                  {coastIntensity === "light"
                    ? "최적 경로 대비 +40% 이내로만 우회"
                    : coastIntensity === "medium"
                      ? "+80% 이내로 우회"
                      : "제한 없이 최대한 해안을 탐"}
                </span>
              </FilterRow>
            )}

            {mode === "loop" && (
              <FilterRow label="경유지">
                {WAYPOINT_TYPES.map((t) => (
                  <Chip
                    key={t}
                    tone="emerald"
                    active={waypointTypes.includes(t)}
                    onClick={() =>
                      setWaypointTypes((prev) =>
                        prev.includes(t)
                          ? prev.filter((v) => v !== t)
                          : [...prev, t],
                      )
                    }
                  >
                    {t === "맛집" ? "음식점" : t}
                  </Chip>
                ))}
              </FilterRow>
            )}
              </div>
            )}
          </div>
          </section>
        </div>

        {/* 최근 검색 — 누르면 같은 조건으로 다시 찾는다 */}
        {history.length > 0 && !loading && (
          <section className="mt-4">
            <div className="mb-2 flex items-baseline justify-between px-1">
              <h3 className="flex items-baseline gap-2 text-xs font-semibold text-secondary dark:text-secondary">
                최근 검색
              </h3>
              <button
                type="button"
                onClick={() => {
                  setHistory([]);
                  void clearHistory();
                }}
                className="text-[11px] text-secondary transition-colors hover:text-disabled dark:hover:text-secondary"
              >
                전체 지우기
              </button>
            </div>
            <ul className="space-y-2">
              {history.slice(0, 5).map((r) => (
                <li key={r.id}>
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => rerunHistory(r)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") rerunHistory(r);
                    }}
                    className="flex w-full cursor-pointer items-center gap-3 rounded-md border border-line bg-raised px-4 py-3 text-left text-sm transition-all hover:-translate-y-px dark:border-line dark:bg-panel"
                  >
                    <span className="shrink-0 text-secondary">
                      {r.mode === "loop" ? (
                        <IconLoop className="h-4 w-4" />
                      ) : (
                        <IconPin className="h-4 w-4" />
                      )}
                    </span>
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-semibold">
                        {r.to
                          ? `${cleanLabel(r.from.name)} – ${cleanLabel(r.to.name)}`
                          : `${cleanLabel(r.from.name)} (${r.budgetH}시간)`}
                      </span>
                      {r.styles.length > 0 && (
                        <span className="ml-2 text-xs text-accent-text dark:text-accent-text">
                          {r.styles.join("·")}
                        </span>
                      )}
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-secondary dark:text-secondary">
                      {relTime(r.ts)}
                    </span>
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label="기록 삭제"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeHistoryNow(r.id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.stopPropagation();
                          removeHistoryNow(r.id);
                        }
                      }}
                      className="grid h-6 w-6 shrink-0 cursor-pointer place-items-center rounded-sm text-secondary transition-colors hover:bg-raised dark:text-disabled dark:hover:bg-raised dark:hover:text-secondary"
                    >
                      닫기
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* 검색 중 스켈레톤 — 지도 + 카드 자리를 미리 잡아 레이아웃이 안 튀게 */}
        {loading && (
          <div className="mt-6 space-y-3">
            {/* 살아있는 진행 표시 — 경과 초 + 늘어나는 바 + 단계 안내로
                장시간 대기가 멈춘 것처럼 보이지 않게 한다. */}
            <div className="rounded-md border border-line bg-raised p-4 dark:border-line dark:bg-panel">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-sm bg-ok-strong opacity-75" />
                  <span className="relative inline-flex h-2.5 w-2.5 rounded-sm bg-ok-strong" />
                </span>
                <p className="text-sm font-semibold text-primary dark:text-primary">
                  코스 찾는 중…
                </p>
                <span className="ml-auto text-xs tabular-nums text-secondary dark:text-secondary">
                  {searchElapsed}s
                </span>
              </div>
              <p className="mt-1 text-xs text-secondary dark:text-secondary">
                {searchElapsed < 8
                  ? "실시간 도로·교통 정보 확인 중…"
                  : searchElapsed < 20
                    ? "주행 구간 확인 중…"
                    : "경로 계산 중…"}
              </p>
              <div className="mt-3 h-1.5 overflow-hidden rounded-sm bg-raised dark:bg-raised">
                <div
                  className="h-full rounded-sm bg-ok-strong transition-[width] duration-1000 ease-linear"
                  style={{ width: `${Math.min(95, 18 + searchElapsed * 4)}%` }}
                />
              </div>
            </div>
            <div className="h-9 w-52 animate-pulse rounded-md bg-raised dark:bg-raised" />
            <div className="h-72 animate-pulse rounded-md bg-raised dark:bg-raised" />
            {[0, 1, 2].map((i) => (
              <div
                key={i}
                className="h-32 animate-pulse rounded-md bg-raised dark:bg-raised"
                style={{ animationDelay: `${i * 120}ms` }}
              />
            ))}
          </div>
        )}

        {error && (
          <div className="mt-4 flex items-start gap-3 rounded-md border border-danger bg-danger-surface p-4 text-sm text-danger dark:border-danger dark:bg-danger-surface dark:text-danger">

            <span>{error}</span>
          </div>
        )}

        {/* 결과 팝업을 닫았을 때 다시 여는 버튼 — 어떤 검색 결과인지 명시하고,
            조건이 바뀌었으면 '이전 검색'임을 분명히 한다 */}
        {candidates.length > 0 && !resultsOpen && (
          <button
            type="button"
            onClick={() => setResultsOpen(true)}
            className={`mt-6 flex w-full flex-col items-center gap-1 rounded-md border px-5 py-3 text-sm font-semibold transition-colors ${
              resultsStale
                ? "border-warn bg-warn-surface text-warn"
                : "border-line bg-raised text-primary"
            }`}
          >
            <span className="flex items-center gap-2">
              <IconCompass className="h-4 w-4" />
              {resultsStale ? "이전 검색 결과 보기" : scored.length > 0
                ? `추천 코스 ${scored.length}개 다시 보기`
                : "조건 조정하고 결과 다시 보기"}
            </span>
            {resultRouteText && (
              <span className="text-[11px] font-medium opacity-70">
                {resultRouteText}
                {resultsStale && " (조건 바뀜)"}
              </span>
            )}
          </button>
        )}

        {/* 지도에서 장소 고르기 — 세부 설정을 접어도 열리도록 바깥에 둔다 */}
        <MapPicker
              open={mapPickFor !== null && !restricted}
              title={mapPickFor === "origin" ? "출발지 선택" : mapPickFor === "dest" ? "목적지 선택" : "꼭 들를 곳 선택"}
              initial={originPlace?.coord ?? destPlace?.coord ?? null}
              vehicleTouch={embedded}
              onClose={() => setMapPickFor(null)}
              onPick={(p) => {
                const place: Place = { name: p.name, address: p.address, coord: { lat: p.lat, lng: p.lng } };
                if (mapPickFor === "origin") {
                  locationAbort.current?.abort();
                  locationRequest.current++;
                  setLocating(false);
                  setOriginPlace(place);
                  setOrigin(place.name);
                } else if (mapPickFor === "dest") {
                  setDestPlace(place);
                  setDestination(place.name);
                } else if (mapPickFor === "pin") addPin(place);
                setMapPickFor(null);
              }}
        />

        {/* 검색 결과 팝업 — 필터는 뒤에 남는다. document.body로 포털해 조상의
            transform( 등) containing block에 갇히지 않게 한다
            (임베드 시 모달 fixed가 뷰포트 기준으로 뜨도록). */}
        {resultsOpen &&
          !restricted &&
          candidates.length > 0 &&
          typeof document !== "undefined" &&
          createPortal(
          <div
            data-vehicle-results={embedded ? "" : undefined}
            data-vehicle-touch={embedded ? "" : undefined}
            className="results-overlay fixed inset-0 z-50 flex justify-center bg-bg sm:p-6"
            onClick={() => setResultsOpen(false)}
          >
            <div
              ref={resultsDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="results-title"
              tabIndex={-1}
              onClick={(e) => e.stopPropagation()}
              className={`results-dialog flex max-h-full w-full max-w-3xl flex-col overflow-hidden bg-bg outline-none sm:rounded-md sm:border sm:border-line ${embedded ? "md:max-w-none" : ""}`}
            >
              <div className="flex shrink-0 items-center justify-between gap-3 border-b border-line bg-panel px-5 py-4">
                <div className="min-w-0">
                  <h2
                    id="results-title"
                    className="flex items-center gap-2 text-base font-bold tracking-tight"
                  >
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-accent text-primary">
                      <IconCompass className="h-3.5 w-3.5" />
                    </span>
                    {scored.length > 0
                      ? `추천 코스 ${scored.length}개`
                      : `조건에 맞는 코스 없음 (${candidates.length}개 중)`}
                  </h2>
                  {resultRouteText && (
                    <p className="mt-1 truncate pl-8 text-[12px] text-secondary">
                      {resultRouteText}
                    </p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => setResultsOpen(false)}
                  aria-label="결과 닫기"
                  className="grid h-8 w-8 shrink-0 place-items-center rounded-sm text-secondary transition-colors hover:bg-raised hover:text-primary dark:hover:bg-raised dark:hover:text-primary"
                >
                  <IconClose className="h-5 w-5" />
                </button>
              </div>
              <div className="results-body min-h-0 flex-1 overflow-y-auto px-5 pb-10 pt-1 sm:px-6">
                <div className="results-sidebar">
                  <div className="results-notices">

        {resultsStale && (
          <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-warn bg-warn-surface p-3 text-xs text-warn">
            <span>검색 조건이 바뀌었어요. 이 결과는 이전 검색이에요.</span>
            <button
              type="button"
              onClick={() => {
                setResultsOpen(false);
                void doSearch();
              }}
              className="shrink-0 rounded-sm bg-warn-strong px-4 py-2 text-xs font-semibold text-warn transition-colors"
            >
              현재 조건으로 다시 검색
            </button>
          </div>
        )}

        {/* 에러는 모달 안에서도 보여야 한다 — 밖 배너는 모달에 가려짐 */}
        {error && (
          <div className="mt-2 flex items-start gap-3 rounded-md border border-danger bg-danger-surface p-3 text-xs text-danger dark:border-danger dark:bg-danger-surface dark:text-danger">

            <span>{error}</span>
          </div>
        )}

        {conditions && conditions.notes.length > 0 && candidates.length > 0 && (
          <div className="mt-2 flex items-start gap-3 rounded-md border border-accent bg-accent-surface p-3 text-xs text-accent-text dark:border-accent dark:bg-accent-surface dark:text-accent-text">

            <div className="space-y-1">
              {conditions.notes.map((n) => (
                <p key={n}>{cleanLabel(n)}</p>
              ))}
            </div>
          </div>
        )}

        {notes.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-warn bg-warn-surface p-3 text-xs text-warn dark:border-warn dark:bg-warn-surface dark:text-warn">
            <span>{notes.map((n) => cleanLabel(n)).join(" ")}</span>
            {coastIntensity !== "max" && (
              <button
                type="button"
                onClick={() => {
                  setCoastIntensity("max");
                  doSearch({ coast: "max" });
                }}
                disabled={loading}
                className="rounded-sm bg-warn-strong px-4 py-2 text-xs font-medium text-primary transition-colors disabled:opacity-50"
              >
                최대 강도로 다시 검색
              </button>
            )}
          </div>
        )}

        {budgetMiss && (
          <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-danger bg-danger-surface p-3 text-xs text-danger dark:border-danger dark:bg-danger-surface dark:text-danger">
            <span>
              {searchedBudgetH}시간 코스 없음 (가장 짧은 코스 <b>{formatDuration(minDurationSec)}</b>)
              {pinned.length > 0 && " 필수 경유지가 멀어서 그럴 수 있어요."}
            </span>
            {suggestedBudgetH > searchedBudgetH && (
              <button
                type="button"
                onClick={() => doSearch({ budgetH: suggestedBudgetH })}
                disabled={loading}
                className="rounded-sm bg-danger-strong px-4 py-2 text-xs font-medium text-primary transition-colors disabled:opacity-50"
              >
                {suggestedBudgetH}시간으로 다시 검색
              </button>
            )}
          </div>
        )}

        {resolved && candidates.length > 0 && (
          <>
            <div className="mt-3 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <h2 className="text-sm font-semibold tracking-tight">
                {resolved.to
                  ? `${cleanLabel(resolved.from.name)} – ${cleanLabel(resolved.to.name)}`
                  : `${cleanLabel(resolved.from.name)} 출발 (${searchedBudgetH}시간 순환)`}
              </h2>
              {metricsLoading && (
                <span className="animate-pulse text-xs text-secondary dark:text-secondary">
                  도로 지표 계산 중…
                </span>
              )}
              {excludedCount > 0 && (
                <span className="text-xs text-warn">
                  {excludeSummary || `상한 초과 ${excludedCount}개`} 제외
                </span>
              )}
            </div>
            {/* 확정된 실제 주소 — 동명 장소를 잘못 고르지 않았는지 확인용 */}
            {(resolved.from.address || resolved.to?.address) && (
              <p className="mt-1 truncate text-[12px] text-secondary dark:text-secondary">
                {cleanLabel(resolved.from.address || resolved.from.name)}
                {resolved.to && ` – ${cleanLabel(resolved.to.address || resolved.to.name)}`}
              </p>
            )}

          </>
        )}

        {resolved && candidates.length > 0 && scored.length === 0 && (
          <div className="mt-4 rounded-md border border-warn bg-warn-surface p-3 text-xs text-warn dark:border-warn dark:bg-warn-surface dark:text-warn">
            <p className="font-semibold">
              코스 {candidates.length}개를 만들었지만 조건으로 전부 제외됐어요
            </p>
            {excludeSummary && (
              <p className="mt-1 text-xs text-warn dark:text-warn">
                {excludeSummary}
              </p>
            )}
            {hasCaps && (
              <button
                type="button"
                onClick={resetCaps}
                className="mt-3 rounded-sm bg-warn-strong px-4 py-2 text-xs font-semibold text-primary transition-colors"
              >
                시간·비용 제한 해제
              </button>
            )}
          </div>
        )}

                  </div>
        {selectedCandidate && (() => {
          const c = selectedCandidate;
          return (
            <section className="results-route-content mt-4 space-y-4 pb-12" aria-label="선택 코스">
              {visiblePickedPoi && (
                <PoiCard
                  key={`${poiIdentity}|${visiblePickedPoi.name}`}
                  place={visiblePickedPoi}
                  adding={rerouting}
                  onAdd={() => {
                    if (currentPoiIdentity.current === poiIdentity) addWaypoint(visiblePickedPoi);
                    setPickedPoi(null);
                  }}
                  onClose={() => setPickedPoi(null)}
                />
              )}
              <div className="space-y-2" aria-label="추천 코스 목록">
              {scored.map((c, rank) => (
                <div
                  key={c.label}
                  onClick={() => setSelected(c.label)}
                  className={`results-route-card cursor-pointer rounded-md border bg-panel p-3 ${c.label === selectedLabel ? "border-accent" : "results-route-card-unselected border-line"}`}
                >
                  <button
                    type="button"
                    aria-pressed={c.label === selectedLabel}
                    onClick={() => setSelected(c.label)}
                    className="flex w-full items-center justify-between gap-2 text-left"
                  >
                    <span className="min-w-0 truncate text-sm font-semibold">{rank + 1}. {cleanLabel(c.label)}</span>
                    <span className="shrink-0 text-sm font-semibold text-accent-text">{c.score.total}점</span>
                  </button>
                  <p className="mt-1 flex flex-wrap gap-x-2 text-xs text-secondary">
                    <span className="whitespace-nowrap">총 거리 {(c.distanceM / 1000).toFixed(1)}km</span>
                    <span className="whitespace-nowrap">예상 소요시간 {formatDuration(c.durationSec)}</span>
                  </p>
                  {courseWhy(c, driveStyles) && (
                    <p data-course-why className="mt-1 text-xs text-primary">추천 이유: {courseWhy(c, driveStyles)}</p>
                  )}
                  {resolved && c.label === selectedLabel && <PleosCourseEstimate compact candidate={c} from={resolved.from.coord} destination={resolved.to?.coord ?? null} />}
                  {c.label === selectedLabel && <StyleHighlights candidate={c} styles={driveStyles} />}
                  <button
                    type="button"
                    onClick={async (e) => {
                      e.stopPropagation();
                      setSelected(c.label);
                      // 코스를 Gubi에 물려준다 — 주행 종료 때 예상 vs 실제 비교
                      const planForDrive = {
                        label: c.label,
                        durationSec: c.durationSec,
                        distanceM: c.distanceM,
                        routeSource: c.routeSource,
                        path: encodePolyline(
                          c.path.map((p): [number, number] => [p.lat, p.lng]),
                        ),
                        vias: (c.waypoints ?? [])
                          .filter((w) => !/^해안\d+$/.test(w.name))
                          .slice(0, 20)
                          .map((w) => ({
                            name: w.name,
                            lat: w.coord.lat,
                            lng: w.coord.lng,
                            dwellMin: w.dwellMin ?? 0,
                          })),
                      };
                      if (onDrive) {
                        onDrive(planForDrive);
                        return;
                      }
                      if (BORROW_SERVER) {
                        // 빌려 쓰기 모드: 코스 전달함(/api/drive-plan, 서버 저장)을 쓰지 않고
                        // 같은 주소의 /log가 읽는 세션 보관함으로 넘긴다.
                        // 코스 경로가 담기므로 기기 안 열쇠로 암호화해 둔다(안 되면 평문).
                        try {
                          await writeSecureJson("drivelog-pending-plan-v1", planForDrive, secureDepsFor(sessionStorage));
                        } catch {}
                        window.location.href = withBasePath("/log");
                        return;
                      }
                      try {
                        const res = await fetch("/api/drive-plan", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify(planForDrive),
                        });
                        const data = await res.json();
                        if (!res.ok || typeof data.id !== "string") {
                          throw new Error(data.error ?? "코스를 전달하지 못했어요");
                        }
                        const h = location.hostname;
                        const target = h.startsWith("drive.")
                          ? `${location.protocol}//drivelog.${h.slice(6)}/log`
                          : "/log";
                        window.location.href = `${target}?plan=${encodeURIComponent(data.id)}`;
                      } catch (err) {
                        setError(err instanceof Error ? err.message : "코스를 전달하지 못했어요");
                      }
                    }}
                    className="mt-2 flex min-h-14 w-full items-center justify-center gap-2 rounded-md bg-accent px-4 text-sm font-semibold text-primary transition-colors"
                  >
                    이 코스로 주행
                  </button>
                </div>
              ))}
              </div>
              <section aria-labelledby="course-details-title" className="space-y-3 border-t border-line pt-4">
                <h3 id="course-details-title" className="text-base font-semibold">상세정보</h3>
                <CourseDetails
                  key={`details|${selectedPathKey}`}
                  candidate={c}
                  from={resolved?.from.coord ?? null}
                  destination={resolved?.to?.coord ?? null}
                  durationText={formatDuration(c.durationSec)}
                  motionSickness={motionSickness}
                  rerouting={rerouting}
                  budgetDifference={isLoopResult && Math.abs(c.durationSec - budgetSec) > BUDGET_TOLERANCE_SEC ? formatDiff(c.durationSec - budgetSec) : undefined}
                  onCycleDwell={(index) => cycleDwell(c.label, index)}
                  onRemoveWaypoint={(index) => { if (!rerouting) removeWaypoint(c, index); }}
                />
            {selectedCandidate && (
              <details key={`nearby|${selectedPathKey}`} className="mt-4 rounded-md border border-line bg-raised p-4 dark:border-line dark:bg-panel">
                <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-semibold">
                  이 코스 주변 추천 명소
                  {visibleCourseSpots && visibleCourseSpots.length > 0 && (
                    <span className="rounded-sm bg-ok-surface px-2 py-1 text-[11px] font-medium text-ok dark:bg-ok-surface dark:text-ok">
                      지도에 {visibleCourseSpots.length}곳
                    </span>
                  )}
                  <span className="ml-auto text-xs text-secondary">펼치기</span>
                </summary>
                <div className="mt-3">
                {/* 종류 필터 — 카페만·맛집만·볼거리만 */}
                <div className="flex gap-2">
                  {(
                    [
                      ["all", "전체"],
                      ["cafe", "카페"],
                      ["food", "음식점"],
                      ["sight", "볼거리"],
                      ["gas", "주유소"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      aria-pressed={courseSpotFilter === id}
                      onClick={() => setCourseSpotFilter(id)}
                      className={`rounded-sm px-3 py-1 text-xs font-medium transition-colors ${
                        courseSpotFilter === id
                          ? "bg-accent text-primary"
                          : "bg-raised text-secondary ring-1 ring-inset ring-line"
                      }`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                {/* 카페·맛집만 볼 땐 조금 돌아가도 들를 곳 — 누르면 그곳을 들르는 코스로 */}
                {!visibleCourseSpotsLoading &&
                  (courseSpotFilter === "cafe" ||
                    courseSpotFilter === "food" ||
                    courseSpotFilter === "gas") &&
                  visibleCourseSpots &&
                  visibleCourseSpots.length > 0 && (
                    <ul className="mt-3 divide-y divide-line dark:divide-line">
                      {visibleCourseSpots.slice(0, 6).map((p) => {
                        const off = p.offRouteM ?? 0;
                        // 왕복 우회 대략치: 2×거리, 평균 40km/h
                        const extraMin = Math.max(1, Math.round(((off * 2) / 1000 / 40) * 60));
                        return (
                          <li key={`${p.name}|${p.coord.lat}`} className="flex items-center gap-2 py-2">
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium">{cleanLabel(p.name)}</span>
                              <span className="block truncate text-xs text-secondary">
                                {p.price != null && `${cleanLabel(p.fuel ?? "휘발유")} ${p.price.toLocaleString()}원 `}
                                {p.rating != null && `평점 ${p.rating} `}
                                {off < 300
                                  ? "길가"
                                  : `(+${extraMin}분)`}
                              </span>
                            </span>
                            <button
                              type="button"
                              onClick={() => { if (currentPoiIdentity.current === poiIdentity) addWaypoint(p); }}
                              disabled={rerouting}
                              className="shrink-0 rounded-sm bg-accent px-3 py-1 text-xs font-semibold text-primary disabled:opacity-40"
                            >
                              + 들르기
                            </button>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                {visibleCourseSpotsLoading ? (
                  <p className="mt-2 animate-pulse text-xs text-secondary dark:text-secondary">
                    주변 추천 명소 찾는 중…
                  </p>
                ) : visibleCourseSpotsError ? (
                  <p className="mt-2 flex items-center gap-2 text-xs text-warn dark:text-warn">
                    명소를 불러오지 못했어요
                    <button
                      type="button"
                      onClick={loadCourseSpots}
                      className="underline hover:text-warn dark:hover:text-warn"
                    >
                      다시 시도
                    </button>
                  </p>
                ) : visibleCourseSpots && visibleCourseSpots.length > 0 ? (
                  <p className="mt-2 flex items-center gap-2 text-xs text-secondary dark:text-secondary">
                    지도에 <b className="text-primary dark:text-primary">{visibleCourseSpots.length}곳</b> 표시됨
                    <button
                      type="button"
                      onClick={loadCourseSpots}
                      className="text-secondary underline hover:text-disabled dark:hover:text-primary"
                    >
                      다시 받기
                    </button>
                  </p>
                ) : visibleCourseSpots && visibleCourseSpots.length === 0 ? (
                  <p className="mt-2 flex items-center gap-2 text-xs text-secondary dark:text-secondary">
                    {courseSpotFilter === "gas"
                      ? "이 코스 3km 안엔 주유소가 없어요"
                      : courseSpotFilter === "cafe"
                      ? "이 코스 3km 안엔 카페가 없어요"
                      : courseSpotFilter === "food"
                        ? "코스 3km 안에 음식점이 없어요"
                        : "이 코스 길가에서 추천할 곳을 못 찾았어요"}
                    <button
                      type="button"
                      onClick={loadCourseSpots}
                      className="underline hover:text-disabled dark:hover:text-primary"
                    >
                      다시
                    </button>
                  </p>
                ) : null}
                <details className="mt-3">
                  <summary className="cursor-pointer list-none text-xs font-semibold tracking-wide text-secondary hover:text-primary dark:text-secondary dark:hover:text-primary">
                    직접 찾기 펼치기
                  </summary>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {WAYPOINT_TYPES.map((t) => (
                    <Chip
                      key={t}
                      tone="emerald"
                      active={nearbyTypes.includes(t)}
                      onClick={() => {
                        nearbyAbort.current?.abort();
                        nearbyRequest.current++;
                        setNearbyLoading(false);
                        setNearby(null);
                        setNearbyTypes((prev) =>
                          prev.includes(t)
                            ? prev.filter((v) => v !== t)
                            : [...prev, t],
                        );
                      }}
                    >
                      {t === "맛집" ? "음식점" : t}
                    </Chip>
                  ))}
                  <button
                    type="button"
                    onClick={searchNearby}
                    disabled={visibleNearbyLoading || nearbyTypes.length === 0}
                    className="ml-1 rounded-sm bg-accent px-4 py-1 text-xs font-medium text-primary transition-colors disabled:opacity-40"
                  >
                    {visibleNearbyLoading ? "검색 중…" : "주변 검색"}
                  </button>
                </div>

                {visibleNearby && visibleNearby.length === 0 && (
                  <p className="mt-3 text-xs text-secondary dark:text-secondary">
                    경로 주변에서 찾은 장소가 없어요.
                  </p>
                )}
                {visibleNearby && visibleNearby.length > 0 && (
                  <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                    {visibleNearby.map((p) => (
                      <li
                        key={`${p.name}|${p.address}`}
                        className="flex items-center justify-between gap-2 rounded-md border border-line dark:border-line bg-raised dark:bg-raised px-3 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {cleanLabel(p.name)}
                          </span>
                          <span className="block truncate text-xs text-secondary dark:text-secondary">
                            {p.type ? cleanLabel(p.type) : p.address ? cleanLabel(p.address) : ""}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => { if (currentPoiIdentity.current === poiIdentity) addWaypoint(p); }}
                          disabled={rerouting}
                          className="shrink-0 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-primary transition-colors disabled:opacity-40"
                        >
                          + 경유
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                <form
                  onSubmit={searchWaypoint}
                  className="mt-3 flex items-center gap-2 border-t border-line dark:border-line pt-3"
                >
                  <span className="shrink-0 text-xs text-secondary dark:text-secondary">
                    직접 검색
                  </span>
                  <input
                    value={wpQuery}
                    onChange={(e) => {
                      waypointAbort.current?.abort();
                      waypointRequest.current++;
                      setWpSearching(false);
                      setWpResults(null);
                      setWpQuery(e.target.value);
                    }}
                    placeholder="장소 이름 (예: 경포대)"
                    className="min-w-0 flex-1 rounded-md border border-line dark:border-line px-3 py-2 text-sm outline-none transition-colors placeholder:text-secondary dark:placeholder:text-secondary focus:border-line"
                  />
                  <button
                    type="submit"
                    disabled={wpSearching || !wpQuery.trim()}
                    className="shrink-0 rounded-sm bg-accent px-4 py-2 text-xs font-medium text-primary transition-colors disabled:opacity-40"
                  >
                    {wpSearching ? "검색 중…" : "검색"}
                  </button>
                </form>
                {wpResults && wpResults.length === 0 && (
                  <p className="mt-2 text-xs text-secondary dark:text-secondary">
                    검색 결과가 없어요.
                  </p>
                )}
                {wpResults && wpResults.length > 0 && (
                  <ul className="mt-2 grid gap-2 sm:grid-cols-2">
                    {wpResults.map((p) => (
                      <li
                        key={`${p.name}|${p.address}`}
                        className="flex items-center justify-between gap-2 rounded-md border border-line dark:border-line bg-raised dark:bg-raised px-3 py-2"
                      >
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium">
                            {cleanLabel(p.name)}
                          </span>
                          <span className="block truncate text-xs text-secondary dark:text-secondary">
                            {p.address && cleanLabel(p.address)}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => { if (currentPoiIdentity.current === poiIdentity) addWaypoint(p); }}
                          disabled={rerouting}
                          className="shrink-0 rounded-sm bg-accent px-3 py-1 text-xs font-medium text-primary transition-colors disabled:opacity-40"
                        >
                          + 경유
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                  {rerouting && (
                    <p className="mt-2 animate-pulse text-xs text-secondary dark:text-secondary">
                      경유지 반영해서 재탐색 중…
                    </p>
                  )}
                </details>
                </div>
              </details>
            )}

              </section>
            </section>
          );
        })()}
                </div>
                {selectedCandidate && (
                  <div className="results-map min-w-0 flex-col">
                    <RouteMapOSM
                      heightClass="results-map-surface"
                      vehicleTouch={embedded}
                      routes={scored.map((candidate) => ({
                        label: candidate.label,
                        path: candidate.path,
                        trafficSamples: trafficCache[pathHash(candidate.path)]?.samples,
                        coastSamples: candidate.metrics?.coast,
                        highlights: candidate.highlights,
                      }))}
                      selected={selectedLabel}
                      onRouteClick={setSelected}
                      colorMode={effectiveMapMode === "coast" ? "none" : effectiveMapMode}
                      coastOverlay={effectiveMapMode === "coast"}
                      modeSelector={([
                        ["traffic", "교통", true],
                        ["winding", "와인딩", hasWinding],
                      ] as const).map(([id, label, available]) => (
                        <button
                          key={id}
                          type="button"
                          disabled={!available}
                          aria-pressed={effectiveMapMode === id}
                          title={available ? undefined : `${label} 정보 없음`}
                          aria-label={available ? label : `${label} (이 코스엔 정보 없음)`}
                          onClick={() => setResultMapMode(id)}
                          className={`rounded-sm px-3 py-2 text-[11px] font-medium min-h-9 ${effectiveMapMode === id ? "bg-accent text-primary" : available ? "bg-panel text-primary ring-1 ring-inset ring-line" : "cursor-not-allowed bg-panel text-disabled ring-1 ring-inset ring-line"}`}
                        >{label}</button>
                      ))}
                      pois={[...(visibleCourseSpots ?? []), ...(visibleNearby ?? [])]}
                      onPoiClick={(name) => {
                        const place = [...(visibleCourseSpots ?? []), ...(visibleNearby ?? [])].find((p) => p.name === name);
                        setPickedPoi(place ? { identity: poiIdentity, place } : null);
                      }}
                    />
                    {/* 로드뷰는 지도 아래에 넓게 — 카드 안 작은 칸에선 잘 안 보였다(유저, 2026-11-13) */}
                    <div className="results-map-roadview shrink-0 px-3 pb-3" onClick={(e) => e.stopPropagation()}>
                      <RoadviewStrip
                        key={selectedPathKey}
                        wide
                        path={selectedCandidate.path}
                        // 고른 종류가 있으면 그 풍경만 — 강변·해안을 골랐으면 물이 보이는 지점만 보여 준다
                        styles={driveStyles.length ? driveStyles : selectedCandidate.styleTag ? [selectedCandidate.styleTag] : []}
                        emptyText={
                          driveStyles.some((st) => st === "강변도로" || st === "해안도로")
                          && !driveStyles.some((st) => st === "와인딩" || st === "산길" || st === "직선도로")
                            ? "이 코스엔 로드뷰로 물이 보이는 지점이 없어요"
                            : undefined
                        }
                        // 경로 해시를 섞어 코스별로 캐시를 분리한다(라벨은 검색마다 재사용됨).
                        cacheKey={`${selectedCandidate.label}|${selectedPathKey}`}
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>,
          document.body,
        )}
      </main>
    </div>
  );
}

/**
 * 카드에 보일 "추천 이유" 한 줄 — 코스 성격(강변·해안·와인딩 등) 위주로 짧게.
 * 신호 관련 문구(무신호·신호 적음)는 OSM 신호 자료가 불완전해 카드에선 뺀다.
 */
function courseWhy(c: RouteCandidate, styles: DriveStyle[] = []): string | null {
  // 고른 종류가 있으면 그 종류에 맞는 이유를 먼저 — 해안을 골랐는데 "와인딩 코스"로 나오지 않게
  const km = c.distanceM / 1000;
  const m = c.metrics;
  if (styles.includes("해안도로") && m && m.seaShoreRatio * km >= 1)
    return `바닷가 길 약 ${Math.round(m.seaShoreRatio * km)}km`;
  if (styles.includes("강변도로") && m && m.riverRatio * km >= 1)
    return `강을 따라 달리는 길 약 ${Math.round(m.riverRatio * km)}km`;
  if (styles.includes("와인딩") || styles.includes("산길")) {
    const hp = (c.badges ?? []).find((b) => /헤어핀 \d+개/.test(b));
    if (hp) return cleanLabel(hp);
  }
  const r = buildReason(c);
  if (r) {
    const [hook, extra] = r.split(" — ");
    // 카드에선 쉬운 말로 — "곡률 55°/km · 와인딩 코스" 같은 수치 표현은 상세정보에만 둔다.
    const plain = hook.replace(/^곡률 \d+°\/km · 와인딩 코스$/, "굽잇길이 많은 와인딩 코스");
    return cleanLabel(extra && !extra.includes("신호") ? `${plain} — ${extra}` : plain);
  }
  // 풍경 배지(헤어핀·해안·해발)만 이유로 쓴다 — 단속·카메라·신호 배지는 주의 사항이지 추천 이유가 아니다.
  const b = [...(c.styleTag ? [c.styleTag] : []), ...(c.badges ?? [])].find(
    (x) => !/신호|단속|카메라/.test(x),
  );
  if (b) return cleanLabel(b);
  const stops = (c.waypoints ?? []).map((w) => cleanLabel(w.name)).filter(Boolean).slice(0, 2);
  return stops.length ? `${stops.join("·")} 경유` : null;
}

export default function Page() {
  // 앱(3탭)은 /log. 루트로 들어오면 같은 도메인의 앱으로 보낸다 — 다른 서브도메인
  // 으로 안 튕기고 현재 도메인(drive. 등)을 그대로 메인으로 쓴다.
  useEffect(() => {
    location.replace(withBasePath("/log"));
  }, []);
  return <div className="min-h-screen bg-bg" />;
}
