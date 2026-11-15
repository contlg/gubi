package dev.homesev.drivelog.pleos;

import android.content.Context;
import android.os.*;
import android.location.Location;
import ai.pleos.playground.navi.data.*;
import java.util.*;
import ai.pleos.playground.navi.constants.NavigationStatus;
import dev.homesev.drivelog.BuildConfig;
import dev.homesev.drivelog.FundriveDiag;

public final class PleosHub {
  public static final String NAV_PACKAGE = "ai.umos.maps.android.navigation.app";
  public interface Listener {
    void event(String type, String json);
  }
  private static PleosHub instance;
  public static synchronized PleosHub get(Context context) {
    if (instance == null) {
      instance = new PleosHub(context.getApplicationContext());
    }
    return instance;
  }
  private final Context context;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Set<String> clients = new HashSet<>();
  private final Set<Listener> listeners = new LinkedHashSet<>();
  private final PleosFeedModel model = new PleosFeedModel();
  private final TbtNext turns = BuildConfig.NATIVE_TBT_ENABLED ? new TbtNext() : null;
  private final NativeRoutingState routing = new NativeRoutingState();
  private String lastTbtReason = "", lastTbtContent = "";
  private long tbtRouteAt = -1;
  private PleosSdkThread sdk;

  private void resetTurns() {
    resetTurns(false);
  }

  private void resetTurns(boolean newRoute) {
    resetTurns(newRoute, now());
  }

  private void resetTurns(boolean newRoute, long at) {
    if (!BuildConfig.NATIVE_TBT_ENABLED) {
      return;
    }
    tbtRouteAt = at;
    if (newRoute) {
      routing.reset();
      turns.routeChanging(at);
    } else {
      turns.reset(false);
    }
    lastTbtContent = "";
    model.tbt(List.of(), now());
  }

  private void updateTurns() {
    if (!BuildConfig.NATIVE_TBT_ENABLED) {
      return;
    }
    if (!routing.eligible(recording && !paused,
        dispatcher != null && dispatcher.connected(), now())) {
      model.tbt(List.of(), now());
      return;
    }
    TbtNext.Selection selected = turns.selection(now());
    String reason = selected.reason;
    if (!reason.equals(lastTbtReason)) {
      if (!reason.isEmpty()) {
        PleosTripDispatcher.event("TBT hidden " + reason, now());
      }
      lastTbtReason = reason;
    }
    String content = PleosFeedModel.json(selected.items);
    if (!content.equals(lastTbtContent)) {
      if (!selected.items.isEmpty()) {
        PleosTripDispatcher.event("TBT selected " + content, now());
      }
      lastTbtContent = content;
    }
    model.tbt(selected.items, now());
  }
  private VehicleTrace trace;
  private long traceStoppedAt = -1;
  public void gForceOpen(boolean open) {
    assertMain();
    gForceOpen = open;
    if (open) acquire("gforce"); else release("gforce");
    if (vehicle != null) vehicle.dynamics(recording || open);
  }
  public void startVehicleTrace() {
    assertMain();
    trace = new VehicleTrace(now());
    traceStoppedAt = -1;
  }
  private void vehicleSample(String key, Object value, long at) {
    if (recording && trace != null) trace.sample(key, value, at);
  }
  public String vehicleTrace() {
    assertMain();
    return trace == null ? "{}" : PleosFeedModel.json(trace.snapshot(traceStoppedAt >= 0 ? traceStoppedAt : now()), 200000);
  }
  private PleosTripDispatcher dispatcher;
  private PleosVehicleFeed vehicle;
  private PleosLocationFeed location;
  private boolean locationPermissionReady;
  private PleosCourseGuide guide;
  private final ChargerOperators chargerOperators = new ChargerOperators();

  public String chargerOperators() {
    return chargerOperators.json();
  }

  void courseStatus(boolean paused, String reason) {
    model.coursePaused = paused;
    model.coursePauseReason = reason;
  }

  private volatile String support;
  private boolean running, verifyOnly, recording, paused, gForceOpen;
  private final LocalGuidanceWatch localWatch = new LocalGuidanceWatch();
  private String recordingId, cancelRecordingId;
  private long lastFused = -1;
  private final ConnectionRetry vehicleRetry = new ConnectionRetry();
  private CancelConfirmation cancellation;
  private volatile String cancelId;
  private boolean cancelQueued;
  private long cancelDeadline;
  /** 순정 내비가 마지막으로 알려 준 안내 상태와 받은 시각(단조 시각). */
  private String lastRouteMode;
  private long lastRouteAt = -1;
  private int cancelGeneration, pendingTrips;
  private final Set<String> requestIds = new HashSet<>();

