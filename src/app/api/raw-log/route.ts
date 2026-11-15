import { NextRequest, NextResponse } from "next/server";

import { readAuthSession } from "@/lib/auth-session";
import { scheduleGForceAttach } from "@/lib/gforce-attach";

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 센서 원본 기록 조각 업로드 (안드로이드 앱의 테스트 기능) — 터널 속도 보정과
 * 횡G 검증을 맥미니에서 재생(scripts/rawlog/analyze.mjs)하려고 받아둔다.
 * 본문은 gzip CSV 조각 하나(proxy 상한 2MB). 같은 조각을 다시 올리면 덮어쓴다.
 * 저장: data/rawlog/<유저버킷>/<주행시작ms>/part-NNN.csv.gz
 */
const MAX_BYTES = 2 * 1024 * 1024;

export async function POST(req: NextRequest) {
  const session = readAuthSession(req);
  if (!session) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
  const owner = req.headers.get("x-drivelog-owner");
  if (owner !== null && owner !== session.idHash) {
    return NextResponse.json({ error: "기록 소유자가 일치하지 않습니다" }, { status: 403 });
  }
  const trip = req.nextUrl.searchParams.get("trip") ?? "";
  const part = req.nextUrl.searchParams.get("part") ?? "";
  if (!/^\d{12,14}$/.test(trip) || !/^\d{3}$/.test(part)) {
    return NextResponse.json({ error: "잘못된 조각 이름" }, { status: 400 });
  }
  const buf = Buffer.from(await req.arrayBuffer());
  if (buf.length < 20 || buf.length > MAX_BYTES || buf[0] !== 0x1f || buf[1] !== 0x8b) {
    return NextResponse.json({ error: "gzip 조각이 아닙니다" }, { status: 400 });
  }
  const dir = join(
    /* turbopackIgnore: true */ process.cwd(),
    "data",
    "rawlog",
    session.recordHash,
    trip,
  );
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `part-${part}.csv.gz`);
  writeFileSync(`${file}.tmp`, buf);
  renameSync(`${file}.tmp`, file);
  scheduleGForceAttach(session.recordHash); // 자이로 기반 G를 기록에 붙인다(백그라운드)
  return NextResponse.json({ ok: true, bytes: buf.length });
}
