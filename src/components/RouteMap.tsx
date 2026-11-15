"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from "react";

import { loadKakaoSdk } from "@/lib/kakao-sdk";
import { curvatureSegments, distanceM } from "@/lib/scoring/curvature";
import type { LatLng } from "@/lib/types";

/**
 * OSM 실측 해안 샘플과 이 거리 안이면 그 구간을 해안 구간으로 색칠한다.
 * 샘플이 500m 간격이라 450m면 해안 구간은 틈 없이 잇고, 해안선에서 먼
 * 내륙 구간은 초록으로 안 뜬다(예전 1300m는 1km 넘게 내륙도 초록으로 샜다).
 */
const COAST_SAMPLE_RADIUS_M = 450;
/**
 * 지표 로딩 전 임시 근사: 해안 경유지에서 이 거리 안이면 해안 구간 취급.
 * route-metrics(Overpass)가 느려 로딩이 오래 걸릴 때 이 색칠이 계속 보이므로,
 * 2000m는 내륙까지 초록으로 샜다. 경유지가 해안도로 위 정점이라 600m면 충분.
 */
const WAYPOINT_FALLBACK_RADIUS_M = 600;
/** tier 2 = 바닷가(진짜 해안도로), tier 1 = 바다뷰 */
const SHORE_COLOR = "#047857";
const VIEW_COLOR = "#34d399";

