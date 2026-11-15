package dev.homesev.drivelog;

import android.app.Activity;
import android.os.*;
import org.json.*;
import java.util.*;
import dev.homesev.drivelog.pleos.PleosHub;

final class PleosFeedBridge {
  interface Host {
    void javascript(String js);
    void nativeActive();
  }
  private final Activity activity;
  private final Host host;
  private final PleosHub hub;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Set<String> pending = new HashSet<>(), cancelPending = new HashSet<>();
  private boolean registered, closed;
  private JSONObject feed;
  private long receivedAt = -1;

  PleosFeedBridge(Activity activity, Host host) {
    this.activity = activity;
    this.host = host;
    hub = PleosHub.get(activity);
  }

  boolean available() {
    return hub.available();
  }

  String support() {
    return hub.support();
  }

  void start() {
    if (closed) {
      return;
    }
    if (!registered) {
      registered = true;
      hub.listen(listener);
    }
    hub.acquire("activity-feed");
  }

  void stop() {
    hub.release("activity-feed");
  }

  String trip(double lat, double lng, String label) {
    if (!available() || !Double.isFinite(lat) || !Double.isFinite(lng) || lat < -90 || lat > 90
        || lng < -180 || lng > 180 || !text(label, 120)) {
      return "";
    }
    String id = UUID.randomUUID().toString();
    main.post(() -> {
      if (closed) {
        return;
      }
      if (pending.size() >= 16) {
        sendTripError(id, "busy");
        return;
      }
      pending.add(id);
      hub.trip(id, lat, lng, label);
      main.postDelayed(() -> {
        if (pending.remove(id)) {
          sendTripError(id, "timeout");
        }
      }, 120000);
    });
    return id;
  }

  String cancelRoute() {
    return cancel(false);
  }

  String verifyInactive() {
    return cancel(true);
  }

  private String cancel(boolean verify) {
    if (closed || "unsupported".equals(support())) {
      return null;
    }
    String id = UUID.randomUUID().toString();
    main.post(() -> {
      if (closed) {
        return;
      }
      cancelPending.add(id);
      hub.cancel(id, verify);
      main.postDelayed(() -> {
        if (cancelPending.remove(id)) {
          sendCancelFailure(id, "timeout");
        }
      }, 23000);
    });
    return id;
  }

  private void sendCancelFailure(String id, String reason) {
    try {
      emit("__pleosCancel",
          new JSONObject().put("requestId", id).put("ok", false).put("reason", reason));
    } catch (JSONException ignored) {
    }
  }

  private void sendTripError(String id, String error) {
    try {
      emit("__pleosTrip", new JSONObject().put("requestId", id).put("error", error));
    } catch (JSONException ignored) {
    }
  }

  private void emit(String callback, JSONObject data) {
    host.javascript("window." + callback + "&&window." + callback + "(JSON.parse("
        + JSONObject.quote(data.toString()) + "))");
  }

  void replay() {
    host.javascript("window.__pleosAvailability&&window.__pleosAvailability(" + available() + ")");
    if (!fresh()) {
      return;
    }
    try {
      JSONObject copy = new JSONObject(feed.toString()), ages = copy.getJSONObject("ageMs");
      long elapsed = SystemClock.elapsedRealtime() - receivedAt;
      Iterator<String> keys = ages.keys();
      while (keys.hasNext()) {
        String key = keys.next();
        if (!ages.isNull(key)) {
          ages.put(key, ages.getDouble(key) + elapsed);
        }
      }
      emit("__pleosFeed", copy);
    } catch (JSONException e) {
      android.util.Log.w("PleosFeed", "Unable to replay feed", e);
    }
  }
  private final PleosHub.Listener listener = this::onHubEvent;

