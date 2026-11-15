/** 기본 연비(km/L) — 추후 차종 필터로 사용자 입력 대체 */
const DEFAULT_KM_PER_LITER = 12;
/** 기본 유가(원/L) — 추후 오피넷 API 등으로 대체 */
const DEFAULT_FUEL_PRICE = 1700;

export function estimateFuelCost(distanceM: number): number {
  const liters = distanceM / 1000 / DEFAULT_KM_PER_LITER;
  return Math.round(liters * DEFAULT_FUEL_PRICE);
}
