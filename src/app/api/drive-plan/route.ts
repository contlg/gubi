import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { NextRequest, NextResponse } from "next/server";

import { decodeValidPolyline } from "@/lib/api-validation";
import { writeFileAtomic } from "@/lib/atomic-write";
import type { DrivePlan, DrivePlanVia } from "@/lib/drive-plan";
import { jsonBodyError, readJsonBody } from "@/lib/request-json";

/**
 * 서로 다른 도메인 사이의 코스 전달함. 공용 파일 한 개를 공유하지 않고,
 * 추측 불가능한 일회용 id마다 별도 파일을 둔다. 수신 즉시 소비되며 만료 파일은
 * 요청 시 정리한다. 정원이 차도 아직 소비하지 않은 다른 사용자의 plan을
 * 밀어내지 않고 새 생성을 잠시 거부한다.
 */
const DIR = join(process.cwd(), "data/drive-plans");
const TTL_MS = 2 * 3600 * 1000;
const MAX_FILES = 256;
const ID_RE = /^[A-Za-z0-9_-]{32,64}$/;
const CREATE_WINDOW_MS = 10 * 60 * 1000;
const CREATE_LIMIT = 12;
const createAttempts = new Map<string, { count: number; resetAt: number }>();

function clientKey(req: NextRequest): string {
  // Caddy가 XFF 끝에 붙이는 실제 접속 IP만 신뢰한다. 앞단에 Cloudflare가
  // 없어 cf-connecting-ip는 클라가 위조할 수 있어 생성 제한 키로 쓰지 않는다.
  const forwarded = req.headers.get("x-forwarded-for");
  const parts = forwarded
    ? forwarded.split(",").map((part) => part.trim()).filter(Boolean)
    : [];
  return parts[parts.length - 1] || req.headers.get("x-real-ip") || "local";
}

function takeCreateAttempt(req: NextRequest): boolean {
  const now = Date.now();
  if (createAttempts.size > 5_000) {
    for (const [key, value] of createAttempts) {
      if (value.resetAt <= now) createAttempts.delete(key);
    }
  }
  const key = clientKey(req);
  const current = createAttempts.get(key);
  if (!current || current.resetAt <= now) {
    createAttempts.set(key, { count: 1, resetAt: now + CREATE_WINDOW_MS });
    return true;
  }
  if (current.count >= CREATE_LIMIT) return false;
  current.count++;
  return true;
}

function fileFor(id: string): string | null {
  return ID_RE.test(id) ? join(DIR, `${id}.json`) : null;
}

