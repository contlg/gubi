package dev.homesev.drivelog;

import android.content.*;
import dev.homesev.drivelog.pleos.PleosHub;
import android.location.Location;
import android.os.*;
import org.json.*;
import java.util.*;

final class PleosLocationSource {
  interface Listener {
    void location(Location fix);
  }
  private static PleosLocationSource instance;
  static synchronized PleosLocationSource get(Context context) {
    if (instance == null) {
      instance = new PleosLocationSource(context.getApplicationContext());
    }
    return instance;
  }
  private final Context context;
  private final Handler main = new Handler(Looper.getMainLooper());
  private final Map<String, Listener> clients = new HashMap<>();
  private volatile Location latest;
  private volatile long received = -1;
  private boolean registered;
  private final PleosHub.Listener hubListener = (type, json) -> {
    if ("location".equals(type)) {
      receive(json);
    }
  };

  private PleosLocationSource(Context context) {
    this.context = context;
  }

  boolean available() {
    return !"unsupported".equals(PleosHub.get(context).support());
  }

  void start(String client, Listener listener) {
    clients.put(client, listener);
    PleosHub hub = PleosHub.get(context);
    if (!registered) {
      registered = true;
      hub.listen(hubListener);
    }
    hub.acquire("location-" + client);
  }

  void stop(String client) {
    if (!clients.containsKey(client)) {
      return;
    }
    clients.remove(client);
    PleosHub hub = PleosHub.get(context);
    hub.release("location-" + client);
    if (clients.isEmpty() && registered) {
      hub.unlisten(hubListener);
      registered = false;
      latest = null;
      received = -1;
    }
  }

  Location fresh() {
    Location fix = latest;
    long at = received;
    if (!available() || fix == null || at < 0 || SystemClock.elapsedRealtime() - at >= 3000
        || Math.abs(System.currentTimeMillis() - fix.getTime()) >= 3000) {
      return null;
    }
    return new Location(fix);
  }

  Location freshForRecording() {
    Location fix = fresh();
    return fix != null && recordingEligible(fix) ? fix : null;
  }

  static boolean recordingEligible(Location fix) {
    Bundle extras = fix.getExtras();
    long sampled = extras == null ? -1 : extras.getLong("vehicleSpeedAtElapsedMs", -1);
    return PleosLocationMath.recordingPleos(fix.hasSpeed(),
        extras == null ? null : extras.getString("speedSource"),
        sampled < 0 ? Long.MAX_VALUE : SystemClock.elapsedRealtime() - sampled);
  }

  private static double number(JSONObject data, String key, double min, double max)
      throws JSONException {
    Object raw = data.get(key);
    if (!(raw instanceof Number)) {
      throw new JSONException(key);
    }
    double value = ((Number) raw).doubleValue();
    if (!Double.isFinite(value) || value < min || value > max) {
      throw new JSONException(key);
    }
    return value;
  }

  private void receive(String raw) {
    try {
      if (raw == null || raw.length() > 8192
          || raw.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 8192) {
        return;
      }
      JSONObject data = new JSONObject(raw);
      double lat = number(data, "lat", -90, 90), lng = number(data, "lng", -180, 180);
      long ts = (long) number(data, "tsMs", 1, 1e15), wall = System.currentTimeMillis();
      long lag = wall - ts;
      if (Math.abs(lag) >= 3000 || latest != null && ts <= latest.getTime()) {
        return;
      }
      long receipt = SystemClock.elapsedRealtimeNanos();
      Location fix = new Location("pleos");
      fix.setLatitude(lat);
      fix.setLongitude(lng);
      fix.setTime(ts);
      fix.setElapsedRealtimeNanos(PleosLocationMath.elapsedNanos(receipt, wall, ts));
      // 공개 위치 데이터에 정확도와 속도가 없어 추정값을 사용한다.
      fix.setAccuracy(10f);
      if (data.has("altitude")) {
        fix.setAltitude(number(data, "altitude", -15000, 100000));
      }
      // 의미가 확인되지 않은 값은 정확도로 사용하지 않는다.
      if (data.has("confidence")) {
        number(data, "confidence", 0, 100);
      }
      Double speed = data.has("speedMps") ? number(data, "speedMps", -120, 120) : null;
      long speedAge =
          data.has("speedAgeMs") ? (long) number(data, "speedAgeMs", 0, 1e15) : Long.MAX_VALUE;
      long sent = SystemClock.elapsedRealtime();
      long transportAge =
          sent < 0 ? Long.MAX_VALUE : Math.max(0, SystemClock.elapsedRealtime() - sent);
      if (transportAge < 2000 && PleosLocationMath.vehicleSpeed(speed, speedAge + transportAge)) {
        fix.setSpeed((float) Math.abs(speed));
        Bundle extras = new Bundle();
        extras.putString("speedSource", "vehicle");
        extras.putLong("vehicleSpeedAtElapsedMs", sent - speedAge);
        fix.setExtras(extras);
      }
      Location previous = latest;
      if (previous != null && SystemClock.elapsedRealtime() - received < 3000
          && previous.distanceTo(fix) >= 3) {
        fix.setBearing(previous.bearingTo(fix));
      } else if (data.has("heading")) {
        float heading = (float) number(data, "heading", 0, 360);
        if (fix.hasSpeed() && fix.getSpeed() > 0.5f) {
          fix.setBearing(heading);
        }
      }
      latest = fix;
      received = SystemClock.elapsedRealtime();
      for (Listener listener : new ArrayList<>(clients.values())) {
        if (listener != null) {
          listener.location(new Location(fix));
        }
      }
    } catch (RuntimeException | JSONException e) {
      android.util.Log.w("PleosLoc", "Rejected location", e);
    }
  }
}
