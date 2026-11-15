"use client";

import { IconClose } from "@/components/icons";

import { useEffect, useRef, useState } from "react";

import { cleanLabel } from "@/lib/display-text";
import { loadKakaoSdk } from "@/lib/kakao-sdk";
import type { DriveStyle, LatLng } from "@/lib/types";

export interface RoadviewPoint {
  name: string;
  coord: LatLng;
  /** 초기 시선 방향(도, 북=0) — 바다/강 쪽. 없으면 도로 진행 방향 기본 */
  pan?: number;
  /** 출발부터 거리(km) — 코스 어디쯤인지 */
  km?: number;

  place?: string;
}

/** 로드뷰 파노라마 하나 — 반경 내 파노라마가 없으면 자리 자체를 숨긴다 */
function RoadviewPane({
  point,
  onFail,
  captionBelow = false,
}: {
  point: RoadviewPoint;
  onFail: () => void;
  /** 설명 글자를 사진 위가 아니라 사진 아래에 — 사진을 가리지 않게(유저, 2026-11-13) */
  captionBelow?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");
  /** 찾은 파노라마 — "크게 보기"가 같은 장면을 전체 화면으로 다시 연다 */
  const [panoId, setPanoId] = useState<number | null>(null);
  const [big, setBig] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fail = () => {
      if (cancelled) return;
      setState("none");
      onFail();
    };
    loadKakaoSdk()
      .then(() => {
        if (cancelled || !ref.current) return;
        const kakao = window.kakao;
        const pos = new kakao.maps.LatLng(point.coord.lat, point.coord.lng);
        const client = new kakao.maps.RoadviewClient();
        // 80m 안을 먼저 — 나란한 다른 도로·엉뚱한 파노로 튀는 걸 막는다. 없으면
        // 200m까지 한 번 더(촬영 안 된 짧은 구간 때문에 칸이 사라지지 않게).
        const find = (radius: number, cb: (id: number | null) => void) =>
          client.getNearestPanoId(pos, radius, cb);
        find(80, (near: number | null) => {
          if (near || cancelled) return show(near);
          find(200, show);
        });
        function show(panoId: number | null) {
            if (cancelled || !ref.current) return;
            if (!panoId) {
              fail();
              return;
            }
            const rv = new kakao.maps.Roadview(ref.current, {
              panoId,
              // 물(바다/강) 쪽을 바라보게 — 서버가 지형으로 계산한 방향
              ...(point.pan !== undefined ? { pan: point.pan } : {}),
            });
            // init 후 시선 강제: pan(있으면) + tilt -4 — 기본값이 살짝
            // 하늘을 봐서 지평선보다 조금 아래로 내린다 (유저 피드백)
            kakao.maps.event.addListener(rv, "init", () => {
              const vp = rv.getViewpoint();
              rv.setViewpoint({
                pan: point.pan ?? vp.pan,
                tilt: -4,
                zoom: 0,
              });
            });
            setPanoId(panoId);
            setState("ok");
        }
      })
      .catch(fail);
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [point.coord.lat, point.coord.lng]);

  if (state === "none") return null;
  const pane = (
    <div data-roadview-pane className="relative h-36 overflow-hidden rounded-md border border-line bg-raised dark:border-line dark:bg-raised">
      {/* 카카오 로드뷰 캔버스는 4:3으로 렌더되고, 납작한 컨테이너에선
          위(하늘)부터 잘려 "하늘만 보이는" 버그가 난다. 내부 캔버스를 4:3으로
          만들어 세로 중앙(수평선)만 보이게 크롭한다 — 실측 스크린샷으로 검증 */}
      <div
        ref={ref}
        className="absolute inset-x-0 top-1/2 aspect-[4/3] w-full -translate-y-1/2"
      />
      {state === "loading" && (
        <div className="absolute inset-0 grid animate-pulse place-items-center text-xs text-secondary">
          로드뷰 불러오는 중…
        </div>
      )}
      {!captionBelow && (
      <span data-roadview-caption className="pointer-events-none absolute left-2 top-2 z-10 rounded-md bg-panel px-3 py-1 text-[11px] font-semibold leading-tight text-primary">
        {cleanLabel(point.name)}
        {point.km != null && (
          <span className="block text-[10px] font-normal text-primary">
            {point.km != null ? `(출발 ${Math.round(point.km)}km)` : ""}
          </span>
        )}
      </span>
      )}
      {/* 예전엔 map.kakao.com 링크로 나갔는데 PC 지도로 넘어가 폰에선 로드뷰가
          안 떴다 — 앱 안에서 같은 파노라마를 전체 화면으로 연다 */}
      {panoId != null && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setBig(true);
          }}
          aria-label="로드뷰 크게 보기"
          title="크게 보기"
          className="absolute right-2 top-2 z-10 grid place-items-center rounded-sm bg-panel/80 p-2 text-primary ring-1 ring-inset ring-line transition-colors hover:bg-bg"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" className="h-5 w-5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" /></svg>
        </button>
      )}
      {big && panoId != null && (
        <RoadviewFull
          panoId={panoId}
          pan={point.pan}
          name={cleanLabel(point.name)}
          onClose={() => setBig(false)}
        />
      )}
    </div>
  );
  if (!captionBelow) return pane;
  return (
    <div>
      {pane}
      <p data-roadview-below className="mt-1 truncate text-xs text-secondary">
        <span className="font-semibold text-primary">{cleanLabel(point.name)}</span>
        {point.km != null ? ` (출발 ${Math.round(point.km)}km)` : ""}
      </p>
    </div>
  );
}

