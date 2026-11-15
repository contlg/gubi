import "server-only";

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { congestionState, linksInBounds, nearbyNodelinks, nodelinkAt } from "@/lib/nodelink";
import type { LatLng } from "@/lib/types";
import { refreshRemoteTrafficCache } from "@/lib/remote-traffic";

interface ItsPayload {
  updatedAt?: number;
  speeds?: Record<string, unknown>;
}

// The collector can belong to another app (Mac: code/car). Read its live cache.
const CACHE_PATH = resolve(process.env.ITS_TRAFFIC_READ_PATH || process.env.ITS_TRAFFIC_CACHE_PATH || join(process.cwd(), "data/its-traffic.json"));
const MAX_AGE_MS = 15 * 60_000;
const STAT_INTERVAL_MS = 30_000;
let checkedAt = 0;
let loadedMtime = -1;
let cacheUpdatedAt = 0;
/**
 * Numeric link IDs are sorted in two compact Float64Arrays. Numbers preserve
 * the original 10-digit link IDs and Float64 speeds preserve every decimal.
 * Rare noncanonical/unsafe IDs keep exact string-key semantics.
 */
class CompactSpeeds {
  // 개발용 작업자(--experimental-strip-types)는 생성자 매개변수 속성을 못 읽어 필드를 따로 적는다.
  private readonly ids: Float64Array;
  private readonly kmh: Float64Array;
  private readonly unusual: Map<string, number>;
  constructor(ids: Float64Array, kmh: Float64Array, unusual: Map<string, number>) {
    this.ids = ids;
    this.kmh = kmh;
    this.unusual = unusual;
  }
  get(id: string): number | undefined {
    const n = Number(id);
    if (!Number.isSafeInteger(n) || String(n) !== id) return this.unusual.get(id);
    let lo = 0, hi = this.ids.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (this.ids[mid] < n) lo = mid + 1;
      else if (this.ids[mid] > n) hi = mid - 1;
      else return this.kmh[mid];
    }
    return undefined;
  }
}

function compactSpeeds(raw: Record<string, unknown>): CompactSpeeds | null {
  const ids: number[] = [];
  const values: number[] = [];
  const unusual = new Map<string, number>();
  for (const id in raw) {
    if (!Object.prototype.hasOwnProperty.call(raw, id)) continue;
    const speed = Number(raw[id]);
    if (!/^\d+$/.test(id) || !Number.isFinite(speed) || speed <= 0 || speed > 160) continue;
    const n = Number(id);
    if (Number.isSafeInteger(n) && String(n) === id) {
      ids.push(n);
      values.push(speed);
    } else {
      unusual.set(id, speed);
    }
  }
  if (!ids.length && !unusual.size) return null;
  const order = Array.from(ids.keys()).sort((a, b) => ids[a] - ids[b]);
  const sorted = new Float64Array(ids.length);
  const speeds = new Float64Array(ids.length);
  for (let i = 0; i < order.length; i++) {
    sorted[i] = ids[order[i]];
    speeds[i] = values[order[i]];
  }
  return new CompactSpeeds(sorted, speeds, unusual);
}

let speeds: CompactSpeeds | null = null;

/** 캐시 파일은 폴러가 원자 교체하므로 mtime이 바뀐 경우에만 다시 파싱한다. */
function currentSpeeds(): CompactSpeeds | null {
  void refreshRemoteTrafficCache();
  // kill switch — ETA·정체레이어·회피라우팅 등 ITS 소비를 한 번에 끈다.
  if (process.env.ITS_TRAFFIC_DISABLE === "1") return null;
  const now = Date.now();
  const allowStale = process.env.ITS_TRAFFIC_ALLOW_STALE === "1";
  if (now - checkedAt < STAT_INTERVAL_MS) return speeds;
  checkedAt = now;
  try {
    const mtime = statSync(CACHE_PATH).mtimeMs;
    if (mtime === loadedMtime && speeds) {
      if (allowStale || now - cacheUpdatedAt <= MAX_AGE_MS) return speeds;
      speeds = null;
      return null;
    }
    const data = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as ItsPayload;
    loadedMtime = mtime;
    if (
      typeof data.updatedAt !== "number" ||
      (!allowStale && now - data.updatedAt > MAX_AGE_MS) ||
      data.updatedAt > now + 60_000 ||
      !data.speeds
    ) {
      speeds = null;
      return null;
    }
    cacheUpdatedAt = data.updatedAt;
    speeds = compactSpeeds(data.speeds);
  } catch {
    loadedMtime = -1;
    cacheUpdatedAt = 0;
    speeds = null;
  }
  return speeds;
}

