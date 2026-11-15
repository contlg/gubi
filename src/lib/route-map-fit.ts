export interface MapView {
  scale: number;
  cx: number;
  cy: number;
  w: number;
  h: number;
}

export interface MapBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

/** Fit projected bounds at the highest supported scale, using CSS-pixel padding. */
export function fitViewToBounds(bounds: MapBounds, w: number, h: number, padding = 40): MapView | null {
  const { minX, maxX, minY, maxY } = bounds;
  if (![w, h, minX, maxX, minY, maxY].every(Number.isFinite) ||
    w <= 0 || h <= 0 || minX > maxX || minY > maxY) return null;
  const inset = Math.min(padding, w / 4, h / 4);
  const scale = Math.min(
    (w - 2 * inset) / (maxX - minX || Number.EPSILON),
    (h - 2 * inset) / (maxY - minY || Number.EPSILON),
    256 * 2 ** 19,
  );
  return { scale, cx: (minX + maxX) / 2 * scale, cy: (minY + maxY) / 2 * scale, w, h };
}

/** Projected world coordinates. Preserve a visible route; otherwise move as little
 * as possible, reducing scale only when the route cannot fit at the current zoom. */
export function expandViewForRoute(view: MapView, bounds: MapBounds): MapView | null {
  const { scale, cx, cy, w, h } = view;
  const { minX, maxX, minY, maxY } = bounds;
  if (w <= 0 || h <= 0 || scale <= 0 || ![minX, maxX, minY, maxY].every(Number.isFinite)) return null;
  if (
    minX * scale >= cx - w / 2 && maxX * scale <= cx + w / 2 &&
    minY * scale >= cy - h / 2 && maxY * scale <= cy + h / 2
  ) return null;

  const padding = Math.min(24, w * 0.05, h * 0.09);
  const nextScale = Math.min(scale,
    (w - 2 * padding) / (maxX - minX || Number.EPSILON),
    (h - 2 * padding) / (maxY - minY || Number.EPSILON));
  const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(high, value));
  return {
    scale: nextScale,
    cx: clamp(cx * nextScale / scale, maxX * nextScale - w / 2 + padding, minX * nextScale + w / 2 - padding),
    cy: clamp(cy * nextScale / scale, maxY * nextScale - h / 2 + padding, minY * nextScale + h / 2 - padding),
    w, h,
  };
}
