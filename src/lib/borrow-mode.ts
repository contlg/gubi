/**
 * "drivelog 서버 빌려 쓰기" 모드 — 맥미니(Gubi 서버)가 꺼져 있을 때 차 앱이
 * Firebase에 올린 정적 화면을 drivelog 주소(/gubi/…) 아래에서 열고, 계산
 * API(/api/…)만 drivelog 서버에 묻는다.
 *
 * 원칙: drivelog는 고치지 않고, Gubi 사용자 데이터(계정·주행 기록·센서 로그)는
 * drivelog로 보내지 않는다. 계정 대신 이 기기 전용 로컬 사용자를 쓰고, 기록은
 * 기기(localStorage)에만 남긴다.
 *
 * 빌드할 때 NEXT_PUBLIC_BORROW_SERVER=1 이면 켜진다(scripts/build-borrow-ui.mjs).
 * 꺼져 있으면 아래 함수는 모두 지금과 똑같이 동작한다.
 */

export const BORROW_SERVER = process.env.NEXT_PUBLIC_BORROW_SERVER === "1";

/** 정적 빌드의 basePath — scripts/build-borrow-ui.mjs의 BASE_PATH와 같아야 한다. */
export const BORROW_BASE_PATH = "/gubi";

/**
 * 손으로 쓴 루트 기준 정적 파일 주소(/sw.js, /log-manifest.json, /icons/… 같은
 * public 파일, 또는 /log 같은 페이지 주소)에 빌려 쓰기 모드의 basePath를 붙인다.
 * /api/… 는 drivelog 서버로 가야 하므로 절대 붙이지 않는다.
 * next/link·router·_next 자산은 Next가 알아서 붙이니 여기 쓰지 않는다.
 */
export function withBasePath(path: string, enabled: boolean = BORROW_SERVER): string {
  if (!enabled) return path;
  if (!path.startsWith("/") || path.startsWith("//")) return path;
  if (path === "/api" || path.startsWith("/api/") || path.startsWith("/api?")) return path;
  if (path === BORROW_BASE_PATH || path.startsWith(`${BORROW_BASE_PATH}/`)) return path;
  return `${BORROW_BASE_PATH}${path}`;
}

/** 로컬 사용자 — 이 기기에서만 쓰는 무작위 아이디(서버 계정 아님). */
export const LOCAL_OWNER_KEY = "fundrive-local-owner-v1";
export const LOCAL_USER_NAME = "내 차";
/** 빌려 쓰기 모드의 주행 기록 보관함(계정별 키: `${KEY}:${hash}`). */
export const LOCAL_RECORDS_KEY = "fundrive-local-records-v1";

function randomId(): string {
  try {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      const bytes = crypto.getRandomValues(new Uint8Array(16));
      return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    }
  } catch {
    // 아래 폴백
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

/** 이 기기의 로컬 사용자 원본 아이디 — 처음이면 만들어 저장하고, 이후엔 같은 값을 돌려준다. */
export function localOwnerSeed(storage: Pick<Storage, "getItem" | "setItem"> | null): string {
  try {
    const saved = storage?.getItem(LOCAL_OWNER_KEY);
    if (saved && saved.length >= 16) return saved;
  } catch {
    // 저장소를 못 읽으면 새로 만든다(이번 실행 동안만 유지)
  }
  const id = randomId();
  try {
    storage?.setItem(LOCAL_OWNER_KEY, id);
  } catch {
    // 저장 실패 — 이번 실행 동안만 유지
  }
  return id;
}

/**
 * 빌려 쓰기 모드에서 drivelog로 보내면 안 되는(사용자 데이터·로그인) API인지.
 * 각 호출부가 먼저 건너뛰지만, 혹시 빠진 곳이 있어도 막을 수 있게 같이 둔다.
 */
const USER_DATA_API = [
  "/api/auth",
  "/api/drive-records",
  "/api/drive-plan",
  "/api/raw-log",
  "/api/dev-log",
  "/api/dev",
  "/api/takeoff",
  "/api/road-rating",
  "/api/route-confirm",
  "/api/ops",
];
export function isUserDataApi(url: string): boolean {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split(/[?#]/)[0];
  return USER_DATA_API.some((base) => path === base || path.startsWith(`${base}/`));
}

/**
 * 안전망 — 빌려 쓰기 모드에서 사용자 데이터 API로 가는 같은 주소 fetch를 막는다.
 * 호출부 가드가 빠져도 기록·로그인 정보가 drivelog로 새지 않게 한다.
 * 막힌 요청은 오프라인처럼 실패(TypeError)로 돌려준다.
 */
export function installBorrowFetchGuard(target: (Window & typeof globalThis) | undefined): void {
  if (!BORROW_SERVER || !target || typeof target.fetch !== "function") return;
  const marked = target as unknown as { __fundriveBorrowGuard?: boolean };
  if (marked.__fundriveBorrowGuard) return;
  marked.__fundriveBorrowGuard = true;
  const original = target.fetch.bind(target);
  target.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    let url = "";
    try {
      url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const parsed = new URL(url, target.location.href);
      if (parsed.origin === target.location.origin && isUserDataApi(parsed.pathname)) {
        console.warn(`[borrow] 사용자 데이터 API 차단: ${parsed.pathname}`);
        return Promise.reject(new TypeError("borrow mode: user-data API blocked"));
      }
    } catch {
      // 주소 해석 실패 — 원래 fetch에 맡긴다
    }
    return original(input, init);
  }) as typeof target.fetch;
}
