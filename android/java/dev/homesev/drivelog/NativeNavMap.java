package dev.homesev.drivelog;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.drawable.ColorDrawable;
import android.os.Handler;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;
import android.webkit.WebView;
import android.widget.FrameLayout;
import com.kakao.vectormap.*;
import com.kakao.vectormap.camera.*;
import com.kakao.vectormap.label.*;
import com.kakao.vectormap.route.*;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

final class NativeNavMap {
  private static boolean sdkInitialized;
  private final Activity activity;
  private final FrameLayout root;
  private final WebView web;
  private final Runnable cancelTouches;
  private final Runnable cancelMapTouches;
  private final Handler handler;
  private final int webBackground;
  private MapView view;
  private KakaoMap map;
  private Label car;
  private LabelLayer cameras;
  private RouteLineLayer routeLayer, traceLayer, turnLayer;
  private JSONObject geometry = new JSONObject(), fix = new JSONObject(), data = new JSONObject();
  private boolean requested, screenVisible, resumed, running, follow = true, tilt = true,
                                                              headingUp = true, sat, carOffRoute;
  private volatile boolean failed;
  private long generation, epoch;
  private double heading, zoomNudge;
  private String routeKey = "";
  private List<LatLng> routePath = new ArrayList<>();
  private final NativeMapStartupWatch startup = new NativeMapStartupWatch();
  private final Runnable watchdog = () -> {
    if (requested && screenVisible && running && map == null
        && startup.expired(SystemClock.elapsedRealtime())) {
      fail("startup_timeout");
    }
  };

  NativeNavMap(Activity activity, FrameLayout root, WebView web, Runnable cancelTouches,
      Runnable cancelMapTouches) {
    this.activity = activity;
    this.root = root;
    this.web = web;
    this.cancelTouches = cancelTouches;
    this.cancelMapTouches = cancelMapTouches;
    handler = new Handler(activity.getMainLooper());
    webBackground = web.getBackground() instanceof ColorDrawable
        ? ((ColorDrawable) web.getBackground()).getColor()
        : Color.WHITE;
  }

  String status() {
    if (!BuildConfig.NATIVE_MAP_ENABLED) {
      return "unsupported";
    }
    if (failed) {
      return "error";
    }
    if (BuildConfig.KAKAO_NATIVE_APP_KEY.trim().isEmpty()) {
      return "no_key";
    }
    try {
      Class.forName("com.kakao.vectormap.MapView", false, NativeNavMap.class.getClassLoader());
      return "ok";
    } catch (LinkageError | ClassNotFoundException e) {
      return "unsupported";
    }
  }

  private static JSONObject json(String value) {
    try {
      return new JSONObject(value);
    } catch (Exception e) {
      return new JSONObject();
    }
  }

  void show(String value) {
    JSONObject next = json(value);
    if (failed) {
      emit(next.optLong("generation"), "state", "error", "reason", "native_error");
      return;
    }
    if (!"ok".equals(status())) {
      return;
    }
    if (!next.has("mapRect")) {
      return;
    }
    if (requested) {
      hide();
    }
    generation = next.optLong("generation");
    geometry = next;
    requested = true;
    follow = true;
    tilt = true;
    headingUp = true;
    sat = false;
    zoomNudge = 0;
    data = new JSONObject();
    fix = new JSONObject();
    routeKey = "";
    routePath = new ArrayList<>();
    if (car != null) {
      car.remove();
      car = null;
    }
    startup.reset();
    if (view == null) {
      create();
    }
    if (map != null) {
      handler.removeCallbacks(watchdog);
      map.changeMapType(MapType.NORMAL);
      drawData();
      drawRoute();
      ready();
    }
    updateVisibility();
    layout();
  }

