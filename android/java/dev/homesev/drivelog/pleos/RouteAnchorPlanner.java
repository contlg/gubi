package dev.homesev.drivelog.pleos;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.PriorityQueue;

/** 현대 내비는 코스 기하를 받지 않으므로 앵커만으로 경로 일치를 보장할 수 없다. */
public final class RouteAnchorPlanner {
  private RouteAnchorPlanner() {}
  public static final class Point {
    public final double lat, lng;
    public Point(double lat, double lng) {
      if (!Double.isFinite(lat) || !Double.isFinite(lng) || lat < -90 || lat > 90 || lng < -180
          || lng > 180) {
        throw new IllegalArgumentException("Invalid coordinate");
      }
      this.lat = lat;
      this.lng = lng;
    }
    @Override
    public String toString() {
      return lat + "," + lng;
    }
  }
  public static final class Via {
    public final String name;
    public final Point point;
    public Via(String name, double lat, double lng) {
      this.name = name == null ? "" : name;
      this.point = new Point(lat, lng);
    }
  }
  public static final class Anchor {
    public final Point point;
    public final String name;
    public final int sourceIndex;
    public final double distanceFromStartM;
    public final boolean mandatory;
    public Anchor(
        Point point, String name, int sourceIndex, double distanceFromStartM, boolean mandatory) {
      this.point = point;
      this.name = name;
      this.sourceIndex = sourceIndex;
      this.distanceFromStartM = distanceFromStartM;
      this.mandatory = mandatory;
    }
    @Override
    public String toString() {
      return name + " @" + Math.round(distanceFromStartM) + "m" + (mandatory ? " (via)" : "");
    }
  }
  public static final class Plan {
    public final Point start, destination;
    public final double totalM;
    public final List<Anchor> anchors;
    public final int skippedNamedVias;
    public final boolean capReached;
    public final List<Point> path;
    final double[] arc;
    public Plan(
        Point s, Point d, double totalM, List<Anchor> a, int skippedNamedVias, boolean capReached) {
      this(s, d, totalM, a, skippedNamedVias, capReached, List.of(), new double[0]);
    }
    Plan(Point s, Point d, double totalM, List<Anchor> a, int skippedNamedVias, boolean capReached,
        List<Point> path, double[] arc) {
      start = s;
      destination = d;
      this.totalM = totalM;
      anchors = List.copyOf(a);
      this.skippedNamedVias = skippedNamedVias;
      this.capReached = capReached;
      this.path = List.copyOf(path);
      this.arc = arc.clone();
    }
    public double arcAt(int i) {
      return arc[i];
    }
    public List<Anchor> initial() {
      return anchors.subList(0, Math.min(2, anchors.size()));
    }
  }
  static final double EARTH = 6371008.8;

  public static double distanceM(Point a, Point b) {
    double lat = Math.toRadians(b.lat - a.lat), lng = Math.toRadians(b.lng - a.lng);
    double s = Math.sin(lat / 2) * Math.sin(lat / 2)
        + Math.cos(Math.toRadians(a.lat)) * Math.cos(Math.toRadians(b.lat)) * Math.sin(lng / 2)
            * Math.sin(lng / 2);
    return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }

  public static List<Point> decode(String encoded) {
    if (encoded == null || encoded.isBlank()) {
      throw new IllegalArgumentException("Empty polyline");
    }
    if (encoded.length() > 900_000) {
      throw new IllegalArgumentException("Polyline too long");
    }
    ArrayList<Point> out = new ArrayList<>();
    long lat = 0, lng = 0;
    int at = 0;
    while (at < encoded.length()) {
      long[] v = readVarint(encoded, at);
      lat += v[0];
      at = (int) v[1];
      if (at >= encoded.length()) {
        throw new IllegalArgumentException("Truncated polyline");
      }
      v = readVarint(encoded, at);
      lng += v[0];
      at = (int) v[1];
      out.add(new Point(lat / 1e5, lng / 1e5));
      if (out.size() > 70000) {
        throw new IllegalArgumentException("Too many route points");
      }
    }
    if (out.size() < 2) {
      throw new IllegalArgumentException("Polyline requires 2+ points");
    }
    return out;
  }

