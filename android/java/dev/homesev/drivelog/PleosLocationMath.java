package dev.homesev.drivelog;

public final class PleosLocationMath {
  private PleosLocationMath() {}

  public static long elapsedNanos(long receiptNanos, long wallNow, long fixWall) {
    long receipt = Math.max(0, receiptNanos);
    // 곱하기 전에 밀리초로 비교해 오래된 표본도 오버플로하지 않게 한다.
    long age = fixWall >= wallNow ? 0 : wallNow - fixWall;
    if (age < 0 || age > receipt / 1000000L) {
      return 0;
    }
    return Math.max(0, Math.min(receipt, receipt - age * 1000000L));
  }

  public static boolean vehicleSpeed(Double speed, long ageMs) {
    return speed != null && Double.isFinite(speed) && Math.abs(speed) <= 120 && ageMs >= 0
        && ageMs < 2000;
  }

  public static boolean positionalSpeedAllowed(boolean hasSpeed, String speedSource) {
    return !hasSpeed || !"vehicle".equals(speedSource);
  }

  public static boolean recordingPleos(boolean hasSpeed, String speedSource, long speedAgeMs) {
    return hasSpeed && "vehicle".equals(speedSource) && speedAgeMs >= 0 && speedAgeMs < 2000;
  }
}
