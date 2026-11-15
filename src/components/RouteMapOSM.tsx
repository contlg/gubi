"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { loadKakaoSdk } from "@/lib/kakao-sdk";
import { cleanLabel } from "@/lib/display-text";
import { curvatureSegments, distanceM } from "@/lib/scoring/curvature";
import type { LatLng } from "@/lib/types";

/**
 * 코스추천 지도 — 공식 카카오맵 JS SDK. 다중 경로 + 선택 강조, 색상모드
 * (기본·속도·와인딩·실시간), 해안 오버레이, 도로 클릭(스냅)·명품 구간 배지·
 * 명소 핀, ＋/－·전체 보기·전체화면 버튼을 지원한다. 지도는 항상 일반(도로) 지도이고,
 * 시점은 항상 "선택한 코스" 경로에 맞춘다.
 */

/** 선택 코스 맞춤 여백(px) — 카카오 setBounds(bounds, 위, 오른쪽, 아래, 왼쪽) 순서.
 *  공용 지도는 위쪽 단추 두 줄(~160px)과 아래 코스 번호 칩(~96px)을 피한다. */
const FIT_PAD_SHARED = { top: 160, right: 48, bottom: 96, left: 48 };
const FIT_PAD_SINGLE = { top: 48, right: 48, bottom: 72, left: 48 };
/** 맞춤 직후 이 시간 동안은 프로그램이 낸 확대 이벤트를 사용자 조작으로 보지 않는다 */
const FIT_EVENT_GUARD_MS = 500;

/** 해안 색칠 반경/색 — 카카오 버전과 동일 규칙 */
const COAST_SAMPLE_RADIUS_M = 450;
const WAYPOINT_FALLBACK_RADIUS_M = 600;
const SHORE_COLOR = "#047857"; // 바닷가(진짜 해안도로)
const VIEW_COLOR = "#34d399"; // 바다뷰
const PLAIN_COLOR = "#fb6550"; // 코럴 브랜드(기본)
const TRAFFIC_MATCH_M = 600;
const TRAFFIC_COLORS: Record<number, string> = {
  1: "#e11d48",
  2: "#f97316",
  3: "#facc15",
  4: "#22c55e",
};

