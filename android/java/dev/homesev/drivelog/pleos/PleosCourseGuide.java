package dev.homesev.drivelog.pleos;

import android.os.*;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.util.*;
import org.json.*;
import ai.pleos.playground.navi.constants.*;
import ai.pleos.playground.navi.data.*;
import ai.pleos.playground.navi.helper.NaviHelper;

final class PleosCourseGuide {
  static final String TAG = "FundriveSmartNavi", FIDELITY_TAG = "FundriveFidelity";
  static final int INITIAL_ANCHORS = 12;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final PleosTripDispatcher dispatcher;
  private final PleosHub hub;
  private final SharedPreferences cache;
  private final PleosProximity proximity;
  private final ProximityPass proximityPass = new ProximityPass();
  private int proximityFirst = -2, proximityGeneration = -2;
  private long lastProgressAt;
  private boolean proximityHeadingKnown;

  void locationPermissionGranted() { proximity.permissionGranted(); }

  private void proximityWindow() {
    RouteAnchorPlanner.Anchor next = session == null ? null : nextUnconfirmedVisible();
    boolean eligible = ownsCourse() && connected && !recordingPaused && nativeRouteStarted
        && session != null && !session.isPaused() && !session.isUpdating() && next != null;
    int first = eligible ? plan.anchors.indexOf(next) : -1;
    if (first == proximityFirst && courseGeneration == proximityGeneration) return;
    proximityFirst = first;
    proximityGeneration = courseGeneration;
    proximityPass.window(courseGeneration, first);
    List<RouteAnchorPlanner.Anchor> window = first < 0 ? List.of()
        : plan.anchors.subList(first, Math.min(first + 2, plan.anchors.size()));
    proximity.window(courseGeneration, first, window);
  }

  private void proximityTransition(int generation, int anchor, boolean enter) {
    if (!ownsCourse() || generation != courseGeneration) return;
    RouteAnchorPlanner.Anchor next = nextUnconfirmedVisible();
    if (next == null || plan.anchors.indexOf(next) != anchor) return;
    boolean eligible = connected && !recordingPaused && nativeRouteStarted && session != null
        && !session.isPaused() && !session.isUpdating() && next != null && progress != null
        && !progress.offCourse() && SystemClock.elapsedRealtime() - lastProgressAt < 3000;
    info("PROXIMITY " + (enter ? "ENTER" : "EXIT") + " anchor=" + anchor);
    if (next != null && progress != null && proximityPass.transition(generation, anchor, enter,
        eligible, progress.arcM(), next.distanceFromStartM, progress.lateralM(),
        proximityHeadingKnown && progress.headingOk())) {
      info("PROXIMITY PASS " + next.name);
      perform(acceptArrival(next.name));
      proximityWindow();
    }
  }
  private String planKey;
  private int confirmedPassed, lastSavedConfirmed;
  private double cachedArcM = Double.NaN, resumeArcM = Double.NaN, lastSavedArcM;
  private long cachedAtWallMs, lastSavedElapsedMs;
  private boolean resuming, resumeWaiting;
  private String resumeFixLog = "none";
  private final Runnable resumeTimeout = () -> finishResume(null);

  static void clearProgress(Context context) {
    context.getSharedPreferences("pleos_course_progress", Context.MODE_PRIVATE)
        .edit()
        .clear()
        .apply();
  }
  private boolean connected, nativeRouteStarted, waypointReadScheduled;
  private volatile boolean destroyed, recordingPaused;
  private long lastRouteRequestAt, lastRouteStartAt;
  private boolean routeRequestQueued;
  private int connectionGeneration;
  private final NativeRouteSignals signals = new NativeRouteSignals();
  private RouteAnchorPlanner.Plan plan;
  private RollingRouteSession session;
  private volatile int courseGeneration = -1;
  private String planLabel;
  private CourseProgress progress;
  private float lastSpeedMps;
  private boolean nativeArrivalSeen;
  private RollingRouteSession.Action deferredRefresh;
  private final Runnable stopCourse = this::revoke;

  PleosCourseGuide(Context context, PleosTripDispatcher dispatcher, PleosHub hub, PleosSdkThread sdk) {
    proximity = new PleosProximity(context, sdk, this::proximityTransition);
    this.hub = hub;
    this.dispatcher = dispatcher;
    cache = context.getSharedPreferences("pleos_course_progress", Context.MODE_PRIVATE);
    CourseOwnership.register(stopCourse);
    dispatcher.attach(this, listener);
  }

