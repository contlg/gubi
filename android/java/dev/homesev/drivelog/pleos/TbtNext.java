package dev.homesev.drivelog.pleos;

import java.util.*;

/** 순서대로 받은 구간 길이를 보존하고, 고정한 거리 원점에서 다음 회전을 찾는다. */
public final class TbtNext {
  public static final class Leg {
    public final String type, text;
    public final double distanceM;
    public Leg(String type, double distanceM, String text) {
      this.type = code(type);
      this.distanceM = distanceM;
      this.text = text == null ? "" : text;
    }
    private boolean same(Leg other) {
      return type.equals(other.type) && Objects.equals(text, other.text)
          && distanceM == other.distanceM;
    }
  }
  public static String code(String type) {
    if (type == null) {
      return "UNKNOWN";
    }
    String code = type.startsWith("TURN_") ? type.substring(5) : type;
    return code.matches("[A-Z][A-Z0-9_]{0,63}") ? code : "UNKNOWN";
  }
  public static final class Selection {
    public final List<Map<String, Object>> items;
    public final String reason;
    public final boolean refetch;
    private Selection(List<Map<String, Object>> items, String reason) {
      this.items = items;
      this.reason = reason;
      refetch = !reason.isEmpty();
    }
  }
  private List<Leg> legs = List.of();
  private boolean captureStart;
  private boolean awaitingRoute;
  private double start = Double.NaN, remaining = Double.NaN, ref = Double.NaN,
                 alternate = Double.NaN, total;
  private long remainingAt = -1, fetchedAt = -1, establishedAt = -1;
  private long routeAt = -1, routingAt = -1, nonGuidingAt = -1;
  public void reset() {
    reset(false);
  }
  public void reset(boolean captureStart) {
    this.captureStart = captureStart;
    awaitingRoute = false;
    establishedAt = -1;
    routeAt = routingAt = nonGuidingAt = -1;
    legs = List.of();
    start = remaining = ref = alternate = Double.NaN;
    remainingAt = fetchedAt = -1;
  }
  public void routeChanging(long at) {
    reset(false);
    awaitingRoute = true;
    routeAt = at;
  }
  public void routeEstablished(long at) {
    if (at >= routeAt && (awaitingRoute || !captureStart)) {
      awaitingRoute = false;
      captureStart = true;
      establishedAt = at;
      // 참여 중 받은 F는 경로 시작 거리 S로 재사용하지 않는다.
      remaining = Double.NaN;
      remainingAt = -1;
      legs = List.of();
      ref = alternate = Double.NaN;
      invalidate();
    }
  }
  public void routingState(boolean guiding, long at) {
    if (at < routeAt || at < routingAt) {
      return;
    }
    routingAt = at;
    if (!guiding) {
      nonGuidingAt = at;
    } else if (nonGuidingAt >= routeAt && nonGuidingAt >= 0 && at > nonGuidingAt) {
      routeEstablished(at);
    }
  }
  public void remaining(double value, long at) {
    if (awaitingRoute || at < establishedAt || !Double.isFinite(value)
        || value < 0 || value > 1e8 || at < remainingAt) {
      return;
    }
    remaining = value;
    remainingAt = at;
    if (captureStart && !Double.isFinite(start) && value > 0) {
      start = value;
    }
  }
  private static double tolerance(double total, double reference) {
    return Math.max(300, Math.max(total, reference) * .03);
  }
  private boolean fresh(long now) {
    return remainingAt >= 0 && now >= remainingAt && now - remainingAt <= 3000;
  }
  public void fetched(List<Leg> next, long now) {
    if (remainingAt < 0 || Math.abs(now - remainingAt) > 3000
        || next == null || next.isEmpty() || next.size() > 4096) {
      invalidate();
      return;
    }
    double sum = 0;
    for (Leg leg : next) {
      if (leg == null || PleosFeedModel.number(leg.distanceM, 0, 1e8) == null
          || !PleosFeedModel.text(leg.text, 256)) {
        invalidate();
        return;
      }
      sum += leg.distanceM;
    }
    if (sum <= 0 || sum > 1e8 || !"ARRIVE".equals(next.get(next.size() - 1).type)) {
      invalidate();
      return;
    }
    boolean s = Double.isFinite(start) && Math.abs(sum - start) <= tolerance(sum, start);
    boolean f = Math.abs(sum - remaining) <= tolerance(sum, remaining);
    double origin = Double.NaN, other = Double.NaN;
    if (!legs.isEmpty() && equal(next, legs)) {
      // 동일 목록은 원점이나 미해결 후보 모두 그대로 상속한다 (R7).
      origin = ref;
      other = alternate;
    } else if (s && !f) {
      origin = start;
    } else if (f && !s) {
      origin = remaining;
    } else if (s && f) {
      if (suffix(next, legs)) {
        origin = remaining;
      } else {
        origin = start;
        other = remaining;
      }
    }
    if (!Double.isFinite(origin)) {
      invalidate();
      return;
    }
    ref = origin;
    alternate = other;
    total = sum;
    legs = List.copyOf(next);
    fetchedAt = now;
  }
  private void invalidate() {
    // 숨긴 뒤에도 같은 경로의 마지막 수락 목록과 원점은 보존한다.
    // 재조회가 같으면 일시적인 표본 누락을 이동 거리 초기화로 오인하지 않는다.
    fetchedAt = -1;
  }
  private static boolean equal(List<Leg> a, List<Leg> b) {
    if (a.size() != b.size()) {
      return false;
    }
    for (int i = 0; i < a.size(); i++) {
      if (!a.get(i).same(b.get(i))) {
        return false;
      }
    }
    return true;
  }
  private static boolean suffix(List<Leg> a, List<Leg> b) {
    if (a.size() >= b.size() || a.isEmpty()) {
      return false;
    }
    int offset = b.size() - a.size();
    for (int i = 0; i < a.size(); i++) {
      Leg x = a.get(i), y = b.get(offset + i);
      if (i == 0) {
        if (!x.type.equals(y.type) || !Objects.equals(x.text, y.text)
            || x.distanceM > y.distanceM) {
          return false;
        }
      } else if (!x.same(y)) {
        return false;
      }
    }
    return true;
  }
  private double[] select(double origin) {
    double progress = origin - remaining;
    if (progress < -tolerance(total, origin)) {
      return null;
    }
    double cumulative = 0;
    for (int i = 0; i < legs.size(); i++) {
      cumulative += legs.get(i).distanceM * origin / total;
      if (cumulative > progress) {
        return new double[] {i, cumulative - progress};
      }
    }
    return null;
  }
  private static Selection hidden(String reason) {
    return new Selection(List.of(), reason);
  }
  public Selection selection(long now) {
    if (!fresh(now)) {
      return hidden("remaining stale");
    }
    if (legs.isEmpty() || fetchedAt < 0 || now < fetchedAt || now - fetchedAt > 10000) {
      return hidden("list invalid or stale");
    }
    double[] chosen = select(ref);
    if (chosen == null) {
      return hidden("remaining grew or route finished");
    }
    if (Double.isFinite(alternate)) {
      double[] second = select(alternate);
      if (second == null || second[0] != chosen[0]) {
        return hidden("origin ambiguous");
      }
      chosen[1] = Math.min(chosen[1], second[1]);
    }
    int index = (int) chosen[0];
    List<Map<String, Object>> items = new ArrayList<>();
    for (int i = index; i < Math.min(index + 3, legs.size()); i++) {
      Leg leg = legs.get(i);
      items.add(PleosFeedModel.object("type", leg.type, "distanceM",
          i == index ? chosen[1] : leg.distanceM * ref / total, "text", leg.text));
    }
    return new Selection(items, "");
  }
}
