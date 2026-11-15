import type { LatLng } from "@/lib/types";

export function isLatLng(value: unknown): value is LatLng {
  if (!value || typeof value !== "object") return false;
  const point = value as LatLng;
  return (
    typeof point.lat === "number" &&
    typeof point.lng === "number" &&
    Number.isFinite(point.lat) &&
    Number.isFinite(point.lng) &&
    point.lat >= -90 &&
    point.lat <= 90 &&
    point.lng >= -180 &&
    point.lng <= 180
  );
}

export function isLatLngPath(
  value: unknown,
  maxPoints = 20_000,
): value is LatLng[] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.length <= maxPoints &&
    value.every(isLatLng)
  );
}

/**
 * Google encoded polyline을 길이·점 개수·좌표 범위까지 엄격히 해석한다.
 * 기존 decoder는 신뢰된 내부 데이터용이라 잘린 문자열도 숫자로 보정할 수 있다.
 * API/저장 경계에서는 이 함수를 써서 손상·과대 입력이 지도와 경로 엔진까지
 * 들어가지 않게 한다.
 */
export function decodeValidPolyline(
  value: unknown,
  maxChars = 200_000,
  maxPoints = 20_000,
): LatLng[] | null {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxChars ||
    maxPoints < 1
  )
    return null;

  let index = 0;
  let latE5 = 0;
  let lngE5 = 0;
  const path: LatLng[] = [];

  const readDelta = (): number | null => {
    let result = 0;
    let shift = 0;
    while (index < value.length) {
      const code = value.charCodeAt(index++) - 63;
      if (code < 0 || code > 63 || shift > 30) return null;
      result += (code & 0x1f) * 2 ** shift;
      if (code < 0x20) return result % 2 ? -((result + 1) / 2) : result / 2;
      shift += 5;
    }
    return null;
  };

  while (index < value.length) {
    const dLat = readDelta();
    const dLng = readDelta();
    if (dLat === null || dLng === null) return null;
    latE5 += dLat;
    lngE5 += dLng;
    const point = { lat: latE5 / 1e5, lng: lngE5 / 1e5 };
    if (!isLatLng(point)) return null;
    path.push(point);
    if (path.length > maxPoints) return null;
  }
  return path;
}