  private boolean ownsCourse() {
    return !destroyed && CourseOwnership.current(courseGeneration);
  }

  private void coursePost(Runnable action) {
    final int g = courseGeneration;
    main.post(() -> {
      if (!destroyed && !recordingPaused && CourseOwnership.current(g)) {
        action.run();
      }
    });
  }

  private void nativeCall(java.util.function.Consumer<NaviHelper> action) {
    nativeCall(action, false);
  }

  private void nativeRoute(java.util.function.Consumer<NaviHelper> action) {
    nativeCall(action, true);
  }

  private void nativeCall(java.util.function.Consumer<NaviHelper> action, boolean routeRequest) {
    nativeCall(action, routeRequest, false);
  }

  private void nativeRolling(java.util.function.Consumer<NaviHelper> action) {
    nativeCall(action, true, true);
  }

  private void scheduleConfirmation(NativeRouteSignals.Op token, long delay) {
    if (token == null) {
      return;
    }
    main.postDelayed(() -> {
      if (ownsCourse() && connected && !recordingPaused && session != null
          && !session.isPaused() && signals.claimRead(token, SystemClock.elapsedRealtime())) {
        nativeCall(NaviHelper::getWaypointInfo);
        nativeCall(NaviHelper::getRouteStateInfo);
      }
    }, Math.max(0, delay));
  }

  private void nativeCall(java.util.function.Consumer<NaviHelper> action, boolean routeRequest,
      boolean rolling) {
    final int g = courseGeneration;
    if (routeRequest) {
      routeRequestQueued = true;
    }
    dispatcher.route(g,
        () -> !destroyed && !recordingPaused && CourseOwnership.current(g),
        action,
        at -> {
          if (routeRequest) {
            routeRequestQueued = false;
            lastRouteRequestAt = at;
            signals.clear();
            dispatcher.routeChanging();
            if (rolling) {
              NativeRouteSignals.Op token = signals.issued(connectionGeneration, g, at);
              scheduleConfirmation(token, Math.max(0, at + 11000 - SystemClock.elapsedRealtime()));
            }
          }
        },
        () -> {
          if (ownsCourse() && session != null) {
            routeRequestQueued = false;
            perform(session.pause("native action failed", "현대 내비 요청 실패"));
          }
        });
  }

  private void info(String text) {
    Log.i(TAG, text);
  }

  private void fail(String where, Throwable e) {
    Log.e(TAG, where, e);
  }

  boolean start(String json, boolean resume) {
    revoke();
    if (!resume) {
      cache.edit().clear().apply();
    }
    if (!loadPlan(json)) {
      return false;
    }
    planKey = CourseResume.planKey(plan);
    resuming = resume;
    confirmedPassed = 0;
    resumeFixLog = "none";
    cachedArcM = Double.NaN;
    resumeArcM = Double.NaN;
    lastSavedArcM = 0;
    lastSavedConfirmed = 0;
    lastSavedElapsedMs = SystemClock.elapsedRealtime();
    long wall = System.currentTimeMillis();
    cachedAtWallMs = cache.getLong("savedAtWallMs", 0);
    if (resume && planKey.equals(cache.getString("planKey", null)) && cachedAtWallMs > 0
        && wall >= cachedAtWallMs && wall - cachedAtWallMs <= 6 * 60 * 60 * 1000L) {
      double arc =
          Double.longBitsToDouble(cache.getLong("arcM", Double.doubleToLongBits(Double.NaN)));
      if (Double.isFinite(arc) && arc >= 0 && arc <= plan.totalM) {
        cachedArcM = arc;
        lastSavedArcM = arc;
        confirmedPassed =
            Math.max(0, Math.min(plan.anchors.size(), cache.getInt("confirmedPassed", 0)));
        lastSavedConfirmed = confirmedPassed;
      }
    }
    courseGeneration = CourseOwnership.begin();
    autoStartGuidance = true;
    resumeWaiting = Double.isFinite(cachedArcM);
    if (resumeWaiting) {
      main.postDelayed(resumeTimeout, 15000);
    }
    if (connected && !recordingPaused) {
      startGuidance();
    }
    return resumeWaiting || autoStartGuidance || session != null;
  }

