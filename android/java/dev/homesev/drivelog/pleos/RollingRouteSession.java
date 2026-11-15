package dev.homesev.drivelog.pleos;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/** 최종 목적지는 유지하고 실제 도착 이벤트와 경로 응답을 모두 받은 뒤 두 경유지를 한 번에 교체한다. */
public final class RollingRouteSession {
  public enum Kind { NONE, READ_WAYPOINTS, REPLACE_TWO, ADD_SECOND, PAUSED }
  public static final class Action {
    public final Kind kind;
    public final List<RouteAnchorPlanner.Anchor> waypoints;
    public final RouteAnchorPlanner.Anchor point;
    public final String message;
    Action(Kind kind, List<RouteAnchorPlanner.Anchor> waypoints, RouteAnchorPlanner.Anchor point,
        String message) {
      this.kind = kind;
      this.waypoints = waypoints;
      this.point = point;
      this.message = message;
    }
    public static Action none() {
      return of(Kind.NONE, null, "");
    }
    static Action of(Kind k, RouteAnchorPlanner.Anchor p, String m) {
      return new Action(k, List.of(), p, m);
    }
    static Action replace(List<RouteAnchorPlanner.Anchor> p) {
      return new Action(Kind.REPLACE_TWO, List.copyOf(p), null,
          "Replace waypoint window in one native routing request");
    }
  }
  enum State { READY, VERIFY_ARRIVAL, WAIT_REPLACE, WAIT_ADD, PAUSED, FINISHED }
  final List<RouteAnchorPlanner.Anchor> all;
  final List<RouteAnchorPlanner.Anchor> visible = new ArrayList<>();
  private String pauseReason = "";
  int nextUnsent;
  State state = State.READY;
  List<RouteAnchorPlanner.Anchor> target = List.of();
  int transientRetries = 0;
  /** 경유지 교체 뒤 6~7초 동안 빈 응답이 올 수 있어 응답 횟수 대신 경과 시간으로 기다린다. */
  static final long CONFIRM_TIMEOUT_MS = 30_000;
  long firstRetryAtMs = -1;
  java.util.function.LongSupplier clock = System::currentTimeMillis;

  private static String norm(String n) {
    return n == null ? "" : n.trim().toLowerCase(Locale.ROOT);
  }

  private static boolean same(String a, String b) {
    return norm(a).equals(norm(b));
  }

  public RollingRouteSession(List<RouteAnchorPlanner.Anchor> anchors) {
    this.all = List.copyOf(anchors);
    visible.addAll(all.subList(0, Math.min(2, all.size())));
    nextUnsent = visible.size();
    if (nextUnsent >= all.size()) {
      state = State.FINISHED;
    }
  }
  public synchronized String description() {
    return "state=" + state + " visible=" + visible.stream().map(a -> a.name).toList()
        + " nextUnsent=" + nextUnsent + "/" + all.size();
  }
  public synchronized boolean isPaused() {
    return state == State.PAUSED;
  }
  public synchronized boolean isUpdating() {
    return state == State.VERIFY_ARRIVAL
        || state == State.WAIT_REPLACE || state == State.WAIT_ADD;
  }
  public synchronized Action onArrival(String name) {
    if (state != State.READY || visible.isEmpty() || nextUnsent >= all.size()) {
      return Action.none();
    }
    if (!same(visible.get(0).name, name)) {
      return pause("Wrong arrived point: " + name);
    }
    transientRetries = 0;
    state = State.VERIFY_ARRIVAL;
    return Action.of(Kind.READ_WAYPOINTS, null, "Verify arrived waypoint against NaviHelper");
  }

  private static boolean contains(List<String> actual, String value) {
    for (String s : actual) {
      if (same(s, value)) {
        return true;
      }
    }
    return false;
  }

