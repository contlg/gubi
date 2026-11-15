import "server-only";

import { constants } from "node:fs";
import { link, lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const MAX_DIAGNOSTIC_BYTES = 16_384;
const INTERVAL_SECONDS = 5 * 24 * 60 * 60;
const ACTIVE_STATES = new Set(["checking", "downloading", "validating", "publishing"]);
const STATES = new Set([...ACTIVE_STATES, "idle", "error", "unknown"]);
const ERROR = /^(?:network|timeout|metadata-network|metadata-invalid|metadata-size|metadata-unavailable|version-unavailable|download|parse|validation|insufficient-data|incompatible-format|incomplete-download|changed-source|storage|dependency|no-space|publish|busy|unknown|(?:tile-)?http-[45]\d\d)$/;
type PublicRecord = Record<string, unknown>;

/** Only fixed public diagnostic files are read; no environment or key files. */
async function readPublicRecord(path: string): Promise<PublicRecord | null> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_DIAGNOSTIC_BYTES) return null;
      const buffer = Buffer.alloc(MAX_DIAGNOSTIC_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_DIAGNOSTIC_BYTES) return null;
      const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
      return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value as PublicRecord : null;
    } finally { await file.close(); }
  } catch { return null; }
}

function integer(value: unknown, maximum = Number.MAX_SAFE_INTEGER) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum
    ? value : null;
}

function version(value: unknown) {
  return typeof value === "string" && /^20\d{6}[A-Z][A-Z0-9]{0,7}$/.test(value) ? value : null;
}

export async function tmapUpdaterState(root = process.cwd()) {
  const [value, config] = await Promise.all([
    readPublicRecord(join(root, "data/tmap-updater-status.json")),
    readPublicRecord(join(root, "data/tmap-updater-config.json")),
  ]);
  const configured = value?.source === "tmap";
  const record = configured ? value : null;
  const state = typeof record?.state === "string" && STATES.has(record.state) ? record.state : "unknown";
  const enabled = config?.source === "tmap" && config.intervalSeconds === INTERVAL_SECONDS
    ? config.enabled === true : record?.enabled === true;
  const timestamp = (key: string) => integer(record?.[key], 8_640_000_000_000_000);
  return {
    source: "tmap" as const, mode: "add" as const, configured, enabled, state,
    currentVersion: version(record?.currentVersion), latestVersion: version(record?.latestVersion),
    cameraCount: integer(record?.cameraCount, 1_000_000),
    lastCheckAt: timestamp("lastCheckAt"), lastSuccessAt: timestamp("lastSuccessAt"),
    nextCheckAt: timestamp("nextCheckAt"), completedTiles: integer(record?.completedTiles, 1_000_000),
    totalTiles: integer(record?.totalTiles, 1_000_000),
    errorCode: record?.errorCode == null ? null
      : typeof record.errorCode === "string" && ERROR.test(record.errorCode) ? record.errorCode : "unknown",
    running: record?.running === true || ACTIVE_STATES.has(state),
  };
}

type QueueResult = "accepted" | "busy" | "cooldown" | "disabled" | "unavailable";

async function atomicJson(path: string, value: PublicRecord) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
  } finally { await unlink(temporary).catch(() => {}); }
}

/** Fixed request spool; the web process never invokes a shell or systemctl. */
export async function queueTmapUpdate(root = process.cwd(), now = Date.now()): Promise<QueueResult> {
  if (!Number.isSafeInteger(now) || now < 0) return "unavailable";
  const folder = join(root, "data");
  const mutex = join(folder, ".tmap-updater-queue.lock");
  const request = join(folder, "tmap-updater-request.json");
  const cooldown = join(folder, "tmap-updater-requested-at.json");
  let locked = false;
  let temporary: string | null = null;
  try {
    try { await mkdir(mutex, { mode: 0o700 }); locked = true; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return "unavailable";
      // A worker killed between mkdir and finally must not block the UI forever.
      const info = await lstat(mutex);
      if (!info.isDirectory() || now - info.mtimeMs < 5 * 60_000) return "busy";
      await rmdir(mutex); // only an empty directory can be reclaimed
      await mkdir(mutex, { mode: 0o700 }); locked = true;
    }
    const state = await tmapUpdaterState(root);
    if (!state.configured) return "unavailable";
    if (!state.enabled) return "disabled";
    if (state.running) return "busy";
    try { await lstat(request); return "busy"; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return "unavailable"; }
    const previous = integer((await readPublicRecord(cooldown))?.requestedAt);
    if (previous !== null && now - previous < 60_000) return "cooldown";
    // Commit cooldown before notifying systemd, which may consume the request immediately.
    await atomicJson(cooldown, { requestedAt: now });
    temporary = join(folder, `.tmap-updater-request-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify({ source: "tmap", requestedAt: now }) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await link(temporary, request); // atomic publication without replacing an existing request
    return "accepted";
  } catch { return "unavailable"; }
  finally {
    if (temporary) await unlink(temporary).catch(() => {});
    if (locked) await rmdir(mutex).catch(() => {});
  }
}