/** 구간 와인딩 지수(°/km) – 파랑(직선)~핑크(와인딩) 그라데이션 (빨강은 정체로 읽혀서 회피) */
function windingColor(degPerKm: number): string {
  const stops = [
    [59, 130, 246], // 파랑
    [139, 92, 246], // 보라
    [236, 72, 153], // 핑크
  ];
  const x = Math.min(degPerKm / 80, 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export type ColorMode = "none" | "speed" | "winding" | "traffic";

export interface RouteLine {
  label: string;
  path: LatLng[];
  /** 해안도로 후보의 해변 경유지 좌표 — OSM 지표 로딩 전 근사 색칠용 */
  coastalWaypoints?: LatLng[];
  /** OSM 실측 해안 샘플 — 로딩되면 이것 기준으로 정밀 색칠 */
  coastSamples?: { lat: number; lng: number; tier: 1 | 2 }[];
  /** 도로종류 기반 속도 샘플(km/h) — 속도 색칠용 (선택 시 로딩) */
  speedSamples?: { lat: number; lng: number; kmh: number }[];
  /** 실시간 소통 샘플 (0정보없음 1정체 2지체 3서행 4원활) — 실시간 색칠용 */
  trafficSamples?: { lat: number; lng: number; state: number }[];
  /** 명품 구간(와인딩 고갯길 등) — 강조선 + 이름 배지 */
  highlights?: { name: string; path: LatLng[] }[];
}

/** 실시간 소통 색 — 카카오 관례(빨강 정체 – 초록 원활) */
const TRAFFIC_COLORS: Record<number, string> = {
  1: "#e11d48", // 정체
  2: "#f97316", // 지체
  3: "#facc15", // 서행
  4: "#22c55e", // 원활
};
/** 교통 샘플이 이 거리 안에 있어야 그 구간을 색칠 (카카오 경로와 어긋난 구간은 기본색) */
const TRAFFIC_MATCH_M = 600;

/** 기본(색칠 없음) 모드의 단일 경로색 — 코럴 브랜드 */
const PLAIN_COLOR = "#fb6550";

/** 속도(km/h) – 빨강(느림)·노랑·초록·파랑(빠름) 그라데이션 */
function speedColor(kmh: number): string {
  const stops = [
    [239, 68, 68], // ~30 빨강
    [245, 158, 11], // ~50 주황
    [34, 197, 94], // ~75 초록
    [37, 99, 235], // 90+ 파랑
  ];
  const x = Math.min(Math.max((kmh - 25) / 65, 0), 1) * (stops.length - 1);
  const i = Math.min(Math.floor(x), stops.length - 2);
  const f = x - i;
  const c = stops[i].map((v, k) => Math.round(v + (stops[i + 1][k] - v) * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export default function RouteMap({
  routes,
  selected,
  colorMode = "none",
  coastOverlay = false,
  onRoadClick,
  roadHighlight,
  pois,
  onPoiClick,
  heightClass = "h-80",
}: {
  routes: RouteLine[];
  selected: string;
  /** 지도 높이 유틸 클래스 (기본 h-80). 좁은 시트 미리보기 등에서 조절 */
  heightClass?: string;
  /** 선택 경로 색칠 기준: 기본(단색)·속도·와인딩 */
  colorMode?: ColorMode;
  /** 해안 구간을 초록으로 우선 강조 (다른 모드 위에 오버레이) */
  coastOverlay?: boolean;
  /** 지도 아무 곳이나 클릭 시 좌표 콜백 — 도로 정보 조회용 */
  onRoadClick?: (p: LatLng) => void;
  /** 클릭한 도로 전체 하이라이트 (글로우 + 부풀기 애니메이션) */
  roadHighlight?: { lines: LatLng[][] } | null;
  /** 주변 경유지 후보 마커 — 누르면 onPoiClick */
  pois?: { name: string; coord: LatLng; type?: string }[];
  onPoiClick?: (name: string) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const polylinesRef = useRef<any[]>([]);
  const highlightRef = useRef<any[]>([]);
  const clickHandlerRef = useRef(onRoadClick);
  clickHandlerRef.current = onRoadClick;
  /** 선택 코스 경로 — 클릭 스냅용 (리스너는 1회 등록이라 ref로 최신 유지) */
  const selectedPathRef = useRef<LatLng[] | null>(null);
  const poiOverlaysRef = useRef<any[]>([]);
  const poiClickRef = useRef(onPoiClick);
  poiClickRef.current = onPoiClick;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    loadKakaoSdk()
      .then(() => {
        if (cancelled || !containerRef.current) return;
        const kakao = window.kakao;

        if (!mapRef.current) {
          mapRef.current = new kakao.maps.Map(containerRef.current, {
            center: new kakao.maps.LatLng(37.5665, 126.978),
            level: 9,
          });
          // 지도 클릭 – 도로 정보 조회 (한 번만 등록, 최신 핸들러는 ref로).
          // 클릭 스냅: 화면 기준 24px 안에 추천 코스가 지나가면 클릭을
          //   코스 위 점으로 보정한다 — 웬만하면 "우리가 추천한 그 길"이
          //   선택되게. 픽셀 기준이라 확대하면 24px가 몇 m뿐이라, 코스와
          //   거리를 두고 찍으면 자연히 다른 길이 잡힌다.
          kakao.maps.event.addListener(mapRef.current, "click", (e: any) => {
            const raw = { lat: e.latLng.getLat(), lng: e.latLng.getLng() };
            let pick = raw;
            const path = selectedPathRef.current;
            const proj = mapRef.current.getProjection?.();
            if (path && path.length > 1 && proj) {
              const cp = proj.containerPointFromCoords(e.latLng);
              const step = Math.max(1, Math.floor(path.length / 900));
              let bestD = Infinity;
              let bestP: LatLng | null = null;
              for (let i = 0; i < path.length; i += step) {
                const q = proj.containerPointFromCoords(
                  new kakao.maps.LatLng(path[i].lat, path[i].lng),
                );
                const d = Math.hypot(q.x - cp.x, q.y - cp.y);
                if (d < bestD) {
                  bestD = d;
                  bestP = path[i];
                }
              }
              if (bestP && bestD <= 24) pick = bestP;
            }
            clickHandlerRef.current?.(pick);
          });
          // E2E 테스트 훅 — kakao.maps.event.trigger로 클릭을 흉내낼 수 있게
          (window as any).__kakaoMap = mapRef.current;
        }
        const map = mapRef.current;

        polylinesRef.current.forEach((line) => line.setMap(null));
        polylinesRef.current = [];

        // 비선택 경로는 회색 단일선으로 먼저 깔고,
        // 선택 경로는 구간별 와인딩 지수에 따라 색을 입혀 위에 그린다
        for (const route of routes.filter((r) => r.label !== selected)) {
          const line = new kakao.maps.Polyline({
            path: route.path.map((p) => new kakao.maps.LatLng(p.lat, p.lng)),
            strokeWeight: 4,
            strokeColor: "#9ca3af",
            strokeOpacity: 0.5,
          });
          line.setMap(map);
          polylinesRef.current.push(line);
        }
        const selectedRoute = routes.find((r) => r.label === selected);
        selectedPathRef.current = selectedRoute?.path ?? null;
        if (selectedRoute) {
          for (const seg of curvatureSegments(selectedRoute.path)) {
            const mid = seg.path[Math.floor(seg.path.length / 2)];
            const probes = [seg.path[0], mid, seg.path[seg.path.length - 1]];

            // 1순위: 해안 오버레이가 켜져 있으면 해안 구간을 초록으로.
            let color: string | null = null;
            if (coastOverlay) {
              if (selectedRoute.coastSamples?.length) {
                // OSM 실측 — 이 구간에 가장 가까운 샘플의 tier로 칠한다.
                let tier = 0;
                let bestD = COAST_SAMPLE_RADIUS_M;
                for (const s of selectedRoute.coastSamples) {
                  for (const q of probes) {
                    const d = distanceM(q, s);
                    if (d < bestD) {
                      bestD = d;
                      tier = s.tier;
                    }
                  }
                }
                if (tier === 2) color = SHORE_COLOR;
                else if (tier === 1) color = VIEW_COLOR;
              } else if (
                selectedRoute.coastalWaypoints?.some((w) =>
                  probes.some((q) => distanceM(q, w) < WAYPOINT_FALLBACK_RADIUS_M),
                )
              ) {
                color = VIEW_COLOR;
              }
            }

            // 2순위: 선택한 기준 색칠 (해안이 아닌 구간)
            if (color === null) {
              if (colorMode === "winding") {
                color = windingColor(seg.degPerKm);
              } else if (
                colorMode === "traffic" &&
                selectedRoute.trafficSamples?.length
              ) {
                let state = 0;
                let bestD = TRAFFIC_MATCH_M;
                for (const s of selectedRoute.trafficSamples) {
                  for (const q of probes) {
                    const d = distanceM(q, s);
                    if (d < bestD) {
                      bestD = d;
                      state = s.state;
                    }
                  }
                }
                color = TRAFFIC_COLORS[state] ?? PLAIN_COLOR;
              } else if (colorMode === "speed" && selectedRoute.speedSamples?.length) {
                let kmh = 60;
                let bestD = Infinity;
                for (const s of selectedRoute.speedSamples) {
                  const d = distanceM(mid, s);
                  if (d < bestD) {
                    bestD = d;
                    kmh = s.kmh;
                  }
                }
                color = speedColor(kmh);
              } else {
                color = PLAIN_COLOR; // 기본(색칠 없음) 또는 속도 데이터 로딩 전
              }
            }

            const line = new kakao.maps.Polyline({
              path: seg.path.map((p) => new kakao.maps.LatLng(p.lat, p.lng)),
              strokeWeight: 6,
              strokeColor: color,
              strokeOpacity: 0.95,
            });
            line.setMap(map);
            polylinesRef.current.push(line);
          }
        }

        // 명품 구간 강조: 주황 테두리선 + 구간 중앙에 이름 배지
        if (selectedRoute?.highlights?.length) {
          for (const h of selectedRoute.highlights) {
            if (h.path.length < 2) continue;
            const line = new kakao.maps.Polyline({
              path: h.path.map((p) => new kakao.maps.LatLng(p.lat, p.lng)),
              strokeWeight: 10,
              strokeColor: "#f59e0b",
              strokeOpacity: 0.35,
            });
            line.setMap(map);
            polylinesRef.current.push(line);
            const mid = h.path[Math.floor(h.path.length / 2)];
            const badge = new kakao.maps.CustomOverlay({
              position: new kakao.maps.LatLng(mid.lat, mid.lng),
              content: `<div style="background:#f59e0b;color:#fff;font-size:11px;font-weight:600;padding:2px 8px;border-radius:6px;white-space:nowrap">${h.name}</div>`,
              yAnchor: 1.4,
            });
            badge.setMap(map);
            polylinesRef.current.push(badge);
          }
        }

        const target = routes.find((r) => r.label === selected) ?? routes[0];
        if (target) {
          const bounds = new kakao.maps.LatLngBounds();
          for (const p of target.path) {
            bounds.extend(new kakao.maps.LatLng(p.lat, p.lng));
          }
          map.setBounds(bounds, 24);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));

    return () => {
      cancelled = true;
    };
  }, [routes, selected, colorMode, coastOverlay]);

  // 주변 경유지 후보 마커 — 알약 오버레이, 누르면 코스에 추가
  useEffect(() => {
    const SPOT_LABEL: Record<string, string> = {
      관광명소: "위치",
      전망대: "전망",
      해변: "해변",
      "강/호수": "강변",
      카페: "카페",
      맛집: "음식점",
      휴게소: "주유",
    };
    loadKakaoSdk()
      .then(() => {
        const kakao = window.kakao;
        const map = mapRef.current;
        poiOverlaysRef.current.forEach((o) => o.setMap(null));
        poiOverlaysRef.current = [];
        if (!map || !pois?.length) return;
        for (const p of pois.slice(0, 30)) {
          const el = document.createElement("div");
          el.style.cssText =
            "background:#fff;border:1.5px solid #0d9488;color:#0f766e;font:600 11px -apple-system,sans-serif;padding:3px 9px;border-radius:6px;cursor:pointer;white-space:nowrap";
          el.textContent = `${SPOT_LABEL[p.type ?? ""] ?? "위치"} ${p.name}`;
          el.addEventListener("click", () => poiClickRef.current?.(p.name));
          const ov = new kakao.maps.CustomOverlay({
            position: new kakao.maps.LatLng(p.coord.lat, p.coord.lng),
            content: el,
            yAnchor: 1.25,
            clickable: true,
          });
          ov.setMap(map);
          poiOverlaysRef.current.push(ov);
        }
      })
      .catch(() => {});
  }, [pois]);

  // 클릭한 도로 전체 하이라이트 — 보라 글로우가 "부풀어오르는" 애니메이션.
  // 영동고속도로급(라인 수백 개)은 긴 라인 위주로 캡을 걸어 렌더 부담을 줄인다.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    loadKakaoSdk()
      .then(() => {
        const kakao = window.kakao;
        const map = mapRef.current;
        highlightRef.current.forEach((l) => l.setMap(null));
        highlightRef.current = [];
        if (!map || !roadHighlight || roadHighlight.lines.length === 0) return;

        const lineLen = (l: LatLng[]) => {
          let m = 0;
          for (let i = 1; i < l.length; i++) m += distanceM(l[i - 1], l[i]);
          return m;
        };
        const lines = [...roadHighlight.lines]
          .sort((a, b) => lineLen(b) - lineLen(a))
          .slice(0, 300);
        const withGlow = lines.length <= 120;

        const glows: any[] = [];
        for (const line of lines) {
          if (line.length < 2) continue;
          const path = line.map((p) => new kakao.maps.LatLng(p.lat, p.lng));
          if (withGlow) {
            const glow = new kakao.maps.Polyline({
              path,
              strokeWeight: 4,
              strokeColor: "#a855f7",
              strokeOpacity: 0.3,
            });
            glow.setMap(map);
            glows.push(glow);
            highlightRef.current.push(glow);
          }
          const core = new kakao.maps.Polyline({
            path,
            strokeWeight: 5,
            strokeColor: "#7c3aed",
            strokeOpacity: 0.9,
          });
          core.setMap(map);
          highlightRef.current.push(core);
        }
        // 부풀기: 글로우 두께 4–16을 5단계로
        if (glows.length > 0) {
          let step = 0;
          timer = setInterval(() => {
            step++;
            const w = 4 + step * 2.4;
            for (const g of glows) g.setOptions({ strokeWeight: w });
            if (step >= 5 && timer) clearInterval(timer);
          }, 50);
        }
      })
      .catch(() => {});
    return () => {
      if (timer) clearInterval(timer);
    };
  }, [roadHighlight]);

  if (error) {
    return (
      <p className="rounded-md bg-warn-surface dark:bg-warn-surface p-3 text-sm text-warn dark:text-warn">{error}</p>
    );
  }
  return (
    <div className="relative">
      <div
        ref={containerRef}
        className={`${heightClass} w-full overflow-hidden rounded-md border border-line bg-raised  dark:border-line dark:bg-raised`}
      />
      {(colorMode !== "none" || coastOverlay) && (
        <div className="absolute bottom-3 left-3 z-10 flex items-center gap-2 rounded-sm bg-raised px-3 py-2 text-xs font-medium text-disabled ring-1 ring-line dark:bg-panel dark:text-secondary dark:ring-line">
          {colorMode === "winding" && (
            <>
              <span>직선</span>
              <span aria-hidden="true" className="flex h-1.5 w-14 overflow-hidden rounded-sm"><span className="flex-1" style={{ backgroundColor: "#3b82f6" }} /><span className="flex-1" style={{ backgroundColor: "#8b5cf6" }} /><span className="flex-1" style={{ backgroundColor: "#ec4899" }} /></span>
              <span>와인딩</span>
            </>
          )}
          {colorMode === "traffic" && (
            <>
              <span className="h-1.5 w-4 rounded-sm bg-rose-600" />
              <span>정체</span>
              <span className="ml-1 h-1.5 w-4 rounded-sm bg-orange-500" />
              <span>지체</span>
              <span className="ml-1 h-1.5 w-4 rounded-sm bg-yellow-400" />
              <span>서행</span>
              <span className="ml-1 h-1.5 w-4 rounded-sm bg-green-500" />
              <span>원활</span>
            </>
          )}
          {colorMode === "speed" && (
            <>
              <span>느림</span>
              <span aria-hidden="true" className="flex h-1.5 w-14 overflow-hidden rounded-sm"><span className="flex-1" style={{ backgroundColor: "#ef4444" }} /><span className="flex-1" style={{ backgroundColor: "#f59e0b" }} /><span className="flex-1" style={{ backgroundColor: "#22c55e" }} /><span className="flex-1" style={{ backgroundColor: "#2563eb" }} /></span>
              <span>빠름</span>
            </>
          )}
          {coastOverlay && (
            <>
              <span className="ml-1 h-1.5 w-4 rounded-sm bg-emerald-700" />
              <span>바닷가</span>
              <span className="ml-1 h-1.5 w-4 rounded-sm bg-emerald-400" />
              <span>바다뷰</span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
