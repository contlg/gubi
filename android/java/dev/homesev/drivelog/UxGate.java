package dev.homesev.drivelog;

import android.car.Car;
import android.car.CarAppFocusManager;
import android.car.drivingstate.CarUxRestrictions;
import android.car.drivingstate.CarUxRestrictionsManager;
import android.content.Context;
import android.os.Handler;

/**
 * 주행 제한(CarUxRestrictions) 추적.
 *
 * 두 값을 따로 알린다.
 *  - courseLocked: 코스 설정 잠금. 차량 서비스를 쓸 수 없으면 안전하게 잠근 채로 둔다(기존 동작).
 *  - uxRestricted: 차량이 실제로 "주행 중 제한"이라고 알려 준 상태. 서비스를 쓸 수 없거나
 *    값을 모르면 제한이라고 단정하지 않고 false로 정직하게 알린다.
 */
public final class UxGate {
  public interface Listener {
    void changed(boolean courseLocked, boolean uxRestricted);
  }

  private Car car;
  private CarUxRestrictionsManager manager;
  private boolean closed;
  private final java.util.function.Consumer<CarAppFocusManager> focusReady;

  /** focusReady: 차 서비스가 연결돼 앱 포커스 관리자를 얻으면(실패 시 null) 호출한다. */
  public UxGate(Context ctx, Handler handler, Listener listener,
      java.util.function.Consumer<CarAppFocusManager> focusReady) {
    this.focusReady = focusReady;
    if (!ctx.getPackageManager().hasSystemFeature("android.hardware.type.automotive")) {
      listener.changed(false, false);
      return;
    }
    listener.changed(true, false);
    car = Car.createCar(ctx, handler, 0, (c, ready) -> {
      if (closed) {
        return;
      }
      if (!ready) {
        listener.changed(true, false);
        focusReady.accept(null);
        return;
      }
      try {
        focusReady.accept((CarAppFocusManager) c.getCarManager(Car.APP_FOCUS_SERVICE));
      } catch (Exception e) {
        android.util.Log.w("FundriveUx", "App focus unavailable", e);
        focusReady.accept(null);
      }
      try {
        manager = (CarUxRestrictionsManager) c.getCarManager(Car.CAR_UX_RESTRICTION_SERVICE);
        manager.registerListener(r -> notify(listener, r));
        notify(listener, manager.getCurrentCarUxRestrictions());
      } catch (Exception e) {
        android.util.Log.w("FundriveUx", "UX unavailable", e);
        listener.changed(true, false);
      }
    });
  }

  private static void notify(Listener listener, CarUxRestrictions r) {
    // 값이 아직 없으면(null) 코스 설정은 잠그고, 제한 상태는 모른다고 보고한다.
    listener.changed(restricted(r), r != null && restricted(r));
  }

  private static boolean restricted(CarUxRestrictions r) {
    return r == null || r.isRequiresDistractionOptimization()
        || r.getActiveRestrictions() != CarUxRestrictions.UX_RESTRICTIONS_BASELINE;
  }

  public void close() {
    closed = true;
    if (manager != null) {
      manager.unregisterListener();
    }
    if (car != null) {
      car.disconnect();
    }
  }
}
