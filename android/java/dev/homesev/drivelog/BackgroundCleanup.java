package dev.homesev.drivelog;

import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

public final class BackgroundCleanup {
  private static final ThreadPoolExecutor worker =
      new ThreadPoolExecutor(0, 1, 5, TimeUnit.SECONDS, new LinkedBlockingQueue<>(), action -> {
        Thread thread = new Thread(action, "drivelog-location-cleanup");
        thread.setDaemon(true);
        return thread;
      });

  private BackgroundCleanup() {}

  public static void execute(Runnable action) {
    worker.execute(() -> {
      try {
        action.run();
      } catch (RuntimeException ignored) {
        // 위치 서비스가 종료돼도 후속 정리는 계속한다.
      }
    });
  }
}
