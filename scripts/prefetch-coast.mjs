// 한국 해안도로(해안선 150m 이내 드라이브 도로) 좌표를 미리 받아 저장한다.
// 런타임에 실시간 Overpass 의존을 없애기 위한 일회성 빌드 스크립트.
//   node scripts/prefetch-coast.mjs                 # 전국 해안(오래 걸림)
//   node scripts/prefetch-coast.mjs 36.8 128.9 38.6 129.6   # 특정 bbox만
// Overpass의 around.<set>:<m> 로 "해안선 셋 주변 도로"만 받는다. 1° 타일은
// 공용 서버에 너무 무거워 0.25° 타일로 잘게 나눈다. 기존 데이터에 병합(누적).

import { writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../src/lib/data/coastal-road-points.json", import.meta.url));
const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];
// residential/living_street 포함 — 바다 바로 옆 해안길(어달해변길 등)이 대개
// residential이라, 빼면 안쪽 도로만 남아 관통선이 내륙으로 붙는다.
const ROAD_RE =
  "^(trunk|primary|secondary|tertiary|unclassified|residential|living_street|road)$";
const COAST_ROAD_M = 150;
const TILE = Number(process.env.TILE) || 0.25; // TILE=0.125 로 더 조밀하게(무거운 해안)

// 전국 해안을 덮는 지역 bbox (south,west,north,east) — 인자 없을 때 기본값
const REGIONS = [
  // 동해안: 북쪽(속초·고성·양양)은 해안이 경도 128.5까지 서쪽이라 서편을 넓힘
  [35.0, 128.3, 38.65, 129.7],
  [34.0, 126.0, 35.25, 129.5], // 남해안
  [34.4, 125.6, 37.9, 127.1], // 서해안(인천 포함)
  [33.1, 126.1, 33.65, 127.0], // 제주
];

const arg = process.argv.slice(2).map(Number);
const regions = arg.length === 4 ? [arg] : REGIONS;

// bbox들을 0.25° 타일로 쪼갠다
const tiles = [];
for (const [s, w, n, e] of regions) {
  for (let lat = s; lat < n - 1e-9; lat += TILE) {
    for (let lng = w; lng < e - 1e-9; lng += TILE) {
      tiles.push([
        +lat.toFixed(3),
        +lng.toFixed(3),
        +Math.min(lat + TILE, n).toFixed(3),
        +Math.min(lng + TILE, e).toFixed(3),
      ]);
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function overpass(query) {
  let lastErr = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const url = MIRRORS[attempt % MIRRORS.length];
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "User-Agent": "drive-planner-prefetch/0.1",
        },
        body: `data=${encodeURIComponent(query)}`,
        signal: AbortSignal.timeout(90_000),
      });
      if (!res.ok) {
        lastErr = `HTTP ${res.status}`;
        await sleep(3000);
        continue;
      }
      return await res.json();
    } catch (e) {
      lastErr = e?.message ?? String(e);
      await sleep(3000);
    }
  }
  throw new Error(lastErr);
}

// 110m 격자로 중복 제거. 각 점은 [lat,lng,dcoast](해안선까지 m). dcoast=998은
// 구형(거리 미상). 격자당 가장 바다쪽(min dcoast)을 남기고, 신규(거리 有)는
// 구형(998)을 대체한다.
const OLD = 998;
const grid = new Map();
function add(lat, lng, d) {
  const key = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  const prev = grid.get(key);
  const dd = Math.round(d);
  if (!prev) {
    grid.set(key, [+lat.toFixed(4), +lng.toFixed(4), dd]);
    return;
  }
  const prevNew = prev[2] < OLD;
  const curNew = dd < OLD;
  if ((curNew && !prevNew) || (curNew === prevNew && dd < prev[2])) {
    grid.set(key, [+lat.toFixed(4), +lng.toFixed(4), dd]);
  }
}
function segDistM(pla, pln, ala, aln, bla, bln) {
  const kx = Math.cos((pla * Math.PI) / 180) * 111320,
    ky = 110540;
  const ax = (aln - pln) * kx,
    ay = (ala - pla) * ky,
    bx = (bln - pln) * kx,
    by = (bla - pla) * ky;
  const dx = bx - ax,
    dy = by - ay,
    l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? -(ax * dx + ay * dy) / l2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + dx * t, ay + dy * t);
}
try {
  for (const e of JSON.parse(readFileSync(OUT, "utf8")))
    add(e[0], e[1], e.length > 2 ? e[2] : OLD);
  console.log(`기존 데이터 ${grid.size}점에 병합`);
} catch {
  /* 새로 시작 */
}

mkdirSync(dirname(OUT), { recursive: true }); // 중간 저장 전에 디렉터리 보장

// 이미 점이 있는 타일은 건너뛴다(재실행 시 504로 빠진 타일만 빠르게 메움)
const coveredTiles = new Set();
for (const [la, ln] of grid.values()) {
  coveredTiles.add(`${Math.floor(la / TILE)},${Math.floor(ln / TILE)}`);
}

let done = 0;
let failed = 0;
let skipped = 0;
for (const [s, w, n, e] of tiles) {
  done++;
  // FORCE=1이면 이미 커버된 타일도 다시 받는다(residential+dcoast 스키마 갱신용)
  if (
    process.env.FORCE !== "1" &&
    coveredTiles.has(`${Math.floor(s / TILE)},${Math.floor(w / TILE)}`)
  ) {
    skipped++;
    continue;
  }
  const query = `[out:json][timeout:80];
way[natural=coastline](${s},${w},${n},${e})->.c;
(.c; way[highway~"${ROAD_RE}"](around.c:${COAST_ROAD_M}););
out geom;`;
  try {
    const data = await overpass(query);
    const coastSegs = [];
    const roadVerts = [];
    for (const el of data.elements ?? []) {
      if (el.type !== "way" || !el.geometry) continue;
      if (el.tags?.natural === "coastline") {
        const g = el.geometry;
        for (let i = 0; i + 1 < g.length; i++)
          coastSegs.push([g[i].lat, g[i].lon, g[i + 1].lat, g[i + 1].lon]);
      } else if (el.tags?.highway) {
        for (const v of el.geometry) roadVerts.push([v.lat, v.lon]);
      }
    }
    let pts = 0;
    for (const [la, ln] of roadVerts) {
      let md = Infinity;
      for (const sg of coastSegs) {
        const d = segDistM(la, ln, sg[0], sg[1], sg[2], sg[3]);
        if (d < md) md = d;
        if (md < 15) break;
      }
      if (md <= COAST_ROAD_M) {
        add(la, ln, md);
        pts++;
      }
    }
    if (pts > 0) {
      console.log(`[${done}/${tiles.length}] (${s},${w}) 정점 ${pts} 누적 ${grid.size}`);
    }
  } catch (err) {
    failed++;
    console.warn(`[${done}/${tiles.length}] (${s},${w}) 실패: ${err.message}`);
  }
  // 중간 저장(오래 걸리니 도중에 죽어도 진행분 보존)
  if (done % 5 === 0) writeFileSync(OUT, JSON.stringify([...grid.values()]));
  await sleep(1200);
}

const points = [...grid.values()];
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(points));
console.log(
  `저장: ${points.length}점, ${(JSON.stringify(points).length / 1048576).toFixed(2)}MB, 실패 ${failed} 스킵 ${skipped}/${tiles.length}`,
);
