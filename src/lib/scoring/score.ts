import type {
  ConditionAdjustments,
  DriveStyle,
  RouteCandidate,
  RouteMetrics,
} from "@/lib/types";
import { fitnessPenalty } from "@/lib/road-fitness";

export type PresetId = "fun" | "scenic" | "balanced";

export interface Weights {
  fun: number;
  scenery: number;
  time: number;
  cost: number;
}

export interface ScoreOptions {
  /** 프리셋 대신 쓸 커스텀 가중치 (합이 1이 아니어도 내부 정규화) */
  weights?: Weights;
  /** 동승자 멀미 배려 — 와인딩이 가점 대신 감점이 된다 */
  motionSickness?: boolean;
  /** 신호 적은 길 선호 — 신호등 밀도를 감점 항목으로 추가 */
  preferFewSignals?: boolean;
  /** 터널 기피 — 터널 비율을 감점 항목으로 추가 */
  avoidTunnels?: boolean;
  /** 드라이브 종류 — 선택된 종류마다 해당 성격에 가중치를 얹는다 */
  driveStyles?: DriveStyle[];

  adjustments?: ConditionAdjustments | null;
}

export interface ScoreBreakdown {
  /** 0~100. scenery는 데이터 로딩 전이면 null */
  fun: number;
  scenery: number | null;
  time: number;
  cost: number;
  total: number;
}

export type ScoredCandidate = RouteCandidate & { score: ScoreBreakdown };

/** 이 이상의 와인딩 지수(°/km)는 재미 만점으로 취급 */
const WINDING_CAP = 80;
/** 이 이상의 봉우리 밀도(개/km)는 산길 만점으로 취급 */
const PEAK_DENSITY_CAP = 0.3;
/** 이 이상의 신호등 밀도(개/km)는 최악으로 취급 */
const SIGNAL_DENSITY_CAP = 0.8;
/** 터널 감점이 최대가 되는 터널 비율 */
const TUNNEL_RATIO_CAP = 0.2;
/** 신호/터널 토글이 켜졌을 때 각각 가져가는 가중치 */
const EXTRA_CRITERION_WEIGHT = 0.15;
/** 드라이브 종류 하나가 가져가는 가중치 */
const STYLE_WEIGHT = 0.3;
/** 강 인접 비율은 절대값이 작아 배율로 감도를 키운다 */
const RIVER_SCALE = 2.5;

/** OSM 지표 로딩이 필요한 드라이브 종류 */
const STYLE_NEEDS_METRICS: Record<DriveStyle, boolean> = {
  와인딩: false,
  직선도로: false,
  산길: true,
  해안도로: true,
  강변도로: true,
};

function styleGoodness(
  style: DriveStyle,
  winding: number,
  m: RouteMetrics | undefined,
  adj: ConditionAdjustments,
  tag?: DriveStyle,
): number {
  // 스타일 변형으로 만들어진 후보는 OSM 지표 로딩 전에도 높은 점수를 선반영
  const tagPrior = tag === style ? 0.85 : 0;
  switch (style) {
    case "와인딩":
      return winding;
    case "직선도로":
      return 1 - winding;
    case "산길":
      return m
        ? Math.min(m.peaksPerKm / PEAK_DENSITY_CAP, 1) * adj.mountainMul
        : tagPrior * adj.mountainMul;
    case "해안도로":
      return m
        ? Math.max(Math.min(seaGoodness(m) * adj.seaMul, 1), tagPrior * 0.5)
        : tagPrior;
    case "강변도로":
      return m ? Math.min(m.riverRatio * RIVER_SCALE, 1) : tagPrior;
  }
}

export const PRESETS: Record<PresetId, { label: string; weights: Weights }> = {
  fun: {
    label: "운전 재미",
    weights: { fun: 0.6, scenery: 0.1, time: 0.15, cost: 0.15 },
  },
  scenic: {
    label: "풍경",
    weights: { fun: 0.15, scenery: 0.5, time: 0.2, cost: 0.15 },
  },
  balanced: {
    label: "균형",
    weights: { fun: 0.25, scenery: 0.25, time: 0.25, cost: 0.25 },
  },
};

const NO_ADJUSTMENTS: ConditionAdjustments = { funMul: 1, mountainMul: 1, seaMul: 1 };

/** 바닷가(해안선 250m 이내)는 100%, 바다뷰(250~800m)는 60%로 친다 */
function seaGoodness(m: RouteMetrics): number {
  return Math.min(m.seaShoreRatio + 0.6 * m.seaViewRatio, 1);
}

function sceneryGoodness(m: RouteMetrics, adj: ConditionAdjustments): number {
  return Math.min(
    0.5 * seaGoodness(m) * adj.seaMul +
      0.2 * m.riverRatio +
      0.3 * Math.min(m.peaksPerKm / PEAK_DENSITY_CAP, 1) * adj.mountainMul,
    1,
  );
}

