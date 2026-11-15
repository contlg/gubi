/** 얇은 라인 아이콘 세트 — 이모지 대체. 24 그리드, currentColor stroke. */
type P = { className?: string; size?: 16 | 20 | 24 };

function Svg({ className, size = 20, children }: P & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? (size === 16 ? "h-4 w-4" : size === 24 ? "h-6 w-6" : "h-5 w-5")}
      width={size}
      height={size}
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconWheel(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2.5" />
      <path d="M12 14.5V21M9.9 10.9 4.2 8.2M14.1 10.9 19.8 8.2" />
    </Svg>
  );
}

export function IconLoop(p: P) {
  return (
    <Svg {...p}>
      <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.5" />
      <path d="M20 3.5v5h-5" />
      <path d="M20 12a8 8 0 0 1-13.7 5.6L4 15.5" />
      <path d="M4 20.5v-5h5" />
    </Svg>
  );
}

export function IconPin(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 21c4.5-4.2 7-7.6 7-11a7 7 0 1 0-14 0c0 3.4 2.5 6.8 7 11Z" />
      <circle cx="12" cy="10" r="2.4" />
    </Svg>
  );
}

export function IconSearch(p: P) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.6-3.6" />
    </Svg>
  );
}

export function IconTarget(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="7" />
      <path d="M12 2v3M12 19v3M2 12h3M19 12h3" />
      <circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconClose(p: P) {
  return (
    <Svg {...p}>
      <path d="m6 6 12 12M18 6 6 18" />
    </Svg>
  );
}

export function IconClock(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5V12l3 1.8" />
    </Svg>
  );
}

export function IconCompass(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="9" />
      <path d="m15.5 8.5-2 5-5 2 2-5 5-2Z" />
    </Svg>
  );
}

export function IconNav(p: P) {
  return (
    <Svg {...p}>
      <path d="M3 11 21 3l-8 18-2.2-7.8L3 11Z" />
    </Svg>
  );
}

export function IconPlay(p: P) {
  return (
    <Svg {...p}>
      <path d="M7 5.5 19 12 7 18.5V5.5Z" />
    </Svg>
  );
}

export function IconUser(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20c1-3.5 4-5 7-5s6 1.5 7 5" />
    </Svg>
  );
}

export function IconSettings(p: P) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
    </Svg>
  );
}

export function IconChevronRight(p: P) {
  return (
    <Svg {...p}>
      <path d="m9 5 7 7-7 7" />
    </Svg>
  );
}

export function IconMap(p: P) {
  return (
    <Svg {...p}>
      <path d="m9 4-6 2.5v13L9 17l6 2.5 6-2.5v-13L15 6.5 9 4Z" />
      <path d="M9 4v13M15 6.5v13" />
    </Svg>
  );
}

export function IconArrowLeft(p: P) {
  return (
    <Svg {...p}>
      <path d="M19 12H5m6-7-7 7 7 7" />
    </Svg>
  );
}

export function IconBolt(p: P) {
  return (
    <Svg {...p}>
      <path d="M13 2 4.5 13.5H11l-1 8.5L19.5 10H13l0-8Z" />
    </Svg>
  );
}

