package dev.homesev.drivelog.pleos;

import java.util.List;

public final class CourseProgress {
  public static final double PASS_AFTER_M = 40, ON_COURSE_M = 60, OFF_COURSE_M = 90;
  public static final int OFF_COURSE_FIXES = 3;
  /** 현대 내비 재탐색에 약 7초가 걸리므로 여유를 둔다. */
  public static final double REROUTE_LATENCY_S = 8, TURN_BUFFER_M = 150, MIN_SPEED_MPS = 8;
  private final RouteAnchorPlanner.Plan plan;
  private final double[] turns;
  private int segment = -1;
  private double arcM = Double.NaN, lateralM = Double.NaN;
  private int offCount = 0;
  private boolean resumePending;
  private double seedArcM;
  private long seedSavedAtWallMs;
  java.util.function.LongSupplier clock = System::currentTimeMillis;

  public CourseProgress(RouteAnchorPlanner.Plan plan) {
    if (plan.path.size() < 2) {
      throw new IllegalArgumentException("Plan has no geometry");
    }
    this.plan = plan;
    this.turns = RouteAnchorPlanner.turnArcs(plan);
  }

  public double arcM() {
    return arcM;
  }

  public double lateralM() {
    return lateralM;
  }

  public boolean offCourse() {
    return offCount >= OFF_COURSE_FIXES;
  }

  public double[] turns() {
    return turns.clone();
  }
  public static final double HEADING_TOL_DEG = 90, HEADING_MIN_SPEED_MPS = 3;
  public static final double MAX_ADVANCE_BASE_M = 80, MAX_ADVANCE_S = 3, MAX_BACKTRACK_M = 30;
  private double maxAdvanceM = Double.POSITIVE_INFINITY, maxBacktrackM = Double.POSITIVE_INFINITY;
  private double fixBearing = Double.NaN;
  public static final double MATCH_HEADING_MIN_SPEED_MPS = 1, WRONG_WAY_PENALTY_M = 50;
  private boolean headingOk = true;

  public void update(double lat, double lng, double bearingDeg, double speedMps) {
    // 1초 위치 표본이 왕복 구간의 복귀 차로로 튀지 않게 진행 거리 상한을 둔다.
    maxAdvanceM = MAX_ADVANCE_BASE_M + Math.max(0, speedMps) * MAX_ADVANCE_S;
    fixBearing = speedMps >= MATCH_HEADING_MIN_SPEED_MPS ? bearingDeg : Double.NaN;
    // 코스상 큰 후퇴는 인접 구간으로 튄 위치로 보고 거부한다.
    maxBacktrackM = MAX_BACKTRACK_M;
    try {
      update(lat, lng);
    } finally {
      maxAdvanceM = Double.POSITIVE_INFINITY;
      maxBacktrackM = Double.POSITIVE_INFINITY;
      fixBearing = Double.NaN;
    }
    // 저속에서는 마지막 판정을 유지한다.
    if (Double.isNaN(bearingDeg) || speedMps < HEADING_MIN_SPEED_MPS || segment < 0) {
      return;
    }
    double c = RouteAnchorPlanner.bearing(plan.path.get(segment), plan.path.get(segment + 1));
    double d = Math.abs(((bearingDeg - c) % 360 + 540) % 360 - 180);
    headingOk = d <= HEADING_TOL_DEG;
  }

  public boolean headingOk() {
    return headingOk;
  }

  void seed(double arc, long savedAtWallMs) {
    arcM = Math.max(0, Math.min(plan.totalM, arc));
    segment = 0;
    while (segment < plan.path.size() - 2 && plan.arcAt(segment + 1) < arcM) {
      segment++;
    }
    lateralM = Double.NaN;
    offCount = 0;
    seedArcM = arcM;
    seedSavedAtWallMs = savedAtWallMs;
    resumePending = true;
  }
  private static final class Match {
    final double arc, lateral;
    final int segment;
    Match(double arc, double lateral, int segment) {
      this.arc = arc;
      this.lateral = lateral;
      this.segment = segment;
    }
  }

  private double headingPenalty(int i, double bearing) {
    if (Double.isNaN(bearing)) {
      return 0;
    }
    double courseBearing = RouteAnchorPlanner.bearing(plan.path.get(i), plan.path.get(i + 1));
    return Math.abs(((bearing - courseBearing) % 360 + 540) % 360 - 180) > 90 ? WRONG_WAY_PENALTY_M
                                                                              : 0;
  }

  double[] projectWithin(double lat, double lng, double minArc, double maxArc) {
    return projectWithin(lat, lng, minArc, maxArc, Double.NaN, 0);
  }

  double[] projectWithin(
      double lat, double lng, double minArc, double maxArc, double bearingDeg, double speedMps) {
    Match match = matchWithin(new RouteAnchorPlanner.Point(lat, lng), minArc, maxArc,
        speedMps >= MATCH_HEADING_MIN_SPEED_MPS ? bearingDeg : Double.NaN);
    return new double[] {match.arc, match.lateral};
  }

