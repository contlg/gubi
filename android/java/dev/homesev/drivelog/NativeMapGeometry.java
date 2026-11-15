package dev.homesev.drivelog;

public final class NativeMapGeometry {
  private NativeMapGeometry() {}
  public static final class Rect {
    public final double left, top, right, bottom;
    public Rect(double left, double top, double right, double bottom) {
      this.left = left;
      this.top = top;
      this.right = right;
      this.bottom = bottom;
    }
    public boolean contains(double x, double y) {
      return Double.isFinite(x) && Double.isFinite(y) && x >= left && y >= top && x < right
          && y < bottom;
    }
  }

  public static Rect toWindow(Rect css, double scale, double webX, double webY) {
    if (!Double.isFinite(scale) || scale <= 0) {
      return new Rect(0, 0, 0, 0);
    }
    return new Rect(css.left * scale + webX, css.top * scale + webY, css.right * scale + webX,
        css.bottom * scale + webY);
  }

  public static boolean routeToMap(
      boolean visible, boolean blocked, Rect map, Rect[] exclusions, double x, double y) {
    if (!visible || blocked || map == null || !map.contains(x, y)) {
      return false;
    }
    for (Rect rect : exclusions) {
      if (rect.contains(x, y)) {
        return false;
      }
    }
    return true;
  }

  public static double local(double windowCoordinate, double viewOrigin) {
    return windowCoordinate - viewOrigin;
  }

  public static boolean isMapGesture(
      double downX, double downY, double x, double y, int pointers, double touchSlop) {
    return pointers > 1 || Math.hypot(x - downX, y - downY) > touchSlop;
  }
}
