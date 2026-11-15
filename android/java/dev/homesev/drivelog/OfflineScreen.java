package dev.homesev.drivelog;

import android.app.Activity;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import java.util.Locale;

/**
 * 오프라인 비상 화면 — 웹 화면(서버)을 못 불러올 때(터널 속 재시작 등)
 * 네이티브로 기록 시작·종료만 할 수 있게 한다. 기록은 TrackService가 하고,
 * 끝난 기록은 폰(pending-trips)에 남았다가 웹이 다시 뜨면 서버로 올라간다.
 */
final class OfflineScreen {
  interface Host {
    void action(String action, String mode);
    void retry();
  }
  private static final int BG = 0xFF09090B, CARD = 0xFF18181B, DIM = 0xFFB3B3BD, FG = 0xFFF4F4F5;
  final View root;
  private final Activity act;
  private final Host host;
  private final Handler ui = new Handler(Looper.getMainLooper());
  private final TextView status, speed, stats, pending, place, gpsStatus;
  private final MiniMapView map;
  /** 지명은 무거운 편이라 200m 움직이거나 10초 지났을 때만 다시 찾는다 */
  private double placeLat = 0, placeLng = 0;
  private long placeAt = 0;
  private final LinearLayout idleBox, driveBox;
  private final Button pauseBtn, stopBtn;
  private long stopArmUntil = 0;
  private boolean running = false;
  OfflineScreen(Activity act, Host host) {
    this.act = act;
    this.host = host;
    LinearLayout col = new LinearLayout(act);
    col.setOrientation(LinearLayout.VERTICAL);
    int p = dp(24);
    col.setPadding(p, dp(40), p, p);
    col.addView(text("Gubi · 오프라인", 24, FG, true));
    TextView sub =
        text("인터넷이 없어도 기록은 폰에 저장되고, 연결되면 자동으로 올라가요.", 13, DIM, false);
    sub.setPadding(0, dp(6), 0, dp(20));
    col.addView(sub);
    status = text("", 14, DIM, false);
    col.addView(status);
    speed = text("0", 72, FG, true);
    col.addView(speed);
    stats = text("", 15, FG, false);
    stats.setPadding(0, 0, 0, dp(10));
    col.addView(stats);
    place = text("", 15, FG, false);
    place.setPadding(0, 0, 0, dp(6));
    col.addView(place);
    gpsStatus = text("", 14, DIM, false);
    col.addView(gpsStatus);
    map = new MiniMapView(act);
    LinearLayout.LayoutParams mlp =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(240));
    mlp.setMargins(0, dp(4), 0, dp(16));
    col.addView(map, mlp);
    OfflineGeo.preload(act);
    idleBox = new LinearLayout(act);
    idleBox.setOrientation(LinearLayout.VERTICAL);
    Button start = button("기록 시작", true);
    start.setOnClickListener(v -> host.action("start", "car"));
    idleBox.addView(start, full(dp(56), dp(12)));
    col.addView(idleBox);
    // 기록 중: 일시중지/재개 + 종료(두 번 눌러 확인)
    driveBox = new LinearLayout(act);
    driveBox.setOrientation(LinearLayout.HORIZONTAL);
    pauseBtn = button("일시중지", false);
    pauseBtn.setOnClickListener(
        v -> host.action("paused".equals(lastPhase) ? "resume" : "pause", null));
    stopBtn = button("주행 종료", false);
    stopBtn.setOnClickListener(v -> {
      long now = System.currentTimeMillis();
      if (now < stopArmUntil) {
        stopArmUntil = 0;
        host.action("stop", null);
      } else {
        stopArmUntil = now + 3000;
        refresh();
      }
    });
    LinearLayout.LayoutParams half = new LinearLayout.LayoutParams(0, dp(56), 1f);
    half.setMargins(0, 0, dp(6), 0);
    driveBox.addView(pauseBtn, half);
    driveBox.addView(stopBtn, new LinearLayout.LayoutParams(0, dp(56), 1f));
    col.addView(driveBox);
    pending = text("", 13, DIM, false);
    pending.setPadding(0, dp(20), 0, dp(8));
    col.addView(pending);
    Button retry = button("다시 연결", false);
    retry.setOnClickListener(v -> host.retry());
    col.addView(retry, full(dp(48), 0));
    ScrollView sv = new ScrollView(act);
    sv.setBackgroundColor(BG);
    sv.addView(col);
    root = sv;
    refresh();
  }
  private String lastPhase = "idle";

  void start() {
    if (running) {
      return;
    }
    running = true;
    tick();
  }

  void stop() {
    running = false;
    ui.removeCallbacksAndMessages(null);
  }

  private void tick() {
    if (!running) {
      return;
    }
    refresh();
    ui.postDelayed(this::tick, 1000);
  }

  private void refresh() {
    String phase = "idle";
    double kmh = 0, dist = 0, max = 0, lat = 0, lng = 0;
    long startTs = 0, fixTs = 0;
    int sats = -1;
    try {
      org.json.JSONObject state = new org.json.JSONObject(TrackService.getStateJson());
      phase = state.optString("phase", "idle");
      kmh = state.optDouble("kmh", 0);
      dist = state.optDouble("distM", 0);
      max = state.optDouble("maxKmh", 0);
      startTs = state.optLong("startTs", 0);
      fixTs = state.optLong("fixTs", 0);
      sats = state.optInt("sats", -1);
      lat = state.optDouble("lat", 0);
      lng = state.optDouble("lng", 0);
      if (lat == 0 && state.optLong("dTs", 0) > 0) {
        lat = state.optDouble("dLat", 0);
        lng = state.optDouble("dLng", 0);
      }
    } catch (org.json.JSONException ignored) { }
    lastPhase = phase;
    boolean active = !"idle".equals(phase);
    idleBox.setVisibility(active ? View.GONE : View.VISIBLE);
    driveBox.setVisibility(active ? View.VISIBLE : View.GONE);
    if (active) {
      long sec = Math.max(0, (System.currentTimeMillis() - startTs) / 1000);
      status.setText("주행" + ("paused".equals(phase) ? " · 일시중지" : " · 기록 중"));
      speed.setText(String.format(Locale.US, "%.0f", kmh));
      stats.setText(String.format(Locale.US, "km/h  ·  %.1f km  ·  %d:%02d:%02d  ·  최고 %.0f",
          dist / 1000, sec / 3600, (sec / 60) % 60, sec % 60, max));
      pauseBtn.setText("paused".equals(phase) ? "재개" : "일시중지");
      boolean gpsWeak = "driving".equals(phase)
          && (fixTs == 0 || System.currentTimeMillis() - fixTs > 10_000 || (sats >= 0 && sats < 4));
      gpsStatus.setText(gpsWeak ? "GPS 신호 약함" : "");
      gpsStatus.setVisibility(gpsWeak ? View.VISIBLE : View.GONE);
      updatePlace(lat, lng);
      map.setVisibility(View.VISIBLE);
      map.update(TrackService.pathSnapshot(), lat, lng, 2);
      boolean armed = System.currentTimeMillis() < stopArmUntil;
      stopBtn.setText(armed ? "한 번 더 눌러 종료" : "주행 종료");
      tint(stopBtn, armed ? 0xFF63450D : 0xFFA3202A);
    } else {
      status.setText("대기 중");
      speed.setText("0");
      stats.setText("km/h");
      place.setText("");
      gpsStatus.setVisibility(View.GONE);
      map.setVisibility(View.GONE);
    }
    int count = 0;
    try {
      count = new org.json.JSONArray(TrackService.getPendingTripsJson(act)).length();
    } catch (org.json.JSONException ignored) { }
    pending.setText(count > 0 ? "폰에 저장된 기록 " + count + "개 — 인터넷이 연결되면 올라가요"
                              : "저장 대기 기록 없음");
  }

  private void updatePlace(double lat, double lng) {
    if (lat == 0 && lng == 0) {
      place.setText("위치 찾는 중…");
      return;
    }
    OfflineGeo geo = OfflineGeo.get();
    if (geo == null) {
      place.setText("지도 자료 불러오는 중…");
      return;
    }
    long now = System.currentTimeMillis();
    if (placeAt != 0 && now - placeAt < 10_000
        && OfflineGeo.distKm(placeLat, placeLng, lat, lng) < 0.2) {
      return;
    }
    placeAt = now;
    placeLat = lat;
    placeLng = lng;
    place.setText(geo.describe(lat, lng));
  }

  // ── 작은 뷰 도우미 ──
  private TextView text(String s, float sp, int color, boolean bold) {
    TextView t = new TextView(act);
    t.setText(s);
    t.setTextSize(sp);
    t.setTextColor(color);
    if (bold) {
      t.setTypeface(Typeface.DEFAULT_BOLD);
    }
    return t;
  }

  private Button button(String s, boolean primary) {
    Button b = new Button(act);
    b.setText(s);
    b.setAllCaps(false);
    b.setMinHeight(dp(48));
    b.setMinWidth(dp(48));
    b.setTextSize(15);
    b.setTextColor(primary ? Color.WHITE : FG);
    b.setGravity(Gravity.CENTER);
    b.setStateListAnimator(null);
    tint(b, primary ? 0xFF2469D8 : CARD);
    return b;
  }

  private void tint(View v, int color) {
    GradientDrawable g = new GradientDrawable();
    g.setColor(color);
    g.setCornerRadius(dp(10));
    g.setStroke(dp(1), 0xFF3F3F46);
    v.setBackground(g);
  }
  private LinearLayout.LayoutParams full(int h, int top) {
    LinearLayout.LayoutParams lp =
        new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, h);
    lp.setMargins(0, top, 0, 0);
    return lp;
  }

  private int dp(int v) {
    return Math.round(v * act.getResources().getDisplayMetrics().density);
  }
}
