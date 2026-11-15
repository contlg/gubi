"use client";

/**
 * 개발자 옵션 기록(클라이언트) — 켜져 있으면 앱 판단을 모아 30초마다 /api/dev-log로 보낸다.
 * 끄면 devlog()는 아무것도 안 한다(일반 사용자 비용 0).
 *  - devlog(kind, data): 한 줄 기록. t(ms, 실제 시각)가 붙는다.
 *  - devMark(reason, extra): "다름" 신고 — 직전 2분 기록을 같이 바로 보낸다.
 * 주행 번호(trip)는 화면이 setDevTrip으로 알려 준다(주행 시작 ms, 주행 밖은 0).
 */
import { BORROW_SERVER } from "@/lib/borrow-mode";

const KEY = "drivelog-devmode-v1";
const RECENT_MS = 120_000;
const FLUSH_MS = 30_000;

type Ev = { t: number; k: string } & Record<string, unknown>;
let on: boolean | null = null;
let trip = 0;
let pending: Ev[] = [];
const recent: Ev[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
export const devStats = { sent: 0, failed: 0, lastAt: 0, marks: 0 };

export function devModeOn(): boolean {
  // 빌려 쓰기 모드: 판정 기록을 drivelog(/api/dev-log)로 보내지 않는다.
  if (BORROW_SERVER) return false;
  if (on === null) {
    try {
      on = localStorage.getItem(KEY) === "1";
    } catch {
      on = false;
    }
    if (on) start();
  }
  return on;
}
export function setDevMode(v: boolean) {
  if (BORROW_SERVER) return;
  on = v;
  try {
    localStorage.setItem(KEY, v ? "1" : "0");
  } catch {}
  if (v) start();
  else {
    pending = [];
    recent.length = 0;
  }
}
export function setDevTrip(t: number) {
  if (t === trip) return;
  void flush(); // 바뀌기 전 주행 것은 그 주행으로
  trip = t;
}

export function devlog(k: string, data: Record<string, unknown> = {}) {
  if (!devModeOn()) return;
  const e: Ev = { t: Date.now(), k, ...data };
  pending.push(e);
  recent.push(e);
  while (recent.length && recent[0].t < e.t - RECENT_MS) recent.shift();
  if (pending.length > 5000) void flush();
}

export async function devMark(reason: string, extra: Record<string, unknown> = {}) {
  if (!devModeOn()) return false;
  const t = Date.now();
  devlog("mark", { reason, ...extra });
  void flush();
  try {
    const r = await fetch(`/api/dev-log?trip=${trip}&mark=1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mark: { t, reason, ...extra }, recent }),
    });
    if (r.ok) devStats.marks++;
    return r.ok;
  } catch {
    return false;
  }
}

async function flush() {
  if (pending.length === 0) return;
  const batch = pending;
  const tr = trip;
  pending = [];
  try {
    const r = await fetch(`/api/dev-log?trip=${tr}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ events: batch }),
      keepalive: JSON.stringify(batch).length < 60_000,
    });
    if (!r.ok) throw new Error(String(r.status));
    devStats.sent += batch.length;
    devStats.lastAt = Date.now();
  } catch {
    devStats.failed++;
    // 네트워크 끊김(터널 등) — 다음에 다시. 너무 쌓이면 오래된 것부터 버린다
    pending = batch.concat(pending).slice(-20000);
  }
}

function start() {
  if (timer || typeof window === "undefined") return;
  timer = setInterval(() => void flush(), FLUSH_MS);
  window.addEventListener("pagehide", () => void flush());
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") void flush();
  });
}
