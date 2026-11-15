package dev.homesev.drivelog;

public final class NativeMapStartupWatch {
  private static final long BUDGET_MS = 10000;
  private long remaining = BUDGET_MS, startedAt = -1;

  public void reset() {
    remaining = BUDGET_MS;
    startedAt = -1;
  }

  public void update(boolean visibleLoading, long now) {
    remaining = remaining(now);
    startedAt = visibleLoading ? now : -1;
  }

  public long remaining(long now) {
    return Math.max(0, remaining - (startedAt < 0 ? 0 : Math.max(0, now - startedAt)));
  }

  public boolean expired(long now) {
    return startedAt >= 0 && remaining(now) == 0;
  }
}
