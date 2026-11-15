package dev.homesev.drivelog;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import java.io.File;
import java.util.Locale;

/**
 * 주행 기록 포그라운드 서비스 — 화면이 꺼져도 GPS를 계속 받고,
 * 알림창에 현재 속도·거리 + [일시중지/재개] [종료] 버튼을 띄운다.
 * 상태는 static으로 들고 있고 WebView 브리지(getStateJson)가 1초마다 읽는다.
 * 웹 쪽(/log)과 같은 필터: 정확도 80m, 정지 3km/h, 점프 500m.
 */
public class TrackService extends Service implements LocationListener {
  interface RecordingListener {
    void result(String id, boolean ok, String reason);
  }
  static RecordingListener recordingListener;
  private static volatile String recordingId;
  // Accessed only on main, including notification commands and WebView bridge requests.
  private static TrackService liveService;
  private static boolean stopping;
  private static String stopFailure;
  private static int stopGeneration;
  static int startGeneration() { return stopGeneration; }
  static boolean acceptStartGeneration(int generation) { return generation == stopGeneration; }

  static String stopResult(android.content.Context context) {
    boolean ok = stopRecording(context);
    return "{\"ok\":" + ok + ",\"reason\":"
        + org.json.JSONObject.quote(ok ? "completed" : stopFailure) + "}";
  }

  static boolean stopRecording(android.content.Context context) {
    if (android.os.Looper.myLooper() != android.os.Looper.getMainLooper()) {
      throw new IllegalStateException("main thread required");
    }
    if (stopping) { stopFailure = "stopping"; return false; }
    stopping = true;
    stopGeneration++; // A stop also cancels any start intent still queued in Android.
    stopFailure = null;
    diagnostic("stop requested");
    try {
      dev.homesev.drivelog.pleos.PleosHub hub = dev.homesev.drivelog.pleos.PleosHub.get(context);
      hub.clearCourseProgress();
      hub.endRecording();
      if (liveService != null) liveService.finishStopResources();
      if (!"idle".equals(phase)) {
        // Preserve the end time on retry after a disk failure.
        if (endTs == 0) endTs = System.currentTimeMillis();
        savePendingTrip(context);
      }
      phase = "idle";
      kmh = 0;
      if (liveService != null) {
        liveService.stopForeground(STOP_FOREGROUND_REMOVE);
        liveService.stopSelf();
      }
      diagnostic("stop completed");
      return true;
    } catch (RuntimeException error) {
      stopFailure = error.getClass().getSimpleName();
      diagnostic("stop failed reason=" + stopFailure);
      android.util.Log.w("Fundrive", "Recording stop failed", error);
      return false;
    } finally {
      stopping = false;
    }
  }

  private void finishStopResources() {
    stopGps();
    if (raw != null) {
      raw.close(lm);
      raw = null;
    }
  }

  private static void diagnostic(String event) {
    FundriveDiag.log("TrackService " + event + " phase=" + phase + " serviceAlive=" + serviceAlive
        + " stopping=" + stopping);
  }
  private dev.homesev.drivelog.pleos.PleosHub hub() {
    return dev.homesev.drivelog.pleos.PleosHub.get(this);
  }

  static void recordingResult(String id, boolean ok, String reason) {
    if (recordingListener != null) {
      recordingListener.result(id, ok, reason);
    }
  }
  private PleosLocationSource pleosLocation;
  private long pleosCount, androidCount, droppedCount;
  private final android.os.Handler locMain =
      new android.os.Handler(android.os.Looper.getMainLooper());
  private final Runnable locReport = new Runnable() {
    public void run() {
      if (pleosLocation == null) {
        return;
      }
      android.util.Log.i("FundriveLoc",
          "PleosLoc pleos=" + pleosCount + " android=" + androidCount + " dropped=" + droppedCount);
      locMain.postDelayed(this, 30000);
    }
  };
  private static final String CHANNEL = "drivelog";
  private static final int NOTIF_ID = 1;
  private static final float MAX_ACCURACY_M = 80f;
  private static final float MOVING_KMH = 3f;
  private static final float MAX_JUMP_M = 500f;

