import "server-only";

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { maxElevation } from "@/lib/elevation";
import { junctionCountNear } from "@/lib/localroute";
import { getPrefetchedPoints } from "@/lib/osm";
import { distanceM, resamplePath } from "@/lib/scoring/curvature";
import type { LatLng } from "@/lib/types";

/**
 * 코스 실측 배지 — 경로 좌표와 로컬 OSM 데이터만으로 계산한다 (API 0회).
 * 원칙: 자랑할 만한 코스에만 붙인다. 모든 코스에 배지가 있으면 소음이다.
 */

/** 이만큼은 신호 없이 이어져야 "무신호" 배지 (도심 코스에는 안 뜨는 수준) */
const SIGNAL_FREE_MIN_M = 8_000;
/** 경로에서 이 거리 안의 신호등만 경로 위 신호로 인정 */
const SIGNAL_HIT_M = 60;
/** 이 반경까지 신호가 전혀 없어야 "진짜 오지" — 정량(km) 주장의 기준 */
const SIGNAL_CORRIDOR_M = 300;
/** ±1km 창의 실교차로 밀도가 이 이상이면 도시/마을권 — 정량 주장 제외 */
const URBAN_JUNCTIONS_PER_KM = 3;
/** 헤어핀: 이 구간 안에서 누적 회전이 기준을 넘는 코너 */
const HAIRPIN_WINDOW_M = 180;
const HAIRPIN_TURN_DEG = 150;
const HAIRPIN_MIN_COUNT = 5;
/** 바닷가(해안선 250m 이내 도로) 밀착 주행 배지 최소 길이 */
const COAST_MIN_M = 5_000;
const COAST_HIT_M = 300;
/** 이 해발(m)을 넘는 고개가 있어야 최고 해발 배지 — 평지 언덕은 자랑거리가 아니다 */
const ELEVATION_MIN_M = 600;
/** 경로에서 이 거리 안의 단속카메라만 경로 위 카메라로 인정 */
const CAM_HIT_M = 60;
/** "단속카메라 없음" 주장은 이 길이 이상 코스에만 — 짧은 코스는 당연해서 소음 */
const CAM_FREE_MIN_M = 20_000;

/** 격자 색인 — 반경 질의가 셀 크기(~1km)보다 훨씬 작을 때만 유효 */
class PointGrid {
  private cells = new Map<string, LatLng[]>();
  private static CELL = 0.01;

  private key(lat: number, lng: number): string {
    return `${Math.floor(lat / PointGrid.CELL)},${Math.floor(lng / PointGrid.CELL)}`;
  }

  add(p: LatLng): void {
    const k = this.key(p.lat, p.lng);
    const arr = this.cells.get(k);
    if (arr) arr.push(p);
    else this.cells.set(k, [p]);
  }

  hasNear(p: LatLng, radiusM: number): boolean {
    const ci = Math.floor(p.lat / PointGrid.CELL);
    const cj = Math.floor(p.lng / PointGrid.CELL);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const arr = this.cells.get(`${ci + di},${cj + dj}`);
        if (!arr) continue;
        for (const q of arr) if (distanceM(p, q) <= radiusM) return true;
      }
    }
    return false;
  }

  /** 반경 안의 점을 out에 수집 — 같은 점은 객체 동일성으로 중복 제거 */
  collectNear(p: LatLng, radiusM: number, out: Set<LatLng>): void {
    const ci = Math.floor(p.lat / PointGrid.CELL);
    const cj = Math.floor(p.lng / PointGrid.CELL);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const arr = this.cells.get(`${ci + di},${cj + dj}`);
        if (!arr) continue;
        for (const q of arr) if (distanceM(p, q) <= radiusM) out.add(q);
      }
    }
  }
}

/** 전국 신호등 노드(OSM highway=traffic_signals) — scripts 추출 산출물 */
const SIGNALS_FILE = join(process.cwd(), "src/lib/data/signals.json");
/** 경찰청 무인단속카메라 표준데이터 — 런타임 캐시(scripts/fetch-speedcams.mjs가
 *  data/에 주기 갱신)를 우선 읽고, 없으면 커밋된 baseline(build-speedcams.mjs
 *  산출물)으로 폴백한다. */
