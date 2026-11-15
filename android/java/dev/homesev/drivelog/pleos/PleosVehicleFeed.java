package dev.homesev.drivelog.pleos;

import android.content.Context;
import dev.homesev.drivelog.AsyncScope;
import dev.homesev.drivelog.FundriveDiag;
import android.os.SystemClock;
import ai.pleos.playground.vehicle.Vehicle;
import ai.pleos.playground.vehicle.listener.*;
import ai.pleos.playground.vehicle.constant.control.VehicleGear;
import kotlin.Unit;
import kotlin.jvm.functions.Function1;
import java.util.*;

final class PleosVehicleFeed {
  private final PleosFeedModel model;
  private final PleosSdkThread sdk;
  private final AsyncScope scope;
  private final List<Runnable> reads = new ArrayList<>(), unsubscribe = new ArrayList<>();
  private Vehicle v;
  private volatile boolean closed;
  boolean initialized, initializationDone, setupStarted, retryScheduled, connectionConfirmed;
  private boolean connectionFailed;
  interface SampleListener { void sample(String key, Object value, long at); }
  private final SampleListener samples;
  private boolean dynamicsConfigured, dynamicsWanted;
  private int dynamicsGeneration;
  private final List<Runnable> dynamicsStops = new ArrayList<>();

  void dynamics(boolean wanted) {
    scope.execute(() -> {
      if (dynamicsWanted == wanted) return;
      dynamicsWanted = wanted;
      dynamicsGeneration++;
      if (wanted && v != null) setupDynamics();
      else {
        dynamicsConfigured = false;
        dynamicsReads.clear();
        for (Runnable stop : dynamicsStops) { try { stop.run(); } catch (RuntimeException ignored) { } }
        dynamicsStops.clear();
        put("steeringDeg", null);
        put("brake", null);
      }
    });
  }
  private final Map<String, Runnable> dynamicsReads = new HashMap<>();

  private static boolean readable(ai.pleos.playground.vehicle.api.model.capability.CapabilityConfig config) {
    return config != null && ("READ".equals(String.valueOf(config.getAccessType()))
        || "READ_WRITE".equals(String.valueOf(config.getAccessType())));
  }

  private void dynamicsUnavailable(String key) {
    put(key, null);
    scope.execute(() -> dynamicsReads.remove(key));
  }
  private Function1<Exception, Unit> dynamicsError(String key) {
    return e -> { connectionError(e); dynamicsUnavailable(key); return Unit.INSTANCE; };
  }
  private void addDynamics(String key, Runnable read, Runnable subscribe, Runnable stop) {
    Runnable safe = () -> {
      try { read.run(); } catch (RuntimeException e) { connectionError(e); dynamicsUnavailable(key); }
    };
    dynamicsReads.put(key, safe);
    dynamicsStops.add(stop);
    safe.run();
    try { subscribe.run(); } catch (RuntimeException e) { connectionError(e); dynamicsUnavailable(key); }
  }
  private final Runnable dynamicsPoll = new Runnable() {
    public void run() {
      if (closed || connectionFailed) return;
      for (Runnable read : new ArrayList<>(dynamicsReads.values())) read.run();
      sdk.later(scope, this, 1000);
    }
  };

