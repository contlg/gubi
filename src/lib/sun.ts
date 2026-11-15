/** NOAA 근사식으로 일몰 시각(UTC) 계산 — 한국 위도에서 오차 ±2분 수준 */
export function sunsetAt(date: Date, lat: number, lng: number): Date | null {
  const rad = Math.PI / 180;
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  const doy = Math.floor((date.getTime() - start) / 86_400_000);

  const gamma = ((2 * Math.PI) / 365) * (doy - 1 + (date.getUTCHours() - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(gamma) -
      0.032077 * Math.sin(gamma) -
      0.014615 * Math.cos(2 * gamma) -
      0.040849 * Math.sin(2 * gamma));
  const decl =
    0.006918 -
    0.399912 * Math.cos(gamma) +
    0.070257 * Math.sin(gamma) -
    0.006758 * Math.cos(2 * gamma) +
    0.000907 * Math.sin(2 * gamma) -
    0.002697 * Math.cos(3 * gamma) +
    0.00148 * Math.sin(3 * gamma);

  const cosHa =
    Math.cos(90.833 * rad) / (Math.cos(lat * rad) * Math.cos(decl)) -
    Math.tan(lat * rad) * Math.tan(decl);
  if (cosHa < -1 || cosHa > 1) return null; // 극지방 백야/극야

  const haDeg = Math.acos(cosHa) / rad;
  const sunsetMinUtc = 720 - 4 * (lng - haDeg) - eqtime;

  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) +
      sunsetMinUtc * 60_000,
  );
}
