import "server-only";

import { spawn } from "node:child_process";
import { join } from "node:path";

/**
 * 센서 원본이 있는 주행에 자이로 기반 G를 붙이는 스크립트를 백그라운드로 돌린다
 * (scripts/rawlog/attach-gforce.mjs). 계산이 몇 초 걸려 요청은 기다리지 않는다.
 * 같은 계정은 20초에 한 번만 — 조각이 연달아 올라와도 한 번에 모아 계산한다.
 */
const last = new Map<string, number>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();

export function scheduleGForceAttach(bucket: string): void {
  // Hosting 모드에서는 맥용 자식 스크립트가 로컬 평문 기록을 별도로 만들지 않게 한다.
  if (process.env.RECORDS_STORAGE === "hosting") return;
  if (!/^[a-f0-9]{16,64}$/.test(bucket) || pending.has(bucket)) return;
  const wait = Math.max(3_000, 20_000 - (Date.now() - (last.get(bucket) ?? 0)));
  pending.set(
    bucket,
    setTimeout(() => {
      pending.delete(bucket);
      last.set(bucket, Date.now());
      try {
        const child = spawn(
          process.execPath,
          [join(/* turbopackIgnore: true */ process.cwd(), "scripts/rawlog/attach-gforce.mjs"), bucket],
          { cwd: process.cwd(), detached: true, stdio: "ignore" },
        );
        child.unref();
      } catch {
        // 계산 실패는 기록 저장에 영향 없음(GPS 값 유지)
      }
    }, wait),
  );
}
