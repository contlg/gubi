"use client";

import type React from "react";
import type { VehicleTrace } from "@/lib/vehicle-trace";


import { decodePolyline } from "@/lib/polyline";

/**
 * 기록 상세 — 차량 조향·제동 및 거리별 속도 그래프.
 * 속도는 path 점마다 저장된 speeds(km/h)를, 거리는 path에서 다시 잰다.
 */


function cumKm(enc: string): number[] {
  const pts = decodePolyline(enc);
  const out = [0];
  for (let i = 1; i < pts.length; i++) {
    const [a1, b1] = pts[i - 1], [a2, b2] = pts[i];
    const kx = 111.32 * Math.cos((a1 * Math.PI) / 180);
    out.push(out[i - 1] + Math.hypot((b2 - b1) * kx, (a2 - a1) * 110.54));
  }
  return out;
}

function LineChart({
  xs,
  ys,
  color,
  unit,
  label,
  fmt = (v: number) => String(Math.round(v)),
}: {
  xs: number[];
  ys: number[];
  color: string;
  unit: string;
  label: string;
  fmt?: (v: number) => string;
}) {
  const W = 320, H = 110, PADL = 30, PADB = 16;
  const xMax = xs[xs.length - 1] || 1;
  const yMin = Math.min(0, ...ys), yMax = Math.max(...ys) || 1;
  const px = (x: number) => PADL + (x / xMax) * (W - PADL - 4);
  const py = (y: number) => 4 + (1 - (y - yMin) / (yMax - yMin || 1)) * (H - PADB - 8);
  // 점이 많으면 화면 폭에 맞게 솎는다(최대값은 살린다)
  const step = Math.max(1, Math.floor(xs.length / 300));
  const idx: number[] = [];
  for (let i = 0; i < xs.length; i += step) {
    let m = i;
    for (let j = i; j < Math.min(xs.length, i + step); j++) if (ys[j] > ys[m]) m = j;
    idx.push(m);
  }
  const d = idx.map((i, k) => `${k ? "L" : "M"}${px(xs[i]).toFixed(1)},${py(ys[i]).toFixed(1)}`).join(" ");
  const iMax = ys.indexOf(Math.max(...ys));
  return (
    <div className="mt-6">
      <div className="mb-1 flex items-baseline justify-between px-1">
        <p className="text-[11px] font-medium uppercase tracking-wide text-secondary">{label}</p>
        <p className="text-[11px] text-disabled">{unit}</p>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full">
        {[0, 0.5, 1].map((t) => {
          const v = yMin + (yMax - yMin) * t;
          return (
            <g key={t}>
              <line x1={PADL} x2={W - 4} y1={py(v)} y2={py(v)} stroke="#27272a" strokeWidth={0.6} />
              <text x={PADL - 4} y={py(v) + 3} fontSize={8} fill="#71717a" textAnchor="end">
                {fmt(v)}
              </text>
            </g>
          );
        })}
        <path d={`${d} L${px(xs[idx[idx.length - 1]])},${py(yMin)} L${px(xs[idx[0]])},${py(yMin)} Z`} fill={color} fillOpacity={0.12} />
        <path d={d} fill="none" stroke={color} strokeWidth={1.4} strokeLinejoin="round" />
        <circle cx={px(xs[iMax])} cy={py(ys[iMax])} r={2.6} fill={color} />
        <text x={Math.min(W - 30, px(xs[iMax]) + 4)} y={Math.max(10, py(ys[iMax]) - 4)} fontSize={9} fill="#e4e4e7">
          {fmt(ys[iMax])}
        </text>
        <text x={PADL} y={H - 3} fontSize={8} fill="#71717a">0</text>
        <text x={W - 4} y={H - 3} fontSize={8} fill="#71717a" textAnchor="end">
          {xMax.toFixed(xMax < 10 ? 1 : 0)}km
        </text>
      </svg>
    </div>
  );
}

export default function TripCharts({ path, speeds, vehicleTrace }: {
  vehicleTrace?: VehicleTrace;
  path?: string;
  speeds?: number[];
}) {
  const xs = path ? cumKm(path) : [];
  const showSpeed = !!speeds && speeds.length === xs.length && xs.length > 3 && xs[xs.length - 1] > 0.2;
  return <>
    {vehicleTrace && (vehicleTrace.steering.length > 0 || vehicleTrace.brake.length > 0) && <VehicleChart trace={vehicleTrace} />}
    {showSpeed && <LineChart xs={xs} ys={speeds!} color="#38bdf8" unit="km/h" label="거리별 속도" />}
  </>;
}

export function VehicleChart({ trace }: { trace: VehicleTrace }) {
  const points = trace.steering;
  const duration = Math.max(1, ...points.map(([t]) => t), ...trace.brake.map(([t]) => t));
  const scale = Math.max(1, ...points.map(([, v]) => Math.abs(v)));
  const x = (t: number) => 25 + t / duration * 290;
  const y = (v: number) => 50 - v / scale * 40;
  const d = points.map(([t, v], i) => `${i ? "L" : "M"}${x(t).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  return (
    <div className="mt-6 text-secondary">
      <p className="mb-2 text-[11px]">조향 · 제동{trace.brakeOverflow ? " · 제동 표시 일부 생략" : ""}</p>
      <svg viewBox="0 0 320 115" className="w-full" role="img" aria-label="시간별 조향각과 제동 표시">
        <line x1="25" x2="315" y1="50" y2="50" stroke="currentColor" strokeOpacity="0.3" />
        <text x="0" y="12" fontSize="9" fill="currentColor">{Math.round(scale)}°</text>
        <text x="0" y="93" fontSize="9" fill="currentColor">-{Math.round(scale)}°</text>
        <path d={d} fill="none" stroke="var(--color-accent)" strokeWidth="1.5" />
        {trace.brake.map(([t, pressed], i) => pressed === true ? <line key={i} x1={x(t)} x2={x(t)} y1="95" y2="102" stroke="var(--color-accent)" strokeWidth="2" /> : null)}
        <text x="25" y="113" fontSize="9" fill="currentColor">0</text>
        <text x="315" y="113" fontSize="9" fill="currentColor" textAnchor="end">{(duration / 60000).toFixed(1)}분</text>
      </svg>
    </div>
  );
}
