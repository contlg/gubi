import "server-only";

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { writeFileAtomic } from "@/lib/atomic-write";

/**
 * 서버(맥미니) 파일에 얹은 TTL 캐시 — 외부 API(구글 별점·오피넷 유가) 응답을
 * 저장해 재시작·재방문에도 비용/지연을 아낀다. 메모리 맵으로 읽고, 변경분은
 * 잠깐 모아 파일로 flush(쓰기 폭주 방지). 만료 항목은 flush 때 정리.
 */
export class PersistCache<T> {
  private map = new Map<string, { ts: number; v: T }>();
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  // 상한 — 서로 다른 좌표 조회가 계속 쌓여도 메모리가 무한히 늘지 않게
  // (한 번 set 후 재조회 없는 키는 get의 만료 제거에 안 걸린다). 초과 시
  // 삽입 순서상 가장 오래된 것부터 버린다(Map은 삽입 순서 유지).
  private maxItems: number;

  constructor(
    private file: string,
    private ttlMs: number,
    maxItems = 5000,
  ) {
    this.maxItems = maxItems;
    try {
      if (existsSync(file)) {
        const obj = JSON.parse(readFileSync(file, "utf8")) as Record<
          string,
          { ts: number; v: T }
        >;
        const now = Date.now();
        for (const [k, e] of Object.entries(obj))
          if (e && now - e.ts <= ttlMs) this.map.set(k, e);
      }
    } catch {
      // 손상/부재 — 빈 캐시로 시작
    }
  }

  get(key: string): T | undefined {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() - e.ts > this.ttlMs) {
      this.map.delete(key);
      return undefined;
    }
    return e.v;
  }

  set(key: string, v: T) {
    this.map.delete(key); // 재삽입해 최신 키를 순서상 끝으로(오래된 것부터 축출)
    this.map.set(key, { ts: Date.now(), v });
    if (this.map.size > this.maxItems) {
      const drop = this.map.size - this.maxItems;
      const it = this.map.keys();
      for (let i = 0; i < drop; i++) this.map.delete(it.next().value as string);
    }
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 3000);
  }

  private flush() {
    this.timer = null;
    if (!this.dirty) return;
    this.dirty = false;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const now = Date.now();
      const obj: Record<string, { ts: number; v: T }> = {};
      for (const [k, e] of this.map)
        if (now - e.ts <= this.ttlMs) obj[k] = e;
      writeFileAtomic(this.file, JSON.stringify(obj));
    } catch {
      // 쓰기 실패는 무시(다음 set 때 재시도)
    }
  }
}