  private void onHubEvent(String type, String raw) {
    if (closed) {
      return;
    }
    if ("availability".equals(type)) {
      host.javascript("window.__pleosAvailability&&window.__pleosAvailability(" + raw + ")");
      return;
    }
    if ("nativeActive".equals(type)) {
      host.nativeActive();
      host.javascript("window.__pleosNativeActive&&window.__pleosNativeActive(" + raw + ")");
      return;
    }
    if ("pleosChargerOperators".equals(type)) {
      try {
        if (raw != null && raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 4096) {
          emit("__pleosChargerOperators", new JSONObject(raw));
        }
      } catch (RuntimeException | JSONException e) {
        android.util.Log.w("PleosFeed", "Invalid charger operators", e);
      }
      return;
    }
    if ("feed".equals(type) || "trip".equals(type) || "cancel".equals(type)) {
      receive(type, raw);
    }
  }

  private void receive(String type, String raw) {
    try {
      if (raw == null || raw.length() > 8192
          || raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 8192) {
        return;
      }
      JSONObject data = new JSONObject(raw);
      if ("feed".equals(type)) {
        validateFeed(data);
        // 오래되거나 재전송된 메시지를 거른 뒤 단조 시각으로 신선도를 계산한다.
        long lag = System.currentTimeMillis() - data.getLong("ts");
        if (Math.abs(lag) >= 3000 || feed != null && data.getLong("ts") <= feed.getLong("ts")) {
          return;
        }
        // 프로세스 간 지연과 재방송에도 원본 표본의 경과 시간을 유지한다.
        JSONObject ages = data.getJSONObject("ageMs");
        java.util.Iterator<String> keys = ages.keys();
        while (keys.hasNext()) {
          String key = keys.next();
          if (!ages.isNull(key)) {
            ages.put(key, ages.getLong(key) + Math.max(0, lag));
          }
        }
        feed = data;
        receivedAt = SystemClock.elapsedRealtime();
        emit("__pleosFeed", data);
      } else if ("cancel".equals(type)) {
        string(data, "requestId", 80);
        String id = data.getString("requestId");
        if (!id.matches("[A-Za-z0-9_-]{1,80}") || !cancelPending.contains(id)) {
          return;
        }
        bool(data, "ok", false);
        if (data.has("reason") && !data.isNull("reason")) {
          string(data, "reason", 128);
        }
        cancelPending.remove(id);
        emit("__pleosCancel", data);
      } else if ("trip".equals(type)) {
        string(data, "requestId", 80);
        String id = data.getString("requestId");
        if (!id.matches("[A-Za-z0-9_-]{1,80}") || !pending.contains(id)) {
          return;
        }
        if (data.has("error")) {
          string(data, "error", 128);
        } else {
          number(data, "distanceM", 0, 1e8, false);
          number(data, "etaS", 0, 1e8, false);
          number(data, "energyWh", 0, 1e9, false);
          number(data, "socAtDestPct", 0, 100, false);
          if (data.has("traffic")) {
            org.json.JSONArray traffic = data.getJSONArray("traffic");
            if (traffic.length() > 200) {
              throw new JSONException("traffic too long");
            }
            for (int i = 0; i < traffic.length(); i++) {
              JSONObject t = traffic.getJSONObject(i);
              string(t, "t", 16);
              number(t, "s", 0, 100, false);
              number(t, "e", 0, 100, false);
            }
          }
        }
        pending.remove(id);
        emit("__pleosTrip", data);
      }
    } catch (RuntimeException | JSONException e) {
      android.util.Log.w("PleosFeed", "Rejected feed payload", e);
    }
  }

  private static boolean text(String s, int max) {
    if (s == null || s.length() > max) {
      return false;
    }
    for (int i = 0; i < s.length(); i++) {
      if (s.charAt(i) < 32) {
        return false;
      }
    }
    return true;
  }

  private static boolean num(Object v, double min, double max) {
    return v instanceof Number && Double.isFinite(((Number) v).doubleValue())
        && ((Number) v).doubleValue() >= min && ((Number) v).doubleValue() <= max;
  }

