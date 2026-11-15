import "server-only";

import { loopCount, startLoopStage, withLoopTiming, type LoopTimingToken } from "@/lib/loop-timing";

import { computeBadges } from "@/lib/badges";
import { elevationProfile } from "@/lib/elevation";
import { annotateCourseFitness } from "@/lib/road-fitness-data";
import type { CourseFitness } from "@/lib/road-fitness";
import {
  getDirections,
  jamRatio,
  routePath,
  type NaviRoute,
  type RoutePriority,
} from "@/lib/kakao";
import { trafficAlongPath } from "@/lib/its-speed";
import {
  localLeg,
  localLegCandidates,
  type LocalLeg,
  type LocalRouteOptions,
} from "@/lib/localroute";
import { generateLoops, type LoopOptions } from "@/lib/loop";
import { buildGuidance, reroute } from "@/lib/navguide";
import { styleAnchorsDense, STYLE_VARIANTS } from "@/lib/places";
import {
  buildCoastalChain,
  coastalRouteWithinBudget,
  crawlCoastToward,
  courseLeg,
  exploreLeg,
  routeViaSmooth,
  spineDirectRoute,
  styleAvoid,
} from "@/lib/routing";
import { estimateFuelCost } from "@/lib/scoring/cost";
import { curveMetrics } from "@/lib/scoring/curvature";
import {
  COAST_DETOUR_CAP,
  type AvoidOption,
  type CoastIntensity,
  type CurveMetrics,
  type DriveStyle,
  type LatLng,
  type RouteCandidate,
} from "@/lib/types";

export interface RoutingResult {
  candidates: RouteCandidate[];
  notes: string[];
}

export interface LoopRoutingInput {
  kind: "loop";
  origin: LatLng;
  /** 경유지 체류시간을 뺀 순수 운전 예산. */
  drivingBudgetSec: number;
  /** 사용자에게 표시하는 전체 예산(체류시간 포함). */
  totalBudgetSec: number;
  dwellSec: number;
  options: LoopOptions;
}

export interface DirectionsRoutingInput {
  kind: "directions";
  origin: LatLng;
  destination: LatLng;
  waypoints?: LatLng[];
  avoid: AvoidOption[];
  styles: DriveStyle[];
  coastIntensity: CoastIntensity;
  maxCost: number;
}

export interface LocalRouteRoutingInput {
  kind: "local-route";
  origin: LatLng;
  destination: LatLng;
  waypoints: LatLng[];
  avoid: AvoidOption[];
}

export interface RouteTrafficRoutingInput {
  kind: "route-traffic";
  stops: LatLng[];
}

export type NavMode = "time" | "distance" | "free" | "nojam";

export interface NavFallbackRoutingInput {
  kind: "nav-fallback";
  origin: LatLng;
  destination: LatLng;
  waypoints: LatLng[];
  mode: NavMode;
}

export interface NavRerouteRoutingInput {
  kind: "nav-reroute";
  from: LatLng;
  path: LatLng[];
  fromIdx: number;
  /** 출발 헤딩(°) — 복귀 경로가 뒤로 돌아가지 않게 역방향 시작을 페널티. */
  heading?: number;
}

export interface NavGuidanceRoutingInput {
  kind: "nav-guidance";
  path: LatLng[];
}

export type RoutingJob =
  | LoopRoutingInput
  | DirectionsRoutingInput
  | LocalRouteRoutingInput
  | RouteTrafficRoutingInput
  | NavFallbackRoutingInput
  | NavRerouteRoutingInput
  | NavGuidanceRoutingInput;

export interface BareRouteCandidate {
  fitness?: CourseFitness;
  durationSec: number;
  distanceM: number;
  tollFare: number;
  tollUnknown?: boolean;
  fuelCost: number;
  curve: CurveMetrics;
  path: LatLng[];
  jamRatio?: number | null;
  trafficSamples?: { lat: number; lng: number; state: number }[];
  source?: "local-its";
  estimated?: boolean;
  routeSource?: "local-its" | "kakao";
}

