package dev.homesev.drivelog;

import android.car.CarAppFocusManager;

/**
 * 차 시스템의 "내비 안내 주인 자리"(APP_FOCUS_TYPE_NAVIGATION)를 공식 API로 잡는다.
 *
 * 차 서비스가 없거나 이 API를 쓸 수 없으면 안내를 막지 않도록 요청은 true로 답하고
 * 이유만 진단 로그에 남긴다. 자리를 뺏기면 {@code Host.lost()}로 알린다.
 */
final class NavFocus {
  interface Host {
    /** 자리를 뺏겼다(다른 내비가 가져감). 어느 스레드에서든 불릴 수 있다. */
    void lost();
  }

  private final Host host;
  private CarAppFocusManager manager;
  private boolean wanted;
  private boolean owning;
  private final CarAppFocusManager.OnAppFocusOwnershipCallback callback =
      new CarAppFocusManager.OnAppFocusOwnershipCallback() {
        @Override
        public void onAppFocusOwnershipLost(int appType) {
          if (appType != CarAppFocusManager.APP_FOCUS_TYPE_NAVIGATION) {
            return;
          }
          synchronized (NavFocus.this) {
            owning = false;
            wanted = false;
          }
          FundriveDiag.log("navfocus lost");
          host.lost();
        }

        @Override
        public void onAppFocusOwnershipGranted(int appType) {
          if (appType == CarAppFocusManager.APP_FOCUS_TYPE_NAVIGATION) {
            synchronized (NavFocus.this) {
              owning = true;
            }
          }
        }
      };

  NavFocus(Host host) {
    this.host = host;
  }

  /** 차 서비스가 연결되면(또는 끊기면 null) 부른다. 연결 전에 요청이 있었으면 이어서 요청한다. */
  synchronized void attach(CarAppFocusManager next) {
    manager = next;
    owning = false;
    if (next != null && wanted) {
      requestLocked();
    }
  }

  /** 자리를 요청한다. 받았거나 차 API를 못 쓰면 true, 다른 앱이 거절하면 false. */
  synchronized boolean request() {
    wanted = true;
    if (manager == null) {
      FundriveDiag.log("navfocus unavailable reason=no-car-service");
      return true;
    }
    return requestLocked();
  }

  private boolean requestLocked() {
    try {
      int result = manager.requestAppFocus(CarAppFocusManager.APP_FOCUS_TYPE_NAVIGATION, callback);
      owning = result == CarAppFocusManager.APP_FOCUS_REQUEST_SUCCEEDED;
      if (!owning) {
        wanted = false;
        FundriveDiag.log("navfocus refused");
      } else {
        FundriveDiag.log("navfocus granted");
      }
      return owning;
    } catch (SecurityException e) {
      // 이 API를 쓸 권한이 없으면 안내를 막지 않고 이유만 남긴다.
      FundriveDiag.log("navfocus unavailable reason=security");
      return true;
    } catch (RuntimeException e) {
      FundriveDiag.log("navfocus unavailable reason=" + e.getClass().getSimpleName());
      return true;
    }
  }

  synchronized void abandon() {
    wanted = false;
    boolean was = owning;
    owning = false;
    if (manager == null || !was) {
      return;
    }
    try {
      manager.abandonAppFocus(callback, CarAppFocusManager.APP_FOCUS_TYPE_NAVIGATION);
      FundriveDiag.log("navfocus abandoned");
    } catch (RuntimeException e) {
      FundriveDiag.log("navfocus abandon failed reason=" + e.getClass().getSimpleName());
    }
  }

  synchronized boolean owning() {
    if (manager != null && owning) {
      try {
        return manager.isOwningFocus(callback, CarAppFocusManager.APP_FOCUS_TYPE_NAVIGATION);
      } catch (RuntimeException e) {
        return owning;
      }
    }
    return owning;
  }
}
