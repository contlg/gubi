"use client";

import { IconTarget } from "@/components/icons";

/**
 * 자체 내비 지도 — MapLibre(벡터 지도) 판. NavMap(타일 캔버스)과 같은 props를 받는다.
 * 글자·도로를 폰이 직접 그려서 3D로 눕혀도 글자가 서 있고, 확대해도 안 흐려진다.
 * 지도 자료는 OpenFreeMap(키 불필요, OSM 기반), 위성은 Esri 타일을 그 위에 깐다.
 * 개발 서버(NEXT_PUBLIC_MAP_GL=1 빌드)에서만 쓰고, "옛 지도" 버튼으로 NavMap으로 돌아간다.
 *
 * 움직임: NavMap과 같이 픽스 사이를 지금 속도·방향으로 굴려(최대 1.5초) 매 프레임 카메라를
 * 옮긴다. 손가락으로 끌면 따라가기를 풀고, 핀치 줌은 따라가기를 유지한 채 줌만 보정한다.
 */

import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { useEffect, useRef, useState } from "react";

import type { LatLng } from "@/lib/types";
import { matchTrafficStates } from "@/lib/traffic-match";
import type { NavMapProps } from "./NavMap";

const STYLE_BASE = "https://tiles.openfreemap.org/styles/";
const THEME_KEY = "drivelog-navmap-theme-v1";
/** day/night = liberty를 내비용으로 다시 칠한 것(카카오 느낌), 나머지는 OpenFreeMap 기본 디자인 그대로 */
export type MapTheme = "day" | "night" | "liberty" | "positron" | "dark";
const THEME_STYLE: Record<MapTheme, string> = { day: "liberty", night: "liberty", liberty: "liberty", positron: "positron", dark: "dark" };

/** 내비용 색 — 길·물·녹지만 또렷하게, 나머지는 눌러서 경로가 돋보이게 */
const PALETTE = {
  // 낮 색은 카카오맵 화면에서 직접 뽑은 값(10-25, 수원 매산동 캡처): 거의 흰 바탕에 흰 건물+연회색 테두리,
  // 밝은 노랑 큰길(테두리 진하지 않게), 학교·관공서 하늘색, 운동장 베이지, 공원 연두, 장소 글씨 진회색
  day: {
    bg: "#fafafa", water: "#c2dcf3", green: "#d0ecc3", resid: "#fafafa", building: "#ffffff", aero: "#eeeeee",
    buildingLine: "#d3d3d8", school: "#e7f2f8", hospital: "#fbecec", pitch: "#e8e3d0",
    poi: { edu: "#4f6d8c", med: "#d9534f", food: "#d4582a", shop: "#a0762a", other: "#5b6566" },
    motorway: ["#ffd24d", "#f0c03c"], trunk: ["#ffdf69", "#f2cf63"], secondary: ["#ffffff", "#cfd0d6"],
    minor: ["#ffffff", "#d8d9de"], path: "#e6e6e9", rail: "#cfd1d6",
    text: "#5b6566", halo: "#ffffff", roadText: "#5b6566",
  },
  night: {
    bg: "#262a31", water: "#1d3150", green: "#26332d", resid: "#2b2f36", building: "#353a43", aero: "#2f333a",
    buildingLine: "#40454f", school: "#28344a", hospital: "#3a2c30", pitch: "#3a3630",
    poi: { edu: "#8db4f0", med: "#f09a97", food: "#e8a76b", shop: "#d9b75e", other: "#aeb4bf" },
    motorway: ["#8a7150", "#5f4e38"], trunk: ["#6c6455", "#4a443a"], secondary: ["#535862", "#2f333a"],
    minor: ["#434852", "#2b2f36"], path: "#363a42", rail: "#4a4f58",
    text: "#dfe2e7", halo: "#1b1e23", roadText: "#b9bec7",
  },
} as const;

