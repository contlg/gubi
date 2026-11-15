package dev.homesev.drivelog.pleos;

import java.nio.charset.StandardCharsets;
import java.util.*;

public final class PleosFeedModel {
  public static final long SAFETY_TTL_MS = 3000, VEHICLE_TTL_MS = 15000;
  public static final int MAX_BYTES = 8192;
  // 내비게이션·기록·도착 배터리 추정에 필요한 값만 받는다. 문·창문·공조·온도·타이어 값은
  // 권한을 요청하지 않으므로 피드에 아예 실리지 않는다(웹은 값이 없으면 표시하지 않는다).
  public static final String[] VEHICLE_KEYS = {"socPct", "capacityWh", "gear",
      "cruiseKmh", "odometerKm", "steeringDeg", "brake"};
  public boolean naviConnected;
  public int chargerOperatorCount;
  public boolean coursePaused;
  public String coursePauseReason = "";
  private long cameraAt = -1, cautionAt = -1, limitAt = -1, arrivalAt = -1, chargeStopAt = -1;
  private List<Map<String, Object>> cameras = new ArrayList<>(), cautions = new ArrayList<>();
  private Integer limit, arrivalWh;
  private List<Map<String, Object>> tbt = List.of();
  private long tbtAt = -1;

  public void tbt(List<Map<String, Object>> items, long now) {
    List<Map<String, Object>> valid = new ArrayList<>();
    if (items != null && items.size() <= 3) {
      for (Map<String, Object> item : items) {
        if (item == null || !(item.get("type") instanceof String)
            || !((String) item.get("type")).matches("[A-Z][A-Z0-9_]{0,63}")
            || !(item.get("text") instanceof String) || !text((String) item.get("text"), 256)
            || !(item.get("distanceM") instanceof Number)
            || number((Number) item.get("distanceM"), 0, 1e8) == null) {
          valid.clear();
          break;
        }
        valid.add(new LinkedHashMap<>(item));
      }
    }
    // 피드는 기존 1초 틱에서만 전송한다. 중복 push/poll 콜백은 추가 전송하지 않는다.
    if (!tbt.equals(valid)) {
      tbt = valid;
    }
    tbtAt = now;
  }
  private Map<String, Object> chargeStop;
  private final Map<String, Object> vehicle = new LinkedHashMap<>();
  private final Map<String, Long> vehicleAt = new HashMap<>();

  public static boolean coordinate(double lat, double lng) {
    return Double.isFinite(lat) && Double.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180
        && lng <= 180;
  }

  public static boolean requestId(String s) {
    return s != null && s.matches("[A-Za-z0-9_-]{1,80}");
  }
  public static Map<String, Object> location(double lat, double lng, Number heading,
      Number altitude, Number confidence, long tsMs, Number speedMps, long speedAgeMs) {
    if (!coordinate(lat, lng) || tsMs <= 0 || tsMs > 1000000000000000L) {
      return null;
    }
    Map<String, Object> fix = object("lat", lat, "lng", lng, "tsMs", tsMs);
    Double h = number(heading, 0, 360), a = number(altitude, -15000, 100000),
           c = number(confidence, 0, 100);
    if (h != null) {
      fix.put("heading", h);
    }
    if (a != null) {
      fix.put("altitude", a);
    }
    if (c != null) {
      fix.put("confidence", c);
    }
    Double speed = number(speedMps, -120, 120);
    if (speed != null && speedAgeMs >= 0 && speedAgeMs < 2000) {
      fix.put("speedMps", speed);
      fix.put("speedAgeMs", speedAgeMs);
    }
    return fix;
  }

  public static boolean text(String s, int max) {
    return s != null && s.length() <= max && s.chars().noneMatch(c -> c < 32);
  }

