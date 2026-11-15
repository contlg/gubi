"use client";

import CourseDetailInfo from "@/components/CourseDetailInfo";
import { IconClose, IconAlert, IconMap, IconNav, IconSearch, IconPin, IconUser } from "@/components/icons";
import { PleosCourseBattery } from "@/components/PleosInfo";
import { cleanLabel } from "@/lib/display-text";
import { buildReason } from "@/lib/reason";
import type { ScoredCandidate } from "@/lib/scoring/score";
import type { LatLng } from "@/lib/types";

const availableNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

function RoadStatIcon({ kind }: { kind: "signals" | "tunnel" | "bridge" }) {
  return <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.8">
    {kind === "signals" ? <><rect x="8" y="2" width="8" height="16" rx="2" /><path d="M12 18v4" /><circle cx="12" cy="6" r="1" /><circle cx="12" cy="10" r="1" /><circle cx="12" cy="14" r="1" /></>
      : kind === "tunnel" ? <><path d="M3 21V11a9 9 0 0 1 18 0v10M7 21V11a5 5 0 0 1 10 0v10M12 15v3m0 2v2" /></>
        : <><path d="M2 15h20M6 5v17M18 5v17M2 8c6 6 14 6 20 0M10 12v3m4-3v3" /></>}
  </svg>;
}

function ElevationGraph({ elevation }: { elevation: NonNullable<ScoredCandidate["elevation"]> }) {
  const { samples, maxEle, minEle } = elevation;
  const width = 240, height = 40;
  const range = Math.max(maxEle - minEle, 1);
  const points = samples.map((value, index) =>
    `${((index / Math.max(1, samples.length - 1)) * width).toFixed(1)},${(height - 3 - ((value - minEle) / range) * (height - 8)).toFixed(1)}`,
  ).join(" ");
  return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="고도 종단면" preserveAspectRatio="none" className="h-10 w-full rounded-md bg-accent-surface">
    <polygon points={`0,${height} ${points} ${width},${height}`} className="fill-teal-200/50 dark:fill-teal-800/30" />
    <polyline points={points} className="fill-none stroke-teal-500 dark:stroke-teal-400" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
  </svg>;
}

