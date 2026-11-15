package dev.homesev.drivelog.pleos;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import ai.pleos.playground.navi.helper.NaviHelper;
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener;
import ai.pleos.playground.navi.data.*;
import ai.pleos.playground.navi.constants.NaviErrorCode;
import ai.pleos.playground.navi.constants.NavigationStatus;
import dev.homesev.drivelog.BuildConfig;
import dev.homesev.drivelog.FundriveDiag;
import dev.homesev.drivelog.AsyncScope;
import kotlin.Unit;
import java.util.*;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;
import java.util.function.LongConsumer;

final class PleosTripDispatcher {
  interface Result {
    void done(TripInfo trip, String error);
  }
  interface Observer extends NaviHelperEventListener {
    void connection(boolean connected);
    default void connecting() {}
    default void routeChanging() {}
    default void drivingInfo(DrivingInfo info, long at) {
      onDrivingInfo(info);
    }
    default void tbtInfo(List<TBTInfo> items, long at) {
      onTBTInfo(items);
    }
    default void routingHint(String name, long at) {
      if ("onRoutingCompleted".equals(name)) {
        onRoutingCompleted();
      } else {
        onReRouteEnded();
      }
    }
    default void navigationStatus(NavigationStatus status, long at) {
      onNavigationStatus(status);
    }
    default void routeState(RouteStateInfo state, long at) {
      onRouteStateInfo(state);
    }
  }
  private final Handler main = new Handler(Looper.getMainLooper());
  private final AsyncScope scope;
  private final PleosSdkThread sdk;
  private final Context context;
  private final TripDispatchQueue queue = new TripDispatchQueue();
  private final Map<TripDispatchQueue.Job, Result> results = new HashMap<>();
  private final Set<Object> clients = new HashSet<>();
  private final Set<Observer> observers = new HashSet<>();
  // SDK 객체는 작업자 스레드에서만 접근한다.
  private NaviHelper navi;
  private volatile int epoch;
  private boolean connected, connecting, initialized, pollQueued;
  private final NativeRoutingState routing = new NativeRoutingState();
  private volatile boolean recording, tbtEligible;
  private long lastTbtPoll = -2000;

  void recording(boolean active) {
    recording = active;
    tbtEligible = active && routing.eligible(true, connected, now());
  }

  void routeChanging() {
    for (Observer o : new ArrayList<>(observers)) {
      o.routeChanging();
    }
  }

  static void event(String name, long at) {
    if ("carTest".equals(BuildConfig.BUILD_TYPE)) {
      android.util.Log.i("FundriveNaviEvents", "NAVI EVENT " + name + " " + at);
    }
  }

  private long lastPoll = -1, lastConnect = -10000;
  private final ConnectionRetry retry = new ConnectionRetry();

  PleosTripDispatcher(Context context, PleosSdkThread sdk) {
    this.context = context.getApplicationContext();
    this.sdk = sdk;
    this.scope = sdk.scope();
  }

  void attach(Object owner, Observer observer) {
    clients.add(owner);
    if (observer != null) {
      observers.add(observer);
      observer.connection(connected);
    }
    connect();
    main.removeCallbacks(tick);
    main.post(tick);
  }

  void detach(Object owner, Observer observer) {
    clients.remove(owner);
    observers.remove(observer);
    cancel(owner);
  }

  boolean ready() {
    return connected && queue.ready(now());
  }

  boolean connected() {
    return connected;
  }

  void cancelRoute(int generation, BooleanSupplier current, Runnable called, Runnable failed) {
    command(generation, current, false, helper -> helper.cancelRoute(), at -> {}, called, failed);
  }

  void route(int generation, BooleanSupplier current, Consumer<NaviHelper> action,
      LongConsumer issued, Runnable failed) {
    command(generation, current, true, action, issued, () -> {}, failed);
  }

