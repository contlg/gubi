package dev.homesev.drivelog;

import android.content.Context;
import java.io.BufferedInputStream;
import java.io.DataInputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.Locale;
import java.util.zip.GZIPInputStream;

/**
 * 인터넷 없이 "지금 어디 위인지" — 앱에 넣은 지리 자료(assets, build-offline-geo.mjs 산출)로
 * 국내는 행정동 경계, 해외·바다는 가장 가까운 도시로 이름을 만든다. 미니 지도도 같은
 * 자료(육지 윤곽·동 경계)를 그린다. 처음 쓸 때 한 번 읽어 메모리에 둔다(~10MB).
 */
final class OfflineGeo {
  static final class Region {
    final String name;
    final int minLat, minLng, maxLat, maxLng;
    final int[][] rings;
    Region(String name, int[] bbox, int[][] rings) {
      this.name = name;
      this.minLat = bbox[0];
      this.minLng = bbox[1];
      this.maxLat = bbox[2];
      this.maxLng = bbox[3];
      this.rings = rings;
    }
  }
  static final class City {
    final String name, country;
    final double lat, lng;
    final int pop;
    City(String name, String country, double lat, double lng, int pop) {
      this.name = name;
      this.country = country;
      this.lat = lat;
      this.lng = lng;
      this.pop = pop;
    }
  }
  /** 육지 고리 — 1e4 정수 */
  static final class Land {
    final int minLat, minLng, maxLat, maxLng;
    final int[] pts;
    Land(int[] bbox, int[] pts) {
      this.minLat = bbox[0];
      this.minLng = bbox[1];
      this.maxLat = bbox[2];
      this.maxLng = bbox[3];
      this.pts = pts;
    }
  }
  private static volatile OfflineGeo inst;
  final ArrayList<Region> dongs = new ArrayList<>();
  final ArrayList<City> cities = new ArrayList<>();
  final ArrayList<Land> land = new ArrayList<>();

  /** 백그라운드에서 불러 둔다. 다 읽기 전엔 get()이 null */
  static void preload(Context c) {
    if (inst != null) {
      return;
    }
    final Context app = c.getApplicationContext();
    new Thread(() -> {
      synchronized (OfflineGeo.class) {
        if (inst == null) {
          try {
            inst = new OfflineGeo(app);
          } catch (IOException ignored) {
            // 자료가 없으면 지명·지도 없이 숫자만 보여준다
          }
        }
      }
    }, "offline-geo").start();
  }

  static OfflineGeo get() {
    return inst;
  }

  private static DataInputStream open(Context c, String name) throws IOException {
    return new DataInputStream(
        new BufferedInputStream(new GZIPInputStream(c.getAssets().open(name), 64 * 1024)));
  }

  private OfflineGeo(Context c) throws IOException {
    try (DataInputStream in = open(c, "dong.bin")) {
      int n = in.readInt();
      for (int i = 0; i < n; i++) {
        String name = in.readUTF();
        int[] bb = {in.readInt(), in.readInt(), in.readInt(), in.readInt()};
        int rc = in.readShort();
        int[][] rings = new int[rc][];
        for (int r = 0; r < rc; r++) {
          int pc = in.readInt();
          int[] p = new int[pc * 2];
          for (int k = 0; k < pc * 2; k++) {
            p[k] = in.readInt();
          }
          rings[r] = p;
        }
        dongs.add(new Region(name, bb, rings));
      }
    }
    try (DataInputStream in = open(c, "cities.bin")) {
      int n = in.readInt();
      for (int i = 0; i < n; i++) {
        String name = in.readUTF(), cc = in.readUTF();
        double lat = in.readInt() / 1e5, lng = in.readInt() / 1e5;
        cities.add(new City(name, cc, lat, lng, in.readInt()));
      }
    }
    try (DataInputStream in = open(c, "land.bin")) {
      int n = in.readInt();
      for (int i = 0; i < n; i++) {
        int[] bb = {in.readInt(), in.readInt(), in.readInt(), in.readInt()};
        int pc = in.readInt();
        int[] p = new int[pc * 2];
        for (int k = 0; k < pc * 2; k++) {
          p[k] = in.readInt();
        }
        land.add(new Land(bb, p));
      }
    }
  }

