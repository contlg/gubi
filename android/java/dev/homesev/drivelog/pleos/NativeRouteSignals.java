package dev.homesev.drivelog.pleos;

/** 완료 콜백은 요청 식별자가 없으므로 확인 조회를 앞당기는 힌트로만 쓴다. */
public final class NativeRouteSignals {
  public static final class Op {
    public final int connectionGen, courseGen;
    public final long opSeq, issuedAt;
    private long hintAt = -1;
    private boolean read, confirmed;
    private long snapshotAt = -1;
    private Op(int connection, int course, long seq, long at) {
      connectionGen = connection;
      courseGen = course;
      opSeq = seq;
      issuedAt = at;
    }
  }
  private Op op;
  private long sequence;
  private String pendingStopReason;
  private long pendingStatusAt = -1;
  private String status;
  private long statusAt = -1;

  public Op issued(int connection, int course, long at) {
    clear();
    op = new Op(connection, course, ++sequence, at);
    return op;
  }
  public void clear() {
    op = null;
    pendingStopReason = null;
    pendingStatusAt = -1;
    status = null;
    statusAt = -1;
  }
  public Op current() {
    return op;
  }
  public boolean hint(int connection, int course, long at) {
    if (op == null || op.connectionGen != connection || op.courseGen != course
        || at < op.issuedAt || op.hintAt >= 0) {
      return false;
    }
    op.hintAt = at;
    return true;
  }
  public boolean claimRead(Op token, long at) {
    if (token == null || token != op || token.read) {
      return false;
    }
    long due = token.issuedAt + 11000;
    if (token.hintAt >= 0) {
      due = Math.min(due, token.hintAt + 800);
    }
    if (at < due) {
      return false;
    }
    token.read = true;
    return true;
  }
  public static boolean guiding(String mode) {
    return "ROUTE_GUIDING".equals(mode) || "SIMULATION_GUIDING".equals(mode);
  }
  public static boolean stopped(String status) {
    return "FREE_DRIVE".equals(status) || "INACTIVE".equals(status);
  }
  public boolean status(String value, long at) {
    if (at < statusAt || op != null && at < op.issuedAt) {
      return false;
    }
    status = value;
    statusAt = at;
    if ("ROUTE_DRIVE".equals(value)) {
      pendingStopReason = null;
      pendingStatusAt = -1;
    }
    return true;
  }
  public void snapshotConfirmed(Op token, long at) {
    if (token != null && token == op && at >= token.issuedAt && token.snapshotAt < 0) {
      token.snapshotAt = at;
    }
  }
  public void sessionState(boolean waiting, boolean paused, long at) {
    if (op != null && !waiting) {
      if (paused) {
        // 실패한 요청의 확인 대기는 끝내되 보류 중인 종료 사유는 유지한다.
        op = null;
      } else {
        snapshotConfirmed(op, at);
      }
    }
  }
  public boolean guarded(long at, long lastRequest, boolean queued, boolean updating) {
    return queued || updating || op != null && op.snapshotAt < 0 && at - op.issuedAt < 30000
        || at - lastRequest < 18000 && (op == null || !op.confirmed);
  }
  public void pending(String reason) {
    pendingStopReason = reason;
    pendingStatusAt = -1;
  }
  public void pendingStatus(String reason, long at, long lastRequest, boolean queued,
      boolean updating) {
    // 자체 경로 교체 중의 일시적 FREE_DRIVE는 나중에 재사용하지 않는다.
    if (!guarded(at, lastRequest, queued, updating)
        && (op == null || at >= op.snapshotAt) && pendingStopReason == null) {
      pendingStopReason = reason;
      pendingStatusAt = at;
    }
  }
  public String routeState(String mode, long at, boolean guarded) {
    if (op != null && at < op.issuedAt || at < statusAt) {
      return null;
    }
    boolean guiding = guiding(mode);
    if (op != null && op.hintAt >= 0 && at >= op.hintAt && guiding) {
      op.confirmed = true;
    }
    if (guiding) {
      pendingStopReason = null;
      pendingStatusAt = -1;
    }
    if (guarded || pendingStopReason == null
        || pendingStatusAt >= 0 && at - pendingStatusAt < 2000) {
      return null;
    }
    String reason = pendingStopReason;
    pendingStopReason = null;
    pendingStatusAt = -1;
    return reason;
  }
}