export default function CourseDetails({ candidate: c, from, destination, durationText, motionSickness, rerouting, budgetDifference, onCycleDwell, onRemoveWaypoint }: {
  candidate: ScoredCandidate;
  from: LatLng | null;
  destination: LatLng | null;
  durationText: string;
  motionSickness: boolean;
  rerouting: boolean;
  budgetDifference?: string;
  onCycleDwell: (index: number) => void;
  onRemoveWaypoint: (index: number) => void;
}) {
  const metrics = c.metrics;
  const cost = c.fuelCost + (c.tollUnknown ? 0 : c.tollFare);
  const estimateExplanation = "실측 데이터로 보정된 로컬 지도 추정치예요. 교외·시골 기준 오차는 약 ±10%예요.";
  const scores = [
    { label: motionSickness ? "직선 위주" : "와인딩", value: c.score.fun, explanation: `곡률 ${c.curve.degPerKm}°/km. ${buildReason(c) ? cleanLabel(buildReason(c)!) : ""}${motionSickness ? " 멀미 방지를 위해 커브가 적은 길에 높은 점수를 줘요." : ""}` },
    { label: "풍경", value: c.score.scenery, explanation: metrics ? `바닷가 ${Math.round(metrics.seaShoreRatio * 100)}%, 강 ${Math.round(metrics.riverRatio * 100)}%` : "도로 지표 계산 중이에요." },
    { label: "시간", value: c.score.time, explanation: "후보 코스의 소요시간을 비교한 점수예요." },
    { label: "비용", value: c.score.cost, explanation: "후보 코스의 연료비와 통행료를 비교한 점수예요." },
  ];
  // Cameras, section enforcement and signal-free distance exist only as badges.
  // Preserve their producer's conservative thresholds and approximate wording.
  const stats = [
    ...(availableNumber(metrics?.signalsPerKm) && availableNumber(c.distanceM) ? [{ kind: "signals" as const, label: "신호", value: `약 ${Math.round(metrics.signalsPerKm * c.distanceM / 1000)}개` }] : []),
    ...(availableNumber(metrics?.tunnelRatio) && availableNumber(c.distanceM) ? [{ kind: "tunnel" as const, label: "터널", value: `약 ${(metrics.tunnelRatio * c.distanceM / 1000).toFixed(1)}km` }] : []),
    ...(availableNumber(metrics?.bridgeCount) ? [{ kind: "bridge" as const, label: "교량", value: `${metrics.bridgeCount}개` }] : []),
  ];
  const fitness = c.fitness;
  const fitnessStats = [
    { label: "비포장", Icon: IconMap, value: fitness ? `${Math.round(fitness.unpavedM).toLocaleString()}m` : "정보 없음", explanation: "OSM에서 확인된 비포장 길이예요." },
    { label: "협로", Icon: IconAlert, value: fitness ? `${Math.round(fitness.narrowM).toLocaleString()}m` : "정보 없음", explanation: "1차로 이하 또는 폭 4.5m 미만으로 확인된 길이예요." },
    { label: "역방향", Icon: IconNav, value: fitness ? `${Math.round(fitness.againstOnewayM).toLocaleString()}m` : "정보 없음", explanation: "저장된 일방통행 방향과 반대로 지나는 길이예요." },
    { label: "노면 미확인", Icon: IconSearch, value: fitness ? `${Math.round(fitness.unknownRatioPct)}%` : "정보 없음", explanation: "전체 코스 중 노면 자료가 없는 거리 비율이에요. 점수는 깎지 않아요." },
    { label: "사고다발", Icon: IconPin, value: fitness?.hotspots.accident != null ? `${fitness.hotspots.accident}곳` : "정보 없음", explanation: "경로 50m 이내 TAAS 사고다발 지점 수예요." },
    { label: "보호구역 사고", Icon: IconUser, value: fitness?.hotspots.schoolZone != null ? `${fitness.hotspots.schoolZone}곳` : "정보 없음", explanation: "경로 50m 이내 어린이보호구역 어린이 사고다발 지점 수예요." },
  ];
  return <>
    <dl className="grid grid-cols-2 gap-3">
      <div className="min-w-0 rounded-md bg-raised p-3">
        <dt className="text-xs text-secondary">시간</dt>
        <dd><CourseDetailInfo label={`시간 ${c.estimated ? "약 " : ""}${durationText}`} value={<span className="text-xl font-semibold tabular-nums">{c.estimated && <small className="mr-1 text-xs font-normal">약</small>}{durationText}</span>}>
          주행 시간 {durationText}. {c.estimated && estimateExplanation}
        </CourseDetailInfo></dd>
      </div>
      <div className="min-w-0 rounded-md bg-raised p-3">
        <dt className="text-xs text-secondary">거리</dt>
        <dd><CourseDetailInfo align="end" label={`거리 ${c.estimated ? "약 " : ""}${(c.distanceM / 1000).toFixed(1)}km`} value={<span className="text-xl font-semibold tabular-nums">{c.estimated && <small className="mr-1 text-xs font-normal">약</small>}{(c.distanceM / 1000).toFixed(1)}<small className="ml-1 text-xs font-normal">km</small></span>}>
          선택 코스 전체 거리예요. {c.estimated && estimateExplanation}
        </CourseDetailInfo></dd>
      </div>
      <div className="min-w-0 rounded-md bg-raised p-3">
        <dt className="text-xs text-secondary">도착 배터리</dt>
        <dd>{from ? <PleosCourseBattery candidate={c} from={from} destination={destination} /> : <span className="inline-block py-2 text-xl font-semibold">정보 없음</span>}</dd>
      </div>
      <div className="min-w-0 rounded-md bg-raised p-3">
        <dt className="text-xs text-secondary">비용</dt>
        <dd><CourseDetailInfo align="end" label={`비용 ${cost.toLocaleString()}원${c.tollUnknown ? ", 통행료 미확인" : ""}`} value={<span className="text-xl font-semibold tabular-nums">{cost.toLocaleString()}<small className="ml-1 text-xs font-normal">원</small></span>}>
          연료비 {c.fuelCost.toLocaleString()}원, 통행료 {c.tollUnknown ? "미확인 (합계에서 제외)" : `${c.tollFare.toLocaleString()}원`}.
        </CourseDetailInfo>
        {c.tollUnknown && <span className="block text-xs text-warn">통행료 미확인</span>}</dd>
      </div>
    </dl>

    <div className="grid grid-cols-2 gap-x-4 gap-y-2" aria-label="코스 점수">
      {scores.map(({ label, value, explanation }, index) => <CourseDetailInfo key={label} align={index % 2 ? "end" : "start"} label={`${label} ${value == null ? "계산 중" : `${value}점`}`} value={<>
        <span className="flex items-baseline justify-between gap-2 text-sm"><span>{label}</span><span className="font-semibold tabular-nums">{value ?? "—"}</span></span>
        {value != null ? <span role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={value} aria-valuetext={`${value}점`} className="mt-2 block h-1.5 overflow-hidden rounded-sm bg-raised"><span className="block h-full bg-accent" style={{ width: `${Math.max(0, Math.min(100, value))}%` }} /></span> : <span className="sr-only">계산 중</span>}
      </>}>{explanation}</CourseDetailInfo>)}
    </div>

    {(c.elevation || availableNumber(metrics?.peaksPerKm)) && <div className="space-y-1">
      {c.elevation && <>
        {c.elevation.maxEle - c.elevation.minEle >= 50 && <ElevationGraph elevation={c.elevation} />}
        <p className="text-xs text-secondary">고도 {Math.round(c.elevation.minEle).toLocaleString()}–{Math.round(c.elevation.maxEle).toLocaleString()}m</p>
      </>}
      <details className="text-xs text-secondary">
        <summary className="min-h-11 cursor-pointer py-3" aria-label="고도·봉우리 더보기">더보기</summary>
        <div className="space-y-1 pb-2">
          {c.elevation && <p>오르막 누적 {Math.round(c.elevation.gainM).toLocaleString()}m</p>}
          {availableNumber(metrics?.peaksPerKm) && <p>봉우리 {metrics.peaksPerKm.toFixed(2)}/km</p>}
        </div>
      </details>
    </div>}

    <div className="grid grid-cols-3 gap-2" aria-label="도로 지표">
      {stats.map(({ kind, label, value }, index) => <CourseDetailInfo key={kind} align={index % 3 === 2 ? "end" : "start"} className="min-w-0 rounded-md bg-raised p-2" label={`${label} ${value}`} value={<span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1 break-keep text-xs text-secondary"><RoadStatIcon kind={kind} />{label}</span>
        <span className="text-sm font-semibold tabular-nums">{value}</span>
      </span>}>
        {label} {value}. 로컬 지도(OSM) 데이터 기준이에요.
      </CourseDetailInfo>)}
    </div>

    <div className="grid grid-cols-3 gap-2" aria-label="도로 적합성">
      {fitnessStats.map(({ label, Icon, value, explanation }, index) => <CourseDetailInfo key={label} align={index % 3 === 2 ? "end" : "start"} className="min-w-0 rounded-md bg-raised p-2" label={`${label} ${value}`} value={<span className="flex min-w-0 flex-col gap-1">
        <span className="flex items-center gap-1 break-keep text-xs text-secondary"><Icon size={16} className="shrink-0" />{label}</span>
        <span className="text-sm font-semibold tabular-nums">{value}</span>
      </span>}>{explanation}</CourseDetailInfo>)}
    </div>
    <CourseDetailInfo label={`폭·차로 확인 ${fitness ? `${Math.round(fitness.widthKnownPct)}%` : "정보 없음"}`} value={<span className="text-xs text-secondary">폭·차로 확인 <span className="tabular-nums">{fitness ? `${Math.round(fitness.widthKnownPct)}%` : "정보 없음"}</span></span>}>
      전체 코스 중 폭 또는 차로 수가 확인된 거리 비율이에요. 표시용이며 점수에 반영하지 않아요.
    </CourseDetailInfo>
    <p className="text-xs text-secondary"><a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">© OpenStreetMap contributors</a> · <a href="https://opendata.koroad.or.kr/" target="_blank" rel="noreferrer">도로교통공단 TAAS</a></p>

    {c.waypoints?.some((waypoint) => !/^해안\d+$/.test(waypoint.name)) && <div className="flex flex-wrap items-center gap-2" aria-label="경유지">
      <span className="text-xs text-secondary">경유</span>
      {c.waypoints.map((waypoint, index) => /^해안\d+$/.test(waypoint.name) ? null : <span key={`${waypoint.name}|${index}`} className="flex items-center gap-1 rounded-sm bg-accent-surface pl-3 text-xs font-medium text-accent-text">
        {cleanLabel(waypoint.name)}
        <button type="button" onClick={() => onCycleDwell(index)} aria-label={`${cleanLabel(waypoint.name)} 체류 시간 변경, 현재 ${waypoint.dwellMin ?? 0}분`} title="체류 시간: 0–15–30–60–90분 순환" className="min-h-11 rounded-sm px-2 font-semibold tabular-nums focus-visible:outline-2 focus-visible:outline-accent">체류 {waypoint.dwellMin ?? 0}분</button>
        <button type="button" disabled={rerouting} onClick={() => onRemoveWaypoint(index)} aria-label={`${cleanLabel(waypoint.name)} 경유지 제거, 현재 체류 ${waypoint.dwellMin ?? 0}분`} className="grid h-11 w-11 place-items-center rounded-sm disabled:opacity-40 focus-visible:outline-2 focus-visible:outline-accent"><IconClose size={16} /></button>
      </span>)}
    </div>}

    {(availableNumber(c.jamRatio) || budgetDifference) && <div className="flex flex-wrap gap-2 text-xs">
      {availableNumber(c.jamRatio) && <CourseDetailInfo label={`교통 ${c.jamRatio >= 0.05 ? `정체 ${Math.round(c.jamRatio * 100)}%` : "원활"}`} value={<span className={c.jamRatio >= 0.15 ? "text-danger" : c.jamRatio >= 0.05 ? "text-warn" : "text-ok"}>{c.jamRatio >= 0.05 ? `정체 ${Math.round(c.jamRatio * 100)}%` : "원활"}</span>}>검색 시점 실시간 정체·지체 구간 비율이에요.</CourseDetailInfo>}
      {budgetDifference && <span className={`py-3 ${budgetDifference.startsWith("+") ? "text-danger" : "text-secondary"}`}>{budgetDifference.startsWith("+") ? `고른 시간보다 ${budgetDifference.slice(1)} 길어요` : `고른 시간보다 ${budgetDifference.replace(/^[-−]/, "")} 짧아요`}</span>}
    </div>}
  </>;
}