/**
 * 후보들을 가중치로 점수화해 총점 내림차순으로 정렬한다.
 * - 재미: 와인딩 지수를 절대 스케일로 정규화 (멀미 모드면 반전)
 * - 풍경: 바다/강 인접 비율 + 봉우리 밀도 (날씨/노을 보정 적용)
 * - 시간/비용: 후보 중 최솟값 대비 비율
 * - 신호/터널 토글: 켜지면 감점 항목으로 가중치에 편입
 * - OSM 지표가 전 후보에 로딩되기 전엔 해당 가중치를 나머지에 재분배
 */
export function scoreCandidates(
  candidates: RouteCandidate[],
  preset: PresetId,
  opts: ScoreOptions = {},
): ScoredCandidate[] {
  if (candidates.length === 0) return [];

  const adj = opts.adjustments ?? NO_ADJUSTMENTS;
  // durationSec가 0인 이상 후보(라우팅 실패 등)가 섞이면 min이 0이 돼 정상
  // 후보의 시간 점수(min/dur)가 전부 0으로 붕괴한다 — 양수 값만으로 min을 낸다.
  const posDur = candidates.map((c) => c.durationSec).filter((d) => d > 0);
  const minDuration = posDur.length > 0 ? Math.min(...posDur) : 0;
  const minCost = Math.min(...candidates.map((c) => c.tollFare + c.fuelCost));
  const metricsReady = candidates.every((c) => c.metrics);

  // 기본 4개 + 선택 항목(신호/터널/드라이브 종류)의 가중치 테이블 구성
  const base = opts.weights ?? PRESETS[preset].weights;
  const w = {
    fun: Math.max(base.fun, 0) * adj.funMul,
    scenery: metricsReady ? Math.max(base.scenery, 0) : 0,
    time: Math.max(base.time, 0),
    cost: Math.max(base.cost, 0),
    signals: metricsReady && opts.preferFewSignals ? EXTRA_CRITERION_WEIGHT : 0,
    tunnels: metricsReady && opts.avoidTunnels ? EXTRA_CRITERION_WEIGHT : 0,
  };
  const activeStyles = (opts.driveStyles ?? []).filter(
    (s) =>
      metricsReady ||
      !STYLE_NEEDS_METRICS[s] ||
      // 지표 로딩 전이라도 해당 스타일 변형 후보가 있으면 태그 기반으로 반영
      candidates.some((c) => c.styleTag === s),
  );
  const sum =
    w.fun +
    w.scenery +
    w.time +
    w.cost +
    w.signals +
    w.tunnels +
    activeStyles.reduce((sum, style) => sum + STYLE_WEIGHT * (style === "와인딩" ? adj.funMul : 1), 0);
  if (sum <= 0) return candidates.map((c) => withScore(c, 0, null, 0, 0, 0));

  return candidates
    .map((c): ScoredCandidate => {
      const winding = Math.min(c.curve.degPerKm / WINDING_CAP, 1);
      const fun = opts.motionSickness ? 1 - winding : winding;
      const scenery =
        metricsReady && c.metrics ? sceneryGoodness(c.metrics, adj) : 0;
      const time = c.durationSec > 0 ? minDuration / c.durationSec : 1;
      const totalCost = c.tollFare + c.fuelCost;
      const cost = totalCost > 0 ? minCost / totalCost : 1;
      const signals = c.metrics
        ? 1 - Math.min(c.metrics.signalsPerKm / SIGNAL_DENSITY_CAP, 1)
        : 0;
      const tunnels = c.metrics
        ? 1 - Math.min(c.metrics.tunnelRatio / TUNNEL_RATIO_CAP, 1)
        : 0;

      const styleSum = activeStyles.reduce(
        (acc, s) =>
          acc + STYLE_WEIGHT * (s === "와인딩" ? adj.funMul : 1) * styleGoodness(s, winding, c.metrics, adj, c.styleTag),
        0,
      );
      const total = Math.round(
        (100 *
          (w.fun * fun +
            w.scenery * scenery +
            w.time * time +
            w.cost * cost +
            w.signals * signals +
            w.tunnels * tunnels +
            styleSum)) /
          sum,
      );
      return withScore(
        c,
        Math.round(fun * 100),
        c.metrics ? Math.round(sceneryGoodness(c.metrics, adj) * 100) : null,
        Math.round(time * 100),
        Math.round(cost * 100),
        Math.max(0, Math.round(total - fitnessPenalty(c.fitness))),
      );
    })
    .sort((a, b) => b.score.total - a.score.total);
}

function withScore(
  c: RouteCandidate,
  fun: number,
  scenery: number | null,
  time: number,
  cost: number,
  total: number,
): ScoredCandidate {
  return { ...c, score: { fun, scenery, time, cost, total } };
}
