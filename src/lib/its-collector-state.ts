import "server-only";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

/** Public diagnostics only. The app never opens the collector's key file. */
export async function directCollectorState(root = process.cwd()) {
  try {
    const file = join(root, "data/its-collector-status.json");
    if ((await stat(file)).size > 16_384) return null;
    const value = JSON.parse(await readFile(file, "utf8"));
    if (value?.source !== "oracle-direct") return null;
    const number = (key: string) => typeof value[key] === "number" && Number.isFinite(value[key])
      && value[key] >= 0 ? value[key] as number : null;
    const errorCode = value.errorCode == null ? null
      : typeof value.errorCode === "string" && /^(?:no-key|network|timeout|storage|parse|dependency|response-size|insufficient-data|stale-source|http-[45]\d\d)$/.test(value.errorCode)
        ? value.errorCode : "unknown";
    return { source: "oracle-direct" as const, configured: errorCode !== "no-key",
      lastAttemptAt: number("lastAttemptAt"), lastSuccessAt: number("lastSuccessAt"),
      sourceAt: number("sourceAt"), count: number("count"), failures: number("failures"),
      durationMs: number("durationMs"), errorCode };
  } catch { return null; }
}
