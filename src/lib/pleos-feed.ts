"use client";

import { useSyncExternalStore } from "react";
import type { PleosSupport } from "./guided-start";
import type { LatLng } from "./types";

export interface PleosCamera {
  id: string; type: string; limit: number | null; remainM: number;
  overSpeed: boolean; sectionAvg: number | null; overSectionAvg: boolean;
}
export interface PleosCaution { id: string; type: string; remainM: number }
export interface PleosChargeStop {
  name: string; remainWh: number; distanceM: number | null; maxKw: number | null; chargers: number | null;
}
export interface PleosVehicle {
  steeringDeg: number | null; brake: boolean | null;
  socPct: number | null; capacityWh: number | null; gear: string | null;
  /** 문·창문·공조·온도·타이어는 차 권한을 빼서 더 이상 오지 않는다(구버전 앱만) */
  doorsLocked?: boolean | null; anyDoorOpen?: boolean | null; anyWindowOpen?: boolean | null;
  hvacOn?: boolean | null; hvacSetC?: number | null; cabinC?: number | null; outsideC?: number | null;
  lowTire?: boolean | null; cruiseKmh: number | null; odometerKm: number | null;
}
export interface PleosTurn { type: string; distanceM: number; text: string }
export function parseNativeTurns(value: unknown): PleosTurn[] {
  if (!Array.isArray(value) || value.length > 3) return [];
  if (!value.every((item) => item && typeof item.type === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(item.type) &&
    typeof item.distanceM === "number" && Number.isFinite(item.distanceM) && item.distanceM >= 0 && item.distanceM <= 1e8 &&
    typeof item.text === "string" && item.text.length <= 256 && !/[\x00-\x1f]/.test(item.text))) return [];
  return value.map(({ type, distanceM, text }) => ({ type, distanceM, text }));
}
export interface PleosFeed {
  chargerOperatorCount?: number;
  courseStatus?: { paused: boolean; reason: string };
  ts: number; naviConnected: boolean; ageMs: Record<string, number | null>;
  tbt?: PleosTurn[];
  arrivalWh?: number | null;
  chargeStop?: PleosChargeStop | null;
  cameras: PleosCamera[]; speedLimitKmh: number | null; cautions: PleosCaution[]; vehicle: PleosVehicle;
}
export type PleosTrip = { requestId: string } & (
  { distanceM: number; etaS: number; energyWh: number; socAtDestPct: number; traffic?: { t: string; s: number; e: number }[]; error?: never } |
  { error: string; distanceM?: never; etaS?: never; energyWh?: never; socAtDestPct?: never }
);
export type PleosCancelResult = { ok: boolean; requestId: string };
type Native = { pleosChargerOperators?: () => string; pleosSupport?: () => PleosSupport; verifyPleosInactive?: () => string | null; cancelPleosRoute?: () => string | null; pleosAvailable?: () => boolean; pleosTrip?: (lat: number, lng: number, label: string) => string };
declare global {
  interface Window {
    __pleosChargerOperators?: (snapshot: unknown) => void;
    __pleosAvailability?: (available: boolean) => void;
    __pleosNativeActive?: (event: { reason: string }) => void;
    __pleosFeed?: (feed: PleosFeed) => void;
    __pleosTrip?: (trip: PleosTrip) => void;
    __pleosCancel?: (result: PleosCancelResult) => void;
  }
}
function bridge(): Native | undefined {
  return typeof window === "undefined" ? undefined : (window as unknown as { DriveNative?: Native }).DriveNative;
}
export function pleosAvailable(): boolean {
  try { return bridge()?.pleosAvailable?.() === true; } catch { return false; }
}
export function pleosSupport(): PleosSupport {
  try { return bridge()?.pleosSupport?.() ?? (typeof bridge()?.pleosAvailable === "function" ? "connecting" : "unsupported"); }
  catch { return "disconnected"; }
}
export interface ChargerSnapshot { items: { id: string; name: string }[]; total: number; truncated: boolean }
export function parseChargerOperators(value: unknown): ChargerSnapshot | null {
  try {
    if (typeof value === "string") value = JSON.parse(value);
    const data = value as ChargerSnapshot | null;
    const text = (s: unknown, max: number): s is string => typeof s === "string" && s.length > 0 && s.length <= max && !/[\x00-\x1f]/.test(s);
    if (!data || !Array.isArray(data.items) || data.items.length > 200 ||
        !Number.isSafeInteger(data.total) || data.total < data.items.length || data.total > 2147483647 ||
        typeof data.truncated !== "boolean" || data.truncated !== (data.total > data.items.length) ||
        !data.items.every((item) => item && text(item.id, 32) && text(item.name, 40))) return null;
    // encodeURIComponent counts UTF-8 bytes, including escaped JSON characters.
    if (encodeURIComponent(JSON.stringify(data)).replace(/%[A-F\d]{2}/gi, "x").length > 4096) return null;
    return { items: data.items.map(({ id, name }) => ({ id, name })), total: data.total, truncated: data.truncated };
  } catch { return null; }
}
export function parseCourseFields(feed: PleosFeed): Pick<PleosFeed, "chargerOperatorCount" | "courseStatus"> {
  const status = feed.courseStatus;
  return {
    chargerOperatorCount: Number.isSafeInteger(feed.chargerOperatorCount) && feed.chargerOperatorCount! >= 0 && feed.chargerOperatorCount! <= 2147483647 ? feed.chargerOperatorCount : 0,
    courseStatus: status && typeof status.paused === "boolean" && typeof status.reason === "string" && status.reason.length <= 120 && !/[\x00-\x1f]/.test(status.reason) ? { paused: status.paused, reason: status.reason } : { paused: false, reason: "" },
  };
}
const empty = { supported: false, available: false, connected: false, feed: null as PleosFeed | null, chargerOperators: null as ChargerSnapshot | null };
let chargerOperators: ChargerSnapshot | null = null;
let snapshot = empty;
let latest: PleosFeed | null = null;
let received = -Infinity;
let timer: ReturnType<typeof setInterval> | undefined;
const listeners = new Set<() => void>();
const pendingCancel = new Map<string, (result: PleosCancelResult) => void>();
const pending = new Map<string, (trip: PleosTrip) => void>();
const positive = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n > 0;
function publish() {
  const supported = pleosSupport() !== "unsupported";
  const available = pleosAvailable();
  const elapsed = performance.now() - received;
  const transportFresh = available && elapsed < 3000;
  const connected = transportFresh && latest?.naviConnected === true;
  let feed: PleosFeed | null = null;
  if (transportFresh && latest) {
    const fresh = (key: string, ttl: number) => typeof latest!.ageMs[key] === "number" && Number.isFinite(latest!.ageMs[key]) && latest!.ageMs[key]! >= 0 && latest!.ageMs[key]! + elapsed < ttl;
    const vehicle = Object.fromEntries(Object.entries(latest.vehicle).map(([key, value]) => [key, fresh(key, key === "steeringDeg" || key === "brake" ? 3000 : 15000) ? value : null])) as unknown as PleosVehicle;
    feed = { ...latest, tbt: connected && fresh("tbt", 5000) ? parseNativeTurns(latest.tbt) : [], cameras: connected && fresh("cameras", 3000) ? latest.cameras : [],
      speedLimitKmh: connected ? latest.speedLimitKmh : null,
      arrivalWh: connected && typeof latest.arrivalWh === "number" && Number.isFinite(latest.arrivalWh) && fresh("arrivalWh", 3000) ? latest.arrivalWh : null,
      chargeStop: connected && fresh("chargeStop", 3000) ? latest.chargeStop ?? null : null,
      cautions: connected && fresh("cautions", 3000) ? latest.cautions : [], vehicle };
  }

  const next = { supported, available, connected, feed, chargerOperators };
  if (JSON.stringify(next) !== JSON.stringify(snapshot)) {
    snapshot = next;
    listeners.forEach((listener) => listener());
  }
}
function install() {
  window.__pleosChargerOperators = (value) => {
    const parsed = parseChargerOperators(value);
    if (parsed) { chargerOperators = parsed; publish(); }
  };
  try { window.__pleosChargerOperators(bridge()?.pleosChargerOperators?.()); } catch {}
  window.__pleosAvailability = () => { if(!pleosAvailable())latest=null;publish(); };
  window.__pleosCancel = (result) => {
    if (!result || typeof result.ok !== "boolean" || !/^[A-Za-z0-9_-]{1,80}$/.test(result.requestId)) return;
    const resolve = pendingCancel.get(result.requestId);
    if (!resolve) return;
    pendingCancel.delete(result.requestId);
    resolve({ ok: result.ok, requestId: result.requestId });
  };
  window.__pleosFeed = (feed) => {
    if (!pleosAvailable() || !feed || !Number.isFinite(feed.ts) || typeof feed.naviConnected !== "boolean" ||
        !feed.ageMs || !feed.vehicle || !Array.isArray(feed.cameras) || !Array.isArray(feed.cautions) ||
        feed.cameras.length > 3 || feed.cautions.length > 3) return;
    const steering = feed.vehicle.steeringDeg;
    const brake = feed.vehicle.brake;
    latest = { ...feed, vehicle: { ...feed.vehicle,
      steeringDeg: typeof steering === "number" && Number.isFinite(steering) && Math.abs(steering) <= 2000 ? Math.round(steering * 10) / 10 : null,
      brake: typeof brake === "boolean" ? brake : null,
    }, ...parseCourseFields(feed) }; received = performance.now(); publish();
  };
  window.__pleosTrip = (trip) => {
    if (!trip || !/^[A-Za-z0-9_-]{1,80}$/.test(trip.requestId)) return;
    const resolve = pending.get(trip.requestId);
    if (!resolve) return;
    if (typeof trip.error !== "string" && ![trip.distanceM, trip.etaS, trip.energyWh, trip.socAtDestPct].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)) return;
    pending.delete(trip.requestId); resolve(trip);
  };
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  if (typeof bridge()?.pleosAvailable === "function") { install(); timer ??= setInterval(publish, 200); }
  publish();
  return () => { listeners.delete(listener); if (!listeners.size && timer) { clearInterval(timer); timer = undefined; } };
}
export function usePleosFeed() { return useSyncExternalStore(subscribe, () => snapshot, () => empty); }