/** 와인딩 지수(°/km) – 파랑(직선)~핑크(와인딩) */
export function windingColor(degPerKm: number): string {
  const stops = [
    [59, 130, 246],
    [139, 92, 246],
    [236, 72, 153],
  ];
  const x = Math.min(degPerKm / 80, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}
/** 속도(km/h) – 빨강(느림)~파랑(빠름) */
function speedColor(kmh: number): string {
  const stops = [
    [239, 68, 68],
    [245, 158, 11],
    [34, 197, 94],
    [37, 99, 235],
  ];
  const x = Math.min(Math.max((kmh - 25) / 65, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

const SPOT_LABEL: Record<string, string> = {
  관광명소: "위치",
  전망대: "전망",
  해변: "해변",
  "강/호수": "강변",
  카페: "카페",
  맛집: "음식점",
  휴게소: "도로",
  주유소: "주유",
};

export type ColorMode = "none" | "speed" | "winding" | "traffic";

export interface RouteLine {
  label: string;
  path: LatLng[];
  coastalWaypoints?: LatLng[];
  coastSamples?: { lat: number; lng: number; tier: 1 | 2 }[];
  speedSamples?: { lat: number; lng: number; kmh: number }[];
  trafficSamples?: { lat: number; lng: number; state: number }[];
  highlights?: { name: string; path: LatLng[] }[];
}

export default function RouteMapOSM({
  routes,
  path,
  selected,
  onRouteClick,
  modeSelector,
  colorMode = "none",
  coastOverlay = false,
  onRoadClick,
  roadHighlight,
  pois,
  onPoiClick,
  poiCard,
  heightClass = "h-80",
  vehicleTouch = false,
}: {
  routes?: RouteLine[];
  path?: LatLng[];
  selected?: string;
  onRouteClick?: (label: string) => void;
  modeSelector?: ReactNode;
  colorMode?: ColorMode;
  coastOverlay?: boolean;
  onRoadClick?: (p: LatLng) => void;
  roadHighlight?: { lines: LatLng[][] } | null;
  pois?: { name: string; coord: LatLng; type?: string }[];
  onPoiClick?: (name: string) => void;
  poiCard?: ReactNode;
  heightClass?: string;
  /** 차량 화면: 전체화면(body 포털)에서도 큰 터치 단추 규칙을 받게 한다 */
  vehicleTouch?: boolean;
}) {
  const routeList: RouteLine[] = routes ?? (path ? [{ label: "_", path }] : []);
  const selLabel = selected ?? routeList[0]?.label;
  const selRoute = routeList.find((r) => r.label === selLabel) ?? routeList[0];
  const sharedMap = !!onRouteClick;

  const mapEl = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const overlays = useRef<any[]>([]);
  const [full, setFull] = useState(false);
  // 지도 세대 — 0은 준비 전. 지도를 새로 만들 때마다 값이 달라져야 종류·그리기·
  // 시점 효과가 새 지도에 다시 돈다(불리언은 false→true가 한 번에 묶여 안 바뀐다).
  const genRef = useRef(0);
  const [mapGen, setMapGen] = useState(0);
  const ready = mapGen > 0;
  const [error, setError] = useState(false);
  const [zoomed, setZoomed] = useState(false);
  // 사용자가 직접 움직였는지 — 이벤트·ResizeObserver 콜백에서 읽으려고 ref에도 둔다
  const zoomedRef = useRef(false);
  const fitGuardUntil = useRef(0);
  const markZoomed = (v: boolean) => {
    zoomedRef.current = v;
    setZoomed(v);
  };

  const latest = useRef({ onRouteClick, onRoadClick, onPoiClick, selPath: selRoute?.path });
  latest.current = { onRouteClick, onRoadClick, onPoiClick, selPath: selRoute?.path };

  const fitKey = sharedMap
    ? JSON.stringify(routeList.map((r) => [r.label, r.path]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
    : JSON.stringify([selLabel, selRoute?.path]);
  const prev = useRef({ fitKey: "", selLabel: "" });

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setFull(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [full]);

  const boundsOf = (list: LatLng[][]) => {
    const k = window.kakao.maps;
    const b = new k.LatLngBounds();
    let n = 0;
    for (const l of list) for (const p of l) { b.extend(new k.LatLng(p.lat, p.lng)); n++; }
    return n ? b : null;
  };
  // 선택한 코스 경로에 지도를 맞춘다(공용·단일 지도 공통). 사용자 조작 표시는 해제한다.
  const fitSelected = () => {
    const map = mapRef.current;
    if (!map) return;
    const b = boundsOf(selRoute ? [selRoute.path] : []);
    if (!b) return;
    map.relayout();
    const pad = { ...(sharedMap ? FIT_PAD_SHARED : FIT_PAD_SINGLE) };
    // 작은 지도에서 여백이 화면을 다 먹지 않게 줄인다(위+아래·좌+우 합이 60%까지만)
    const el = mapEl.current;
    if (el) {
      const vs = pad.top + pad.bottom;
      if (el.clientHeight > 0 && vs > el.clientHeight * 0.6) {
        const f = (el.clientHeight * 0.6) / vs;
        pad.top = Math.round(pad.top * f);
        pad.bottom = Math.round(pad.bottom * f);
      }
      const hs = pad.left + pad.right;
      if (el.clientWidth > 0 && hs > el.clientWidth * 0.6) {
        const f = (el.clientWidth * 0.6) / hs;
        pad.left = Math.round(pad.left * f);
        pad.right = Math.round(pad.right * f);
      }
    }
    fitGuardUntil.current = Date.now() + FIT_EVENT_GUARD_MS;
    map.setBounds(b, pad.top, pad.right, pad.bottom, pad.left);
    markZoomed(false);
  };
  const fitRef = useRef(fitSelected);
  fitRef.current = fitSelected;

  // 지도 생성 (전체화면 토글 시 컨테이너가 바뀌므로 다시 만든다)
  useEffect(() => {
    let alive = true;
    let observer: ResizeObserver | undefined;
    setMapGen(0);
    loadKakaoSdk()
      .then(() => {
        if (!alive || !mapEl.current) return;
        const k = window.kakao.maps;
        const map = new k.Map(mapEl.current, { center: new k.LatLng(37.5665, 126.978), level: 7 });
        map.setMapTypeId(k.MapTypeId.ROADMAP);
        mapRef.current = map;
        k.event.addListener(map, "dragstart", () => markZoomed(true));
        k.event.addListener(map, "zoom_start", () => {
          if (Date.now() < fitGuardUntil.current) return; // 자동 맞춤이 낸 이벤트
          markZoomed(true);
        });
        k.event.addListener(map, "click", (e: any) => {
          const cb = latest.current.onRoadClick;
          if (!cb) return;
          const raw = { lat: e.latLng.getLat(), lng: e.latLng.getLng() };
          let pick: LatLng = raw;
          const sel = latest.current.selPath;
          const proj = map.getProjection();
          if (sel && sel.length > 1 && proj) {
            const cp = proj.containerPointFromCoords(e.latLng);
            let bestD = Infinity;
            let bestP: LatLng | null = null;
            const step = Math.max(1, Math.floor(sel.length / 900));
            for (let i = 0; i < sel.length; i += step) {
              const q = proj.containerPointFromCoords(new k.LatLng(sel[i].lat, sel[i].lng));
              const d = Math.hypot(q.x - cp.x, q.y - cp.y);
              if (d < bestD) { bestD = d; bestP = sel[i]; }
            }
            if (bestP && bestD <= 24) pick = bestP;
          }
          cb(pick);
        });
        // 크기가 바뀌면 다시 맞춘다 — 단, 사용자가 지도를 움직인 뒤에는 relayout만
        observer = new ResizeObserver(() => {
          if (zoomedRef.current) map.relayout();
          else fitRef.current();
        });
        observer.observe(mapEl.current);
        zoomedRef.current = false;
        setZoomed(false);
        prev.current = { fitKey: "", selLabel: "" };
        setError(false);
        setMapGen(++genRef.current);
      })
      .catch(() => alive && setError(true));
    return () => {
      alive = false;
      observer?.disconnect();
      for (const o of overlays.current) o.setMap(null);
      overlays.current = [];
      mapRef.current = null;
    };
  }, [full]);

  // 그리기
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selRoute || selRoute.path.length < 2) return;
    const k = window.kakao.maps;
    for (const o of overlays.current) o.setMap(null);
    overlays.current = [];
    const ll = (p: LatLng) => new k.LatLng(p.lat, p.lng);
    const line = (pts: LatLng[], color: string, weight: number, opacity = 1, z = 1) => {
      const pl = new k.Polyline({ map, path: pts.map(ll), strokeColor: color, strokeWeight: weight, strokeOpacity: opacity, strokeStyle: "solid", zIndex: z });
      overlays.current.push(pl);
      return pl;
    };
    const html = (pos: LatLng, content: HTMLElement, z: number, yAnchor = 0.5) => {
      const ov = new k.CustomOverlay({ map, position: ll(pos), content, xAnchor: 0.5, yAnchor, zIndex: z });
      overlays.current.push(ov);
    };

    for (const r of routeList) {
      if (r.label === selLabel || r.path.length < 2) continue;
      const pl = line(r.path, "#9ca3af", 5, 0.6, 1);
      k.event.addListener(pl, "click", () => latest.current.onRouteClick?.(r.label));
    }
    for (const ln of (roadHighlight?.lines ?? []).slice(0, 300)) {
      if (ln.length < 2) continue;
      line(ln, "#a855f7", 9, 0.35, 2);
      line(ln, "#7c3aed", 4, 1, 2);
    }
    for (const hl of selRoute.highlights ?? []) if (hl.path.length > 1) line(hl.path, "#f59e0b", 9, 0.35, 3);

    const fp = selRoute.path;
    line(fp, "#000000", full ? 8 : 6, 0.5, 4);
    const w = full ? 5 : 4;
    const accent = (mapEl.current && getComputedStyle(mapEl.current).getPropertyValue("--color-accent").trim()) || PLAIN_COLOR;
    const routeColor = sharedMap ? accent : PLAIN_COLOR;
    for (const seg of curvatureSegments(fp)) {
      if (seg.path.length < 2) continue;
      const mid = seg.path[Math.floor(seg.path.length / 2)];
      const probes = [seg.path[0], mid, seg.path[seg.path.length - 1]];
      let color: string | null = null;
      if (coastOverlay) {
        if (selRoute.coastSamples?.length) {
          let tier = 0;
          let bestD = COAST_SAMPLE_RADIUS_M;
          for (const s of selRoute.coastSamples) for (const q of probes) {
            const d = distanceM(q, s);
            if (d < bestD) { bestD = d; tier = s.tier; }
          }
          if (tier === 2) color = SHORE_COLOR;
          else if (tier === 1) color = VIEW_COLOR;
        } else if (selRoute.coastalWaypoints?.some((wp) => probes.some((q) => distanceM(q, wp) < WAYPOINT_FALLBACK_RADIUS_M))) {
          color = VIEW_COLOR;
        }
      }
      if (color === null) {
        if (colorMode === "winding") {
          color = seg.degPerKm > 0 || sharedMap ? windingColor(seg.degPerKm) : PLAIN_COLOR;
        } else if (colorMode === "traffic" && selRoute.trafficSamples?.length) {
          let state = 0;
          let bestD = TRAFFIC_MATCH_M;
          for (const s of selRoute.trafficSamples) for (const q of probes) {
            const d = distanceM(q, s);
            if (d < bestD) { bestD = d; state = s.state; }
          }
          color = TRAFFIC_COLORS[state] ?? routeColor;
        } else if (colorMode === "speed" && selRoute.speedSamples?.length) {
          let kmh = 60;
          let bestD = Infinity;
          for (const s of selRoute.speedSamples) {
            const d = distanceM(mid, s);
            if (d < bestD) { bestD = d; kmh = s.kmh; }
          }
          color = speedColor(kmh);
        } else color = routeColor;
      }
      line(seg.path, color, w, 1, 5);
    }

    for (const [p, c] of [[fp[0], "#10b981"], [fp[fp.length - 1], "#ef4444"]] as const) {
      const d = document.createElement("div");
      const s = full ? 14 : 11;
      d.style.cssText = `width:${s}px;height:${s}px;border-radius:50%;background:${c};border:2.5px solid #fafaf9;box-shadow:0 1px 3px #0006`;
      html(p, d, 8);
    }
    for (const hl of selRoute.highlights ?? []) {
      if (hl.path.length < 2) continue;
      const d = document.createElement("div");
      d.textContent = cleanLabel(hl.name);
      d.style.cssText = "background:#f59e0b;color:#fff;font:600 11px -apple-system,sans-serif;padding:2px 6px;border-radius:9px;white-space:nowrap;pointer-events:none";
      html(hl.path[Math.floor(hl.path.length / 2)], d, 9);
    }
    for (const sp of (pois ?? []).slice(0, 24)) {
      const d = document.createElement("div");
      const kind = SPOT_LABEL[sp.type ?? ""];
      const spName = cleanLabel(sp.name);
      d.textContent = kind && kind !== "위치" ? `${kind} ${spName}` : spName;
      d.style.cssText = "background:#fff;color:#0f766e;border:1.2px solid #0d9488;font:600 10px -apple-system,sans-serif;padding:2px 6px;border-radius:9px;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis;cursor:pointer";
      d.onclick = (e) => { e.stopPropagation(); latest.current.onPoiClick?.(sp.name); };
      html(sp.coord, d, 10);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapGen, routes, path, selLabel, colorMode, coastOverlay, roadHighlight, pois, full, sharedMap]);

  // 시점: 지도 생성(처음·전체화면 전환)·경로 집합 변경·선택 코스 변경 때마다 선택 코스에 맞춘다
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !selRoute) return;
    const before = prev.current;
    prev.current = { fitKey, selLabel: selLabel ?? "" };
    if (before.fitKey !== fitKey || before.selLabel !== (selLabel ?? "")) fitRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapGen, fitKey, selLabel, sharedMap]);

  const bumpZoom = (d: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const map = mapRef.current;
    if (map) map.setLevel(Math.max(1, Math.min(14, map.getLevel() - d)), { animate: true });
  };

  const canvasEl = (
    <>
      <div ref={mapEl} className={`absolute inset-0 bg-panel ${full ? "" : "rounded-md"} overflow-hidden`} />
      {(!ready || error) && (
        <div className="absolute inset-0 flex items-center justify-center rounded-md bg-panel text-sm text-secondary">
          {error ? "지도를 불러오지 못했어요" : "지도 불러오는 중…"}
        </div>
      )}
    </>
  );

  const showTrafficLegend = colorMode === "traffic" && !!selRoute?.trafficSamples?.length;
  const legend = (colorMode !== "none" && colorMode !== "traffic") || showTrafficLegend || coastOverlay ? (
    <div className={`pointer-events-none absolute ${sharedMap ? "bottom-16" : "bottom-3"} left-1/2 z-10 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-sm bg-raised px-3 py-2 text-[11px] font-medium text-disabled ring-1 ring-line dark:bg-panel dark:text-secondary`}>
      {colorMode === "winding" && (
        <>
          <span>직선</span>
          <span aria-hidden="true" className="flex h-1.5 w-12 overflow-hidden rounded-sm"><span className="flex-1" style={{ backgroundColor: "#3b82f6" }} /><span className="flex-1" style={{ backgroundColor: "#8b5cf6" }} /><span className="flex-1" style={{ backgroundColor: "#ec4899" }} /></span>
          <span>와인딩</span>
        </>
      )}
      {colorMode === "speed" && (
        <>
          <span>느림</span>
          <span aria-hidden="true" className="flex h-1.5 w-12 overflow-hidden rounded-sm"><span className="flex-1" style={{ backgroundColor: "#ef4444" }} /><span className="flex-1" style={{ backgroundColor: "#f59e0b" }} /><span className="flex-1" style={{ backgroundColor: "#22c55e" }} /><span className="flex-1" style={{ backgroundColor: "#2563eb" }} /></span>
          <span>빠름</span>
        </>
      )}
      {showTrafficLegend && (
        <>
          <span className="h-1.5 w-3 rounded-sm bg-rose-600" />정체
          <span className="ml-1 h-1.5 w-3 rounded-sm bg-green-500" />원활
        </>
      )}
      {coastOverlay && (
        <>
          <span className="ml-1 h-1.5 w-3 rounded-sm bg-emerald-700" />바닷가
          <span className="ml-1 h-1.5 w-3 rounded-sm bg-emerald-400" />바다뷰
        </>
      )}
    </div>
  ) : null;

  const controls = (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setFull((v) => !v);
        }}
        aria-label={full ? "전체화면 닫기" : "전체화면"}
        className="absolute left-1.5 top-1.5 z-10 rounded-md bg-bg px-3 py-2 text-[11px] font-semibold text-primary hover:bg-panel"
      >
        {full ? "닫기" : "전체화면"}
      </button>
      {modeSelector && <div data-map-modes data-map-modes-inline={sharedMap ? "" : undefined} className="absolute left-1.5 right-1.5 top-12 z-10 flex flex-wrap gap-1">{modeSelector}</div>}
      {onRouteClick && (
        <div className="absolute bottom-3 left-2 right-14 z-10 flex gap-1 overflow-x-auto" role="group" aria-label="코스 선택">
          {routeList.map((route, index) => (
            <button
              key={route.label}
              type="button"
              aria-label={`코스 ${index + 1} 선택`}
              aria-pressed={route.label === selLabel}
              onClick={() => onRouteClick(route.label)}
              className={`h-10 min-w-10 shrink-0 rounded-sm px-3 text-sm font-semibold ${route.label === selLabel ? "bg-accent text-primary" : "bg-panel text-secondary ring-1 ring-inset ring-line"}`}
            >{index + 1}</button>
          ))}
        </div>
      )}
      <div className="absolute bottom-2 right-2 z-10 flex flex-col overflow-hidden rounded-md border border-line">
        <button
          onClick={bumpZoom(1)}
          aria-label="확대"
          className="bg-bg px-3 py-3 text-base font-bold leading-none text-primary hover:bg-panel"
        >
          ＋
        </button>
        <button
          onClick={bumpZoom(-1)}
          aria-label="축소"
                    className="border-t border-line bg-bg px-3 py-3 text-base font-bold leading-none text-primary hover:bg-panel disabled:opacity-40"
        >
          －
        </button>
      </div>
      {(sharedMap || zoomed) && (
        <button
          data-map-fit={sharedMap ? "" : undefined}
          onClick={(e) => {
            e.stopPropagation();
            fitSelected();
          }}
          className={`absolute z-10 ${sharedMap ? "left-20 top-1.5" : "bottom-2 left-2"} rounded-md bg-bg px-3 py-2 text-[11px] font-medium text-primary hover:bg-panel`}
        >
          전체 보기
        </button>
      )}
    </>
  );

  if (full) {
    // body로 포털 — 임베드 카드의 transform/overflow 조상에 갇히면 fixed가
    // 뷰포트가 아니라 그 조상 기준이 돼 "전체화면인데 안 커지는" 문제가 난다.
    return createPortal(
      <div
        data-vehicle-touch={vehicleTouch ? "" : undefined}
        className="fixed inset-0 z-[80] flex flex-col bg-bg p-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-md">
          {canvasEl}
          {!poiCard && legend}
          {controls}
          {poiCard && (
            <div className="absolute inset-x-3 bottom-3 z-20 mx-auto max-w-md">{poiCard}</div>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className={`relative min-h-0 min-w-0 ${heightClass}`} onClick={(e) => e.stopPropagation()}>
      {canvasEl}
      {!poiCard && legend}
      {controls}
      {poiCard && <div className="absolute inset-x-2 bottom-2 z-20">{poiCard}</div>}
    </div>
  );
}
