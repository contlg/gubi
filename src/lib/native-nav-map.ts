import type { NavMapProps } from "../app/log/NavMap";
import { matchTrafficStates } from "./traffic-match";

export interface NativeNavMapBridge {
  nativeNavMapAvailable?: () => boolean;
  nativeNavMapStatus?: () => "ok" | "no_key" | "unsupported" | "error";
  nativeNavMapShow?: (json: string) => void;
  nativeNavMapHide?: () => void;
  nativeNavMapLayout?: (json: string) => void;
  nativeNavMapData?: (json: string) => void;
  nativeNavMapFix?: (json: string) => void;
  nativeNavMapCommand?: (json: string) => void;
}
export type NativeMapEvent = { generation: number; state?: "ready" | "error"; reason?: string; follow?: boolean };
declare global { interface Window { __nativeNavMap?: (event: NativeMapEvent) => void } }

export function nativeMapBridge(): NativeNavMapBridge | undefined {
  return typeof window === "undefined" ? undefined : window.DriveNative;
}

// 웹 지도의 속도별 확대 곡선을 유지하고 카카오의 정수 확대 단계에 맞춰 제한한다.
export function kakaoZoom(kmh: number, nudge = 0): number {
  const v = Number.isFinite(kmh) ? Math.max(0, kmh) : 0;
  return Math.max(0, Math.min(21, Math.round(16.6 - Math.min(v, 110) / 110 * 1.5
    - Math.min(Math.max(v - 110, 0), 190) / 190 * 1.5 + nudge)));
}

// 굽이 교통 4색(코스 상세와 같음): 정체·지체·서행·원활
const trafficColors: Record<number, string> = { 1: "#E8323C", 2: "#FF7A1A", 3: "#F5B700", 4: "#1DB954" };
export function nativeMapRouteData(props: Pick<NavMapProps, "path" | "traffic" | "special">) {
  const states = matchTrafficStates(props.path, props.traffic);
  const cumulative = [0];
  for (let i = 1; i < props.path.length; i++) {
    const a = props.path[i - 1], b = props.path[i];
    cumulative.push(cumulative[i - 1] + Math.hypot((b.lat - a.lat) * 111320,
      (b.lng - a.lng) * 111320 * Math.cos(b.lat * Math.PI / 180)));
  }
  return {
    path: props.path, colors: props.path.slice(1).map((_, i) => {
      // 코스 특별 구간은 상세 화면처럼 교통색 위에 덧칠한다.
      const mid = (cumulative[i] + cumulative[i + 1]) / 2;
      // 겹치면 뒤의 구간(더 중요한 종류)이 이긴다 — 웹 지도에서 위에 그려지는 순서와 같다.
      let special: string | undefined;
      for (const seg of props.special ?? []) if (mid >= seg.from && mid < seg.to) special = seg.color;
      return special ?? trafficColors[states?.[i] ?? 0] ?? "#38bdf8";
    }),
    cumulative: props.path.length ? cumulative : [],
  };
}

export function nativeMapTrace(trace: NavMapProps["trace"]) {
  if (!trace?.length) return [];
  const stride = trace.length > 1500 ? Math.ceil(trace.length / 1200) : 1;
  if (stride === 1) return trace;
  const sampled = trace.filter((_, i) => i % stride === 0);
  if (sampled[sampled.length - 1] !== trace[trace.length - 1]) sampled.push(trace[trace.length - 1]);
  return sampled;
}

export function nativeMapData(props: NavMapProps) {
  return { ...nativeMapRouteData(props), cams: props.cams, maneuvers: props.maneuvers, trace: nativeMapTrace(props.trace) };
}

export function cssRect(rect: Pick<DOMRect, "left" | "top" | "right" | "bottom">) {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

const geometryProperties = ["transform", "translate", "top", "left", "right", "bottom", "width", "height"];
// 무한 애니메이션이나 색상·투명도 변화는 지도 영역을 다시 측정하지 않는다.
export function nativeMapGeometryAnimating(animation: Animation): boolean {
  const effect = animation.effect as KeyframeEffect | null;
  return animation.playState === "running" && !!effect && Number.isFinite(effect.getTiming().iterations)
    && effect.getKeyframes().some((frame) => geometryProperties.some((property) => property in frame));
}

let sequence = 0;
// 지도 시작 제한 시간은 안드로이드가 관리하고 정리 후 지연 콜백은 거부한다.
export function nativeMapSession(
  bridge: NativeNavMapBridge,
  onFollow: (follow: boolean) => void,
  onError: (reason: string) => void,
) {
  const generation = ++sequence;
  let active = true;
  function fail(reason: string) {
    if (!active) return;
    active = false;
    try { bridge.nativeNavMapHide?.(); } catch {}
    onError(reason);
  }
  return {
    generation,
    receive(event: NativeMapEvent) {
      if (!active || !event || event.generation !== generation) return;
      if (event.state === "error") { fail(event.reason ?? "map_error"); return; }
      if (typeof event.follow === "boolean") onFollow(event.follow);
    },
    fail,
    close() {
      active = false;
      try { bridge.nativeNavMapHide?.(); } catch {}
    },
  };
}