  private void finishResume(android.location.Location fix) {
    if (!ownsCourse() || !resumeWaiting) {
      return;
    }
    double fixArc = Double.NaN;
    boolean onCourse = false;
    if (fix != null && plan.path.size() >= 2) {
      CourseProgress matcher = new CourseProgress(plan);
      double[] window =
          CourseResume.window(cachedArcM, System.currentTimeMillis() - cachedAtWallMs);
      double[] projected = matcher.projectWithin(fix.getLatitude(), fix.getLongitude(), window[0],
          Math.min(plan.totalM, window[1]), fix.hasBearing() ? fix.getBearing() : Double.NaN,
          fix.hasSpeed() ? fix.getSpeed() : 0);
      fixArc = projected[0];
      onCourse = projected[1] <= CourseProgress.ON_COURSE_M;
    }
    resumeFixLog = Double.isFinite(fixArc)
        ? String.format(Locale.US, "%.0f/onCourse=%s", fixArc, onCourse)
        : "none";
    resumeArcM = CourseResume.resumeArc(cachedArcM, fixArc, onCourse);
    resumeWaiting = false;
    main.removeCallbacks(resumeTimeout);
    startGuidance();
  }

  private void saveProgress(boolean force) {
    if (!ownsCourse() || progress == null || progress.offCourse()
        || progress.lateralM() > CourseProgress.ON_COURSE_M) {
      return;
    }
    double arc = Double.isFinite(progress.arcM()) ? progress.arcM() : lastSavedArcM;
    arc = Math.max(lastSavedArcM, arc);
    long now = SystemClock.elapsedRealtime();
    if (!force && confirmedPassed == lastSavedConfirmed
        && (now - lastSavedElapsedMs < 10000 || arc - lastSavedArcM < 100)) {
      return;
    }
    cache.edit()
        .putString("planKey", planKey)
        .putLong("arcM", Double.doubleToLongBits(arc))
        .putInt("confirmedPassed", confirmedPassed)
        .putLong("savedAtWallMs", System.currentTimeMillis())
        .apply();
    lastSavedArcM = arc;
    lastSavedConfirmed = confirmedPassed;
    lastSavedElapsedMs = now;
  }
  private RouteAnchorPlanner.Anchor nextUnconfirmedVisible() {
    if (session != null) {
      for (RouteAnchorPlanner.Anchor a : session.visible) {
        if (plan.anchors.indexOf(a) >= confirmedPassed) {
          return a;
        }
      }
    }
    return null;
  }
  private RollingRouteSession.Action acceptArrival(String name) {
    RouteAnchorPlanner.Anchor first = nextUnconfirmedVisible();
    RollingRouteSession.Action action = session.onArrival(name);
    if (first != null && name != null && first.name.equalsIgnoreCase(name.trim())
        && (action.kind == RollingRouteSession.Kind.READ_WAYPOINTS
            || session.state == RollingRouteSession.State.FINISHED)) {
      int next = plan.anchors.indexOf(first) + 1;
      if (next > confirmedPassed) {
        confirmedPassed = next;
        saveProgress(true);
      }
    }
    proximityWindow();
    return action;
  }



  void pause(boolean value) {
    recordingPaused = value;
    proximityWindow();
    if (!value && ownsCourse() && connected) {
      NativeRouteSignals.Op token = signals.current();
      if (token != null) {
        scheduleConfirmation(token, Math.max(0, token.issuedAt + 11000 - SystemClock.elapsedRealtime()));
      }
      if (autoStartGuidance) {
        startGuidance();
      } else if (session != null) {
        if (deferredRefresh != null) {
          RollingRouteSession.Action pending = deferredRefresh;
          deferredRefresh = null;
          perform(pending);
        }
        nativeCall(NaviHelper::getWaypointInfo);
      }
    }
  }

  void revoke() {
    proximityFirst = -2;
    proximity.window(-1, -1, List.of());
    proximityPass.window(-1, -1);
    signals.clear();
    hub.courseStatus(false, "");
    routeRequestQueued = false;
    main.removeCallbacksAndMessages(null);
    if (session != null) {
      session.stop();
    }
    session = null;
    progress = null;
    deferredRefresh = null;
    autoStartGuidance = false;
    nativeRouteStarted = false;
    waypointReadScheduled = false;
    courseGeneration = -1;
    resumeWaiting = false;
    resuming = false;
    resumeArcM = Double.NaN;
  }