  public static Double number(Number n, double min, double max) {
    if (n == null) {
      return null;
    }
    double d = n.doubleValue();
    return Double.isFinite(d) && d >= min && d <= max ? d : null;
  }
  /** 차량 순항 속도는 m/s, 피드와 화면은 km/h를 사용한다. */
  public static Double kmh(Number metersPerSecond) {
    Double speed = number(metersPerSecond, 0, 400 / 3.6);
    return speed == null ? null : speed * 3.6;
  }
  public static Map<String, Object> object(Object... pairs) {
    Map<String, Object> m = new LinkedHashMap<>();
    for (int i = 0; i < pairs.length; i += 2) {
      m.put((String) pairs[i], pairs[i + 1]);
    }
    return m;
  }
  public static Map<String, Object> camera(
      String id, String type, int limit, int remain, boolean over, int avg, boolean overAvg) {
    if (!text(id, 128) || !text(type, 80) || remain <= 0 || remain > 100000000) {
      return null;
    }
    return object("id", id, "type", type, "limit", number(limit, 1, 300), "remainM", remain,
        "overSpeed", over, "sectionAvg", number(avg, 0, 400), "overSectionAvg", overAvg);
  }
  public static Map<String, Object> caution(String id, String type, int remain) {
    return !text(id, 128) || !text(type, 80) || remain <= 0 || remain > 100000000
        ? null
        : object("id", id, "type", type, "remainM", remain);
  }
  public static Map<String, Object> chargeStop(
      String name, int remainWh, Number distanceM, Number maxKw, Number chargers) {
    if (number(remainWh, -1e7, 1e7) == null) {
      return null;
    }
    return object("name", text(name, 120) && !name.isEmpty() ? name : "충전소", "remainWh",
        remainWh, "distanceM", number(distanceM, 0, 1e8), "maxKw", number(maxKw, 1, 1000),
        "chargers", number(chargers, 0, 1000));
  }
  static List<Map<String, Object>> nearest(List<Map<String, Object>> items) {
    List<Map<String, Object>> result = new ArrayList<>();
    if (items != null) {
      for (Map<String, Object> m : items) {
        if (m != null && m.get("remainM") instanceof Number
            && ((Number) m.get("remainM")).doubleValue() > 0) {
          result.add(new LinkedHashMap<>(m));
        }
      }
    }
    result.sort(Comparator.comparingDouble(m -> ((Number) m.get("remainM")).doubleValue()));
    return new ArrayList<>(result.subList(0, Math.min(3, result.size())));
  }

  public void cameras(List<Map<String, Object>> items, long now) {
    cameras = nearest(items);
    cameraAt = now;
  }

  public void cautions(List<Map<String, Object>> items, long now) {
    cautions = nearest(items);
    cautionAt = now;
  }

  public void speedLimit(int kmh, long now) {
    limit = kmh > 0 && kmh <= 300 ? kmh : null;
    limitAt = now;
  }

  public void arrival(int wh, long now) {
    drivingSnapshot(wh, null, now);
  }
  /** 목적지가 없는 응답으로 기존 표본을 비우거나 시각을 갱신하지 않는다. */
  public void drivingSnapshot(Integer wh, Map<String, Object> stop, long now) {
    if (wh == null) {
      return;
    }
    arrivalWh = wh >= -10000000 && wh <= 10000000 ? wh : null;
    chargeStop = stop == null ? null : new LinkedHashMap<>(stop);
    arrivalAt = chargeStopAt = now;
  }

  public void disconnected() {
    naviConnected = false;
    tbt = List.of();
    tbtAt = -1;
    cameras.clear();
    cautions.clear();
    limit = arrivalWh = null;
    chargeStop = null;
    cameraAt = cautionAt = limitAt = arrivalAt = chargeStopAt = -1;
  }

  public void vehicle(String key, Object value, long now) {
    if (!Arrays.asList(VEHICLE_KEYS).contains(key)) {
      throw new IllegalArgumentException("vehicle key");
    }
    boolean numeric = Arrays
                          .asList("socPct", "capacityWh", "cruiseKmh", "odometerKm", "steeringDeg")
                          .contains(key);
    if (numeric) {
      if (!(value instanceof Number)) {
        value = null;
      }
      double min = 0, max = 1e9;
      if (key.equals("socPct")) {
        max = 100;
      }
      if (key.equals("cruiseKmh")) {
        max = 400;
      }
      if (key.equals("steeringDeg")) {
        min = -2000;
        max = 2000;
      }
      value = number((Number) value, min, max);
      if (key.equals("steeringDeg") && value != null) {
        value = Math.round(((Number) value).doubleValue() * 10) / 10.0;
      }
    } else if (key.equals("gear")) {
      if (!(value instanceof String) || !text((String) value, 32)) {
        value = null;
      }
    } else if (!(value instanceof Boolean)) {
      value = null;
    }
    vehicle.put(key, value);
    vehicleAt.put(key, now);
  }

