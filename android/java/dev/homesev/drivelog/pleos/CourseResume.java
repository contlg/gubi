package dev.homesev.drivelog.pleos;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;

public final class CourseResume {
  private CourseResume() {}

  public static String planKey(RouteAnchorPlanner.Plan plan) {
    StringBuilder key = new StringBuilder()
                            .append(plan.destination.lat)
                            .append(',')
                            .append(plan.destination.lng)
                            .append(';')
                            .append(plan.totalM);
    for (RouteAnchorPlanner.Anchor a : plan.anchors) {
      key.append(';')
          .append(a.name.length())
          .append(':')
          .append(a.name)
          .append(',')
          .append(a.point.lat)
          .append(',')
          .append(a.point.lng)
          .append(',')
          .append(a.distanceFromStartM);
    }
    long hash = 0xcbf29ce484222325L;
    for (byte b : key.toString().getBytes(StandardCharsets.UTF_8)) {
      hash ^= b & 255;
      hash *= 0x100000001b3L;
    }
    return Long.toHexString(hash);
  }
  public static List<RouteAnchorPlanner.Anchor> remaining(
      RouteAnchorPlanner.Plan plan, double resumeArcM, int confirmedPassed) {
    List<RouteAnchorPlanner.Anchor> rest = new ArrayList<>();
    for (int i = 0; i < plan.anchors.size(); i++) {
      RouteAnchorPlanner.Anchor a = plan.anchors.get(i);
      if (i >= confirmedPassed && resumeArcM < a.distanceFromStartM + CourseProgress.PASS_AFTER_M) {
        rest.add(a);
      }
    }
    return rest;
  }
  /** 호출부에서 투영 범위의 상한을 전체 코스 길이로 제한한다. */
  public static double[] window(double cachedArcM, long elapsedMs) {
    return new double[] {
        Math.max(0, cachedArcM - 500), cachedArcM + 200 + 40 * (Math.max(0, elapsedMs) / 1000.0)};
  }
  /** 범위 밖 위치는 NaN으로 남겨 잘못된 복원을 막는다. */
  public static double resumeArc(double cachedArcM, double fixArcInWindowM, boolean fixOnCourse) {
    if (!Double.isFinite(cachedArcM)) {
      return 0;
    }
    return fixOnCourse && Double.isFinite(fixArcInWindowM) ? Math.max(cachedArcM, fixArcInWindowM)
                                                           : cachedArcM;
  }
}
