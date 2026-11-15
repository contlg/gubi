"use client";

import { IconTarget } from "@/components/icons";

import { useEffect, useMemo, useRef, useState } from "react";
import { cssRect, kakaoZoom, nativeMapBridge, nativeMapGeometryAnimating, nativeMapRouteData, nativeMapTrace, nativeMapSession } from "@/lib/native-nav-map";
import type { NavMapProps } from "./NavMap";

let failed = false;
let noticeUsed = false;
const failureEvent = "drivelog-native-map-failed";

export function useNativeNavMap(active: boolean) {
  const [enabled, setEnabled] = useState(false);
  const [notice, setNotice] = useState(false);
  useEffect(() => {
    if (!active) { setEnabled(false); return; }
    const showNotice = () => { if (!noticeUsed) { noticeUsed = true; setNotice(true); } };
    const fallback = () => { failed = true; setEnabled(false); showNotice(); };
    window.addEventListener(failureEvent, fallback);
    try {
      const bridge = nativeMapBridge();
      const status = bridge?.nativeNavMapStatus?.();
      if (status === "error") fallback();
      else if (status === "no_key") showNotice();
      else if (!failed && bridge?.nativeNavMapAvailable?.()) setEnabled(true);
    } catch { fallback(); }
    return () => window.removeEventListener(failureEvent, fallback);
  }, [active]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(false), 5000);
    return () => clearTimeout(timer);
  }, [notice]);
  return { enabled, notice };
}