  private void create() {
    if (!sdkInitialized) {
      KakaoMapSdk.init(activity.getApplicationContext(), BuildConfig.KAKAO_NATIVE_APP_KEY);
      sdkInitialized = true;
    }
    final long token = ++epoch;
    view = new MapView(activity);
    view.setVisibility(View.GONE);
    view.setFinishManually(true);
    root.addView(view, 0, new FrameLayout.LayoutParams(1, 1));
    view.start(
        new MapLifeCycleCallback() {
          @Override
          public void onMapDestroy() {}
          @Override
          public void onMapError(Exception error) {
            final long callbackGeneration = generation;
            handler.post(() -> {
              if (token == epoch && requested && callbackGeneration == generation) {
                fail("map_error");
              }
            });
          }
        },
        new KakaoMapReadyCallback() {
          @Override
          public void onMapReady(KakaoMap kakaoMap) {
            handler.post(() -> {
              if (token != epoch || !requested || failed) {
                return;
              }
              try {
                map = kakaoMap;
                map.changeMapType(sat ? MapType.SKYVIEW : MapType.NORMAL);
                // Driving view: keep roads/routes readable without shop/amenity POIs.
                map.setPoiVisible(false);
                map.setPoiClickable(false);
                map.setBuildingHeightScale(0.01f);
                routeLayer = map.getRouteLineManager().addLayer("drive-route", 10001);
                traceLayer = map.getRouteLineManager().addLayer("drive-trace", 10000);
                turnLayer = map.getRouteLineManager().addLayer("drive-turn", 10002);
                cameras = map.getLabelManager().addLayer(LabelLayerOptions.from("drive-cameras")
                        .setCompetitionType(CompetitionType.None));
                map.setOnCameraMoveStartListener((m, gesture) -> {
                  final long callbackGeneration = generation;
                  handler.post(() -> {
                    if (token == epoch && requested && callbackGeneration == generation
                        && gesture != GestureType.Unknown) {
                      stopFollowing();
                    }
                  });
                });
                // 카메라가 움직여도 차량의 지리적 방향은 유지된다.
                handler.removeCallbacks(watchdog);
                layout();
                drawData();
                ready();
                updateVisibility();
                // 지도가 화면에 붙은 뒤에 첫 위치로 카메라를 옮긴다. 붙기 전에 옮기면 기본 위치(판교)에 머문다.
                drawFix();
              } catch (RuntimeException | LinkageError e) {
                fail("render_error");
              }
            });
          }
        });
  }

  private void ready() {
    event("state", "ready");
    event("follow", follow);
  }

  void hide() {
    requested = false;
    handler.removeCallbacks(watchdog);
    cancelMapTouches.run();
    updateVisibility();
    // 이전 세대 지도의 지연 콜백이 새 세션에 들어오지 않게 한다.
    if (map == null) {
      disposeView();
    }
  }

  void screen(boolean visible) {
    if (screenVisible != visible) {
      cancelTouches.run();
    }
    screenVisible = visible;
    updateVisibility();
  }

  void resume() {
    resumed = true;
    updateVisibility();
  }

  void pause() {
    cancelTouches.run();
    resumed = false;
    updateVisibility();
  }

  void destroy() {
    requested = false;
    handler.removeCallbacks(watchdog);
    cancelTouches.run();
    startup.update(false, SystemClock.elapsedRealtime());
    try {
      disposeView();
    } finally {
      web.setBackgroundColor(webBackground);
    }
  }

  private void disposeView() {
    ++epoch;
    if (view != null) {
      if (running) {
        view.pause();
      }
      running = false;
      view.finish();
      root.removeView(view);
      view = null;
    }
    map = null;
    car = null;
    cameras = null;
    routeLayer = null;
    traceLayer = null;
    turnLayer = null;
  }

  private void updateVisibility() {
    boolean visible = requested && screenVisible && resumed && !failed && view != null;
    web.setBackgroundColor(visible ? Color.TRANSPARENT : webBackground);
    if (view != null) {
      view.setVisibility(visible ? View.VISIBLE : View.GONE);
      if (visible && !running) {
        view.resume();
        running = true;
      } else if (!visible && running) {
        view.pause();
        running = false;
      }
    }
    long now = SystemClock.elapsedRealtime();
    boolean loading = visible && running && map == null;
    startup.update(loading, now);
    handler.removeCallbacks(watchdog);
    if (loading) {
      handler.postDelayed(watchdog, startup.remaining(now));
    }
  }

