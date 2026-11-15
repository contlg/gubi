import { sanitizeVehicleRecord, type VehicleRecord } from "@/lib/vehicle-trace";
import { NextRequest, NextResponse } from "next/server";

import { readAuthSession } from "@/lib/auth-session";
import { scheduleGForceAttach } from "@/lib/gforce-attach";
import { decodeValidPolyline } from "@/lib/api-validation";
import { placeNameAt } from "@/lib/place-names";
import { jsonBodyError, readJsonBody } from "@/lib/request-json";

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

/**
 * 주행 기록 저장소 — 맥미니 파일 저장 (유저 지시: "로그는 맥미니에 저장").
 * 단일 홈서버라 파일이면 충분. 폰·PC 어디서 봐도 같은 기록이 보인다.
 */
interface DriveRecord extends VehicleRecord {
  id: string;
  startTs: number;
  endTs: number;
  distanceM: number;
  maxKmh: number;
  avgKmh: number;
  movingSec: number;
  startAddr?: string;
  endAddr?: string;
  /** 플래너 코스로 달린 주행 — 예상 vs 실제 비교용 */
  courseLabel?: string;
  planSec?: number;
  planM?: number;
  /** 주행 궤적 (encoded polyline) — 기록 지도 표시용 */
  path?: string;
  speeds?: number[];

  /** 구버전 기록 분류값. 자동차 외 기록은 응답에서 제외한다. */
  mode?: string;
  /** 정지 출발 최고 0–50 / 0–100km/h 초 */
  zero50Sec?: number;
  zero100Sec?: number;
  /** 앱이 빠른 제로백을 센서로 확인함(저장은 안 하고 하한 판단에만) */
  zeroChecked?: boolean;
  /** 이번 주행 G — 네 방향 최고값 + 방향별(36칸) 최대 */
  gForce?: { accel: number; brake: number; left: number; right: number; env?: number[] };
}

const LEGACY_FILE = join(process.cwd(), "data/drive-records.json");
const USER_DIR = join(process.cwd(), "data/records");
const MAX = 500;

/** 유저 해시 – 기록 파일 경로 (최초 로그인이면 레거시 1회 이관) */
function userFileFor(hash: string): string {
  const f = join(
    /* turbopackIgnore: true */ process.cwd(),
    "data",
    "records",
    `${hash}.json`,
  );
  maybeMigrateLegacy(f);
  return f;
}

/**
 * 최초 로그인 1회 이관 — 로그인 게이트 도입 전 공용 파일에 쌓인 기록을
 * 첫 유저 버킷으로 옮긴다(단일 사용자 홈서버). 유저 버킷이 이미 하나라도
 * 있으면(=두 번째 이후 로그인) 아무것도 안 한다 — 남의 계정에 안 붙게.
 */
function maybeMigrateLegacy(userF: string) {
  try {
    if (
      existsSync(/* turbopackIgnore: true */ userF) ||
      !existsSync(LEGACY_FILE)
    )
      return;
    mkdirSync(USER_DIR, { recursive: true });
    const others = readdirSync(USER_DIR).filter((n) => n.endsWith(".json"));
    if (others.length > 0) return;
    copyFileSync(LEGACY_FILE, /* turbopackIgnore: true */ userF);
  } catch {
    // 이관 실패해도 빈 기록으로 시작 — 치명적이지 않다
  }
}

function load(file: string): DriveRecord[] {
  // 본 파일이 깨졌으면 직전 백업(.bak)에서 복구한다
  for (const f of [file, `${file}.bak`]) {
    try {
      const arr = JSON.parse(
        readFileSync(/* turbopackIgnore: true */ f, "utf8"),
      );
      if (Array.isArray(arr)) return arr;
    } catch {
      // 다음 후보(백업)로
    }
  }
  return [];
}
function persist(file: string, list: DriveRecord[]) {
  mkdirSync(/* turbopackIgnore: true */ dirname(file), { recursive: true });
  const data = JSON.stringify(list, null, 1);
  // 직전 버전을 .bak 으로 보관 — 논리적 손상·오삭제 대비 복구본
  try {
    if (existsSync(/* turbopackIgnore: true */ file))
      copyFileSync(
        /* turbopackIgnore: true */ file,
        /* turbopackIgnore: true */ `${file}.bak`,
      );
  } catch {}
  // 임시파일에 완전히 쓴 뒤 원자적 교체 — 쓰는 도중 크래시로 본 파일이
  // 잘리거나 깨지는 걸 막는다(부분 쓰기 방지).
  const tmp = `${file}.tmp`;
  writeFileSync(/* turbopackIgnore: true */ tmp, data);
  renameSync(
    /* turbopackIgnore: true */ tmp,
    /* turbopackIgnore: true */ file,
  );
}