export function arrivalText(wh: number | null | undefined, capacityWh: number | null | undefined, chargeStop?: PleosChargeStop | null): { text: string; shortage: boolean; stop?: string } | null {
  if (typeof wh !== "number" || !Number.isFinite(wh)) return null;
  const stop = chargeStop ? { stop: `충전소 경유: ${chargeStop.name}${chargeStop.distanceM == null ? "" : ` · ${(chargeStop.distanceM / 1000).toFixed(1)} km`}` } : {};
  if (wh < 0) return { text: "도착 전 배터리 부족 예상", shortage: true, ...stop };
  if (chargeStop && chargeStop.remainWh < 0) return { text: "충전소 도착 전 배터리 부족 예상", shortage: true, ...stop };
  const pct = positive(capacityWh) ? ` (약 ${Math.max(0, Math.min(100, Math.round(wh / capacityWh * 100)))}%)` : "";
  return { text: `${chargeStop ? "충전 후 도착" : "도착"} 시 배터리 약 ${(wh / 1000).toFixed(1)} kWh${pct}`, shortage: false, ...stop };
}

let tripChain: Promise<unknown> = Promise.resolve();
let lastStart = -Infinity;
const tripCache = new Map<string, Promise<PleosTrip>>();

export function requestPleosTrip(key: string, target: LatLng, label: string): Promise<PleosTrip> {
  const cached = tripCache.get(key);
  if (cached) return cached;
  const result = tripChain.then(async (): Promise<PleosTrip> => {
    if (!pleosAvailable()) return { requestId: "unavailable", error: "unavailable" };
    const wait = Math.max(0, 1000 - (performance.now() - lastStart));
    if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
    return new Promise((resolve) => {
      try {
        lastStart = performance.now();
        const id = bridge()?.pleosTrip?.(target.lat, target.lng, label.slice(0, 120));
        if (!id || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) { resolve({ requestId: "unavailable", error: "unavailable" }); return; }
        const timeout = setTimeout(() => { pending.delete(id); resolve({ requestId: id, error: "timeout" }); }, 120000);
        pending.set(id, (trip) => { clearTimeout(timeout); resolve(trip); });
      } catch { resolve({ requestId: "unavailable", error: "unavailable" }); }
    });
  });
  tripCache.set(key, result);
  tripChain = result.catch(() => undefined);
  return result;
}
export function isPleosTripResult(trip: PleosTrip): trip is Extract<PleosTrip, { distanceM: number }> {
  return trip.error === undefined && positive(trip.distanceM) && positive(trip.energyWh) &&
    typeof trip.etaS === "number" && Number.isFinite(trip.etaS) && trip.etaS >= 0 &&
    typeof trip.socAtDestPct === "number" && Number.isFinite(trip.socAtDestPct) && trip.socAtDestPct >= 0 && trip.socAtDestPct <= 100;
}
export function courseEstimate(trip: PleosTrip, courseM: number, vehicle: PleosVehicle | undefined) {
  if (!isPleosTripResult(trip) || !positive(courseM) ||
      !positive(vehicle?.socPct) || vehicle.socPct > 100 || !positive(vehicle?.capacityWh)) return null;
  const energyWh = trip.energyWh / trip.distanceM * courseM;
  if (!Number.isFinite(energyWh)) return null;
  return { kWh: energyWh / 1000, socPct: Math.max(0, vehicle.socPct - energyWh / vehicle.capacityWh * 100) };
}
export function tripTarget(path: LatLng[], from: LatLng, destination: LatLng | null): LatLng | null {
  const valid = (p: LatLng) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  if (destination) return valid(destination) ? destination : null;
  if (!valid(from)) return null;
  const rad = Math.PI / 180;
  const distance = (p: LatLng) => Math.sin((p.lat - from.lat) * rad / 2) ** 2 + Math.cos(from.lat * rad) * Math.cos(p.lat * rad) * Math.sin((p.lng - from.lng) * rad / 2) ** 2;
  let farthest: LatLng | null = null, max = 0;
  for (const point of path) { if (!valid(point)) return null; const d = distance(point); if (d > max) { max = d; farthest = point; } }
  return farthest;
}
export const PLEOS_LABELS: Record<string, string> = {
  SPEED_CAMERA_FIX: "고정식 과속단속", SPEED_CAMERA_MOV: "이동식 과속단속",
  SPEED_CAMERA_SECTION_START: "구간단속 시작", SECTION_SPEED_ALERT: "구간 평균속도", SPEED_CAMERA_SECTION_END: "구간단속 종료",
  SPEED_CAMERA_TRAFFIC_LIGHT: "신호·과속단속", SPEED_CAMERA_REAR: "후면 단속", VARIABLE_SPEED_CAMERA: "가변속도 단속",
  SPEED_CAMERA_SCHOOL_ZONE: "어린이보호구역 단속", SPEED_CAMERA_SCHOOL_ZONE_TRAFFIC_LIGHT: "어린이보호구역 신호·과속단속",
  SPEED_BUMP: "과속방지턱", SCHOOL_ZONE: "어린이보호구역", ACCIDENT_PRONE_AREA: "사고다발 구간",
  RAILROAD_CROSSING: "철도 건널목", FOG_AREA: "안개 구간", FALLING_ROCK_AREA: "낙석 주의", DOWNHILL_CAUTION_AREA: "내리막 주의",
  WILDLIFE_CROSSING: "야생동물 주의", NARROW_ROAD: "좁은 도로", HIGHWAY_CONSTRUCTION: "고속도로 공사",
  TRAFFIC_INFO_COLLECTION: "교통정보 수집", NO_PARKING_ZONE: "주정차 금지", TRAFFIC_LIGHT_VIOLATION_ENFORCEMENT: "신호위반 단속",
  BUS_LANE_VIOLATION_ENFORCEMENT: "버스전용차로 단속", CUT_IN_VIOLATION_ENFORCEMENT: "끼어들기 단속",
  BLOCK_INTERSECTION_ENFORCEMENT: "교차로 꼬리물기 단속", LANE_CHANGE_CAMERA_ALERT: "차로변경 단속", SLIPPERY_ROAD_ALERT: "미끄러운 도로",
  ROAD_DAMAGE_ALERT: "도로 파손", WRONG_WAY_DRIVING_ALERT: "역주행 주의", BUS_LANE_UNAVAILABLE_NOTICE: "버스전용차로 운영 종료",
  BUS_LANE_AVAILABLE_NOTICE: "버스전용차로 운영 중", SIGN_MALFUNCION: "신호기 고장",
};

// 선택이 바뀐 뒤 이전 응답이 적용되지 않게 요청 식별자를 즉시 노출한다.
export function requestPleosCancel(verifyOnly = false): Promise<PleosCancelResult> & { requestId: string } {
  let id = "unavailable";
  let settle: (result: PleosCancelResult) => void = () => {};
  const promise = new Promise<PleosCancelResult>((resolve) => { settle = resolve; });
  try {
    if (pleosSupport() === "unsupported") throw new Error("unavailable");
    install();
    const requestId = verifyOnly ? bridge()?.verifyPleosInactive?.() : bridge()?.cancelPleosRoute?.();
    if (!requestId || !/^[A-Za-z0-9_-]{1,80}$/.test(requestId)) throw new Error("unavailable");
    id = requestId;
    const timeout = setTimeout(() => {
      pendingCancel.delete(id);
      settle({ ok: false, requestId: id });
    }, 23000);
    pendingCancel.set(id, (result) => { clearTimeout(timeout); settle(result); });
  } catch { settle({ ok: false, requestId: id }); }
  return Object.assign(promise, { requestId: id });
}