  private static long now() {
    return SystemClock.elapsedRealtime();
  }

  private PleosHub(Context context) {
    this.context = context;
    // SDK에 지원 여부 조회가 없어 패키지 부재로 미지원 기기를 판별한다.
    support = context.getPackageManager().getLaunchIntentForPackage(NAV_PACKAGE) == null
        ? "unsupported"
        : "connecting";
    FundriveDiag.log("support initial=" + support + " reason=native-package-presence");
    CourseOwnership.monotonicClock(SystemClock::elapsedRealtimeNanos);
    CourseOwnership.mainThreadRunner(action -> {
      assertMain();
      action.run();
    });
  }

  private static void assertMain() {
    if (Looper.myLooper() != Looper.getMainLooper()) {
      throw new IllegalStateException("main thread required");
    }
  }

  public String support() {
    return support;
  }

  public boolean available() {
    return "connected".equals(support);
  }

  public void listen(Listener listener) {
    assertMain();
    listeners.add(listener);
    listener.event("availability", Boolean.toString(available()));
  }

  public void unlisten(Listener listener) {
    assertMain();
    listeners.remove(listener);
  }

  private void emit(String type, String json) {
    for (Listener l : new ArrayList<>(listeners)) {
      l.event(type, json);
    }
  }

  private void updateSupport(String next) { updateSupport(next, "hub-start"); }

  private void updateSupport(String next, String reason) {
    if ("unsupported".equals(support)) {
      return;
    }
    if (!support.equals(next)) {
      FundriveDiag.log("support " + support + " -> " + next + " reason=" + reason + " owners=" + new TreeSet<>(clients));
      support = next;
      emit("availability", Boolean.toString(available()));
    }
  }

  public void acquire(String client) {
    assertMain();
    boolean changed = clients.add(client);
    FundriveDiag.log("hub acquire owner=" + client + " changed=" + changed + " owners=" + new TreeSet<>(clients) + " running=" + running);
    start();
  }

  public void release(String client) {
    assertMain();
    boolean changed = clients.remove(client);
    FundriveDiag.log("hub release owner=" + client + " changed=" + changed + " owners=" + new TreeSet<>(clients) + " running=" + running);
    maybeStop();
  }

  public void recording(String id) {
    assertMain();
    CourseOwnership.revokeAll();
    localWatch.reset();
    if (cancellation != null) {
      finishCancel(false, "superseded");
    }
    recording = true;
    // 녹화 시작/종료는 현대 내비 경로의 거리 원점을 바꾸지 않는다.
    paused = false;
    recordingId = id;
    acquire("recording");
    if (vehicle != null) vehicle.dynamics(true);
    if (dispatcher != null) {
      dispatcher.recording(true);
    }
  }

  public void endRecording() {
    assertMain();
    if (recording) traceStoppedAt = now();
    recording = false;
    if (vehicle != null) vehicle.dynamics(gForceOpen);
    if (BuildConfig.NATIVE_TBT_ENABLED) {
      model.tbt(List.of(), now());
    }
    if (dispatcher != null) {
      dispatcher.recording(false);
    }
    paused = false;
    recordingId = null;
    localWatch.reset();
    CourseOwnership.revokeAll();
    if (cancellation != null) {
      finishCancel(false, "recording_stopped");
    }
    release("recording");
  }

  public void pause(boolean value) {
    assertMain();
    paused = value;
    if (dispatcher != null) {
      dispatcher.recording(recording && !paused);
    }
    if (paused) {
      model.tbt(List.of(), now());
    }
    if (guide != null) {
      guide.pause(value);
    }
  }

  public boolean localAudioAllowed() {
    assertMain();
    return "unsupported".equals(support)
        || recording && localWatch.allowed() && dispatcher != null && dispatcher.connected();
  }

  private void nativeActive(String reason) {
    if (reason == null) {
      return;
    }
    emit("nativeActive", PleosFeedModel.json(PleosFeedModel.object("reason", reason)));
  }

  public boolean startCourse(String json) {
    assertMain();
    if (paused) {
      return false;
    }
    return course(json, false);
  }

