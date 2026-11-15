// 모든 주행 시작 경로에서 같은 안내 방식 선택 규칙을 사용한다.
export function needsGuideChoice(carBuild: boolean, plan: { path?: string } | null | undefined,
  mode: string, recordingOnly = false, support: string = "connected"): boolean {
  return carBuild && support !== "unsupported" && mode === "car" && !!plan?.path && !recordingOnly;
}

export function guidedStartBlockMessage(phase: string): string | null {
  return phase === "driving" || phase === "paused"
    ? "주행 중에는 새 안내를 시작할 수 없어요. 주행을 끝낸 뒤 다시 시도해 주세요."
    : null;
}

export function currentLocalSelection(selectedGeneration: number, currentGeneration: number,
  expectedId: string, result: { requestId: string; ok: boolean }): boolean {
  return result.ok && expectedId === result.requestId && selectedGeneration === currentGeneration;
}

export type GuideMode = "native" | "local" | "local-pending" | "local-failed" | "none";
export type PleosSupport = "unsupported" | "connecting" | "connected" | "disconnected";
export function restoreGuideMode(saved: GuideMode, support: PleosSupport): GuideMode {
  return support !== "unsupported" && (saved === "local" || saved === "local-pending") ? "local-pending" : saved;
}
export function localGuidanceAllowed(mode: GuideMode): boolean { return mode === "local"; }

/** Fixed decision fields only. Diagnostics must never affect a course-start decision. */
export function courseStartDiagnostic(branch: string, fields: Record<string, string | boolean>): void {
  const reason = fields.reason ?? (fields.chooser === true ? "show-chooser"
    : fields.guideSelected ? "guide-already-selected" : fields.recordingOnly ? "recording-only"
    : fields.carBuild === false ? "web-build" : fields.support === "unsupported" ? "unsupported"
    : fields.path === false ? "no-course-path" : fields.mode && fields.mode !== "car" ? "non-car-mode" : "entry");
  try { window.DriveNative?.diag?.(`courseStart ${branch} ${JSON.stringify({ ...fields, reason })}`); } catch {}
}