  void close() {
    revoke();
    destroyed = true;
    proximity.close();
    CourseOwnership.unregister(stopCourse);
    dispatcher.detach(this, listener);
  }
  private final PleosTripDispatcher.Observer listener = new PleosTripDispatcher.Observer() {
    public void connection(boolean value) {
      if (connected != value) {
        connectionGeneration++;
        signals.clear();
        routeRequestQueued = false;
      }
      connected = value;
      proximityWindow();
      if (value && autoStartGuidance && ownsCourse() && !recordingPaused) {
        startGuidance();
      }
    }
    @Override
    public void routingHint(String name, long at) {
      final int g = courseGeneration, connection = connectionGeneration;
      coursePost(() -> {
        if (session != null && session.isUpdating() && !routeRequestQueued
            && signals.hint(connection, g, at)) {
          scheduleConfirmation(signals.current(),
              Math.max(0, at + 800 - SystemClock.elapsedRealtime()));
        }
      });
    }
    @Override
    public void navigationStatus(NavigationStatus status, long at) {
      coursePost(() -> {
        String value = String.valueOf(status);
        if (signals.status(value, at) && NativeRouteSignals.stopped(value)) {
          signals.pendingStatus("navigationStatus " + value, at, lastRouteRequestAt,
              routeRequestQueued, session != null && session.isUpdating());
        }
      });
    }
    @Override
    public void routeState(RouteStateInfo state, long at) {
      coursePost(() -> {
        String mode = state == null ? null : String.valueOf(state.getNaviMode());
        String pending = signals.routeState(mode, at,
            signals.guarded(SystemClock.elapsedRealtime(), lastRouteRequestAt, routeRequestQueued,
                session != null && session.isUpdating()));
        if (pending != null) {
          verifyPotentialRouteStop(pending);
        }
      });
    }
    @Override
    public void onRouteStarted(RouteStartInfo i) {
      final int g = courseGeneration;
      main.post(() -> {
        if (!ownsCourse() || !CourseOwnership.current(g)) {
          return;
        }
        nativeRouteStarted = true;
        nativeArrivalSeen = false;
        lastRouteStartAt = SystemClock.elapsedRealtime();
        if (session != null && !recordingPaused) {
          perform(session.onGuidanceStarted());
        }
      });
    }
    @Override
    public void onRouteEnded() {
      coursePost(() -> verifyPotentialRouteStop("ENDED"));
    }
    @Override
    public void onRouteCancelled() {
      coursePost(() -> verifyPotentialRouteStop("CANCELLED"));
    }
    @Override
    public void onDestinationArrived(DestinationArrivedInfo i) {
      coursePost(() -> {
        cache.edit().clear().apply();
        revoke();
      });
    }
    @Override
    public void onWayPointArrived(WaypointArrivedInfo i) {
      coursePost(() -> {
        nativeArrivalSeen = true;
        if (session != null && nativeRouteStarted && i.getIndex() == WaypointIndex.FIRST) {
          perform(acceptArrival(i.getName()));
        }
      });
    }
    @Override
    public void onWaypointChanged(WaypointChangedInfo i) {
      coursePost(() -> {
        if (session == null) {
          return;
        }
        if ("REMOVE".equals(i.getCmdType().name()) && i.getIndex() == WaypointIndex.FIRST
            && nativeRouteStarted && !session.isUpdating() && !session.isPaused()
            && !session.visible.isEmpty()
            && (progress == null || Double.isNaN(progress.arcM())
                || progress.arcM() >= session.visible.get(0).distanceFromStartM - 200)) {
          // 같은 경유지의 도착 처리 뒤에 삭제 이벤트가 올 수 있다.
          perform(acceptArrival(session.visible.get(0).name));
          return;
        }
        perform(session.onChange(i.getCmdType().name()));
      });
    }
    @Override
    public void onWayPointInfo(List<WaypointInfo> data) {
      List<String> names = new ArrayList<>();
      if (data != null) {
        for (WaypointInfo i : data) {
          if (i != null) {
            names.add(i.getName());
          }
        }
      }
      coursePost(() -> {
        if (session != null && deferredRefresh == null) {
          RollingRouteSession.Action action = session.onSnapshot(names);
          perform(action);
        }
      });
    }
    @Override
    public void onDestinationInfo(DestinationInfo i) {
      coursePost(() -> {
        if (session == null || plan == null || i.getLatitude() == 0 && i.getLongitude() == 0) {
          return;
        }
        double meters = RouteAnchorPlanner.distanceM(
            new RouteAnchorPlanner.Point(i.getLatitude(), i.getLongitude()), plan.destination);
        if (meters > 300) {
          perform(session.pause("Native destination differs by " + Math.round(meters) + "m", "목적지 달라짐"));
        }
      });
    }
    @Override
    public void onError(NaviErrorCode e) {
      coursePost(() -> {
        if (session != null) {
          perform(session.pause("Native API error " + e, "현대 내비 오류"));
        }
      });
    }
  };