  private void command(int generation, BooleanSupplier current, boolean waitForResume,
      Consumer<NaviHelper> action, LongConsumer issued, Runnable done, Runnable failed) {
    final int gen = epoch;
    if (!connected) {
      failed.run();
      return;
    }
    scope.execute(new Runnable() {
      public void run() {
        if (!CourseOwnership.current(generation)) {
          return;
        }
        if (gen != epoch) {
          scope.deliver(() -> {
            if (CourseOwnership.current(generation)) {
              failed.run();
            }
          });
          return;
        }
        if (!current.getAsBoolean()) {
          // 일시중지는 대기 작업만 멈추고 최초 경로 요청은 보존한다.
          if (waitForResume) {
            sdk.later(scope, this, 100);
          }
          return;
        }
        try {
          if (navi == null) {
            throw new IllegalStateException("disconnected");
          }
          final long at = now();
          scope.deliver(() -> {
            if (gen == epoch && CourseOwnership.current(generation)) {
              issued.accept(at);
            }
          });
          action.accept(navi);
          scope.deliver(() -> {
            if (gen == epoch && CourseOwnership.current(generation) && current.getAsBoolean()) {
              done.run();
            }
          });
        } catch (RuntimeException e) {
          scope.deliver(() -> {
            if (gen == epoch && CourseOwnership.current(generation)) {
              failed.run();
              closeConnection("sdk-failure");
            }
          });
        }
      }
    });
  }

  void submit(Object owner, String name, double lat, double lng, Result result) {
    if (!clients.contains(owner)) {
      result.done(null, "disconnected");
      return;
    }
    try {
      TripDispatchQueue.Job j = queue.enqueue(owner, name, lat, lng, now());
      results.put(j, result);
      sendNext();
    } catch (IllegalArgumentException e) {
      result.done(null, "invalid_or_busy");
    }
  }

  void cancel(Object owner) {
    for (TripDispatchQueue.Job j : queue.cancel(owner)) {
      results.remove(j);
    }
  }

  private static long now() {
    return SystemClock.elapsedRealtime();
  }

  private void status(boolean value) {
    FundriveDiag.log("NaviHelper " + (value ? "onConnected" : "onDisconnected") + " epoch=" + epoch);
    connected = value;
    if (!value) {
      routing.reset();
      tbtEligible = false;
      lastTbtPoll = -2000;
    }
    for (Observer o : new ArrayList<>(observers)) {
      o.connection(value);
    }
  }

  private void releaseHelper() {
    NaviHelper old = navi;
    navi = null;
    if (old != null) {
      try {
        FundriveDiag.log("NaviHelper release epoch=" + epoch);
        old.release();
      } catch (RuntimeException ignored) {
      }
    }
  }

  private void closeConnection(String reason) {
    FundriveDiag.log("NaviHelper connection failure reason=" + reason + " epoch=" + epoch);
    event("connection closed", now());
    retry.failed(now());
    epoch++;
    connecting = false;
    initialized = false;
    pollQueued = false;
    status(false);
    scope.execute(this::releaseHelper);
  }

  void shutdown() {
    epoch++;
    connected = false;
    connecting = false;
    initialized = false;
    main.removeCallbacksAndMessages(null);
    clients.clear();
    observers.clear();
    results.clear();
    scope.close(this::releaseHelper);
  }

  private void connect() {
    if (clients.isEmpty() || initialized || connecting || !retry.ready(now())) {
      return;
    }
    lastConnect = now();
    connecting = true;
    for (Observer o : new ArrayList<>(observers)) {
      o.connecting();
    }
    final int gen = ++epoch;
    scope.execute(() -> {
      if (gen != epoch) {
        return;
      }
      try {
        NaviHelper helper = new NaviHelper(context);
        navi = helper;
        FundriveDiag.log("NaviHelper initialize epoch=" + gen);
        helper.initialize(
            () -> {
              scope.execute(() -> {
                if (gen != epoch) {
                  return;
                }
                try {
                  helper.addListener(listener(gen));
                  sdk.later(scope, () -> {
                    if (gen == epoch && navi != null) {
                      try {
                        helper.getChargerOperatorInfo();
                      } catch (RuntimeException e) {
                        android.util.Log.w("PleosFeed", "Charger operators unavailable", e);
                      }
                    }
                  }, 100);
                  scope.deliver(() -> {
                    if (gen != epoch) {
                      return;
                    }
                    connecting = false;
                    initialized = true;
                    retry.healthy();
                    event("connection initialized", now());
                    status(true);
                  });
                } catch (RuntimeException e) {
                  scope.deliver(() -> {
                    if (gen == epoch) {
                      closeConnection("sdk-failure");
                    }
                  });
                }
              });
              return Unit.INSTANCE;
            },
            e -> {
              scope.deliver(() -> {
                if (gen == epoch) {
                  closeConnection("sdk-failure");
                }
              });
              return Unit.INSTANCE;
            });
      } catch (RuntimeException e) {
        scope.deliver(() -> {
          if (gen == epoch) {
            closeConnection("sdk-failure");
          }
        });
      }
    });
  }

