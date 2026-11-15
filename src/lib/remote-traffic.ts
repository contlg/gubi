import "server-only";

import { mkdir, open, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { randomUUID } from "node:crypto";

interface RefreshState {
  configured: boolean;
  checkedAt: number | null;
  importedAt: number | null;
  error: string | null;
}

const state: RefreshState = { configured: false, checkedAt: null, importedAt: null, error: null };
let pending: Promise<void> | null = null;
let nextCheckAt = 0;
const MAX_JSON = 16 * 1024 * 1024;
const CACHE = join(process.cwd(), "data/its-traffic.json");

export function remoteTrafficState(): RefreshState {
  return { ...state, configured: !!process.env.ITS_TRAFFIC_FEED_URL };
}

export function trafficSourceTime(value: unknown): number | null {
  if (typeof value !== "string" || !/^\d{14}$/.test(value)) return null;
  const parts = [0, 4, 6, 8, 10, 12].map((start, i) => Number(value.slice(start, i ? start + 2 : 4)));
  const [year, month, day, hour, minute, second] = parts;
  const time = Date.UTC(year, month - 1, day, hour - 9, minute, second);
  const roundTrip = new Date(time + 9 * 3600_000).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
  return roundTrip === value ? time : null;
}

async function refresh(): Promise<void> {
  const rawUrl = process.env.ITS_TRAFFIC_FEED_URL;
  if (!rawUrl) return;
  state.configured = true;
  state.checkedAt = Date.now();
  try {
    const url = new URL(rawUrl);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (url.username || url.password || url.search || url.hash ||
        (url.protocol !== "https:" && !(local && process.env.NODE_ENV !== "production"))) {
      throw new Error("feed-url");
    }
    const token = process.env.OPS_SHARED_TOKEN;
    if (!token || token.length < 32) throw new Error("feed-token");
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, "Accept-Encoding": "identity" },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(12_000),
    });
    if (!response.ok || !response.body) throw new Error(`feed-http-${response.status}`);
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_JSON) throw new Error("feed-size");
        chunks.push(value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    const binary = Buffer.concat(chunks);
    const raw = binary[0] === 0x1f && binary[1] === 0x8b
      ? gunzipSync(binary, { maxOutputLength: MAX_JSON }).toString("utf8")
      : binary.toString("utf8");
    const payload = JSON.parse(raw);
    const now = Date.now();
    const sourceTime = trafficSourceTime(payload.itsCreatedDate);
    if (typeof payload.updatedAt !== "number" || !Number.isFinite(payload.updatedAt) ||
        now - payload.updatedAt > 15 * 60_000 || payload.updatedAt > now + 60_000 ||
        sourceTime === null || now - sourceTime > 20 * 60_000 || sourceTime > now + 60_000 ||
        !payload.speeds || typeof payload.speeds !== "object" || Array.isArray(payload.speeds)) {
      throw new Error("feed-invalid");
    }
    const entries = Object.entries(payload.speeds);
    if (entries.length < 300_000 || entries.length > 1_000_000 || payload.count !== entries.length ||
        entries.some(([id, speed]) => !/^\d{1,16}$/.test(id) ||
          typeof speed !== "number" || !Number.isFinite(speed) || speed <= 0 || speed > 160)) {
      throw new Error("feed-invalid");
    }
    await mkdir(join(process.cwd(), "data"), { recursive: true });
    const lockPath = `${CACHE}.remote-lock`;
    try {
      if (Date.now() - (await stat(lockPath)).mtimeMs > 120_000) await unlink(lockPath);
    } catch { /* no abandoned lock */ }
    let lock;
    try { lock = await open(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
      throw error;
    }
    const temporary = `${CACHE}.${randomUUID()}.tmp`;
    try {
      // All worker threads share this directory. Read the previous generation only
      // after acquiring the file lock, so a slower fetch cannot roll back a newer one.
      let previousAt = 0;
      try {
        const previous = JSON.parse(await readFile(CACHE, "utf8"));
        if (Number.isFinite(previous.updatedAt)) previousAt = previous.updatedAt;
      } catch { /* first import */ }
      if (payload.updatedAt > previousAt) {
        await writeFile(temporary, raw, { mode: 0o600 });
        await rename(temporary, CACHE);
      }
      state.importedAt = Math.max(previousAt, payload.updatedAt);
    } finally {
      await unlink(temporary).catch(() => undefined);
      await lock.close();
      await unlink(lockPath).catch(() => undefined);
    }
    state.error = null;
  } catch (error) {
    // Never expose a fetch exception: it can include a URL or credentials.
    const message = error instanceof Error ? error.message : "";
    state.error = /^feed-(?:url|token|size|invalid|http-\d{3})$/.test(message) ? message : "feed-unreachable";
  }
}

/** No configured feed means no network requests and no change to the existing Mac path. */
export function refreshRemoteTrafficCache(): Promise<void> {
  if (!process.env.ITS_TRAFFIC_FEED_URL) return Promise.resolve();
  if (pending) return pending;
  if (Date.now() < nextCheckAt) return Promise.resolve();
  nextCheckAt = Date.now() + 60_000;
  pending = refresh().finally(() => { pending = null; });
  return pending;
}
