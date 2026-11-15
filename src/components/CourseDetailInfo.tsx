"use client";

import { useId, useState, type ReactNode } from "react";

/** Touch and keyboard disclosure for explanations hidden from the glance view. */
export default function CourseDetailInfo({ label, value, children, className = "", align = "start" }: {
  label: string;
  value: ReactNode;
  children: ReactNode;
  className?: string;
  align?: "start" | "end";
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className={`relative min-w-0 ${className}`}>
      <button
        type="button"
        aria-label={`${label} · 설명`}
        aria-expanded={open}
        aria-controls={id}
        aria-describedby={open ? id : undefined}
        onClick={() => setOpen((previous) => !previous)}
        onBlur={() => setOpen(false)}
        onKeyDown={(event) => { if (event.key === "Escape") setOpen(false); }}
        className="min-h-11 w-full rounded-sm text-left focus-visible:outline-2 focus-visible:outline-accent"
      >
        {value}
      </button>
      <div id={id} role="tooltip" hidden={!open} className={`absolute ${align === "end" ? "right-0" : "left-0"} top-full z-30 min-w-40 max-w-full rounded-md border border-line bg-panel p-3 text-xs font-normal leading-relaxed text-primary shadow-md`}>
        {children}
      </div>
    </div>
  );
}
