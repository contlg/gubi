import type {
  AvoidOption,
  CoastIntensity,
  DriveStyle,
  Place,
  WaypointType,
} from "./types";
import { loadSecureJsonQueued, updateSecureJson } from "./secure-store";

/**
 * 검색 기록 — localStorage에 파라미터+결과 요약만 저장한다(기기 안 AES-GCM 암호화, secure-store.ts). 경로 지오메트리는
 * 크고(수백 KB) 엔진이 결정론적이라, 다시 누르면 같은 조건으로 재검색하면 된다.
 */
export interface SearchRecord {
  id: string;
  ts: number;
  mode: "loop" | "dest";
  from: Place;
  to: Place | null;
  budgetH: number;
  styles: DriveStyle[];
  coastIntensity: CoastIntensity;
  avoid: AvoidOption[];
  waypointTypes: WaypointType[];
  pinned: Place[];
  results: { label: string; durationSec: number; distanceM: number }[];
  // 성향·상한 조건 — "같은 조건으로 다시 찾기"가 그대로 복원되게 스냅샷한다.
  // 구버전 기록엔 없을 수 있어 모두 선택적(복원 시 기본값 폴백).
  motionSickness?: boolean;
  preferFewSignals?: boolean;
  avoidTunnels?: boolean;
  avoidJam?: boolean;
  minDurationH?: number;
  maxDurationH?: number;
  maxCost?: number;
}

const BASE_KEY = "drive-history-v1";
const MAX = 15;

// 로그인 계정별로 검색 기록을 분리한다(공용 기기에서 이전 유저 검색 노출 방지).
// 로그인하면 유저 해시로 네임스페이스, 로그아웃/비로그인이면 기본 키.
let namespace: string | null = null;
export function setHistoryNamespace(ns: string | null | undefined) {
  namespace = ns && /^[a-f0-9]{8,64}$/.test(ns) ? ns : null;
}
function keyFor(): string {
  return namespace ? `${BASE_KEY}:${namespace}` : BASE_KEY;
}

/** 지금 계정의 저장 키 — 비동기 저장이 끝나기 전에 계정이 바뀌어도 원래 계정 키에 쓰게 미리 잡아 둔다. */
export function historyKey(): string {
  return keyFor();
}

const asList = (value: unknown): SearchRecord[] => (Array.isArray(value) ? value : []);

/** 검색 기록 읽기 — 기기 안에서 암호화돼 있다(예전 평문은 읽을 때 암호화로 바꾼다). */
export async function loadHistory(key: string = keyFor()): Promise<SearchRecord[]> {
  try {
    return asList((await loadSecureJsonQueued(key)).value);
  } catch {
    return [];
  }
}

/** 용량·프라이빗 모드 실패나 보관함 잠김이면 null(기존 값 유지). */
function update(key: string, change: (list: SearchRecord[]) => SearchRecord[]): Promise<SearchRecord[] | null> {
  return updateSecureJson(key, (current) => change(asList(current)));
}

/** 모든 검색 조건이 같은 재검색만 최신 것 하나로 합친다. */
function sig(r: Omit<SearchRecord, "id" | "ts" | "results">) {
  const place = (p: Place | null) =>
    p
      ? `${p.coord.lat.toFixed(6)},${p.coord.lng.toFixed(6)},${p.dwellMin ?? 0}`
      : "";
  return [
    r.mode,
    place(r.from),
    place(r.to),
    r.budgetH,
    [...r.styles].sort().join(","),
    r.coastIntensity,
    [...r.avoid].sort().join(","),
    [...r.waypointTypes].sort().join(","),
    r.pinned.map(place).join(";"),
    r.motionSickness ?? false,
    r.preferFewSignals ?? false,
    r.avoidTunnels ?? false,
    r.avoidJam ?? false,
    r.minDurationH ?? 0,
    r.maxDurationH ?? 0,
    r.maxCost ?? 0,
  ].join("|");
}

export async function addHistory(rec: Omit<SearchRecord, "id" | "ts">, key: string = keyFor()): Promise<SearchRecord[]> {
  const entry: SearchRecord = {
    ...rec,
    id:
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : String(Date.now()),
    ts: Date.now(),
  };
  const make = (list: SearchRecord[]) => [entry, ...list.filter((r) => sig(r) !== sig(rec))].slice(0, MAX);
  return (await update(key, make)) ?? make(await loadHistory(key));
}

export async function removeHistory(id: string, key: string = keyFor()): Promise<SearchRecord[]> {
  const make = (list: SearchRecord[]) => list.filter((r) => r.id !== id);
  return (await update(key, make)) ?? make(await loadHistory(key));
}

export async function clearHistory(key: string = keyFor()): Promise<SearchRecord[]> {
  await update(key, () => []);
  return [];
}

/** "방금 전 · 3분 전 · 2시간 전 · 4일 전" */
export function relTime(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "방금 전";
  if (s < 3600) return `${Math.floor(s / 60)}분 전`;
  if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
  return `${Math.floor(s / 86400)}일 전`;
}