function applyPalette(map: maplibregl.Map, theme: MapTheme) {
  if (theme !== "day" && theme !== "night") return;
  const c = PALETTE[theme];
  const set = (id: string, prop: string, v: unknown) => {
    try {
      map.setPaintProperty(id, prop, v);
    } catch {}
  };
  for (const l of map.getStyle().layers ?? []) {
    const id = l.id;
    // 군더더기 — 덜 중요한 상점·시설(r7·r20), 일방통행 화살표, 바탕 음영, 광장 빗금, 빈 도로번호 상자
    if (/^poi_r20|one_way|natural_earth|road_area_pattern|shield/.test(id)) {
      map.setLayoutProperty(id, "visibility", "none");
      continue;
    }
    if (l.type === "background") set(id, "background-color", c.bg);
    else if (l.type === "fill") {
      // 카카오맵처럼 용도별로 옅게 — 학교 파랑, 병원 분홍, 운동장 베이지, 공원·숲 초록
      const col = /water/.test(id) ? c.water
        : /school/.test(id) ? c.school
        : /hospital/.test(id) ? c.hospital
        : /pitch|track/.test(id) ? c.pitch
        : /park|wood|grass|wetland|cemetery/.test(id) ? c.green
        : /building/.test(id) ? c.building
        : /aeroway/.test(id) ? c.aero
        : /residential|sand|ice/.test(id) ? c.resid
        : null;
      if (col) set(id, "fill-color", col);
      if (/park|school|hospital|pitch|track/.test(id)) set(id, "fill-opacity", 1);
      if (id === "building") {
        set(id, "fill-outline-color", c.buildingLine);
        set(id, "fill-opacity", 1);
        // 기본 스타일은 줌 14부터 평면 건물을 끄고 입체로만 그린다 — 평면(3D 꺼짐)에서도 보이게 끝까지
        map.setLayerZoomRange(id, 13, 24);
      }
    } else if (l.type === "fill-extrusion") {
      set(id, "fill-extrusion-color", c.building);
      set(id, "fill-extrusion-opacity", 0.85);
    } else if (l.type === "line") {
      const casing = /casing/.test(id);
      const pick = (pair: readonly [string, string]) => (casing ? pair[1] : pair[0]);
      const col = /waterway/.test(id) ? c.water
        : /park_outline|boundary|hatching/.test(id) ? null
        : /rail/.test(id) ? c.rail
        : /path_pedestrian/.test(id) ? c.path
        : /motorway/.test(id) ? pick(c.motorway)
        : /trunk_primary/.test(id) ? pick(c.trunk)
        : /secondary_tertiary/.test(id) ? pick(c.secondary)
        : /minor|street|link|service_track/.test(id) ? pick(c.minor)
        : /aeroway/.test(id) ? c.aero
        : null;
      if (col) set(id, "line-color", col);
      if (/park_outline/.test(id)) map.setLayoutProperty(id, "visibility", "none");
    } else if (l.type === "symbol") {
      const road = /highway-name/.test(id);
      const p = c.poi;
      // 장소 이름은 종류별 색(카카오맵처럼) — 학교 파랑·병원 빨강·먹거리 주황·가게 황토
      const poiColor = ["match", ["get", "class"],
        ["school", "college", "library", "kindergarten"], p.edu,
        ["hospital", "doctors", "dentist", "pharmacy", "veterinary"], p.med,
        ["cafe", "restaurant", "fast_food", "bakery", "bar", "beer", "ice_cream"], p.food,
        ["shop", "grocery", "convenience", "supermarket", "clothing_store", "department_store"], p.shop,
        p.other];
      set(id, "text-color", /^poi_r(1|7)$/.test(id) ? poiColor : road ? c.roadText : c.text);
      // 장소 층에서도 버스정류장은 뺀다(대중교통 층과 같은 이유)
      if (/^poi_r(1|7)$/.test(id)) {
        const f = map.getFilter(id);
        if (f) map.setFilter(id, ["all", f, ["!=", ["get", "class"], "bus"]] as maplibregl.FilterSpecification);
      }
      set(id, "text-halo-color", c.halo);
      set(id, "text-halo-width", 1.4);
    }
  }
}
const SAT_TILES = "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
// NavMap과 같은 저장 키 — 두 지도를 오가도 선택이 유지된다
const MODE_KEY = "drivelog-navmap-mode-v1";
const ROT_KEY = "drivelog-nav-rotate-v1";
const TILT_KEY = "drivelog-nav-3d-v1";
const PITCH_3D = 55;
const TRAFFIC_LINE: Record<number, string> = { 1: "#ef4444", 2: "#f97316", 3: "#eab308", 4: "#22c55e" };

