package dev.homesev.drivelog.pleos;

/** 취소는 경로 유무가 아닌 단조 시각과 연속 안전 상태로 확인한다. */
public final class CancelConfirmation {
  private final long received;
  private boolean connected, everConnected, called;
  private long safeSince = -1, lastSample = -1;
  private Boolean ok;
  private String reason;

  public CancelConfirmation(long now) {
    received = now;
  }

  public void connection(boolean value) {
    if (!value && everConnected) {
      fail("disconnected");
    }
    connected = value;
    everConnected |= value;
  }

  public void called(long now) {
    called = true;
    safeSince = -1;
    lastSample = -1;
  }

  public void route(long now, String mode) {
    if (!called || ok != null) {
      return;
    }
    boolean safe = "SAFE_GUIDING".equals(mode) || "NOT_WORKING".equals(mode);
    if (!safe) {
      safeSince = -1;
      lastSample = now;
      return;
    }
    if (safeSince < 0 || lastSample < 0 || now - lastSample > 1500) {
      safeSince = now;
    }
    lastSample = now;
  }

  public void destination() {
    safeSince = -1;
  }

  public void fail(String why) {
    if (ok == null) {
      ok = false;
      reason = why;
    }
  }

  public Boolean check(long now, boolean current) {
    if (ok != null) {
      return ok;
    }
    if (!current) {
      fail("superseded");
    } else if (now - received >= 20000) {
      fail("timeout");
    } else if (called && connected && safeSince >= 0 && now - safeSince >= 12000 && lastSample >= 0
        && now - lastSample <= 1500) {
      ok = true;
    }
    return ok;
  }

  public boolean canCall() {
    return connected && !called && ok == null;
  }

  public String reason() {
    return reason;
  }
}
