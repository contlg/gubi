package dev.homesev.drivelog.pleos;

import android.content.Context;
import android.content.pm.PackageManager;
import dev.homesev.drivelog.AsyncScope;
import android.os.SystemClock;
import android.car.Car;
import android.car.VehiclePropertyIds;
import android.car.hardware.CarPropertyValue;
import android.car.hardware.property.CarPropertyManager;
import android.util.Log;
import ai.pleos.playground.location.fused.FusedLocation;
import ai.pleos.playground.location.fused.listener.FusedLocationListener;
import ai.pleos.playground.location.fused.model.LocationData;
import java.util.Map;
import java.util.function.Consumer;

final class PleosLocationFeed {
  private final AsyncScope scope;
  private FusedLocation fused;
  private FusedLocationListener listener;
  private Car car;
  private CarPropertyManager props;
  private CarPropertyManager.CarPropertyEventCallback speedCallback;
  private Double speed;
  private long speedAt = -1;
  private boolean logged;

  private void warn(String message, Exception error) {
    if (!logged) {
      logged = true;
      Log.w("PleosLoc", message, error);
    }
  }

  PleosLocationFeed(Context ctx, PleosSdkThread sdk, Consumer<String> output) {
    this.scope = sdk.scope();
    scope.execute(() -> initialize(ctx, output));
  }

  private void initialize(Context ctx, Consumer<String> output) {
    try {
      fused = new FusedLocation(ctx);
      if (ctx.checkSelfPermission("pleos.car.permission.FUSED_LOCATION")
              != PackageManager.PERMISSION_GRANTED
          || !fused.isSupported()) {
        warn("FusedLocation unsupported or permission missing", null);
        fused.release();
        fused = null;
        return;
      }
      fused.initialize();
      listener = new FusedLocationListener() {
        public void onChanged(LocationData data) {
          scope.execute(() -> {
            if (data == null) {
              return;
            }
            Map<String, Object> fix =
                PleosFeedModel.location(data.getLatitude(), data.getLongitude(), data.getHeading(),
                    data.getAltitude(), data.getConfidence(), data.getTimestampMillis(), speed,
                    speedAt < 0 ? Long.MAX_VALUE : SystemClock.elapsedRealtime() - speedAt);
            if (fix != null) {
              String json = PleosFeedModel.json(fix);
              scope.deliver(() -> output.accept(json));
            }
          });
        }
        public void onError(Exception e) {
          scope.execute(() -> { warn("FusedLocation error", e); });
        }
      };
      fused.registerFusedLocationCallback(listener);
    } catch (RuntimeException e) {
      warn("FusedLocation initialization failed", e);
    }
    try {
      car = Car.createCar(ctx);
      if (car != null) {
        props = (CarPropertyManager) car.getCarManager(Car.PROPERTY_SERVICE);
        speedCallback = new CarPropertyManager.CarPropertyEventCallback() {
          public void onChangeEvent(CarPropertyValue value) {
            scope.execute(() -> {
              // 수신 시각이 아닌 속성의 단조 표본 시각을 사용한다.
              long sampleMs = value == null ? -1 : value.getTimestamp() / 1000000L;
              Object v = value != null && value.getStatus() == CarPropertyValue.STATUS_AVAILABLE
                  ? value.getValue()
                  : null;
              speed = v instanceof Number ? PleosFeedModel.number((Number) v, -120, 120) : null;
              speedAt = sampleMs;
            });
          }
          public void onErrorEvent(int property, int area) {
            scope.execute(() -> {
              speed = null;
              speedAt = -1;
            });
          }
        };
        props.registerCallback(speedCallback, VehiclePropertyIds.PERF_VEHICLE_SPEED,
            CarPropertyManager.SENSOR_RATE_ONCHANGE);
      }
    } catch (RuntimeException e) {
      Log.w("PleosLoc", "Vehicle speed unavailable", e);
    }
  }

  void close() {
    scope.close(this::release);
  }

  private void release() {
    try {
      if (fused != null && listener != null) {
        fused.unregisterFusedLocationCallback(listener);
      }
    } catch (RuntimeException e) {
      Log.w("PleosLoc", "Unregister", e);
    }
    try {
      if (fused != null) {
        fused.release();
      }
    } catch (RuntimeException e) {
      Log.w("PleosLoc", "Release", e);
    }
    try {
      if (props != null && speedCallback != null) {
        props.unregisterCallback(speedCallback);
      }
    } catch (RuntimeException ignored) {
    }
    try {
      if (car != null) {
        car.disconnect();
      }
    } catch (RuntimeException ignored) {
    }
  }
}
