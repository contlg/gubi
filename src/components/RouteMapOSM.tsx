"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { loadKakaoSdk } from "@/lib/kakao-sdk";
import { cleanLabel } from "@/lib/display-text";
import { curvatureSegments, distanceM } from "@/lib/scoring/curvature";
import type { SpecialKind } from "@/lib/special-segments";
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

/** 굽이 지도(코스 상세) — 교통 4색 위에 코스의 특별 구간을 덧칠한다 */
const GUBI_TRAFFIC: Record<number, string> = {
  1: "#E8323C", // 정체
  2: "#FF7A1A", // 지체
  3: "#F5B700", // 서행
  4: "#1DB954", // 원활
};
const GUBI_TRAFFIC_LEGEND: [string, string][] = [
  ["#1DB954", "원활"],
  ["#F5B700", "서행"],
  ["#FF7A1A", "지체"],
  ["#E8323C", "정체"],
];
/** 교통 정보가 없는 구간 — 원활처럼 보이지 않게 회색 */
const GUBI_NO_TRAFFIC = "#5B6470";
export const SPECIAL_COLOR: Record<SpecialKind, string> = {
  winding: "#7C3AED",
  coast: "#1D4ED8",
  river: "#0891B2",
};
export const SPECIAL_NAME: Record<SpecialKind, string> = {
  winding: "와인딩",
  coast: "해안",
  river: "강변",
};
export interface SpecialSegment {
  kind: SpecialKind;
  path: LatLng[];
  km: number;
}
/** 코스 상세 지도 맞춤 여백 — 위 단추 줄·아래 범례만 비우고 꽉 채운다(꼬리표는 안쪽으로 접는다) */
const GUBI_FIT_PAD = { top: 96, right: 24, bottom: 100, left: 24 };
const CALLOUT_W = 300;
const CALLOUT_H = 222;

/** 지도 위 이름표·말풍선의 화면 상자 — 좌표 기준 가로 가운데, 세로는 dy(위로 뜨면 음수)부터 h */
interface OverlayBox {
  at: LatLng;
  w: number;
  h: number;
  dy: number;
}
interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}
const hits = (a: Rect, b: Rect, m = 0) => a.l < b.r + m && a.r > b.l - m && a.t < b.b + m && a.b > b.t - m;

