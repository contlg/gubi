package dev.homesev.drivelog.pleos;

import java.util.*;

/** Bounded independently of IMU/debug logging. Times are monotonic milliseconds since start. */
public final class VehicleTrace {
  private static final int MAX_BUCKETS = 1800, MAX_BRAKES = 2000;
  private final long started;
  private long interval = 1000, lastSteerAt = -1, brakeAt = -1, brakeMs;
  private double lastSteer, maxSteering;
  private int brakeCount;
  private Boolean braking;
  private boolean overflow, sampled;
  private final TreeMap<Long, double[][]> buckets = new TreeMap<>();
  private final List<Object> brakes = new ArrayList<>();

  public VehicleTrace(long started) {
    this.started = started;
  }

  public synchronized void sample(String key, Object value, long at) {
    long t = Math.max(0, at - started);
    if ("steeringDeg".equals(key) && value instanceof Number) {
      double v = ((Number) value).doubleValue();
      if (!Double.isFinite(v) || Math.abs(v) > 2000) {
        return;
      }
      sampled = true;
      maxSteering = Math.max(maxSteering, Math.abs(v));
      if (lastSteerAt >= 0 && (t - lastSteerAt < 100
          || Math.abs(v - lastSteer) <= 0.5 && t - lastSteerAt < 1000)) {
        return;
      }
      lastSteerAt = t;
      lastSteer = v;
      merge(buckets, interval, new double[] {t, Math.round(v * 10) / 10.0});
      while (buckets.size() > MAX_BUCKETS || interval < Math.max(1000, t / 3600)) {
        interval *= 2;
        TreeMap<Long, double[][]> compact = new TreeMap<>();
        for (double[][] pair : buckets.values()) {
          merge(compact, interval, pair[0]);
          merge(compact, interval, pair[1]);
        }
        buckets.clear();
        buckets.putAll(compact);
      }
    } else if ("brake".equals(key)) {
      // An unavailable sample closes a known pressed period instead of inventing time.
      Boolean next = value instanceof Boolean ? (Boolean) value : null;
      if (next != null) sampled = true;
      if (Objects.equals(next, braking)) {
        return;
      }
      if (Boolean.TRUE.equals(braking)) {
        brakeMs += Math.max(0, t - brakeAt);
      }
      if (Boolean.TRUE.equals(next)) {
        brakeCount++;
        brakeAt = t;
      }
      braking = next;
      if (brakes.size() < MAX_BRAKES) {
        brakes.add(Arrays.asList(t, next));
      } else {
        overflow = true;
      }
    }
  }

  private static void merge(TreeMap<Long, double[][]> into, long width, double[] point) {
    long bucket = (long) point[0] / width;
    double[][] pair = into.get(bucket);
    if (pair == null) {
      into.put(bucket, new double[][] {point, point});
    } else {
      if (point[1] < pair[0][1]) pair[0] = point;
      if (point[1] > pair[1][1]) pair[1] = point;
    }
  }

  public synchronized Map<String, Object> snapshot(long at) {
    if (!sampled) return Collections.emptyMap();
    List<Object> steering = new ArrayList<>();
    for (double[][] pair : buckets.values()) {
      double[] first = pair[0][0] <= pair[1][0] ? pair[0] : pair[1];
      double[] second = first == pair[0] ? pair[1] : pair[0];
      steering.add(Arrays.asList((long) first[0], first[1]));
      if (first != second) steering.add(Arrays.asList((long) second[0], second[1]));
    }
    long total = brakeMs + (Boolean.TRUE.equals(braking) ? Math.max(0, at - started - brakeAt) : 0);
    return PleosFeedModel.object("vehicleTrace", PleosFeedModel.object("steering", steering,
        "brake", new ArrayList<>(brakes), "brakeOverflow", overflow, "intervalMs", interval),
        "maxSteeringDeg", maxSteering, "brakeCount", brakeCount, "brakeSeconds", total / 1000.0);
  }
}
