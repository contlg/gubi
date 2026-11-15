package dev.homesev.drivelog.pleos;

public final class LocalGuidanceWatch {
  private boolean allowed;

  public boolean allowed() {
    return allowed;
  }

  public void reset() {
    allowed = false;
  }

  public void verified() {
    allowed = true;
  }

  private String invalidate(String reason) {
    if (!allowed) {
      return null;
    }
    allowed = false;
    return reason;
  }

  public String disconnect() {
    return invalidate("disconnected");
  }

  public String destination() {
    return invalidate("destination");
  }

  public String route(String mode) {
    return "ROUTE_GUIDING".equals(mode) || "SIMULATION_GUIDING".equals(mode)
        ? invalidate("route_guiding")
        : null;
  }
}
