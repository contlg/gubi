"use client";

import { useEffect, useState } from "react";

import { SPECIAL_COLOR, SPECIAL_NAME } from "@/components/RouteMapOSM";
import type { SpecialKind } from "@/lib/special-segments";
import type { LatLng, SpecialRanges } from "@/lib/types";

/** 주행 경로 위 특별 구간(와인딩·해안·강변) — 출발부터 m */
export interface DriveSpecial {
  kind: SpecialKind;
  from: number;
  to: number;
}

const KINDS: SpecialKind[] = ["winding", "coast", "river"];
/** 고른 길 종류를 주행 화면은 모른다 — 코스에 이만큼 이상 있는 종류만 보인다 */
const KIND_MIN_TOTAL_M = 2000;
const PIECE_MIN_M = 300;
/** 다음 구간은 이 거리 안일 때만 알린다 */
const AHEAD_MAX_M = 30_000;

/**
 * 코스 주행 중 경로의 특별 구간을 한 번 받아 온다(경로가 바뀔 때만 다시).
 * 코스 상세와 같은 서버 계산(/api/route-metrics)이라 같은 구간이 칠해진다.
 * 실패하면 조용히 없음 — 주행 안내에는 영향이 없다.
 */
export function useDriveSpecial(path: LatLng[] | null, enabled: boolean): DriveSpecial[] | null {
  const [got, setGot] = useState<{ path: LatLng[]; segs: DriveSpecial[] } | null>(null);
  useEffect(() => {
    if (!enabled || !path || path.length < 2) return;
    const ctrl = new AbortController();
    fetch("/api/route-metrics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ paths: [path] }),
      signal: ctrl.signal,
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        const special: SpecialRanges | undefined = data?.metrics?.[0]?.special;
        if (!special) return;
        const segs: DriveSpecial[] = [];
        for (const kind of KINDS) {
          const pieces = (special[kind] ?? []).filter(([a, b]) => b - a >= PIECE_MIN_M);
          const total = pieces.reduce((sum, [a, b]) => sum + (b - a), 0);
          if (total >= KIND_MIN_TOTAL_M) for (const [from, to] of pieces) segs.push({ kind, from, to });
        }
        segs.sort((a, b) => a.from - b.from);
        setGot({ path, segs });
      })
      .catch(() => {});
    return () => ctrl.abort();
  }, [path, enabled]);
  return enabled && got && got.path === path ? got.segs : null;
}

/** 겹칠 때 앞서는 종류 — 굽잇길이 먼저 */
const RANK: Record<SpecialKind, number> = { winding: 0, coast: 1, river: 2 };

/** 지도에 칠할 구간(색 포함) — 중요한 종류를 뒤에 두어 겹치면 위에 그려지게 */
export function specialPaint(segs: DriveSpecial[] | null) {
  return segs
    ? [...segs]
        .sort((a, b) => RANK[b.kind] - RANK[a.kind])
        .map((s) => ({ from: s.from, to: s.to, color: SPECIAL_COLOR[s.kind] }))
    : undefined;
}

const km = (m: number) => (m >= 950 ? `${(m / 1000).toFixed(1)}km` : `${Math.max(0, Math.round(m / 10) * 10)}m`);

/** 지금 달리는 특별 구간, 아니면 30km 안의 다음 구간 */
export function SpecialNow({ segs, along }: { segs: DriveSpecial[] | null; along: number | null }) {
  if (!segs?.length || along == null) return null;
  const now = segs
    .filter((s) => along >= s.from && along < s.to)
    .sort((a, b) => RANK[a.kind] - RANK[b.kind])[0];
  const next = now ? null : segs.find((s) => s.from > along && s.from - along <= AHEAD_MAX_M);
  const s = now ?? next;
  if (!s) return null;
  return (
    <p data-drv-special className="drv-line">
      <i style={{ background: SPECIAL_COLOR[s.kind] }} aria-hidden="true" />
      {now ? (
        <>
          <b>{SPECIAL_NAME[s.kind]} 구간</b>
          <span>({km(s.to - along)} 남음)</span>
        </>
      ) : (
        <>
          <b>
            다음 {SPECIAL_NAME[s.kind]} {km(s.from - along)}
          </b>
          <span>(길이 {km(s.to - s.from)})</span>
        </>
      )}
    </p>
  );
}

/** 코스 진행 막대 — 전체 경로 위에 특별 구간과 지금 위치. 움직임 효과 없음 */
export function CourseBar({ segs, along, total }: { segs: DriveSpecial[] | null; along: number | null; total: number }) {
  if (!(total > 0) || along == null) return null;
  const pct = (m: number) => `${Math.max(0, Math.min(100, (m / total) * 100))}%`;
  return (
    <div data-drv-course-bar className="drv-bar" aria-label={`코스 ${Math.round((along / total) * 100)}% 진행`}>
      <span className="drv-bar-done" style={{ width: pct(along) }} />
      {[...(segs ?? [])].sort((a, b) => RANK[b.kind] - RANK[a.kind]).map((s, i) => (
        <span
          key={i}
          className="drv-bar-seg"
          style={{ left: pct(s.from), width: pct(s.to - s.from), background: SPECIAL_COLOR[s.kind] }}
        />
      ))}
      <span className="drv-bar-me" style={{ left: pct(along) }} />
    </div>
  );
}