/**
 * 링크 번호로 ITS 속도 찾기. ITS는 원래 링크를 쪼갠 조각(같은 앞 8자리) 중 감지기 있는 조각에만
 * 속도를 줘서 고속도로도 48%만 잡혔다(10-28). 직접 번호가 없으면 연결표(its-donors.json,
 * scripts/build-its-crosswalk.mjs)에 적힌 순서로 — 옛 번호, 그다음 실제로 이어진 같은 묶음 조각 —
 * 빌려 온다. ITS_FILL=off면 직접 번호만, parent면 예전 실험식(끝 두 자리 00).
 */
const DONOR_PATH = join(process.cwd(), "src/lib/data/nodelink/its-donors.json");
let donors: Record<string, string[]> | null | undefined;
function donorList(linkId: string): string[] | undefined {
  if (donors === undefined) {
    try {
      donors = JSON.parse(readFileSync(DONOR_PATH, "utf8")) as Record<string, string[]>;
    } catch {
      donors = null;
    }
  }
  return donors?.[linkId];
}
// 간선 탐색에서 가장 자주 불리는 곳이라 process.env를 매번 읽지 않는다(실험 스위치, 시작 때 한 번).
const ITS_FILL_MODE = process.env.ITS_FILL ?? "donor";
function speedFor(cache: CompactSpeeds, linkId: string): number | undefined {
  const exact = cache.get(linkId);
  const mode = ITS_FILL_MODE;
  if (exact !== undefined || mode === "off") return exact;
  if (mode === "parent") {
    if (linkId.length < 3 || linkId.endsWith("00")) return undefined;
    return cache.get(linkId.slice(0, -2) + "00");
  }
  for (const d of donorList(linkId) ?? []) {
    const v = cache.get(d);
    if (v !== undefined) return v;
  }
  return undefined;
}

/**
 * 좌표와 진행방향에 맞는 가장 가까운 ITS 링크의 현재 속도(km/h).
 * 캐시가 없거나 15분보다 오래됐거나, 70m/60° 안에 소통 링크가 없으면 null.
 */
export function nearestLinkSpeedKmh(
  point: LatLng,
  headingDeg?: number | null,
): number | null {
  return nearestLinkTraffic(point, headingDeg)?.speedKmh ?? null;
}

export interface ItsLinkTraffic {
  speedKmh: number;
  rank: number;
  linkId: string;
  distanceM: number;
  maxSpeedKmh: number;
  source: "direct" | "donor";
}

/** One directed road match for speed and state; also used by offline validation. */
export function nearestLinkTraffic(
  point: LatLng,
  headingDeg?: number | null,
): ItsLinkTraffic | null {
  const cache = currentSpeeds();
  if (!cache) return null;
  const matches = nearbyNodelinks(point, headingDeg, 70, 60);
  const nearestDistance = matches.reduce((d, x) => Math.min(d, x.distanceM), Infinity);
  for (const match of matches) {
    // 가장 가까운 실제 도로보다 멀리 떨어진 "ITS 정보가 있는 다른 도로"로
    // 건너가지 않는다. 평행 본선/램프는 12m 안 후보까지만 허용한다.
    if (match.distanceM > nearestDistance + 12) continue;
    const speed = speedFor(cache, match.linkId);
    if (speed !== undefined) return { speedKmh: speed, rank: match.rank, linkId: match.linkId,
      distanceM: match.distanceM, maxSpeedKmh: match.maxSpeedKmh, source: cache.get(match.linkId) !== undefined ? "direct" : "donor" };
  }
  return null;
}

/** roadgraph–nodelink crosswalk의 직접 인덱스로 조회(런타임 공간검색 없음). */
export function nodelinkSpeedKmh(indexValue: number): number | null {
  const cache = currentSpeeds();
  if (!cache) return null;
  const link = nodelinkAt(indexValue);
  if (!link) return null;
  return speedFor(cache, link.linkId) ?? null;
}