const SPEEDCAMS_CACHE = join(process.cwd(), "data/speedcams.json");
const SPEEDCAMS_LAST_GOOD = join(process.cwd(), "data/speedcams.last-good.json");
const SPEEDCAMS_BASE = join(process.cwd(), "src/lib/data/speedcams.json");

interface SpeedCams {
  fixed: number[][];
  section: number[][];
  signal: number[][];
}
let speedCams: SpeedCams | null = null;
// 활성 파일 경로+mtime을 합친 키 — 캐시가 새로 생기거나(경로 전환) 갱신되면 리로드.
let speedCamsMtime = "";
function loadSpeedCams(): SpeedCams {
  const files = [SPEEDCAMS_CACHE, SPEEDCAMS_LAST_GOOD, SPEEDCAMS_BASE].filter((f) => existsSync(f));
  const key = files.map((f) => {
    try { return `${f}:${statSync(f).mtimeMs}`; } catch { return `${f}:missing`; }
  }).join("|");
  if (speedCams && key === speedCamsMtime) return speedCams;
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(f, "utf8")) as Partial<SpeedCams>;
      if (!Array.isArray(raw.fixed) || !Array.isArray(raw.section) || !Array.isArray(raw.signal)) continue;
      speedCams = { fixed: raw.fixed, section: raw.section, signal: raw.signal };
      speedCamsMtime = key;
      return speedCams;
    } catch {
      // 마지막 정상 캐시를 먼저 읽고 정적 기본 데이터로 대체한다.
    }
  }
  if (!speedCams) speedCams = { fixed: [], section: [], signal: [] };
  speedCamsMtime = key;
  return speedCams;
}

let signalGrid: PointGrid | null = null;
let signalsMtime = -1;
function loadSignalGrid(): PointGrid {
  try {
    const mtime = statSync(SIGNALS_FILE).mtimeMs + loadSpeedCams().signal.length;
    if (signalGrid && mtime === signalsMtime) return signalGrid;
    const arr = JSON.parse(readFileSync(SIGNALS_FILE, "utf8")) as number[][];
    const grid = new PointGrid();
    for (const [lat, lng] of arr) grid.add({ lat, lng });
    // OSM 신호 태그는 커버리지 30~40% — 신호위반 단속카메라(경찰청 공식)는
    // 신호등 교차로에만 서니까, 그 위치로 신호등 공백을 보강한다
    for (const [lat, lng] of loadSpeedCams().signal) grid.add({ lat, lng });
    signalGrid = grid;
    signalsMtime = mtime;
  } catch {
    if (!signalGrid) signalGrid = new PointGrid();
  }
  return signalGrid;
}

/** 과속 단속카메라(고정식/구간) 격자 */
let camGrids: { fixed: PointGrid; section: PointGrid } | null = null;
let camGridsMtime = "";
function loadCamGrids(): { fixed: PointGrid; section: PointGrid } {
  const cams = loadSpeedCams();
  if (camGrids && speedCamsMtime === camGridsMtime) return camGrids;
  const fixed = new PointGrid();
  const section = new PointGrid();
  for (const [lat, lng] of cams.fixed) fixed.add({ lat, lng });
  for (const [lat, lng] of cams.section) section.add({ lat, lng });
  camGrids = { fixed, section };
  camGridsMtime = speedCamsMtime;
  return camGrids;
}

/** 경로 위(60m) 과속 단속카메라 수 — 같은 카메라는 한 번만 센다 */
export function speedCamCounts(path: LatLng[]): { fixed: number; section: number } {
  const grids = loadCamGrids();
  const samples = resamplePath(path, 50);
  const fixedSet = new Set<LatLng>();
  const sectionSet = new Set<LatLng>();
  for (const s of samples) {
    grids.fixed.collectNear(s, CAM_HIT_M, fixedSet);
    grids.section.collectNear(s, CAM_HIT_M, sectionSet);
  }
  return { fixed: fixedSet.size, section: sectionSet.size };
}

/** 해안 구간(해안선 250m 이내) 도로 정점 격자 — 프리페치 데이터 재사용 */
let coastGrid: PointGrid | null = null;
let coastSrcLen = -1;
function loadCoastGrid(): PointGrid {
  const pts = getPrefetchedPoints();
  if (coastGrid && pts.length === coastSrcLen) return coastGrid;
  const grid = new PointGrid();
  for (const p of pts) if (p.d <= 250) grid.add(p);
  coastGrid = grid;
  coastSrcLen = pts.length;
  return coastGrid;
}