  /** 픽스 간 허용 점프 상한. */
  private static float maxJump() {
    return MAX_JUMP_M;
  }
  // ── 공유 상태 (브리지가 읽음) ──
  private static volatile String phase = "idle";
  private static volatile double kmh = 0;
  private static volatile double distM = 0;
  private static volatile double maxKmh = 0;
  private static volatile double movingSec = 0;
  private static volatile long startTs = 0;
  private static volatile String tripOwner = QueueOwner.UNASSIGNED;
  private static volatile long endTs = 0;
  private static volatile double lastLat = 0;
  private static volatile double lastLng = 0;
  /** 마지막 실제 Location 콜백 시각 — WebView 폴링 반복값과 새 GPS 픽스 구분. */
  private static volatile long lastFixTs = 0;
  private static volatile boolean serviceAlive = false;
  /** GPS 고도(m, 없으면 NaN)·분당 상승(m/min)·위성(사용/보임) — 비상 화면 표시용 */
  private static volatile int satsUsed = -1, satsVisible = -1;
  /** 사용 위성이 0이 된 시각(부팅 후 ms — 폰 시계를 바꿔도 안 틀어지게) */
  private static volatile long satsZeroSince = 0;
  /**
   * 표시용 위치 — 정확도와 무관하게 가장 최근 위치(와이파이·기지국 대략 위치, 시작 시
   * 폰의 마지막 위치 포함). 카카오맵처럼 GPS 잡기 전에도 지도·주소를 먼저 보여주는 데만
   * 쓰고, 거리·속도·경로 기록엔 절대 안 쓴다(그건 lastLat/lastLng = 정확한 GPS만).
   */
  private static volatile double dispLat = 0, dispLng = 0, dispAcc = 0;
  private static volatile long dispTs = 0;
  /** 첫 픽스 위치 — "출발지에서 거리" */
  private static volatile double startLat = 0, startLng = 0;
  private android.location.GnssStatus.Callback gnssCb;
  /** 자동차 기록 모드. */
  private static final String mode = "car";
  /** 이번 기록 최고 0–50 / 0–100km/h 시간(초). 없으면 -1 */
  private static volatile double zero50 = -1, zero100 = -1;
  // 정지 출발 추적: 출발 시각(2km/h 통과, ms) — 연속성이 깨지면 -1
  private long launchT = -1;
  private boolean launchStill = false;
  private double launchPrevV = -1;
  private long launchPrevT = -1;
  /** 같은 순간들의 부팅 후 시각(ms) — 센서와 같은 시계 */
  private double launchEt = -1, launchPrevEt = -1, fixEt = -1;
  /**
   * 출발 확인용 센서 — 중력 뺀 가속도 크기(m/s²) 최근 30초. 일반 차보다 빠른 출발(0–50 2초 미만,
   * 한 픽스에 0.7G 초과)은 GPS 튐과 구별이 안 돼서, 그 순간 센서에도 그만한 가속이 찍혔을 때만 인정한다.
   */
  private android.hardware.SensorManager sensors;
  /** 터널(GPS 끊김) 속 화면 속도 — 바퀴 진동 추정. 차 모드만 */
  private WheelSpeed wheel;
  private static volatile boolean wheelEst = false;
  private final java.util.ArrayDeque<double[]> linAcc = new java.util.ArrayDeque<>();
  private final android.hardware.SensorEventListener linListener =
      new android.hardware.SensorEventListener() {
        @Override
        public void onSensorChanged(android.hardware.SensorEvent e) {
          double et = e.timestamp / 1e6;
          linAcc.addLast(new double[] {et,
              Math.sqrt(e.values[0] * e.values[0] + e.values[1] * e.values[1]
                  + e.values[2] * e.values[2])});
          while (!linAcc.isEmpty() && et - linAcc.peekFirst()[0] > 30_000) {
            linAcc.pollFirst();
          }
        }
        @Override
        public void onAccuracyChanged(android.hardware.Sensor s, int a) {}
      };

  /** 두 시각 사이 센서 가속 평균(m/s²). 센서 없음·표본 부족이면 -1 */
  private double sensorMean(double fromEt, double toEt) {
    double sum = 0;
    int n = 0;
    for (double[] a : linAcc) {
      if (a[0] >= fromEt && a[0] <= toEt) {
        sum += a[1];
        n++;
      }
    }
    return n >= 5 ? sum / n : -1;
  }
  /** GPS 진행방향(° 북 기준) — 자체 내비 지도 회전용. 없으면 -1 */
  private static volatile double bearingDeg = -1;
  // 궤적 — 20m 간격, 4000점 넘으면 절반 솎고 간격 2배 (기록 지도 표시용)
  private static final java.util.ArrayList<double[]> path = new java.util.ArrayList<>();
  private static volatile float pathMinM = 20f;
  private LocationManager lm;
  private volatile LocationListener androidListener;
  private final LocationRegistration gpsUpdates = new LocationRegistration();
  private final LocationRegistration gpsSatellites = new LocationRegistration();
  /** 센서 원본 기록 (설정에서 켰을 때만) */
  private RawLogger raw;
  private Location prev;
  /** prev 픽스에서 받아들인 속도(m/s) — 기기 속도가 0이라 거리로 계산한 값 포함. 터널 거리 채우기 판단용 */
  private double prevV = 0;
  private Location jumpCand;
  private long lastNotifAt = 0;
  /** 화면을 꺼도 CPU를 깨워둬 GPS 콜백이 끊기지 않게 하는 부분 웨이크락.
   *  포그라운드 서비스는 프로세스가 안 죽게 할 뿐 CPU 잠자기(deep sleep)를
   *  막지 못한다 — 락이 없으면 화면 잠금 후 GPS 콜백이 지연·중단돼 기록이
   *  멈춘다. GPS를 켤 때 잡고 끌 때 푼다. */
  private PowerManager.WakeLock wakeLock;

  public static String getPathJson() {
    StringBuilder sb = new StringBuilder("[");
    synchronized (path) {
      for (int i = 0; i < path.size(); i++) {
        double[] p = path.get(i);
        if (i > 0) {
          sb.append(',');
        }
        // [lat,lng,속도kmh] — 웹이 3번째 원소로 점별 속도를 읽어 속도색을 칠한다.
        // 구형 저장점(2원소)은 0으로 채워 파싱 안전.
        sb.append(
            String.format(Locale.US, "[%.5f,%.5f,%.0f]", p[0], p[1], p.length > 2 ? p[2] : 0.0));
      }
    }
    return sb.append(']').toString();
  }