/** 점의 최근접 링크 소통상태(1정체~4원활, 0정보없음) — 경로/궤적 정체색칠용. */
export function nearestLinkState(
  point: LatLng,
  headingDeg?: number | null,
): number {
  const match = nearestLinkTraffic(point, headingDeg);
  return match ? congestionState(match.speedKmh, match.rank) : 0;
}

export interface PathTrafficSummary {
  samples: { lat: number; lng: number; state: number }[];
  distanceM: number;
  /** 전체 경로 중 ITS 소통정보가 매칭된 표본 비율 */
  coverage: number;
  /** 전체 경로 중 정체·지체(상태 1~2) 표본 비율. 커버리지 30% 미만이면 null. */
  jamRatio: number | null;
}

const distanceM = (a: LatLng, b: LatLng) => {
  const kx = 111_320 * Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180);
  return Math.hypot((b.lat - a.lat) * 110_540, (b.lng - a.lng) * kx);
};

const bearing = (a: LatLng, b: LatLng) => {
  const kx = Math.cos((((a.lat + b.lat) / 2) * Math.PI) / 180) * 111_320;
  return (Math.atan2((b.lng - a.lng) * kx, (b.lat - a.lat) * 110_540) * 180) / Math.PI;
};

/** 경로를 일정 거리로 보간해 ITS 소통색·정체비율을 한 번에 계산한다. */
export function trafficAlongPath(path: LatLng[], sampleM = 300): PathTrafficSummary {
  if (path.length < 2) return { samples: [], distanceM: 0, coverage: 0, jamRatio: null };
  const samples: PathTrafficSummary["samples"] = [];
  let totalM = 0;
  let untilNext = 0;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const length = distanceM(a, b);
    if (length <= 0) continue;
    const heading = bearing(a, b);
    let offset = untilNext;
    while (offset <= length) {
      const t = Math.min(1, offset / length);
      const point = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
      samples.push({ ...point, state: nearestLinkState(point, heading) });
      offset += sampleM;
    }
    untilNext = offset - length;
    totalM += length;
  }
  const end = path[path.length - 1];
  const last = samples[samples.length - 1];
  if (!last || distanceM(last, end) > sampleM * 0.35) {
    const heading = bearing(path[path.length - 2], end);
    samples.push({ ...end, state: nearestLinkState(end, heading) });
  }
  const known = samples.filter((sample) => sample.state > 0).length;
  const jam = samples.filter((sample) => sample.state === 1 || sample.state === 2).length;
  const coverage = samples.length > 0 ? known / samples.length : 0;
  return {
    samples,
    distanceM: totalM,
    coverage,
    jamRatio: coverage >= 0.3 ? jam / samples.length : null,
  };
}

export interface TrafficLayerLink {

  s: number;

  c: number[];
}

/**
 * bbox 내 ITS 실시간 소통이 잡히는 링크만 상태색과 함께 반환한다(전국 정체
 * 레이어). 캐시가 없거나 stale이면 빈 배열. 데이터 없는 링크는 payload를
 * 줄이려 생략한다 — 화면엔 소통정보 있는 도로만 색칠된다.
 */
export function trafficLayer(
  minLat: number,
  minLng: number,
  maxLat: number,
  maxLng: number,
  maxRank = 7,
  limit = 6000,
): TrafficLayerLink[] {
  const cache = currentSpeeds();
  if (!cache) return [];
  const out: TrafficLayerLink[] = [];
  for (const link of linksInBounds(minLat, minLng, maxLat, maxLng, maxRank, limit)) {
    const speed = speedFor(cache, link.linkId);
    if (speed === undefined) continue;
    out.push({ s: congestionState(speed, link.rank), c: link.coords });
  }
  return out;
}

/** 소통 캐시가 지금 유효한지(레이어/색칠을 켤지 판단) */
export function trafficAvailable(): boolean {
  return currentSpeeds() !== null;
}

/**
 * 폰 계산용 속도 파일을 만들 때 쓰는 현재 속도표(링크 번호 → km/h)와 ITS 갱신 시각(ms).
 * 캐시가 없거나 낡았으면 null — 이때 폰은 서버 계산으로 돌아간다.
 */
export function itsSpeedsSnapshot(): { updatedAt: number; speeds: Pick<Map<string, number>, "get"> } | null {
  const current = currentSpeeds();
  return current ? { updatedAt: cacheUpdatedAt, speeds: current } : null;
}
