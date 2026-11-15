
export type RecordingAck = { id: string; ok: boolean; reason?: string };
declare global { interface Window { __driveRecording?: (result: RecordingAck) => void } }
const pending = new Map<string, (result: RecordingAck) => void>();
export function abortRecording(id: string): boolean | void {
  const native = window.DriveNative;
  try {
    return native?.pleosSupport ? native.abortProvisionalDrive?.(id) : native?.abortProvisionalDrive?.();
  } catch { return false; }
}
export function requestRecording(mode: string, id: string): Promise<RecordingAck> {
  return new Promise(resolve => {
    const native = window.DriveNative;
    if (!native) { resolve({ id, ok: true }); return; }
    // 구버전 앱에는 비동기 시작 승인 프로토콜이 없다.
    if (!native.pleosSupport) {
      try { if (native.startMode) native.startMode(mode); else native.start(); resolve({ id, ok: true }); }
      catch { resolve({ id, ok: false }); }
      return;
    }
    window.__driveRecording = result => {
      if (result && typeof result.ok === "boolean" && typeof result.id === "string") pending.get(result.id)?.(result);
    };
    const timeout = setTimeout(() => finish({ id, ok: false, reason: "timeout" }), 10000);
    const finish = (result: RecordingAck) => { clearTimeout(timeout); pending.delete(id); resolve(result); };
    pending.set(id, finish);
    try {
      const returned = native.startMode?.(mode, id);
      if (returned !== id) finish({ id, ok: false, reason: "denied" });
    } catch { finish({ id, ok: false, reason: "denied" }); }
  });
}