type FC = GeoJSON.FeatureCollection;
const fc = (features: GeoJSON.Feature[] = []): FC => ({ type: "FeatureCollection", features });
const line = (pts: LatLng[], props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: "Feature",
  properties: props,
  geometry: { type: "LineString", coordinates: pts.map((p) => [p.lng, p.lat]) },
});
const point = (p: LatLng, props: Record<string, unknown> = {}): GeoJSON.Feature => ({
  type: "Feature",
  properties: props,
  geometry: { type: "Point", coordinates: [p.lng, p.lat] },
});
const lerpAngle = (a: number, b: number, t: number) => a + ((((b - a + 540) % 360) - 180) * t);

/** 속도 연동 줌(256px 타일 기준 NavMap과 같은 값) – MapLibre 줌(512px 기준이라 1 작다).
 *  110km/h 넘으면 300km/h까지 1.5단계 더 넓게 */
const autoZoom = (kmh: number) => {
  const v = Math.max(kmh, 0);
  return 16.6 - (Math.min(v, 110) / 110) * 1.5 - (Math.min(Math.max(v - 110, 0), 190) / 190) * 1.5 - 1;
};

/** 지명은 한글 이름 우선(없으면 현지 이름) — 기본 스타일은 "Seoul 서울"처럼 둘 다 쓴다.
 *  기울임 글꼴(정류장·물 이름)은 바로 세운다 — 한글이 비스듬히 누워 어색했다(10-25). */
function koreanLabels(map: maplibregl.Map) {
  for (const l of map.getStyle().layers ?? []) {
    if (l.type !== "symbol" || !l.layout || !("text-field" in l.layout)) continue;
    map.setLayoutProperty(l.id, "text-field", ["coalesce", ["get", "name:ko"], ["get", "name"]]);
    const font = (l.layout as { "text-font"?: unknown })["text-font"];
    if (Array.isArray(font) && font.includes("Noto Sans Italic"))
      map.setLayoutProperty(l.id, "text-font", ["Noto Sans Regular"]);
  }
  // 대중교통 표시는 지하철역·공항만 — 버스정류장이 강남역 일대에만 10개 넘게 떠서 도로명보다 눈에 띄었다
  if (map.getLayer("poi_transit")) map.setFilter("poi_transit", ["match", ["get", "class"], ["airport", "rail"], true, false]);
}

function themeNow(): MapTheme {
  try {
    const t = localStorage.getItem(THEME_KEY);
    if (t && t in THEME_STYLE) return t as MapTheme;
  } catch {}
  return "day";
}