function finiteBetween(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

type RecordCore = Record<string, unknown> & Pick<DriveRecord,
  "id" | "startTs" | "endTs" | "distanceM" | "maxKmh">;

/** 중복 기록도 필수 필드는 검증하되, 궤적 검증은 새 기록에만 한다. */
function isRecordCore(value: unknown): value is RecordCore {
  if (!value || typeof value !== "object") return false;
  const x = value as Record<string, unknown>;
  if (
    (x.mode != null && x.mode !== "car") ||
    typeof x.id !== "string" ||
    x.id.length < 1 ||
    x.id.length > 80 ||
    !finiteBetween(x.startTs, 1, 10_000_000_000_000) ||
    !finiteBetween(x.endTs, x.startTs, 10_000_000_000_000) ||
    !finiteBetween(x.distanceM, 0, 3_000_000) ||
    !finiteBetween(x.maxKmh, 0, 400)
  ) {
    return false;
  }
  return true;
}

/** 허용 DTO만 새 객체에 복사해 임의 필드·비정상 수치가 파일에 쌓이지 않게 한다. */
function sanitizeRecord(value: unknown): DriveRecord | null {
  if (!isRecordCore(value)) return null;
  const x = value;
  const clean: DriveRecord = {
    id: x.id,
    startTs: x.startTs,
    endTs: x.endTs,
    distanceM: x.distanceM,
    maxKmh: x.maxKmh,
    avgKmh: finiteBetween(x.avgKmh, 0, 400) ? x.avgKmh : 0,
    movingSec: finiteBetween(x.movingSec, 0, 7 * 24 * 3600) ? x.movingSec : 0,
  };
  Object.assign(clean, sanitizeVehicleRecord(x, clean.endTs - clean.startTs));
  for (const key of ["startAddr", "endAddr"] as const) {
    const v = x[key];
    if (typeof v === "string" && v.length <= 160) clean[key] = v;
  }
  if (typeof x.courseLabel === "string" && x.courseLabel.length <= 120)
    clean.courseLabel = x.courseLabel;
  if (finiteBetween(x.planSec, 0, 7 * 24 * 3600)) clean.planSec = x.planSec;
  if (finiteBetween(x.planM, 0, 3_000_000)) clean.planM = x.planM;
  const pts = typeof x.path === "string" ? decodeValidPolyline(x.path, 200_000, 4_000) : null;
  if (typeof x.path === "string" && (pts?.length ?? 0) >= 2) clean.path = x.path;
  // 지명이 빈 기록(앱이 꺼졌다 나중에 올라온 기록·해외) — 첫·끝 점으로 채운다
  if (clean.path && pts) {
    if (!clean.startAddr) clean.startAddr = placeNameAt(pts[0]) ?? undefined;
    if (!clean.endAddr) clean.endAddr = placeNameAt(pts[pts.length - 1]) ?? undefined;
    if (!clean.startAddr) delete clean.startAddr;
    if (!clean.endAddr) delete clean.endAddr;
  }
  if (Array.isArray(x.speeds) && x.speeds.length <= 4_000) {
    const speeds = x.speeds.filter((v): v is number => finiteBetween(v, 0, 400));
    if (speeds.length === x.speeds.length) clean.speeds = speeds;
  }
  // 0–50 2초·0–100 3초 미만은 GPS 튐(구버전 앱이 1.4초를 보냈다) — 센서로 확인한 새 앱 값만
  // 물리 하한(1.0·1.8초)까지 받는다
  const chk = x.zeroChecked === true;
  if (finiteBetween(x.zero50Sec, chk ? 1 : 2, 120)) clean.zero50Sec = x.zero50Sec;
  if (finiteBetween(x.zero100Sec, chk ? 1.8 : 3, 180)) clean.zero100Sec = x.zero100Sec;
  if (x.gForce && typeof x.gForce === "object") {
    const g = x.gForce as Record<string, unknown>;
    const ok = (v: unknown): v is number => finiteBetween(v, 0, 2);
    if (ok(g.accel) && ok(g.brake) && ok(g.left) && ok(g.right)) {
      clean.gForce = { accel: g.accel, brake: g.brake, left: g.left, right: g.right };
      if (Array.isArray(g.env) && g.env.length === 36 && g.env.every(ok)) clean.gForce.env = g.env as number[];
    }
  }
  return clean;
}

/** 목록과 동기화 응답은 추적 배열을 싣지 않는다. 원본은 상세 조회에서만 보낸다. */
function recordList(records: DriveRecord[]) {
  return records.filter((record) => record.mode == null || record.mode === "car")
    .map(({ vehicleTrace: _trace, ...summary }) => summary);
}

export async function GET(req: NextRequest) {
  const session = readAuthSession(req);
  if (!session)
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const records = load(userFileFor(session.recordHash));
  const id = req.nextUrl.searchParams.get("id");
  if (id !== null) {
    if (!id || id.length > 80) return NextResponse.json({ error: "올바른 id가 필요합니다" }, { status: 400 });
    const record = records.find((r) => r.id === id && (r.mode == null || r.mode === "car"));
    return record ? NextResponse.json({ record }) : NextResponse.json({ error: "기록이 없습니다" }, { status: 404 });
  }
  return NextResponse.json({ records: recordList(records) });
}

export async function POST(req: NextRequest) {
  // 익명 쓰기 금지 — 로그인 유저 버킷에만 저장한다(공용 파일 오염 방지)
  const session = readAuthSession(req);
  if (!session) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const detail = jsonBodyError(error);
    return NextResponse.json({ error: detail.message }, { status: detail.status });
  }
  // 단건 또는 배열(오프라인 큐 동기화) 둘 다 받는다
  const values = (Array.isArray(body) ? body : [body]).slice(0, MAX);
  if (values.some((value) => value && typeof value === "object" && "owner" in value && value.owner !== session.idHash)) {
    return NextResponse.json({ error: "기록 소유자가 일치하지 않습니다" }, { status: 403 });
  }
  const candidates = values.filter(isRecordCore);
  if (candidates.length === 0) {
    return NextResponse.json({ error: "유효한 기록이 없습니다" }, { status: 400 });
  }
  const file = userFileFor(session.recordHash);
  const cur = load(file);
  const known = new Set(cur.map((r) => r.id));
  const added: DriveRecord[] = [];
  for (const candidate of candidates) {
    if (known.has(candidate.id)) continue;
    const record = sanitizeRecord(candidate);
    if (!record) continue;
    known.add(record.id);
    added.push(record);
  }
  const next = [...added, ...cur]
    .sort((a, b) => b.startTs - a.startTs)
    .slice(0, MAX);
  // 재전송만 있는 요청은 기존 파일·백업을 다시 쓰지 않는다.
  if (added.length) persist(file, next);
  // 센서 원본이 먼저 올라와 있었으면 이 기록에 자이로 G를 붙인다(백그라운드)
  if (added.length) scheduleGForceAttach(session.recordHash);
  return NextResponse.json({ ok: true, added: added.length, records: recordList(next) });
}

export async function DELETE(req: NextRequest) {
  const session = readAuthSession(req);
  if (!session) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id || id.length > 80)
    return NextResponse.json({ error: "올바른 id가 필요합니다" }, { status: 400 });
  const file = userFileFor(session.recordHash);
  const next = load(file).filter((r) => r.id !== id);
  persist(file, next);
  return NextResponse.json({ ok: true, records: recordList(next) });
}
