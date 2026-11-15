package dev.homesev.drivelog.pleos;

import java.util.LinkedHashSet;
import java.util.ArrayList;
import java.util.Set;
import java.util.function.LongSupplier;

/** 상태 변경은 메인 스레드에서만 하고 작업자 호출도 현재 소유권을 확인한다. */
public final class CourseOwnership {
  public interface Runner {
    void run(Runnable action);
  }
  private static Runner main = Runnable::run;
  private static final Set<Runnable> stops = new LinkedHashSet<>();
  private static volatile int generation;
  private static LongSupplier clock = System::nanoTime;
  private static long lastBeginAt = -1;

  private CourseOwnership() {}

  public static void mainThreadRunner(Runner runner) {
    main = runner;
  }

  public static void monotonicClock(LongSupplier source) {
    clock = source;
  }

  public static void register(Runnable stopCourse) {
    stops.add(stopCourse);
  }

  public static void unregister(Runnable stopCourse) {
    stops.remove(stopCourse);
  }

  public static int begin() {
    lastBeginAt = clock.getAsLong();
    return ++generation;
  }

  public static boolean beganAfter(long requestedAt) {
    return requestedAt > 0 && lastBeginAt > requestedAt;
  }

  public static boolean current(int g) {
    return generation == g;
  }

  public static int revokeAll() {
    int g = ++generation;
    main.run(() -> {
      RuntimeException failure = null;
      for (Runnable stop : new ArrayList<>(stops)) {
        try {
          stop.run();
        } catch (RuntimeException e) {
          if (failure == null) {
            failure = e;
          } else {
            failure.addSuppressed(e);
          }
        }
      }
      if (failure != null) {
        throw failure;
      }
    });
    return g;
  }
}