export interface LocalRouteRoutingResult {
  candidate: BareRouteCandidate | null;
}

export interface RouteTrafficRoutingResult {
  samples: { lat: number; lng: number; state: number }[];
  durationSec: number;
  distanceM: number;
  jamRatio: number | null;
  coverage: number;
  source: "its";
}

export interface NavFallbackRoutingResult {
  candidate: BareRouteCandidate | null;
}

export type NavRerouteRoutingResult = ReturnType<typeof reroute>;
export type NavGuidanceRoutingResult = ReturnType<typeof buildGuidance>;

export type RoutingJobResult =
  | RoutingResult
  | LocalRouteRoutingResult
  | RouteTrafficRoutingResult
  | NavFallbackRoutingResult
  | NavRerouteRoutingResult
  | NavGuidanceRoutingResult;

const PRIORITIES: {
  priority: RoutePriority;
  label: string;
  avoid?: "motorway" | "toll";
}[] = [
  { priority: "RECOMMEND", label: "추천" },
  { priority: "TIME", label: "최단시간" },
  { priority: "DISTANCE", label: "최단거리" },
  { priority: "RECOMMEND", label: "국도 위주", avoid: "motorway" },
];

function toCandidate(route: NaviRoute, label: string): RouteCandidate {
  const path = routePath(route);
  return {
    label,
    durationSec: route.summary.duration,
    distanceM: route.summary.distance,
    tollFare: route.summary.fare.toll,
    fuelCost: estimateFuelCost(route.summary.distance),
    curve: curveMetrics(path),
    path,
    // 같은 응답에 실려 오는 실시간 소통 — '정체 회피' 필터가 쓴다 (0콜 추가)
    jamRatio: jamRatio(route) ?? undefined,
    routeSource: "kakao",
  };
}

function joinLocalLegs(stops: LatLng[], options: LocalRouteOptions): LocalLeg | null {
  const legs: LocalLeg[] = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const leg = localLeg(stops[i], stops[i + 1], options);
    if (!leg) return null;
    legs.push(leg);
  }
  const path: LatLng[] = [];
  for (const leg of legs) {
    for (const point of leg.path) {
      const previous = path[path.length - 1];
      if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) path.push(point);
    }
  }
  const distanceM = legs.reduce((sum, leg) => sum + leg.dist, 0);
  return {
    path,
    dur: legs.reduce((sum, leg) => sum + leg.dur, 0),
    dist: distanceM,
    toll: 0,
    juncPerKm:
      legs.reduce((sum, leg) => sum + leg.juncPerKm * leg.dist, 0) /
      Math.max(1, distanceM),
  };
}

function localCandidate(leg: LocalLeg, label: string): RouteCandidate {
  const traffic = trafficAlongPath(leg.path);
  return {
    label,
    durationSec: leg.dur,
    distanceM: leg.dist,
    tollFare: 0,
    tollUnknown: true,
    fuelCost: estimateFuelCost(leg.dist),
    curve: curveMetrics(leg.path),
    path: leg.path,
    jamRatio: traffic.jamRatio ?? undefined,
    estimated: true,
    routeSource: "local-its",
  };
}

function localBaseCandidates(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[] | undefined,
  avoid: AvoidOption[],
): RouteCandidate[] {
  const avoidMotorway = avoid.includes("motorway");
  const stops = [origin, ...(waypoints ?? []), destination];
  const out: RouteCandidate[] = [];
  if (waypoints?.length) {
    const fastest = joinLocalLegs(stops, { objective: "time", avoidMotorway });
    if (fastest) out.push(localCandidate(fastest, "ITS 빠른길"));
  } else {
    const fastest = localLegCandidates(origin, destination, {
      objective: "time",
      avoidMotorway,
      alternatives: 3,
    });
    fastest.forEach((leg, i) =>
      out.push(localCandidate(leg, i === 0 ? "ITS 빠른길" : `ITS 우회 ${i}`)),
    );
  }
  const shortest = joinLocalLegs(stops, { objective: "distance", avoidMotorway });
  if (shortest) out.push(localCandidate(shortest, "최단거리"));
  if (!avoidMotorway) {
    const noMotorway = joinLocalLegs(stops, { objective: "time", avoidMotorway: true });
    if (noMotorway) out.push(localCandidate(noMotorway, "고속도로 회피"));
  }
  return dedupe(out);
}