  private void fail(String reason) {
    if (failed || !requested) {
      return;
    }
    failed = true;
    event("state", "error", "reason", reason);
    try {
      hide();
    } catch (RuntimeException | LinkageError error) {
      web.setBackgroundColor(webBackground);
      android.util.Log.w(
          "Fundrive", "Native map cleanup failed: " + error.getClass().getSimpleName());
    }
  }

  void error() {
    fail("native_error");
  }

  private void event(String key, Object value) {
    event(key, value, null, null);
  }

  private void event(String key, Object value, String key2, Object value2) {
    if (!requested) {
      return;
    }
    emit(generation, key, value, key2, value2);
  }

  private void emit(long eventGeneration, String key, Object value, String key2, Object value2) {
    try {
      JSONObject event = new JSONObject().put("generation", eventGeneration).put(key, value);
      if (key2 != null) {
        event.put(key2, value2);
      }
      web.evaluateJavascript("window.__nativeNavMap?.(" + event + ")", null);
    } catch (Exception ignored) {
    }
  }

  private boolean accepts(JSONObject value) {
    return requested && !failed && value.optLong("generation", -1) == generation;
  }

  void layout(String value) {
    JSONObject next = json(value);
    if (accepts(next)) {
      geometry = next;
      layout();
    }
  }
  private NativeMapGeometry.Rect rect(JSONObject value) {
    if (value == null) {
      return new NativeMapGeometry.Rect(0, 0, 0, 0);
    }
    int[] location = new int[2];
    web.getLocationInWindow(location);
    // DOM 좌표에는 화면 배율이 반영되어 있고 뷰포트 오프셋은 제거되어 있다.
    return NativeMapGeometry.toWindow(
        new NativeMapGeometry.Rect(value.optDouble("left"), value.optDouble("top"),
            value.optDouble("right"), value.optDouble("bottom")),
        geometry.optDouble("cssScale", web.getScale()), location[0], location[1]);
  }

  void layout() {
    if (view == null || !requested) {
      return;
    }
    NativeMapGeometry.Rect r = rect(geometry.optJSONObject("mapRect"));
    if (!Double.isFinite(r.left + r.top + r.right + r.bottom)) {
      return;
    }
    int[] origin = new int[2];
    root.getLocationInWindow(origin);
    FrameLayout.LayoutParams p =
        new FrameLayout.LayoutParams(Math.max(1, (int) Math.round(r.right - r.left)),
            Math.max(1, (int) Math.round(r.bottom - r.top)));
    p.leftMargin = (int) Math.round(r.left - origin[0]);
    p.topMargin = (int) Math.round(r.top - origin[1]);
    FrameLayout.LayoutParams old = (FrameLayout.LayoutParams) view.getLayoutParams();
    if (old.width != p.width || old.height != p.height || old.leftMargin != p.leftMargin
        || old.topMargin != p.topMargin) {
      view.setLayoutParams(p);
    }
    // 상단 여백으로 카메라 대상을 지도 높이의 2/3 지점에 둔다.
    if (map != null) {
      map.setPadding(0, p.height / 3, 0, 0);
    }
  }

  boolean ownsDown(double x, double y) {
    JSONArray source = geometry.optJSONArray("exclusionRects");
    NativeMapGeometry.Rect[] exclusions =
        new NativeMapGeometry.Rect[source == null ? 0 : source.length()];
    for (int i = 0; i < exclusions.length; i++) {
      exclusions[i] = rect(source.optJSONObject(i));
    }
    return NativeMapGeometry.routeToMap(requested && screenVisible && running && map != null,
        geometry.optBoolean("blocked", true), rect(geometry.optJSONObject("mapRect")), exclusions,
        x, y);
  }

  private void stopFollowing() {
    if (follow) {
      follow = false;
      event("follow", false);
    }
  }

  void gesture() {
    if (!follow) {
      return;
    }
    stopFollowing();
    if (map != null) {
      map.moveCamera(CameraUpdateFactory.newCameraPosition(map.getCameraPosition()));
    }
  }