/** 로드뷰 전체 화면 — 드래그로 둘러보기, 닫기/뒤로가기로 닫힘 */
function RoadviewFull({
  panoId,
  pan,
  name,
  onClose,
}: {
  panoId: number;
  pan?: number;
  name: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!ref.current) return;
    const kakao = window.kakao;
    const rv = new kakao.maps.Roadview(ref.current, {
      panoId,
      ...(pan !== undefined ? { pan } : {}),
    });
    kakao.maps.event.addListener(rv, "init", () => {
      const vp = rv.getViewpoint();
      rv.setViewpoint({ pan: pan ?? vp.pan, tilt: -4, zoom: 0 });
    });
    // 폰 뒤로가기로 닫히게
    history.pushState({ roadview: true }, "");
    const onPop = () => onClose();
    window.addEventListener("popstate", onPop);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("popstate", onPop);
      document.body.style.overflow = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [panoId]);
  return (
    <div
      className="fixed inset-0 z-[100] bg-bg"
      onClick={(e) => e.stopPropagation()}
    >
      <div ref={ref} className="absolute inset-0" />
      <span className="pointer-events-none absolute left-4 top-[calc(env(safe-area-inset-top)+16px)] z-10 rounded-sm bg-panel px-3 py-2 text-[13px] font-semibold text-primary">
        {cleanLabel(name)}
      </span>
      <button
        type="button"
        onClick={() => history.back()}
        aria-label="닫기"
        className="absolute right-4 top-[calc(env(safe-area-inset-top)+12px)] z-10 grid h-10 w-10 place-items-center rounded-sm bg-panel text-lg font-bold text-primary"
      >
        <IconClose />
      </button>
    </div>
  );
}

/** 같은 코스 재선택 때 재요청 안 하게 — 라벨 기준 모듈 캐시 */
const spotsCache = new Map<string, RoadviewPoint[]>();

/**
 * 선택된 코스 카드에 붙는 로드뷰 미리보기 스트립. 촬영 지점은 서버
 * (/api/photo-spots)가 고른다 — 스타일 풍경 매칭(와인딩–산, 해안–바다,
 * 강변–강), 도시·마을 제외, 물 쪽 바라보는 pan까지. JS SDK 로드뷰라
 * REST 쿼터를 안 먹는다.
 */
export default function RoadviewStrip({
  path,
  styles,
  cacheKey,
  wide = false,
  emptyText,
}: {
  path: LatLng[];
  /** 유저가 고른 스타일들 + 후보의 styleTag — 서버가 풍경 우선순위로 씀 */
  styles?: DriveStyle[];
  cacheKey: string;
  /** 지도 아래 넓은 자리 — 두 장을 반반 나란히, 가로 넘김 없이 */
  wide?: boolean;
  /** 보여 줄 지점이 하나도 없을 때 칸을 숨기는 대신 띄울 안내 */
  emptyText?: string;
}) {
  const [points, setPoints] = useState<RoadviewPoint[] | null>(
    () => spotsCache.get(cacheKey) ?? null,
  );
  const [failCount, setFailCount] = useState(0);

  useEffect(() => {
    if (spotsCache.has(cacheKey)) {
      setPoints(spotsCache.get(cacheKey)!);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/photo-spots", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, styles }),
        });
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const spots: RoadviewPoint[] = data.spots ?? [];
        spotsCache.set(cacheKey, spots);
        setPoints(spots);
      } catch {
        // 스팟 선정 실패 = 로드뷰 없이 감 (치명적이지 않음)
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cacheKey]);

  // 전부 실패(커버리지 없음·SDK 실패)하면 캡션만 남지 않게 통째로 숨긴다
  if (points && emptyText && (points.length === 0 || failCount >= points.length))
    return <p data-roadview-empty className="mt-3 text-xs text-secondary">{emptyText}</p>;
  if (!points || points.length === 0 || failCount >= points.length) return null;
  return (
    <div
      className="mt-3"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      role="presentation"
    >
      <p data-roadview-title className="mb-2 flex items-baseline gap-2 text-xs font-semibold text-secondary dark:text-secondary">
        로드뷰 미리보기
      </p>
      {/* 가로로 넘겨 보게 해서 카드 높이를 한 장 분량으로 묶는다 */}
      <div className={wide
        ? `grid gap-2 ${points.length > 1 ? "grid-cols-2" : "grid-cols-1"}`
        : `flex snap-x gap-2 overflow-x-auto pb-1 [&>*]:shrink-0 [&>*]:snap-start ${points.length > 1 ? "[&>*]:w-[85%]" : "[&>*]:w-full"}`}>
        {points.map((p) => (
          <RoadviewPane
            key={`${p.coord.lat},${p.coord.lng}`}
            point={p}
            captionBelow={wide}
            onFail={() => setFailCount((n) => n + 1)}
          />
        ))}
      </div>
    </div>
  );
}
