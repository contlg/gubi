"use client";

import { useEffect, useRef } from "react";

export default function GuideChoice({ busy, message, onNative, onLocal, onCancel }: {
  busy: boolean; message: string | null;
  onNative: () => void; onLocal: () => void; onCancel: () => void;
}) {
  const sheet = useRef<HTMLDivElement>(null);
  const primary = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    primary.current?.focus();
    return () => { previous?.focus(); };
  }, []);
  useEffect(() => {
    if (busy) sheet.current?.focus();
    else primary.current?.focus();
  }, [busy]);
  const status = message;
  return (
    <div data-map-block className="fixed inset-0 z-[100] flex items-end justify-center bg-overlay p-4 sm:items-center">
      <div ref={sheet} role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="guide-choice-title"
        className="w-full max-w-md space-y-3 rounded-md border border-line bg-bg p-6 text-primary"
        onKeyDown={(event) => {
          if (event.key === "Escape") { event.preventDefault(); if (!busy) onCancel(); }
          if (event.key === "Tab") {
            const buttons = Array.from(sheet.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
            if (!buttons.length) { event.preventDefault(); return; }
            const first = buttons[0], last = buttons[buttons.length - 1];
            if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
            else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
          }
        }}>
        <h2 id="guide-choice-title" className="text-xl font-bold">안내 방식 선택</h2>
        <button ref={primary} type="button" disabled={busy} onClick={onNative}
          className="w-full rounded-md bg-accent p-4 text-left text-primary disabled:opacity-50">
          <span className="block font-bold">현대 내비로 안내 (추천)</span>
          <span className="mt-1 block text-sm">(카메라, 충전 안내 포함)</span>
        </button>
        <button type="button" disabled={busy} onClick={onLocal}
          className="w-full rounded-md border border-line p-4 text-left disabled:opacity-50">
          <span className="block font-bold">이 앱으로 안내</span>
          <span className="mt-1 block text-sm text-secondary">(현대 내비 꺼짐)</span>
        </button>
        {status && <p role="status" aria-live="polite" className="text-sm">{status}</p>}
        <button type="button" disabled={busy} onClick={onCancel} className="w-full rounded-md p-3 font-semibold disabled:opacity-50">취소</button>
      </div>
    </div>
  );
}