  /** 짝홀 규칙 점-다각형 판정 (pts = lat,lng 교대) */
  private static boolean inside(int[] pts, double lat, double lng, double scale) {
    boolean in = false;
    int n = pts.length / 2;
    for (int i = 0, j = n - 1; i < n; j = i++) {
      double yi = pts[i * 2] / scale, xi = pts[i * 2 + 1] / scale;
      double yj = pts[j * 2] / scale, xj = pts[j * 2 + 1] / scale;
      if ((yi > lat) != (yj > lat) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) {
        in = !in;
      }
    }
    return in;
  }

  Region dongAt(double lat, double lng) {
    int la = (int) Math.round(lat * 1e5), ln = (int) Math.round(lng * 1e5);
    for (Region r : dongs) {
      if (la < r.minLat || la > r.maxLat || ln < r.minLng || ln > r.maxLng) {
        continue;
      }
      boolean in = false;
      for (int[] ring : r.rings) {
        if (inside(ring, lat, lng, 1e5)) {
          in = !in;
        }
      }
      if (in) {
        return r;
      }
    }
    return null;
  }

  boolean onLand(double lat, double lng) {
    int la = (int) Math.round(lat * 1e4), ln = (int) Math.round(lng * 1e4);
    for (Land l : land) {
      if (la < l.minLat || la > l.maxLat || ln < l.minLng || ln > l.maxLng) {
        continue;
      }
      if (inside(l.pts, lat, lng, 1e4)) {
        return true;
      }
    }
    return false;
  }

  /** 가장 가까운 도시 — 50km 안에 인구 10만+가 있으면 그쪽을 우선(작은 마을보다 알아보기 쉽게) */
  City nearestCity(double lat, double lng, double[] distKmOut) {
    City best = null, bestBig = null;
    double bd = 1e18, bbd = 1e18;
    for (City c : cities) {
      double d = distKm(lat, lng, c.lat, c.lng);
      if (d < bd) {
        bd = d;
        best = c;
      }
      if (c.pop >= 100_000 && d < bbd) {
        bbd = d;
        bestBig = c;
      }
    }
    if (bestBig != null && bbd <= 50) {
      distKmOut[0] = bbd;
      return bestBig;
    }
    distKmOut[0] = bd;
    return best;
  }

  /** 사람이 읽는 위치 한 줄 */
  String describe(double lat, double lng) {
    Region r = dongAt(lat, lng);
    if (r != null) {
      return shortKr(r.name);
    }
    double[] d = new double[1];
    City c = nearestCity(lat, lng, d);
    if (c == null) {
      return "";
    }
    boolean land = onLand(lat, lng);
    String place = "한국".equals(c.country) ? c.name : c.country + " " + c.name;
    if (!land) {
      return String.format(Locale.KOREA, "바다 위 · %s에서 %.0fkm", place, d[0]);
    }
    if (d[0] < 5) {
      return place;
    }
    return String.format(Locale.KOREA, "%s 근처 · %.0fkm", place, d[0]);
  }

  private static String shortKr(String s) {
    String[][] m = {
        {"서울특별시", "서울"},
        {"부산광역시", "부산"},
        {"대구광역시", "대구"},
        {"인천광역시", "인천"},
        {"광주광역시", "광주"},
        {"대전광역시", "대전"},
        {"울산광역시", "울산"},
        {"세종특별자치시", "세종"},
        {"경기도", "경기"},
        {"강원특별자치도", "강원"},
        {"강원도", "강원"},
        {"충청북도", "충북"},
        {"충청남도", "충남"},
        {"전북특별자치도", "전북"},
        {"전라북도", "전북"},
        {"전라남도", "전남"},
        {"경상북도", "경북"},
        {"경상남도", "경남"},
        {"제주특별자치도", "제주"},
    };
    for (String[] p : m) {
      if (s.startsWith(p[0])) {
        return p[1] + s.substring(p[0].length());
      }
    }
    return s;
  }

  static double distKm(double lat1, double lng1, double lat2, double lng2) {
    double t = Math.PI / 180, dl = (lat2 - lat1) * t, dn = (lng2 - lng1) * t;
    double h = Math.sin(dl / 2) * Math.sin(dl / 2)
        + Math.cos(lat1 * t) * Math.cos(lat2 * t) * Math.sin(dn / 2) * Math.sin(dn / 2);
    return 2 * 6371 * Math.asin(Math.sqrt(h));
  }
}
