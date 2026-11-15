"use client";

import { curvatureSegments, distanceM } from "@/lib/scoring/curvature";
import type { DriveStyle, RouteCandidate } from "@/lib/types";

/** 한 줄 막대 — 전체 중 얼마나인지 */
function ShareBar({ ratio, color }: { ratio: number; color: string }) {
  return (
    <span className="gb-share" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(ratio * 100)}>
      <span style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%`, background: color }} />
    </span>
  );
}

/**
 * 고른 길 종류에 맞춘 코스 설명(코스 상세 오른쪽).
 * 와인딩·산길: 굽은 정도(노란 면)와 고도(흰 선)를 같은 거리 축에, 아래에 급커브 수.
 * 해안·강변: 그 길 길이를 크게, 전체 중 비율 막대. 직선: 가장 긴 곧은 길.
 * 아무것도 안 골랐으면 표시하지 않는다.
 */
export default function StyleHighlights({
  candidate: c,
  styles,
}: {
  candidate: RouteCandidate;
  styles: DriveStyle[];
}) {
  const wantsWinding = styles.includes("와인딩") || styles.includes("산길");
  const wantsRiver = styles.includes("강변도로");
  const wantsCoast = styles.includes("해안도로");
  const wantsStraight = styles.includes("직선도로");
  if (!wantsWinding && !wantsRiver && !wantsCoast && !wantsStraight) return null;

  const totalKm = c.distanceM / 1000;
  // 1km 창으로 나눈 구간별 굽은 정도와, 각 창의 가운데 거리(km)
  const segs = curvatureSegments(c.path, 1000);
  const mids: number[] = [];
  let acc = 0;
  for (const s of segs) {
    let len = 0;
    for (let i = 1; i < s.path.length; i++) len += distanceM(s.path[i - 1], s.path[i]);
    mids.push((acc + len / 2) / 1000);
    acc += len;
  }
  const axisKm = Math.max(acc / 1000, 0.001);
  const boxes: React.ReactNode[] = [];

  if (wantsWinding) {
    const hairpins = Number((c.badges ?? []).map((b) => b.match(/헤어핀 (\d+)개/)?.[1]).find(Boolean) ?? 0);
    const W = 448, H = 150, top = 8;
    const maxDeg = Math.max(120, ...segs.map((s) => s.degPerKm));
    const x = (km: number) => (km / axisKm) * W;
    const yCurve = (deg: number) => H - (Math.min(deg, maxDeg) / maxDeg) * (H - top);
    const area = segs.length
      ? `M0,${H} ${segs.map((s, i) => `L${x(mids[i]).toFixed(1)},${yCurve(s.degPerKm).toFixed(1)}`).join(" ")} L${W},${H} Z`
      : "";
    const ele = c.elevation;
    let eleLine = "";
    if (ele && ele.samples.length > 1) {
      const range = Math.max(ele.maxEle - ele.minEle, 1);
      const eleKm = ((ele.samples.length - 1) * ele.stepM) / 1000;
      eleLine = ele.samples
        .map((v, i) => {
          const km = (i / (ele.samples.length - 1)) * eleKm;
          const yy = H - 6 - ((v - ele.minEle) / range) * (H - top - 12);
          return `${i ? "L" : "M"}${x(Math.min(km, axisKm)).toFixed(1)},${yy.toFixed(1)}`;
        })
        .join(" ");
    }
    const extras = [
      ele ? `최고 고도 ${Math.round(ele.maxEle).toLocaleString()}m` : null,
      ele ? `오르막 합계 ${Math.round(ele.gainM).toLocaleString()}m` : null,
    ].filter(Boolean) as string[];
    boxes.push(
      <div key="winding" data-style-box="winding" className="gb-type">
        <div className="gb-type-head">
          <p className="gb-type-title">굽은 정도와 고도</p>
          <p className="gb-type-legend">
            <span><i className="gb-sw-curve" />굽은 정도</span>
            {eleLine && <span><i className="gb-sw-ele" />고도</span>}
          </p>
        </div>
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="gb-type-chart" role="img" aria-label="거리별 굽은 정도와 고도 그래프">
          <line x1="0" y1={H - 0.5} x2={W} y2={H - 0.5} stroke="#f4f3ef" strokeOpacity="0.2" />
          {area && <path d={area} fill="#F5C542" fillOpacity="0.88" />}
          {eleLine && <path d={eleLine} fill="none" stroke="#f4f3ef" strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />}
        </svg>
        <div className="gb-type-axis">
          <span>출발</span>
          <span>{totalKm.toFixed(0)}km</span>
        </div>
        <p className="gb-type-line">
          {hairpins > 0 ? (
            <>
              <b>급커브 {hairpins}곳</b>
              {extras.length > 0 && <span> ({extras.join(", ")})</span>}
            </>
          ) : extras.length > 0 ? (
            <>
              <b>{extras[0]}</b>
              {extras[1] && <span> ({extras[1]})</span>}
            </>
          ) : (
            <b>급커브 적음</b>
          )}
        </p>
      </div>,
    );
  }

  const water = (key: string, title: string, ratio: number | undefined, color: string) => {
    const km = ratio == null ? null : Math.round(ratio * totalKm);
    boxes.push(
      <div key={key} data-style-box={key} className="gb-type">
        <p className="gb-type-title">{title}</p>
        {km == null ? (
          <p className="gb-type-line">계산 중</p>
        ) : (
          <>
            <p className="gb-type-big">
              <span className="gb-big">
                {km}
                <small>km</small>
              </span>
            </p>
            <ShareBar ratio={ratio ?? 0} color={color} />
            <p className="gb-type-sub">전체 {totalKm.toFixed(0)}km 중</p>
          </>
        )}
      </div>,
    );
  };
  if (wantsCoast) water("coast", "바닷가 길", c.metrics?.seaShoreRatio, "#1D4ED8");
  if (wantsRiver) water("river", "강변 길", c.metrics?.riverRatio, "#0891B2");

  if (wantsStraight) {
    let best = 0;
    let run = 0;
    let straight = 0;
    for (const s of segs) {
      if (s.degPerKm < 15) {
        run++;
        straight++;
        best = Math.max(best, run);
      } else run = 0;
    }
    const ratio = segs.length ? straight / segs.length : 0;
    boxes.push(
      <div key="straight" data-style-box="straight" className="gb-type">
        <p className="gb-type-title">가장 긴 곧은 길</p>
        <p className="gb-type-big">
          <span className="gb-big">
            {best}
            <small>km</small>
          </span>
        </p>
        <ShareBar ratio={ratio} color="#f4f3ef" />
        <p className="gb-type-sub">곧은 길 {Math.round(ratio * 100)}% (전체 {totalKm.toFixed(0)}km 중)</p>
      </div>,
    );
  }

  return <div className="gb-types">{boxes}</div>;
}