async function kakaoBaseCandidates(
  origin: LatLng,
  destination: LatLng,
  waypoints: LatLng[] | undefined,
  globalAvoid: AvoidOption[],
): Promise<RouteCandidate[]> {
  const results = await Promise.all(
    PRIORITIES.map(async ({ priority, label, avoid }) => {
      const merged = [...new Set([...globalAvoid, ...(avoid ? [avoid] : [])])];
      const routes = await getDirections(origin, destination, priority, {
        avoid: merged,
        waypoints,
      });
      return routes.map((route, i) =>
        toCandidate(route, i === 0 ? label : `${label} 대안${i}`),
      );
    }),
  );
  return dedupe(results.flat());
}

/** 기준 경로 회랑 또는 실제 해안선을 따라 선택 스타일 후보를 만든다. */
async function styleVariant(
  origin: LatLng,
  destination: LatLng,
  basePath: LatLng[],
  variant: (typeof STYLE_VARIANTS)[number],
  avoid: AvoidOption[],
  maxCoastDurationSec: number,
): Promise<RouteCandidate | null> {
  if (variant.style === "해안도로") {
    const beachChain = await crawlCoastToward(origin, destination, variant.type);
    const seed =
      beachChain.length >= 1
        ? beachChain
        : await styleAnchorsDense(basePath, variant.type);
    if (seed.length < 1) return null;
    const { chain, roadLinear } = await buildCoastalChain(origin, destination, seed);
    if (chain.length < 2) return null;
    if (roadLinear && !Number.isFinite(maxCoastDurationSec)) {
      return spineDirectRoute(
        origin,
        destination,
        chain.map((p) => p.coord),
        avoid,
        variant.label,
        courseLeg,
      );
    }
    return coastalRouteWithinBudget(
      origin,
      destination,
      chain,
      avoid,
      variant.label,
      maxCoastDurationSec,
      !roadLinear,
    );
  }

  const anchors = await styleAnchorsDense(basePath, variant.type);
  if (anchors.length === 0) return null;
  return routeViaSmooth(
    origin,
    destination,
    anchors,
    styleAvoid(variant.style, avoid),
    variant.label,
    variant.style,
  );
}

/** 거리·시간이 거의 같은 경로는 사실상 동일 경로로 보고 제거한다. */
function dedupe(candidates: RouteCandidate[]): RouteCandidate[] {
  const result: RouteCandidate[] = [];
  for (const candidate of candidates) {
    const duplicate = result.some(
      (existing) =>
        Math.abs(existing.distanceM - candidate.distanceM) < 500 &&
        Math.abs(existing.durationSec - candidate.durationSec) < 60,
    );
    if (!duplicate) result.push(candidate);
  }
  return result;
}

function enrich(candidates: RouteCandidate[]): void {
  const endTiming = startLoopStage("worker.enrich");
  try {
  for (const candidate of candidates) {
    annotateCourseFitness(candidate);
    candidate.elevation = elevationProfile(candidate.path) ?? undefined;
    candidate.badges = computeBadges(
      candidate.path,
      candidate.elevation?.maxEle ?? null,
    );
  }
  } finally {
    endTiming?.();
  }
}

