import { NextRequest, NextResponse } from "next/server";

import { readAuthSession } from "@/lib/auth-session";

import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 개발자 옵션 기록 — 앱이 주행 중 내린 판단(GPS·G값 계산 상태·카메라 경고 판정·
 * 음성 멘트·재탐색)을 모아 받는다. 실주행에서 생긴 문제를 맥미니에서 그대로 다시 본다.
 *  - POST ?trip=<주행시작ms|0>        본문 {events:[...]} – data/devlog/<버킷>/<trip>.jsonl 에 이어 쓰기
 *  - POST ?trip=..&mark=1             본문 {mark:{...}, recent:[...]} — "다름" 신고.
 *                                      marks.jsonl 한 줄 + 직전 기록 묶음 파일 하나.
 * 본문 상한 1MB, 주행 파일 하나 상한 50MB(넘으면 버림 — 폭주 방지).
 */
const MAX_BODY = 1024 * 1024;
const MAX_FILE = 50 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = readAuthSession(req);
  if (!session) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const trip = req.nextUrl.searchParams.get("trip") ?? "0";
  if (!/^(0|\d{12,14})$/.test(trip)) return NextResponse.json({ error: "잘못된 주행" }, { status: 400 });
  const text = await req.text();
  if (text.length > MAX_BODY) return NextResponse.json({ error: "너무 큼" }, { status: 413 });
  let body: { events?: unknown[]; mark?: Record<string, unknown>; recent?: unknown[] };
  try {
    body = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "JSON 아님" }, { status: 400 });
  }
  const dir = join(/* turbopackIgnore: true */ process.cwd(), "data", "devlog", session.recordHash);
  mkdirSync(dir, { recursive: true });
  // 주행 밖(trip=0) 기록은 날짜별로
  const name = trip === "0" ? `idle-${new Date().toISOString().slice(0, 10)}` : trip;

  if (req.nextUrl.searchParams.get("mark") === "1") {
    const mark = body.mark && typeof body.mark === "object" ? body.mark : {};
    const t = Date.now();
    appendFileSync(join(dir, "marks.jsonl"), JSON.stringify({ ...mark, trip: Number(trip), savedAt: t }) + "\n");
    writeFileSync(
      join(dir, `${name}-mark-${t}.json`),
      JSON.stringify({ mark, trip: Number(trip), recent: Array.isArray(body.recent) ? body.recent : [] }),
    );
    return NextResponse.json({ ok: true });
  }

  const events = Array.isArray(body.events) ? body.events : [];
  if (events.length === 0) return NextResponse.json({ ok: true, n: 0 });
  const file = join(dir, `${name}.jsonl`);
  try {
    if (statSync(file).size > MAX_FILE) return NextResponse.json({ ok: false, error: "파일 상한" });
  } catch {
    // 새 파일
  }
  appendFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return NextResponse.json({ ok: true, n: events.length });
}