  boolean touch(MotionEvent event) {
    if (view == null) {
      return false;
    }
    MotionEvent copy = MotionEvent.obtain(event);
    int[] location = new int[2];
    view.getLocationInWindow(location);
    // 윈도 좌표의 터치 이벤트를 모든 포인터에 대해 지도 좌표로 바꾼다.
    copy.offsetLocation(-location[0], -location[1]);
    try {
      return view.dispatchTouchEvent(copy);
    } finally {
      copy.recycle();
    }
  }

  void data(String value) {
    JSONObject next = json(value);
    if (!accepts(next)) {
      return;
    }
    // 궤적 갱신마다 긴 경로를 다시 보내지 않도록 콘텐츠 그룹을 나눈다.
    for (String key : new String[] {"path", "colors", "cumulative", "cams", "maneuvers", "trace"}) {
      if (next.has(key)) {
        try {
          data.put(key, next.get(key));
        } catch (org.json.JSONException ignored) {
        }
      }
    }
    if (next.has("path")) {
      // 색상과 누적 거리의 인덱스를 맞추기 위해 유효하지 않은 항목도 유지한다.
      JSONArray source = data.optJSONArray("path");
      routePath = new ArrayList<>();
      if (source != null) {
        for (int i = 0; i < source.length(); i++) {
          routePath.add(point(source.optJSONObject(i)));
        }
      }
    }
    if (next.has("path") || next.has("colors") || next.has("cumulative")) {
      routeKey = "";
      if (map != null) {
        drawRoute();
      }
    }
    if (next.has("trace")) {
      drawTrace();
    }
    if (next.has("cams")) {
      drawCameras();
    }
  }

  void fix(String value) {
    JSONObject next = json(value);
    if (accepts(next)) {
      fix = next;
      double h = fix.optDouble("heading", Double.NaN);
      if (Double.isFinite(h)) {
        heading = ((h % 360) + 360) % 360;
      }
      drawFix();
    }
  }

  private static LatLng point(JSONObject p) {
    if (p == null) {
      return null;
    }
    double lat = p.optDouble("lat", Double.NaN), lng = p.optDouble("lng", Double.NaN);
    return Double.isFinite(lat) && Double.isFinite(lng) && Math.abs(lat) <= 90
            && Math.abs(lng) <= 180
        ? LatLng.from(lat, lng)
        : null;
  }

  private static List<LatLng> points(JSONArray source, int start, int end) {
    List<LatLng> out = new ArrayList<>();
    if (source != null) {
      for (int i = Math.max(0, start); i < Math.min(end, source.length()); i++) {
        LatLng p = point(source.optJSONObject(i));
        if (p != null) {
          out.add(p);
        }
      }
    }
    return out;
  }

  private float dp(float value) {
    return value * activity.getResources().getDisplayMetrics().density;
  }

  private RouteLineSegment segment(List<LatLng> path, int color, float width) {
    return RouteLineSegment.from(path).setStyles(
        RouteLineStyles.from(RouteLineStyle.from(dp(width), color)));
  }

  private void line(RouteLineLayer layer, List<LatLng> path, int color, float width) {
    if (path.size() > 1) {
      layer.addRouteLine(RouteLineOptions.from(segment(path, color, width)));
    }
  }

  private void drawData() {
    drawTrace();
    drawCameras();
  }

  private void drawTrace() {
    if (map == null || !requested) {
      return;
    }
    traceLayer.removeAll();
    JSONArray trace = data.optJSONArray("trace");
    line(traceLayer, points(trace, 0, trace == null ? 0 : trace.length()), Color.rgb(52, 211, 153),
        4);
  }

  private void drawCameras() {
    if (map == null || !requested) {
      return;
    }
    cameras.removeAll();
    JSONArray cams = data.optJSONArray("cams");
    if (cams != null) {
      for (int i = 0; i < cams.length(); i++) {
        JSONObject camera = cams.optJSONObject(i);
        LatLng at = point(camera);
        if (at == null) {
          continue;
        }
        int limit = camera.optInt("limitKmh", 0);
        cameras.addLabel(LabelOptions.from(at).setStyles(cameraIcon(limit)).setRank(100));
      }
    }
  }

