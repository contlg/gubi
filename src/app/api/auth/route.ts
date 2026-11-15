import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";

import {
  clearAuthCookie,
  createAuthSession,
  readAuthSession,
  revokeAllSessionsForAccount,
  revokeAuthSession,
} from "@/lib/auth-session";
import {
  linkedProvidersForAccount,
  removeLinksForAccount,
} from "@/lib/oauth-links";

/**
 * 회원가입/로그인 게이트. 기록 버킷은 여전히 credHash(=sha256(id\0pw))로
 * 저장되지만(기존 기록 보존), 그 앞에 서버 검증을 둔다. 레지스트리는 idHash
 * (=sha256(id))로 키를 잡고, 원본 credHash 대신 scrypt 해시(verifier)만 저장해
 * 파일이 유출돼도 기록 버킷 키가 새지 않게 한다.
 */

const AUTH_FILE = join(process.cwd(), "data/auth-users.json");
const HASH_RE = /^[a-f0-9]{16,64}$/;
const scryptAsync = promisify(scrypt);
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const attempts = new Map<string, { count: number; resetAt: number }>();
const authLocks = new Map<string, Promise<void>>();

interface Entry {
  verifier: string;
  createdAt: number;
  vinHash?: string;
  cars?: Record<string, string>;
}
type Registry = Record<string, Entry>;

/**
 * 파일이 아예 없으면(=아직 가입자 0명) 빈 레지스트리로 시작한다. 그러나 파일이
 * 존재하는데 읽기/파싱에 실패하면 throw 한다 — 손상을 "사용자 0명"으로 위장해
 * 이후 save()가 전체 계정 파일을 새 항목 하나로 덮어쓰는 사고를 막는다(fail-closed).
 */