  static long[] readVarint(String s, int pos) {
    long result = 0;
    int shift = 0;
    while (true) {
      if (pos >= s.length() || shift > 40) {
        throw new IllegalArgumentException("Malformed encoded polyline");
      }
      int b = s.charAt(pos++) - 63;
      if (b < 0 || b > 63) {
        throw new IllegalArgumentException("Invalid polyline character");
      }
      result |= (long) (b & 31) << shift;
      if (b < 32) {
        break;
      }
      shift += 5;
    }
    return new long[] {((result & 1) != 0) ? ~(result >>> 1) : (result >>> 1), pos};
  }
  static final class Interval {
    final int from, to, split;
    final double score, deviation;
    Interval(int from, int to, int split, double score, double dev) {
      this.from = from;
      this.to = to;
      this.split = split;
      this.score = score;
      this.deviation = dev;
    }
  }

  static double chordDeviationM(Point p, Point a, Point b) {
    double meanLat = Math.toRadians((a.lat + b.lat + p.lat) / 3);
    double bx = (b.lng - a.lng) * 111195 * Math.cos(meanLat), by = (b.lat - a.lat) * 111195;
    double px = (p.lng - a.lng) * 111195 * Math.cos(meanLat), py = (p.lat - a.lat) * 111195;
    double den = bx * bx + by * by;
    double t = den < 1 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / den));
    return Math.hypot(px - t * bx, py - t * by);
  }

  static Interval interval(List<Point> path, double[] arc, int from, int to) {
    if (to - from < 2) {
      return null;
    }
    double len = arc[to] - arc[from], chord = distanceM(path.get(from), path.get(to));
    if (len < 900) {
      return null;
    }
    int split = -1;
    double maxDev = -1;
    for (int i = from + 1; i < to; i++) {
      if (arc[i] - arc[from] < 330 || arc[to] - arc[i] < 330) {
        continue;
      }
      double dev = chordDeviationM(path.get(i), path.get(from), path.get(to));
      if (dev > maxDev) {
        maxDev = dev;
        split = i;
      }
    }
    if (split < 0) {
      return null;
    }
    // 긴 직선에서도 평행 도로로 빠지지 않게 중간 앵커를 둔다.
    if (maxDev < 200 && len > 11_000) {
      double mid = (arc[from] + arc[to]) / 2;
      for (int i = from + 1; i < to; i++) {
        if (arc[i] >= mid) {
          split = i;
          break;
        }
      }
    }
    double stretch = Math.min(3.0, len / Math.max(100, chord));
    double score = maxDev + Math.min(400, (stretch - 1) * 180);
    if (len > 11_000) {
      score = Math.max(score, 300 + (len - 11_000) / 1000 * 15);
    }
    if (score < 245 && len <= 11_000) {
      return null;
    }
    return new Interval(from, to, split, score, maxDev);
  }

  public static Plan plan(String encoded, List<Via> namedVias) {
    return plan(decode(encoded), namedVias, 24);
  }

  public static Plan plan(List<Point> source, List<Via> namedVias, int maxAnchors) {
    if (source == null || source.size() < 2) {
      throw new IllegalArgumentException("Route needs at least 2 coordinates");
    }
    if (maxAnchors < 0 || maxAnchors > 60) {
      throw new IllegalArgumentException("Invalid anchor cap");
    }
    ArrayList<Point> path = new ArrayList<>();
    for (Point p : source) {
      if (path.isEmpty() || distanceM(path.get(path.size() - 1), p) > 2.5) {
        path.add(p);
      }
    }
    if (path.size() < 2) {
      throw new IllegalArgumentException("Route collapsed");
    }
    double[] arc = new double[path.size()];
    for (int i = 1; i < path.size(); i++) {
      arc[i] = arc[i - 1] + distanceM(path.get(i - 1), path.get(i));
    }
    if (arc[path.size() - 1] > 2_000_000) {
      throw new IllegalArgumentException("Unusually long route");
    }
    boolean[] picked = new boolean[path.size()];
    String[] labels = new String[path.size()];
    int skips = 0, forced = 0;
    List<Via> vias = namedVias == null ? List.of() : namedVias;
    // 사용자가 지정한 경유지는 보존하되 경로에 대응되지 않는 점은 거부한다.
    for (Via v : vias) {
      int best = -1;
      double min = 180;
      for (int i = 1; i < path.size() - 1; i++) {
        double d = distanceM(v.point, path.get(i));
        if (d < min) {
          min = d;
          best = i;
        }
      }
      if (best < 0 || arc[best] < 250 || arc[path.size() - 1] - arc[best] < 250) {
        skips++;
        continue;
      }
      if (!picked[best]) {
        picked[best] = true;
        labels[best] = v.name.isBlank() ? "방문 지점" : v.name;
        forced++;
      }
    }
    // 필수 경유지가 상한을 넘으면 삭제하지 않고 명시적으로 실패한다.
    if (forced > maxAnchors) {
      throw new IllegalArgumentException("Route contains more mandatory visits than plan cap");
    }
    PriorityQueue<Interval> pq =
        new PriorityQueue<>(Comparator.<Interval>comparingDouble(i -> i.score).reversed());
    ArrayList<Integer> boundaries = new ArrayList<>();
    boundaries.add(0);
    for (int i = 1; i < path.size() - 1; i++) {
      if (picked[i]) {
        boundaries.add(i);
      }
    }
    boundaries.add(path.size() - 1);
    for (int i = 1; i < boundaries.size(); i++) {
      Interval w = interval(path, arc, boundaries.get(i - 1), boundaries.get(i));
      if (w != null) {
        pq.add(w);
      }
    }
    int count = forced;
    while (!pq.isEmpty() && count < maxAnchors) {
      Interval w = pq.poll();
      // 회전 정점에 경유지를 두면 교차 도로나 반대 차로로 매칭될 수 있어 정점을 피한다.
      int i = nudgeAwayFromTurns(path, arc, w.split, w.from, w.to);
      if (picked[i]) {
        continue;
      }
      // 필수 경유지와 기존 곡선 앵커 주변에 중복 앵커를 넣지 않는다.
      boolean tooClose = false;
      for (int j = 1; j < path.size() - 1; j++) {
        if (picked[j] && Math.abs(arc[i] - arc[j]) < 650) {
          tooClose = true;
          break;
        }
      }
      if (tooClose) {
        continue;
      }
      picked[i] = true;
      count++;
      Interval a = interval(path, arc, w.from, i), b = interval(path, arc, i, w.to);
      if (a != null) {
        pq.add(a);
      }
      if (b != null) {
        pq.add(b);
      }
    }
    boolean capReached = !pq.isEmpty();
    ArrayList<Anchor> anchors = new ArrayList<>();
    // 이름 없는 통과 지점은 순정 내비에 "다음 명소 방향"으로 보인다(없으면 도착 방향).
    String nextLabel = null;
    String[] autoName = new String[path.size()];
    for (int i = path.size() - 2; i >= 1; i--) {
      if (labels[i] != null) {
        nextLabel = labels[i];
      }
      autoName[i] = shortName(nextLabel != null ? nextLabel : "도착지") + " 방향";
    }
    for (int i = 1; i < path.size() - 1; i++) {
      if (picked[i]) {
        boolean mandatory = labels[i] != null;
        anchors.add(new Anchor(path.get(i), mandatory ? labels[i] : autoName[i], i,
            arc[i], mandatory));
      }
    }
    return new Plan(path.get(0), path.get(path.size() - 1), arc[path.size() - 1], anchors, skips,
        capReached, path, arc);
  }

  static String shortName(String name) {
    String n = name.trim();
    return n.length() > 14 ? n.substring(0, 14) : n;
  }

  static double turnDeg(List<Point> path, double[] arc, int i, double spanM) {
    int a = i, b = i;
    while (a > 0 && arc[i] - arc[a] < spanM) {
      a--;
    }
    while (b < path.size() - 1 && arc[b] - arc[i] < spanM) {
      b++;
    }
    if (a == i || b == i) {
      return 0;
    }
    double d =
        Math.abs(bearing(path.get(a), path.get(i)) - bearing(path.get(i), path.get(b))) % 360;
    return d > 180 ? 360 - d : d;
  }

  static double bearing(Point a, Point b) {
    double la = Math.toRadians(a.lat), lb = Math.toRadians(b.lat),
           dl = Math.toRadians(b.lng - a.lng);
    double y = Math.sin(dl) * Math.cos(lb),
           x = Math.cos(la) * Math.sin(lb) - Math.sin(la) * Math.cos(lb) * Math.cos(dl);
    return (Math.toDegrees(Math.atan2(y, x)) + 360) % 360;
  }
  static final double TURN_DEG = 35, TURN_SPAN_M = 40, TURN_CLEAR_M = 150;

  public static double[] turnArcs(Plan plan) {
    ArrayList<Double> out = new ArrayList<>();
    for (int i = 1; i < plan.path.size() - 1; i++) {
      if (turnDeg(plan.path, plan.arc, i, TURN_SPAN_M) >= TURN_DEG) {
        if (!out.isEmpty() && plan.arc[i] - out.get(out.size() - 1) < 60) {
          continue;
        }
        out.add(plan.arc[i]);
      }
    }
    double[] r = new double[out.size()];
    for (int i = 0; i < r.length; i++) {
      r[i] = out.get(i);
    }
    return r;
  }

  static boolean clearOfTurns(List<Point> path, double[] arc, int i) {
    for (int j = i; j > 0 && arc[i] - arc[j] <= TURN_CLEAR_M; j--) {
      if (turnDeg(path, arc, j, TURN_SPAN_M) >= TURN_DEG) {
        return false;
      }
    }
    for (int j = i; j < path.size() - 1 && arc[j] - arc[i] <= TURN_CLEAR_M; j++) {
      if (turnDeg(path, arc, j, TURN_SPAN_M) >= TURN_DEG) {
        return false;
      }
    }
    return true;
  }
  /** 회전을 지나도록 회전 직후의 직선 구간을 우선하며 분할점은 양 끝에서 330m 이상 떨어뜨린다. */
  static int nudgeAwayFromTurns(List<Point> path, double[] arc, int i, int from, int to) {
    if (clearOfTurns(path, arc, i)) {
      return i;
    }
    for (int j = i + 1; j < to && arc[j] - arc[i] <= 600; j++) {
      if (arc[to] - arc[j] < 330) {
        break;
      }
      if (arc[j] - arc[i] >= TURN_CLEAR_M && clearOfTurns(path, arc, j)) {
        return j;
      }
    }
    for (int j = i - 1; j > from && arc[i] - arc[j] <= 600; j--) {
      if (arc[j] - arc[from] < 330) {
        break;
      }
      if (arc[i] - arc[j] >= TURN_CLEAR_M && clearOfTurns(path, arc, j)) {
        return j;
      }
    }
    return i;
  }

  public static Plan splitLeg(Plan plan, int leg) {
    if (plan.path.isEmpty() || leg < 0 || leg > plan.anchors.size()) {
      return null;
    }
    int from = leg == 0 ? 0 : plan.anchors.get(leg - 1).sourceIndex;
    int to = leg == plan.anchors.size() ? plan.path.size() - 1 : plan.anchors.get(leg).sourceIndex;
    if (plan.arc[to] - plan.arc[from] < 700) {
      return null;
    }
    int split = -1;
    double best = -1;
    for (int i = from + 1; i < to; i++) {
      if (plan.arc[i] - plan.arc[from] < 330 || plan.arc[to] - plan.arc[i] < 330) {
        continue;
      }
      double dev = chordDeviationM(plan.path.get(i), plan.path.get(from), plan.path.get(to));
      if (dev > best) {
        best = dev;
        split = i;
      }
    }
    if (split < 0) {
      return null;
    }
    // 직선 구간에서도 평행 도로로 빠질 수 있어 중간점을 고정한다.
    if (best < 60) {
      double mid = (plan.arc[from] + plan.arc[to]) / 2;
      for (int i = from + 1; i < to; i++) {
        if (plan.arc[i] >= mid) {
          split = i;
          break;
        }
      }
    }
    split = nudgeAwayFromTurns(plan.path, plan.arc, split, from, to);
    ArrayList<Anchor> next = new ArrayList<>(plan.anchors);
    int auto = 0;
    for (Anchor a : plan.anchors) {
      if (!a.mandatory) {
        auto++;
      }
    }
    next.add(leg,
        new Anchor(
            plan.path.get(split), "Gubi 보정 " + (auto + 1), split, plan.arc[split], false));
    return new Plan(plan.start, plan.destination, plan.totalM, next, plan.skippedNamedVias,
        plan.capReached, plan.path, plan.arc);
  }
}