  private void drawFix() {
    if (map == null || !requested) {
      return;
    }
    LatLng pos = point(fix);
    if (pos != null) {
      boolean off = fix.optBoolean("offRoute");
      if (car == null) {
        car = map.getLabelManager().getLayer().addLabel(LabelOptions.from("drive-car", pos)
                .setStyles(carIcon(off))
                .setRank(10000)
                .setTransform(TransformMethod.AbsoluteRotation));
      } else {
        car.moveTo(pos, 900);
        if (off != carOffRoute) {
          car.setStyles(carIcon(off));
        }
      }
      carOffRoute = off;
      car.rotateTo((float) Math.toRadians(heading));
    }
    drawRoute();
    camera();
  }

  private void drawRoute() {
    JSONArray colors = data.optJSONArray("colors"), cumulative = data.optJSONArray("cumulative");
    int n = routePath.size(), alongIdx = fix.optInt("alongIdx", 0),
        cut = NativeMapRoute.cut(alongIdx, n);
    boolean off = fix.optBoolean("offRoute");
    double nextAt = fix.optDouble("nextAt", Double.NaN);
    String key = alongIdx + "|" + off + "|" + nextAt;
    if (key.equals(routeKey)) {
      return;
    }
    routeKey = key;
    routeLayer.removeAll();
    turnLayer.removeAll();
    List<RouteLineSegment> segments = new ArrayList<>();
    for (int i = 0; i < n - 1;) {
      int color = routeColor(i, cut, off, colors), j = i + 1;
      while (j < n - 1 && routeColor(j, cut, off, colors) == color) {
        j++;
      }
      List<LatLng> part = routePoints(i, j + 1);
      if (part.size() > 1) {
        segments.add(segment(part, color, 5.5f));
      }
      i = j;
    }
    if (!segments.isEmpty()) {
      routeLayer.addRouteLine(RouteLineOptions.from(segments.toArray(new RouteLineSegment[0])));
    }
    if (Double.isFinite(nextAt) && cumulative != null && n > 1
        && nextAt - cumulative.optDouble(Math.max(0, Math.min(alongIdx, n - 1))) < 3000) {
      int start = Math.min(n - 1, NativeMapRoute.maneuverStart(alongIdx));
      while (start < n - 1 && cumulative.optDouble(start) < nextAt - 45) {
        start++;
      }
      int end = start;
      while (end < n - 1 && cumulative.optDouble(end) < nextAt + 55) {
        end++;
      }
      line(turnLayer, routePoints(start, end + 1), Color.WHITE, 6);
    }
  }

  private List<LatLng> routePoints(int start, int end) {
    List<LatLng> out = new ArrayList<>();
    for (int i = Math.max(0, start); i < Math.min(end, routePath.size()); i++) {
      LatLng p = routePath.get(i);
      if (p != null) {
        out.add(p);
      }
    }
    return out;
  }

  private int routeColor(int index, int cut, boolean off, JSONArray colors) {
    if (NativeMapRoute.passed(index, cut)) {
      return Color.rgb(148, 163, 184);
    }
    if (off) {
      return Color.rgb(245, 158, 11);
    }
    if (colors != null && NativeMapRoute.traffic(index, cut)) {
      try {
        return Color.parseColor(colors.optString(index, "#38bdf8"));
      } catch (IllegalArgumentException ignored) {
      }
    }
    return Color.rgb(56, 189, 248);
  }

  private void camera() {
    if (map == null || !requested || !follow) {
      return;
    }
    LatLng pos = point(fix);
    if (pos == null) {
      return;
    }
    int zoom = (int) Math.max(
        0, Math.min(21, Math.round(fix.optDouble("zoom", 17) + zoomNudge + densityBoost())));
    // height는 비워 둔다 — 0을 넣으면 zoom을 무시하고 최대 확대(21)로 붙는다(SDK 2.15.2 실측).
    map.moveCamera(
        CameraUpdateFactory.newCameraPosition(
            CameraPosition.from(
                new CameraPosition.Builder()
                    .setPosition(pos)
                    .setZoomLevel(zoom)
                    .setTiltAngle(tilt ? Math.toRadians(50) : 0)
                    .setRotationAngle(headingUp ? Math.toRadians(heading) : 0))),
        CameraAnimation.from(900, true, true));
  }

