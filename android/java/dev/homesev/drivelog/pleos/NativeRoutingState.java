package dev.homesev.drivelog.pleos;

/** 두 출처 중 가장 나중에 받은 경로 상태를 따른다. */
public final class NativeRoutingState {
  private long at = -1;
  private boolean routing, sampled;
  public void reset() {
    at = -1;
    routing = sampled = false;
  }
  public void status(String status, long now) {
    update("ROUTE_DRIVE".equals(status), false, now);
  }
  public void routeState(String mode, long now) {
    update(NativeRouteSignals.guiding(mode), true, now);
  }
  private void update(boolean value, boolean sample, long now) {
    if (now >= at) {
      routing = value;
      sampled = sample;
      at = now;
    }
  }
  public boolean eligible(boolean recording, boolean connected, long now) {
    return recording && connected && routing && at >= 0 && now >= at
        && (!sampled || now - at <= 3000);
  }
}
