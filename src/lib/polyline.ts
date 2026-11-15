/**
 * Google encoded polyline (precision 5) — GPS 궤적을 기록 JSON에 넣기 위한
 * 압축. [lat,lng] 한 점이 평균 ~10바이트라 3시간 주행도 수 KB.
 */

export function encodePolyline(points: [number, number][]): string {
  let out = "";
  let prevLat = 0;
  let prevLng = 0;
  for (const [lat, lng] of points) {
    const iLat = Math.round(lat * 1e5);
    const iLng = Math.round(lng * 1e5);
    out += encodeDiff(iLat - prevLat) + encodeDiff(iLng - prevLng);
    prevLat = iLat;
    prevLng = iLng;
  }
  return out;
}

function encodeDiff(v: number): string {
  let n = v < 0 ? ~(v << 1) : v << 1;
  let s = "";
  while (n >= 0x20) {
    s += String.fromCharCode((0x20 | (n & 0x1f)) + 63);
    n >>= 5;
  }
  return s + String.fromCharCode(n + 63);
}

export function decodePolyline(enc: string): [number, number][] {
  const pts: [number, number][] = [];
  let lat = 0;
  let lng = 0;
  let i = 0;
  while (i < enc.length) {
    for (const which of [0, 1]) {
      let shift = 0;
      let result = 0;
      let b: number;
      do {
        b = enc.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20 && i <= enc.length);
      const d = result & 1 ? ~(result >> 1) : result >> 1;
      if (which === 0) lat += d;
      else lng += d;
    }
    pts.push([lat / 1e5, lng / 1e5]);
  }
  return pts;
}
