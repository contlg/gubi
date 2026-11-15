import type { GuideMode } from "./guided-start";

export function nativeTurnVisible(mode: GuideMode, phase: string): boolean {
  return phase === "driving" && (mode === "native" || mode === "none");
}
export function nativeTurnDistance(meters: number): string {
  meters = Math.round(meters);
  return meters < 1000 ? `${Math.round(meters)}m` : `${(meters / 1000).toFixed(1)}km`;
}
const labels: Record<string, string> = {
  UNKNOWN: "경로 안내", STRAIGHT: "직진", LEFT: "좌회전", RIGHT: "우회전",
  KEEP_L: "왼쪽 방향", KEEP_R: "오른쪽 방향", SHARP_L: "크게 좌회전", SHARP_R: "크게 우회전", UTURN: "유턴",
  WAY: "경유지", ARRIVE: "도착", TUNNEL: "터널", DEVIDE_MERGE: "분기·합류", TOLL: "요금소",
  ENTER_SERVICEAREA: "휴게소 진입", RESTAREA: "쉼터", EXIT_ROUNDABOUT: "회전교차로 출구",
};
for (const side of ["L", "R", "C"]) {
  labels[`ENTER_IC_${side}`] = "나들목 진입";
  labels[`EXIT_IC_${side}`] = "나들목 출구";
  labels[`ENTER_UNDER_${side}`] = "지하차도 진입";
  labels[`AVOID_UNDER_${side}`] = "지하차도 옆길";
  labels[`ENTER_OVER_${side}`] = "고가도로 진입";
  labels[`AVOID_OVER_${side}`] = "고가도로 옆길";
}
for (let hour = 2; hour <= 12; hour++) labels[`ENTER_ROUNDABOUT_${String(hour).padStart(2, "0")}`] = "회전교차로 진입";
export function nativeTurnLabel(type: string): string { return labels[type] ?? labels.UNKNOWN; }