  public void clearCourseProgress() {
    assertMain();
    PleosCourseGuide.clearProgress(context);
  }

  public boolean resumeCourse(String json) {
    return course(json, true);
  }

  private boolean course(String json, boolean resume) {
    assertMain();
    if (!recording || !("connected".equals(support) || "connecting".equals(support))) {
      return false;
    }
    localWatch.reset();
    if (guide == null) {
      guide = new PleosCourseGuide(context, dispatcher, this, sdk);
    }
    guide.pause(paused);
    return guide.start(json, resume);
  }



  public void fallbackFix(Location fix) {
    assertMain();
    if (guide != null && lastFused >= 0 && now() - lastFused < 3000) {
      return;
    }
    if (guide != null) {
      guide.onFix(fix);
    }
  }

  private void fusedFix(String json) {
    emit("location", json);
    try {
      org.json.JSONObject data = new org.json.JSONObject(json);
      if (Math.abs(System.currentTimeMillis() - data.getLong("tsMs")) >= 3000) {
        return;
      }
      lastFused = now();
      if (guide == null) {
        return;
      }
      Location fix = new Location("pleos");
      fix.setLatitude(data.getDouble("lat"));
      fix.setLongitude(data.getDouble("lng"));
      if (data.has("heading")) {
        fix.setBearing((float) data.getDouble("heading"));
      }
      if (data.has("speedMps") && data.optLong("speedAgeMs", Long.MAX_VALUE) < 2000) {
        fix.setSpeed((float) Math.abs(data.getDouble("speedMps")));
      }
      guide.onFix(fix);
    } catch (org.json.JSONException e) {
      android.util.Log.w("PleosHub", "Invalid fused fix", e);
    }
  }

  private void start() {
    if (running || "unsupported".equals(support)) {
      return;
    }
    running = true;
    vehicleRetry.healthy();
    FundriveDiag.log("hub start owners=" + new TreeSet<>(clients));
    sdk = new PleosSdkThread(main);
    vehicle = new PleosVehicleFeed(context, sdk, model, this::vehicleSample, recording || gForceOpen);
    dispatcher = new PleosTripDispatcher(context, sdk);
    dispatcher.attach(this, observer);
    if (!dispatcher.connected()) {
      updateSupport("connecting");
    }
    locationPermissionReady = context.checkSelfPermission("pleos.car.permission.FUSED_LOCATION")
        == android.content.pm.PackageManager.PERMISSION_GRANTED;
    location = new PleosLocationFeed(context, sdk, this::fusedFix);
    main.post(tick);
    main.post(cancelTick);
  }

  public void locationPermissionGranted() {
    assertMain();
    if (!running || locationPermissionReady || context.checkSelfPermission(
        "pleos.car.permission.FUSED_LOCATION") != android.content.pm.PackageManager.PERMISSION_GRANTED) return;
    locationPermissionReady = true;
    if (location != null) location.close();
    location = new PleosLocationFeed(context, sdk, this::fusedFix);
    if (guide != null) guide.locationPermissionGranted();
  }

  private void maybeStop() {
    if (!running || !clients.isEmpty() || pendingTrips != 0 || cancellation != null) {
      return;
    }
    running = false;
    FundriveDiag.log("hub stop owners-empty pendingTrips=" + pendingTrips);
    main.removeCallbacks(tick);
    main.removeCallbacks(cancelTick);
    if (guide != null) {
      guide.close();
      guide = null;
    }
    if (vehicle != null) {
      vehicle.close();
    }
    vehicle = null;
    if (location != null) {
      location.close();
    }
    location = null;
    dispatcher.detach(this, observer);
    dispatcher.shutdown();
    sdk.close();
    sdk = null;
    model.disconnected();
    updateSupport("disconnected", "last-owner-released");
  }

  public void cancel(String id, boolean verify) {
    assertMain();
    start();
    if (cancellation != null) {
      finishCancel(false, "superseded");
    }
    localWatch.reset();
    verifyOnly = verify;
    cancelId = id;
    cancelRecordingId = recordingId;
    cancellation = new CancelConfirmation(now());
    cancelQueued = false;
    cancelDeadline = now() + 20000;
    cancelGeneration = CourseOwnership.revokeAll();
    cancellation.connection(dispatcher != null && dispatcher.connected());
    if (!recording || "unsupported".equals(support)) {
      cancellation.fail("unavailable");
    }
    pumpCancel();
  }