  void verifyPotentialRouteStop(String reason) {
    if (!ownsCourse() || recordingPaused) {
      return;
    }
    final int g = courseGeneration;
    long now = android.os.SystemClock.elapsedRealtime();
    // 경로 교체 시 이전 경로 콜백과 새 시작 이벤트가 경합할 수 있다.
    if (signals.guarded(now, lastRouteRequestAt, routeRequestQueued,
        session != null && session.isUpdating())) {
      signals.pending(reason);
      info("NAVI " + reason + " during initial route/waypoint recompute; waiting for final state");
      main.postDelayed(() -> {
        if (CourseOwnership.current(g) && !recordingPaused && connected && session != null) {
          nativeCall(NaviHelper::getRouteStateInfo);
        }
      }, 4500);
      return;
    }
    signals.clear();
    nativeRouteStarted = false;
    if (session != null) {
      perform(session.pause("Native guidance stopped", "현대 내비 안내 중단"));
    }
    info("NAVI " + reason + ": auto waypoint rolling stopped");
  }

  void startGuidance() {
    if (!ownsCourse() || recordingPaused || !connected || plan == null || resumeWaiting) {
      return;
    }
    autoStartGuidance = false;
    try {
      List<RouteAnchorPlanner.Anchor> remaining = resuming
          ? CourseResume.remaining(
                plan, Double.isFinite(resumeArcM) ? resumeArcM : 0, confirmedPassed)
          : plan.anchors;
      if (resuming) {
        info(String.format(Locale.US, "RESUME arc=%.0f cached=%.0f fix=%s skipped=%d",
            Double.isFinite(resumeArcM) ? resumeArcM : 0, cachedArcM, resumeFixLog,
            plan.anchors.size() - remaining.size()));
      }
      session = new RollingRouteSession(remaining);
      session.clock = SystemClock::elapsedRealtime;
      deferredRefresh = null;
      nativeRouteStarted = false;
      try {
        progress = new CourseProgress(plan);
        if (Double.isFinite(resumeArcM)) {
          progress.seed(resumeArcM, cachedAtWallMs);
        }
      } catch (IllegalArgumentException e) {
        progress = null;
      }
      lastRouteRequestAt = android.os.SystemClock.elapsedRealtime();
      RouteInfo dest = new RouteInfo(plan.destination.lat, plan.destination.lng, null, null,
          planLabel + " 도착", "", "", "0", RouteOption.RECOMMENDED, "", false);
      ArrayList<RequestWaypointInfo> points = new ArrayList<>();
      List<RouteAnchorPlanner.Anchor> init =
          resuming ? remaining.subList(0, Math.min(2, remaining.size())) : plan.initial();
      if (init.size() > 0) {
        points.add(via(init.get(0), WaypointIndex.FIRST));
      }
      if (init.size() > 1) {
        points.add(via(init.get(1), WaypointIndex.SECOND));
      }
      info("SENDING FINAL DESTINATION + " + points.size() + " initial anchors "
          + init.stream().map(a -> a.name).toList());
      if (points.size() == 0) {
        nativeRoute(navi -> navi.requestRoute(dest));
      } else {
        nativeRoute(
            navi -> navi.requestRouteWithWaypoints(new RouteWithWaypointsRequest(dest, points)));
      }
      info("Initial route requested. Waiting for native onRouteStarted.");
    } catch (Throwable t) {
      fail("startGuidance", t);
      session = null;
      signals.clear();
    }
  }

