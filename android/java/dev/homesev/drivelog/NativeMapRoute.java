package dev.homesev.drivelog;

public final class NativeMapRoute {
  private NativeMapRoute() {}

  public static int cut(int alongIdx, int pointCount) {
    return Math.max(0, (int) Math.min((long) alongIdx + 1, pointCount - 1L));
  }

  public static boolean passed(int index, int cut) {
    return index < Math.max(0, cut - 1);
  }

  public static boolean traffic(int index, int cut) {
    return index >= Math.max(0, cut - 1) && index < (long) cut + 900;
  }

  public static int maneuverStart(int alongIdx) {
    return Math.max(0, alongIdx - 2);
  }
}
