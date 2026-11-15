import "server-only";

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import type { NextRequest, NextResponse } from "next/server";

import { writeFileAtomic } from "@/lib/atomic-write";

const SESSION_FILE = join(process.cwd(), "data/auth-sessions.json");
const SESSION_COOKIE = "drivelog-session";
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const HASH_RE = /^[a-f0-9]{16,64}$/;
const TOKEN_HASH_RE = /^[a-f0-9]{64}$/;
const MAX_SESSIONS = 10_000;
const MAX_SESSIONS_PER_ACCOUNT = 8;
const SESSION_STAT_INTERVAL_MS = 1_000;
const SESSION_PRUNE_INTERVAL_MS = 5 * 60_000;

export interface AuthSession {
  autoCar?: boolean;
  idHash: string;
  /** 기존 기록 파일 이름을 유지하기 위한 내부 버킷 키. 클라이언트에는 안 보낸다. */
  recordHash: string;
  expiresAt: number;
}

type SessionRegistry = Record<string, AuthSession>;

interface SessionFileVersion {
  mtimeMs: number;
  size: number;
  ino: number;
}

let cachedSessions: SessionRegistry | null = null;
let cachedVersion: SessionFileVersion | null = null;
let nextStatAt = 0;
let nextPruneAt = 0;

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function sameVersion(a: SessionFileVersion | null, b: SessionFileVersion): boolean {
  return !!a && a.mtimeMs === b.mtimeMs && a.size === b.size && a.ino === b.ino;
}

function sessionFileVersion(): SessionFileVersion {
  const stat = statSync(SESSION_FILE);
  return { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino };
}

/**
 * 인증 핫패스는 메모리 캐시를 쓰고, 외부 프로세스가 파일을 바꿨는지만 최대
 * 1초마다 stat으로 확인한다. 로그인/로그아웃 쓰기는 force reload로 병합한다.
 */
function loadSessions(force = false): SessionRegistry {
  const now = Date.now();
  if (!force && cachedSessions && now < nextStatAt) return cachedSessions;
  nextStatAt = now + SESSION_STAT_INTERVAL_MS;
  try {
    const version = sessionFileVersion();
    if (!force && cachedSessions && sameVersion(cachedVersion, version)) {
      return cachedSessions;
    }
    const parsed = JSON.parse(readFileSync(SESSION_FILE, "utf8"));
    const sessions = parsed && typeof parsed === "object"
      ? (parsed as SessionRegistry)
      : {};
    cachedSessions = sessions;
    cachedVersion = version;
    return sessions;
  } catch {
    cachedSessions = {};
    cachedVersion = null;
    return cachedSessions;
  }
}

function saveSessions(sessions: SessionRegistry): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileAtomic(SESSION_FILE, JSON.stringify(sessions));
  cachedSessions = sessions;
  cachedVersion = sessionFileVersion();
  nextStatAt = Date.now() + SESSION_STAT_INTERVAL_MS;
}

function validSession(key: string, value: AuthSession | null, now: number): boolean {
  return !!(
    TOKEN_HASH_RE.test(key) &&
    value &&
    HASH_RE.test(value.idHash) &&
    HASH_RE.test(value.recordHash) &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt > now
  );
}

function pruneSessions(sessions: SessionRegistry, now = Date.now()): boolean {
  let changed = false;
  for (const [key, value] of Object.entries(sessions)) {
    if (!validSession(key, value, now)) {
      delete sessions[key];
      changed = true;
    }
  }
  return changed;
}

/** 장기 실행 서버에서 세션 파일이 무한히 커지지 않게 최신 세션만 유지한다. */
function capSessions(sessions: SessionRegistry): void {
  const byAccount = new Map<string, [string, AuthSession][]>();
  for (const entry of Object.entries(sessions)) {
    const list = byAccount.get(entry[1].idHash) ?? [];
    list.push(entry);
    byAccount.set(entry[1].idHash, list);
  }
  for (const list of byAccount.values()) {
    list.sort((a, b) => b[1].expiresAt - a[1].expiresAt);
    for (const [key] of list.slice(MAX_SESSIONS_PER_ACCOUNT)) delete sessions[key];
  }
  const all = Object.entries(sessions).sort(
    (a, b) => b[1].expiresAt - a[1].expiresAt,
  );
  for (const [key] of all.slice(MAX_SESSIONS)) delete sessions[key];
}

function requestIsHttps(req: NextRequest): boolean {
  const forwarded = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim();
  return forwarded === "https" || req.nextUrl.protocol === "https:";
}

export function createAuthSession(
  req: NextRequest,
  res: NextResponse,
  idHash: string,
  recordHash: string,
  autoCar = false,
): void {
  const now = Date.now();
  const token = randomBytes(32).toString("base64url");
  const sessions = loadSessions(true);
  pruneSessions(sessions, now);
  nextPruneAt = now + SESSION_PRUNE_INTERVAL_MS;
  sessions[tokenHash(token)] = {
    idHash,
    recordHash,
    ...(autoCar ? { autoCar: true } : {}),
    expiresAt: now + SESSION_TTL_MS,
  };
  capSessions(sessions);
  saveSessions(sessions);
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: requestIsHttps(req),
    path: "/",
    maxAge: Math.floor(SESSION_TTL_MS / 1000),
  });
}

export function readAuthSession(req: NextRequest): AuthSession | null {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token || token.length > 128) return null;
  const now = Date.now();
  const sessions = loadSessions();
  let changed = false;
  if (now >= nextPruneAt) {
    changed = pruneSessions(sessions, now);
    nextPruneAt = now + SESSION_PRUNE_INTERVAL_MS;
  }
  const key = tokenHash(token);
  let session: AuthSession | null = sessions[key] ?? null;
  // 전체 1만 건 순회는 주기적으로만 하되, 현재 요청의 만료 세션은 매번 즉시
  // 거부한다. 캐시 때문에 만료 허용 시간이 늘어나는 일은 없다.
  if (session && !validSession(key, session, now)) {
    delete sessions[key];
    session = null;
    changed = true;
  }
  if (changed) saveSessions(sessions);
  return session;
}

export function revokeAuthSession(req: NextRequest): void {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token || token.length > 128) return;
  const sessions = loadSessions(true);
  const removed = delete sessions[tokenHash(token)];
  const now = Date.now();
  if (pruneSessions(sessions, now) || removed) saveSessions(sessions);
  nextPruneAt = now + SESSION_PRUNE_INTERVAL_MS;
}

/**
 * 계정 삭제 시 이 계정의 모든 기기 세션을 끊는다(현재 기기뿐 아니라 폰·PC까지).
 * 삭제 후 다른 브라우저의 저장된 로그인 표시가 유령 세션으로 되살아나지 않게 한다.
 */
export function revokeAllSessionsForAccount(idHash: string): void {
  const sessions = loadSessions(true);
  let changed = false;
  for (const [key, value] of Object.entries(sessions)) {
    if (value.idHash === idHash) {
      delete sessions[key];
      changed = true;
    }
  }
  const now = Date.now();
  if (pruneSessions(sessions, now) || changed) saveSessions(sessions);
  nextPruneAt = now + SESSION_PRUNE_INTERVAL_MS;
}

export function clearAuthCookie(req: NextRequest, res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: requestIsHttps(req),
    path: "/",
    maxAge: 0,
  });
}
