/**
 * 기기 안 암호화 보관 — 주행 기록·주행 중 스냅샷·최근 목적지·즐겨찾기·코스 검색 기록·
 * 출발 대기 코스처럼 위치가 담긴 값을 localStorage/sessionStorage에 평문으로 두지 않는다.
 *
 * - 열쇠: AES-GCM 256, 꺼낼 수 없는(non-extractable) CryptoKey. 처음 한 번 만들어
 *   IndexedDB에 CryptoKey 그대로 넣는다(원본 바이트는 어디에도 나오지 않는다).
 * - 쓸 때마다 새 12바이트 IV. 저장 모양: {"v":2,"iv":"<base64>","ct":"<base64>"}
 * - 예전 평문 값은 읽을 수 있고, 다음 저장 때 암호문으로 바뀐다.
 * - WebCrypto·IndexedDB가 없으면 평문으로 계속 쓴다(기록을 잃지 않게). 경고는 한 번만.
 */

export const SECURE_STORE_VERSION = 2;
const KEY_DB = "gubi-secure-v1";
const KEY_STORE = "keys";
const KEY_ID = "local-records-aes-gcm";
const KEY_TIMEOUT_MS = 3000;

type Storage2 = Pick<Storage, "getItem" | "setItem">;

export type SecureStoreDeps = {
  storage: Storage2;
  subtle: SubtleCrypto | null;
  randomBytes: (n: number) => Uint8Array;
  /** 암호화 열쇠. null이면 평문으로 쓴다. */
  getKey: () => Promise<CryptoKey | null>;
  warn: (msg: string) => void;
};

export type SecureRead =
  /** 값 없음·평문·복호 성공 */
  | { ok: true; value: unknown; encrypted: boolean }
  /** 암호문인데 열 수 없음(열쇠 없음·손상) — 이 값 위에 덮어쓰면 안 된다 */
  | { ok: false; reason: "locked" | "corrupt" };

let warned = false;
function warnOnce(deps: Pick<SecureStoreDeps, "warn">, msg: string) {
  if (warned) return;
  warned = true;
  try { deps.warn(msg); } catch {}
}

function toB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

type Envelope = { v: number; iv: string; ct: string };
function isEnvelope(x: unknown): x is Envelope {
  return !!x && typeof x === "object" && !Array.isArray(x) &&
    (x as Envelope).v === SECURE_STORE_VERSION && typeof (x as Envelope).iv === "string" && typeof (x as Envelope).ct === "string";
}

/** 저장된 값을 읽는다. 평문(예전 형식)도 그대로 돌려준다. */
export async function readSecureJson(key: string, deps: SecureStoreDeps = defaultDeps()): Promise<SecureRead> {
  let raw: string | null;
  try {
    raw = deps.storage.getItem(key);
  } catch {
    return { ok: true, value: null, encrypted: false };
  }
  if (raw == null) return { ok: true, value: null, encrypted: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: "corrupt" };
  }
  if (!isEnvelope(parsed)) return { ok: true, value: parsed, encrypted: false };
  const cryptoKey = deps.subtle ? await deps.getKey().catch(() => null) : null;
  if (!deps.subtle || !cryptoKey) return { ok: false, reason: "locked" };
  try {
    const plain = await deps.subtle.decrypt({ name: "AES-GCM", iv: fromB64(parsed.iv) as BufferSource }, cryptoKey,
      fromB64(parsed.ct) as BufferSource);
    return { ok: true, value: JSON.parse(new TextDecoder().decode(plain)), encrypted: true };
  } catch {
    return { ok: false, reason: "corrupt" };
  }
}

/**
 * 값을 암호화해 저장한다. 암호화할 수 없으면 평문으로 저장한다.
 * 저장 실패(용량 등)면 false.
 */
export async function writeSecureJson(key: string, value: unknown, deps: SecureStoreDeps = defaultDeps()): Promise<boolean> {
  const out = await sealJson(value, deps);
  try {
    deps.storage.setItem(key, out);
    return true;
  } catch {
    return false;
  }
}

/**
 * 저장할 문자열만 만든다(암호문 봉투, 안 되면 평문 JSON). 저장 직전에 "아직 최신인지"
 * 확인해야 하는 곳(주행 스냅샷)이 직접 setItem 한다.
 */
export async function sealJson(value: unknown, deps: SecureStoreDeps = defaultDeps()): Promise<string> {
  const json = JSON.stringify(value);
  const cryptoKey = deps.subtle ? await deps.getKey().catch(() => null) : null;
  if (deps.subtle && cryptoKey) {
    try {
      const iv = deps.randomBytes(12);
      const ct = await deps.subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, cryptoKey,
        new TextEncoder().encode(json) as BufferSource);
      return JSON.stringify({ v: SECURE_STORE_VERSION, iv: toB64(iv), ct: toB64(new Uint8Array(ct)) });
    } catch {
      warnOnce(deps, "[secure-store] 암호화 실패 — 평문으로 저장");
    }
  } else {
    warnOnce(deps, "[secure-store] WebCrypto/IndexedDB 없음 — 평문으로 저장");
  }
  return json;
}