  private static boolean matches(List<String> actual, List<RouteAnchorPlanner.Anchor> expected) {
    if (actual.size() != expected.size()) {
      return false;
    }
    for (int i = 0; i < expected.size(); i++) {
      if (!same(actual.get(i), expected.get(i).name)) {
        return false;
      }
    }
    return true;
  }
  public synchronized Action onSnapshot(List<String> actual) {
    if (!isUpdating()) {
      return Action.none();
    }
    if (actual == null || actual.isEmpty()) {
      return retry("Transient empty waypoint snapshot");
    }
    transientRetries = 0;
    if (state == State.WAIT_REPLACE) {
      if (matches(actual, target)) {
        visible.clear();
        visible.addAll(target);
        target = List.of();
        state = nextUnsent < all.size() ? State.READY : State.FINISHED;
        return Action.none();
      }
      if (matches(actual, visible)) {
        return retry("Native replacement still pending");
      }
      return pause("Unexpected waypoint list during native replacement " + actual);
    }
    if (state == State.WAIT_ADD) {
      if (matches(actual, target)) {
        visible.clear();
        visible.addAll(target);
        target = List.of();
        state = nextUnsent < all.size() ? State.READY : State.FINISHED;
        return Action.none();
      }
      if (matches(actual, visible)) {
        return retry("Native addition still pending");
      }
      return pause("Unexpected waypoint list during addition " + actual);
    }
    // 사용자가 경로를 수정했을 수 있어 두 번째 지정 경유지가 남아 있어야 한다.
    for (int i = 1; i < visible.size(); i++) {
      if (!contains(actual, visible.get(i).name)) {
        return pause("User or nav modified the remaining waypoint");
      }
    }
    if (visible.isEmpty()) {
      return pause("Missing active waypoint");
    }
    String departed = visible.get(0).name;
    if (contains(actual, departed)) {
      if (!matches(actual, visible)) {
        return pause("Expected waypoint order changed");
      }
      if (nextUnsent >= all.size()) {
        return Action.none();
      }
      // 최종 목적지는 유지하고 두 경유지는 한 번에 교체한다.
      target = new ArrayList<>(visible.subList(1, visible.size()));
      target.add(all.get(nextUnsent++));
      state = State.WAIT_REPLACE;
      transientRetries = 0;
      return Action.replace(target);
    }
    // 일부 현대 내비 버전은 도착한 경유지를 자동으로 제거한다.
    visible.remove(0);
    if (nextUnsent < all.size()) {
      target = new ArrayList<>(visible);
      RouteAnchorPlanner.Anchor a = all.get(nextUnsent++);
      target.add(a);
      state = State.WAIT_ADD;
      return Action.of(Kind.ADD_SECOND, a, "Native auto-removed arrived point; fill one free slot");
    }
    state = State.FINISHED;
    return Action.none();
  }
  public synchronized Action onChange(String command) {
    if (state == State.WAIT_ADD && "ADD".equals(command)) {
      return Action.of(Kind.READ_WAYPOINTS, null, "Native ADD acknowledged");
    }
    return Action.none();
  }
  public synchronized Action onGuidanceStarted() {
    if (state == State.WAIT_REPLACE) {
      return Action.of(Kind.READ_WAYPOINTS, null, "Native replacement guidance started");
    }
    return Action.none();
  }

  public synchronized String pauseReason() {
    return pauseReason;
  }

  private Action retry(String message) {
    long now = clock.getAsLong();
    if (transientRetries++ == 0) {
      firstRetryAtMs = now;
    }
    if (now - firstRetryAtMs > CONFIRM_TIMEOUT_MS) {
      return pause("Navi did not confirm state in 30 s: " + message);
    }
    return Action.of(Kind.READ_WAYPOINTS, null, message);
  }
  public synchronized Action pause(String why) {
    return pause(why, "경유지 확인 실패");
  }
  /** why는 로그용(영어), shownCause는 화면 상태 줄에 붙는 짧은 한국어 이유. */
  public synchronized Action pause(String why, String shownCause) {
    state = State.PAUSED;
    pauseReason = why.startsWith("경유지 자동 변경") ? why : "경유지 자동 변경을 멈췄어요 · " + shownCause;
    target = List.of();
    return Action.of(Kind.PAUSED, null, why);
  }
  public synchronized void stop() {
    state = State.PAUSED;
    target = List.of();
  }
}