export default function NavMapGL(props: NavMapProps & { engineToggle?: { label: string; onClick: () => void } }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const [mode, setMode] = useState<"map" | "sat">("map");
  const [headingUp, setHeadingUp] = useState(true);
  const [tilt, setTilt] = useState(false);
  const [following, setFollowing] = useState(true);
  const ui = useRef({ mode, headingUp, tilt, following, zoomNudge: 0 });
  ui.current.mode = mode;
  ui.current.headingUp = headingUp;
  ui.current.tilt = tilt;
  ui.current.following = following;
  const mapRef = useRef<maplibregl.Map | null>(null);

  useEffect(() => {
    try {
      if (localStorage.getItem(MODE_KEY) === "sat") setMode("sat");
      if (localStorage.getItem(ROT_KEY) === "north") setHeadingUp(false);
      if (localStorage.getItem(TILT_KEY) === "1") setTilt(true);
    } catch {}
  }, []);

  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    const P0 = propsRef.current;
    const start = P0.pos ?? P0.path[0] ?? { lat: 37.5665, lng: 126.978 };
    const map = new maplibregl.Map({
      container: box,
      style: STYLE_BASE + THEME_STYLE[themeNow()],
      center: [start.lng, start.lat],
      zoom: autoZoom(P0.kmh),
      // 출처 표시는 아래에서 직접 단다(접힌 출처로, 아래 정보창 위에)
      attributionControl: false,
      // 한글은 폰 글꼴로 그린다(지도 서버 글꼴에 한글이 없다)
      localIdeographFontFamily: "'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif",
      pitchWithRotate: true,
      maxPitch: 70,
    });
    mapRef.current = map;
    // 지도 출처(라이선스 표기) — 기본 위치에선 펼쳐진 띠가 "일시중지·주행 종료" 버튼을 덮었다(10-25).
    // 접힌 출처 버튼으로 두고, 아래 정보창 위로 올린다(위치는 insetBottom 효과에서 갱신).
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-left");
    map.once("load", () => box.querySelector(".maplibregl-ctrl-attrib")?.classList.remove("maplibregl-compact-show"));
    // 개발 모드에서만 시험 스크립트가 지도 상태를 읽을 수 있게
    if (process.env.NODE_ENV !== "production") (window as unknown as { __navmap?: maplibregl.Map }).__navmap = map;

    // 차 화살표 — 지도 방향 기준으로 돌고(진행방향), 눕혀도 서 있다
    const el = document.createElement("div");
    el.innerHTML =
      '<svg width="34" height="34" viewBox="-17 -17 34 34"><circle r="15" fill="rgba(14,165,233,0.18)"/>' +
      '<path d="M0,-13 L9.5,9 L0,4 L-9.5,9 Z" fill="#0ea5e9" stroke="#fff" stroke-width="2.5" stroke-linejoin="round"/></svg>';
    const car = new maplibregl.Marker({ element: el, rotationAlignment: "map", pitchAlignment: "viewport" })
      .setLngLat([start.lng, start.lat])
      .addTo(map);

    let ready = false;
    map.on("style.load", () => {
      koreanLabels(map);
      applyPalette(map, themeNow());
      const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
      map.addSource("sat", { type: "raster", tiles: [SAT_TILES], tileSize: 256, maxzoom: 19, attribution: "© Esri" });
      map.addLayer({ id: "sat", type: "raster", source: "sat", layout: { visibility: "none" } }, firstSymbol);
      for (const id of ["trace", "route", "passed", "near", "arrow", "arrowHead", "compareRoute", "cams", "compareCams", "pois"])
        map.addSource(id, { type: "geojson", data: fc() });
      const rnd = { "line-join": "round", "line-cap": "round" } as const;
      // 경로 선은 글자 아래(firstSymbol 앞)에 — 도로 이름이 경로에 안 가리게
      map.addLayer({ id: "trace", type: "line", source: "trace", layout: rnd, paint: { "line-color": "#34d399", "line-width": 4 } }, firstSymbol);
      map.addLayer({ id: "compareRoute", type: "line", source: "compareRoute", paint: { "line-color": "#c026d3", "line-width": 5, "line-dasharray": [2, 1.6] } }, firstSymbol);
      map.addLayer({ id: "routeCasing", type: "line", source: "route", layout: rnd, paint: { "line-color": "rgba(0,0,0,0.5)", "line-width": 10 } }, firstSymbol);
      map.addLayer({ id: "route", type: "line", source: "route", layout: rnd, paint: { "line-color": ["get", "color"], "line-width": 6.5 } }, firstSymbol);
      map.addLayer({ id: "near", type: "line", source: "near", layout: rnd, paint: { "line-color": ["get", "color"], "line-width": 7 } }, firstSymbol);
      map.addLayer({ id: "passed", type: "line", source: "passed", layout: rnd, paint: { "line-color": "rgba(148,163,184,0.95)", "line-width": 6.5 } }, firstSymbol);
      map.addLayer({ id: "arrowCasing", type: "line", source: "arrow", layout: rnd, paint: { "line-color": "#0369a1", "line-width": 12 } });
      map.addLayer({ id: "arrow", type: "line", source: "arrow", layout: rnd, paint: { "line-color": "#ffffff", "line-width": 7 } });
      map.addLayer({ id: "arrowHead", type: "fill", source: "arrowHead", paint: { "fill-color": "#ffffff", "fill-outline-color": "#0369a1" } });
      map.addLayer({
        id: "pois", type: "circle", source: "pois",
        paint: {
          "circle-radius": ["match", ["get", "k"], "end", 7, 5],
          "circle-color": ["match", ["get", "k"], "end", "#ef4444", "#ffffff"],
          "circle-stroke-color": ["match", ["get", "k"], "end", "#ffffff", "#0284c7"],
          "circle-stroke-width": 2.5,
          "circle-pitch-alignment": "map",
        },
      });
      // 단속카메라 — 제한속도 표지(빨간 테 흰 원 + 숫자). 숫자가 없으면 작은 빨간 점
      map.addLayer({
        id: "cams", type: "circle", source: "cams",
        paint: { "circle-radius": ["case", ["has", "limit"], 11, 6], "circle-color": "#ffffff", "circle-stroke-color": "#dc2626", "circle-stroke-width": 3.5 },
      });
      map.addLayer({
        id: "camLimits", type: "symbol", source: "cams", filter: ["has", "limit"],
        layout: { "text-field": ["to-string", ["get", "limit"]], "text-size": 11, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true, "text-ignore-placement": true },
        paint: { "text-color": "#111827" },
      });
      // 출처별로 조금씩 비켜 그린다(circle-translate는 자료별로 못 바꿔서 출처마다 층 하나)
      for (const [s, off] of [["public", [-9, -7]], ["tmap", [9, -7]], ["kakao", [0, 8]]] as const) {
        map.addLayer({
          id: `compareCams-${s}`, type: "circle", source: "compareCams", filter: ["==", ["get", "src"], s],
          paint: { "circle-radius": 8, "circle-color": ["get", "fill"], "circle-stroke-color": "#fff", "circle-stroke-width": 1.5, "circle-translate": [off[0], off[1]] },
        });
      }
      map.addLayer({
        id: "compareCamText", type: "symbol", source: "compareCams",
        layout: { "text-field": ["get", "t"], "text-size": 10, "text-font": ["Noto Sans Bold"], "text-allow-overlap": true, "text-ignore-placement": true, "text-offset": ["get", "toff"] },
        paint: { "text-color": "#fff" },
      });
      ready = true;
      lastKey = ""; // 레이어가 새로 생겼으니 정적 자료를 다시 넣는다
    });

    // 손가락 조작: 끌기·돌리기·기울이기는 따라가기 해제, 핀치 줌은 따라가기 유지(줌만 보정).
    // jumpTo는 진행 중인 조작을 stop()으로 끊는다 — 매 프레임 따라가기가 손가락 조작을 계속
    // 취소해 지도가 안 움직였다. 손가락이 닿은 순간부터 뗄 때까지는 카메라를 건드리지 않는다.
    let userMoving = false;
    const touches = new Set<number>();
    const down = (e: PointerEvent) => {
      touches.add(e.pointerId);
      userMoving = true;
    };
    const up = (e: PointerEvent) => {
      touches.delete(e.pointerId);
    };
    box.addEventListener("pointerdown", down, true);
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    map.on("movestart", (e) => {
      if (!(e as { originalEvent?: Event }).originalEvent) return;
      userMoving = true;
    });
    map.on("dragstart", () => setFollowing(false));
    map.on("rotatestart", (e) => (e as { originalEvent?: Event }).originalEvent && setFollowing(false));
    map.on("pitchstart", (e) => (e as { originalEvent?: Event }).originalEvent && setFollowing(false));
    // 손가락을 다 떼고 지도 움직임(관성 포함)이 멈추면 다시 따라간다(따라가기 중이었다면)
    const settle = () => {
      if (!userMoving || touches.size > 0 || map.isMoving()) return;
      userMoving = false;
      if (ui.current.following) ui.current.zoomNudge = Math.max(-8, Math.min(3, map.getZoom() - autoZoom(propsRef.current.kmh)));
    };
    map.on("moveend", settle);
    const upSettle = () => setTimeout(settle, 50);
    window.addEventListener("pointerup", upSettle, true);

    const anim = { lat: start.lat, lng: start.lng, heading: P0.heading ?? 0, pitch: 0 };
    const fix = { lat: NaN, lng: NaN, at: 0 };
    let lastT = 0, lastLineAt = 0, lastKey = "";
    let cum: number[] = [], cumPath: LatLng[] | null = null;
    let tstate: Int8Array | null = null, tFor: unknown = null, tPath: LatLng[] | null = null;
    let raf = 0;
    const src = (id: string) => map.getSource(id) as GeoJSONSource | undefined;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const P = propsRef.current;
      const fixPos = P.pos ?? P.path[0];
      if (!fixPos) return;
      if (fixPos.lat !== fix.lat || fixPos.lng !== fix.lng) {
        fix.lat = fixPos.lat;
        fix.lng = fixPos.lng;
        fix.at = now;
      }
      let target = fixPos;
      if (P.pos && P.kmh >= 3 && P.heading !== null) {
        const d = (P.kmh / 3.6) * Math.min(1.5, (now - fix.at) / 1000);
        const hr = (P.heading * Math.PI) / 180;
        target = {
          lat: fix.lat + (d * Math.cos(hr)) / 111_320,
          lng: fix.lng + (d * Math.sin(hr)) / (111_320 * Math.cos((fix.lat * Math.PI) / 180)),
        };
      }
      const fdt = lastT ? Math.min(0.1, (now - lastT) / 1000) : 0.016;
      lastT = now;
      const k = (tau: number) => 1 - Math.exp(-fdt / tau);
      // 달리는 중엔 차 속도만큼 스스로 굴러가고(지연 없음), GPS와의 차이는 0.6초에 걸쳐 메운다.
      // 목표를 쫓기만 하면 속도×시정수만큼 늘 뒤처지고(3m), 새 픽스의 ±3m 흔들림마다 순간 속도가
      // 6~40m/s로 출렁였다(시뮬 측정).
      if (P.pos && P.kmh >= 3 && P.heading !== null) {
        const d = (P.kmh / 3.6) * fdt;
        const hr = (anim.heading * Math.PI) / 180;
        anim.lat += (d * Math.cos(hr)) / 111_320;
        anim.lng += (d * Math.sin(hr)) / (111_320 * Math.cos((anim.lat * Math.PI) / 180));
        anim.lat += (target.lat - anim.lat) * k(0.6);
        anim.lng += (target.lng - anim.lng) * k(0.6);
      } else {
        anim.lat += (target.lat - anim.lat) * k(0.15);
        anim.lng += (target.lng - anim.lng) * k(0.15);
      }
      if (P.heading !== null) anim.heading = lerpAngle(anim.heading, P.heading, k(0.3));
      anim.pitch += ((ui.current.tilt ? PITCH_3D : 0) - anim.pitch) * k(0.25);

      car.setLngLat([anim.lng, anim.lat]);
      car.setRotation(anim.heading);

      if (ui.current.following && !userMoving) {
        const H = box.clientHeight;
        const top = P.insetTop ?? 0, bottom = P.insetBottom ?? 0;
        const A = top + (H - top - bottom) * (ui.current.headingUp ? 0.68 : 0.5);
        map.jumpTo({
          center: [anim.lng, anim.lat],
          zoom: autoZoom(P.kmh) + ui.current.zoomNudge,
          bearing: ui.current.headingUp ? anim.heading : 0,
          pitch: anim.pitch,
          padding: { top: Math.max(0, 2 * A - H), bottom: Math.max(0, H - 2 * A), left: 0, right: 0 },
        });
      }
      if (!ready) return;

      // 경로 누적거리(경로가 바뀔 때만)
      if (cumPath !== P.path) {
        cumPath = P.path;
        cum = [0];
        for (let i = 1; i < P.path.length; i++) {
          const a = P.path[i - 1], b = P.path[i];
          cum.push(cum[i - 1] + Math.hypot((b.lat - a.lat) * 111_320, (b.lng - a.lng) * 111_320 * Math.cos((a.lat * Math.PI) / 180)));
        }
      }
      if (tFor !== P.traffic || tPath !== P.path) {
        tFor = P.traffic;
        tPath = P.path;
        tstate = matchTrafficStates(P.path, P.traffic);
      }
      const n = P.path.length;
      const remainColor = P.offRoute ? "#f59e0b" : "#38bdf8";

      // 정적 자료 — 경로·카메라·회전점·소통·회전 화살표(경로 위치가 바뀔 때만)
      const key = `${n}|${P.alongIdx}|${P.offRoute}|${P.nextAt}|${P.cams.length}|${P.maneuvers.length}|${P.compare?.cams.length ?? -1}|${P.compare?.route?.length ?? -1}|${tFor ? 1 : 0}`;
      if (key !== lastKey) {
        lastKey = key;
        src("route")?.setData(n >= 2 ? fc([line(P.path, { color: remainColor })]) : fc());
        // 근거리(앞 900점) 소통 색
        const near: GeoJSON.Feature[] = [];
        const cut = Math.min(P.alongIdx + 1, n - 1);
        const nearEnd = Math.min(cut + 900, n - 1);
        if (tstate && !P.offRoute && n >= 2) {
          let i = Math.max(0, cut - 1);
          while (i < nearEnd) {
            const col = TRAFFIC_LINE[tstate[i]] ?? remainColor;
            let j = i + 1;
            while (j < nearEnd && (TRAFFIC_LINE[tstate[j]] ?? remainColor) === col) j++;
            near.push(line(P.path.slice(i, j + 1), { color: col }));
            i = j;
          }
        }
        src("near")?.setData(fc(near));
        // 다음 회전 통과 화살표 — 3km 안일 때만
        let arrow: GeoJSON.Feature[] = [], head: GeoJSON.Feature[] = [];
        if (P.nextAt !== null && cum.length === n && n >= 2 && P.nextAt - cum[Math.min(P.alongIdx, n - 1)] < 3000) {
          let i0 = Math.max(0, cut - 3);
          while (i0 < n - 1 && cum[i0] < P.nextAt - 45) i0++;
          let i1 = i0;
          while (i1 < n - 1 && cum[i1] < P.nextAt + 55) i1++;
          if (i1 > i0) {
            arrow = [line(P.path.slice(i0, i1 + 1))];
            const a = P.path[i1 - 1], b = P.path[i1];
            const kx = 111_320 * Math.cos((b.lat * Math.PI) / 180);
            const ex = (b.lng - a.lng) * kx, ey = (b.lat - a.lat) * 111_320;
            const L = Math.hypot(ex, ey) || 1;
            const ux = ex / L, uy = ey / L;
            const at = (fwd: number, side: number): [number, number] => [
              b.lng + (ux * fwd - uy * side) / kx,
              b.lat + (uy * fwd + ux * side) / 111_320,
            ];
            head = [{ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [[at(9, 0), at(-3, 6), at(-3, -6), at(9, 0)]] } }];
          }
        }
        src("arrow")?.setData(fc(arrow));
        src("arrowHead")?.setData(fc(head));
        src("cams")?.setData(fc(P.cams.map((c) => point(c, c.limitKmh ? { limit: c.limitKmh } : {}))));
        const pois = P.maneuvers.filter((m) => m.type !== "arrive").map((m) => point(m, { k: "turn" }));
        if (n) pois.push(point(P.path[n - 1], { k: "end" }));
        src("pois")?.setData(fc(pois));
        const cst = {
          public: { fill: "#71717a", t: "공", off: [-9, -7] },
          tmap: { fill: "#dc2626", t: "T", off: [9, -7] },
          kakao: { fill: "#ca8a04", t: "K", off: [0, 8] },
        } as const;
        src("compareCams")?.setData(
          fc((P.compare?.cams ?? []).map((c) => {
            const st = cst[c.src];
            return point(c, { src: c.src, fill: st.fill, t: st.t, toff: [st.off[0] / 10, st.off[1] / 10] });
          })),
        );
        src("compareRoute")?.setData(P.compare?.route?.length ? fc([line(P.compare.route)]) : fc());
      }

      // 차를 따라 움직이는 선(지나온 회색 끝·초록 궤적 끝) — 초당 10번
      if (now - lastLineAt > 100) {
        lastLineAt = now;
        let passed: GeoJSON.Feature[] = [];
        if (n >= 2 && P.alongIdx >= 0 && P.alongIdx < n - 1 && !P.offRoute) {
          const a = P.path[P.alongIdx], b = P.path[P.alongIdx + 1];
          const kx = Math.cos((a.lat * Math.PI) / 180);
          const bx = (b.lng - a.lng) * kx, by = b.lat - a.lat;
          const L = bx * bx + by * by;
          const t = L > 0 ? Math.max(0, Math.min(1, ((anim.lng - a.lng) * kx * bx + (anim.lat - a.lat) * by) / L)) : 0;
          passed = [line([...P.path.slice(0, P.alongIdx + 1), { lat: a.lat + by * t, lng: a.lng + (b.lng - a.lng) * t }])];
        } else if (n >= 2) {
          passed = [line(P.path.slice(0, Math.min(P.alongIdx + 2, n)))];
        }
        src("passed")?.setData(fc(passed));
        const tr = P.trace;
        src("trace")?.setData(tr && tr.length > 1 ? fc([line([...tr, { lat: anim.lat, lng: anim.lng }])]) : fc());
      }
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      box.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointerup", up, true);
      window.removeEventListener("pointercancel", up, true);
      window.removeEventListener("pointerup", upSettle, true);
      car.remove();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 일반/위성 — 위성 사진을 글자 아래에 깔고, 바탕 지도는 그대로 둔다(글자·도로 이름은 유지)
  // 입체 건물은 3D일 때만 — 평면에서도 옆면 그림자가 져서 지도가 지저분했다(10-25, 카카오맵 비교)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => map.getLayer("building-3d") && map.setLayoutProperty("building-3d", "visibility", tilt ? "visible" : "none");
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [tilt]);

  // 지도 출처 출처를 아래 정보창 위로 — 정보창 높이(insetBottom)가 바뀔 때마다 따라 올린다
  useEffect(() => {
    const corner = boxRef.current?.querySelector<HTMLElement>(".maplibregl-ctrl-bottom-left");
    if (corner) corner.style.bottom = `${(props.insetBottom ?? 0) + 4}px`;
  }, [props.insetBottom]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const apply = () => map.getLayer("sat") && map.setLayoutProperty("sat", "visibility", mode === "sat" ? "visible" : "none");
    if (map.isStyleLoaded()) apply();
    else map.once("style.load", apply);
  }, [mode]);

  const recenter = () => {
    ui.current.zoomNudge = 0;
    setFollowing(true);
  };
  const nudgeZoom = (dz: number) => {
    ui.current.zoomNudge = Math.max(-8, Math.min(3, ui.current.zoomNudge + dz));
    if (!ui.current.following) mapRef.current?.easeTo({ zoom: (mapRef.current?.getZoom() ?? 15) + dz, duration: 200 });
  };
  const btn = "rounded-md px-3 py-3 text-[11px] font-semibold";
  return (
    <div className={`relative h-full w-full overflow-hidden ${props.fullBleed ? "" : "rounded-md"}`}>
      {/* maplibregl-map 클래스가 position:relative로 덮어써서 inset만으론 높이 0 — 인라인으로 고정 */}
      <div ref={boxRef} style={{ position: "absolute", inset: 0 }} />
      <div className="absolute right-2 flex gap-1" style={{ top: 8 + (props.insetTop ?? 0) }}>
        {(["map", "sat"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              try {
                localStorage.setItem(MODE_KEY, m);
              } catch {}
            }}
            className={`${btn} ${mode === m ? "bg-accent text-primary" : "bg-bg text-secondary"}`}
          >
            {m === "map" ? "일반" : "위성"}
          </button>
        ))}
        <button
          type="button"
          onClick={() =>
            setHeadingUp((v) => {
              try {
                localStorage.setItem(ROT_KEY, v ? "north" : "heading");
              } catch {}
              return !v;
            })
          }
          className={`${btn} bg-bg text-secondary`}
        >
          {headingUp ? "회전" : "북쪽 고정"}
        </button>
        <button
          type="button"
          onClick={() =>
            setTilt((v) => {
              try {
                localStorage.setItem(TILT_KEY, v ? "0" : "1");
              } catch {}
              return !v;
            })
          }
          className={`${btn} ${tilt ? "bg-accent text-primary" : "bg-bg text-secondary"}`}
        >
          3D
        </button>
      </div>
      <div className="absolute right-2 flex flex-col gap-1" style={{ bottom: 8 + (props.insetBottom ?? 0) }}>
        {props.engineToggle && (
          <button type="button" onClick={props.engineToggle.onClick} className={`${btn} mb-1 bg-bg text-secondary`}>
            {props.engineToggle.label}
          </button>
        )}
        {!following && (
          <button
            type="button"
            onClick={recenter}
            className="mb-1 flex h-12 w-12 items-center justify-center rounded-sm border border-line bg-accent text-lg text-primary"
            aria-label="현재 위치로"
          >
            <IconTarget />
          </button>
        )}
        <button type="button" aria-label="확대" onClick={() => nudgeZoom(0.5)} className="h-12 w-12 rounded-md border border-line bg-bg text-base font-bold text-primary">
          +
        </button>
        <button type="button" aria-label="축소" onClick={() => nudgeZoom(-0.5)} className="h-12 w-12 rounded-md border border-line bg-bg text-base font-bold text-primary">
          −
        </button>
      </div>
    </div>
  );
}
