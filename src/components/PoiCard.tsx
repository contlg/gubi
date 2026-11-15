"use client";

import { IconClose } from "@/components/icons";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { loadKakaoSdk } from "@/lib/kakao-sdk";
import { cleanLabel } from "@/lib/display-text";
import type { LatLng } from "@/lib/types";

export interface PoiCardPlace {
  name: string;
  coord: LatLng;
  address?: string;
  type?: string;
  rating?: number;
  ratingCount?: number;
  offRouteM?: number;
  /** 카카오에서 찾은 가게면 장소 페이지로 바로 연결 */
  kakaoId?: string;
  /** 카카오 분류 "음식점 > 카페 > 커피전문점" */
  category?: string;
  phone?: string;
  /** 주유소 — 오피넷 원/L·상표·유종 */
  price?: number;
  brand?: string;
  fuel?: string;
}

/** 장소 위치의 카카오 로드뷰 — 카카오맵 상세 창 맨 위 사진처럼. 없으면 칸을 숨긴다 */
function RoadviewHeader({ coord }: { coord: LatLng }) {
  const ref = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"loading" | "ok" | "none">("loading");
  useEffect(() => {
    let cancelled = false;
    loadKakaoSdk()
      .then(() => {
        if (cancelled || !ref.current) return;
        const kakao = window.kakao;
        const pos = new kakao.maps.LatLng(coord.lat, coord.lng);
        new kakao.maps.RoadviewClient().getNearestPanoId(pos, 120, (panoId: number | null) => {
          if (cancelled || !ref.current) return;
          if (!panoId) return setState("none");
          const rv = new kakao.maps.Roadview(ref.current, { panoId });
          // 로드뷰 카메라가 장소를 바라보게 — 파노 위치에서 장소 방향
          kakao.maps.event.addListener(rv, "init", () => {
            const p = rv.getPosition();
            const dy = coord.lat - p.getLat();
            const dx = (coord.lng - p.getLng()) * Math.cos((coord.lat * Math.PI) / 180);
            const pan = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
            rv.setViewpoint({ pan, tilt: 0, zoom: 0 });
          });
          setState("ok");
        });
      })
      .catch(() => setState("none"));
    return () => {
      cancelled = true;
    };
  }, [coord.lat, coord.lng]);
  if (state === "none") return null;
  return (
    <div className="relative h-44 overflow-hidden rounded-md bg-raised">
      <div ref={ref} className="absolute inset-x-0 top-1/2 aspect-[4/3] w-full -translate-y-1/2" />
      {state === "loading" && (
        <div className="absolute inset-0 grid animate-pulse place-items-center text-xs text-secondary">
          로드뷰 불러오는 중…
        </div>
      )}
      <span className="pointer-events-none absolute bottom-2 right-2 rounded-sm bg-panel px-3 py-1 text-[11px] font-semibold text-primary">
        로드뷰
      </span>
    </div>
  );
}

/**
 * 지도 핀을 누르면 뜨는 장소 상세 창 — 카카오맵 상세 창처럼. 태블릿·PC는 왼쪽 옆
 * 창, 폰은 아래에서 올라오는 창. body로 띄워 전체화면 지도 위에도 보인다.
 * 영업시간·메뉴·사진은 카카오가 API로 안 줘서 "카카오맵" 버튼으로 넘긴다.
 */