  static Long age(long at, long now) {
    return at < 0 ? null : Math.max(0, now - at);
  }

  static boolean fresh(long at, long now, long ttl) {
    return at >= 0 && now >= at && now - at < ttl;
  }

  public String feed(long wall, long now) {
    Map<String, Object> v = new LinkedHashMap<>(),
                        ages = object("tbt", age(tbtAt, now), "cameras", age(cameraAt, now), "cautions",
                            age(cautionAt, now), "speedLimitKmh", age(limitAt, now), "chargeStop",
                            age(chargeStopAt, now), "arrivalWh", age(arrivalAt, now));
    for (String key : VEHICLE_KEYS) {
      long at = vehicleAt.getOrDefault(key, -1L);
      v.put(key, fresh(at, now, VEHICLE_TTL_MS) ? vehicle.get(key) : null);
      ages.put(key, age(at, now));
    }
    return json(object("chargerOperatorCount", chargerOperatorCount,
        "courseStatus", object("paused", coursePaused, "reason", coursePauseReason), "ts", wall, "naviConnected", naviConnected, "ageMs", ages, "chargeStop",
        naviConnected && fresh(chargeStopAt, now, SAFETY_TTL_MS) ? chargeStop : null, "arrivalWh",
        naviConnected && fresh(arrivalAt, now, SAFETY_TTL_MS) ? arrivalWh : null, "cameras",
        naviConnected && fresh(cameraAt, now, SAFETY_TTL_MS) ? cameras : Collections.emptyList(),
        "speedLimitKmh", naviConnected ? limit : null, "cautions",
        naviConnected && fresh(cautionAt, now, SAFETY_TTL_MS) ? cautions : Collections.emptyList(),
        "vehicle", v, "tbt",
        naviConnected && fresh(tbtAt, now, 5000) ? tbt : Collections.emptyList()));
  }

  public static double[] estimate(
      double fastM, double energyWh, double courseM, double soc, double capacityWh) {
    for (double n : new double[] {fastM, energyWh, courseM, soc, capacityWh}) {
      if (!Double.isFinite(n) || n <= 0) {
        return null;
      }
    }
    if (soc > 100) {
      return null;
    }
    double wh = energyWh / fastM * courseM;
    if (!Double.isFinite(wh)) {
      return null;
    }
    return new double[] {wh / 1000, Math.max(0, soc - wh / capacityWh * 100)};
  }

  public static String json(Object value) {
    return json(value, MAX_BYTES);
  }

  public static String json(Object value, int maxBytes) {
    StringBuilder b = new StringBuilder();
    write(b, value);
    String s = b.toString();
    if (s.getBytes(StandardCharsets.UTF_8).length > maxBytes) {
      throw new IllegalArgumentException("JSON exceeds size budget");
    }
    return s;
  }

  private static void write(StringBuilder b, Object v) {
    if (v == null) {
      b.append("null");
      return;
    }
    if (v instanceof Boolean) {
      b.append(v);
      return;
    }
    if (v instanceof Number) {
      if (!Double.isFinite(((Number) v).doubleValue())) {
        throw new IllegalArgumentException("nonfinite JSON");
      }
      b.append(v);
      return;
    }
    if (v instanceof String) {
      String s = (String) v;
      if (s.length() > 256) {
        throw new IllegalArgumentException("long JSON string");
      }
      b.append('"');
      for (char c : s.toCharArray()) {
        switch (c) {
          case '"':
            b.append("\\\"");
            break;
          case '\\':
            b.append("\\\\");
            break;
          default:
            if (c < 32 || c == '\u2028' || c == '\u2029') {
              b.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
            } else {
              b.append(c);
            }
        }
      }
      b.append('"');
      return;
    }
    if (v instanceof Map) {
      b.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) v).entrySet()) {
        if (!first) {
          b.append(',');
        }
        first = false;
        write(b, e.getKey());
        b.append(':');
        write(b, e.getValue());
      }
      b.append('}');
      return;
    }
    if (v instanceof Iterable) {
      b.append('[');
      boolean first = true;
      for (Object e : (Iterable<?>) v) {
        if (!first) {
          b.append(',');
        }
        first = false;
        write(b, e);
      }
      b.append(']');
      return;
    }
    throw new IllegalArgumentException("JSON type");
  }
}
