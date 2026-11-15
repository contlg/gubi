import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";

// Next의 서버 번들 밖에서 원본 TS를 실행한다. 동기 hook이 @/ 별칭과
// server-only shim을 처리하고, Node의 타입 스트리핑이 TS 문법을 제거한다.
// 정적 import보다 먼저 hook을 등록해야 한다.
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const srcRoot = join(projectRoot, "src");
const shimUrl = pathToFileURL(join(projectRoot, "scripts/nav-eval/shim.mjs")).href;

function resolveFile(base) {
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.mjs`,
    `${base}.js`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    } catch {}
  }
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only" || specifier === "client-only") {
      return { url: shimUrl, shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const file = resolveFile(join(srcRoot, specifier.slice(2)));
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    if (specifier.startsWith(".") && context.parentURL?.startsWith("file:")) {
      const file = resolveFile(fileURLToPath(new URL(specifier, context.parentURL)));
      if (file) return { url: pathToFileURL(file).href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
const { installSharedRoadBinaries } = await import("./shared-road-binaries.ts");
installSharedRoadBinaries(workerData?.sharedRoadBinaries);
const { executeRoutingJob } = await import("./routing-jobs.ts");

if (!parentPort) {
  throw new Error("routing-worker는 worker thread 안에서만 실행할 수 있습니다");
}

parentPort.on("message", async ({ id, job, timing }) => {
  try {
    parentPort.postMessage({ id, ok: true, result: await executeRoutingJob(job, timing) });
  } catch (error) {
    parentPort.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : "코스 계산 worker 오류",
    });
  }
});
