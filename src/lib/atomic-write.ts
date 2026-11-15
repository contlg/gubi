import "server-only";

import { renameSync, writeFileSync } from "node:fs";

/**
 * 원자적 파일 쓰기 — .tmp에 완전히 쓴 뒤 rename으로 교체한다. 쓰는 도중
 * 크래시·전원차단이 나도 본 파일이 잘리거나 깨지지 않는다(rename은 원자적).
 * drive-records가 쓰던 패턴을 공용화 — road-ratings·drive-plan·캐시도 사용.
 */
export function writeFileAtomic(file: string, data: string) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}