  RequestWaypointInfo via(RouteAnchorPlanner.Anchor a, WaypointIndex index) {
    return new RequestWaypointInfo(a.point.lat, a.point.lng, a.name, index, "", "", "0", "");
  }

  private void syncOperation() {
    if (session != null) {
      hub.courseStatus(session.isPaused(), session.isPaused() ? session.pauseReason() : "");
      signals.sessionState(session.state == RollingRouteSession.State.WAIT_REPLACE
              || session.state == RollingRouteSession.State.WAIT_ADD,
          session.isPaused(), SystemClock.elapsedRealtime());
    }
  }

  void perform(RollingRouteSession.Action action) {
    if (!ownsCourse() || action == null || session == null) {
      return;
    }
    syncOperation();
    proximityWindow();
    if (recordingPaused || !connected) {
      deferredRefresh = action;
      return;
    }
    final int g = courseGeneration;
    if (action.kind != RollingRouteSession.Kind.NONE) {
      info("ROLLER " + action.kind + ": " + action.message);
    }
    try {
      switch (action.kind) {
        case READ_WAYPOINTS:
          if (!waypointReadScheduled) {
            waypointReadScheduled = true;
            main.postDelayed(() -> {
              waypointReadScheduled = false;
              if (CourseOwnership.current(g) && !recordingPaused && session != null && connected
                  && !session.isPaused()) {
                nativeCall(NaviHelper::getWaypointInfo);
              }
            }, 1800);
          }
          break;
        case REPLACE_TWO:
          if (action.waypoints.isEmpty() || action.waypoints.size() > 2) {
            throw new IllegalStateException("Invalid replacement window");
          }
          if (progress != null && !Double.isNaN(progress.arcM())
              && !progress.refreshAllowed(lastSpeedMps)) {
            deferredRefresh = action;
            info(String.format(Locale.US,
                "REFRESH DEFERRED: next course turn in %.0f m < %.0f m needed for ~7 s re-route",
                progress.nextTurnAheadM(), CourseProgress.refreshNeedM(lastSpeedMps)));
            break;
          }
          deferredRefresh = null;
          RouteInfo sameDest = new RouteInfo(plan.destination.lat, plan.destination.lng, null, null,
              planLabel + " 도착", "", "", "0", RouteOption.RECOMMENDED, "", false);
          ArrayList<RequestWaypointInfo> nextWindow = new ArrayList<>();
          for (int i = 0; i < action.waypoints.size(); i++) {
            nextWindow.add(
                via(action.waypoints.get(i), i == 0 ? WaypointIndex.FIRST : WaypointIndex.SECOND));
          }
          lastRouteRequestAt = android.os.SystemClock.elapsedRealtime();
          info("ATOMIC REFRESH final destination unchanged; via="
              + action.waypoints.stream().map(a -> a.name).toList());
          nativeRolling(navi -> navi.requestRouteWithWaypoints(
              new RouteWithWaypointsRequest(sameDest, nextWindow)));
          break;
        case ADD_SECOND:
          // 경유지 추가도 재탐색에 11~15초가 걸려 같은 회전 구간 보호를 적용한다.
          if (progress != null && !Double.isNaN(progress.arcM())
              && !progress.refreshAllowed(lastSpeedMps)) {
            deferredRefresh = action;
            info(String.format(Locale.US,
                "REFRESH DEFERRED (add): next course turn in %.0f m < %.0f m needed for re-route",
                progress.nextTurnAheadM(), CourseProgress.refreshNeedM(lastSpeedMps)));
            break;
          }
          deferredRefresh = null;
          RequestWaypointInfo added = via(action.point, WaypointIndex.SECOND);
          nativeRolling(navi -> navi.addWaypoint(added));
          break;
        case PAUSED:
          info("AUTOMATIC CHANGES PAUSED: " + action.message);
          break;
        default:
          break;
      }
    } catch (Throwable t) {
      fail("roller action", t);
      perform(session.pause("native action failed", "현대 내비 요청 실패"));
    }
  }

