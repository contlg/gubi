"use client";

import { useState } from "react";

import { FirstRoadview, usePhotoSpots } from "@/components/RoadviewStrip";
import { distanceM } from "@/lib/scoring/curvature";
import type { DriveStyle, LatLng } from "@/lib/types";

export interface CourseCardItem {
  label: string;
  /** 화면에 보일 이름(실제 지명) */
  title: string;
  path: LatLng[];
  distanceM: number;
  durationSec: number;
  /** 한 줄 추천 이유 */
  why: string | null;
  /** 로드뷰 지점 고르기에 쓸 풍경 종류 */
  photoStyles: DriveStyle[];
  /** 코스별 로드뷰 캐시 키 (라벨 + 경로 해시) */
  photoKey: string;
}

/** 큰 숫자 + 작은 단위 — "248km", "4시간 10분" */
export function BigDuration({ sec }: { sec: number }) {
  const total = Math.max(0, Math.round(sec / 60));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return (
    <span className="gb-big">
      {h > 0 && (
        <>
          {h}
          <small>시간</small>
          {m > 0 && " "}
        </>
      )}
      {(m > 0 || h === 0) && (
        <>
          {m}
          <small>분</small>
        </>
      )}
    </span>
  );
}

export function BigKm({ m }: { m: number }) {
  const km = m / 1000;
  return (
    <span className="gb-big">
      {km >= 100 ? Math.round(km) : km.toFixed(km >= 10 ? 0 : 1)}
      <small>km</small>
    </span>
  );
}

/** 사진이 없을 때 — 어두운 바탕에 코스 모양만 조용히 그린다 */
export function RouteShape({ path, className }: { path: LatLng[]; className?: string }) {
  if (path.length < 2) return null;
  const step = Math.max(1, Math.floor(path.length / 400));
  const pts = path.filter((_, i) => i % step === 0 || i === path.length - 1);
  const midLat = pts.reduce((s, p) => s + p.lat, 0) / pts.length;
  const kx = Math.cos((midLat * Math.PI) / 180);
  const xs = pts.map((p) => p.lng * kx);
  const ys = pts.map((p) => -p.lat);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  const W = 100, H = 100, pad = 14;
  const sc = (W - pad * 2) / span;
  const ox = (W - (maxX - minX) * sc) / 2;
  const oy = (H - (maxY - minY) * sc) / 2;
  const d = xs
    .map((x, i) => `${i ? "L" : "M"}${(ox + (x - minX) * sc).toFixed(1)},${(oy + (ys[i] - minY) * sc).toFixed(1)}`)
    .join("");
  const sx = ox + (xs[0] - minX) * sc;
  const sy = oy + (ys[0] - minY) * sc;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className={className} aria-hidden="true" preserveAspectRatio="xMidYMid meet">
      <path d={d} fill="none" stroke="#f4f3ef" strokeOpacity="0.16" strokeWidth="5" strokeLinejoin="round" strokeLinecap="round" />
      <path d={d} fill="none" stroke="#f5c542" strokeOpacity="0.85" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={sx} cy={sy} r="2.6" fill="#101113" stroke="#f4f3ef" strokeWidth="1.2" />
    </svg>
  );
}

/** 앞 카드가 이미 쓴 지점에서 이만큼 안이면 같은 풍경으로 본다 */
const SAME_SPOT_M = 1000;

/**
 * 카드 윗부분 — 검증된 로드뷰가 있으면 그 사진, 없으면 코스 모양.
 * 앞 카드가 이미 보여 준 곳(같은 송도 바다 등)은 건너뛰고 이 코스의 다음 지점을 쓴다.
 */
function CoursePhoto({ item, taken, onShow }: { item: CourseCardItem; taken: LatLng[]; onShow: (p: LatLng) => void }) {
  const spots = usePhotoSpots(item.path, item.photoStyles, item.photoKey);
  const [none, setNone] = useState("");
  const usable = (spots ?? []).filter((sp) => taken.every((t) => distanceM(t, sp.coord) > SAME_SPOT_M));
  const key = usable.map((p) => `${p.coord.lat},${p.coord.lng}`).join("|");
  return (
    <div className="gb-card-photo">
      <RouteShape path={item.path} className="gb-card-shape" />
      {usable.length > 0 && none !== key && (
        <FirstRoadview
          key={key}
          points={usable}
          variant="cover"
          onShow={(p) => onShow(p.coord)}
          onNone={() => setNone(key)}
        />
      )}
    </div>
  );
}

/**
 * 추천 코스 카드 — 나란히 3장. 위는 큰 사진, 아래는 이름·이유 한 줄·큰 숫자(거리, 시간).
 * 누르면 그 코스의 상세(지도)로 간다.
 */
export default function CourseCards({
  items,
  selected,
  onOpen,
}: {
  items: CourseCardItem[];
  selected?: string;
  onOpen: (label: string) => void;
}) {
  // 카드마다 실제로 보여 준 로드뷰 지점 — 뒤 카드가 같은 곳을 다시 쓰지 않게
  const [shown, setShown] = useState<Record<string, LatLng>>({});
  return (
    <ul className="gb-cards" aria-label="추천 코스">
      {items.map((it, i) => (
        <li key={it.label}>
          <button
            type="button"
            className="gb-card"
            aria-current={it.label === selected ? "true" : undefined}
            aria-label={`코스 ${i + 1} ${it.title} 자세히 보기`}
            onClick={() => onOpen(it.label)}
          >
            <CoursePhoto
              item={it}
              taken={items.slice(0, i).map((x) => shown[x.photoKey]).filter((p): p is LatLng => !!p)}
              onShow={(p) => setShown((prev) => (prev[it.photoKey] === p ? prev : { ...prev, [it.photoKey]: p }))}
            />
            <span className="gb-card-body">
              <span className="gb-card-name">{it.title}</span>
              {it.why && <span className="gb-card-why">{it.why}</span>}
              <span className="gb-card-nums">
                <BigKm m={it.distanceM} />
                <BigDuration sec={it.durationSec} />
              </span>
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}