export default function PoiCard({
  place,
  onAdd,
  adding,
  onClose,
}: {
  place: PoiCardPlace;
  onAdd?: () => void;
  adding?: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // 뒤로가기/ESC로 닫기
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const q = encodeURIComponent(place.name);
  const kakao = place.kakaoId
    ? `https://place.map.kakao.com/${place.kakaoId}`
    : `https://map.kakao.com/link/search/${q}`;
  const naver = `https://map.naver.com/p/search/${q}?c=${place.coord.lng},${place.coord.lat},15,0,0,0,dh`;
  const google = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(
    `${place.name} ${place.address ?? ""}`.trim(),
  )}`;
  const kind = place.category?.split(" > ").slice(-1)[0] ?? place.type;
  const off =
    place.offRouteM == null
      ? null
      : place.offRouteM < 300
        ? "코스 길가"
        : `코스에서 ${place.offRouteM < 1000 ? `${place.offRouteM}m` : `${(place.offRouteM / 1000).toFixed(1)}km`}`;

  const row = "flex items-start gap-3 py-3 text-sm text-primary dark:text-primary";
  const linkBtn =
    "flex flex-1 flex-col items-center gap-1 rounded-md bg-raised py-2 text-[11px] font-medium text-primary dark:bg-raised dark:text-primary";

  if (typeof document === "undefined") return null; // 서버 미리그리기 중엔 그리지 않는다
  return createPortal(
    <div className="fixed inset-0 z-[95]" onClick={onClose}>
      {/* 폰: 아래 시트 / md 이상: 왼쪽 옆 창 */}
      <div
        className="absolute inset-x-0 bottom-0 max-h-[78vh] overflow-y-auto rounded-t-lg bg-panel p-4 pb-[calc(env(safe-area-inset-bottom)+16px)] dark:bg-panel md:bottom-auto md:left-3 md:right-auto md:top-3 md:max-h-[calc(100vh-24px)] md:w-[380px] md:rounded-md"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        <div className="mx-auto mb-3 h-1 w-10 rounded-sm bg-raised md:hidden dark:bg-raised" />
        <div className="relative">
          <RoadviewHeader coord={place.coord} />
          <button
            type="button"
            aria-label="닫기"
            onClick={onClose}
            className="absolute right-2 top-2 z-10 grid h-9 w-9 place-items-center rounded-sm bg-raised text-primary ring-1 ring-inset ring-line"
          >
            <IconClose />
          </button>
        </div>

        <div className="mt-3 flex items-baseline gap-2">
          <h3 className="min-w-0 truncate text-xl font-bold text-primary dark:text-primary">{cleanLabel(place.name)}</h3>
          {kind && <span className="shrink-0 text-xs text-secondary">{cleanLabel(kind)}</span>}
        </div>
        {place.rating != null && (
          <p className="mt-1 text-sm">
            <b className="text-danger">{place.rating}</b>{" "}
            <span className="text-danger">평점</span>
            {place.ratingCount ? <span className="text-secondary"> ({place.ratingCount})</span> : null}
            <span className="ml-1 text-[11px] text-secondary">구글</span>
          </p>
        )}

        <div className="mt-2 divide-y divide-line dark:divide-line">
          {place.price != null && (
            <div className={row}>
              <span>주유</span>
              <span>
                <b>{cleanLabel(place.fuel ?? "휘발유")} {place.price.toLocaleString()}원/L</b>
                {place.brand && <span className="text-secondary"> ({cleanLabel(place.brand)})</span>}
              </span>
            </div>
          )}
          {off && (
            <div className={row}>
              <span>안내</span>
              <span>{off}</span>
            </div>
          )}
          {place.address && (
            <div className={row}>
              <span>위치</span>
              <span className="min-w-0 flex-1">{cleanLabel(place.address)}</span>
              <button
                type="button"
                onClick={() => {
                  void navigator.clipboard?.writeText(place.address!).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1500);
                  });
                }}
                className="shrink-0 text-xs text-secondary underline"
              >
                {copied ? "복사됨" : "복사"}
              </button>
            </div>
          )}
          {place.phone && (
            <div className={row}>
              <span>전화</span>
              <a href={`tel:${place.phone.replace(/[^0-9+]/g, "")}`} className="underline">
                {place.phone}
              </a>
            </div>
          )}
        </div>

        <p className="mt-3 text-[11px] text-secondary">영업시간·메뉴·사진은 지도 앱에서 볼 수 있어요</p>
        <div className="mt-2 flex gap-2">
          <a href={kakao} target="_blank" rel="noreferrer" className={linkBtn}>
            카카오맵
          </a>
          <a href={naver} target="_blank" rel="noreferrer" className={linkBtn}>
            네이버지도
          </a>
          <a href={google} target="_blank" rel="noreferrer" className={linkBtn}>
            구글지도
          </a>
        </div>
        {onAdd && (
          <button
            type="button"
            disabled={adding}
            onClick={onAdd}
            className="mt-3 w-full rounded-md bg-accent py-4 text-sm font-bold text-primary disabled:opacity-40"
          >
            + 이 코스에 경유지로 추가
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