  private void finishCancel(boolean ok, String reason) {
    if (cancelId == null) {
      return;
    }
    if (ok
        && (!CourseOwnership.current(cancelGeneration) || !recording
            || !Objects.equals(recordingId, cancelRecordingId))) {
      ok = false;
      reason = "superseded";
    }
    String id = cancelId;
    cancellation = null;
    cancelId = null;
    cancelQueued = false;
    if (ok) {
      localWatch.verified();
    }
    android.util.Log.i("PleosHub", "CANCEL requestId=" + id + " ok=" + ok + " reason=" + reason);
    emit("cancel",
        PleosFeedModel.json(PleosFeedModel.object("requestId", id, "ok", ok, "reason", reason)));
    maybeStop();
  }

  /** 순정 내비가 방금(1.5초 안) "안내 없음"이라고 알려 왔는가. 모르면 false. */
  private boolean routeKnownInactive() {
    return lastRouteMode != null && lastRouteAt >= 0 && now() - lastRouteAt <= 1500
        && ("SAFE_GUIDING".equals(lastRouteMode) || "NOT_WORKING".equals(lastRouteMode));
  }

  private void pumpCancel() {
    if (cancellation == null) {
      return;
    }
    Boolean done = cancellation.check(now(), CourseOwnership.current(cancelGeneration));
    if (done != null) {
      finishCancel(done, cancellation.reason());
      return;
    }
    if (cancellation.canCall() && !cancelQueued) {
      if (!CourseOwnership.current(cancelGeneration)) {
        finishCancel(false, "superseded");
        return;
      }
      // 순정 내비에 안내가 없는데 cancelRoute를 보내면 순정 내비가 실패(NOT_CANCEL_ABLE_TRIP)한 뒤
      // "취소 중" 상태에 갇혀, 운전자의 "안내 종료"까지 먹지 않는다(에뮬레이터 v2.1.0에서 재현).
      // 그래서 최근(1.5초 안) 받은 상태가 "안내 없음"이면 요청을 보내지 않고 확인만 한다.
      if (verifyOnly || routeKnownInactive()) {
        if (!verifyOnly) {
          android.util.Log.i("PleosHub", "CANCEL skip call: native route already inactive mode=" + lastRouteMode);
        }
        cancellation.called(now());
        return;
      }
      cancelQueued = true;
      final String id = cancelId;
      final long deadline = cancelDeadline;
      dispatcher.cancelRoute(cancelGeneration,
          () -> id.equals(cancelId) && now() < deadline,
          () -> {
            if (id.equals(cancelId) && cancellation != null) {
              cancelQueued = false;
              cancellation.called(now());
              pumpCancel();
            }
          },
          () -> {
            if (id.equals(cancelId)) {
              finishCancel(false, "exception");
            }
          });
    }
  }

  public void trip(String id, double lat, double lng, String label) {
    assertMain();
    start();
    if (dispatcher == null || !PleosFeedModel.coordinate(lat, lng)
        || !PleosFeedModel.text(label, 120)) {
      tripError(id, "invalid_request");
      return;
    }
    if (requestIds.contains(id)) {
      tripError(id, "duplicate_request");
      return;
    }
    if (requestIds.size() >= 512 || pendingTrips >= 16) {
      tripError(id, "busy");
      return;
    }
    requestIds.add(id);
    pendingTrips++;
    dispatcher.submit(this, id, lat, lng, (trip, error) -> {
      pendingTrips--;
      if (error != null) {
        tripError(id, error);
      } else {
        Double distance = PleosFeedModel.number(trip.getDistance(), 0, 1e8),
               eta = PleosFeedModel.number(trip.getEta(), 0, 1e8),
               energy = PleosFeedModel.number(trip.getEnergyConsumption(), 0, 1e9),
               soc = PleosFeedModel.number(trip.getEstimatedSocAtDest(), 0, 100);
        if (distance == null || eta == null || energy == null || soc == null) {
          tripError(id, "invalid_result");
        } else {
          emit("trip",
              PleosFeedModel.json(PleosFeedModel.object("requestId", id, "distanceM", distance,
                  "etaS", eta, "energyWh", energy, "socAtDestPct", soc, "traffic", tripTraffic(trip))));
        }
      }
      maybeStop();
    });
  }

