export interface ScreenPoint {
  x: number;
  y: number;
}

/** Screen-space segment distance, so sparse paths and every zoom level work alike. */
export function hitTestRoute(
  routes: { label: string; points: ScreenPoint[] }[],
  point: ScreenPoint,
  radius = 24,
  selected?: string,
): string | null {
  let nearest: string | null = null;
  let nearestDistance = Infinity;
  for (const route of routes) {
    let distance = Infinity;
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i - 1];
      const b = route.points[i];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1,
        ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared,
      ));
      distance = Math.min(distance, Math.hypot(point.x - a.x - t * dx, point.y - a.y - t * dy));
    }
    if (distance > radius) continue;
    if (distance < nearestDistance - 1e-6) {
      nearest = route.label;
      nearestDistance = distance;
    } else if (Math.abs(distance - nearestDistance) <= 1e-6 && route.label === selected) {
      nearest = selected;
    }
  }
  return nearest;
}