export function IconGauge(p: P) {
  return (
    <Svg {...p}>
      <path d="M4.5 18a8 8 0 1 1 15 0" />
      <path d="M12 14.5 16 10" />
      <circle cx="12" cy="14.5" r="1.3" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function IconPause(p: P) {
  return (
    <Svg {...p}>
      <path d="M9 5v14M15 5v14" />
    </Svg>
  );
}

export function IconFuel(p: P) {
  return (
    <Svg {...p}>
      <path d="M4 21V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v15M3 21h12" />
      <path d="M8 9h4" />
      <path d="M14 9h2.5a1.5 1.5 0 0 1 1.5 1.5V16a1.8 1.8 0 0 0 3.6 0V9L18.5 6" />
    </Svg>
  );
}

export function IconDownload(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 3v12m0 0 4.5-4.5M12 15l-4.5-4.5M4 20h16" />
    </Svg>
  );
}

export function IconCheck(p: P) {
  return (
    <Svg {...p}>
      <path d="M20 6 9 17l-5-5" />
    </Svg>
  );
}

export function IconAlert(p: P) {
  return (
    <Svg {...p}>
      <path d="M12 3 2 21h20L12 3Z" />
      <path d="M12 9v5m0 3v.5" />
    </Svg>
  );
}

export function IconStar({ filled = false, ...p }: P & { filled?: boolean }) {
  return (
    <Svg {...p}>
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z" fill={filled ? "currentColor" : "none"} />
    </Svg>
  );
}

export function IconCamera(p: P) {
  return (
    <Svg {...p}>
      <path d="M4 7h4l2-3h4l2 3h4v13H4Z" />
      <circle cx="12" cy="13" r="3" />
    </Svg>
  );
}

const MANEUVER_PATH: Record<string, string> = {
  left: "M20 20V10H5m5-5-5 5 5 5",
  right: "M4 20V10h15m-5-5 5 5-5 5",
  "slight-left": "M16 21V12L6 3m0 7V3h7",
  "slight-right": "M8 21V12L18 3m-7 0h7v7",
  "sharp-left": "M18 21V5L5 16m0-7v7h7",
  "sharp-right": "M6 21V5l13 11m-7 0h7V9",
  uturn: "M18 21V8a6 6 0 0 0-12 0v9m-4-4 4 4 4-4",
  "keep-left": "M12 21V12L5 4m0 6V4h6",
  "keep-right": "M12 21V12l7-8m-6 0h6v6",
  "fork-left": "M12 21V12L5 4m0 6V4h6m1 8 7-8",
  "fork-right": "M12 21V12l7-8m-6 0h6v6m-7 2L5 4",
  "roundabout-left": "M12 21v-5a6 6 0 1 0-6-6M2 6l4 4 4-4",
  "roundabout-right": "M12 21v-5a6 6 0 1 1 6-6m-4-4 4 4 4-4",
  overpass: "M3 18h18M5 18V9m14 9V9M3 9c6-7 12-7 18 0",
  underpass: "M3 6h18M5 6v9m14-9v9M3 15c6 7 12 7 18 0",
  tunnel: "M4 21V10a8 8 0 0 1 16 0v11M9 21V11m6 10V11",
  arrive: "M5 21V3h14l-3 4 3 4H5",
};

export function IconManeuver({ type, ...p }: P & { type: string }) {
  return <Svg {...p}><path d={MANEUVER_PATH[type] ?? "M12 21V3m-6 6 6-6 6 6"} /></Svg>;
}

const TRANSPORT_PATH: Record<string, string> = {
  car: "M4 15V9l2-5h12l2 5v6H4Zm0-6h16M6 15v4m12-4v4M7 12h1m8 0h1",
};

export function IconTransport({ mode, ...p }: P & { mode: "car" }) {
  return <Svg {...p}><path d={TRANSPORT_PATH[mode] ?? TRANSPORT_PATH.car} /></Svg>;
}

export function IconSound({ on, ...p }: P & { on: boolean }) {
  return (
    <Svg {...p}>
      <path d="M4 9h4l5-4v14l-5-4H4Z" />
      <path d={on ? "M17 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14" : "m17 9 5 6m0-6-5 6"} />
    </Svg>
  );
}

/** 순정 내비 TurnType용 회전·시설 기호. */
export function IconNativeTurn({ type, ...p }: P & { type: string }) {
  const paths: Record<string, string> = {
    STRAIGHT: "M12 21V3m-6 6 6-6 6 6",
    LEFT: "M17 21V9H3m6-6L3 9l6 6",
    RIGHT: "M7 21V9h14m-6-6 6 6-6 6",
    KEEP_L: "M15 21v-8L5 3m0 7V3h7",
    KEEP_R: "M9 21v-8L19 3m0 7V3h-7",
    SHARP_L: "M17 21V4L4 16m0-7v7h7",
    SHARP_R: "M7 21V4l13 12m0-7v7h-7",
    UTURN: "M18 21V8a6 6 0 0 0-12 0v9m-4-4 4 4 4-4",
    IC_ENTER: "M15 21V3m-4 4 4-4 4 4M3 18l12-8",
    IC_EXIT: "M7 21V3m0 11L20 3m-7 0h7v7",
    ROUNDABOUT: "M12 21v-5a5 5 0 1 1 5-5h4m-4-4 4 4-4 4",
    TUNNEL: "M3 21V11a9 9 0 0 1 18 0v10M7 21V11a5 5 0 0 1 10 0v10M12 16v3",
    TOLL: "M3 21V7h18v14M2 7l3-4h14l3 4M8 7v14M16 7v14M8 12h8",
    SERVICE: "M4 21V3h6a4 4 0 0 1 0 8H4m12-8v8m4-8v8m-4-4h4m-2 4v10",
    ARRIVE: "M5 21V3h14l-3 4 3 4H5",
    UNKNOWN: "M5 19 19 5M7 5h12v12",
  };
  const key = type.includes("ROUNDABOUT") ? "ROUNDABOUT"
    : type.startsWith("ENTER_IC_") ? "IC_ENTER" : type.startsWith("EXIT_IC_") ? "IC_EXIT"
    : type.includes("SERVICEAREA") || type === "RESTAREA" ? "SERVICE"
    : type.startsWith("ENTER_UNDER_") ? "TUNNEL"
    : type.startsWith("AVOID_") ? (type.endsWith("_L") ? "KEEP_L" : "KEEP_R")
    : type.startsWith("ENTER_OVER_") ? "STRAIGHT" : type;
  return <Svg {...p}><path d={paths[key] ?? paths.UNKNOWN} /></Svg>;
}
