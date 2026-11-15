"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useEffect, useRef, useState } from "react";

import { loadKakaoSdk } from "@/lib/kakao-sdk";
import { decodePolyline } from "@/lib/polyline";

/**
 * 주행 궤적 미니 지도 — 카카오맵 JS SDK 위에 경로를 그린다.
 * enc(단일 경로)면 출발·도착 점 + (speeds 있으면) 속도색.
 * paths(여러 경로)면 전부 겹쳐 그린다 — "내가 달린 지도(정복 맵)".
 * interactive면 카카오 기본 드래그·핀치·휠 + ＋/－ 버튼으로 확대/이동한다.
 */

const MODE_KEY = "drivelog-map-mode-v1";

type MapMode = "map" | "sat";

const MODES: Record<MapMode, { label: string }> = {
  map: { label: "일반" },
  sat: { label: "위성" },
};

/** 속도(km/h) – 색 — 속도 분포 버킷과 동일(느림 청록 – 빠름 빨강). 경계는 이동수단별(기본 차) */
function speedColor(v: number, bins: readonly [number, number, number] = [60, 90, 120]): string {
  if (v < bins[0]) return "#22d3ee";
  if (v < bins[1]) return "#34d399";
  if (v < bins[2]) return "#fbbf24";
  return "#f87171";
}

/** 실시간 소통 색 — 카카오 관례(빨강 정체 – 초록 원활). 0/정보없음은 파랑 */
const TRAFFIC_COLORS: Record<number, string> = {
  1: "#e11d48", // 정체
  2: "#f97316", // 지체
  3: "#facc15", // 서행
  4: "#22c55e", // 원활
};
const TRAFFIC_PLAIN = "#60a5fa"; // 정보없음(0)·매칭 실패
/** 교통 샘플이 이 거리(m) 안일 때만 그 상태색으로 칠한다 */
const TRAFFIC_MATCH_M = 600;

