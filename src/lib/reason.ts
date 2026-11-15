import type { RouteCandidate } from "./types";

export function buildReason(c: RouteCandidate): string | null {
  const m = c.metrics;
  const deg = c.curve.degPerKm;

  let hook: string | null = null;
  let hookKind: "highlight" | "sea" | "river" | "winding" | "mountain" | "straight" | null =
    null;

  if (c.highlights?.length) {
    const names = c.highlights
      .slice(0, 2)
      .map((h) => h.name)
      .join("·");
    hook =
      c.highlights.length > 2
        ? `${names} 등 주행 구간 ${c.highlights.length}곳`
        : `${names} 주행 구간`;
    hookKind = "highlight";
  } else if (m && m.seaShoreRatio >= 0.2) {
    hook = `해안 구간 ${Math.round(m.seaShoreRatio * 100)}%`;
    hookKind = "sea";
  } else if (m && m.seaShoreRatio + m.seaViewRatio >= 0.35) {
    hook = `바다 전망 구간 ${Math.round((m.seaShoreRatio + m.seaViewRatio) * 100)}%`;
    hookKind = "sea";
  } else if (m && m.riverRatio >= 0.3) {
    hook = `강변 구간 ${Math.round(m.riverRatio * 100)}%`;
    hookKind = "river";
  } else if (deg >= 55) {
    hook = `곡률 ${Math.round(deg)}°/km · 와인딩 코스`;
    hookKind = "winding";
  } else if (m && m.peaksPerKm >= 0.4) {
    hook = "산길 코스";
    hookKind = "mountain";
  } else if (deg <= 25) {
    hook = "직선 위주 코스";
    hookKind = "straight";
  }

  if (!hook) return null;

  const extras: string[] = [];
  if (m) {
    if (m.signalsPerKm <= 0.35) extras.push("신호 거의 없음");
    else if (m.signalsPerKm >= 2)
      extras.push("시내 구간·신호 대기 많음");
    if (m.tunnelRatio >= 0.15)
      extras.push(`터널 구간 ${Math.round(m.tunnelRatio * 100)}%`);
  }
  if (hookKind !== "winding" && hookKind !== "straight" && hookKind !== "highlight") {
    if (deg >= 55) extras.push("급커브 구간 포함");
    else if (deg <= 25) extras.push("완만한 커브 위주");
  }

  return extras.length ? `${hook} — ${extras[0]}` : hook;
}