  public static String getStateJson() {
    return String.format(Locale.US,
        "{\"owner\":%s,\"recordingId\":%s,\"phase\":\"%s\",\"kmh\":%.1f,\"distM\":%.0f,\"maxKmh\":%.1f,"
            + "\"movingSec\":%.0f,\"startTs\":%d,\"endTs\":%d,\"lat\":%.6f,\"lng\":%.6f,"
            + "\"brg\":%.1f,\"fixTs\":%d,\"alive\":%s,"
            + "\"mode\":\"%s\",\"z50\":%.2f,\"z100\":%.2f,\"zchk\":true,\"kmhEst\":%s,"
            + "\"sats\":%d,\"satsVis\":%d,"
            + "\"startLat\":%.6f,\"startLng\":%.6f,"
            + "\"dLat\":%.6f,\"dLng\":%.6f,\"dAcc\":%.0f,\"dTs\":%d}",
        org.json.JSONObject.quote(tripOwner), org.json.JSONObject.quote(recordingId), phase, kmh, distM, maxKmh, movingSec, startTs,
        endTs, lastLat, lastLng, bearingDeg, lastFixTs, serviceAlive ? "true" : "false",
        mode, zero50, zero100, wheelEst ? "true" : "false",
        satsUsed,
        satsVisible, startLat, startLng, dispLat, dispLng, dispAcc, dispTs);
  }

  /** 미니 지도용 궤적 사본 [[lat,lng],...] */
  static double[][] pathSnapshot() {
    synchronized (path) {
      double[][] out = new double[path.size()][];
      for (int i = 0; i < out.length; i++) {
        out[i] = new double[] {path.get(i)[0], path.get(i)[1]};
      }
      return out;
    }
  }
  @Override
  public void onCreate() {
    super.onCreate();
    serviceAlive = true;
    liveService = this;
    diagnostic("onCreate");
  }
  @Override
  public void onDestroy() {
    hub().endRecording();
    stopGps();
    if (raw != null) {
      raw.close(lm);
      raw = null;
    }
    serviceAlive = false;
    if (liveService == this) liveService = null;
    diagnostic("onDestroy retained-state");
    super.onDestroy();
  }
  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    // START_STICKY 재생성에서 null intent를 새 주행으로 오인하던 유령 트립 방지.
    if (intent == null || intent.getAction() == null) {
      stopSelf(startId);
      return START_NOT_STICKY;
    }
    String action = intent.getAction();
    diagnostic("command=" + action);
    switch (action) {
      case "start":
        if (!acceptStartGeneration(intent.getIntExtra("stopGeneration", stopGeneration))) {
          diagnostic("discard stopped pending start");
          recordingResult(intent.getStringExtra("recordingId"), false, "stopped_before_start");
          if ("idle".equals(phase)) {
            // Android still expects promotion for the already-enqueued FGS start intent.
            try { startAsForeground(); }
            catch (RuntimeException error) { stopFailedForegroundStart(); }
            finally {
              stopForeground(STOP_FOREGROUND_REMOVE);
              stopSelf(startId);
            }
          }
          break;
        }
        recordingId = intent.getStringExtra("recordingId");
        if (recordingId == null) {
          recordingId = java.util.UUID.randomUUID().toString();
        }
        try {
          // 파일·센서·SDK 초기화 전에 전경 서비스 시작 기한을 충족한다.
          startAsForeground();
          hub().endRecording();
          stopGps();
          // 이전 기록이 끝나지 않은 채 새로 시작하면 이전 것을 먼저 마감 저장
          if ("driving".equals(phase) || "paused".equals(phase)) {
            endTs = System.currentTimeMillis();
            savePendingTrip();
          }
          // 바퀴 진동 추정은 기록마다 새로 — 차가 바뀌면 바퀴 둘레가 다르다
          if (wheel != null) {
            wheel.stop();
          }
          wheel = null;
          wheelEst = false;
          zero50 = -1;
          zero100 = -1;
          launchT = -1;
          launchStill = false;
          launchPrevV = -1;
          launchPrevT = -1;
          launchEt = launchPrevEt = -1;


          satsUsed = -1;
          satsZeroSince = 0;
          satsVisible = -1;
          startLat = 0;
          startLng = 0;
          dispLat = 0;
          dispLng = 0;
          dispAcc = 0;
          dispTs = 0;

          phase = "driving";
          kmh = 0;
          distM = 0;
          maxKmh = 0;
          movingSec = 0;
          startTs = System.currentTimeMillis();
          String owner = intent.getStringExtra("owner");
          tripOwner = QueueOwner.UNASSIGNED.equals(owner) ? owner
              : QueueOwner.valid(owner) ? owner : QueueOwner.recording(this);
          hub().startVehicleTrace();
          endTs = 0;
          lastLat = 0;
          lastLng = 0;
          lastFixTs = 0;
          bearingDeg = -1;
          prev = null;
          jumpCand = null;
          synchronized (path) {
            path.clear();
          }
          pathMinM = 20f;
          if (raw != null) {
            raw.close(lm);
          }
          // 센서 원본은 사용자가 설정에서 켠 경우에만 기록
          raw = RawLogger.isOn(this) ? new RawLogger(this, startTs, tripOwner) : null;
          hub().recording(recordingId);
          requestGps();
          recordingResult(recordingId, true, null);
        } catch (RuntimeException e) {
          android.util.Log.w("Fundrive", "Recording start denied", e);
          // 전경 전환에 실패하면 정리 중 예외가 나기 전에 대기 서비스를 종료한다.
          stopFailedForegroundStart();
          phase = "idle";
          try {
            hub().endRecording();
            stopGps();
            if (raw != null) {
              raw.close(lm);
              raw = null;
            }
          } catch (RuntimeException cleanup) {
            android.util.Log.w("Fundrive", "Failed-start cleanup", cleanup);
          } finally {
            recordingResult(recordingId, false, e.getClass().getSimpleName());
            stopForeground(STOP_FOREGROUND_REMOVE);
          }
        }
        break;
      case "pause":
        if ("driving".equals(phase)) {
          phase = "paused";
          hub().pause(true);
          kmh = 0;
          prev = null;
          stopGps();
          if (raw != null) {
            raw.event("pause");
          }
          notifyNow();
        }
        break;
      case "resume":
        if ("paused".equals(phase)) {
          phase = "driving";
          hub().pause(false);
          if (raw != null) {
            raw.event("resume");
          }
          requestGps();
          notifyNow();
        }
        break;
      case "abort":
        if (intent.hasExtra("recordingId")
            && !java.util.Objects.equals(recordingId, intent.getStringExtra("recordingId"))) {
          break;
        }
        hub().endRecording();
        // 외부 안내 전환에 실패한 임시 기록은 저장하지 않고 폐기한다.
        stopGps();
        if (raw != null) {
          raw.close(lm);
          raw = null;
        }
        phase = "idle";
        startTs = 0;
        endTs = 0;
        lastFixTs = 0;
        kmh = 0;
        distM = 0;
        maxKmh = 0;
        movingSec = 0;
        prev = null;
        lastLat = lastLng = 0;
        dispLat = dispLng = 0;
        dispTs = 0;
        prevV = 0;
        dispAcc = 0;
        startLat = startLng = 0;


        bearingDeg = -1;
        zero50 = zero100 = -1;
        satsUsed = satsVisible = -1;
        satsZeroSince = 0;

        pathMinM = 20f;
        launchT = launchPrevT = -1;
        launchStill = false;
        launchPrevV = -1;
        launchEt = launchPrevEt = fixEt = -1;
        synchronized (path) {
          path.clear();
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
        break;
      case "stop":
        stopRecording(this);
        break;
      default:
        stopSelf(startId);
        return START_NOT_STICKY;
    }
    diagnostic("command completed=" + action);
    return START_NOT_STICKY;
  }

