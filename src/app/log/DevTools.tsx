"use client";

import { useEffect, useRef, useState } from "react";

import { BORROW_SERVER } from "@/lib/borrow-mode";
import { devMark, devlog } from "@/lib/devlog";
import type { LatLng } from "@/lib/types";

/**
 * 개발자 옵션 — 주행 화면 왼쪽의 "다름"·"비교" 버튼.
 *  - 다름: 다른 내비(티맵·카카오)와 안내가 다를 때 누른다. 이유를 고르면 그 순간 위치와
 *    직전 2분 앱 판단 기록을 서버(data/devlog)에 따로 저장한다.
 *  - 비교: 지도에 출처별 단속카메라(공공·티맵·카카오)와, 경로 안내 중이면 카카오 경로를 겹친다.
 */
export type DevCompare = {
  cams: { lat: number; lng: number; src: "public" | "tmap" | "kakao"; limit: number }[];
  route?: LatLng[];
};

const REASONS = [
  { id: "cam-miss", label: "카메라 경고 놓침" },
  { id: "cam-false", label: "헛경고" },
  { id: "route-diff", label: "길 안내 다름" },
  { id: "other", label: "기타" },
] as const;

const dM = (a: LatLng, b: LatLng) =>
  Math.hypot((b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180), (b.lat - a.lat) * 111320);

/** 비교 자료 — 700m 움직일 때마다 반경 2.5km 카메라, 경로가 바뀌면 카카오 경로 */
export function useDevCompare(requested: boolean, pos: LatLng | null, navPath: LatLng[] | null): DevCompare | null {
  // 빌려 쓰기 모드: 개발용 비교 API(/api/dev/*)는 drivelog에서 로그인이 필요하고 부르지도 않는다.
  const on = requested && !BORROW_SERVER;
  const [cams, setCams] = useState<DevCompare["cams"] | null>(null);
  const [route, setRoute] = useState<LatLng[] | undefined>(undefined);
  const lastAt = useRef<LatLng | null>(null);
  const routeKey = useRef("");

  useEffect(() => {
    if (!on || !pos) return;
    if (lastAt.current && dM(lastAt.current, pos) < 700) return;
    lastAt.current = pos;
    // 위치는 1초마다 바뀌므로 요청을 취소하지 않는다(취소하면 느린 응답이 영영 안 들어온다)
    fetch(`/api/dev/compare?lat=${pos.lat}&lng=${pos.lng}&r=2500`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j) return;
        const out: DevCompare["cams"] = [];
        for (const src of ["public", "tmap", "kakao"] as const)
          for (const c of j[src] ?? []) out.push({ lat: c.lat, lng: c.lng, src, limit: c.limit });
        setCams(out);
      })
      .catch(() => {
        lastAt.current = null; // 실패면 다음 위치에서 다시
      });
  }, [on, pos]);

  useEffect(() => {
    if (!on || !navPath || navPath.length < 2 || !pos) return;
    const end = navPath[navPath.length - 1];
    const key = `${navPath.length}|${end.lat.toFixed(5)},${end.lng.toFixed(5)}`;
    if (key === routeKey.current) return;
    routeKey.current = key;
    fetch(`/api/dev/compare?route=1&olat=${pos.lat}&olng=${pos.lng}&dlat=${end.lat}&dlng=${end.lng}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (!j?.path) return;
        const path = (j.path as [number, number][]).map(([lat, lng]) => ({ lat, lng }));
        setRoute(path);
        devlog("compare-route", { n: path.length, from: pos, to: end });
      })
      .catch(() => {});
  }, [on, navPath, pos]);

  useEffect(() => {
    if (!on) {
      lastAt.current = null; // 다시 켜면 바로 새로 받는다
      routeKey.current = "";
    }
  }, [on]);

  return on && cams ? { cams, route: navPath ? route : undefined } : null;
}

export default function DevTools({
  pos,
  kmh,
  heading,
  mode,
  compareOn,
  onCompare,
  top,
}: {
  pos: LatLng | null;
  kmh: number;
  heading: number | null;
  mode: "nav" | "free";
  compareOn: boolean;
  onCompare: (v: boolean) => void;

  top: number;
}) {
  const [sheet, setSheet] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  // 누른 순간 위치 — 이유 고르는 사이 차가 움직여도 누른 곳을 남긴다
  const at = useRef<{ pos: LatLng | null; kmh: number; heading: number | null; t: number } | null>(null);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2500);
    return () => clearTimeout(id);
  }, [toast]);

  return (
    <>
      <div data-over-map className="pointer-events-auto fixed left-3 z-50 flex flex-col gap-2" style={{ top }}>
        <button
          type="button"
          onClick={() => {
            at.current = { pos, kmh, heading, t: Date.now() };
            setSheet(true);
          }}
          className="rounded-md bg-accent px-3 py-2 text-[13px] font-bold text-primary"
        >
          다름
        </button>
        <button
          type="button"
          onClick={() => onCompare(!compareOn)}
          className={`rounded-md px-3 py-2 text-[13px] font-bold  ${
            compareOn ? "bg-panel text-primary" : "bg-raised text-primary"
          }`}
        >
          비교
        </button>
      </div>
      {sheet && (
        <div data-map-block className="fixed inset-0 z-[60] flex items-end bg-overlay" onClick={() => setSheet(false)}>
          <div className="w-full rounded-t-lg bg-panel p-4 pb-8" onClick={(e) => e.stopPropagation()}>
            <p className="mb-3 text-[15px] font-bold text-primary">무엇이 달랐나요?</p>
            <div className="grid grid-cols-2 gap-2">
              {REASONS.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={async () => {
                    setSheet(false);
                    const a = at.current;
                    const ok = await devMark(r.id, {
                      lat: a?.pos?.lat,
                      lng: a?.pos?.lng,
                      kmh: a?.kmh,
                      heading: a?.heading,
                      pressedAt: a?.t,
                      mode,
                    });
                    setToast(ok ? "기록했어요" : "저장 실패 — 네트워크를 확인해 주세요");
                  }}
                  className="rounded-md bg-raised px-3 py-4 text-[14px] font-semibold text-primary"
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
      {toast && (
        <div data-over-map className="pointer-events-none fixed inset-x-0 top-24 z-[61] flex justify-center">
          <span className="rounded-sm bg-overlay px-4 py-2 text-[13px] text-primary">{toast}</span>
        </div>
      )}
    </>
  );
}
