/** 워커별 고정 안내 캐시. 교통속도·시간 보정은 캐시하지 않는다. */
export class GuidanceCache<T> {
  private entries = new Map<string, { value: T; bytes: number; expires: number }>();
  private bytes = 0;
  private maxEntries: number;
  private maxBytes: number;
  private ttlMs: number;

  constructor(maxEntries = 64, maxBytes = 16 * 1024 * 1024, ttlMs = 5 * 60_000) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
  }

  get(key: string, now = Date.now()): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expires <= now) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key);
    this.entries.set(key, entry);
    // NavEngine·호출자가 배열을 바꿔도 다음 사용자 안내에 전파되지 않는다.
    return structuredClone(entry.value);
  }

  set(key: string, value: T, now = Date.now()): void {
    this.remove(key);
    const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
    if (bytes > this.maxBytes || this.maxEntries < 1) return;
    for (const [key, entry] of this.entries) if (entry.expires <= now) this.remove(key);
    while (this.entries.size >= this.maxEntries || this.bytes + bytes > this.maxBytes) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.remove(oldest);
    }
    this.entries.set(key, { value: structuredClone(value), bytes, expires: now + this.ttlMs });
    this.bytes += bytes;
  }

  private remove(key: string): void {
    const entry = this.entries.get(key);
    if (entry) this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}
