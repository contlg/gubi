package dev.homesev.drivelog;

import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicReference;

/** 위치 등록과 해제는 같은 직렬 실행기를 사용해야 한다. */
public final class LocationRegistration {
  private final Executor worker;
  private final AtomicReference<Token> current = new AtomicReference<>();

  public LocationRegistration() {
    this(BackgroundCleanup::execute);
  }

  public LocationRegistration(Executor worker) {
    this.worker = worker;
  }
  private static final class Token {
    final Runnable remove;
    // 이 두 필드는 직렬 작업자에서만 접근한다.
    boolean attempted, removed;
    Token(Runnable remove) {
      this.remove = remove;
    }
    void remove() {
      if (attempted && !removed) {
        removed = true;
        remove.run();
      }
    }
  }

  public boolean active() {
    return current.get() != null;
  }

  public void start(Runnable register, Runnable remove) {
    Token token = new Token(remove), old = current.getAndSet(token);
    if (old != null) {
      worker.execute(old::remove);
    }
    worker.execute(() -> {
      // 이전 바인더 호출을 기다리는 동안 중단된 경우다.
      if (current.get() != token) {
        return;
      }
      token.attempted = true;
      try {
        register.run();
      } catch (RuntimeException e) {
        current.compareAndSet(token, null);
        token.remove();
        throw e;
      } finally {
        // 등록 중 중단 요청이 들어왔으므로 등록을 해제한다.
        if (current.get() != token) {
          token.remove();
        }
      }
    });
  }

  public void stop() {
    // 작업자를 기다리지 않고 즉시 무효화한다.
    Token token = current.getAndSet(null);
    if (token != null) {
      worker.execute(token::remove);
    }
  }
}