  private Match matchWithin(
      RouteAnchorPlanner.Point p, double minArc, double maxArc, double bearing) {
    double best = Double.POSITIVE_INFINITY, bestArc = Double.NaN,
           bestLateral = Double.POSITIVE_INFINITY;
    int bestSegment = -1;
    minArc = Math.max(0, minArc);
    maxArc = Math.min(plan.totalM, maxArc);
    if (maxArc < minArc) {
      return new Match(bestArc, bestLateral, bestSegment);
    }
    for (int i = 0; i < plan.path.size() - 1; i++) {
      double from = plan.arcAt(i), to = plan.arcAt(i + 1), span = to - from;
      if (to < minArc || from > maxArc || span <= 0) {
        continue;
      }
      RouteAnchorPlanner.Point a = plan.path.get(i), b = plan.path.get(i + 1);
      double t = project(p, a, b)[1];
      t = Math.max(
          Math.max(0, (minArc - from) / span), Math.min(Math.min(1, (maxArc - from) / span), t));
      RouteAnchorPlanner.Point clipped =
          new RouteAnchorPlanner.Point(a.lat + t * (b.lat - a.lat), a.lng + t * (b.lng - a.lng));
      double lateral = RouteAnchorPlanner.distanceM(p, clipped),
             score = lateral + headingPenalty(i, bearing);
      if (score < best - 0.5) {
        best = score;
        bestLateral = lateral;
        bestArc = from + t * span;
        bestSegment = i;
      }
    }
    return new Match(bestArc, bestLateral, bestSegment);
  }

  private boolean reacquire(RouteAnchorPlanner.Point p, double minArc, double maxArc) {
    Match match = matchWithin(p, minArc, maxArc, fixBearing);
    lateralM = match.lateral;
    if (match.segment < 0 || match.lateral > ON_COURSE_M) {
      return false;
    }
    arcM = Math.max(arcM, match.arc);
    segment = match.segment;
    offCount = 0;
    return true;
  }

  public void update(double lat, double lng) {
    RouteAnchorPlanner.Point p = new RouteAnchorPlanner.Point(lat, lng);
    if (resumePending) {
      double[] window = CourseResume.window(seedArcM, clock.getAsLong() - seedSavedAtWallMs);
      if (reacquire(p, window[0], window[1])) {
        resumePending = false;
      } else if (++offCount >= OFF_COURSE_FIXES) {
        // 경로 이탈 후에는 기본 위치 매칭으로 돌아간다.
        resumePending = false;
      }
      return;
    }
    List<RouteAnchorPlanner.Point> path = plan.path;
    int lo = 0, hi = path.size() - 2;
    if (segment >= 0 && !offCourse()) {
      lo = Math.max(0, segment - 5);
      while (hi > lo && plan.arcAt(hi) - plan.arcAt(segment) > 3000) {
        hi--;
      }
    }
    double best = Double.MAX_VALUE, bestLateral = Double.MAX_VALUE, bestArc = Double.NaN;
    int bestSeg = -1;
    for (int i = lo; i <= hi; i++) {
      double[] r = project(p, path.get(i), path.get(i + 1));
      double candArc = plan.arcAt(i) + r[1] * (plan.arcAt(i + 1) - plan.arcAt(i));
      if (!Double.isNaN(arcM) && !offCourse()
          && (candArc > arcM + maxAdvanceM || candArc < arcM - maxBacktrackM)) {
        continue;
      }
      // 왕복 구간에서는 차량 진행 방향과 같은 선분을 우선한다.
      double score = r[0] + headingPenalty(i, fixBearing);
      if (score < best - 0.5) {
        best = score;
        bestLateral = r[0];
        bestSeg = i;
        bestArc = plan.arcAt(i) + r[1] * (plan.arcAt(i + 1) - plan.arcAt(i));
      }
    }
    if (bestSeg < 0) {
      return;
    }
    lateralM = bestLateral;
    // 이탈 중에는 마지막 코스 위 진행 거리를 유지한다.
    if (bestLateral > OFF_COURSE_M) {
      offCount++;
      return;
    }
    offCount = 0;
    segment = bestSeg;
    arcM = bestArc;
  }

  public boolean passed(RouteAnchorPlanner.Anchor a) {
    return !Double.isNaN(arcM) && lateralM <= ON_COURSE_M && headingOk
        && arcM >= a.distanceFromStartM + PASS_AFTER_M;
  }

  public double nextTurnAheadM() {
    if (Double.isNaN(arcM)) {
      return Double.POSITIVE_INFINITY;
    }
    for (double t : turns) {
      if (t > arcM + 5) {
        return t - arcM;
      }
    }
    return Double.POSITIVE_INFINITY;
  }

  public static double refreshNeedM(double speedMps) {
    return Math.max(speedMps, MIN_SPEED_MPS) * REROUTE_LATENCY_S + TURN_BUFFER_M;
  }
  /** 재탐색 중 다음 회전을 지나칠 수 있으면 해당 회전을 통과할 때까지 경유지 갱신을 기다린다. */
  public boolean refreshAllowed(double speedMps) {
    return nextTurnAheadM() >= refreshNeedM(speedMps);
  }

  static double[] project(
      RouteAnchorPlanner.Point p, RouteAnchorPlanner.Point a, RouteAnchorPlanner.Point b) {
    double c = Math.cos(Math.toRadians((a.lat + b.lat) / 2));
    double bx = (b.lng - a.lng) * 111195 * c, by = (b.lat - a.lat) * 111195;
    double px = (p.lng - a.lng) * 111195 * c, py = (p.lat - a.lat) * 111195;
    double den = bx * bx + by * by;
    double t = den < 1e-6 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / den));
    return new double[] {Math.hypot(px - t * bx, py - t * by), t};
  }
}