/** "와인딩 9.8km", "해안 31km" — 10km 넘으면 정수 */
export function kmText(km: number): string {
  return `${km >= 10 ? Math.round(km) : km.toFixed(1)}km`;
}

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
  variant = "classic",
  special,
  specialKinds,
  stops,
  loop = false,
  topLeft,
  callout,
  calloutAt,
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
  /** gubi: 코스 상세 지도 — 교통 4색 + 특별 구간 덧칠, 흰 테두리, 출발·경유 말풍선 */
  variant?: "classic" | "gubi";
  /** 덧칠할 특별 구간(와인딩·해안·강변) */
  special?: SpecialSegment[];
  /** 범례에 보일 특별 구간 종류(고른 길 종류) */
  specialKinds?: SpecialKind[];
  /** 경유지 말풍선 */
  stops?: { name: string; coord: LatLng }[];
  /** 순환 코스 — 출발점에 "출발·도착" */
  loop?: boolean;
  /** 지도 왼쪽 위에 놓을 단추(코스 목록으로 등) */
  topLeft?: ReactNode;
  /** 지도 위 작은 카드(로드뷰) — calloutAt 지점과 가는 선으로 잇는다 */
  callout?: ReactNode;
  calloutAt?: LatLng | null;
}) {
  const gubi = variant === "gubi";
  /** 로드뷰 카드 자리 고르기에 쓰는 지도 위 물건들 */
  const overlayBoxes = useRef<OverlayBox[]>([]);
  const legendRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef<HTMLDivElement>(null);
  const topLeftRef = useRef<HTMLDivElement>(null);
  const topRightRef = useRef<HTMLDivElement>(null);
  const calloutRef = useRef<HTMLDivElement>(null);
  /** 출발·도착 꼬리표 — 지도 끝에 걸리면 안쪽으로 밀고, 아래 범례에 걸리면 점 위로 올린다 */
  const endTags = useRef<{ at: LatLng; box: HTMLElement; label: HTMLElement }[]>([]);
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
    const pad = { ...(gubi ? GUBI_FIT_PAD : sharedMap ? FIT_PAD_SHARED : FIT_PAD_SINGLE) };
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
    // 카카오 확대 단계는 2배씩이라 빈자리가 크게 남을 수 있다 — 한 단계 더 들어가도
    // 코스가 위 단추·아래 범례를 뺀 자리에 들어가면 한 단계 더 확대한다
    if (gubi && el) {
      // 카카오가 맞춤을 반영한 다음 프레임에 잰다
      requestAnimationFrame(() => {
        if (mapRef.current !== map || map.getLevel() <= 1) return;
        const proj = map.getProjection();
        if (!proj) return;
        const sw = proj.containerPointFromCoords(b.getSouthWest());
        const ne = proj.containerPointFromCoords(b.getNorthEast());
        const w = Math.abs(ne.x - sw.x);
        const h = Math.abs(sw.y - ne.y);
        if (w * 2 <= el.clientWidth - pad.left - pad.right && h * 2 <= el.clientHeight - pad.top - pad.bottom) {
          const c = new window.kakao.maps.LatLng((b.getSouthWest().getLat() + b.getNorthEast().getLat()) / 2, (b.getSouthWest().getLng() + b.getNorthEast().getLng()) / 2);
          fitGuardUntil.current = Date.now() + FIT_EVENT_GUARD_MS;
          map.setLevel(map.getLevel() - 1);
          map.setCenter(c);
          // 위·아래 여백이 다르니 코스 가운데를 남는 자리 가운데로
          map.panBy(0, (pad.bottom - pad.top) / 2);
        }
      });
    }
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

    const tag = (text: string, css: string) => {
      const d = document.createElement("div");
      d.textContent = text;
      d.style.cssText = css;
      return d;
    };
    if (gubi) {
      const fp = selRoute.path;
      // 흰 테두리 → 교통 4색 → 특별 구간 덧칠
      line(fp, "#FFFFFF", full ? 13 : 11, 1, 4);
      const samples = selRoute.trafficSamples ?? [];
      for (const seg of curvatureSegments(fp, 1000)) {
        if (seg.path.length < 2) continue;
        let color = GUBI_NO_TRAFFIC;
        if (samples.length) {
          const mid = seg.path[Math.floor(seg.path.length / 2)];
          const probes = [seg.path[0], mid, seg.path[seg.path.length - 1]];
          let state = 0;
          let bestD = TRAFFIC_MATCH_M;
          for (const sm of samples) for (const q of probes) {
            const d = distanceM(q, sm);
            if (d < bestD) { bestD = d; state = sm.state; }
          }
          color = GUBI_TRAFFIC[state] ?? GUBI_NO_TRAFFIC;
        }
        line(seg.path, color, full ? 7 : 6, 1, 5);
      }
      for (const sp of special ?? []) if (sp.path.length > 1) line(sp.path, SPECIAL_COLOR[sp.kind], full ? 8 : 7, 1, 6);
      // 이름표 — 알약 + 점. 가까이 붙은 같은 종류 구간은 한 이름표에 길이를 합치고, 이름표는 3개까지
      const labels: { kind: SpecialKind; at: LatLng; km: number }[] = [];
      const isLoopRoute = loop || distanceM(fp[0], fp[fp.length - 1]) < 300;
      const markers: LatLng[] = [fp[0], ...(isLoopRoute ? [] : [fp[fp.length - 1]]), ...(stops ?? []).map((st) => st.coord), ...(calloutAt ? [calloutAt] : [])];
      for (const sp of [...(special ?? [])].sort((a, b) => b.km - a.km)) {
        if (sp.path.length < 2) continue;
        // 구간 가운데쯤(20~80%)에서 출발·경유·로드뷰 점과 가장 먼 곳에 이름표를 단다
        let mid = sp.path[Math.floor(sp.path.length / 2)];
        let bestGap = -1;
        const n = sp.path.length;
        for (let i = Math.floor(n * 0.2); i <= Math.floor(n * 0.8); i += Math.max(1, Math.floor(n / 24))) {
          const gap = markers.length ? Math.min(...markers.map((m) => distanceM(m, sp.path[i]))) : 0;
          if (gap > bestGap) {
            bestGap = gap;
            mid = sp.path[i];
          }
        }
        const near = labels.find((l) => l.kind === sp.kind && sp.path.some((q, i) => i % 10 === 0 && distanceM(q, l.at) < 8000));
        if (near) near.km += sp.km;
        else if (labels.length < 3) labels.push({ kind: sp.kind, at: mid, km: sp.km });
      }
      const placed: OverlayBox[] = [];
      for (const sp of labels) {
        const at = sp.at;
        // 경유지 말풍선(위로 뜸)과 겹치지 않게, 가까이 경유지가 있으면 이름표를 점 아래로
        // 로드뷰 점이 바로 북쪽에 있으면 이름표가 그 점과 선을 덮지 않게 역시 아래로
        const under =
          (stops ?? []).some((st) => distanceM(st.coord, at) < 8000) ||
          (!!calloutAt && calloutAt.lat > at.lat && distanceM(calloutAt, at) < 8000);
        const text = `${SPECIAL_NAME[sp.kind]} ${kmText(sp.km)}`;
        placed.push({ at, w: text.length * 15 + 36, h: 62, dy: under ? 0 : -62 });
        const box = document.createElement("div");
        box.style.cssText = `display:flex;flex-direction:${under ? "column-reverse" : "column"};align-items:center;gap:6px;transform:translateY(${under ? -8 : 8}px);pointer-events:none`;
        box.appendChild(tag(`${SPECIAL_NAME[sp.kind]} ${kmText(sp.km)}`, `background:${SPECIAL_COLOR[sp.kind]};color:#fff;font:700 17px Pretendard,-apple-system,sans-serif;padding:7px 14px;border-radius:12px;white-space:nowrap;box-shadow:0 2px 6px #0004;border:2px solid #fff`));
        box.appendChild(tag("", "width:14px;height:14px;border-radius:50%;background:#101113;border:3px solid #fff;box-shadow:0 1px 3px #0006"));
        html(at, box, 12, under ? 0 : 1);
      }
      // 경유지 — 흰 말풍선(이름 + 작은 "경유")
      for (const st of (stops ?? []).slice(0, 8)) {
        placed.push({ at: st.coord, w: cleanLabel(st.name).length * 17 + 70, h: 64, dy: -64 });
        const box = document.createElement("div");
        box.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:6px;transform:translateY(7px);pointer-events:none";
        const b = tag("", "display:flex;align-items:baseline;gap:6px;background:#fff;color:#101113;font:700 17px Pretendard,-apple-system,sans-serif;padding:8px 14px;border-radius:12px;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;box-shadow:0 2px 8px #0003");
        b.appendChild(document.createTextNode(cleanLabel(st.name)));
        b.appendChild(tag("경유", "font:500 13px Pretendard,-apple-system,sans-serif;color:#6b7078"));
        box.appendChild(b);
        box.appendChild(tag("", "width:14px;height:14px;border-radius:50%;background:#fff;border:3px solid #101113"));
        html(st.coord, box, 11, 1);
      }
      // 출발(·도착) — 검은 점 + 검은 꼬리표
      const endMark = (p: LatLng, text: string) => {
        const box = document.createElement("div");
        box.style.cssText = "display:flex;flex-direction:column;align-items:center;gap:8px;transform:translateY(-9px);pointer-events:none";
        box.appendChild(tag("", "width:18px;height:18px;border-radius:50%;background:#101113;border:3.5px solid #fff;box-shadow:0 1px 4px #0006"));
        const label = tag(text, "background:#101113;color:#fff;font:700 17px Pretendard,-apple-system,sans-serif;padding:6px 12px;border-radius:10px;white-space:nowrap");
        box.appendChild(label);
        html(p, box, 13, 0);
        endTags.current.push({ at: p, box, label });
      };
      endTags.current = [];
      endMark(fp[0], isLoopRoute ? "출발·도착" : "출발");
      placed.push({ at: fp[0], w: 120, h: 70, dy: -12 });
      if (!isLoopRoute) {
        endMark(fp[fp.length - 1], "도착");
        placed.push({ at: fp[fp.length - 1], w: 120, h: 70, dy: -12 });
      }
      overlayBoxes.current = placed;
      if (calloutAt) {
        html(calloutAt, tag("", "width:14px;height:14px;border-radius:50%;background:#101113;border:3px solid #fff;box-shadow:0 1px 3px #0006;pointer-events:none"), 14);
      }
      for (const sp of (pois ?? []).slice(0, 24)) {
        const kind = SPOT_LABEL[sp.type ?? ""];
        const spName = cleanLabel(sp.name);
        const d = tag(kind && kind !== "위치" ? `${kind} ${spName}` : spName, "background:#fff;color:#0f766e;border:1.5px solid #0d9488;font:600 14px Pretendard,-apple-system,sans-serif;padding:4px 10px;border-radius:10px;white-space:nowrap;max-width:240px;overflow:hidden;text-overflow:ellipsis;cursor:pointer");
        d.onclick = (e) => { e.stopPropagation(); latest.current.onPoiClick?.(sp.name); };
        html(sp.coord, d, 10);
      }
      return;
    }

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
  }, [mapGen, routes, path, selLabel, colorMode, coastOverlay, roadHighlight, pois, full, sharedMap, gubi, special, stops, loop, calloutAt]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !gubi) return;
    const k = window.kakao.maps;
    const fitTags = () => {
      const proj = map.getProjection();
      const el = mapEl.current;
      if (!proj || !el) return;
      const W = el.clientWidth;
      const H = el.clientHeight;
      const legend = legendRef.current?.getBoundingClientRect();
      const base = el.getBoundingClientRect();
      const legendTop = legend ? legend.top - base.top : H;
      const legendRight = legend ? legend.right - base.left : 0;
      for (const t of endTags.current) {
        const p = proj.containerPointFromCoords(new k.LatLng(t.at.lat, t.at.lng));
        const w = t.label.offsetWidth || 110;
        const dx = Math.min(0, W - 12 - (p.x + w / 2)) + Math.max(0, 12 - (p.x - w / 2));
        const below = p.y + 60;
        const flip = below > H - 8 || (below > legendTop - 6 && p.x - w / 2 < legendRight);
        t.label.style.transform = `translateX(${Math.round(dx)}px)`;
        t.box.style.flexDirection = flip ? "column-reverse" : "column";
        // 꼬리표를 점 위로 — 상자 아래끝(점)이 좌표에 오게 올린다
        t.box.style.transform = flip ? "translateY(calc(-100% + 9px))" : "translateY(-9px)";
      }
    };
    const timer = setTimeout(fitTags, 50);
    k.event.addListener(map, "idle", fitTags);
    return () => {
      clearTimeout(timer);
      k.event.removeListener(map, "idle", fitTags);
    };
  }, [mapGen, ready, gubi, routes, special, stops, calloutAt, full]);

  // 지도 위 로드뷰 카드 — 지도가 멈출 때마다 빈자리를 골라 놓고(코스 선·범례·확대 단추·
  // 이름표를 피하고 지점에 가깝게), 움직이는 동안은 지점 쪽 선 끝만 따라간다
  const [callLayout, setCallLayout] = useState<{ x: number; y: number; w: number; h: number; ch: number; left: number; top: number } | null>(null);
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !calloutAt || !gubi) {
      setCallLayout(null);
      return;
    }
    const k = window.kakao.maps;
    const pos = new k.LatLng(calloutAt.lat, calloutAt.lng);
    const place = (spotOnly: boolean) => {
      const proj = map.getProjection();
      const el = mapEl.current;
      if (!proj || !el) return;
      const W = el.clientWidth;
      const H = el.clientHeight;
      const sp = proj.containerPointFromCoords(pos);
      if (spotOnly) {
        setCallLayout((prev) => (prev ? { ...prev, x: sp.x, y: sp.y } : prev));
        return;
      }
      const base = el.getBoundingClientRect();
      const rel = (n: HTMLElement | null): Rect | null => {
        if (!n) return null;
        const r = n.getBoundingClientRect();
        return { l: r.left - base.left, t: r.top - base.top, r: r.right - base.left, b: r.bottom - base.top };
      };
      const hard = [legendRef.current, zoomRef.current, topLeftRef.current, topRightRef.current].map(rel).filter((r): r is Rect => !!r);
      const soft = overlayBoxes.current.map((o) => {
        const p = proj.containerPointFromCoords(new k.LatLng(o.at.lat, o.at.lng));
        return { l: p.x - o.w / 2, t: p.y + o.dy, r: p.x + o.w / 2, b: p.y + o.dy + o.h };
      });
      const path = latest.current.selPath ?? [];
      const step = Math.max(1, Math.floor(path.length / 300));
      const pts: { x: number; y: number }[] = [];
      for (let i = 0; i < path.length; i += step) pts.push(proj.containerPointFromCoords(new k.LatLng(path[i].lat, path[i].lng)));
      const CW = CALLOUT_W;
      const CH = calloutRef.current?.offsetHeight || CALLOUT_H;
      let best: { left: number; top: number; cost: number } | null = null;
      for (let top = 16; top <= H - CH - 16; top += 24) {
        for (let left = 16; left <= W - CW - 16; left += 24) {
          const rc: Rect = { l: left, t: top, r: left + CW, b: top + CH };
          if (hard.some((h) => hits(rc, h, 12))) continue;
          if (hits(rc, { l: sp.x, t: sp.y, r: sp.x, b: sp.y }, 28)) continue;
          let cost = 0;
          for (const o of soft) if (hits(rc, o, 8)) cost += 1e5;
          for (const q of pts) if (q.x > rc.l - 10 && q.x < rc.r + 10 && q.y > rc.t - 10 && q.y < rc.b + 10) cost += 60;
          // 선 끝 — 카드 테두리에서 지점에 가장 가까운 곳. 선이 이름표를 지나가면 벌점
          const ex = Math.max(rc.l, Math.min(sp.x, rc.r));
          const ey = Math.max(rc.t, Math.min(sp.y, rc.b));
          for (let t = 0.1; t < 1; t += 0.1) {
            const lx = sp.x + (ex - sp.x) * t;
            const ly = sp.y + (ey - sp.y) * t;
            if (soft.some((o) => lx > o.l && lx < o.r && ly > o.t && ly < o.b)) cost += 3e4;
          }
          cost += Math.hypot(ex - sp.x, ey - sp.y) * 0.4;
          if (!best || cost < best.cost) best = { left, top, cost };
        }
      }
      const fb = { left: 16, top: Math.max(16, H - CH - 120) };
      setCallLayout({ x: sp.x, y: sp.y, w: W, h: H, ch: CH, left: (best ?? fb).left, top: (best ?? fb).top });
    };
    const onMove = () => place(true);
    const onIdle = () => place(false);
    // 그리기·맞춤이 끝난 다음에 고른다
    const t = setTimeout(onIdle, 300);
    k.event.addListener(map, "bounds_changed", onMove);
    k.event.addListener(map, "idle", onIdle);
    return () => {
      clearTimeout(t);
      k.event.removeListener(map, "bounds_changed", onMove);
      k.event.removeListener(map, "idle", onIdle);
    };
  }, [mapGen, calloutAt, ready, gubi, special, stops]);

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
      <div ref={mapEl} className={`absolute inset-0 bg-panel ${full || gubi ? "" : "rounded-md"} overflow-hidden`} />
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

  const kindsInLegend = [...new Set([...(specialKinds ?? []), ...(special ?? []).map((sp) => sp.kind)])];
  const gubiLegend = gubi && (showTrafficLegendGubi(selRoute) || kindsInLegend.length > 0) ? (
    <div ref={legendRef} data-gubi-legend className="gb-map-legend">
      {showTrafficLegendGubi(selRoute) && GUBI_TRAFFIC_LEGEND.map(([c, t]) => (
        <span key={t}><i style={{ background: c }} />{t}</span>
      ))}
      {showTrafficLegendGubi(selRoute) && kindsInLegend.length > 0 && <b aria-hidden="true" />}
      {kindsInLegend.map((kd) => (
        <span key={kd}><i style={{ background: SPECIAL_COLOR[kd] }} />{SPECIAL_NAME[kd]}</span>
      ))}
    </div>
  ) : null;

  const calloutEl = gubi && callout ? (
    <>
      {callLayout && callLayout.x >= 0 && callLayout.y >= 0 && callLayout.x <= callLayout.w && callLayout.y <= callLayout.h && (
        <svg className="pointer-events-none absolute inset-0 z-10 h-full w-full" aria-hidden="true">
          <line
            x1={callLayout.x}
            y1={callLayout.y}
            x2={Math.max(callLayout.left, Math.min(callLayout.x, callLayout.left + CALLOUT_W))}
            y2={Math.max(callLayout.top, Math.min(callLayout.y, callLayout.top + callLayout.ch))}
            stroke="#101113"
            strokeWidth="2"
          />
        </svg>
      )}
      <div
        ref={calloutRef}
        data-map-callout
        className="absolute z-20"
        style={callLayout ? { left: callLayout.left, top: callLayout.top, width: CALLOUT_W } : { left: 16, top: 96, width: CALLOUT_W, visibility: "hidden" }}
      >
        {callout}
      </div>
    </>
  ) : null;

  const gubiControls = (
    <>
      {topLeft && <div ref={topLeftRef} className="absolute left-4 top-4 z-20">{topLeft}</div>}
      <div ref={topRightRef} className="absolute right-4 top-4 z-20 flex gap-2">
        {zoomed && (
          <button
            type="button"
            data-map-fit=""
            onClick={(e) => {
              e.stopPropagation();
              fitSelected();
            }}
            className="gb-map-btn"
          >
            전체 보기
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setFull((v) => !v);
          }}
          aria-label={full ? "전체화면 닫기" : "전체화면"}
          className="gb-map-btn"
        >
          {full ? "닫기" : "전체화면"}
        </button>
      </div>
      <div ref={zoomRef} className="gb-map-zoom absolute bottom-10 right-4 z-20 flex flex-col overflow-hidden">
        <button type="button" onClick={(e) => bumpZoom(1)(e)} aria-label="확대">＋</button>
        <button type="button" onClick={(e) => bumpZoom(-1)(e)} aria-label="축소">－</button>
      </div>
      {calloutEl}
    </>
  );

  const controls = gubi ? gubiControls : (
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
          {!poiCard && (gubi ? gubiLegend : legend)}
          {controls}
          {poiCard && (
            <div className="absolute inset-x-3 bottom-3 z-30 mx-auto max-w-md">{poiCard}</div>
          )}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className={`relative min-h-0 min-w-0 ${heightClass}`} onClick={(e) => e.stopPropagation()}>
      {canvasEl}
      {!poiCard && (gubi ? gubiLegend : legend)}
      {controls}
      {poiCard && <div className="absolute inset-x-2 bottom-2 z-30">{poiCard}</div>}
    </div>
  );
}

function showTrafficLegendGubi(route: RouteLine | undefined): boolean {
  return !!route?.trafficSamples?.length;
}