  private static void number(JSONObject o, String key, double min, double max, boolean nullable)
      throws JSONException {
    Object v = o.get(key);
    if (nullable && v == JSONObject.NULL) {
      return;
    }
    if (!num(v, min, max)) {
      throw new JSONException(key);
    }
  }

  private static void bool(JSONObject o, String key, boolean nullable) throws JSONException {
    Object v = o.get(key);
    if (nullable && v == JSONObject.NULL) {
      return;
    }
    if (!(v instanceof Boolean)) {
      throw new JSONException(key);
    }
  }

  private static void string(JSONObject o, String key, int max) throws JSONException {
    Object v = o.get(key);
    if (!(v instanceof String) || !text((String) v, max)) {
      throw new JSONException(key);
    }
  }

  private static void alerts(JSONObject o, String key, boolean camera) throws JSONException {
    JSONArray a = o.getJSONArray(key);
    if (a.length() > 3) {
      throw new JSONException(key);
    }
    double previous = 0;
    for (int i = 0; i < a.length(); i++) {
      JSONObject c = a.getJSONObject(i);
      string(c, "id", 128);
      string(c, "type", 80);
      number(c, "remainM", 1, 1e8, false);
      double d = c.getDouble("remainM");
      if (d < previous) {
        throw new JSONException("order");
      }
      previous = d;
      if (camera) {
        number(c, "limit", 1, 300, true);
        number(c, "sectionAvg", 0, 400, true);
        bool(c, "overSpeed", false);
        bool(c, "overSectionAvg", false);
      }
    }
  }

  private static void validateFeed(JSONObject o) throws JSONException {
    if (o.has("chargerOperatorCount")) {
      number(o, "chargerOperatorCount", 0, Integer.MAX_VALUE, false);
    }
    if (o.has("courseStatus")) {
      JSONObject status = o.getJSONObject("courseStatus");
      bool(status, "paused", false);
      string(status, "reason", 120);
    }
    number(o, "ts", 1, 1e15, false);
    bool(o, "naviConnected", false);
    number(o, "speedLimitKmh", 1, 300, true);
    if (o.has("arrivalWh")) {
      number(o, "arrivalWh", -1e7, 1e7, true);
    }
    if (o.has("chargeStop") && !o.isNull("chargeStop")) {
      JSONObject stop = o.getJSONObject("chargeStop");
      string(stop, "name", 120);
      number(stop, "remainWh", -1e7, 1e7, false);
      number(stop, "distanceM", 0, 1e8, true);
      number(stop, "maxKw", 1, 1000, true);
      number(stop, "chargers", 0, 1000, true);
    }
    alerts(o, "cameras", true);
    alerts(o, "cautions", false);
    JSONObject ages = o.getJSONObject("ageMs"), v = o.getJSONObject("vehicle");
    if (ages.has("arrivalWh")) {
      number(ages, "arrivalWh", 0, 1e15, true);
    }
    if (ages.has("chargeStop")) {
      number(ages, "chargeStop", 0, 1e15, true);
    }
    for (String key : new String[] {"cameras", "cautions", "speedLimitKmh", "socPct", "capacityWh",
             "gear", "cruiseKmh", "odometerKm"}) {
      number(ages, key, 0, 1e15, true);
    }
    if (!v.isNull("gear")) {
      string(v, "gear", 32);
    }
    number(v, "socPct", 0, 100, true);
    number(v, "capacityWh", 0, 1e9, true);
    number(v, "cruiseKmh", 0, 400, true);
    number(v, "odometerKm", 0, 1e9, true);
  }

  private boolean fresh() {
    return feed != null && receivedAt >= 0 && SystemClock.elapsedRealtime() - receivedAt < 3000
        && feed.optBoolean("naviConnected", false);
  }

  void close() {
    closed = true;
    stop();
    main.removeCallbacksAndMessages(null);
    pending.clear();
    cancelPending.clear();
    if (registered) {
      hub.unlisten(listener);
      registered = false;
    }
  }
}