function bearing(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(toRad(b.lat));
  const x =
    Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
    Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(dLng);
  return (Math.atan2(y, x) * 180) / Math.PI;
}

/**
 * 신호 없는 연속 구간. onRoute는 경로 위(60m) 신호 기준의 최장 구간.
 * quant는 정량(km) 주장용의 보수적 기준 — 주변 300m에 신호가 없고,
 * 실교차로 밀도도 낮은(비도시) 구간만 이어서 센다. OSM 신호등 태그는
 * 지방에서 누락이 많지만 교차로 토폴로지는 충실하므로, 교차로 밀도가
 * 도시/마을 수준인 구간에선 "신호가 없다"는 정밀 주장을 포기한다.
 */
function longestSignalFree(path: LatLng[]): {
  onRouteM: number;
  quantM: number;
  totalM: number;
} {
  const grid = loadSignalGrid();
  const STEP = 50;
  const samples = resamplePath(path, STEP);
  const n = samples.length;

  // 실교차로(차수≥3) 근접 플래그 – 누적합으로 ±1km 창 밀도 계산
  const juncFlag = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (junctionCountNear(samples[i], 60) > 0) juncFlag[i] = 1;
  }
  const prefix = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + juncFlag[i];
  const WIN = Math.round(1000 / STEP); // ±1km
  const urbanish = (i: number) => {
    const lo = Math.max(0, i - WIN);
    const hi = Math.min(n, i + WIN + 1);
    const km = ((hi - lo) * STEP) / 1000;
    return (prefix[hi] - prefix[lo]) / km >= URBAN_JUNCTIONS_PER_KM;
  };

  let onLongest = 0,
    onRun = 0;
  let qLongest = 0,
    qRun = 0;
  for (let i = 0; i < n; i++) {
    const s = samples[i];
    if (grid.hasNear(s, SIGNAL_HIT_M)) {
      if (onRun > onLongest) onLongest = onRun;
      onRun = 0;
    } else {
      onRun += STEP;
    }
    if (grid.hasNear(s, SIGNAL_CORRIDOR_M) || urbanish(i)) {
      if (qRun > qLongest) qLongest = qRun;
      qRun = 0;
    } else {
      qRun += STEP;
    }
  }
  if (onRun > onLongest) onLongest = onRun;
  if (qRun > qLongest) qLongest = qRun;
  return { onRouteM: onLongest, quantM: qLongest, totalM: n * STEP };
}

/**
 * 헤어핀 수 — 짧은 구간(180m) 안에서 한 방향으로 150° 이상 감기는 코너.
 * 단일 스텝에서 120° 이상 꺾이는 건 주행 가능한 코너가 아니라 왕복 반환점
 * 같은 경로 데이터 반전이므로 그 창은 통째로 건너뛴다.
 */
function countHairpins(path: LatLng[]): number {
  const STEP = 20;
  const samples = resamplePath(path, STEP);
  if (samples.length < 4) return 0;

  const deltas: number[] = [];
  let prev = bearing(samples[0], samples[1]);
  for (let i = 1; i < samples.length - 1; i++) {
    const cur = bearing(samples[i], samples[i + 1]);
    let d = cur - prev;
    if (d > 180) d -= 360;
    if (d < -180) d += 360;
    deltas.push(d);
    prev = cur;
  }

  const win = Math.max(2, Math.round(HAIRPIN_WINDOW_M / STEP));
  let count = 0;
  let i = 0;
  while (i < deltas.length) {
    let sum = 0;
    let reversal = false;
    const end = Math.min(i + win, deltas.length);
    for (let j = i; j < end; j++) {
      if (Math.abs(deltas[j]) > 120) reversal = true;
      sum += deltas[j];
    }
    if (!reversal && Math.abs(sum) >= HAIRPIN_TURN_DEG) {
      count++;
      i = end; // 같은 코너 중복 집계 방지
    } else {
      i++;
    }
  }
  return count;
}

