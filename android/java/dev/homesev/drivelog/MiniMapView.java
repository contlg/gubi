package dev.homesev.drivelog;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.view.View;

/**
 * 오프라인 미니 지도 — 타일 없이 앱에 넣은 육지 윤곽과 행정동 경계 위에 지나온
 * 경로·현재 위치를 그린다. 범위는 경로+현재 위치에 맞추되 최소 폭 2km를 둔다. 등장방형 투영(경도에 cos(위도) 보정).
 */
final class MiniMapView extends View {
  private double[][] path = new double[0][];
  private double curLat = Double.NaN, curLng = Double.NaN;
  private double minSpanKm = 2;
  private final Paint sea = new Paint(), landP = new Paint(), dongP = new Paint();
  private final Paint trackP = new Paint(), dotP = new Paint(), startP = new Paint();
  private final Path tmp = new Path();

  MiniMapView(Context c) {
    super(c);
    sea.setColor(0xFF0B1220);
    landP.setColor(0xFF1F2023);
    landP.setStyle(Paint.Style.FILL);
    landP.setAntiAlias(true);
    dongP.setColor(0x33FFFFFF);
    dongP.setStyle(Paint.Style.STROKE);
    dongP.setStrokeWidth(1f);
    trackP.setColor(0xFF3182F6);
    trackP.setStyle(Paint.Style.STROKE);
    trackP.setStrokeWidth(4f * getResources().getDisplayMetrics().density);
    trackP.setStrokeJoin(Paint.Join.ROUND);
    trackP.setStrokeCap(Paint.Cap.ROUND);
    trackP.setAntiAlias(true);
    dotP.setColor(0xFFFFFFFF);
    dotP.setAntiAlias(true);
    startP.setColor(0xFF34D399);
    startP.setAntiAlias(true);
  }

  void update(double[][] path, double lat, double lng, double minSpanKm) {
    this.path = path;
    this.curLat = lat;
    this.curLng = lng;
    this.minSpanKm = minSpanKm;
    invalidate();
  }
  @Override
  protected void onDraw(Canvas cv) {
    int w = getWidth(), h = getHeight();
    cv.drawRect(0, 0, w, h, sea);
    // 범위: 경로 + 현재 위치
    double minLat = 90, maxLat = -90, minLng = 180, maxLng = -180;
    boolean any = false;
    for (double[] p : path) {
      minLat = Math.min(minLat, p[0]);
      maxLat = Math.max(maxLat, p[0]);
      minLng = Math.min(minLng, p[1]);
      maxLng = Math.max(maxLng, p[1]);
      any = true;
    }
    if (!Double.isNaN(curLat) && curLat != 0) {
      minLat = Math.min(minLat, curLat);
      maxLat = Math.max(maxLat, curLat);
      minLng = Math.min(minLng, curLng);
      maxLng = Math.max(maxLng, curLng);
      any = true;
    }
    OfflineGeo geo = OfflineGeo.get();
    if (!any) {
      // 아직 위치 없음 — 한반도 전체
      minLat = 33;
      maxLat = 39;
      minLng = 124.5;
      maxLng = 130.5;
    }
    final double cLat = (minLat + maxLat) / 2, cLng = (minLng + maxLng) / 2;
    final double kx = Math.cos(Math.toRadians(cLat));
    double spanLat = Math.max(maxLat - minLat, minSpanKm / 111.0) * 1.25;
    double spanLng = Math.max((maxLng - minLng) * kx, minSpanKm / 111.0) * 1.25;
    // 화면 비율 맞추기
    double aspect = (double) w / h;
    if (spanLng / spanLat < aspect) {
      spanLng = spanLat * aspect;
    } else {
      spanLat = spanLng / aspect;
    }
    final double sLat = spanLat, sLng = spanLng;
    final double x0 = cLng, y0 = cLat;
    // 투영
    final float fw = w, fh = h;
    java.util.function.DoubleBinaryOperator px =
        (la, ln) -> (float) (fw / 2 + (ln - x0) * kx / sLng * fw);
    java.util.function.DoubleBinaryOperator py =
        (la, ln) -> (float) (fh / 2 - (la - y0) / sLat * fh);
    double vMinLat = y0 - sLat / 2, vMaxLat = y0 + sLat / 2;
    double vMinLng = x0 - sLng / kx / 2, vMaxLng = x0 + sLng / kx / 2;
    if (geo != null) {
      for (OfflineGeo.Land l : geo.land) {
        if (l.maxLat / 1e4 < vMinLat || l.minLat / 1e4 > vMaxLat) {
          continue;
        }
        if (l.maxLng / 1e4 < vMinLng || l.minLng / 1e4 > vMaxLng) {
          continue;
        }
        drawRing(cv, l.pts, 1e4, px, py, landP, true);
      }
      // 동 경계는 가까이 볼 때만(폭 30km 이하)
      if (sLat * 111 <= 30) {
        for (OfflineGeo.Region r : geo.dongs) {
          if (r.maxLat / 1e5 < vMinLat || r.minLat / 1e5 > vMaxLat) {
            continue;
          }
          if (r.maxLng / 1e5 < vMinLng || r.minLng / 1e5 > vMaxLng) {
            continue;
          }
          for (int[] ring : r.rings) {
            drawRing(cv, ring, 1e5, px, py, dongP, true);
          }
        }
      }
    }
    if (path.length > 1) {
      tmp.reset();
      tmp.moveTo((float) px.applyAsDouble(path[0][0], path[0][1]),
          (float) py.applyAsDouble(path[0][0], path[0][1]));
      for (int i = 1; i < path.length; i++) {
        tmp.lineTo((float) px.applyAsDouble(path[i][0], path[i][1]),
            (float) py.applyAsDouble(path[i][0], path[i][1]));
      }
      cv.drawPath(tmp, trackP);
    }
    float d = getResources().getDisplayMetrics().density;
    if (path.length > 0) {
      cv.drawCircle((float) px.applyAsDouble(path[0][0], path[0][1]),
          (float) py.applyAsDouble(path[0][0], path[0][1]), 5 * d, startP);
    }
    if (!Double.isNaN(curLat) && curLat != 0) {
      cv.drawCircle((float) px.applyAsDouble(curLat, curLng),
          (float) py.applyAsDouble(curLat, curLng), 7 * d, dotP);
      cv.drawCircle((float) px.applyAsDouble(curLat, curLng),
          (float) py.applyAsDouble(curLat, curLng), 4.5f * d, trackP);
    }
  }

  private void drawRing(Canvas cv, int[] pts, double scale,
      java.util.function.DoubleBinaryOperator px, java.util.function.DoubleBinaryOperator py,
      Paint p, boolean close) {
    int n = pts.length / 2;
    if (n < 2) {
      return;
    }
    tmp.reset();
    for (int i = 0; i < n; i++) {
      double la = pts[i * 2] / scale, ln = pts[i * 2 + 1] / scale;
      float x = (float) px.applyAsDouble(la, ln), y = (float) py.applyAsDouble(la, ln);
      if (i == 0) {
        tmp.moveTo(x, y);
      } else {
        tmp.lineTo(x, y);
      }
    }
    if (close) {
      tmp.close();
    }
    cv.drawPath(tmp, p);
  }
}
