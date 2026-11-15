package dev.homesev.drivelog;

import android.content.*;
import android.os.*;
import android.util.Log;
import ai.pleos.playground.navi.helper.NaviHelper;
import ai.pleos.playground.navi.helper.listener.NaviHelperEventListener;
import ai.pleos.playground.navi.data.*;
import ai.pleos.playground.navi.constants.NaviErrorCode;
import java.lang.reflect.Method;
import java.util.*;
import org.json.*;
import kotlin.Unit;

/** Test APK only. Read-only SDK probe; never sets destinations or changes guidance. */
public final class TrafficProbeReceiver extends BroadcastReceiver {
  private static Handler worker;
  private static NaviHelper helper;
  private static NaviHelperEventListener listener;
  private static android.location.LocationManager locationManager;
  private static android.location.OnNmeaMessageListener nmeaListener;
  private static long deadline;
  private static final String TAG = "DriveTrafficProbe";
  private static final Set<String> FIELDS = new HashSet<>(Arrays.asList(
      "getNaviMode", "isRouting", "getTrafficStatus", "getSummary",
      "getCongestionItemList", "getTrafficEventList", "getTotalCongestionAvrSpeed",
      "getTotalCongestionDist", "getTotalCongestionTime", "getLatitude", "getLongitude",
      "getHeading", "getRouteId", "getCurrentRouteIndex", "getOffset", "getDistance",
      "getTrafficCongestionTime", "getTrafficCongestionType", "getAvrSpeed", "getRoadName",
      "getStartCrossName", "getEndCrossName", "getTrafficConditions", "getCongestionType",
      "getStartRatio", "getEndRatio", "getEta", "getRoutePoints", "getPoiName"));

  private static Object encode(Object v, int depth) throws Exception {
    if (v == null) return JSONObject.NULL;
    if (v instanceof Number || v instanceof Boolean || v instanceof String) return v;
    if (v instanceof Enum) return v.toString();
    if (depth > 5) return "depth_limit";
    if (v instanceof Collection) {
      JSONArray a = new JSONArray();
      for (Object x : (Collection<?>) v) { if (a.length() >= 100) break; a.put(encode(x, depth + 1)); }
      return a;
    }
    JSONObject o = new JSONObject();
    for (Method m : v.getClass().getMethods()) {
      if (m.getParameterCount() == 0 && FIELDS.contains(m.getName())) {
        try { o.put(m.getName(), encode(m.invoke(v), depth + 1)); }
        catch (Exception e) { o.put(m.getName(), "read_error"); }
      }
    }
    return o;
  }
  private static void emit(String event, Object value) {
    try {
      JSONObject data = new JSONObject().put("elapsedMs", SystemClock.elapsedRealtime())
          .put("event", event).put("data", encode(value, 0));
      Log.i(TAG, data.toString());
    } catch (Exception e) { Log.e(TAG, "encode_failed", e); }
  }
  private static void stop() {
    if (worker != null) worker.removeCallbacksAndMessages(null);
    if (locationManager != null && nmeaListener != null) {
      locationManager.removeNmeaListener(nmeaListener);
      nmeaListener = null;
    }
    if (helper != null) {
      helper.removeListener(listener);
      helper.release();
      helper = null;
      emit("stopped", true);
    }
  }
  @Override public void onReceive(Context context, Intent intent) {
    if (worker == null) {
      HandlerThread thread = new HandlerThread("TrafficProbe"); thread.start();
      worker = new Handler(thread.getLooper());
    }
    Context app = context.getApplicationContext();
    worker.post(() -> {
      stop();
      if ("stop".equals(intent.getStringExtra("cmd"))) return;
      deadline = SystemClock.elapsedRealtime() + 150000;
      locationManager = (android.location.LocationManager) app.getSystemService(Context.LOCATION_SERVICE);
      nmeaListener = (message, timestamp) -> {
        if (message.startsWith("$GPGSA")) emit("rawGsa", message.trim());
      };
      try { locationManager.addNmeaListener(nmeaListener, worker); }
      catch (SecurityException error) { emit("rawGsaPermission", false); }
      helper = new NaviHelper(app);
      listener = new NaviHelperEventListener() {
        @Override public void onRouteStateInfo(RouteStateInfo s) { emit("routeState", s); }
        @Override public void onCurrentLocationInfo(CurrentLocationInfo p) { emit("nativeLocation", p); }
        @Override public void onTripInfo(TripInfo t) { emit("trip", t); }
        @Override public void onError(NaviErrorCode e) { emit("sdkError", e); }
      };
      helper.initialize(() -> {
        worker.post(() -> {
          helper.addListener(listener);
          emit("initialized", true);
          if ("trip".equals(intent.getStringExtra("cmd"))) {
            double latitude = intent.getDoubleExtra("latitude", Double.NaN);
            double longitude = intent.getDoubleExtra("longitude", Double.NaN);
            if (Double.isFinite(latitude) && Double.isFinite(longitude)
                && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180) {
              emit("tripRequested", true);
              helper.requestTrip(new TripRequest(latitude, longitude, "", "official-safe-traffic-probe", ""));
            } else {
              emit("tripRequestInvalid", true);
            }
          }
          worker.post(new Runnable() {
            @Override public void run() {
              if (helper == null) return;
              if (SystemClock.elapsedRealtime() >= deadline) { stop(); return; }
              try { helper.getRouteStateInfo(); helper.getCurrentLocationInfo(); }
              catch (RuntimeException e) { emit("pollError", e.getClass().getSimpleName()); }
              worker.postDelayed(this, 2000);
            }
          });
        });
        return Unit.INSTANCE;
      }, error -> { emit("initializeError", error.getClass().getSimpleName()); return Unit.INSTANCE; });
    });
  }
}
