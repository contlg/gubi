"use client";

import { IconLoop, IconTransport } from "@/components/icons";
import { cleanLabel } from "@/lib/display-text";

/** 자동차 주행 기록 카드. */
export interface TripCardRec {
  id: string;
  startTs: number;
  endTs: number;
  distanceM: number;
  maxKmh: number;
  startAddr?: string;
  endAddr?: string;
  courseLabel?: string;
  zero100Sec?: number;
}

const CAR = { label: "주행", icon: <IconTransport mode="car" size={16} className="h-4 w-4" />, badge: "bg-accent-surface", accent: "text-accent-text", line: "bg-accent-surface" };

const SIDO: [RegExp, string][] = [
  [/^서울/, "서울"], [/^부산/, "부산"], [/^대구/, "대구"], [/^인천/, "인천"], [/^광주/, "광주"],
  [/^대전/, "대전"], [/^울산/, "울산"], [/^세종/, "세종"],
];
const KR_DO = /^(경기|강원|충청|충북|충남|전라|전북|전남|경상|경북|경남|제주)/;

/** 주소 – 큰 이름(도시) + 작은 이름(동네·나라). 한국 행정동, 해외 "나라 도시", 영문 공항 이름 */
function place(addr?: string): { big: string; small: string } {
  const w = addr?.trim().split(/\s+/) ?? [];
  if (!w.length || !w[0]) return { big: "—", small: "" };
  const metro = SIDO.find(([re]) => re.test(w[0]));
  if (metro) return { big: metro[1], small: w.length > 2 ? `${w[1]} ${w[w.length - 1]}` : (w[1] ?? "") };
  if (KR_DO.test(w[0])) {
    const city = (w[1] ?? w[0]).replace(/(특별자치)?[시군]$/, "");
    return { big: city || w[1], small: w.length > 2 ? w[w.length - 1] : "" };
  }
  // 해외 — "중국 칭다오 시"는 앞이 한글 나라 이름
  if (w.length > 1 && /^[가-힣]+$/.test(w[0])) return { big: w.slice(1).join(" ").replace(/\s시$/, ""), small: w[0] };
  // 영문 공항 이름은 길다 — 첫 단어(도시)만 크게
  if (/Airport$/i.test(addr!)) return { big: w[0], small: "공항" };
  return { big: w.join(" "), small: "" };
}

const hhmm = (ts: number) =>
  new Date(ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
const ymd = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}`;
};
function dur(ms: number) {
  const m = Math.round(ms / 60000);
  return m >= 60 ? `${Math.floor(m / 60)}시간 ${m % 60}분` : `${m}분`;
}

const CAL = "M8 2v4M16 2v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z";
const PIN = "M20 10c0 6-8 12-8 12s-8-6-8-12a8 8 0 0 1 16 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z";
const Svg = ({ d, className = "h-3.5 w-3.5" }: { d: string; className?: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
    <path d={d} />
  </svg>
);

export function TripCard({ r, onClick, action }: { r: TripCardRec; onClick?: () => void; action?: React.ReactNode }) {
  const m = CAR;
  const from = place(r.startAddr), to = place(r.endAddr);
  const same = from.big === to.big && from.small === to.small;
  return (
    <div
      onClick={onClick}
      className={`rounded-md bg-raised p-4 transition-colors active:bg-raised ${onClick ? "cursor-pointer" : ""}`}
    >
      <div className="mb-4 flex items-center justify-between">
        <div className="flex min-w-0 items-center">
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[13px] ${m.badge}`}>{m.icon}</span>
          <span className="ml-2 truncate font-semibold text-primary">{cleanLabel(r.courseLabel ?? m.label)}</span>
        </div>
        <div className="flex shrink-0 items-center text-secondary">
          <Svg d={CAL} />
          <span className="ml-1 text-sm tabular-nums">{ymd(r.startTs)}</span>
        </div>
      </div>
      <div className="flex items-center">
        <div className="flex min-w-0 flex-1 flex-col items-start">
          <span className="max-w-full truncate text-2xl font-bold text-primary">{from.big}</span>
          <span className="max-w-full truncate text-sm text-secondary">{from.small || " "}</span>
          <span className={`mt-1 text-sm font-medium tabular-nums ${m.accent}`}>{hhmm(r.startTs)}</span>
        </div>
        <div className="flex flex-1 flex-col items-center px-2">
          <div className="flex w-full items-center">
            <div className="h-0.5 flex-1 bg-raised" />
            <span className="mx-2 text-[15px]">{same ? <IconLoop className="h-4 w-4" /> : m.icon}</span>
            <div className="h-0.5 flex-1 bg-raised" />
          </div>
          <span className="mt-1 text-xs text-secondary">{dur(r.endTs - r.startTs)}</span>
        </div>
        <div className="flex min-w-0 flex-1 flex-col items-end">
          <span className="max-w-full truncate text-2xl font-bold text-primary">{to.big}</span>
          <span className="max-w-full truncate text-sm text-secondary">{to.small || " "}</span>
          <span className={`mt-1 text-sm font-medium tabular-nums ${m.accent}`}>{hhmm(r.endTs)}</span>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-line pt-3">
        <div className="flex items-center gap-1 text-sm text-secondary">
          <Svg d={PIN} />
          <span className="tabular-nums">
            {`${(r.distanceM / 1000).toFixed(1)}km`}
          </span>
        </div>
        <div className="flex items-center gap-2">
          {r.maxKmh > 0 && (
            <span className="rounded-sm bg-raised px-2 py-1 text-[11px] font-semibold tabular-nums text-secondary">
              최고 {`${Math.round(r.maxKmh)}km/h`}
            </span>
          )}
          {r.zero100Sec != null && (
            <span className="rounded-sm bg-warn-surface px-2 py-1 text-[11px] font-semibold tabular-nums text-warn">
              0–100 {r.zero100Sec.toFixed(1)}초
            </span>
          )}
          {action}
        </div>
      </div>
    </div>
  );
}
