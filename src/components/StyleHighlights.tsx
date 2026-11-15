"use client";

import { windingColor } from "@/components/RouteMapOSM";
import { curvatureSegments, distanceM } from "@/lib/scoring/curvature";
import type { DriveStyle, RouteCandidate } from "@/lib/types";

/**
 * 고른 드라이브 종류에 맞춘 코스 요약 — 와인딩·산길이면 굽은 길, 강변·해안이면 물가,
 * 직선이면 곧은 길을 앞에 보여 준다. 아무것도 안 골랐으면 표시하지 않는다.
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
  // 1km 창으로 나눈 구간별 굽은 정도와, 각 창이 시작하는 거리(km)
  const segs = curvatureSegments(c.path, 1000);
  const starts: number[] = [];
  let acc = 0;
  for (const s of segs) {
    starts.push(acc / 1000);
    for (let i = 1; i < s.path.length; i++) acc += distanceM(s.path[i - 1], s.path[i]);
  }

  const boxes: React.ReactNode[] = [];

  if (wantsWinding) {
    const hairpins = Number((c.badges ?? []).map((b) => b.match(/헤어핀 (\d+)개/)?.[1]).find(Boolean) ?? 0);
    let top = -1;
    segs.forEach((s, i) => {
      if (top < 0 || s.degPerKm > segs[top].degPerKm) top = i;
    });
    const curvyKm = segs.filter((s) => s.degPerKm >= 40).length; // 1km 창이라 개수 = km
    boxes.push(
      <div key="winding" data-style-box="winding" className="rounded-md border border-line bg-raised p-3">
        <p className="text-xs font-semibold text-primary">와인딩·산길</p>
        <ul className="mt-1 space-y-0.5 text-xs text-secondary">
          <li>헤어핀(아주 급한 굽이) {hairpins > 0 ? `${hairpins}개` : "없음"}</li>
          <li>굽은 길 약 {curvyKm}km</li>
          {top >= 0 && segs[top].degPerKm > 0 && (
            <li>가장 굽은 곳: 출발 {starts[top].toFixed(0)}km 지점</li>
          )}
          {c.elevation && <li>최고 해발 약 {Math.round(c.elevation.maxEle)}m</li>}
        </ul>
        {/* 거리별 굽은 정도 — 가로는 출발→도착, 높을수록 굽은 길. 색은 지도 와인딩 색과 같다 */}
        <svg
          viewBox={`0 0 ${segs.length} 40`}
          preserveAspectRatio="none"
          className="mt-2 block h-12 w-full"
          role="img"
          aria-label="거리별 굽은 정도 그래프"
        >
          {segs.map((s, i) => {
            const h = Math.max(1, Math.min(s.degPerKm / 120, 1) * 40);
            return <rect key={i} x={i} y={40 - h} width={0.9} height={h} fill={windingColor(s.degPerKm)} />;
          })}
        </svg>
        <div className="mt-1 flex justify-between text-[10px] text-secondary">
          <span>출발</span>
          <span>{totalKm.toFixed(0)}km</span>
        </div>
      </div>,
    );
  }

  if (wantsRiver || wantsCoast) {
    const m = c.metrics;
    const lines: string[] = [];
    if (!m) lines.push("물가 구간 계산 중…");
    else {
      if (wantsRiver) {
        const km = Math.round(m.riverRatio * totalKm);
        lines.push(km > 0 ? `강을 따라 달리는 길 약 ${km}km (전체의 ${Math.round(m.riverRatio * 100)}%)` : "강을 따라 달리는 길이 거의 없어요");
      }
      if (wantsCoast) {
        const km = Math.round(m.seaShoreRatio * totalKm);
        const view = Math.round((m.seaShoreRatio + m.seaViewRatio) * totalKm);
        lines.push(km > 0 ? `바닷가 길 약 ${km}km` : "바닷가 바로 옆 길은 거의 없어요");
        if (view > km) lines.push(`바다가 보이는 길 약 ${view}km`);
      }
    }
    boxes.push(
      <div key="water" data-style-box="water" className="rounded-md border border-line bg-raised p-3">
        <p className="text-xs font-semibold text-primary">{wantsRiver && wantsCoast ? "강변·해안" : wantsRiver ? "강변" : "해안"}</p>
        <ul className="mt-1 space-y-0.5 text-xs text-secondary">
          {lines.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </div>,
    );
  }

  if (wantsStraight) {
    let best = 0;
    let run = 0;
    let straightKm = 0;
    for (const s of segs) {
      if (s.degPerKm < 15) {
        run++;
        straightKm++;
        best = Math.max(best, run);
      } else run = 0;
    }
    boxes.push(
      <div key="straight" data-style-box="straight" className="rounded-md border border-line bg-raised p-3">
        <p className="text-xs font-semibold text-primary">직선도로</p>
        <ul className="mt-1 space-y-0.5 text-xs text-secondary">
          <li>가장 긴 곧은 길 약 {best}km</li>
          <li>곧은 길 비율 {segs.length ? Math.round((straightKm / segs.length) * 100) : 0}%</li>
        </ul>
      </div>,
    );
  }

  return <div className="mt-2 space-y-2" onClick={(e) => e.stopPropagation()}>{boxes}</div>;
}