  private void finish(TripDispatchQueue.Job j, TripInfo trip, String error) {
    if (j == null) {
      return;
    }
    Result r = results.remove(j);
    if (r != null && !j.cancelled) {
      r.done(trip, error);
    }
  }

  private void sendNext() {
    if (!connected) {
      return;
    }
    TripDispatchQueue.Job j = queue.start(now());
    if (j == null) {
      return;
    }
    final int gen = epoch;
    scope.execute(() -> {
      if (gen != epoch) {
        return;
      }
      try {
        navi.requestTrip(new TripRequest(j.lat, j.lng, "", j.name, ""));
      } catch (RuntimeException e) {
        scope.deliver(() -> {
          if (gen == epoch) {
            closeConnection("sdk-failure");
          }
        });
      }
    });
  }

  private void poll() {
    tbtEligible = routing.eligible(recording, connected, now());
    if (pollQueued) {
      return;
    }
    final boolean turns = BuildConfig.NATIVE_TBT_ENABLED && tbtEligible
        && now() - lastTbtPoll >= 2000;
    if (turns) {
      lastTbtPoll = now();
    }
    pollQueued = true;
    final int gen = epoch;
    scope.execute(() -> {
      if (gen != epoch) {
        return;
      }
      try {
        navi.getRouteStateInfo();
        if (BuildConfig.NATIVE_TBT_ENABLED && turns && recording && tbtEligible) {
          navi.getTBTInfo();
        }
        scope.deliver(() -> {
          if (gen == epoch) {
            pollQueued = false;
          }
        });
      } catch (RuntimeException e) {
        scope.deliver(() -> {
          if (gen == epoch) {
            closeConnection("sdk-failure");
          }
        });
      }
    });
  }
  private final Runnable tick = new Runnable() {
    public void run() {
      finish(queue.expire(now()), null, "timeout");
      if (clients.isEmpty() && results.isEmpty()) {
        closeConnection("no-owners");
        return;
      }
      // 경로 상태 콜백은 연결 확인 신호가 아니다. 안내가 없으면 응답이 없을 수 있다.
      // SDK 초기화 실패·오류 콜백·호출 예외에서만 연결을 다시 만든다.
      if (connecting && now() - lastConnect >= 5000) {
        closeConnection("initialize-timeout");
      }
      if (!connected) {
        for (TripDispatchQueue.Job j : queue.expireWaiting(now())) {
          finish(j, null, "unavailable");
        }
      }
      connect();
      if (connected) {
        if (now() - lastPoll >= 1000) {
          lastPoll = now();
          poll();
        }
        sendNext();
      }
      main.postDelayed(this, 50);
    }
  };