export default function RouteMap({
  enc,
  paths,
  className = "h-44",
  speeds,
  speedBins,
  trafficSamples,
  interactive = false,
  trafficToggle = false,
  modeToggle = true,
  dongFills,
}: {

  enc?: string;
  /** 여러 경로(encoded 배열) — 정복 지도용. 전부 겹쳐 그린다 */
  paths?: string[];
  /** 정복한 행정동 폴리곤 — 각 링 [lat,lng,...]. 지도에 반투명 칠 */
  dongFills?: { rings: number[][] }[];
  className?: string;
  /** 궤적 각 점 속도(km/h) — enc일 때 경로를 속도별로 색칠 */
  speeds?: number[];
  /** 속도 색 경계(km/h) — 주행 속도 분포 구간과 맞춘다 */
  speedBins?: readonly [number, number, number];
  /** 실시간 소통 샘플(0정보없음 1정체 2지체 3서행 4원활) — enc일 때 정체색 */
  trafficSamples?: { lat: number; lng: number; state: number }[];
  /** 핀치·휠·드래그 + 버튼으로 확대/이동 허용 */
  interactive?: boolean;
  /** "실시간 정체" 토글 버튼을 띄운다(뷰포트 전체 ITS 정체 레이어, 카카오 콜 없음) */
  trafficToggle?: boolean;
  /** 일반/위성 전환 단추를 띄운다 — 단추 안에 넣는 미리보기는 false(저장된 지도 종류는 그대로 따른다) */
  modeToggle?: boolean;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const overlaysRef = useRef<any[]>([]);
  const layerOverlaysRef = useRef<any[]>([]);
  const fitRef = useRef<() => void>(() => {});
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const [mode, setMode] = useState<MapMode>("map");
  const [moved, setMoved] = useState(false);
  const [atMin, setAtMin] = useState(true);
  const [showTraffic, setShowTraffic] = useState(false);
  const [layer, setLayer] = useState<{ s: number; c: number[] }[] | null>(null);
  const layerKey = useRef("");

  useEffect(() => {
    try {
      if (localStorage.getItem(MODE_KEY) === "sat") setMode("sat");
    } catch {}
  }, []);

  // 정체 레이어를 끄면 캐시한 링크·조회키를 비운다
  useEffect(() => {
    if (!showTraffic) {
      setLayer(null);
      layerKey.current = "";
    }
  }, [showTraffic]);

  const pick = (m: MapMode) => (e: React.MouseEvent) => {
    e.stopPropagation();
    setMode(m);
    try {
      localStorage.setItem(MODE_KEY, m);
    } catch {}
  };

  // 지도 생성 (1회)
  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    loadKakaoSdk()
      .then(() => {
        const box = boxRef.current;
        if (cancelled || !box) return;
        const kakao = window.kakao;
        const map = new kakao.maps.Map(box, {
          center: new kakao.maps.LatLng(36.5, 127.8),
          level: 12,
        });
        mapRef.current = map;
        ro = new ResizeObserver(() => {
          map.relayout();
        });
        ro.observe(box);
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      ro?.disconnect();
      mapRef.current = null;
    };
  }, []);

  // 일반/위성
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const k = window.kakao.maps;
    map.setMapTypeId(mode === "sat" ? k.MapTypeId.HYBRID : k.MapTypeId.ROADMAP);
  }, [ready, mode]);

  // 조작 허용 여부 + 줌/이동 상태
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    map.setDraggable(interactive);
    map.setZoomable(interactive);
    if (!interactive) return;
    const k = window.kakao.maps;
    const onChange = () => {
      setMoved(true);
      setAtMin(map.getLevel() >= fitLevel.current);
    };
    k.event.addListener(map, "dragend", onChange);
    k.event.addListener(map, "zoom_changed", onChange);
    return () => {
      k.event.removeListener(map, "dragend", onChange);
      k.event.removeListener(map, "zoom_changed", onChange);
    };
  }, [ready, interactive]);
  const fitLevel = useRef(14);

  // 경로·마커·정복 동 그리기 + 전체 맞춤
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const kakao = window.kakao;
    for (const o of overlaysRef.current) o.setMap(null);
    overlaysRef.current = [];
    const src = paths && paths.length ? paths : enc ? [enc] : [];
    const polys = src.map((p) => decodePolyline(p)).filter((pp) => pp.length >= 2);
    if (polys.length === 0) return;
    const isMulti = !!(paths && paths.length);
    const ll = (pt: number[]) => new kakao.maps.LatLng(pt[0], pt[1]);
    const add = (o: any) => {
      o.setMap(map);
      overlaysRef.current.push(o);
    };
    const line = (pts: any[], color: string, weight: number, opacity = 1) =>
      add(new kakao.maps.Polyline({ path: pts, strokeColor: color, strokeWeight: weight, strokeOpacity: opacity, strokeStyle: "solid" }));

    // 정복한 행정동 반투명 칠 (경로 밑)
    for (const dg of dongFills ?? []) {
      for (const ring of dg.rings) {
        if (ring.length < 6) continue;
        const pts = [];
        for (let i = 0; i + 1 < ring.length; i += 2) pts.push(new kakao.maps.LatLng(ring[i], ring[i + 1]));
        add(new kakao.maps.Polygon({ path: pts, strokeColor: "#3b82f6", strokeWeight: 1, strokeOpacity: 0.5, fillColor: "#3b82f6", fillOpacity: 0.3 }));
      }
    }

    if (isMulti) {
      // 점이 많으면 렌더가 느려지므로 전체 ~8000점으로 다운샘플
      const total = polys.reduce((n, pp) => n + pp.length, 0);
      const stride = Math.max(1, Math.round(total / 8000));
      for (const [color, width, op] of [["#000000", 6, 0.35], ["#2563eb", 4, 0.7]] as const) {
        for (const pp of polys) {
          const pts = [];
          for (let i = 0; i < pp.length; i += stride) pts.push(ll(pp[i]));
          pts.push(ll(pp[pp.length - 1]));
          line(pts, color, width, op);
        }
      }
    } else {
      const pp = polys[0];
      const all = pp.map(ll);
      const colorAt = (i: number): string | null => {
        // i-1 → i 구간 색
        if (speeds && speeds.length >= 2) return speedColor(speeds[Math.min(i, speeds.length - 1)] ?? 0, speedBins);
        if (trafficSamples && trafficSamples.length) {
          const mlat = (pp[i - 1][0] + pp[i][0]) / 2;
          const mlng = (pp[i - 1][1] + pp[i][1]) / 2;
          let bestD = Infinity;
          let state = 0;
          for (const t of trafficSamples) {
            const d = Math.hypot((t.lng - mlng) * 88_000, (t.lat - mlat) * 111_000);
            if (d < bestD) {
              bestD = d;
              state = t.state;
            }
          }
          return bestD <= TRAFFIC_MATCH_M ? (TRAFFIC_COLORS[state] ?? TRAFFIC_PLAIN) : TRAFFIC_PLAIN;
        }
        return null;
      };
      if (!colorAt(1)) {
        line(all, "#000000", 7, 0.55);
        line(all, "#34d399", 4);
      } else {
        line(all, "#000000", 7, 0.55);
        // 같은 색이 이어지는 구간은 한 선으로 묶는다
        let runColor = colorAt(1)!;
        let run = [all[0], all[1]];
        for (let i = 2; i < all.length; i++) {
          const c = colorAt(i)!;
          if (c === runColor) run.push(all[i]);
          else {
            line(run, runColor, 4);
            runColor = c;
            run = [all[i - 1], all[i]];
          }
        }
        line(run, runColor, 4);
      }
      // 출발(초록)·도착(빨강) 점
      for (const [i, color] of [[0, "#10b981"], [pp.length - 1, "#ef4444"]] as const) {
        add(new kakao.maps.CustomOverlay({
          position: all[i],
          yAnchor: 0.5,
          xAnchor: 0.5,
          zIndex: 5,
          content: `<div style="width:14px;height:14px;border-radius:50%;background:${color};border:2.5px solid #fafaf9;box-sizing:border-box"></div>`,
        }));
      }
    }

    // 전체 맞춤 — 처음 한 번만 자동, 이후는 "전체 보기" 버튼
    const fit = () => {
      const bounds = new kakao.maps.LatLngBounds();
      for (const pp of polys) for (const pt of pp) bounds.extend(ll(pt));
      map.relayout();
      map.setBounds(bounds, 24, 24, 24, 24);
      fitLevel.current = map.getLevel();
      setMoved(false);
      setAtMin(true);
    };
    fitRef.current = fit;
    fit();
  }, [ready, enc, paths, speeds, speedBins, trafficSamples, dongFills]);

  // ITS 정체 레이어 — 보이는 영역이 (약 1km 격자로) 바뀔 때만 재조회
  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map || !showTraffic) return;
    const k = window.kakao.maps;
    let cancelled = false;
    const load = () => {
      const b = map.getBounds();
      const sw = b.getSouthWest(), ne = b.getNorthEast();
      const west = sw.getLng(), south = sw.getLat(), east = ne.getLng(), north = ne.getLat();
      const z = Math.max(0, Math.min(19, 20 - map.getLevel()));
      const key = `${z}:${west.toFixed(2)},${south.toFixed(2)},${east.toFixed(2)},${north.toFixed(2)}`;
      if (key === layerKey.current) return;
      layerKey.current = key;
      fetch(`/api/traffic-layer?bbox=${west},${south},${east},${north}&z=${z}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!cancelled && Array.isArray(d?.links)) setLayer(d.links);
        })
        .catch(() => {});
    };
    load();
    k.event.addListener(map, "idle", load);
    return () => {
      cancelled = true;
      k.event.removeListener(map, "idle", load);
    };
  }, [ready, showTraffic]);

  useEffect(() => {
    const map = mapRef.current;
    if (!ready || !map) return;
    const kakao = window.kakao;
    for (const o of layerOverlaysRef.current) o.setMap(null);
    layerOverlaysRef.current = [];
    if (!showTraffic || !layer) return;
    for (const ln of layer) {
      const c = ln.c;
      if (c.length < 4) continue;
      const pts = [];
      for (let i = 0; i + 1 < c.length; i += 2) pts.push(new kakao.maps.LatLng(c[i], c[i + 1]));
      const pl = new kakao.maps.Polyline({ path: pts, strokeColor: TRAFFIC_COLORS[ln.s] ?? TRAFFIC_PLAIN, strokeWeight: 3, strokeOpacity: 0.95, zIndex: 1 });
      pl.setMap(map);
      layerOverlaysRef.current.push(pl);
    }
  }, [ready, showTraffic, layer]);

  const bumpZoom = (d: number) => (e: React.MouseEvent) => {
    e.stopPropagation();
    const map = mapRef.current;
    if (!map) return;
    map.setLevel(map.getLevel() - d, { animate: true });
    setMoved(true);
  };

  return (
    <div className="relative">
      <div ref={boxRef} className={`w-full overflow-hidden rounded-md bg-panel ${className}`} />
      {failed && (
        <p className="absolute inset-0 grid place-items-center rounded-md bg-panel text-[12px] text-secondary">지도를 불러오지 못했어요</p>
      )}
      {modeToggle && <div className="absolute z-10 right-1.5 top-1.5 flex overflow-hidden rounded-md text-[11px]">
        {(Object.keys(MODES) as MapMode[]).map((m) => (
          <button
            key={m}
            onClick={pick(m)}
            className={
              mode === m
                ? "bg-accent px-3 py-2 font-semibold text-primary"
                : "bg-raised px-3 py-2 text-secondary ring-1 ring-inset ring-line"
            }
          >
            {MODES[m].label}
          </button>
        ))}
      </div>}
      {trafficToggle && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowTraffic((v) => !v);
          }}
          className={`absolute z-10 left-1.5 top-1.5 rounded-md px-3 py-2 text-[11px] font-semibold ${
            showTraffic
              ? "bg-accent text-primary"
              : "bg-raised text-secondary ring-1 ring-inset ring-line"
          }`}
        >
          실시간 정체
        </button>
      )}
      {trafficToggle && showTraffic && (
        <div className="absolute z-10 bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-md bg-bg px-2 py-1 text-[10px] text-secondary">
          {[
            ["#e11d48", "정체"],
            ["#f97316", "지체"],
            ["#facc15", "서행"],
            ["#22c55e", "원활"],
          ].map(([c, l]) => (
            <span key={l} className="inline-flex items-center gap-1">
              <span className="h-1.5 w-3 rounded-sm" style={{ background: c }} />
              {l}
            </span>
          ))}
        </div>
      )}
      {interactive && (
        <div className="absolute z-10 bottom-2 right-2 flex flex-col overflow-hidden rounded-md border border-line">
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
            disabled={atMin}
            className="border-t border-line bg-bg px-3 py-3 text-base font-bold leading-none text-primary hover:bg-panel disabled:opacity-40"
          >
            －
          </button>
        </div>
      )}
      {interactive && moved && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            fitRef.current();
          }}
          className="absolute z-10 bottom-2 left-2 rounded-md bg-bg px-3 py-1 text-[11px] font-medium text-primary hover:bg-panel"
        >
          전체 보기
        </button>
      )}
    </div>
  );
}