function cleanup(): number {
  try {
    mkdirSync(DIR, { recursive: true });
    const now = Date.now();
    const files = readdirSync(DIR)
      .filter((name) => ID_RE.test(name.replace(/\.json$/, "")) && name.endsWith(".json"))
      .map((name) => {
        const file = join(DIR, name);
        return { file, mtime: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    files.forEach(({ file, mtime }) => {
      if (now - mtime > TTL_MS) {
        try {
          unlinkSync(file);
        } catch {}
      }
    });
    return files.filter(({ mtime }) => now - mtime <= TTL_MS).length;
  } catch {
    // 정리는 보조 기능 — 읽기/쓰기는 아래에서 자체 실패 처리한다.
    return MAX_FILES;
  }
}

function readPlan(file: string): DrivePlan | null {
  try {
    const plan = JSON.parse(readFileSync(file, "utf8")) as DrivePlan;
    if (!Number.isFinite(plan.ts) || Date.now() - plan.ts > TTL_MS) return null;
    return plan;
  } catch {
    return null;
  }
}

export async function GET(req: NextRequest) {
  cleanup();
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const file = fileFor(id);
  if (!file) return NextResponse.json({ error: "올바른 plan id가 필요합니다" }, { status: 400 });
  const plan = readPlan(file);
  if (!plan) return NextResponse.json({ error: "코스가 없거나 만료됐습니다" }, { status: 404 });
  // GET 성공과 동시에 소비한다. 다른 계정/탭이 나중에 같은 링크를 재사용할 수 없다.
  try {
    unlinkSync(file);
  } catch {}
  return NextResponse.json({ plan });
}

export async function POST(req: NextRequest) {
  let body: {
    label?: unknown;
    durationSec?: unknown;
    distanceM?: unknown;
    path?: unknown;
    vias?: unknown;
    routeSource?: unknown;
  };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const detail = jsonBodyError(error);
    return NextResponse.json({ error: detail.message }, { status: detail.status });
  }
  const { label, durationSec, distanceM, path, vias, routeSource } = body;
  const decodedPath = decodeValidPolyline(path, 200_000, 20_000);
  if (
    typeof label !== "string" ||
    label.trim().length === 0 ||
    label.length > 120 ||
    typeof durationSec !== "number" ||
    !Number.isFinite(durationSec) ||
    durationSec <= 0 ||
    durationSec > 7 * 24 * 3600 ||
    typeof distanceM !== "number" ||
    !Number.isFinite(distanceM) ||
    distanceM <= 0 ||
    distanceM > 3_000_000 ||
    typeof path !== "string" ||
    !decodedPath ||
    decodedPath.length < 2
  ) {
    return NextResponse.json({ error: "코스 정보가 올바르지 않습니다" }, { status: 400 });
  }

  const cleanVias: DrivePlanVia[] = Array.isArray(vias)
    ? vias
        .filter(
          (v): v is Record<string, unknown> =>
            !!v &&
            typeof v === "object" &&
            typeof v.name === "string" &&
            v.name.length > 0 &&
            v.name.length <= 60 &&
            typeof v.lat === "number" &&
            Number.isFinite(v.lat) &&
            v.lat >= -90 &&
            v.lat <= 90 &&
            typeof v.lng === "number" &&
            Number.isFinite(v.lng) &&
            v.lng >= -180 &&
            v.lng <= 180,
        )
        .slice(0, 20)
        .map((v) => {
          const dwellMin =
            typeof v.dwellMin === "number" && Number.isFinite(v.dwellMin)
              ? Math.min(24 * 60, Math.max(0, Math.round(v.dwellMin)))
              : undefined;
          return {
            name: v.name as string,
            lat: v.lat as number,
            lng: v.lng as number,
            ...(dwellMin === undefined ? {} : { dwellMin }),
          };
        })
    : [];

  // 비로그인 플래너도 도메인 간 전달을 써야 하므로 인증을 강제하진 않되,
  // 무한 생성으로 정상 사용자의 256개 일회용 토큰을 밀어내는 공격은 막는다.
  if (!takeCreateAttempt(req)) {
    return NextResponse.json(
      { error: "코스 전달 요청이 너무 많아요. 잠시 후 다시 시도해주세요" },
      { status: 429, headers: { "Retry-After": "600" } },
    );
  }

  const activePlans = cleanup();
  if (activePlans >= MAX_FILES) {
    return NextResponse.json(
      { error: "코스 전달함이 잠시 가득 찼어요. 잠시 후 다시 시도해주세요" },
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }
  mkdirSync(DIR, { recursive: true });
  const id = randomBytes(32).toString("base64url");
  const plan: DrivePlan = {
    label: label.trim(),
    durationSec,
    distanceM,
    path,
    vias: cleanVias,
    ...(["local-its", "kakao"].includes(routeSource as string)
      ? { routeSource: routeSource as "local-its" | "kakao" }
      : {}),
    ts: Date.now(),
  };
  writeFileAtomic(join(DIR, `${id}.json`), JSON.stringify(plan));
  return NextResponse.json({ ok: true, id });
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const file = fileFor(id);
  if (!file) return NextResponse.json({ error: "올바른 plan id가 필요합니다" }, { status: 400 });
  try {
    unlinkSync(file);
  } catch {}
  return NextResponse.json({ ok: true });
}
