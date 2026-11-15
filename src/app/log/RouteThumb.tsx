"use client";

import { useMemo } from "react";

import { decodePolyline } from "@/lib/polyline";

/** 기록 목록용 작은 경로 그림 — 지도 없이 궤적 모양만 선으로 */
export function RouteThumb({ enc, size = 44 }: { enc?: string; size?: number }) {
  const d = useMemo(() => {
    if (!enc) return null;
    let pts: [number, number][];
    try {
      pts = decodePolyline(enc);
    } catch {
      return null;
    }
    if (pts.length < 2) return null;
    // 목록 수십 줄을 그리니 점은 80개 안팎으로 솎는다
    const step = Math.max(1, Math.floor(pts.length / 80));
    const thin = pts.filter((_, i) => i % step === 0 || i === pts.length - 1);
    const kx = Math.cos((thin[0][0] * Math.PI) / 180);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const xy = thin.map(([lat, lng]) => {
      const x = lng * kx, y = -lat;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      return [x, y];
    });
    const pad = size * 0.18;
    const span = Math.max(maxX - minX, maxY - minY) || 1;
    const s = (size - pad * 2) / span;
    const ox = (size - (maxX - minX) * s) / 2, oy = (size - (maxY - minY) * s) / 2;
    const pt = ([x, y]: number[]) => [(x - minX) * s + ox, (y - minY) * s + oy];
    const [ex, ey] = pt(xy[xy.length - 1]);
    return {
      line: xy.map((p, i) => `${i ? "L" : "M"}${pt(p).map((v) => v.toFixed(1)).join(" ")}`).join(""),
      end: [ex, ey],
    };
  }, [enc, size]);

  return (
    <div
      className="grid shrink-0 place-items-center rounded-md bg-raised"
      style={{ width: size, height: size }}
    >
      {d ? (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden>
          <path d={d.line} fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" className="text-accent-text" />
          <circle cx={d.end[0]} cy={d.end[1]} r={2.2} className="fill-white" />
        </svg>
      ) : (
        <span className="h-1.5 w-1.5 rounded-sm bg-raised" />
      )}
    </div>
  );
}
