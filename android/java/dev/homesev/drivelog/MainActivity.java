package dev.homesev.drivelog;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.GeolocationPermissions;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * Gubi 껍데기 — WebView가 drivelog 웹앱을 그대로 띄운다 (서버에서
 * 고치면 앱도 즉시 반영). window.DriveNative 브리지로 웹이 네이티브 GPS
 * 서비스를 시작/일시중지/종료하고 상태를 폴링한다.
 */
public class MainActivity extends Activity {
  /** 빌드 스크립트가 -Durl= 으로 치환할 수 있게 상수 분리 (에뮬레이터 검증용) */
  private static final String URL = BuildUrl.VALUE;
  /** WebView 안에서 허용할 유일한 호스트 — 그 외 웹주소·위치권한·브리지 차단.
   *  악성 사이트로 이동해도 네이티브 GPS/궤적/인텐트/TTS가 노출되지 않게 한다. */
  private static final String HOST = Uri.parse(BuildUrl.VALUE).getHost();
  private static java.lang.ref.WeakReference<MainActivity> live =
      new java.lang.ref.WeakReference<>(null);
  private WebView web;
  private android.widget.FrameLayout webRoot;
  private NativeNavMap nativeNavMap;
  private boolean mapGesture, gestureActive;
  private float mapDownX, mapDownY;
  private android.view.MotionEvent lastTouch;
  private UxGate uxGate;
  private NavFocus navFocus;
  private volatile PleosFeedBridge pleosFeed;
  private dev.homesev.drivelog.pleos.PleosHub hub() {
    return dev.homesev.drivelog.pleos.PleosHub.get(this);
  }
  private <T> T onMain(java.util.concurrent.Callable<T> action, T fallback) {
    try {
      if (android.os.Looper.myLooper() == android.os.Looper.getMainLooper()) {
        return action.call();
      }
      java.util.concurrent.FutureTask<T> task = new java.util.concurrent.FutureTask<>(action);
      runOnUiThread(task);
      return task.get();
    } catch (Exception e) {
      android.util.Log.w("Fundrive", "Native action failed", e);
      return fallback;
    }
  }