async function runLoop(input: LoopRoutingInput): Promise<RoutingResult> {
  const endTiming = startLoopStage("worker.execute");
  try {
  const candidates = await generateLoops(
    input.origin,
    input.drivingBudgetSec,
    input.options,
  );
  loopCount("candidatesReturned", candidates.length);
  enrich(candidates);

  const notes: string[] = [];
  if (input.options.styles?.includes("해안도로")) {
    const coastal = candidates.find((candidate) => candidate.styleTag === "해안도로");
    if (!coastal) {
      notes.push(
        "이 출발지에서는 해안도로 코스를 찾지 못했어요.",
      );
    } else if (
      coastal.durationSec + input.dwellSec >
      input.totalBudgetSec + 1800
    ) {
      notes.push(
        "해안까지 왕복 이동으로 설정 시간을 초과해요.",
      );
    }
  }
  return { candidates, notes };
  } finally {
    endTiming?.();
  }
}

async function runDirections(input: DirectionsRoutingInput): Promise<RoutingResult> {
  const notes: string[] = [];
  const needsKnownToll =
    input.avoid.includes("toll") ||
    (Number.isFinite(input.maxCost) && input.maxCost > 0);
  let candidates = needsKnownToll
    ? await kakaoBaseCandidates(
        input.origin,
        input.destination,
        input.waypoints,
        input.avoid,
      )
    : localBaseCandidates(
        input.origin,
        input.destination,
        input.waypoints,
        input.avoid,
      );

  if (candidates.length === 0) {
    candidates = await kakaoBaseCandidates(
      input.origin,
      input.destination,
      input.waypoints,
      input.avoid,
    );
    notes.push("로컬 도로 연결에 실패한 구간만 카카오 경로로 대체했어요.");
  } else if (!needsKnownToll) {
    notes.push(
      "ITS 실시간 속도로 후보를 계산했어요. 실제 주행 시작 시 카카오 경로로 최종 확인해요.",
    );
  }

  if (input.styles.length > 0 && !input.waypoints && candidates.length > 0) {
    const base = candidates[0];
    const cap = COAST_DETOUR_CAP[input.coastIntensity];
    const maxCoastDurationSec = Number.isFinite(cap)
      ? base.durationSec * (1 + cap)
      : Infinity;
    const selected = STYLE_VARIANTS.filter((variant) =>
      input.styles.includes(variant.style),
    );
    const variants = await Promise.all(
      selected.map((variant) =>
        styleVariant(
          input.origin,
          input.destination,
          base.path,
          variant,
          input.avoid,
          maxCoastDurationSec,
        ),
      ),
    );
    selected.forEach((variant, index) => {
      if (variant.style !== "해안도로") return;
      const candidate = variants[index];
      if (candidate === null) {
        if (Number.isFinite(cap)) {
          notes.push(
            "선택한 해안 강도 안에 드는 해안 경로가 없어 제외했어요. 강도를 높여보세요.",
          );
        }
        return;
      }
      if (!candidate.waypoints?.[0]?.name?.startsWith("해안")) {
        notes.push(
          "해안도로 데이터를 실시간으로 못 받아 해변 기준 근사 경로예요(정확도 낮음). 잠시 후 다시 검색하면 진짜 해안도로로 잡혀요.",
        );
      }
    });
    candidates = dedupe([
      ...candidates,
      ...variants.filter((candidate): candidate is RouteCandidate => candidate !== null),
    ]);
  }

  enrich(candidates);
  return { candidates, notes };
}

