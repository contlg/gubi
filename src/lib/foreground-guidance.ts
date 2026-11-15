// 내비 앱 규칙: 안내(음성·비프)는 앱이 화면 앞에 있을 때만 한다.
// 뒤로 간 동안 놓친 안내는 다시 말하지 않는다.
export function pageVisibleForGuidance(doc: { visibilityState?: string; hidden?: boolean } | undefined =
  typeof document === "undefined" ? undefined : document): boolean {
  if (!doc) return true;
  return doc.visibilityState !== "hidden" && doc.hidden !== true;
}

/** 화면이 가려지면 웹 음성을 바로 끊는다. 해제 함수를 돌려준다. */
export function cancelSpeechWhenHidden(): () => void {
  if (typeof document === "undefined") return () => {};
  const onVis = () => {
    if (pageVisibleForGuidance()) return;
    try { window.speechSynthesis?.cancel?.(); } catch {}
  };
  document.addEventListener("visibilitychange", onVis);
  window.addEventListener("pagehide", onVis);
  return () => {
    document.removeEventListener("visibilitychange", onVis);
    window.removeEventListener("pagehide", onVis);
  };
}