  void command(String value) {
    JSONObject command = json(value);
    if (!accepts(command)) {
      return;
    }
    switch (command.optString("cmd")) {
      case "recenter":
        follow = true;
        zoomNudge = 0;
        event("follow", true);
        camera();
        break;
      case "zoom":
        double delta = command.optDouble("d", 0);
        if (!Double.isFinite(delta) || delta == 0) {
          break;
        }
        zoomNudge = Math.max(-8, Math.min(4, zoomNudge + Math.signum(delta)));
        if (map != null && !follow) {
          CameraPosition cp = map.getCameraPosition();
          map.moveCamera(CameraUpdateFactory.zoomTo(
              Math.max(0, Math.min(21, cp.getZoomLevel() + (delta > 0 ? 1 : -1)))));
        } else {
          camera();
        }
        break;
      case "tilt":
        tilt = command.optBoolean("on");
        if (follow) {
          camera();
        } else if (map != null) {
          map.moveCamera(CameraUpdateFactory.tiltTo(tilt ? Math.toRadians(50) : 0),
              CameraAnimation.from(900, true, true));
        }
        break;
      case "headingUp":
        headingUp = command.optBoolean("on");
        if (follow) {
          camera();
        } else if (map != null) {
          map.moveCamera(CameraUpdateFactory.rotateTo(headingUp ? Math.toRadians(heading) : 0),
              CameraAnimation.from(900, true, true));
        }
        break;
      case "sat":
        sat = command.optBoolean("on");
        if (map != null) {
          map.changeMapType(sat ? MapType.SKYVIEW : MapType.NORMAL);
        }
        break;
      default:
        break;
    }
  }

  /** 차 화면은 밀도 1.0(160dpi)이라 카카오 지도가 휴대폰보다 넓고 작게 그려진다 — 아이콘만 키우고 확대는 올리지 않는다(2단계 당기면 거리 라벨이 안 읽힐 만큼 가까웠다). */
  private int densityBoost() {
    float d = activity.getResources().getDisplayMetrics().density;
    return d < 1.5f ? 0 : d < 2.5f ? 1 : 0;
  }

  /** 같은 이유로 내 차·카메라 아이콘도 키운다. */
  private float lowDensityScale() {
    return Math.max(1f, 2f / activity.getResources().getDisplayMetrics().density);
  }

  private Bitmap carIcon(boolean off) {
    int size = (int) (dp(36) * lowDensityScale());
    Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(bitmap);
    canvas.scale(size / 36f, size / 36f);
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    Path path = new Path();
    path.moveTo(18, 3);
    path.lineTo(30, 30);
    path.lineTo(18, 24);
    path.lineTo(6, 30);
    path.close();
    paint.setColor(off ? Color.rgb(245, 158, 11) : Color.rgb(34, 211, 238));
    canvas.drawPath(path, paint);
    paint.setColor(Color.rgb(12, 74, 110));
    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(2);
    canvas.drawPath(path, paint);
    return bitmap;
  }

  private Bitmap cameraIcon(int limit) {
    float k = lowDensityScale();
    int size = (int) (dp(32) * k);
    Bitmap bitmap = Bitmap.createBitmap(size, size, Bitmap.Config.ARGB_8888);
    Canvas canvas = new Canvas(bitmap);
    Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
    paint.setColor(Color.WHITE);
    canvas.drawCircle(size / 2f, size / 2f, size * .45f, paint);
    paint.setColor(Color.RED);
    paint.setStyle(Paint.Style.STROKE);
    paint.setStrokeWidth(dp(2) * k);
    canvas.drawCircle(size / 2f, size / 2f, size * .43f, paint);
    paint.setStyle(Paint.Style.FILL);
    paint.setColor(Color.BLACK);
    paint.setTextAlign(Paint.Align.CENTER);
    paint.setTextSize(dp(limit > 99 ? 10 : 12) * k);
    canvas.drawText(limit > 0 ? String.valueOf(limit) : "CAM", size / 2f,
        size / 2f - (paint.ascent() + paint.descent()) / 2, paint);
    return bitmap;
  }
}