/** 해안 구간 주행 거리(m) — 해안선 250m 이내 도로 정점 300m 이내 구간 합 */
function coastHugM(path: LatLng[]): number {
  const grid = loadCoastGrid();
  const STEP = 100;
  const samples = resamplePath(path, STEP);
  let m = 0;
  for (const s of samples) if (grid.hasNear(s, COAST_HIT_M)) m += STEP;
  return m;
}

export interface BadgeStats {
  signalFreeOnRouteM: number;
  signalFreeQuantM: number;
  totalM: number;
  hairpins: number;
  coastM: number;
  /** 경로 최고 해발(m) — DEM 미구축이면 null */
  maxEleM: number | null;
  /** 경로 위 과속 단속카메라 수 (경찰청 표준데이터) */
  camFixed: number;
  camSection: number;
}

/** 배지 원시 수치 — 테스트/튜닝용으로도 노출 */
export function badgeStats(path: LatLng[]): BadgeStats {
  const sig = longestSignalFree(path);
  const cams = speedCamCounts(path);
  return {
    signalFreeOnRouteM: sig.onRouteM,
    signalFreeQuantM: sig.quantM,
    totalM: sig.totalM,
    hairpins: countHairpins(path),
    coastM: coastHugM(path),
    maxEleM: maxElevation(path),
    camFixed: cams.fixed,
    camSection: cams.section,
  };
}

/**
 * 경로 실측 배지. OSM 신호등 매핑이 완전하지 않아 무신호 거리는 "약"으로
 * 표기하고, 문턱을 높게 잡아 확실한 코스에만 붙인다.
 * maxEleM: 호출부가 이미 종단면을 계산했으면 그 최고 고도를 넘겨 재계산을
 * 피하고 카드 그래프와 수치를 일치시킨다 (undefined면 여기서 계산).
 */
export function computeBadges(
  path: LatLng[],
  maxEleM?: number | null,
): string[] {
  if (path.length < 2) return [];
  const s = badgeStats(path);
  if (maxEleM !== undefined) s.maxEleM = maxEleM;
  const badges: string[] = [];

  // 정량(km) 주장은 보수적 기준(주변 300m 무신호 + 비도시 교차로 밀도)으로만
  // — "32km 연속" 같은 정밀 주장은 한 번만 틀려도 신뢰를 깎는다
  if (s.signalFreeQuantM >= SIGNAL_FREE_MIN_M) {
    badges.push(`무신호 약 ${Math.round(s.signalFreeQuantM / 1000)}km 연속`);
  } else if (s.signalFreeOnRouteM >= s.totalM * 0.6 && s.totalM >= SIGNAL_FREE_MIN_M) {
    badges.push("신호 거의 없음");
  }

  if (s.hairpins >= HAIRPIN_MIN_COUNT) {
    badges.push(`헤어핀 ${s.hairpins}개`);
  }

  if (s.coastM >= COAST_MIN_M) {
    badges.push(`해안 구간 ${Math.round(s.coastM / 1000)}km`);
  }

  // 90m 격자 평균이라 좁은 고개는 표지판보다 ~5% 낮게 나온다 — "약"이 정직
  if (s.maxEleM !== null && s.maxEleM >= ELEVATION_MIN_M) {
    badges.push(`최고 해발 약 ${(Math.round(s.maxEleM / 10) * 10).toLocaleString()}m`);
  }

  // 과속 단속 — 경찰청 공식 데이터라 정량 표기 가능.
  // 구간단속은 평균속도 방식이라 시·종점 카메라 2대를 다 지나야 실제로
  // 단속된다 — 1대만 스치는 건 교차점 통과라 주장하지 않는다(미시령옛길
  // 시작점 = 터널 구간단속 시점인 케이스). 개수는 쌍 집계라 부정확할 수
  // 있어 유무만 말한다. 이동식 단속은 데이터 밖 – "없음" 주장은 완전히

  if (s.camSection >= 2) {
    badges.push("구간단속 있음");
  }
  if (s.camFixed >= 1) {
    badges.push(`과속카메라 ${s.camFixed}대`);
  }
  if (s.camSection === 0 && s.camFixed === 0 && s.totalM >= CAM_FREE_MIN_M) {
    badges.push("고정 단속카메라 없음");
  }

  return badges;
}