async function runLocalRoute(
  input: LocalRouteRoutingInput,
): Promise<LocalRouteRoutingResult> {
  const path: LatLng[] = [];
  let durationSec = 0;
  let distanceM = 0;
  let tollFare = 0;
  let usesLocal = false;
  let current = input.origin;
  for (const next of [...input.waypoints, input.destination]) {
    const leg = await exploreLeg(current, next, input.avoid);
    if (!leg) return { candidate: null };
    for (const point of leg.path) {
      const previous = path[path.length - 1];
      if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) {
        path.push(point);
      }
    }
    durationSec += leg.dur;
    distanceM += leg.dist;
    tollFare += leg.toll;
    usesLocal ||= leg.source === "local-its";
    current = next;
  }
  return {
    candidate: annotateCourseFitness<BareRouteCandidate>({
      durationSec: Math.round(durationSec),
      distanceM: Math.round(distanceM),
      tollFare,
      fuelCost: estimateFuelCost(distanceM),
      curve: curveMetrics(path),
      path,
      estimated: usesLocal,
      routeSource: usesLocal ? "local-its" : "kakao",
      tollUnknown: usesLocal || undefined,
    }),
  };
}

function runRouteTraffic(
  input: RouteTrafficRoutingInput,
): RouteTrafficRoutingResult | null {
  const path: LatLng[] = [];
  let durationSec = 0;
  for (let index = 0; index + 1 < input.stops.length; index++) {
    const leg = localLeg(input.stops[index], input.stops[index + 1]);
    if (!leg) return null;
    durationSec += leg.dur;
    for (const point of leg.path) {
      const previous = path[path.length - 1];
      if (!previous || previous.lat !== point.lat || previous.lng !== point.lng) {
        path.push(point);
      }
    }
  }
  const traffic = trafficAlongPath(path, 350);
  return {
    samples: traffic.samples,
    durationSec: Math.round(durationSec),
    distanceM: Math.round(traffic.distanceM),
    jamRatio: traffic.jamRatio,
    coverage: traffic.coverage,
    source: "its",
  };
}

function runNavFallback(
  input: NavFallbackRoutingInput,
): NavFallbackRoutingResult {
  if (input.mode === "free") return { candidate: null };
  let legs: LocalLeg[];
  if (input.waypoints.length > 0) {
    const joined = joinLocalLegs(
      [input.origin, ...input.waypoints, input.destination],
      {
        objective: input.mode === "distance" ? "distance" : "time",
        avoidJam: input.mode === "nojam",
      },
    );
    legs = joined ? [joined] : [];
  } else {
    legs = localLegCandidates(input.origin, input.destination, {
      objective: input.mode === "distance" ? "distance" : "time",
      alternatives: input.mode === "nojam" ? 3 : 1,
      avoidJam: input.mode === "nojam",
    });
  }
  if (legs.length === 0) return { candidate: null };
  const ranked = legs
    .map((leg) => ({ leg, traffic: trafficAlongPath(leg.path) }))
    .sort((a, b) =>
      input.mode === "nojam"
        ? (a.traffic.jamRatio ?? 1) - (b.traffic.jamRatio ?? 1) ||
          a.leg.dur - b.leg.dur
        : 0,
    );
  const { leg, traffic } = ranked[0];
  return {
    candidate: {
      durationSec: Math.round(leg.dur),
      distanceM: Math.round(leg.dist),
      tollFare: 0,
      tollUnknown: true,
      fuelCost: estimateFuelCost(leg.dist),
      curve: curveMetrics(leg.path),
      path: leg.path,
      jamRatio: traffic.jamRatio,
      trafficSamples: traffic.samples,
      source: "local-its",
      estimated: true,
    },
  };
}

export async function executeRoutingJob(job: RoutingJob, timing?: LoopTimingToken): Promise<RoutingJobResult> {
  if (job.kind === "loop" && timing) {
    return withLoopTiming(timing.requestId, "worker", () => runLoop(job));
  }
  switch (job.kind) {
    case "loop":
      return runLoop(job);
    case "directions":
      return runDirections(job);
    case "local-route":
      return runLocalRoute(job);
    case "route-traffic":
      return runRouteTraffic(job);
    case "nav-fallback":
      return runNavFallback(job);
    case "nav-reroute":
      return reroute(job.from, job.path, job.fromIdx, job.heading);
    case "nav-guidance":
      return buildGuidance(job.path);
  }
}
