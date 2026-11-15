"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useRef, useState } from "react";
import { loadKakaoSdk } from "@/lib/kakao-sdk";
import { matchTrafficStates } from "@/lib/traffic-match";
import type { NavMapProps } from "./NavMap";

const COLORS: Record<number, string> = { 1: "#ef4444", 2: "#f97316", 3: "#eab308", 4: "#22c55e" };

/** Official Kakao web map for browsers and x86 emulators. Map stays north-up;
 * the vehicle marker follows its actual bearing. ARM uses the native Kakao map. */
export default function NavMapKakao(props: NavMapProps) {
  const root = useRef<HTMLDivElement>(null);
  const map = useRef<any>(null);
  const marker = useRef<any>(null);
  const arrow = useRef<HTMLDivElement | null>(null);
  const latest = useRef(props); latest.current = props;
  const following = useRef(true);
  const bearing = useRef(0);
  const lines = useRef<any[]>([]);
  const trace = useRef<any>(null);
  const cameraMarkers = useRef<any[]>([]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [follow, setFollow] = useState(true);

  useEffect(() => {
    let alive = true;
    let observer: ResizeObserver | undefined;
    let drag: (() => void) | undefined;
    loadKakaoSdk().then(() => {
      if (!alive || !root.current) return;
      const k = window.kakao.maps;
      const p = latest.current.pos ?? latest.current.trace?.at(-1) ?? latest.current.path[0] ?? { lat: 37.5665, lng: 126.978 };
      // Focus on the immediate road rather than an entire district full of POIs.
      const instance = new k.Map(root.current, { center: new k.LatLng(p.lat, p.lng), level: typeof window.DriveNative?.startPleosCourse === "function" ? 4 : 2 });
      map.current = instance;
      const element = document.createElement("div");
      element.setAttribute("aria-label", "차량 진행 방향");
      element.dataset.vehicleBearing = "0";
      element.style.cssText = "width:44px;height:52px;transform-origin:50% 50%;transition:transform .3s linear;filter:drop-shadow(0 2px 4px #0006);pointer-events:none";
      element.innerHTML = '<svg width="44" height="52" viewBox="0 0 44 52" aria-hidden="true"><path d="M22 3 L40 45 L22 36 L4 45 Z" fill="#1677ff" stroke="white" stroke-width="3" stroke-linejoin="round"/></svg>';
      arrow.current = element;
      marker.current = new k.CustomOverlay({ map: instance, position: new k.LatLng(p.lat, p.lng), content: element, xAnchor: .5, yAnchor: .5, zIndex: 20 });
      trace.current = new k.Polyline({ map: instance, path: [], strokeColor: "#647b96", strokeWeight: 3, strokeOpacity: .55 });
      drag = () => { following.current = false; setFollow(false); };
      k.event.addListener(instance, "dragstart", drag);
      observer = new ResizeObserver(() => { instance.relayout(); if (following.current && latest.current.pos) instance.setCenter(new k.LatLng(latest.current.pos.lat, latest.current.pos.lng)); });
      observer.observe(root.current);
      setReady(true); setError("");
    }).catch(() => { if (alive) setError("카카오 지도를 불러오지 못했어요."); });
    return () => {
      alive = false; observer?.disconnect();
      if (drag && map.current) window.kakao.maps.event.removeListener(map.current, "dragstart", drag);
      marker.current?.setMap(null); trace.current?.setMap(null);
      for (const item of [...lines.current, ...cameraMarkers.current]) item.setMap(null);
      lines.current = []; cameraMarkers.current = []; map.current = null;
      setReady(false);
    };
  }, [retry]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const current = props.pos ?? props.trace?.at(-1);
    if (!current) return;
    const k = window.kakao.maps;
    const position = new k.LatLng(current.lat, current.lng);
    marker.current.setPosition(position);
    let heading = props.heading;
    // Paused sessions may restore before the native bearing arrives. Recover the
    // last direction from the saved trace instead of showing a north-facing car.
    if (heading == null && props.trace && props.trace.length > 1) {
      const end = props.trace[props.trace.length - 1];
      for (let i = props.trace.length - 2; i >= 0; i--) {
        const start = props.trace[i];
        const x = (end.lng - start.lng) * Math.cos(end.lat * Math.PI / 180);
        const y = end.lat - start.lat;
        if (Math.hypot(x, y) * 111320 > 4) {
          heading = (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
          break;
        }
      }
    }
    if (heading != null && Number.isFinite(heading)) {
      const delta = ((heading - bearing.current + 540) % 360) - 180;
      bearing.current += delta;
      if (arrow.current) {
        arrow.current.style.transform = `rotate(${bearing.current}deg)`;
        arrow.current.dataset.vehicleBearing = String((bearing.current % 360 + 360) % 360);
      }
    }
    if (following.current) map.current.setCenter(position);
  }, [ready, props.pos, props.heading, props.trace]);

  useEffect(() => {
    if (!ready || !map.current) return;
    const k = window.kakao.maps;
    for (const line of lines.current) line.setMap(null);
    lines.current = [];
    const add = (points: NavMapProps["path"], color: string, weight = 7) => {
      if (points.length < 2) return;
      lines.current.push(new k.Polyline({ map: map.current, path: points.map(p => new k.LatLng(p.lat, p.lng)), strokeWeight: weight, strokeColor: color, strokeOpacity: .95, zIndex: 3 }));
    };
    add(props.path, "#ffffff", 12);
    add(props.path, "#2563eb");
    const states = matchTrafficStates(props.path, props.traffic);
    if (states) {
      let start = 0;
      for (let i = 1; i <= props.path.length; i++) {
        if (i < props.path.length && states[i] === states[start]) continue;
        if (COLORS[states[start]]) add(props.path.slice(start, Math.min(i + 1, props.path.length)), COLORS[states[start]]);
        start = i;
      }
    }
    if (props.compare?.route) add(props.compare.route, "#a855f7", 3);
  }, [ready, props.path, props.traffic, props.compare?.route]);

  useEffect(() => {
    if (!ready || !trace.current) return;
    // Keep the complete recording, but only show its recent 600m in the live view.
    const points = props.trace ?? [];
    let first = Math.max(0, points.length - 1), distance = 0;
    while (first > 0 && distance < 600) {
      const a = points[first - 1], b = points[first];
      distance += Math.hypot((a.lat - b.lat) * 111320,
        (a.lng - b.lng) * 111320 * Math.cos(b.lat * Math.PI / 180));
      first--;
    }
    trace.current.setPath(points.slice(first).map(p => new window.kakao.maps.LatLng(p.lat, p.lng)));
  }, [ready, props.trace]);

  useEffect(() => {
    if (!ready || !map.current) return;
    for (const item of cameraMarkers.current) item.setMap(null);
    cameraMarkers.current = props.cams.map(cam => {
      const content = document.createElement("div");
      content.style.cssText = "border:3px solid #ef4444;border-radius:50%;background:white;color:#18181b;padding:3px;font:bold 12px sans-serif;min-width:28px;text-align:center";
      content.textContent = String(cam.limitKmh || "단속");
      return new window.kakao.maps.CustomOverlay({ map: map.current, position: new window.kakao.maps.LatLng(cam.lat, cam.lng), content, zIndex: 5 });
    });
  }, [ready, props.cams]);

  const button = "min-h-11 min-w-11 rounded-lg border border-line bg-panel px-3 text-sm font-bold text-primary shadow-sm";
  return <div className={`fundrive-kakao-driving isolate relative h-full w-full overflow-hidden bg-panel`} data-map-provider="kakao">
    <div ref={root} className="absolute inset-0" />
    <div data-over-map className="absolute right-3 z-10 flex gap-2" style={{ top: (props.insetTop ?? 0) + 12 }}>
      <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-panel text-sm font-bold text-secondary" aria-label="북쪽 고정 지도">N ↑</span>
    </div>
    <div data-over-map className="absolute right-3 z-10 flex flex-col gap-2" style={{ bottom: (props.insetBottom ?? 0) + 24 }}>
      <button type="button" aria-label="확대" className={button} onClick={() => { if (map.current) map.current.setLevel(Math.max(1, map.current.getLevel() - 1)); }}>＋</button>
      <button type="button" aria-label="축소" className={button} onClick={() => { if (map.current) map.current.setLevel(Math.min(12, map.current.getLevel() + 1)); }}>−</button>
      {!follow && <button type="button" className={button} onClick={() => {
        following.current = true; setFollow(true);
        if (props.pos && map.current) map.current.setCenter(new window.kakao.maps.LatLng(props.pos.lat, props.pos.lng));
      }}>현위치</button>}
    </div>
    {(!ready || error) && <div className="absolute inset-0 flex items-center justify-center bg-panel text-sm text-secondary">
      {error ? <div className="space-y-3 text-center"><p>{error}</p><button type="button" className={button} onClick={() => { setError(""); setRetry(n => n + 1); }}>다시 시도</button></div> : "카카오 지도 불러오는 중…"}
    </div>}
  </div>;
}