function load(): Registry {
  let raw: string;
  try {
    raw = readFileSync(AUTH_FILE, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw e; // 권한/IO 오류는 빈 상태로 위장하지 않는다
  }
  const j = JSON.parse(raw); // 손상 시 throw – 호출부가 덮어쓰지 못한다
  if (!j || typeof j !== "object") throw new Error("auth registry corrupt");
  return j as Registry;
}

function save(reg: Registry): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  const tmp = `${AUTH_FILE}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg));
  renameSync(tmp, AUTH_FILE);
}

async function makeVerifier(credHash: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const derived = (await scryptAsync(credHash, salt, 32)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}

async function verify(credHash: string, verifier: string): Promise<boolean> {
  const [salt, hex] = (verifier || "").split(":");
  if (!salt || !hex) return false;
  const stored = Buffer.from(hex, "hex");
  const calc = (await scryptAsync(credHash, salt, 32)) as Buffer;
  return stored.length === calc.length && timingSafeEqual(stored, calc);
}

function clientKey(req: NextRequest): string {
  // Caddy가 XFF 끝에 붙이는 실제 접속 IP만 신뢰한다. 앞단에 Cloudflare가
  // 없어 cf-connecting-ip는 클라가 위조 가능 – 로그인 시도 제한(무차별 대입
  // 방어) 키로 쓰면 헤더 회전으로 우회되므로 신뢰하지 않는다.
  const forwarded = req.headers.get("x-forwarded-for");
  const forwardedParts = forwarded
    ? forwarded.split(",").map((part) => part.trim()).filter(Boolean)
    : [];
  return (
    forwardedParts[forwardedParts.length - 1] ||
    req.headers.get("x-real-ip") ||
    "local"
  );
}

function takeAttempt(key: string, limit: number): boolean {
  const now = Date.now();
  if (attempts.size > 5_000) {
    for (const [k, value] of attempts) if (value.resetAt <= now) attempts.delete(k);
  }
  const value = attempts.get(key);
  if (!value || value.resetAt <= now) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return true;
  }
  if (value.count >= limit) return false;
  value.count++;
  return true;
}

/** 같은 계정의 바인딩·가입·삭제만 직렬화한다. */
async function withAccountLock<T>(idHash: string, fn: () => Promise<T>): Promise<T> {
  const previous = authLocks.get(idHash) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => gate);
  authLocks.set(idHash, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (authLocks.get(idHash) === tail) authLocks.delete(idHash);
  }
}

/** 겹치는 기기·차량 계정은 항상 같은 순서로 잠가 교착을 피한다. */
async function withAccountLocks<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
  const sorted = [...new Set(ids)].sort();
  const acquire = (index: number): Promise<T> => index === sorted.length ? fn()
    : withAccountLock(sorted[index], () => acquire(index + 1));
  return acquire(0);
}

export async function POST(req: NextRequest) {
  let body: { mode?: string; idHash?: string; credHash?: string; vinHash?: string; carIdHash?: string; carCredHash?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "JSON 본문이 필요합니다" }, { status: 400 });
  }
  const mode = body.mode;
  const idHash = String(body.idHash ?? "");
  const credHash = String(body.credHash ?? "");
  if (!HASH_RE.test(idHash) || !HASH_RE.test(credHash)) {
    return NextResponse.json({ error: "잘못된 요청입니다" }, { status: 400 });
  }

  const ip = clientKey(req);
  if (!takeAttempt(`ip:${ip}`, 30) || !takeAttempt(`account:${ip}:${idHash}`, 10)) {
    return NextResponse.json(
      { error: "로그인 시도가 너무 많아요. 15분 뒤 다시 시도해주세요" },
      { status: 429, headers: { "Retry-After": "900" } },
    );
  }

  try {
    const lockIds = [idHash];
    if (mode === "car" && typeof body.carIdHash === "string" && HASH_RE.test(body.carIdHash)) lockIds.push(body.carIdHash);
    return await withAccountLocks(lockIds, async () => {
      const reg = load();
      const entry = reg[idHash];

      if (mode === "car") {
        const vinHash = body.vinHash;
        if (vinHash !== undefined && (typeof vinHash !== "string" || !/^[a-f0-9]{64}$/.test(vinHash))) {
          return NextResponse.json({ error: "잘못된 차량 정보입니다" }, { status: 400 });
        }
        // The base device proof is mandatory on every route, including existing per-car accounts.
        if (entry && !await verify(credHash, entry.verifier)) {
          return NextResponse.json({ error: "기기 인증에 실패했어요" }, { status: 401 });
        }
        const baseVerifier = entry?.verifier ?? await makeVerifier(credHash);
        const latest = load();
        const base = latest[idHash] ?? { verifier: baseVerifier, createdAt: Date.now() };
        const targetId = idHash, targetProof = credHash;
        if (base.vinHash && vinHash && base.vinHash !== vinHash) {
          const carId = String(body.carIdHash ?? ""), carProof = String(body.carCredHash ?? "");
          if (!HASH_RE.test(carId) || !HASH_RE.test(carProof) || carId === idHash) {
            return NextResponse.json({ error: "차량별 기기 인증이 필요합니다" }, { status: 400 });
          }
          if (base.cars?.[vinHash] && base.cars[vinHash] !== carId) {
            return NextResponse.json({ error: "차량 인증이 일치하지 않아요" }, { status: 401 });
          }
          // Both base and routed ids are locked while verifying and saving.
          const current = load();
          const target = current[carId];
          if (target && (!await verify(carProof, target.verifier) || target.vinHash !== vinHash)) {
            return NextResponse.json({ error: "차량 인증이 일치하지 않아요" }, { status: 401 });
          }
          const verifier = target?.verifier ?? await makeVerifier(carProof);
          const final = load();
          final[idHash] = { ...base, cars: { ...base.cars, [vinHash]: carId } };
          final[carId] = target ?? { verifier, createdAt: Date.now(), vinHash };
          save(final);
          const res = NextResponse.json({ ok: true, idHash: carId, vinHash, autoCar: true });
          createAuthSession(req, res, carId, carProof, true);
          return res;
        }
        if (!base.vinHash && vinHash) base.vinHash = vinHash;
        latest[idHash] = base;
        save(latest);
        const res = NextResponse.json({ ok: true, idHash: targetId, vinHash: base.vinHash, autoCar: true });
        createAuthSession(req, res, targetId, targetProof, true);
        return res;
      }

      if (mode === "signup") {
        if (entry) {
          return NextResponse.json({ error: "이미 사용 중인 아이디예요" }, { status: 409 });
        }
        const verifier = await makeVerifier(credHash);
        // 저장 직전에 레지스트리를 다시 읽는다.
        const latest = load();
        if (latest[idHash]) {
          return NextResponse.json({ error: "이미 사용 중인 아이디예요" }, { status: 409 });
        }
        latest[idHash] = { verifier, createdAt: Date.now() };
        save(latest);
        const res = NextResponse.json({ ok: true, idHash });
        createAuthSession(req, res, idHash, credHash);
        return res;
      }

      if (mode === "login") {
        if (entry) {
          if (await verify(credHash, entry.verifier)) {
            const res = NextResponse.json({ ok: true, idHash, vinHash: entry?.vinHash });
            createAuthSession(req, res, idHash, credHash);
            return res;
          }
          return NextResponse.json({ error: "비밀번호가 일치하지 않아요" }, { status: 401 });
        }
        // 레지스트리 도입 전 유저 — 이 credHash의 기록 버킷이 존재하면 올바른
        // 비밀번호를 안다는 뜻이므로 이번 로그인으로 계정을 입양(등록)한다.
        if (
          existsSync(
            join(
              /* turbopackIgnore: true */ process.cwd(),
              "data",
              "records",
              `${credHash}.json`,
            ),
          )
        ) {
          const verifier = await makeVerifier(credHash);
          // 저장 직전에 레지스트리를 다시 읽는다.
          const finalRegistry = load();
          finalRegistry[idHash] = { verifier, createdAt: Date.now() };
          save(finalRegistry);
          const res = NextResponse.json({ ok: true, adopted: true, idHash });
          createAuthSession(req, res, idHash, credHash);
          return res;
        }
        return NextResponse.json({ error: "가입되지 않은 아이디예요" }, { status: 404 });
      }

      return NextResponse.json({ error: "mode는 signup, login 또는 car" }, { status: 400 });
    });
  } catch {
    // 레지스트리 손상/IO 오류 — 덮어쓰기 없이 일시 실패로 응답한다(fail-closed)
    return NextResponse.json(
      { error: "인증 저장소를 일시적으로 사용할 수 없어요. 잠시 후 다시 시도해주세요" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }
}

/** 저장된 브라우저 로그인 표시가 실제 서버 세션과 일치하는지 확인한다. */
export async function GET(req: NextRequest) {
  const session = readAuthSession(req);
  if (!session) {
    const res = NextResponse.json({ ok: false }, { status: 401 });
    clearAuthCookie(req, res);
    return res;
  }
  try {
    return NextResponse.json({
      ok: true,
      idHash: session.idHash,
      linkedProviders: linkedProvidersForAccount(session.idHash),
      autoCar: session.autoCar === true,
      vinHash: load()[session.idHash]?.vinHash,
    });
  } catch {
    return NextResponse.json({ error: "로그인 정보를 확인하지 못했어요" }, { status: 503 });
  }
}

/** recordHash로 된 기록 버킷 파일과 그 백업·임시본을 지운다(경로 조작 방지 검증 후). */
function deleteRecordBucket(recordHash: string): void {
  if (!HASH_RE.test(recordHash)) return;
  const base = join(
    /* turbopackIgnore: true */ process.cwd(),
    "data",
    "records",
    `${recordHash}.json`,
  );
  for (const f of [base, `${base}.bak`, `${base}.tmp`]) {
    try {
      rmSync(/* turbopackIgnore: true */ f, { force: true });
    } catch {
      // 일부 파일이 없거나 못 지워도 나머지는 계속 지운다
    }
  }
  // 센서 원본 기록(api/raw-log)도 같은 유저 버킷 — 함께 지운다
  try {
    rmSync(
      join(/* turbopackIgnore: true */ process.cwd(), "data", "rawlog", recordHash),
      { recursive: true, force: true },
    );
  } catch {
    // 없으면 그만
  }
}

export async function DELETE(req: NextRequest) {
  const wantsAccountDelete =
    req.nextUrl.searchParams.get("action") === "delete-account";

  // 기본 DELETE = 로그아웃(현재 기기 세션만). 계정 삭제는 명시적으로 요청해야 한다.
  if (!wantsAccountDelete) {
    revokeAuthSession(req);
    const res = NextResponse.json({ ok: true });
    clearAuthCookie(req, res);
    return res;
  }

  // 계정 삭제 — 반드시 로그인 상태여야 하고, 삭제 대상은 세션이 가리키는 계정뿐이다.
  const session = readAuthSession(req);
  if (!session) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
  const { idHash, recordHash } = session;

  try {
    await withAccountLock(idHash, async () => {
      // 1) 로그인 자격(레지스트리 항목) 삭제 — 같은 아이디 재가입이 가능해진다.
      //    레지스트리가 손상돼 load()가 throw하면 여기서 멈춰(기록·세션은 건드리지
      //    않은 채) 아래 catch로 빠진다 — 자격은 남고 기록은 보존되는 안전한 실패.
      const reg = load();
      if (reg[idHash]) {
        delete reg[idHash];
        save(reg);
      }
      // 2) 주행 기록 버킷 삭제 (유저 지시: 계정 삭제 시 기록까지 함께 삭제)
      deleteRecordBucket(recordHash);
      // 3) 모든 기기의 세션 무효화
      revokeAllSessionsForAccount(idHash);
      // 4) 이 계정을 가리키던 소셜 연동 제거 — 삭제된 버킷을 잇는 유령 링크 방지
      removeLinksForAccount(idHash);
    });
  } catch {
    return NextResponse.json(
      { error: "인증 저장소를 일시적으로 사용할 수 없어요. 잠시 후 다시 시도해주세요" },
      { status: 503, headers: { "Retry-After": "30" } },
    );
  }

  const res = NextResponse.json({ ok: true, deleted: true });
  clearAuthCookie(req, res);
  return res;
}