export default function NavMapNative(props: NavMapProps) {
  const root = useRef<HTMLDivElement>(null);
  const send = useRef<(method: "nativeNavMapData" | "nativeNavMapFix" | "nativeNavMapCommand", data: object) => void>(() => {});
  const [following, setFollowing] = useState(true);
  const [tilt, setTilt] = useState(true);
  const [headingUp, setHeadingUp] = useState(true);
  const routeKey = useMemo(() => JSON.stringify(nativeMapRouteData(props)), [props.path, props.traffic]);
  const detailsKey = useMemo(() => JSON.stringify({ cams: props.cams, maneuvers: props.maneuvers }), [props.cams, props.maneuvers]);
  const traceKey = useMemo(() => JSON.stringify({ trace: nativeMapTrace(props.trace) }), [props.trace]);
  const fixKey = JSON.stringify({ ...props.pos, heading: props.heading, kmh: props.kmh, zoom: kakaoZoom(props.kmh, typeof window !== "undefined" && typeof window.DriveNative?.startPleosCourse === "function" ? -1 : 0),
    alongIdx: props.alongIdx, nextAt: props.nextAt, offRoute: props.offRoute });

  useEffect(() => {
    const bridge = nativeMapBridge();
    if (!bridge || !root.current) return;
    const session = nativeMapSession(bridge, setFollowing, () => {
      failed = true;
      window.dispatchEvent(new Event(failureEvent));
    });
    window.__nativeNavMap = session.receive;
    send.current = (method, value) => {
      try { bridge[method]?.(JSON.stringify({ ...value, generation: session.generation })); }
      catch { session.fail("bridge_error"); }
    };
    document.documentElement.setAttribute("data-native-nav-map", "");
    let frame = 0, shown = false, lastLayout = "";
    const observed = new Set<Element>();
    const visible = (el: Element) => {
      const r = el.getBoundingClientRect(), style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden"
        && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    const refresh = () => {
      frame = 0;
      if (!root.current) return;
      const overlays = Array.from(document.querySelectorAll("[data-over-map]"));
      const elements = [root.current, ...overlays, ...document.querySelectorAll("[data-map-block]")];
      for (const el of observed) if (!elements.includes(el)) { observer.unobserve(el); observed.delete(el); }
      for (const el of elements) if (!observed.has(el)) { observer.observe(el); observed.add(el); }
      // 하위 요소와 조상 요소의 이동 애니메이션도 영역 재측정 대상이다.
      const moving = document.getAnimations().some((animation) => {
        const target = (animation.effect as KeyframeEffect | null)?.target;
        return nativeMapGeometryAnimating(animation) && target instanceof Element
          && overlays.some((el) => target === el || target.contains(el) || el.contains(target));
      });
      const viewport = window.visualViewport;
      const rect = (el: Element) => {
        const r = cssRect(el.getBoundingClientRect());
        return { left: r.left - (viewport?.offsetLeft ?? 0), right: r.right - (viewport?.offsetLeft ?? 0),
          top: r.top - (viewport?.offsetTop ?? 0), bottom: r.bottom - (viewport?.offsetTop ?? 0) };
      };
      const layout = JSON.stringify({ generation: session.generation, mapRect: rect(root.current),
        exclusionRects: overlays.filter((el) => visible(el) && getComputedStyle(el).pointerEvents !== "none").map(rect),
        blocked: Array.from(document.querySelectorAll("[data-map-block]")).some(visible),
        // 기기 배율에 페이지 확대 비율을 더해 지도 좌표를 환산한다.
        cssScale: devicePixelRatio * (viewport?.scale ?? 1) });
      if (layout !== lastLayout) {
        try {
          if (!shown) { bridge.nativeNavMapShow?.(layout); shown = true; }
          else bridge.nativeNavMapLayout?.(layout);
          lastLayout = layout;
        } catch { session.fail("layout_error"); }
      }
      if (moving) frame = requestAnimationFrame(refresh);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(refresh); };
    const observer = new ResizeObserver(schedule);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true,
      attributeFilter: ["class", "style", "hidden", "data-over-map", "data-map-block"] });
    for (const event of ["scroll", "resize", "transitionrun", "transitionend", "transitioncancel", "animationend", "animationstart"]) {
      window.addEventListener(event, schedule, true);
    }
    window.visualViewport?.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("scroll", schedule);
    refresh();
    return () => {
      send.current = () => {};
      session.close();
      if (window.__nativeNavMap === session.receive) delete window.__nativeNavMap;
      document.documentElement.removeAttribute("data-native-nav-map");
      observer.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame);
      for (const event of ["scroll", "resize", "transitionrun", "transitionend", "transitioncancel", "animationend", "animationstart"]) {
        window.removeEventListener(event, schedule, true);
      }
      window.visualViewport?.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("scroll", schedule);
    };
  }, []);
  useEffect(() => { send.current("nativeNavMapData", JSON.parse(routeKey)); }, [routeKey]);
  useEffect(() => { send.current("nativeNavMapData", JSON.parse(detailsKey)); }, [detailsKey]);
  useEffect(() => { send.current("nativeNavMapData", JSON.parse(traceKey)); }, [traceKey]);
  useEffect(() => { send.current("nativeNavMapFix", JSON.parse(fixKey)); }, [fixKey]);
  const command = (cmd: string, fields = {}) => send.current("nativeNavMapCommand", { cmd, ...fields });
  const btn = "rounded-md px-3 py-3 text-[11px] font-semibold";
  return (
    <div ref={root} className={`relative h-full w-full overflow-hidden ${props.fullBleed ? "" : "rounded-md"}`}>
      <div data-over-map className="absolute right-2 flex gap-1" style={{ top: 8 + (props.insetTop ?? 0) }}>
        <button data-over-map type="button" onClick={() => { setHeadingUp(!headingUp); command("headingUp", { on: !headingUp }); }}
          className={`${btn} bg-bg text-secondary`}>{headingUp ? "회전" : "북쪽 고정"}</button>
        <button data-over-map type="button" onClick={() => { setTilt(!tilt); command("tilt", { on: !tilt }); }}
          className={`${btn} ${tilt ? "bg-accent text-primary" : "bg-bg text-secondary"}`}>3D</button>
      </div>
      <div data-over-map className="absolute right-2 flex flex-col gap-1" style={{ bottom: 8 + (props.insetBottom ?? 0) }}>
        {props.engineToggle && <button data-over-map type="button" onClick={props.engineToggle.onClick}
          className={`${btn} mb-1 bg-bg text-secondary`}>{props.engineToggle.label}</button>}
        {!following && <button data-over-map type="button" aria-label="현재 위치로"
          onClick={() => { setFollowing(true); command("recenter"); }}
          className="mb-1 grid h-12 w-12 place-items-center rounded-sm border border-line bg-accent text-primary"><IconTarget /></button>}
        <button data-over-map type="button" aria-label="확대" onClick={() => command("zoom", { d: 0.5 })}
          className="h-12 w-12 rounded-md border border-line bg-bg text-base font-bold text-primary">+</button>
        <button data-over-map type="button" aria-label="축소" onClick={() => command("zoom", { d: -0.5 })}
          className="h-12 w-12 rounded-md border border-line bg-bg text-base font-bold text-primary">−</button>
      </div>
    </div>
  );
}