  private void requestGps() {
    if (pleosLocation == null) {
      PleosLocationSource candidate = PleosLocationSource.get(this);
      if (candidate.available()) {
        pleosLocation = candidate;
        pleosLocation.start("track", this::onLocationChanged);
        locMain.removeCallbacks(locReport);
        locMain.postDelayed(locReport, 30000);
      }
    }
    try {
      final LocationManager manager = (LocationManager) getSystemService(LOCATION_SERVICE);
      lm = manager;
      LocationListener subscription = new LocationListener() {
        @Override
        public void onLocationChanged(Location fix) {
          if (androidListener == this && gpsUpdates.active()) {
            TrackService.this.onLocationChanged(fix);
          }
        }
      };
      androidListener = subscription;
      final java.util.concurrent.Executor delivery = getMainExecutor();
      // 위치 등록과 해제는 한 작업자를 공유한다. 바인더 호출 중 리스너 잠금이
      // 유지될 수 있고 콜백 전달은 메인 스레드에서 처리한다.
      gpsUpdates.start(() -> {
        if (Build.VERSION.SDK_INT >= 31 && manager.hasProvider(LocationManager.FUSED_PROVIDER)) {
          android.location.LocationRequest req =
              new android.location.LocationRequest.Builder(1000)
                  .setQuality(android.location.LocationRequest.QUALITY_HIGH_ACCURACY)
                  .setMinUpdateIntervalMillis(500)
                  .build();
          manager.requestLocationUpdates(
              LocationManager.FUSED_PROVIDER, req, delivery, subscription);
        } else {
          manager.requestLocationUpdates(LocationManager.GPS_PROVIDER, 1000, 0, subscription,
              android.os.Looper.getMainLooper());
        }
      }, () -> manager.removeUpdates(subscription));
      if (gnssCb == null) {
        // 등록이 지연되면 위성 판정 전이므로 기존 미확정 상태를 유지한다.
        satsUsed = -1;
        satsVisible = -1;
        satsZeroSince = 0;
        android.location.GnssStatus.Callback satellites =
            new android.location.GnssStatus.Callback() {
              @Override
              public void onSatelliteStatusChanged(android.location.GnssStatus st) {
                if (gnssCb != this || !gpsSatellites.active()) {
                  return;
                }
                int used = 0;
                for (int i = 0; i < st.getSatelliteCount(); i++) {
                  if (st.usedInFix(i)) {
                    used++;
                  }
                }
                if (used == 0 && satsUsed != 0) {
                  satsZeroSince = android.os.SystemClock.elapsedRealtime();
                }
                satsUsed = used;
                satsVisible = st.getSatelliteCount();
              }
            };
        gnssCb = satellites;
        gpsSatellites.start(() -> manager.registerGnssStatusCallback(satellites, locMain),
            () -> manager.unregisterGnssStatusCallback(satellites));
      }
      // 마지막 위치 조회도 바인더 호출이므로 메인 스레드에서 기다리지 않는다.
      if (dispTs == 0) {
        BackgroundCleanup.execute(() -> {
          if (androidListener != subscription || !gpsUpdates.active()) {
            return;
          }
          for (String provider : new String[] {
                   "fused", LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
              Location last = manager.getLastKnownLocation(provider);
              if (last != null && System.currentTimeMillis() - last.getTime() < 600000) {
                locMain.post(() -> {
                  if (androidListener != subscription || !gpsUpdates.active() || dispTs != 0) {
                    return;
                  }
                  dispLat = last.getLatitude();
                  dispLng = last.getLongitude();
                  dispAcc = last.getAccuracy();
                  dispTs = System.currentTimeMillis();
                });
                break;
              }
            } catch (IllegalArgumentException ignored) {
              // 이 기기에서 지원하지 않는 위치 제공자다.
            }
          }
        });
      }
      if (raw != null) {
        raw.startSensors(lm);
      }
      if (sensors == null) {
        sensors = (android.hardware.SensorManager) getSystemService(SENSOR_SERVICE);
        android.hardware.Sensor lin = sensors != null
            ? sensors.getDefaultSensor(android.hardware.Sensor.TYPE_LINEAR_ACCELERATION)
            : null;
        if (lin != null) {
          sensors.registerListener(linListener, lin,
              android.hardware.SensorManager.SENSOR_DELAY_GAME,
              new android.os.Handler(android.os.Looper.getMainLooper()));
        } else {
          sensors = null;
        }
      }
      if (wheel == null) {
        android.hardware.SensorManager sm =
            (android.hardware.SensorManager) getSystemService(SENSOR_SERVICE);
        if (sm != null) {
          wheel = new WheelSpeed(mps -> {
            // 입구 속도에서 시작한 추정 — 최고속도엔 안 넣는다(검증 안 된 값으로 기록 갱신 방지)
            kmh = mps * 3.6;
            wheelEst = true;
            if (raw != null) {
              raw.event(String.format(java.util.Locale.US, "wheel %.1f", kmh));
            }
            long now = System.currentTimeMillis();
            if (now - lastNotifAt > 2000) {
              lastNotifAt = now;
              notifyNow();
            }
          });
          wheel.start(sm, new android.os.Handler(android.os.Looper.getMainLooper()));
        }
      }
      // 화면 꺼짐 대비 — GPS 켤 때만 CPU를 깨워둔다
      acquireWakeLock();
    } catch (SecurityException e) {
      // 권한 없음 — 액티비티가 요청함. 서비스는 조용히 대기.
    }
  }