  private void setupDynamics() {
    if (!dynamicsWanted || dynamicsConfigured) return;
    dynamicsConfigured = true;
    final int generation = dynamicsGeneration;
    SteeringWheelAngleListener steering = new SteeringWheelAngleListener() {
      public void onSteeringWheelAngleUpdated(Float value) { if (generation == dynamicsGeneration && dynamicsWanted) put("steeringDeg", value); }
      public void onFailed(Exception e) { connectionError(e); dynamicsUnavailable("steeringDeg"); }
    };
    BrakePedalStatusListener brake = new BrakePedalStatusListener() {
      public void onBrakePedalStatusUpdated(Boolean value) { if (generation == dynamicsGeneration && dynamicsWanted) put("brake", value); }
      public void onFailed(Exception e) { connectionError(e); dynamicsUnavailable("brake"); }
    };
    try {
      v.getSteeringWheel().checkSteeringWheelAngleCapabilities((config, bounds) -> {
        scope.execute(() -> {
          if (closed || generation != dynamicsGeneration || !dynamicsWanted) return;
          if (!readable(config)) { dynamicsUnavailable("steeringDeg"); return; }
          addDynamics("steeringDeg", () -> v.getSteeringWheel().getCurrentSteeringWheelAngle(ok("steeringDeg"), dynamicsError("steeringDeg")),
              () -> v.getSteeringWheel().registerSteeringWheelAngle(steering),
              () -> v.getSteeringWheel().unregisterSteeringWheelAngle(steering));
        });
        return Unit.INSTANCE;
      }, dynamicsError("steeringDeg"));
    } catch (RuntimeException e) { connectionError(e); dynamicsUnavailable("steeringDeg"); }
    try {
      v.getBrake().checkBrakePedalStatusCapabilities(config -> {
        scope.execute(() -> {
          if (closed || generation != dynamicsGeneration || !dynamicsWanted) return;
          if (!readable(config)) { dynamicsUnavailable("brake"); return; }
          addDynamics("brake", () -> v.getBrake().getCurrentBrakePedalStatus(ok("brake"), dynamicsError("brake")),
              () -> v.getBrake().registerBrakePedalStatus(brake),
              () -> v.getBrake().unregisterBrakePedalStatus(brake));
        });
        return Unit.INSTANCE;
      }, dynamicsError("brake"));
    } catch (RuntimeException e) { connectionError(e); dynamicsUnavailable("brake"); }
  }

  PleosVehicleFeed(Context ctx, PleosSdkThread sdk, PleosFeedModel model, SampleListener samples, boolean dynamicsWanted) {
    this.sdk = sdk;
    this.scope = sdk.scope();
    this.model = model;
    this.samples = samples;
    this.dynamicsWanted = dynamicsWanted;
    sdk.later(scope, dynamicsPoll, 1000);
    scope.execute(() -> initialize(ctx));
  }

  private void initialize(Context ctx) {
    try {
      v = new Vehicle(ctx);
      FundriveDiag.log("Vehicle initialize");
      v.initialize();
      FundriveDiag.log("Vehicle initialize returned (not connection confirmation)");
      scope.deliver(() -> {
        initialized = true;
        initializationDone = true;
      });
      sdk.later(scope, () -> {
        if (!closed && !connectionFailed) {
          scope.deliver(() -> setupStarted = true);
          setup();
        }
      }, 1500);
    } catch (RuntimeException e) {
      connectionError(e);
      FundriveDiag.log("Vehicle initialize failed type=" + e.getClass().getSimpleName());
      scope.deliver(() -> {
        initialized = false;
        initializationDone = true;
      });
      android.util.Log.w("PleosFeed", "Vehicle initialization", e);
    }
    scope.execute(poll);
  }

  private void connectionError(Exception error) {
    if (!VehicleConnectionFailure.isConnectionFailure(error)) return;
    scope.execute(() -> {
      if (closed || connectionFailed) return;
      connectionFailed = true;
      FundriveDiag.log("Vehicle onDisconnected reason=connection-error type=" + error.getClass().getSimpleName());
      scope.deliver(() -> { initialized = false; initializationDone = true; connectionConfirmed = false; });
    });
  }

  private void put(String key, Object value) {
    long sampled = SystemClock.elapsedRealtime();
    scope.deliver(() -> {
      if (value != null && !connectionConfirmed && !connectionFailed) {
        connectionConfirmed = true;
        FundriveDiag.log("Vehicle onConnected reason=property-received");
      }
      model.vehicle(key, value, sampled);
      samples.sample(key, value, sampled);
    });
  }
  private <T> Function1<T, Unit> ok(String key) {
    return value -> {
      put(key, value);
      return Unit.INSTANCE;
    };
  }
  private Function1<Exception, Unit> error(String key) {
    return e -> {
      connectionError(e);
      put(key, null);
      return Unit.INSTANCE;
    };
  }

  private void add(String key, Runnable read, Runnable subscribe, Runnable stop) {
    Runnable safeRead = () -> {
      try {
        read.run();
      } catch (RuntimeException e) {
        connectionError(e);
        put(key, null);
      }
    };
    reads.add(safeRead);
    safeRead.run();
    if (subscribe != null) {
      unsubscribe.add(stop);
      try {
        subscribe.run();
      } catch (RuntimeException e) {
        connectionError(e);
        put(key, null);
      }
    }
  }

