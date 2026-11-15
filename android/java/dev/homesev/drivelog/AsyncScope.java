package dev.homesev.drivelog;

import java.util.concurrent.Executor;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/** 닫힌 작업 범위에서는 대기 작업과 결과 전달을 실행하지 않는다. */
public final class AsyncScope {
  private final Executor worker, results;
  private final Consumer<RuntimeException> errors;
  private final AtomicBoolean closed = new AtomicBoolean();

  public AsyncScope(Executor worker, Executor results, Consumer<RuntimeException> errors) {
    this.worker = worker;
    this.results = results;
    this.errors = errors;
  }

  private void submit(Executor executor, Runnable action) {
    try {
      executor.execute(() -> {
        try {
          action.run();
        } catch (RuntimeException e) {
          errors.accept(e);
        }
      });
    } catch (RuntimeException e) {
      if (!closed.get()) {
        errors.accept(e);
      }
    }
  }

  public void execute(Runnable action) {
    if (!closed.get()) {
      submit(worker, () -> {
        if (!closed.get()) {
          action.run();
        }
      });
    }
  }

  public void deliver(Runnable action) {
    if (!closed.get()) {
      submit(results, () -> {
        if (!closed.get()) {
          action.run();
        }
      });
    }
  }

  public void close(Runnable cleanup) {
    if (closed.compareAndSet(false, true)) {
      submit(worker, cleanup);
    }
  }
}