  private void stopGps() {
    locMain.removeCallbacks(locReport);
    if (pleosLocation != null) {
      pleosLocation.stop("track");
      pleosLocation = null;
    }
    androidListener = null;
    gnssCb = null;
    gpsUpdates.stop();
    gpsSatellites.stop();
    if (raw != null) {
      raw.stopSensors(lm);
    }
    if (sensors != null) {
      sensors.unregisterListener(linListener);
    }
    sensors = null;
    linAcc.clear();
    if (wheel != null) {
      wheel.stop();
    }
    wheel = null;
    wheelEst = false;
    releaseWakeLock();
  }

  private void acquireWakeLock() {
    if (wakeLock == null) {
      PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
      wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "drivelog:track");
      wakeLock.setReferenceCounted(false);
    }
    if (!wakeLock.isHeld()) {
      wakeLock.acquire();
    }
  }

  private void releaseWakeLock() {
    if (wakeLock != null && wakeLock.isHeld()) {
      wakeLock.release();
    }
  }
  @Override
  public void onLocationChanged(Location loc) {
    if (!"pleos".equals(loc.getProvider())) {
      hub().fallbackFix(loc);
    }
    if (!"driving".equals(phase)) {
      return;
    }
    boolean pleos = "pleos".equals(loc.getProvider());
    // 속도 없는 현대 위치도 단발 조회에는 쓰되 안드로이드 기록을 대체하지 않는다.
    if (pleos && !PleosLocationSource.recordingEligible(loc)) {
      droppedCount++;
      return;
    }
    if (!pleos && pleosLocation != null && pleosLocation.freshForRecording() != null) {
      droppedCount++;
      return;
    }
    if (pleos) {
      pleosCount++;
    } else {
      androidCount++;
    }
    if (raw != null) {
      raw.location(loc);
    }
    // 표시용은 모든 위치(대략 위치 포함)로 갱신
    dispLat = loc.getLatitude();
    dispLng = loc.getLongitude();
    dispAcc = loc.hasAccuracy() ? loc.getAccuracy() : 0;
    dispTs = System.currentTimeMillis();
    // 기록엔 정확한 위치만
    if (loc.getAccuracy() > MAX_ACCURACY_M) {
      return;
    }
    // 위성 0개(터널) 동안 들어오는 위치는 전부 버린다 — 속도·거리·경로가 입구 값에 멈춘다.
    // 보령해저터널(10-25): 통합 위치가 센서로 추정한 위치·속도(86–105km/h로 부풀음)와
    // 기지국 위치(오차 30~68m라 정확도 필터 통과, 입구 뒤 800m로 튀고 0km/h)가 섞여 들어왔다.
    // 화면 속도는 입구 속도로 유지되고, 출구 첫 픽스에서 터널 거리를 직선으로 채운다(아래).
    // 위성 상태 콜백이 고장 나 0에 굳는 경우를 대비해 15분 넘으면 풀어준다. 자동차 기록에 적용한다.
    // Windows test replay reports zero satellites even for injected accurate GPS fixes.
    // Only the explicit emulator test build bypasses the satellite gate; all accuracy,
    // speed and jump checks remain active, and production builds retain tunnel filtering.
    if (!BuildConfig.EMULATOR_GNSS_REPLAY && !pleos && satsUsed == 0
        && android.os.SystemClock.elapsedRealtime() - satsZeroSince < 15 * 60_000
       ) {
      return;
    }
    // 기기 속도(m/s). 일부 기기/에뮬레이터는 hasSpeed()=true인데 0으로
    // 뭉개서 오므로, 0에 가깝면 픽스 간 거리로 직접 계산해 큰 쪽을 쓴다.
    double v = loc.hasSpeed() ? loc.getSpeed() : 0;
    boolean calcSpeed = false;
    boolean positionalSpeed = PleosLocationMath.positionalSpeedAllowed(
        loc.hasSpeed(), loc.getExtras() == null ? null : loc.getExtras().getString("speedSource"));
    if (positionalSpeed && v < 0.5 && prev != null) {
      double dt = (loc.getTime() - prev.getTime()) / 1000.0;
      float dJump = prev.distanceTo(loc);
      // GPS 점프(500m+)는 속도 계산에서도 제외 — 최고속도 219km/h 같은
      // 가짜 기록 방지 (에뮬 검증에서 실측된 버그)
      // 위치 오차 안쪽의 흔들림은 움직임이 아니다 — 공항 주차장에서 멈춘 채 위치가 14m 튄 걸
      // 시속 50km로 계산해 0–50 1.4초·가속 0.72G가 나왔다(10-24). 두 픽스 오차 합의 2배는 넘어야.
      float noise = 2
          * ((prev.hasAccuracy() ? prev.getAccuracy() : 10)
              + (loc.hasAccuracy() ? loc.getAccuracy() : 10));
      if (dt > 0.5 && dJump < maxJump() && dJump > noise) {
        double calc = dJump / dt;
        // 55m/s(198km/h) 캡
        if (calc > v && calc < 55) {
          v = calc;
          calcSpeed = true;
        }
      }
    }
    double cur = Math.max(0, v * 3.6);
    kmh = cur;
    // 상한 400km/h — 넘는 값은 튐
    if (cur > maxKmh && cur < 400) {
      maxKmh = cur;
    }
    // 제로백은 기기 도플러 속도로만 — 위치로 계산한 속도는 튐이 커서 출발 측정을 끊는다
    fixEt = loc.getElapsedRealtimeNanos() / 1e6;
    if (wheel != null) {
      // 끊김 뒤 첫 픽스 — 진동 추정을 했는지·왜 안 했는지 원본 기록에 남긴다(나중에 출구 속도와 대조)
      if (raw != null && !wheel.gateInfo.isEmpty()) {
        raw.event("wheelgate " + wheel.gateInfo);
      }
      wheel.gateInfo = "";
      wheel.fix(fixEt, v, loc.getAccuracy() <= 15);
    }
    wheelEst = false;
    if (calcSpeed) {
      launchT = -1;
    } else {
      trackLaunch(loc.getTime(), cur);
    }
    if (prev != null && loc.getTime() > prev.getTime()) {
      float d = prev.distanceTo(loc);
      double dt = (loc.getTime() - prev.getTime()) / 1000.0;
      if (d < maxJump() && cur >= MOVING_KMH) {
        distM += d;
        movingSec += dt;
      } else if (d >= maxJump()) {
        // GPS 끊김(터널) 뒤 첫 픽스 — 들어갈 때·나올 때 다 달리고 있었고 평균 속도가 말이 되면
        // 직선 거리로 채운다(굽은 터널은 조금 덜 잡힘). 보령해저터널 6.8km가 통째로 빠졌다(10-25).
        double prevKmh = prevV * 3.6;
        double avg = d / dt;
        if (prevKmh >= 20 && cur >= 20 && dt <= 1800 && avg >= 5
            && avg <= 55) {
          distM += d;
          movingSec += dt;
        }
      }
    }
    prev = loc;
    prevV = v;
    if (startLat == 0 && startLng == 0) {
      startLat = loc.getLatitude();
      startLng = loc.getLongitude();
    }
    lastLat = loc.getLatitude();
    lastLng = loc.getLongitude();
    lastFixTs = Math.max(loc.getTime(), System.currentTimeMillis());
    if (loc.hasBearing() && cur >= MOVING_KMH) {
      bearingDeg = loc.getBearing();
    }
    addPathPoint(loc);
    // 알림 갱신은 2초에 한 번 (배터리 배려)
    long now = System.currentTimeMillis();
    if (now - lastNotifAt > 2000) {
      lastNotifAt = now;
      notifyNow();
    }
  }
  /**
   * 정지 출발 0–50·0–100 측정. 2km/h 미만(정지)에서 출발해 연속 픽스(간격≤2초)로
   * 50·100을 넘는 순간을 앞뒤 픽스로 보간한다. 출발 시각도 2km/h 통과를 보간.
   * 0.7g 넘는 속도 변화나 0–50 2초·0–100 3초 미만은 센서가 같은 가속을 확인할 때만 인정
   * (GPS 튐이 1.4초를 만들었다 — 10-24). 끊김이 있으면 그 출발은 무효.
   */
  private void trackLaunch(long t, double v) {
    double pv = launchPrevV;
    long pt = launchPrevT;
    double pEt = launchPrevEt, et = fixEt;
    launchPrevV = v;
    launchPrevT = t;
    launchPrevEt = et;
    if (pt < 0) {
      launchStill = v < 2;
      return;
    }
    double dt = (t - pt) / 1000.0;
    if (dt <= 0) {
      return;
    }
    // 한 픽스 사이 가속 7m/s²(0.7G) 넘으면 튐 — 보통 차의 출발은 0.3~0.5G.
    // 단, 센서도 그 가속의 60% 넘게 찍었으면 진짜 빠른 출발
    double aGps = Math.abs(v - pv) / 3.6 / dt;
    boolean jump = aGps > 7 && !(aGps < 15 && sensorMean(pEt, et) >= 0.6 * aGps);
    if (dt > 2.0 || jump) {
      // 끊김·튐 — 지금 정지 상태일 때만 새 출발을 기다린다
      launchT = -1;
      launchStill = v < 2;
      return;
    }
    if (v < 2) {
      launchStill = true;
      launchT = -1;
      return;
    }
    if (launchStill && pv < 2) {
      launchT = (long) (pt + (2 - pv) / (v - pv) * (t - pt));
      launchEt = pEt + (launchT - pt);
      launchStill = false;
    }
    if (launchT < 0) {
      return;
    }
    for (int target : new int[] {50, 100}) {
      if (pv < target && v >= target) {
        double cross = pt + (target - pv) / (v - pv) * (t - pt);
        double sec = (cross - launchT) / 1000.0;
        // 0–50 2초·0–100 3초 미만은 센서 평균이 그 가속의 70% 넘을 때만(물리 하한 1.0·1.8초)
        double floor = target == 50 ? 2.0 : 3.0, hard = target == 50 ? 1.0 : 1.8;
        boolean ok = sec >= floor;
        if (!ok && sec >= hard && launchEt > 0) {
          double need = 0.7 * (target / 3.6) / sec;
          ok = sensorMean(launchEt, pEt + (cross - pt)) >= need;
        }
        if (ok && target == 50 && (zero50 < 0 || sec < zero50)) {
          zero50 = sec;
        }
        if (ok && target == 100 && (zero100 < 0 || sec < zero100)) {
          zero100 = sec;
        }
      }
    }
    // 이번 출발 측정 끝
    if (v >= 100) {
      launchT = -1;
    }
  }
  // ── 폰에 남기는 마감 기록 (웹이 나중에 가져가 서버에 올린다) ──────────
  static File pendingDir(android.content.Context c) {
    return new File(c.getFilesDir(), "pending-trips");
  }

  private void savePendingTrip() {
    try { savePendingTrip(this); }
    catch (RuntimeException error) { android.util.Log.w("Fundrive", "Previous trip save failed", error); }
  }

  private static void savePendingTrip(android.content.Context context) {
    try {
      org.json.JSONObject o = new org.json.JSONObject();
      o.put("id", String.valueOf(endTs));
      o.put("startTs", startTs);
      o.put("owner", tripOwner);
      if ("car".equals(mode)) {
        try {
          org.json.JSONObject trace = new org.json.JSONObject(dev.homesev.drivelog.pleos.PleosHub.get(context).vehicleTrace());
          java.util.Iterator<String> keys = trace.keys();
          while (keys.hasNext()) { String key = keys.next(); o.put(key, trace.get(key)); }
        } catch (Exception ignored) {
          // 차량 추적이 없어도 소유자와 경로를 포함한 주행은 보관한다.
        }
      }
      o.put("endTs", endTs);
      o.put("distanceM", Math.round(distM));
      o.put("maxKmh", Math.round(maxKmh));
      o.put("avgKmh", movingSec > 10 ? Math.round(distM / movingSec * 3.6) : 0);
      o.put("movingSec", Math.round(movingSec));
      o.put("mode", mode);
      if (zero50 > 0) {
        o.put("zero50Sec", Math.round(zero50 * 10) / 10.0);
      }
      if (zero100 > 0) {
        o.put("zero100Sec", Math.round(zero100 * 10) / 10.0);
      }
      // 빠른 제로백은 센서로 확인한 값(서버가 하한을 낮춘다)
      o.put("zeroChecked", true);
      o.put("path", new org.json.JSONArray(getPathJson()));
      File dir = pendingDir(context);
      dir.mkdirs();
      File tmp = new File(dir, startTs + ".json.tmp");
      try (java.io.FileOutputStream fo = new java.io.FileOutputStream(tmp)) {
        fo.write(o.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
        fo.getFD().sync();
      }
      if (!tmp.renameTo(new File(dir, startTs + ".json"))) {
        throw new java.io.IOException("pending trip rename failed");
      }
    } catch (Exception error) {
      // Retain phase/path until persistence succeeds; caller can report failure and retry.
      throw new IllegalStateException("pending trip save failed", error);
    }
  }

  /** 아직 서버로 안 간 마감 기록들 [{...}] */
  static String getPendingTripsJson(android.content.Context c) {
    org.json.JSONArray arr = new org.json.JSONArray();
    File[] fs = pendingDir(c).listFiles((d, n) -> n.endsWith(".json"));
    if (fs != null) {
      for (File f : fs) {
        try {
          byte[] b = java.nio.file.Files.readAllBytes(f.toPath());
          arr.put(new org.json.JSONObject(new String(b, java.nio.charset.StandardCharsets.UTF_8)));
        } catch (Exception e) {
          // 읽지 못한 파일도 소유자를 확인할 수 없어 보관한다.
        }
      }
    }
    return arr.toString();
  }

  static int unassignedCount(android.content.Context c) {
    java.util.Set<String> starts = RawLogger.unassigned(c);
    try {
      org.json.JSONArray items = new org.json.JSONArray(getPendingTripsJson(c));
      for (int i = 0; i < items.length(); i++) {
        org.json.JSONObject item = items.getJSONObject(i);
        if (!QueueOwner.valid(item.optString("owner", null))) starts.add(item.optString("startTs"));
      }
    } catch (Exception ignored) { }
    return starts.size();
  }

  static boolean adoptUnassigned(android.content.Context c, String owner) {
    File[] files = pendingDir(c).listFiles((d, n) -> n.endsWith(".json"));
    boolean adopted = true;
    if (files != null) for (File file : files) {
      org.json.JSONObject item;
      try {
        item = new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8));
        item.getLong("startTs");
      } catch (Exception e) {
        // 손상 파일을 보관하고 나머지 기록은 계속 처리한다.
        file.renameTo(new File(file.getPath() + ".bad"));
        continue;
      }
      try {
        if (!QueueOwner.valid(item.optString("owner", null))) {
          item.put("owner", owner);
          File tmp = new File(file.getPath() + ".tmp");
          java.nio.file.Files.write(tmp.toPath(), item.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8));
          java.nio.file.Files.move(tmp.toPath(), file.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
          RawLogger.adopt(c, item.getLong("startTs"), owner);
        }
      } catch (Exception e) { adopted = false; }
    }
    // pending 파일 하나가 손상돼도 별도 원본 기록은 입양한다.
    RawLogger.adoptUnassigned(c, owner);
    return adopted;
  }

  /** 웹이 서버(또는 오프라인 큐)에 넘긴 기록 지우기 */
  static void ackPendingTrip(android.content.Context c, long tripStartTs) {
    File file = new File(pendingDir(c), tripStartTs + ".json");
    try {
      org.json.JSONObject item = new org.json.JSONObject(new String(java.nio.file.Files.readAllBytes(file.toPath()), java.nio.charset.StandardCharsets.UTF_8));
      if (java.util.Objects.equals(QueueOwner.current(), item.optString("owner", QueueOwner.UNASSIGNED))
          && QueueOwner.current() != null) file.delete();
    } catch (Exception ignored) { }
  }

  private void addPathPoint(Location loc) {
    synchronized (path) {
      if (!path.isEmpty()) {
        double[] last = path.get(path.size() - 1);
        float[] res = new float[1];
        Location.distanceBetween(last[0], last[1], loc.getLatitude(), loc.getLongitude(), res);
        if (res[0] < pathMinM) {
          return;
        }
        if (res[0] > maxJump()) {
          // 단발 위성 튐은 버리고, 다음 픽스가 같은 곳이면 진짜 이동으로 인정
          Location c = jumpCand;
          jumpCand = new Location(loc);
          if (c == null || c.distanceTo(loc) > 200) {
            return;
          }
        }
      }
      jumpCand = null;
      // 점마다 현재 속도(kmh)를 함께 저장 — 기록 지도의 구간별 속도색(RouteMap)이
      // 앱 주행(백그라운드 포함)에서도 살아나게. 웹은 폴링이 멈추는 화면꺼짐 구간
      // 속도를 못 모으므로 네이티브가 점별로 들고 있어야 한다.
      path.add(new double[] {loc.getLatitude(), loc.getLongitude(), kmh});
      if (path.size() > 4000) {
        for (int i = path.size() - 2; i > 0; i -= 2) {
          path.remove(i);
        }
        pathMinM *= 2;
      }
    }
  }
  private PendingIntent pi(String action, int code) {
    if ("stop".equals(action)) {
      return PendingIntent.getBroadcast(this, code, new Intent(this, StopRecordingReceiver.class),
          PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
    Intent i = new Intent(this, TrackService.class).setAction(action);
    return PendingIntent.getService(
        this, code, i, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
  }

  private Notification buildNotif() {
    boolean paused = "paused".equals(phase);
    Notification.Builder b =
        new Notification.Builder(this, CHANNEL)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentTitle(paused ? "일시중지" : String.format(Locale.US, "주행 %.0f km/h", kmh))
            .setContentText(
                String.format(Locale.US, "%.1f km · 최고 %.0f km/h", distM / 1000, maxKmh))
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setGroup("drive")
            .addAction(
                new Notification.Action.Builder(
                    null, paused ? "재개" : "일시중지", pi(paused ? "resume" : "pause", 2))
                    .build())
            .addAction(new Notification.Action.Builder(null, "주행 종료", pi("stop", 3)).build());
    // 알림 탭 – 앱 열기
    Intent open = new Intent(this, MainActivity.class);
    b.setContentIntent(PendingIntent.getActivity(
        this, 1, open, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
    return b.build();
  }

  private void ensureNotificationChannel() {
    NotificationManager nm = getSystemService(NotificationManager.class);
    if (nm.getNotificationChannel(CHANNEL) == null) {
      NotificationChannel ch =
          new NotificationChannel(CHANNEL, "주행 기록", NotificationManager.IMPORTANCE_LOW);
      ch.setDescription("주행 중 속도·거리 표시");
      nm.createNotificationChannel(ch);
    }
  }

  private void startAsForeground() {
    ensureNotificationChannel();
    if (Build.VERSION.SDK_INT >= 29) {
      startForeground(NOTIF_ID, buildNotif(), ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
    } else {
      startForeground(NOTIF_ID, buildNotif());
    }
  }

  private void stopFailedForegroundStart() {
    try {
      ensureNotificationChannel();
      Notification minimal = new Notification.Builder(this, CHANNEL)
                                 .setSmallIcon(android.R.drawable.ic_menu_mylocation)
                                 .setContentTitle("기록을 시작하지 못했어요")
                                 .build();
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(NOTIF_ID, minimal, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION);
      } else {
        startForeground(NOTIF_ID, minimal);
      }
    } catch (RuntimeException denied) {
      android.util.Log.w("Fundrive", "Failed-start foreground promotion denied", denied);
    } finally {
      // 권한 상실로 전경 전환에 실패해도 시작 타이머가 남지 않게 한다.
      stopSelf();
    }
  }

  private void notifyNow() {
    getSystemService(NotificationManager.class).notify(NOTIF_ID, buildNotif());
  }
  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }
}
