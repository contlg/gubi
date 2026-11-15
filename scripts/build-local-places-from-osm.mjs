#!/usr/bin/env node

import { createReadStream, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const input = resolve(process.argv[2] ?? join(root, "data-osm/south-korea-latest.osm.pbf"));
const output = resolve(process.argv[3] ?? join(root, "src/lib/data/local-places.json"));
if (!existsSync(input)) throw new Error(`OSM PBF를 찾을 수 없습니다: ${input}`);

const temp = mkdtempSync(join(tmpdir(), "car-local-places-"));
const filtered = join(temp, "places.osm.pbf");
const seq = join(temp, "places.geojsonseq");

const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] });
  if (result.status !== 0) {
    throw new Error(`${command} 실패(${result.status}): ${result.stderr || "출력 없음"}`);
  }
};

const filters = [
  "nwr/tourism=viewpoint,attraction,museum,gallery,theme_park,zoo,aquarium,picnic_site",
  "nwr/natural=beach,water",
  "nwr/water=lake,reservoir,pond",
  "nwr/waterway=river,riverbank",
  "nwr/amenity=cafe,restaurant,fast_food,food_court",
  "nwr/highway=services,rest_area",
  "nwr/leisure=park,garden,nature_reserve,beach_resort",
  "nwr/historic",
  "nwr/man_made=observatory",
];

function representative(geometry) {
  if (!geometry) return null;
  if (geometry.type === "Point") return geometry.coordinates;
  const lines = [];
  if (geometry.type === "LineString") lines.push(geometry.coordinates);
  else if (geometry.type === "MultiLineString" || geometry.type === "Polygon") lines.push(...geometry.coordinates);
  else if (geometry.type === "MultiPolygon") {
    for (const polygon of geometry.coordinates) lines.push(...polygon);
  }
  let best = null;
  for (const line of lines) if (line.length > (best?.length ?? 0)) best = line;
  if (!best?.length) return null;
  // 극단적으로 큰 강/호수 폴리곤에서도 경계 꼭짓점 밀도에 치우치지 않는 bbox 중심.
  let minLng = Infinity, minLat = Infinity, maxLng = -Infinity, maxLat = -Infinity;
  for (const point of best) {
    if (!Array.isArray(point) || point.length < 2) continue;
    minLng = Math.min(minLng, point[0]); maxLng = Math.max(maxLng, point[0]);
    minLat = Math.min(minLat, point[1]); maxLat = Math.max(maxLat, point[1]);
  }
  return Number.isFinite(minLng) ? [(minLng + maxLng) / 2, (minLat + maxLat) / 2] : null;
}

function typesOf(tags) {
  const out = [];
  if (tags.tourism === "viewpoint" || tags.man_made === "observatory") out.push("전망대");
  if (tags.natural === "beach" || tags.leisure === "beach_resort") out.push("해변");
  if (
    tags.natural === "water" || ["lake", "reservoir", "pond"].includes(tags.water) ||
    ["river", "riverbank"].includes(tags.waterway)
  ) out.push("강/호수");
  if (tags.amenity === "cafe") out.push("카페");
  if (["restaurant", "fast_food", "food_court"].includes(tags.amenity)) out.push("맛집");
  if (["services", "rest_area"].includes(tags.highway)) out.push("휴게소");
  if (
    ["attraction", "museum", "gallery", "theme_park", "zoo", "aquarium", "picnic_site"].includes(tags.tourism) ||
    ["park", "garden", "nature_reserve"].includes(tags.leisure) || tags.historic
  ) out.push("관광명소");
  return [...new Set(out)];
}

function displayName(tags) {
  return tags["name:ko"] || tags.name || tags["name:en"] || "";
}

function addressOf(tags) {
  const area = tags["addr:province"] || tags["addr:city"] || tags["addr:district"] || "";
  const street = tags["addr:street"] || tags["addr:place"] || "";
  const number = tags["addr:housenumber"] || "";
  return [area, street, number].filter(Boolean).join(" ");
}

function importance(tags) {
  let score = 0;
  if (tags.wikipedia || tags.wikidata) score += 5;
  if (tags["name:ko"]) score += 2;
  if (["attraction", "theme_park", "zoo", "aquarium", "museum"].includes(tags.tourism)) score += 2;
  if (tags.brand || tags.operator) score += 1;
  return score;
}

try {
  run("osmium", ["tags-filter", input, ...filters, "-o", filtered, "-O"]);
  run("osmium", ["export", filtered, "-f", "geojsonseq", "-o", seq, "-O"]);

  const places = [];
  const seen = new Set();
  const reader = createInterface({ input: createReadStream(seq), crlfDelay: Infinity });
  for await (const raw of reader) {
    const line = raw.startsWith("\u001e") ? raw.slice(1) : raw;
    if (!line.trim()) continue;
    let feature;
    try { feature = JSON.parse(line); } catch { continue; }
    const tags = feature.properties ?? {};
    const name = displayName(tags).trim();
    if (!name) continue;
    const coord = representative(feature.geometry);
    if (!coord) continue;
    const [lng, lat] = coord;
    if (!(lat >= 32.5 && lat <= 39.0 && lng >= 124.0 && lng <= 132.0)) continue;
    for (const type of typesOf(tags)) {
      const key = `${type}|${name}|${lat.toFixed(4)}|${lng.toFixed(4)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // [위도, 경도, 종류, 이름, 주소, 중요도] — 런타임 메모리와 번들 크기 절약.
      places.push([
        Number(lat.toFixed(6)), Number(lng.toFixed(6)), type, name,
        addressOf(tags), importance(tags),
      ]);
    }
  }
  places.sort((a, b) => a[2].localeCompare(b[2], "ko") || b[5] - a[5] || a[3].localeCompare(b[3], "ko"));
  const payload = {
    version: 1,
    source: input.slice(root.length + 1),
    sourceMtime: Math.round(statSync(input).mtimeMs),
    places,
  };
  writeFileSync(output, `${JSON.stringify(payload)}\n`);
  const counts = {};
  for (const place of places) counts[place[2]] = (counts[place[2]] ?? 0) + 1;
  process.stdout.write(`${output}: ${places.length.toLocaleString()}곳 ${JSON.stringify(counts)}\n`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
