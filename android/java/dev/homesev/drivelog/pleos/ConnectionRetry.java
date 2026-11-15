package dev.homesev.drivelog.pleos;

/** Main-thread retry clock. A new connection may be attempted only after cleanup is queued. */
final class ConnectionRetry {
  private static final long[] DELAYS = {1000, 2000, 5000, 10000};
  private int failures;
  private long nextAt;
  void failed(long now) {
    nextAt = now + DELAYS[failures];
    failures = Math.min(failures + 1, DELAYS.length - 1);
  }
  boolean ready(long now) { return now >= nextAt; }
  void healthy() { failures = 0; nextAt = 0; }
}