  private NaviHelperEventListener listener(int gen) {
    return new NaviHelperEventListener() {
      private void hint(String name) {
        final long at = now();
        event(name, at);
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.routingHint(name, at);
            }
          }
        });
      }
      @Override
      public void onChargerOperatorInfo(List<ChargerOperator> items) {
        List<ChargerOperator> copy = items == null ? List.of() : new ArrayList<>(items);
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onChargerOperatorInfo(copy);
            }
          }
        });
      }
      @Override
      public void onRoutingCompleted() {
        hint("onRoutingCompleted");
      }
      @Override
      public void onReRouteEnded() {
        hint("onReRouteEnded");
      }
      @Override
      public void onNavigationStatus(NavigationStatus status) {
        final long at = now();
        event("onNavigationStatus " + status, at);
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            routing.status(String.valueOf(status), at);
            tbtEligible = routing.eligible(recording, connected, now());
            for (Observer o : new ArrayList<>(observers)) {
              o.navigationStatus(status, at);
            }
          }
        });
      }
      @Override
      public void onTBTInfo(List<TBTInfo> items) {
        if (!BuildConfig.NATIVE_TBT_ENABLED) {
          return;
        }
        final long at = now();
        event("onTBTInfo count=" + (items == null ? 0 : items.size()), at);
        List<TBTInfo> copy = items == null ? Collections.emptyList() : new ArrayList<>(items);
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.tbtInfo(copy, at);
            }
          }
        });
      }
      @Override
      public void onRouteStarted(RouteStartInfo i) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onRouteStarted(i);
            }
          }
        });
      }
      @Override
      public void onRouteEnded() {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onRouteEnded();
            }
          }
        });
      }
      @Override
      public void onDestinationArrived(DestinationArrivedInfo i) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onDestinationArrived(i);
            }
          }
        });
      }
      @Override
      public void onWayPointArrived(WaypointArrivedInfo i) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onWayPointArrived(i);
            }
          }
        });
      }
      @Override
      public void onWaypointChanged(WaypointChangedInfo i) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onWaypointChanged(i);
            }
          }
        });
      }
      @Override
      public void onWayPointInfo(List<WaypointInfo> i) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onWayPointInfo(i);
            }
          }
        });
      }
      @Override
      public void onDestinationInfo(DestinationInfo i) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onDestinationInfo(i);
            }
          }
        });
      }
      @Override
      public void onTripInfo(TripInfo t) {
        scope.deliver(() -> {
          if (gen != epoch || t == null || t.getSummary() == null
              || t.getSummary().getRoutePoints() == null) {
            return;
          }
          RoutePointInfo dest = null;
          for (RoutePointInfo p : t.getSummary().getRoutePoints()) {
            if ("DESTINATION".equals(String.valueOf(p.getPointType()))) {
              if (dest != null) {
                return;
              }
              dest = p;
            }
          }
          if (dest != null) {
            finish(queue.accept(dest.getPoiName(), now()), t, null);
          }
        });
      }
      @Override
      public void onRouteStateInfo(RouteStateInfo s) {
        final long at = now();
        scope.deliver(() -> {
          if (gen == epoch && initialized) {
            routing.routeState(s == null ? null : String.valueOf(s.getNaviMode()), at);
            tbtEligible = routing.eligible(recording, connected, now());
            if (!connected) {
              status(true);
            }
            for (Observer o : new ArrayList<>(observers)) {
              o.routeState(s, at);
            }
          }
        });
      }
      @Override
      public void onRouteCancelled() {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onRouteCancelled();
            }
          }
        });
      }
      @Override
      public void onError(NaviErrorCode e) {
        scope.deliver(() -> {
          if (gen != epoch) {
            return;
          }
          status(false);
          for (Observer o : new ArrayList<>(observers)) {
            o.onError(e);
          }
          closeConnection("sdk-failure");
        });
      }
      @Override
      public void onCameraAlert(List<CameraAlert> a) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onCameraAlert(a);
            }
          }
        });
      }
      @Override
      public void onDrivingInfo(DrivingInfo d) {
        final long at = now();
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.drivingInfo(d, at);
            }
          }
        });
      }
      @Override
      public void onCautionPointInfo(List<CautionPoint> a) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onCautionPointInfo(a);
            }
          }
        });
      }
      @Override
      public void onCurrentRoadSpeedLimit(int k) {
        scope.deliver(() -> {
          if (gen == epoch && connected) {
            for (Observer o : new ArrayList<>(observers)) {
              o.onCurrentRoadSpeedLimit(k);
            }
          }
        });
      }
    };
  }
}
