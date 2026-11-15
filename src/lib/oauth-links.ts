import "server-only";

import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { writeFileAtomic } from "@/lib/atomic-write";
import type { OAuthProvider } from "@/lib/oauth";

/**
 * 소셜 계정 – 기존 계정 연동 표. 로그인한 사용자가 소셜을 연결하면
 * provider+subject 키에 그 계정의 idHash·recordHash를 저장한다. 이후 같은
 * 소셜로 로그인하면 여기서 원래 계정([[auth-session]]·기록 버킷)을 찾아 준다.
 * 값은 이미 해시(원문 아이디·비번 아님)라 그대로 저장해도 안전하다.
 */
const LINKS_FILE = join(process.cwd(), "data/auth-links.json");
const HASH_RE = /^[a-f0-9]{16,64}$/;

export interface AccountLink {
  idHash: string;
  recordHash: string;
  provider: OAuthProvider;
  linkedAt: number;
}

type LinkRegistry = Record<string, AccountLink>;

/** provider+subject – 연동 표 키. accountHashes의 idHash와 같은 파생식. */
function linkKey(provider: OAuthProvider, sub: string): string {
  return createHash("sha256").update(`${provider}:${sub}`).digest("hex");
}

function load(): LinkRegistry {
  try {
    const parsed = JSON.parse(readFileSync(LINKS_FILE, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as LinkRegistry) : {};
  } catch {
    return {};
  }
}

function save(reg: LinkRegistry): void {
  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  writeFileAtomic(LINKS_FILE, JSON.stringify(reg));
}

/** 이 소셜 신원이 연결된 기존 계정을 찾는다(없으면 null – 신규 소셜 계정). */
export function lookupLink(provider: OAuthProvider, sub: string): AccountLink | null {
  const link = load()[linkKey(provider, sub)];
  if (!link || !HASH_RE.test(link.idHash) || !HASH_RE.test(link.recordHash)) {
    return null;
  }
  return link;
}

/** 로그인한 계정에 이 소셜 신원을 연결한다(force reload 후 원자 저장). */
export function setLink(
  provider: OAuthProvider,
  sub: string,
  idHash: string,
  recordHash: string,
): void {
  const reg = load();
  reg[linkKey(provider, sub)] = { idHash, recordHash, provider, linkedAt: Date.now() };
  save(reg);
}

/** 이 계정에 연결된 소셜 provider 목록(UI에서 이미 연동된 버튼을 숨기는 데 쓴다). */
export function linkedProvidersForAccount(idHash: string): OAuthProvider[] {
  const seen = new Set<OAuthProvider>();
  for (const value of Object.values(load())) {
    if (value.idHash === idHash && (value.provider === "kakao" || value.provider === "google")) {
      seen.add(value.provider);
    }
  }
  return [...seen];
}

/** 계정 삭제 시 이 계정을 가리키던 모든 소셜 연동을 함께 지운다(유령 링크 방지). */
export function removeLinksForAccount(idHash: string): void {
  const reg = load();
  let changed = false;
  for (const [key, value] of Object.entries(reg)) {
    if (value.idHash === idHash) {
      delete reg[key];
      changed = true;
    }
  }
  if (changed) save(reg);
}
