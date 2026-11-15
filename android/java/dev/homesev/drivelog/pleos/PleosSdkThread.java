package dev.homesev.drivelog.pleos;

import android.os.Handler;
import android.os.HandlerThread;
import dev.homesev.drivelog.AsyncScope;

final class PleosSdkThread {
  private final HandlerThread thread = new HandlerThread("pleos-sdk");
  private final Handler worker, main;
  private final java.util.concurrent.atomic.AtomicInteger leases = new java.util.concurrent.atomic.AtomicInteger(1);

  PleosSdkThread(Handler main) {
    this.main = main;
    thread.start();
    worker = new Handler(thread.getLooper());
  }

  AsyncScope scope() {
    return new AsyncScope(action -> worker.post(action),
        action -> main.post(action),
        e -> android.util.Log.w("PleosSDK", "Background operation failed", e));
  }

  void later(AsyncScope scope, Runnable action, long delay) {
    worker.postDelayed(() -> scope.execute(action), delay);
  }

  void retain() {
    leases.incrementAndGet();
  }

  void close() {
    if (leases.decrementAndGet() == 0) thread.quitSafely();
  }
}
