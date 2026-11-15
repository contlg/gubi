"use client";

/* eslint-disable @typescript-eslint/no-explicit-any */

import { IconTarget } from "@/components/icons";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { loadKakaoSdk } from "@/lib/kakao-sdk";

import type { LatLng } from "@/lib/types";

/**
 * 지도에서 지점 고르기 — 전체화면. 지도를 끌어 가운데 핀에 맞추고 "여기로"를 누른다.
 * 길찾기 출발·목적지·경유지, 코스 추천 출발·목적지·꼭 들를 곳, 즐겨찾기 추가에서 쓴다.
 * 지도는 카카오맵 JS SDK. 가운데 지점 이름은 /api/revgeocode?detail=1
 * (카카오 도로명 주소, 실패 시 행정동).
 */
export interface PickedPlace {
  name: string;
  address: string;
  lat: number;
  lng: number;
}

type Props = {
  open: boolean;
  title?: string;

  initial?: LatLng | null;
  confirmLabel?: string;
  /** 차량 화면: body 포털에서도 큰 터치 단추 규칙을 받게 한다 */
  vehicleTouch?: boolean;
  onPick: (p: PickedPlace) => void;
  onClose: () => void;
};

/** 열릴 때마다 새로 만든다 — 처음 가운데를 상태 초기값으로 */
export default function MapPicker(props: Props) {
  if (!props.open || typeof document === "undefined") return null;
  return <MapPickerOpen {...props} />;
}

function MapPickerOpen({ title = "지도에서 선택", initial, confirmLabel = "여기로", vehicleTouch = false, onPick, onClose }: Props) {
  const start = initial ?? { lat: 37.5665, lng: 126.978 };
  const boxRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<any>(null);
  const userMoved = useRef(false);
  const [center, setCenter] = useState<LatLng | null>({ lat: start.lat, lng: start.lng });
  const [label, setLabel] = useState<{ name: string; address: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  // auto: 처음 위치가 없을 때 자동으로 한 번 — 그새 사용자가 지도를 끌었으면 건드리지 않는다
  const locate = (auto = false) => {
    navigator.geolocation?.getCurrentPosition(
      (p) => {
        const map = mapRef.current;
        if (!map || (auto && userMoved.current)) return;
        map.setCenter(new window.kakao.maps.LatLng(p.coords.latitude, p.coords.longitude));
        setCenter({ lat: p.coords.latitude, lng: p.coords.longitude });
      },
      () => {},
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    loadKakaoSdk()
      .then(() => {
        const box = boxRef.current;
        if (cancelled || !box) return;
        const kakao = window.kakao;
        const map = new kakao.maps.Map(box, {
          center: new kakao.maps.LatLng(start.lat, start.lng),
          level: 3,
        });
        mapRef.current = map;
        kakao.maps.event.addListener(map, "dragstart", () => {
          userMoved.current = true;
        });
        // 멈춘 뒤(idle) 가운데 좌표를 확정
        kakao.maps.event.addListener(map, "idle", () => {
          const c = map.getCenter();
          setCenter({ lat: c.getLat(), lng: c.getLng() });
        });
        ro = new ResizeObserver(() => map.relayout());
        ro.observe(box);
        // 처음 위치를 안 받았으면 현재 위치로 — 실패·거부면 서울시청 그대로
        if (!initial) locate(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      ro?.disconnect();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 가운데 지점 이름 — 멈춘 뒤 0.4초
  useEffect(() => {
    if (!center) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setLoading(true);
      try {
        const r = await fetch(`/api/revgeocode?coord=${center.lng},${center.lat}&detail=1`, { signal: ctl.signal });
        const j = r.ok ? await r.json() : null;
        setLabel(j?.place ? { name: j.place.name || j.place.address || "선택한 지점", address: j.place.address ?? "" } : null);
      } catch {
        // 취소·실패 — 좌표로
      } finally {
        if (!ctl.signal.aborted) setLoading(false);
      }
    }, 400);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [center]);

  const zoom = (dz: number) => {
    const map = mapRef.current;
    if (map) map.setLevel(map.getLevel() - dz, { animate: true });
  };

  return createPortal(
    <div data-vehicle-touch={vehicleTouch ? "" : undefined} className="fixed inset-0 z-[80] flex flex-col bg-bg">
      <div className="flex items-center gap-2 px-3 py-3">
        <button
          type="button"
          onClick={onClose}
          className="rounded-sm px-3 py-2 text-[14px] text-secondary hover:bg-raised"
        >
          취소
        </button>
        <p className="flex-1 text-center text-[15px] font-semibold text-primary">{title}</p>
        <span className={vehicleTouch ? "w-[76px]" : "w-12"} />
      </div>
      <div className="relative flex-1 touch-none">
        <div ref={boxRef} className="absolute inset-0 h-full w-full" />
        {failed && (
          <p className="absolute inset-0 grid place-items-center bg-panel text-[14px] text-secondary">지도를 불러오지 못했어요</p>
        )}
        {/* 가운데 핀 — 끝이 정확히 가운데 */}
        <div className="pointer-events-none absolute z-10 left-1/2 top-1/2 -translate-x-1/2 -translate-y-full">
          {/* viewBox 아랫변 가운데(12,21)가 핀 끝 — 흰 테두리·그림자로 밝은 지도에서도 보이게 */}
          <svg viewBox="3 1 18 20" width={36} height={40} aria-hidden="true" className="block overflow-visible" style={{ filter: "drop-shadow(0 2px 3px rgb(0 0 0 / 0.55))" }}>
            <path d="M12 21c4.5-4.2 7-7.6 7-11a7 7 0 1 0-14 0c0 3.4 2.5 6.8 7 11Z" fill="#e11d48" stroke="#fff" strokeWidth={2} strokeLinejoin="round" paintOrder="stroke" />
            <circle cx="12" cy="10" r="2.6" fill="#fff" />
          </svg>
        </div>
        <div className="absolute z-10 bottom-3 right-3 flex flex-col gap-2">
          <button type="button" onClick={() => locate()} className="grid h-10 w-10 place-items-center rounded-sm bg-panel text-[18px] text-primary" aria-label="현재 위치">
            <IconTarget />
          </button>
          <button type="button" onClick={() => zoom(1)} className="grid h-10 w-10 place-items-center rounded-sm bg-panel text-[20px] font-bold text-primary" aria-label="확대">
            +
          </button>
          <button type="button" onClick={() => zoom(-1)} className="grid h-10 w-10 place-items-center rounded-sm bg-panel text-[20px] font-bold text-primary" aria-label="축소">
            −
          </button>
        </div>
      </div>
      <div className="border-t border-line px-4 pb-6 pt-3">
        <p className="truncate text-[15px] font-semibold text-primary">
          {loading && !label ? "주소 찾는 중…" : label?.name ?? "지도를 움직여 핀을 맞추세요"}
        </p>
        <p className="mt-1 truncate text-[12px] text-secondary">
          {label?.address || (center ? `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}` : "")}
        </p>
        <button
          type="button"
          disabled={!center}
          onClick={() => {
            if (!center) return;
            onPick({
              name: label?.name || `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`,
              address: label?.address ?? "",
              lat: Math.round(center.lat * 1e6) / 1e6,
              lng: Math.round(center.lng * 1e6) / 1e6,
            });
          }}
          className="mt-3 w-full rounded-md bg-accent py-4 text-[15px] font-semibold text-primary disabled:opacity-40"
        >
          {confirmLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}