  private void tripError(String id, String error) {
    emit("trip", PleosFeedModel.json(PleosFeedModel.object("requestId", id, "error", error)));
  }
  private final Runnable cancelTick = new Runnable() {
    public void run() {
      if (!running) {
        return;
      }
      pumpCancel();
      main.postDelayed(this, 50);
    }
  };
  private final Runnable tick = new Runnable() {
    public void run() {
      if (!running) {
        return;
      }
      if (vehicle != null && vehicle.initializationDone && !vehicle.initialized) {
        if (!vehicle.retryScheduled) {
          vehicle.retryScheduled = true;
          vehicleRetry.failed(now());
          vehicle.close();
          updateSupport("connecting", "vehicle-connection-failure");
        } else if (vehicleRetry.ready(now())) {
          vehicle = new PleosVehicleFeed(context, sdk, model, PleosHub.this::vehicleSample, recording || gForceOpen);
        }
      } else if (vehicle != null && vehicle.connectionConfirmed) {
        vehicleRetry.healthy();
      }
      if (dispatcher.connected()) {
        updateSupport(vehicle != null && vehicle.initialized ? "connected" : "connecting", "sdk-health-tick");
      }
      updateTurns();
      emit("feed", model.feed(System.currentTimeMillis(), now()));
      main.postDelayed(this, 1000);
    }
  };
  private final PleosTripDispatcher.Observer observer = new PleosTripDispatcher.Observer() {
    public void connecting() {
      updateSupport("connecting", "navi-initialize");
    }
    public void connection(boolean connected) {
      if (!connected) {
        nativeActive(localWatch.disconnect());
        routing.reset();
        resetTurns();
      }
      updateSupport(connected
              ? (vehicle != null && vehicle.initialized ? "connected" : "connecting")
              : "disconnected", connected ? "navi-connected" : "navi-disconnected");
      if (cancellation != null) {
        cancellation.connection(connected);
        pumpCancel();
      }
      if (connected) {
        model.naviConnected = true;
      } else {
        model.disconnected();
        if (running) {
          emit("feed", model.feed(System.currentTimeMillis(), now()));
        }
      }
    }
    @Override
    public void onChargerOperatorInfo(List<ChargerOperator> items) {
      try {
        List<Map<String, Object>> values = new ArrayList<>();
        for (ChargerOperator item : items) {
          values.add(item == null ? null : PleosFeedModel.object("id", item.getId(), "name", item.getName()));
        }
        if (chargerOperators.update(values)) {
          emit("pleosChargerOperators", chargerOperators.json());
        }
        model.chargerOperatorCount = chargerOperators.total();
      } catch (RuntimeException e) {
        android.util.Log.w("PleosFeed", "Unable to serialize charger operators", e);
      }
    }
    @Override
    public void routeChanging() {
      resetTurns(true);
    }
    @Override
    public void onRouteStarted(RouteStartInfo state) {
      resetTurns(true);
      if (BuildConfig.NATIVE_TBT_ENABLED) {
        turns.routeEstablished(now());
      }
    }
    @Override
    public void routingHint(String name, long at) {
      if (at >= tbtRouteAt) {
        resetTurns(true, at);
        if (BuildConfig.NATIVE_TBT_ENABLED) {
          turns.routeEstablished(at);
        }
      }
    }
    @Override
    public void navigationStatus(NavigationStatus status, long at) {
      if (BuildConfig.NATIVE_TBT_ENABLED) {
        String value = String.valueOf(status);
        routing.status(value, at);
        if ("ROUTE_DRIVE".equals(value) || NativeRouteSignals.stopped(value)) {
          turns.routingState("ROUTE_DRIVE".equals(value), at);
        }
      }
      updateTurns();
    }
    @Override
    public void tbtInfo(List<TBTInfo> items, long at) {
      if (!BuildConfig.NATIVE_TBT_ENABLED || at < tbtRouteAt) {
        return;
      }
      List<TbtNext.Leg> legs = new ArrayList<>();
      for (TBTInfo item : items) {
        if (item == null) {
          legs.add(null);
        } else {
          legs.add(new TbtNext.Leg(String.valueOf(item.getType()), item.getDistance(),
              item.getDescription()));
        }
      }
      turns.fetched(legs, at);
      updateTurns();
    }
    @Override
    public void routeState(RouteStateInfo state, long at) {
      if (BuildConfig.NATIVE_TBT_ENABLED) {
        String mode = state == null ? null : String.valueOf(state.getNaviMode());
        routing.routeState(mode, at);
        if (state != null) {
          turns.routingState(NativeRouteSignals.guiding(mode), at);
        }
      }
      updateTurns();
      onRouteStateInfo(state);
    }
    @Override
    public void onRouteStateInfo(RouteStateInfo state) {
      String mode = state == null ? null : String.valueOf(state.getNaviMode());
      if (mode != null) {
        lastRouteMode = mode;
        lastRouteAt = now();
      }
      nativeActive(localWatch.route(mode));
      if (cancellation != null) {
        cancellation.route(now(), state == null ? null : String.valueOf(state.getNaviMode()));
        pumpCancel();
      }
    }
    @Override
    public void onRouteCancelled() {
      android.util.Log.i("PleosFeed", "onRouteCancelled (confirmation still required)");
    }
    @Override
    public void onError(ai.pleos.playground.navi.constants.NaviErrorCode e) {
      if (cancellation != null) {
        cancellation.fail("error");
        pumpCancel();
      }
    }
    @Override
    public void onCameraAlert(List<CameraAlert> items) {
      List<Map<String, Object>> a = new ArrayList<>();
      if (items != null) {
        for (CameraAlert c : items) {
          if (c != null) {
            a.add(PleosFeedModel.camera(c.getId(), String.valueOf(c.getType()), c.getSpeedLimit(),
                c.getRemainDistance(), c.isOverSpeed(), c.getSectionAvrSpeed(),
                c.isOverSectionAvrSpeed()));
          }
        }
      }
      model.cameras(a, now());
    }
    @Override
    public void onCautionPointInfo(List<CautionPoint> items) {
      List<Map<String, Object>> a = new ArrayList<>();
      if (items != null) {
        for (CautionPoint c : items) {
          if (c != null) {
            a.add(PleosFeedModel.caution(
                c.getId(), String.valueOf(c.getType()), c.getRemainDistance()));
          }
        }
      }
      model.cautions(a, now());
    }
    @Override
    public void onCurrentRoadSpeedLimit(int k) {
      model.speedLimit(k, now());
    }
    @Override
    public void drivingInfo(DrivingInfo d, long at) {
      try {
        DrivingState destination = d == null ? null : d.getDestination();
        if (destination == null) {
          return;
        }
        nativeActive(localWatch.destination());
        if (cancellation != null) {
          cancellation.destination();
        }
        if (BuildConfig.NATIVE_TBT_ENABLED && at >= tbtRouteAt
            && routing.eligible(true, true, now())) {
          turns.remaining(destination.getDistance(), at);
        }
        updateTurns();
        int arrivalWh = destination.getRemainDestinationChargingValue();
        Map<String, Object> stop = null;
        List<DrivingState> waypoints = d.getWaypoints();
        if (waypoints != null) {
          for (DrivingState waypoint : waypoints) {
            if (waypoint != null && waypoint.isChargingStation()) {
              stop = PleosFeedModel.chargeStop(waypoint.getName(),
                  waypoint.getRemainDestinationChargingValue(), waypoint.getDistance(),
                  waypoint.getMaxChargingPower(), waypoint.getChargerCount());
              break;
            }
          }
        }
        model.drivingSnapshot(arrivalWh, stop, now());
      } catch (RuntimeException e) {
        if (cancellation != null) {
          cancellation.fail("exception");
          pumpCancel();
        }
        android.util.Log.w("PleosFeed", "Invalid driving info", e);
      }
    }
  };

  /** 예상 경로의 소통 구간(경로 비율 0~100). 경로 선은 SDK가 주지 않아 비율로만 넘긴다. */
  private static List<Map<String, Object>> tripTraffic(TripInfo trip) {
    List<Map<String, Object>> out = new ArrayList<>();
    if (trip.getSummary() == null || trip.getSummary().getTrafficConditions() == null) {
      return out;
    }
    for (TrafficInfo t : trip.getSummary().getTrafficConditions()) {
      if (t == null || out.size() >= 200) {
        continue;
      }
      out.add(PleosFeedModel.object("t", String.valueOf(t.getCongestionType()),
          "s", t.getStartRatio(), "e", t.getEndRatio()));
    }
    return out;
  }
}