  private void setup() {
    setupDynamics();
    EvBatteryStateOfChargeListener socPct = new EvBatteryStateOfChargeListener() {
      public void onEvBatteryStateOfChargeUpdated(Integer value) {
        put("socPct", value);
      }
      public void onFailed(Exception e) {
        connectionError(e);
        put("socPct", null);
      }
    };
    add("socPct",
        () -> v.getEvBattery().getEvBatteryStateOfCharge(ok("socPct"), error("socPct")),
        () -> v.getEvBattery().registerEvBatteryStateOfCharge(socPct),
        () -> v.getEvBattery().unregisterEvBatteryStateOfCharge(socPct));
    GearSelectionListener gear = new GearSelectionListener() {
      public void onSelected(VehicleGear value) {
        put("gear", value == null || value == VehicleGear.GEAR_UNKNOWN ? null : value.name());
      }
      public void onFailed(Exception e) {
        connectionError(e);
        put("gear", null);
      }
    };
    add("gear",
        () -> v.getGear().getCurrentGearSelectionState(
            value -> {
              put("gear",
                  value == null || value == VehicleGear.GEAR_UNKNOWN ? null : value.name());
              return Unit.INSTANCE;
            },
            error("gear")),
        () -> v.getGear().registerGearSelection(gear),
        () -> v.getGear().unregisterGearSelection(gear));
    DistanceDrivenListener odometerKm = new DistanceDrivenListener() {
      public void onDistanceDrivenUpdated(Float value) {
        put("odometerKm", value);
      }
      public void onFailed(Exception e) {
        connectionError(e);
        put("odometerKm", null);
      }
    };
    add("odometerKm",
        () -> v.getOdometer().getCurrentDistanceDriven(ok("odometerKm"), error("odometerKm")),
        () -> v.getOdometer().registerDistanceDriven(odometerKm),
        () -> v.getOdometer().unregisterDistanceDriven(odometerKm));
    CruiseControlTargetSpeedListener cruiseKmh = new CruiseControlTargetSpeedListener() {
      public void onCruiseControlTargetSpeedUpdated(Float value) {
        put("cruiseKmh", PleosFeedModel.kmh(value));
      }
      public void onFailed(Exception e) {
        connectionError(e);
        put("cruiseKmh", null);
      }
    };
    add("cruiseKmh",
        () -> v.getDrivingMode().getCruiseControlTargetSpeed(
            value -> {
              put("cruiseKmh", PleosFeedModel.kmh(value));
              return Unit.INSTANCE;
            },
            error("cruiseKmh")),
        () -> v.getDrivingMode().registerCruiseControlTargetSpeed(cruiseKmh),
        () -> v.getDrivingMode().unregisterCruiseControlTargetSpeed(cruiseKmh));
    add("capacityWh",
        () -> v.getEvBattery().getEvBatteryCapacity(ok("capacityWh"), error("capacityWh")),
        null, null);
  }

  private final Runnable poll = new Runnable() {
    public void run() {
      if (closed || connectionFailed) {
        return;
      }
      // 정적 구독 값은 다시 전달되지 않을 수 있어 직접 갱신해 권한·서비스 상실을
      // 확인한다. 실패한 콜백은 해당 필드만 비운다.
      for (Runnable read : new ArrayList<>(reads)) {
        read.run();
      }
      sdk.later(scope, this, 5000);
    }
  };

  void close() {
    closed = true;
    scope.close(this::release);
  }

  private void release() {
    for (Runnable r : unsubscribe) {
      try {
        r.run();
      } catch (RuntimeException ignored) {
      }
    }
    for (Runnable stop : dynamicsStops) { try { stop.run(); } catch (RuntimeException ignored) { } }
    dynamicsStops.clear();
    dynamicsReads.clear();
    unsubscribe.clear();
    reads.clear();
    try {
      if (v != null) {
        FundriveDiag.log("Vehicle release");
        v.release();
      }
    } catch (RuntimeException ignored) {
    }
  }
}
