import {
  copyFileSync,
  existsSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const projectRoot = process.cwd();
const distName = process.env.NEXT_DIST_DIR || ".next";
if (!/^\.next(?:-[A-Za-z0-9_-]+)?$/.test(distName)) {
  throw new Error(`안전하지 않은 NEXT_DIST_DIR: ${distName}`);
}
const distDir = resolve(projectRoot, distName);
if (!existsSync(distDir)) {
  throw new Error(`${distName}이 없습니다. next build를 먼저 실행하세요.`);
}
const outputDir = join(distDir, "routing-worker");

// 검증된 Next 산출물 하위의 생성 디렉터리만 교체한다.
rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

execFileSync(
  process.execPath,
  [
    join(projectRoot, "node_modules/typescript/bin/tsc"),
    "--project",
    join(projectRoot, "tsconfig.routing-worker.json"),
    "--outDir",
    outputDir,
  ],
  { cwd: projectRoot, stdio: "inherit" },
);

copyFileSync(
  join(projectRoot, "scripts/routing-worker-entry.mjs"),
  join(outputDir, "entry.mjs"),
);
copyFileSync(
  join(projectRoot, "scripts/routing-worker-loader.mjs"),
  join(outputDir, "loader.mjs"),
);
copyFileSync(
  join(projectRoot, "scripts/nav-eval/shim.mjs"),
  join(outputDir, "shim.mjs"),
);
writeFileSync(join(outputDir, "package.json"), '{"type":"module"}\n');

console.log(`Routing worker built: ${outputDir}`);
