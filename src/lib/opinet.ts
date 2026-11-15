import "server-only";

import { join } from "node:path";

import proj4 from "proj4";

import { PersistCache } from "@/lib/persist-cache";
import type { LatLng } from "@/lib/types";

/**
 * 오피넷(한국석유공사) 주변 주유소·유가. 오피넷은 위경도가 아니라 KATEC(TM128)
 * 좌표를 쓰므로 proj4로 변환한다. 결과 좌표도 KATEC이라 다시 위경도로 되돌려
 * 지도·길안내에 쓴다. HTTP 엔드포인트(서버에서만 호출).
 */
const KATEC =
  "+proj=tmerc +lat_0=38 +lon_0=128 +ellps=bessel +x_0=400000 +y_0=600000 +k=0.9999 +towgs84=-146.43,507.89,681.46 +units=m +no_defs";
const KEY = process.env.OPINET_API_KEY;

const BRAND: Record<string, string> = {
  SKE: "SK에너지",
  GSC: "GS칼텍스",
  HDO: "현대오일뱅크",
  SOL: "S-OIL",
  RTO: "자영알뜰",
  RTX: "고속도로알뜰",
  NHO: "농협알뜰",
  ETC: "자가상표",
  E1G: "E1",
  SKG: "SK가스",
};

export const FUEL = {
  gasoline: "B027", // 휘발유
  premium: "B034", // 고급휘발유
  diesel: "D047", // 경유
  lpg: "K015", // 자동차용 LPG
} as const;
export type FuelKind = keyof typeof FUEL;

export interface GasStation {
  id: string;
  name: string;
  brand: string;

  price: number;
  distanceM: number;
  coord: LatLng;
}

// 유가 파일 캐시 30분 — 하루 몇 번 갱신이라 충분히 신선하고 호출을 크게 줄인다
const gasCache = new PersistCache<GasStation[]>(
  join(process.cwd(), "data/cache/gas.json"),
  30 * 60 * 1000,
);

export async function gasNear(
  center: LatLng,
  opts: { fuel?: FuelKind; sort?: "price" | "distance"; radiusM?: number } = {},
): Promise<GasStation[]> {
  if (!KEY) return [];
  const fuel = opts.fuel ?? "gasoline";
  const sortKind = opts.sort === "distance" ? "distance" : "price";
  const radius = Math.min(opts.radiusM ?? 5000, 5000);
  // ~100m 격자로 캐시 키(주유소는 안 움직임)
  const ck = `${center.lat.toFixed(3)},${center.lng.toFixed(3)}|${fuel}|${sortKind}|${radius}`;
  const cached = gasCache.get(ck);
  if (cached) return cached;

  const [x, y] = proj4("EPSG:4326", KATEC, [center.lng, center.lat]);
  const prodcd = FUEL[fuel];
  const sort = sortKind === "distance" ? 2 : 1; // 1=최저가, 2=거리
  // https 사용 — 평문 HTTP면 API 키(code)가 감청될 수 있다(opinet https 지원 확인됨)
  const url = `https://www.opinet.co.kr/api/aroundAll.do?code=${KEY}&x=${Math.round(
    x,
  )}&y=${Math.round(y)}&radius=${radius}&sort=${sort}&prodcd=${prodcd}&out=json`;

  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`오피넷 오류 ${res.status}`);
  const data = await res.json();
  const oils: Record<string, unknown>[] = data?.RESULT?.OIL ?? [];

  const out = oils
    .map((o) => {
      const [lng, lat] = proj4(KATEC, "EPSG:4326", [
        Number(o.GIS_X_COOR),
        Number(o.GIS_Y_COOR),
      ]);
      return {
        id: String(o.UNI_ID),
        name: String(o.OS_NM),
        brand: BRAND[String(o.POLL_DIV_CD)] ?? String(o.POLL_DIV_CD),
        price: Number(o.PRICE),
        distanceM: Math.round(Number(o.DISTANCE)),
        coord: { lat, lng },
      };
    })
    .filter((s) => s.price > 0);
  if (out.length > 0) gasCache.set(ck, out);
  return out;
}

const mPerDeg = (lat: number) => ({
  x: 111_320 * Math.cos((lat * Math.PI) / 180),
  y: 110_540,
});
function segDistM(p: LatLng, poly: LatLng[]): number {
  const { x: kx, y: ky } = mPerDeg(p.lat);
  let m = Infinity;
  for (let i = 1; i < poly.length; i++) {
    const ax = poly[i - 1].lng * kx, ay = poly[i - 1].lat * ky;
    const bx = poly[i].lng * kx, by = poly[i].lat * ky;
    const px = p.lng * kx, py = p.lat * ky;
    const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
    let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
    t = Math.max(0, Math.min(1, t));
    m = Math.min(m, Math.hypot(px - (ax + t * dx), py - (ay + t * dy)));
  }
  return m;
}

/**
 * 경로를 따라 있는 주유소 — 경로를 몇 지점으로 샘플해 각 지점 주변을 오피넷으로
 * 훑고, 중복을 합쳐 "경로에서 벗어난 거리(offM)"와 함께 준다. 경로 순서(alongFrac)
 * 또는 최저가로 정렬. 호출 수를 12점으로 제한한다.
 */
export async function gasAlongRoute(
  path: LatLng[],
  opts: { fuel?: FuelKind; sort?: "price" | "distance" } = {},
): Promise<(GasStation & { offM: number; alongFrac: number })[]> {
  if (!KEY || path.length < 2) return [];
  // 경로 길이 – 샘플 점 수(3~12)
  const cum = [0];
  for (let i = 1; i < path.length; i++) {
    const { x: kx, y: ky } = mPerDeg(path[i].lat);
    cum.push(
      cum[i - 1] +
        Math.hypot(
          (path[i].lng - path[i - 1].lng) * kx,
          (path[i].lat - path[i - 1].lat) * ky,
        ),
    );
  }
  const total = cum[cum.length - 1];
  const n = Math.max(3, Math.min(12, Math.round(total / 12000)));
  const ptAt = (frac: number): LatLng => {
    const s = frac * total;
    let i = 1;
    while (i < path.length - 1 && cum[i] < s) i++;
    const sp = cum[i] - cum[i - 1] || 1;
    const t = Math.max(0, Math.min(1, (s - cum[i - 1]) / sp));
    return {
      lat: path[i - 1].lat + (path[i].lat - path[i - 1].lat) * t,
      lng: path[i - 1].lng + (path[i].lng - path[i - 1].lng) * t,
    };
  };
  const samples = Array.from({ length: n }, (_, i) => (i + 0.5) / n);

  // 동시성 제한(3)으로 각 샘플 주변 조회
  const merged = new Map<string, GasStation & { offM: number; alongFrac: number }>();
  let next = 0;
  async function worker() {
    while (next < samples.length) {
      const k = next++;
      const frac = samples[k];
      try {
        const list = await gasNear(ptAt(frac), {
          fuel: opts.fuel,
          sort: "distance",
          radiusM: 5000,
        });
        for (const s of list) {
          const off = Math.round(segDistM(s.coord, path));
          const prev = merged.get(s.id);
          if (!prev || off < prev.offM)
            merged.set(s.id, { ...s, offM: off, alongFrac: frac });
        }
      } catch {
        // 한 지점 실패는 무시
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, n) }, worker));

  // 경로에서 3km 넘게 벗어난 곳은 "가는 길"이 아니다
  const out = [...merged.values()].filter((s) => s.offM <= 3000);
  out.sort((a, b) =>
    opts.sort === "distance" ? a.alongFrac - b.alongFrac : a.price - b.price,
  );
  return out;
}