  private void muteLocalAudio() {
    pleosAudioOwned = true;
    getPreferences(MODE_PRIVATE).edit().putBoolean("pleosAudioOwned", true).apply();
    if (tts != null) {
      tts.stop();
    }
    if (focusReq != null) {
      ((android.media.AudioManager) getSystemService(AUDIO_SERVICE))
          .abandonAudioFocusRequest(focusReq);
    }
  }
  private final TrackService.RecordingListener recordingListener = (id, ok, reason) -> {
    try {
      org.json.JSONObject data =
          new org.json.JSONObject().put("id", id).put("ok", ok).put("reason", reason);
      if (web != null && hostAllowed(web.getUrl())) {
        web.evaluateJavascript(
            "window.__driveRecording&&window.__driveRecording(" + data + ")", null);
      }
    } catch (org.json.JSONException e) {
      android.util.Log.w("Fundrive", "Recording result", e);
    }
  };
  private boolean courseSetupRestricted = true;
  /** 차량이 알려 준 주행 제한 상태. 서비스를 못 쓰거나 값을 모르면 false. */
  private volatile boolean uxRestricted;
  private volatile boolean pleosAudioOwned;
  /** 웹 화면을 못 불러올 때 대신 띄우는 네이티브 기록 화면 */
  private OfflineScreen offline;
  private boolean showingOffline = false;
  /** 이번 메인 페이지 로드가 실패했는지 — onPageFinished에서 화면 전환 판단 */
  private boolean mainFrameFailed = false;
  /** 위치 권한을 한 번이라도 시스템 다이얼로그로 물었는지 — 최초 요청과
   *  "다시 묻지 않음" 영구 거부를 구분해 재요청/설정점프를 고른다. */
  private boolean askedLocationOnce = false;
  // 자체 내비 음성 — WebView는 speechSynthesis가 안 돼서 네이티브 TTS.
  // 내비 안내 오디오 속성 + 재생 중 음악은 잠깐 줄인다(덕킹).
  private android.speech.tts.TextToSpeech tts;
  private volatile boolean ttsReady = false;
  private android.media.AudioFocusRequest focusReq;
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    QueueOwner.suspend();
    live = new java.lang.ref.WeakReference<>(this);
    // 권한 — 위치(필수) + 알림(13+)
    java.util.ArrayList<String> perms = new java.util.ArrayList<>();
    if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
        != PackageManager.PERMISSION_GRANTED) {
      perms.add(Manifest.permission.ACCESS_FINE_LOCATION);
      askedLocationOnce = true;
    }
    if (checkSelfPermission("pleos.car.permission.FUSED_LOCATION")
        != PackageManager.PERMISSION_GRANTED) {
      perms.add("pleos.car.permission.FUSED_LOCATION");
    }
    if (Build.VERSION.SDK_INT >= 33
        && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
            != PackageManager.PERMISSION_GRANTED) {
      perms.add(Manifest.permission.POST_NOTIFICATIONS);
    }
    if (!perms.isEmpty()) {
      requestPermissions(perms.toArray(new String[0]), 1);
    }
    web = new WebView(this);
    webRoot = new android.widget.FrameLayout(this);
    webRoot.addView(web, new android.widget.FrameLayout.LayoutParams(-1, -1));
    nativeNavMap =
        new NativeNavMap(this, webRoot, web, this::cancelRoutedGesture, this::cancelMapGesture);
    web.addOnLayoutChangeListener(
        (v, l, t, r, b, ol, ot, or, ob) -> nativeMapAction(() -> nativeNavMap.layout()));
    WebSettings s = web.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setGeolocationEnabled(true);
    s.setMediaPlaybackRequiresUserGesture(false);
    // 빌려쓰기 모드: /gubi 화면만 Firebase에서 받아 drivelog 주소 아래에 보여 준다.
    final BorrowUi borrowUi = BuildConfig.BORROW_UI
        ? new BorrowUi(this, URL, BuildConfig.UI_ORIGIN, BuildConfig.UI_PREFIX) : null;
    web.setWebViewClient(new WebViewClient() {
      // 웹 화면 프로세스가 죽어도(메모리 부족 등) 앱 전체를 죽이지 않는다.
      // 죽은 화면을 떼어 내고 액티비티를 다시 만들어 화면만 새로 띄운다. 주행 기록 서비스는 그대로 돈다.
      @Override
      public boolean onRenderProcessGone(WebView v, android.webkit.RenderProcessGoneDetail detail) {
        FundriveDiag.log("webview render gone crashed=" + detail.didCrash());
        android.view.ViewParent parent = v.getParent();
        if (parent instanceof android.view.ViewGroup) {
          ((android.view.ViewGroup) parent).removeView(v);
        }
        v.destroy();
        if (v == web && !isFinishing()) {
          recreate();
        }
        return true;
      }
      // 입출력 스레드에서 불린다 — 화면은 건드리지 않는다. 바꿔 줄 요청이 아니면 null.
      @Override
      public android.webkit.WebResourceResponse shouldInterceptRequest(
          WebView v, android.webkit.WebResourceRequest req) {
        if (borrowUi != null) {
          try {
            android.webkit.WebResourceResponse r = borrowUi.intercept(req);
            if (r != null) {
              return r;
            }
          } catch (RuntimeException e) {
            android.util.Log.w("FundriveBorrow", "intercept failed", e);
          }
        }
        return super.shouldInterceptRequest(v, req);
      }
      // 신뢰 웹 주소는 앱 안에서, 그 외 링크는 시스템에 전달한다.
      @Override
      public boolean shouldOverrideUrlLoading(WebView v, String url) {
        if (url.startsWith("http://") || url.startsWith("https://")) {
          // 신뢰 호스트만 앱 내부에서 연다. 그 외 웹주소는 외부 브라우저로
          // 보내 WebView 안에서 네이티브 브리지에 닿지 못하게 한다.
          if (hostAllowed(url)) {
            return false;
          }
          try {
            Intent ext = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            ext.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(ext);
          } catch (Exception e) {
            // 열 앱 없음 — 무시
          }
          return true;
        }
        try {
          Intent i = url.startsWith("intent:") ? Intent.parseUri(url, Intent.URI_INTENT_SCHEME)
                                               : new Intent(Intent.ACTION_VIEW, Uri.parse(url));
          i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          startActivity(i);
        } catch (Exception e) {
          // 대상 앱 없음 — 무시 (페이지가 폴백을 안내)
        }
        return true;
      }
      @Override
      public void onPageStarted(WebView v, String url, android.graphics.Bitmap icon) {
        mainFrameFailed = false;
        nativeMapAction(() -> nativeNavMap.hide());
      }
      @Override
      public void onReceivedError(
          WebView v, android.webkit.WebResourceRequest req, android.webkit.WebResourceError err) {
        if (req.isForMainFrame()) {
          mainFrameFailed = true;
          showOffline();
        }
      }
      @Override
      public void onReceivedHttpError(WebView v, android.webkit.WebResourceRequest req,
          android.webkit.WebResourceResponse res) {
        // 서버가 죽어 5xx면 인터넷 없는 것과 같다
        if (req.isForMainFrame() && res.getStatusCode() >= 500) {
          mainFrameFailed = true;
          showOffline();
        }
      }
      @Override
      public void onPageFinished(WebView v, String url) {
        if (pleosFeed != null) {
          pleosFeed.replay();
        }
        if (!mainFrameFailed && showingOffline && hostAllowed(url)) {
          showWeb();
        }
      }
    });
    web.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onGeolocationPermissionsShowPrompt(
          String origin, GeolocationPermissions.Callback callback) {
        // 신뢰 호스트에만 위치 권한 부여 — 딴 사이트엔 거부
        boolean ok = false;
        try {
          ok = HOST != null && HOST.equals(Uri.parse(origin).getHost());
        } catch (Exception e) {
          ok = false;
        }
        callback.invoke(origin, ok, false);
      }
    });
    web.addJavascriptInterface(new Bridge(), "DriveNative");
    FundriveDiag.log("startup apk=" + BuildConfig.APK_BUILD_ID);
    TrackService.recordingListener = recordingListener;
    pleosAudioOwned = getPreferences(MODE_PRIVATE).getBoolean("pleosAudioOwned", false);
    if (BuildFlags.DEBUG) {
      WebView.setWebContentsDebuggingEnabled(true);
    }
    updateScreen();
    pleosFeed = new PleosFeedBridge(this, new PleosFeedBridge.Host() {
      public void javascript(String js) {
        if (web != null && hostAllowed(web.getUrl())) {
          web.evaluateJavascript(js, null);
        }
      }
      public void nativeActive() {
        muteLocalAudio();
      }
    });
    pleosFeed.start();
    PleosLocationSource.get(this).start("activity", null);
    navFocus = new NavFocus(() -> runOnUiThread(() -> {
      if (web != null && !isFinishing() && !isDestroyed() && hostAllowed(web.getUrl())) {
        web.evaluateJavascript(
            "window.dispatchEvent(new Event('drivenative-navfocus-lost'))", null);
      }
    }));
    uxGate = new UxGate(this, new android.os.Handler(getMainLooper()), (courseLocked, restricted) -> {
      // 코스 설정 가능 여부만 갱신한다. 지도·안내·기록 화면은 계속 표시한다.
      courseSetupRestricted = courseLocked;
      // 웹에는 차량이 실제로 알려 준 주행 제한 상태를 그대로 알린다(바뀔 때만 이벤트).
      boolean changed = uxRestricted != restricted;
      uxRestricted = restricted;
      if (changed) {
        notifyUxRestrictionChanged();
      }
    }, manager -> navFocus.attach(manager));
    // 소셜 로그인 복귀로 앱이 새로 켜졌으면 첫 화면 대신 로그인 마무리 주소로
    if (!handleAuthIntent(getIntent())) {
      web.loadUrl(URL);
    }
    initTts();
    // 지난 주행에서 못 올린 센서 원본 기록 재시도
    RawLogger.uploadPendingAsync(this);
    offline = new OfflineScreen(this, new OfflineScreen.Host() {
      @Override
      public void action(String action, String mode) {
        serviceAction(action, mode);
      }
      @Override
      public void retry() {
        web.loadUrl(URL);
      }
    });
    watchNetwork();
  }
  @Override
  protected void onStart() {
    super.onStart();
    FundriveDiag.log("activity onStart support=" + hub().support());
  }
  @Override
  protected void onResume() {
    FundriveDiag.log("activity onResume support=" + hub().support());
    super.onResume();
    activityResumed = true;
    nativeMapAction(() -> nativeNavMap.resume());
    if (pleosFeed != null) {
      pleosFeed.start();
      hub().locationPermissionGranted();
    }
    PleosLocationSource.get(this).start("activity", null);
  }
  @Override
  protected void onPause() {
    FundriveDiag.log("activity onPause support=" + hub().support());
    activityResumed = false;
    // 백그라운드에서는 안내 음성을 내지 않는다 — 말하던 것도 즉시 끊고 오디오 포커스를 돌려준다.
    stopTts();
    nativeMapAction(() -> nativeNavMap.pause());
    super.onPause();
  }

  private void notifyUxRestrictionChanged() {
    runOnUiThread(() -> {
      if (web != null && !isFinishing() && !isDestroyed() && hostAllowed(web.getUrl())) {
        web.evaluateJavascript("window.dispatchEvent(new Event('drivenative-ux'))", null);
      }
    });
  }

  /** 이 앱이 앞에 있을 때 현대 내비 안내를 끄기 시작했는가 — 몇 초 안에 가려지면 되돌아온다. */
  private volatile boolean activityResumed;
  private volatile long returnAfterCancelUntil;

  private void returnToFront() {
    try {
      startActivity(new Intent(this, MainActivity.class)
          .addFlags(Intent.FLAG_ACTIVITY_REORDER_TO_FRONT));
      FundriveDiag.log("activity returnToFront after nav cancel");
    } catch (RuntimeException e) {
      android.util.Log.w("Fundrive", "returnToFront failed", e);
    }
  }

  private void nativeMapAction(Runnable action) {
    try {
      action.run();
    } catch (RuntimeException | LinkageError error) {
      android.util.Log.w(
          "Fundrive", "Native map action failed: " + error.getClass().getSimpleName());
      try {
        if (nativeNavMap != null) {
          nativeNavMap.error();
        }
      } catch (RuntimeException | LinkageError ignored) {
      }
    }
  }
  @Override
  public boolean dispatchTouchEvent(android.view.MotionEvent event) {
    if (event.getActionMasked() == android.view.MotionEvent.ACTION_DOWN) {
      cancelRoutedGesture();
      gestureActive = true;
      mapGesture = nativeNavMap != null && nativeNavMap.ownsDown(event.getX(), event.getY());
      mapDownX = event.getX();
      mapDownY = event.getY();
    }
    if (mapGesture
        && (event.getActionMasked() == android.view.MotionEvent.ACTION_MOVE
            || event.getActionMasked() == android.view.MotionEvent.ACTION_POINTER_DOWN)
        && NativeMapGeometry.isMapGesture(mapDownX, mapDownY, event.getX(), event.getY(),
            event.getPointerCount(),
            android.view.ViewConfiguration.get(this).getScaledTouchSlop())) {
      nativeMapAction(() -> nativeNavMap.gesture());
    }
    if (lastTouch != null) {
      lastTouch.recycle();
    }
    lastTouch = android.view.MotionEvent.obtain(event);
    boolean result;
    if (mapGesture) {
      nativeMapAction(() -> nativeNavMap.touch(event));
      result = true;
    } else {
      result = super.dispatchTouchEvent(event);
    }
    if (event.getActionMasked() == android.view.MotionEvent.ACTION_UP
        || event.getActionMasked() == android.view.MotionEvent.ACTION_CANCEL) {
      gestureActive = false;
      mapGesture = false;
      if (lastTouch != null) {
        lastTouch.recycle();
        lastTouch = null;
      }
    }
    return result;
  }

  private void cancelMapGesture() {
    if (mapGesture) {
      cancelRoutedGesture();
    }
  }

  private void cancelRoutedGesture() {
    android.view.MotionEvent previous = lastTouch;
    lastTouch = null;
    boolean wasActive = gestureActive, wasMap = mapGesture;
    gestureActive = false;
    mapGesture = false;
    if (previous == null) {
      return;
    }
    try {
      if (wasActive) {
        android.view.MotionEvent cancel = android.view.MotionEvent.obtain(previous);
        cancel.setAction(android.view.MotionEvent.ACTION_CANCEL);
        try {
          if (wasMap && nativeNavMap != null) {
            nativeNavMap.touch(cancel);
          } else {
            super.dispatchTouchEvent(cancel);
          }
        } finally {
          cancel.recycle();
        }
      }
    } catch (RuntimeException | LinkageError error) {
      android.util.Log.w(
          "Fundrive", "Touch cancellation failed: " + error.getClass().getSimpleName());
    } finally {
      previous.recycle();
    }
  }
  @Override
  protected void onStop() {
    FundriveDiag.log("activity onStop support=" + hub().support());
    if (pleosFeed != null) {
      pleosFeed.stop();
    }
    PleosLocationSource.get(this).stop("activity");
    super.onStop();
    // 안내를 끈 직후 가려졌다 = 순정 내비가 앞으로 나왔다. 보이지 않는 화면 덕에 되돌아올 수 있다.
    if (android.os.SystemClock.elapsedRealtime() < returnAfterCancelUntil) {
      returnAfterCancelUntil = 0;
      returnToFront();
    }
  }

  private void sendLoc(String id, android.location.Location l) {
    String safeId = id.replaceAll("[^A-Za-z0-9_-]", "");
    String json = l == null
        ? "null"
        : String.format(java.util.Locale.US, "{\"lat\":%.7f,\"lng\":%.7f,\"acc\":%.1f}",
              l.getLatitude(), l.getLongitude(), l.getAccuracy());
    web.evaluateJavascript(
        "window.__driveLoc&&window.__driveLoc('" + safeId + "'," + json + ")", null);
  }

  private void updateScreen() {
    android.view.View target = showingOffline && offline != null ? offline.root : webRoot;
    cancelRoutedGesture();
    nativeMapAction(() -> nativeNavMap.screen(target == webRoot));
    android.view.ViewGroup parent = (android.view.ViewGroup) target.getParent();
    if (parent != null) {
      parent.removeView(target);
    }
    setContentView(target);
  }

  private void showOffline() {
    if (showingOffline) {
      return;
    }
    showingOffline = true;
    updateScreen();
    offline.start();
  }

  private void showWeb() {
    showingOffline = false;
    offline.stop();
    updateScreen();
  }

  /** 비상 화면 중 인터넷이 돌아오면 웹을 다시 불러본다 */
  private void watchNetwork() {
    android.net.ConnectivityManager cm =
        (android.net.ConnectivityManager) getSystemService(CONNECTIVITY_SERVICE);
    try {
      cm.registerDefaultNetworkCallback(new android.net.ConnectivityManager.NetworkCallback() {
        @Override
        public void onAvailable(android.net.Network n) {
          runOnUiThread(() -> {
            if (showingOffline) {
              web.loadUrl(URL);
            }
          });
          RawLogger.uploadPendingAsync(MainActivity.this);
        }
      });
    } catch (Exception ignored) {
      // 권한·기기 문제 — 다시 연결 버튼으로 대신한다
    }
  }

  private void initTts() {
    android.media.AudioAttributes attrs =
        new android.media.AudioAttributes.Builder()
            .setUsage(android.media.AudioAttributes.USAGE_ASSISTANCE_NAVIGATION_GUIDANCE)
            .setContentType(android.media.AudioAttributes.CONTENT_TYPE_SPEECH)
            .build();
    focusReq =
        new android.media.AudioFocusRequest.Builder(
            android.media.AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
            .setAudioAttributes(attrs)
            .build();
    tts = new android.speech.tts.TextToSpeech(this, status -> {
      if (status != android.speech.tts.TextToSpeech.SUCCESS) {
        return;
      }
      tts.setLanguage(java.util.Locale.KOREAN);
      tts.setAudioAttributes(attrs);
      tts.setOnUtteranceProgressListener(new android.speech.tts.UtteranceProgressListener() {
        private void release() {
          android.media.AudioManager am =
              (android.media.AudioManager) getSystemService(AUDIO_SERVICE);
          am.abandonAudioFocusRequest(focusReq);
        }
        @Override
        public void onStart(String id) {}
        @Override
        public void onDone(String id) {
          release();
        }
        @Override
        public void onError(String id) {
          release();
        }
      });
      ttsReady = true;
    });
  }

  static void debugAudioCommand(String command, String plan) {
    MainActivity a = live.get();
    if (!BuildFlags.DEBUG || a == null) {
      return;
    }
    a.runOnUiThread(() -> {
      if ("handoff".equals(command) && plan != null) {
        String js = "JSON.stringify({handed:DriveNative.startPleosCourse("
            + org.json.JSONObject.quote(plan) + "),owner:DriveNative.isPleosAudioOwned()})";
        a.web.evaluateJavascript(
            js, result -> android.util.Log.i("FundriveAudio", "BRIDGE_PROBE " + result));
      } else if ("probe".equals(command)) {
        a.speakTts("Gubi 음성 억제 검사");
        android.util.Log.i("FundriveAudio",
            "AUDIO_PROBE owned=" + a.pleosAudioOwned
                + " speaking=" + (a.tts != null && a.tts.isSpeaking()));
      }
    });
  }

  /** 재생 중인 안내 음성을 끊고 오디오 포커스를 돌려준다. */
  private void stopTts() {
    try {
      if (tts != null) {
        tts.stop();
      }
      if (focusReq != null) {
        ((android.media.AudioManager) getSystemService(AUDIO_SERVICE))
            .abandonAudioFocusRequest(focusReq);
      }
    } catch (RuntimeException e) {
      android.util.Log.w("Fundrive", "stopTts failed", e);
    }
  }

  private void speakTts(String text) {
    // 화면 앞에 있을 때만 말한다(Pleos 내비 규정: 백그라운드 안내 음성 금지).
    if (!activityResumed) {
      android.util.Log.i("FundriveAudio", "TTS_BLOCKED background");
      stopTts();
      return;
    }
    if (pleosAudioOwned) {
      android.util.Log.i("FundriveAudio", "TTS_BLOCKED owner=PLEOS");
      return;
    }
    if (!ttsReady || text == null || text.isEmpty()) {
      return;
    }
    android.util.Log.i("FundriveAudio", "TTS_REQUEST owner=DRIVELOG");
    android.media.AudioManager am = (android.media.AudioManager) getSystemService(AUDIO_SERVICE);
    am.requestAudioFocus(focusReq);
    // 새 안내가 묵은 안내를 끊는다 (실내비와 동일)
    tts.speak(text, android.speech.tts.TextToSpeech.QUEUE_FLUSH, null, "nav");
  }
  @Override
  protected void onDestroy() {
    nativeMapAction(() -> nativeNavMap.destroy());
    PleosLocationSource.get(this).stop("activity");
    if (pleosFeed != null) {
      pleosFeed.close();
    }
    if (TrackService.recordingListener == recordingListener) {
      TrackService.recordingListener = null;
    }
    // 내비 안내 주인 자리는 차 서비스 연결을 끊기 전에 돌려준다.
    if (navFocus != null) {
      navFocus.abandon();
    }
    if (uxGate != null) {
      uxGate.close();
    }
    if (tts != null) {
      tts.shutdown();
    }
    super.onDestroy();
  }
  /** singleTask 앱의 로그인 복귀 인텐트 처리. */
  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    if (BuildFlags.DEBUG && intent.getBooleanExtra("audioProbe", false)) {
      speakTts("Gubi 음성 억제 검사");
      android.util.Log.i("FundriveAudio",
          "AUDIO_PROBE owned=" + pleosAudioOwned
              + " speaking=" + (tts != null && tts.isSpeaking()));
    }
    setIntent(intent);
    handleAuthIntent(intent);
  }
  /**
   * 외부 브라우저 소셜 로그인 복귀 — drivelog://auth?code=… | linked=… | error=…
   * code는 서버의 일회용 표라 WebView가 app-exchange로 열어 세션 쿠키를 받는다.
   * 처리했으면 true.
   */
  private boolean handleAuthIntent(Intent intent) {
    if (intent == null || !Intent.ACTION_VIEW.equals(intent.getAction())) {
      return false;
    }
    Uri data = intent.getData();
    if (data == null || !"drivelog".equals(data.getScheme()) || !"auth".equals(data.getHost())) {
      return false;
    }
    // 화면 회전·재진입 때 같은 표를 다시 쓰지 않게
    intent.setData(null);
    // 빌려쓰기 모드는 drivelog에 로그인하지 않는다 — 로그인 복귀는 무시하고 평소 화면을 띄운다.
    if (BuildConfig.BORROW_UI) {
      return false;
    }
    Uri base = Uri.parse(URL);
    String origin = base.getScheme() + "://" + base.getEncodedAuthority();
    String code = data.getQueryParameter("code");
    String linked = data.getQueryParameter("linked");
    String error = data.getQueryParameter("error");
    String target;
    if (code != null && code.matches("[A-Za-z0-9_-]{43}")) {
      target = origin + "/api/auth/oauth/app-exchange?code=" + code;
    } else if (linked != null && linked.length() <= 20) {
      target = origin + "/log?linked=" + Uri.encode(linked);
    } else {
      target = origin + "/log?authError="
          + Uri.encode(error != null && error.length() <= 120 ? error : "로그인하지 못했어요");
    }
    if (showingOffline) {
      showWeb();
    }
    web.loadUrl(target);
    return true;
  }




  @Override
  public void onBackPressed() {
    if (showingOffline) {
      super.onBackPressed();
    } else if (web.canGoBack()) {
      web.goBack();
    } else {
      super.onBackPressed();
    }
  }
  /** 권한 다이얼로그 결과 — 웹 게이트가 즉시 다시 확인하도록 신호를 보낸다. */
  @Override
  public void onRequestPermissionsResult(
      int requestCode, String[] permissions, int[] grantResults) {
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    if (checkSelfPermission("pleos.car.permission.FUSED_LOCATION")
        == PackageManager.PERMISSION_GRANTED) {
      hub().locationPermissionGranted();
    }
    if (web != null) {
      web.evaluateJavascript("window.dispatchEvent(new Event('drivenative-perm'))", null);
    }
  }

  /** 앱 상세 설정 화면 열기 — 권한을 수동으로 켜게 유도(영구 거부 회복용) */
  private void openAppSettings() {
    try {
      Intent i = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
          Uri.fromParts("package", getPackageName(), null));
      i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      startActivity(i);
    } catch (Exception e) {
      // 설정 화면을 못 열면 무시 — 사용자가 수동으로 이동
    }
  }

  private boolean serviceAction(String action) {
    return serviceAction(action, null, null);
  }

  private boolean serviceAction(String action, String mode) {
    return serviceAction(action, mode, null);
  }

  private boolean serviceAction(String action, String mode, String id) {
    if ("stop".equals(action)) return TrackService.stopRecording(this);
    Intent i = new Intent(this, TrackService.class).setAction(action);
    if (mode != null) {
      i.putExtra("mode", mode);
    }
    if (id != null) {
      i.putExtra("recordingId", id);
    }
    try {
      if ("start".equals(action)) {
        i.putExtra("owner", QueueOwner.starting(this));
        i.putExtra("stopGeneration", TrackService.startGeneration());
        String denied = null;
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            != PackageManager.PERMISSION_GRANTED) {
          denied = "location_permission";
        }
        if (denied != null) {
          android.util.Log.w("Fundrive", "Recording start denied: " + denied);
          if (id != null) {
            recordingListener.result(id, false, denied);
          }
          return false;
        }
      }
      android.content.ComponentName result =
          "start".equals(action) ? startForegroundService(i) : startService(i);
      if (result == null) {
        throw new IllegalStateException("service unavailable");
      }
      return true;
    } catch (IllegalStateException | SecurityException e) {
      // API 31부터 서비스 시작 제한 예외는 IllegalStateException을 상속한다.
      android.util.Log.w("Fundrive", "Service action denied: " + action, e);
      if (id != null) {
        recordingListener.result(id, false, e.getClass().getSimpleName());
      }
      return false;
    }
  }

  /** WebView 안에서 열도록 허용된 신뢰 호스트인지 (그 외는 외부 브라우저로) */
  private boolean hostAllowed(String url) {
    try {
      return HOST != null && HOST.equals(Uri.parse(url).getHost());
    } catch (Exception e) {
      return false;
    }
  }
  /** 웹 – 네이티브 브리지 — /log 페이지가 감지해서 쓴다. 신뢰 호스트만 앱
   *  내부에서 로드되므로(shouldOverrideUrlLoading) 외부 사이트는 이 브리지에
   *  닿지 못한다. */
  private class Bridge {
    @JavascriptInterface
    public boolean kakaoNaviAvailable() {
      try {
        getPackageManager().getActivityInfo(new android.content.ComponentName(
            MainActivity.this, "dev.homesev.drivelog.KakaoNaviActivity"), 0);
        return true;
      } catch (android.content.pm.PackageManager.NameNotFoundException e) { return false; }
    }
    @JavascriptInterface
    public void openKakaoNavi() {
      runOnUiThread(() -> {
        if (web != null && hostAllowed(web.getUrl()) && kakaoNaviAvailable()) {
          startActivity(new android.content.Intent().setClassName(
              getPackageName(), "dev.homesev.drivelog.KakaoNaviActivity"));
        }
      });
    }
    @JavascriptInterface
    public String nativeNavMapStatus() {
      return nativeNavMap == null ? "unsupported" : nativeNavMap.status();
    }
    @JavascriptInterface
    public boolean nativeNavMapAvailable() {
      return "ok".equals(nativeNavMapStatus());
    }
    private void mapAction(Runnable action) {
      runOnUiThread(() -> {
        if (web != null && hostAllowed(web.getUrl())) {
          nativeMapAction(action);
        }
      });
    }
    @JavascriptInterface
    public void nativeNavMapShow(String json) {
      mapAction(() -> nativeNavMap.show(json));
    }
    @JavascriptInterface
    public void nativeNavMapHide() {
      mapAction(() -> nativeNavMap.hide());
    }
    @JavascriptInterface
    public void nativeNavMapLayout(String json) {
      mapAction(() -> nativeNavMap.layout(json));
    }
    @JavascriptInterface
    public void nativeNavMapData(String json) {
      mapAction(() -> nativeNavMap.data(json));
    }
    @JavascriptInterface
    public void nativeNavMapFix(String json) {
      mapAction(() -> nativeNavMap.fix(json));
    }
    @JavascriptInterface
    public void nativeNavMapCommand(String json) {
      mapAction(() -> nativeNavMap.command(json));
    }
    @JavascriptInterface
    public boolean notificationsAllowed() {
      return Build.VERSION.SDK_INT < 33
          || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
          == PackageManager.PERMISSION_GRANTED;
    }
    @JavascriptInterface
    public String pleosSupport() {
      return hub().support();
    }
    @JavascriptInterface
    public boolean pleosAvailable() {
      return pleosFeed != null && pleosFeed.available();
    }
    @JavascriptInterface
    public String pleosChargerOperators() {
      return hub().chargerOperators();
    }
    @JavascriptInterface
    public String pleosTrip(double lat, double lng, String label) {
      return pleosFeed == null ? "" : pleosFeed.trip(lat, lng, label);
    }
    /**
     * 현대 Pleos 차량 빌드 — 동일 프로세스에서 코스 전체를 안내한다.
     */
    @JavascriptInterface
    public String carCredentials() {
      try {
        String androidId = android.provider.Settings.Secure.getString(
            getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
        return credentialsJson(androidId, null,
            getSharedPreferences("car_identity", MODE_PRIVATE).getString("vinHash", null));
      } catch (Exception e) { return null; }
    }
    @JavascriptInterface
    public void requestCarCredentials(String requestId) {
      if (requestId == null || !requestId.matches("[A-Za-z0-9_-]{1,80}")) return;
      // 차대번호(VIN)는 더 이상 읽지 않는다(PRIVATE_CAR_INFO 권한 제거). 기기 값과 저장된 값만 쓴다.
      // Settings may use Binder: read the device material on the bridge thread.
      String device = null, cached = null;
      try {
        device = android.provider.Settings.Secure.getString(
            getContentResolver(), android.provider.Settings.Secure.ANDROID_ID);
        cached = getSharedPreferences("car_identity", MODE_PRIVATE).getString("vinHash", null);
      } catch (RuntimeException ignored) { }
      final String credentials = credentialsJson(device, null, cached);
      runOnUiThread(() -> {
        if (web != null && !isFinishing() && !isDestroyed() && hostAllowed(web.getUrl())) {
          web.evaluateJavascript("window.__driveCarCredentials&&window.__driveCarCredentials("
              + org.json.JSONObject.quote(requestId) + ","
              + (credentials == null ? "null" : org.json.JSONObject.quote(credentials)) + ")", null);
        }
      });
    }
    private String credentialsJson(String androidId, String liveVin, String cachedVin) {
      try {
        if (androidId == null || androidId.isEmpty()) return null;
        String vin = dev.homesev.drivelog.pleos.CarIdentity.fallbackVin(liveVin, cachedVin);
        String id = dev.homesev.drivelog.pleos.CarIdentity.id(androidId);
        String secret = dev.homesev.drivelog.pleos.CarIdentity.secret(androidId, getPackageName());
        org.json.JSONObject o = new org.json.JSONObject();
        o.put("id", id);
        o.put("secret", secret);
        if (vin != null) {
          o.put("vinHash", vin);
          o.put("vinSource", liveVin == null ? "cached" : "live");
          o.put("carId", dev.homesev.drivelog.pleos.CarIdentity.carId(id, vin));
          o.put("carSecret", dev.homesev.drivelog.pleos.CarIdentity.carSecret(secret, vin));
        }
        return o.toString();
      } catch (Exception e) { return null; }
    }
    @JavascriptInterface
    public void setAuthenticatedOwner(String owner, String vinHash) {
      QueueOwner.resolved(MainActivity.this, owner);
      if (QueueOwner.valid(owner) && vinHash != null && vinHash.matches("[a-f0-9]{64}")) {
        getSharedPreferences("car_identity", MODE_PRIVATE).edit().putString("vinHash", vinHash).apply();
      }
    }
    @JavascriptInterface
    public void clearAuthenticatedOwner() { QueueOwner.logout(MainActivity.this); }
    @JavascriptInterface
    public void setOfflineRecordingOwner(String owner) {
      QueueOwner.allowOffline(MainActivity.this, owner);
    }
    @JavascriptInterface
    public void setGForceOpen(boolean open) { runOnUiThread(() -> hub().gForceOpen(open)); }
    @JavascriptInterface
    public int getUnassignedTripCount() { return TrackService.unassignedCount(MainActivity.this); }
    @JavascriptInterface
    public String getVehicleTrace() { return onMain(() -> hub().vehicleTrace(), "{}"); }
    @JavascriptInterface
    public boolean adoptUnassignedTrips(String owner) {
      if (!QueueOwner.valid(owner) || !owner.equals(QueueOwner.current())) return false;
      return TrackService.adoptUnassigned(MainActivity.this, owner);
    }
    /** 차량이 알려 준 주행 제한 상태 — 바뀌면 웹에 drivenative-ux 이벤트가 간다. */
    /** 차 시스템 내비 안내 주인 자리 요청 — 받았거나 차 API를 못 쓰면 true, 거절되면 false. */
    @JavascriptInterface
    public boolean requestNavFocus() {
      return navFocus == null || navFocus.request();
    }
    /** 내비 안내 주인 자리 반납. */
    @JavascriptInterface
    public void abandonNavFocus() {
      if (navFocus != null) {
        navFocus.abandon();
      }
    }
    /** 지금 이 앱이 내비 안내 주인 자리를 갖고 있는가. */
    @JavascriptInterface
    public boolean hasNavFocus() {
      return navFocus != null && navFocus.owning();
    }
    @JavascriptInterface
    public boolean uxRestricted() {
      return uxRestricted;
    }
    @JavascriptInterface
    public boolean canStartPleosCourse() {
      String support = hub().support();
      return !courseSetupRestricted && ("connected".equals(support) || "connecting".equals(support))
          && getPackageManager().getLaunchIntentForPackage(
                 dev.homesev.drivelog.pleos.PleosHub.NAV_PACKAGE)
          != null;
    }
    @JavascriptInterface
    public String cancelPleosRoute() {
      // 순정 내비는 안내 취소 요청을 받으면 스스로 앞으로 나온다 — 그때 우리 화면을 되찾는다.
      if (activityResumed) {
        returnAfterCancelUntil = android.os.SystemClock.elapsedRealtime() + 5000;
        runOnUiThread(() -> {
          try {
            startActivity(new Intent(MainActivity.this, ReturnGraceActivity.class));
            overridePendingTransition(0, 0);
          } catch (RuntimeException e) {
            android.util.Log.w("Fundrive", "grace activity failed", e);
          }
        });
      }
      return pleosFeed == null ? null : pleosFeed.cancelRoute();
    }
    @JavascriptInterface
    public String verifyPleosInactive() {
      return pleosFeed == null ? null : pleosFeed.verifyInactive();
    }
    @JavascriptInterface
    public boolean abortProvisionalDrive() {
      return abortProvisionalDrive(null);
    }
    @JavascriptInterface
    public boolean abortProvisionalDrive(String id) {
      return onMain(() -> serviceAction("abort", null, id), false);
    }
    /** 복구 시에는 코스 작업자만 복원하고 화면을 새로 열지 않는다. */
    @JavascriptInterface
    public boolean resumePleosCourse(String json) {
      if (json == null || json.isEmpty() || json.length() > 1_000_000) {
        return false;
      }
      return onMain(() -> {
        muteLocalAudio();
        return hub().resumeCourse(json);
      }, false);
    }
    @JavascriptInterface
    public boolean startPleosCourse(String json) {
      if (json == null || json.isEmpty() || json.length() > 1_000_000) {
        return false;
      }
      return onMain(() -> {
        if (!canStartPleosCourse()) {
          return false;
        }
        Intent launcher = getPackageManager().getLaunchIntentForPackage(
            dev.homesev.drivelog.pleos.PleosHub.NAV_PACKAGE);
        if (launcher == null || !hub().startCourse(json)) {
          return false;
        }
        muteLocalAudio();
        try {
          startActivity(launcher);
          return true;
        } catch (RuntimeException e) {
          dev.homesev.drivelog.pleos.CourseOwnership.revokeAll();
          android.util.Log.w("Fundrive", "Navigation launcher failed", e);
          return false;
        }
      }, false);
    }
    /** 실제 브리지 호출을 통한 debug 자동 검사. 출시 APK에서는 실행되지 않는다. */
    @JavascriptInterface
    public boolean isPleosAudioOwned() {
      return pleosAudioOwned;
    }
    @JavascriptInterface
    public boolean useLocalAudio() {
      return onMain(() -> {
        if (!hub().localAudioAllowed()) {
          muteLocalAudio();
          return false;
        }
        pleosAudioOwned = false;
        getPreferences(MODE_PRIVATE).edit().putBoolean("pleosAudioOwned", false).apply();
        android.util.Log.i("FundriveAudio", "AUDIO_OWNER DRIVELOG confirmedInactive=true");
        return true;
      }, false);
    }
    @JavascriptInterface
    public void holdLocalAudio() {
      onMain(() -> {
        muteLocalAudio();
        return true;
      }, false);
    }
    /** 소셜 로그인 — 우리 서버 주소만 외부 브라우저로 연다(구글은 WebView 로그인을 막는다) */
    @JavascriptInterface
    public void openExternal(String url) {
      if (url == null || !url.startsWith("https://") && !url.startsWith("http://")) {
        return;
      }
      if (!hostAllowed(url)) {
        return;
      }
      // 빌려쓰기 모드는 drivelog 로그인을 쓰지 않는다.
      if (BuildConfig.BORROW_UI) {
        return;
      }
      runOnUiThread(() -> {
        try {
          Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
          i.addCategory(Intent.CATEGORY_BROWSABLE);
          i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
          startActivity(i);
        } catch (Exception e) {
          // 브라우저 없음 — 무시
        }
      });
    }
    @JavascriptInterface
    public String start() {
      return startMode("car", java.util.UUID.randomUUID().toString());
    }
    @JavascriptInterface
    public String startMode(String mode) {
      return startMode(mode, null);
    }
    /** 서비스가 실제 전경 기록 상태에 들어간 뒤에만 시작 식별자를 승인한다. */
    @JavascriptInterface
    public String startMode(String mode, String id) {
      if (!"car".equals(mode)) return null;
      String requestId = id != null && id.matches("[A-Za-z0-9_-]{1,80}")
          ? id
          : java.util.UUID.randomUUID().toString();
      return onMain(() -> {
        muteLocalAudio();
        return serviceAction("start", mode, requestId) ? requestId : null;
      }, null);
    }
    /** 폰에 남은 마감 기록들(웹 없이 끝난 기록) — JSON 배열 (1.4+) */
    @JavascriptInterface
    public String getPendingTrips() {
      return TrackService.getPendingTripsJson(MainActivity.this);
    }
    /**
     * 폰이 마지막으로 알던 위치(구글 통합/GPS/네트워크 중 가장 최근, 30분 이내) —
     * {"lat","lng","acc","age"} 또는 "" (1.5+)
     */
    private String locationJson(android.location.Location l) {
      return String.format(java.util.Locale.US,
          "{\"lat\":%.7f,\"lng\":%.7f,\"acc\":%.1f,\"age\":%d}", l.getLatitude(), l.getLongitude(),
          l.getAccuracy(), Math.max(0, System.currentTimeMillis() - l.getTime()));
    }
    @JavascriptInterface
    public String getLastLocation() {
      android.location.LocationManager lm =
          (android.location.LocationManager) getSystemService(LOCATION_SERVICE);
      android.location.Location best = PleosLocationSource.get(MainActivity.this).fresh();
      if (best != null) {
        return locationJson(best);
      }
      for (String pv : new String[] {"fused", "gps", "network"}) {
        try {
          android.location.Location l = lm.getLastKnownLocation(pv);
          if (l != null && (best == null || l.getTime() > best.getTime())) {
            best = l;
          }
        } catch (SecurityException | IllegalArgumentException ignored) {
        }
      }
      if (best == null) {
        return "";
      }
      long age = System.currentTimeMillis() - best.getTime();
      if (age > 30 * 60_000L) {
        return "";
      }
      return String.format(java.util.Locale.US,
          "{\"lat\":%.7f,\"lng\":%.7f,\"acc\":%.1f,\"age\":%d}", best.getLatitude(),
          best.getLongitude(), best.getAccuracy(), age);
    }
    /**
     * 지금 위치를 새로 한 번 받는다(구글 통합 위치, 카카오맵과 같은 방식). 결과는
     * window.__driveLoc(id, json|null)로 돌려준다 (1.5+)
     */
    @JavascriptInterface
    public void requestCurrentLocation(final String id) {
      runOnUiThread(() -> {
        android.location.Location pleos = PleosLocationSource.get(MainActivity.this).fresh();
        if (pleos != null) {
          sendLoc(id, pleos);
          return;
        }
        android.location.LocationManager lm =
            (android.location.LocationManager) getSystemService(LOCATION_SERVICE);
        String pv = Build.VERSION.SDK_INT >= 31 && lm.hasProvider("fused") ? "fused" : "gps";
        try {
          if (Build.VERSION.SDK_INT >= 31) {
            // 빠른 응답 우선(와이파이·기지국 수준) — 카카오맵처럼 먼저 대략 위치
            android.location.LocationRequest req =
                new android.location.LocationRequest.Builder(0)
                    .setQuality(android.location.LocationRequest.QUALITY_BALANCED_POWER_ACCURACY)
                    .setDurationMillis(10_000)
                    .build();
            lm.getCurrentLocation(pv, req, null, getMainExecutor(), l -> sendLoc(id, l));
          } else if (Build.VERSION.SDK_INT >= 30) {
            lm.getCurrentLocation(pv, null, getMainExecutor(), l -> sendLoc(id, l));
          } else {
            sendLoc(id, lm.getLastKnownLocation(pv));
          }
        } catch (SecurityException | IllegalArgumentException e) {
          sendLoc(id, null);
        }
      });
    }
    /** 로그인 직후 등 — 못 올린 센서 원본 기록을 지금 올린다 (1.4+) */
    @JavascriptInterface
    public void flushUploads() {
      RawLogger.uploadPendingAsync(MainActivity.this);
    }
    /** 서버/오프라인 큐로 넘긴 마감 기록 지우기 (1.4+) */
    @JavascriptInterface
    public void ackPendingTrip(String startTs) {
      try {
        TrackService.ackPendingTrip(MainActivity.this, Long.parseLong(startTs));
      } catch (NumberFormatException ignored) {
      }
    }
    @JavascriptInterface
    public boolean pause() {
      return onMain(() -> serviceAction("pause"), false);
    }
    @JavascriptInterface
    public boolean resume() {
      return onMain(() -> serviceAction("resume"), false);
    }
    @JavascriptInterface
    public String stop() {
      // Synchronous completion on main: no background service start, even after onDestroy.
      return onMain(() -> TrackService.stopResult(MainActivity.this),
          "{\"ok\":false,\"reason\":\"main_timeout\"}");
    }
    @JavascriptInterface
    public void diag(String message) {
      if (FundriveDiag.enabled() && message != null && message.length() <= 700) {
        FundriveDiag.log("web " + message.replace('\n', ' ').replace('\r', ' '));
      }
    }
    @JavascriptInterface
    public String getState() {
      return TrackService.getStateJson();
    }
    /** 주행 궤적 [[lat,lng],...] — 종료 시 웹이 한 번 읽어 기록에 붙인다 */
    @JavascriptInterface
    public String getPath() {
      return TrackService.getPathJson();
    }
    /** 자체 내비 음성 안내 */
    @JavascriptInterface
    public void speak(String text) {
      runOnUiThread(() -> speakTts(text));
    }
    /** 위치 권한 보유 여부 — 웹 게이트가 통과/차단을 정한다 */
    @JavascriptInterface
    public boolean hasLocationPermission() {
      return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
          == PackageManager.PERMISSION_GRANTED;
    }
    /**
     * 위치 권한 요청 — 최초이거나 재요청 가능(rationale)하면 시스템
     * 다이얼로그를, "다시 묻지 않음"으로 영구 거부된 상태면 앱 설정 화면을
     * 연다. 결과는 onRequestPermissionsResult가 웹에 알린다.
     */
    @JavascriptInterface
    public void requestLocation() {
      runOnUiThread(() -> {
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
            == PackageManager.PERMISSION_GRANTED) {
          web.evaluateJavascript("window.dispatchEvent(new Event('drivenative-perm'))", null);
          return;
        }
        boolean canAsk = !askedLocationOnce
            || shouldShowRequestPermissionRationale(Manifest.permission.ACCESS_FINE_LOCATION);
        if (canAsk) {
          askedLocationOnce = true;
          requestPermissions(new String[] {Manifest.permission.ACCESS_FINE_LOCATION}, 1);
        } else {
          MainActivity.this.openAppSettings();
        }
      });
    }
    /** 센서 원본 기록(테스트) 켜짐 여부 — 다음 주행부터 적용 */
    @JavascriptInterface
    public boolean isRawLog() {
      return RawLogger.isOn(MainActivity.this);
    }
    @JavascriptInterface
    public void setRawLog(boolean on) {
      RawLogger.setOn(MainActivity.this, on);
    }
    /** 앱 설정 화면 열기 — 웹 게이트의 "설정 열기" 버튼용 */
    @JavascriptInterface
    public void openAppSettings() {
      runOnUiThread(() -> MainActivity.this.openAppSettings());
    }
  }
}