/** 같은 키의 읽기·쓰기를 한 줄로 세운다(동시 저장이 서로 덮어쓰지 않게). */
const queues = new Map<string, Promise<unknown>>();
export function inSecureQueue<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job);
  const tail = run.catch(() => null);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return run;
}

/**
 * 읽기 + 평문 자동 이전. 값이 없거나 손상이면 value=null.
 * locked(암호문인데 지금 열쇠를 못 얻음)면 그 위에 덮어쓰지 말 것.
 */
export async function loadSecureJson(key: string, deps: SecureStoreDeps = defaultDeps()): Promise<{ value: unknown; locked: boolean }> {
  const got = await readSecureJson(key, deps);
  if (!got.ok) return { value: null, locked: got.reason === "locked" };
  if (!got.encrypted && got.value != null) await writeSecureJson(key, got.value, deps);
  return { value: got.value, locked: false };
}

/** 줄 세운 읽고-고치고-쓰기. 잠김·저장 실패면 null(기존 값은 그대로). */
export function updateSecureJson<T>(key: string, change: (current: unknown) => T,
  deps: SecureStoreDeps = defaultDeps()): Promise<T | null> {
  return inSecureQueue(key, async () => {
    const { value, locked } = await loadSecureJson(key, deps);
    if (locked) return null;
    const next = change(value);
    return (await writeSecureJson(key, next, deps)) ? next : null;
  }).catch(() => null);
}

/** 줄 세운 읽기(앞선 쓰기가 끝난 뒤 읽는다). */
export function loadSecureJsonQueued(key: string, deps: SecureStoreDeps = defaultDeps()): Promise<{ value: unknown; locked: boolean }> {
  return inSecureQueue(key, () => loadSecureJson(key, deps)).catch(() => ({ value: null, locked: false }));
}

/** 같은 열쇠로 다른 저장소(sessionStorage 등)를 쓰는 도우미. */
export function secureDepsFor(storage: Storage2): SecureStoreDeps {
  return { ...defaultDeps(), storage };
}

/** IndexedDB에 꺼낼 수 없는 AES-GCM 열쇠를 한 번 만들어 둔다. 두 탭이 동시에 만들어도 먼저 들어간 것 하나만 쓴다. */
export function indexedDbKeyProvider(idb: IDBFactory | undefined, subtle: SubtleCrypto | null): () => Promise<CryptoKey | null> {
  let pending: Promise<CryptoKey | null> | null = null;
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = idb!.open(KEY_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(KEY_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("blocked"));
  });
  const load = async (): Promise<CryptoKey | null> => {
    if (!idb || !subtle) return null;
    const db = await open();
    try {
      const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
        const req = db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get(KEY_ID);
        req.onsuccess = () => resolve(req.result as CryptoKey | undefined);
        req.onerror = () => reject(req.error);
      });
      if (existing) return existing;
      const fresh = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
      return await new Promise<CryptoKey>((resolve, reject) => {
        const tx = db.transaction(KEY_STORE, "readwrite");
        const store = tx.objectStore(KEY_STORE);
        let chosen: CryptoKey = fresh;
        const get = store.get(KEY_ID);
        get.onsuccess = () => {
          if (get.result) chosen = get.result as CryptoKey;
          else store.put(fresh, KEY_ID);
        };
        tx.oncomplete = () => resolve(chosen);
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  };
  return () => {
    if (!pending) {
      // IndexedDB가 응답하지 않으면 3초 뒤 평문으로 넘어간다(화면이 멈추지 않게).
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), KEY_TIMEOUT_MS); });
      pending = Promise.race([load().catch(() => null), timeout]).then((k) => {
        clearTimeout(timer);
        if (!k) pending = null; // 실패면 다음에 다시 시도
        return k;
      });
    }
    return pending;
  };
}

let defaults: SecureStoreDeps | null = null;
function defaultDeps(): SecureStoreDeps {
  if (defaults) return defaults;
  const c = typeof crypto !== "undefined" ? crypto : undefined;
  const subtle = c?.subtle ?? null;
  const idb = typeof indexedDB !== "undefined" ? indexedDB : undefined;
  defaults = {
    storage: localStorage,
    subtle,
    randomBytes: (n) => c!.getRandomValues(new Uint8Array(n)),
    getKey: indexedDbKeyProvider(idb, subtle),
    warn: (m) => console.warn(m),
  };
  return defaults;
}
