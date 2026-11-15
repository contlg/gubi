import "server-only";

import type { LatLng } from "./types";
import { adminDongAt } from "./admdong";
import { nearestCity } from "./world-cities";

/**
 * 한국 밖인지 — 행정동이 없고 가장 가까운 도시가 외국일 때만. 한국 바다·다리 위는
 * 가까운 도시가 한국이라 국내로 남는다. 도시 자료가 없는 먼 바다는 판단 보류(false).
 */
export function isAbroad(p: LatLng): boolean {
  if (adminDongAt(p)) return false;
  const city = nearestCity(p);
  return !!city && city.country !== "한국";
}

/** 어디든 위치 이름 — 한국은 행정동(시도 시군구 동), 밖이면 placeNameAbroad */
export function placeNameAt(p: LatLng): string | null {
  return adminDongAt(p)?.name ?? placeNameAbroad(p);
}

/** 한국 밖의 가까운 도시 이름. */
export function placeNameAbroad(p: LatLng): string | null {
  const city = nearestCity(p);
  return city && city.distKm <= 50
    ? city.country === "한국" ? city.name : `${city.country} ${city.name}`
    : null;
}