  boolean loadPlan(String raw) {
    try {
      JSONObject src = new JSONObject(raw);
      String label = src.optString("label", "Gubi 코스");
      String encoded = src.getString("path");
      JSONArray vias = src.optJSONArray("vias");
      List<RouteAnchorPlanner.Via> requested = new ArrayList<>();
      if (vias != null) {
        for (int i = 0; i < vias.length(); i++) {
          JSONObject v = vias.getJSONObject(i);
          requested.add(new RouteAnchorPlanner.Via(
              v.optString("name", "방문 지점"), v.getDouble("lat"), v.getDouble("lng")));
        }
      }
      RouteAnchorPlanner.Plan next =
          RouteAnchorPlanner.plan(RouteAnchorPlanner.decode(encoded), requested, INITIAL_ANCHORS);
      plan = next;
      planLabel = label;
      info("코스: " + planLabel + " (" + Math.round(plan.totalM / 1000.0 * 10) / 10.0 + " km)");
      info("경로에서 선정한 통과 지점: " + plan.anchors.size()
          + "개 (교차로 150m 밖 직선 구간 우선)");
      for (RouteAnchorPlanner.Anchor a : plan.anchors) {
        info("  " + a);
      }
      if (plan.skippedNamedVias > 0) {
        info("WARNING: path에서 찾지 못한 방문지 " + plan.skippedNamedVias
            + "개. 안내 시작 전 확인 필요.");
      }
      if (plan.capReached) {
        info("NOTE: 초기 경유지 " + INITIAL_ANCHORS
            + "개 한도. '경로 일치 검사'로 어긋난 구간만 보강하세요.");
      }
      info("주의: 순정 내비는 경유지 사이 길을 스스로 계산함. 일치 여부는 검사 결과로만 판단");
      Log.i(FIDELITY_TAG,
          "PLAN label=" + planLabel + " km=" + String.format(Locale.US, "%.1f", plan.totalM / 1000)
              + " anchors=" + plan.anchors.size());
      return true;
    } catch (Exception e) {
      fail("INVALID DrivePlanHandoff", e);
      return false;
    }
  }
  private boolean autoStartGuidance = false;





  void onFix(android.location.Location l) {
    if (resumeWaiting && ownsCourse() && connected && !recordingPaused) {
      finishResume(l);
      return;
    }
    if (!ownsCourse() || !connected || recordingPaused || progress == null || session == null) {
      return;
    }
    boolean wasOff = progress.offCourse();
    progress.update(l.getLatitude(), l.getLongitude(), l.hasBearing() ? l.getBearing() : Double.NaN,
        l.hasSpeed() ? l.getSpeed() : 0);
    lastProgressAt = SystemClock.elapsedRealtime();
    proximityHeadingKnown = l.hasBearing() && l.hasSpeed() && l.getSpeed() >= CourseProgress.HEADING_MIN_SPEED_MPS;
    proximityWindow();
    lastSpeedMps = l.hasSpeed() ? l.getSpeed() : lastSpeedMps;
    Log.i(FIDELITY_TAG,
        String.format(Locale.US, "FIX %.6f,%.6f arc=%.0f lateral=%.0f off=%s nextTurn=%.0f",
            l.getLatitude(), l.getLongitude(), progress.arcM(), progress.lateralM(),
            progress.offCourse(), progress.nextTurnAheadM()));
    if (!wasOff && progress.offCourse()) {
      info("코스 이탈 감지 (" + Math.round(progress.lateralM())
          + "m): 순정 내비가 다음 경유지로 재안내함, 자동 교체 보류");
    }
    if (progress.offCourse()) {
      return;
    }
    saveProgress(false);
    if (deferredRefresh != null && progress.refreshAllowed(lastSpeedMps)) {
      RollingRouteSession.Action a = deferredRefresh;
      deferredRefresh = null;
      info("REFRESH RESUMED after course turn");
      perform(a);
      return;
    }
    RouteAnchorPlanner.Anchor next = nextUnconfirmedVisible();
    if (nativeRouteStarted && !session.isPaused() && !session.isUpdating() && next != null
        && progress.passed(next)) {
      String name = next.name;
      RollingRouteSession.Action a = acceptArrival(name);
      if (a.kind != RollingRouteSession.Kind.NONE) {
        info("LOCATION PASS " + name
            + (nativeArrivalSeen ? "" : " (순정 도착 이벤트 없이 위치로 판정)"));
      }
      perform(a);
    }
  }
}
