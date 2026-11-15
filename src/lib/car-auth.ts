export interface CarCredentials {
  id: string;
  secret: string;
  vinHash?: string;
  vinSource?: "live" | "cached";
  carId?: string;
  carSecret?: string;
}
export interface CarSession { idHash: string; autoCar?: boolean; vinHash?: string }

declare global {
  interface Window {
    __driveCarCredentials?: (requestId: string, raw: string | null) => void;
  }
}
const credentialRequests = new Map<string, (raw: string | null) => void>();
let credentialSequence = 0;

/** Await the live VIN deadline without blocking the WebView's JavaScript thread. */
export async function readCarCredentials(target: Window): Promise<CarCredentials | null> {
  if (!target.DriveNative?.requestCarCredentials) {
    try { return parseCarCredentials(target.DriveNative?.carCredentials?.()); }
    catch { return null; }
  }
  const requestId = `vin-${Date.now()}-${++credentialSequence}`;
  target.__driveCarCredentials = (id, raw) => credentialRequests.get(id)?.(raw);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      credentialRequests.delete(requestId);
      // A lost callback must not publish/sync a potentially stale automatic session.
      reject(new Error("차량 로그인 확인 시간 초과"));
    }, 5000);
    credentialRequests.set(requestId, raw => {
      clearTimeout(timer);
      credentialRequests.delete(requestId);
      resolve(parseCarCredentials(raw));
    });
    try { target.DriveNative!.requestCarCredentials!(requestId); }
    catch (error) {
      clearTimeout(timer);
      credentialRequests.delete(requestId);
      reject(error);
    }
  });
}

export function parseCarCredentials(raw: string | null | undefined): CarCredentials | null {
  try {
    const c = JSON.parse(raw ?? "null");
    if (!c || typeof c.id !== "string" || typeof c.secret !== "string" || !/^car-[a-f0-9]{12}$/.test(c.id) || !/^[a-f0-9]{64}$/.test(c.secret)) return null;
    if (c.vinHash !== undefined && (typeof c.vinHash !== "string" || typeof c.carSecret !== "string" || !/^[a-f0-9]{64}$/.test(c.vinHash) ||
        c.carId !== `${c.id}-${c.vinHash.slice(0, 8)}` || !/^[a-f0-9]{64}$/.test(c.carSecret))) return null;
    return c;
  } catch { return null; }
}

export function carSessionChanged(session: CarSession, credentials: CarCredentials | null): boolean {
  return session.autoCar === true && !!session.vinHash && !!credentials?.vinHash &&
    session.vinHash !== credentials.vinHash;
}

/** Confirm only an offline recording owner; do not restore a session or enable uploads. */
export async function confirmOfflineRecordingOwner(target: Window, session: CarSession | null,
  hash: (value: string) => Promise<string>): Promise<void> {
  if (!session || !target.DriveNative?.setOfflineRecordingOwner) return;
  try {
    const credentials = await readCarCredentials(target);
    if (!credentials) return;
    const automatic = session.autoCar === true || session.idHash === await hash(credentials.id) ||
      (!!credentials.carId && session.idHash === await hash(credentials.carId));
    if (automatic && carSessionChanged({ ...session, autoCar: true }, credentials)) return;
    target.DriveNative.setOfflineRecordingOwner(session.idHash);
  } catch { /* An unresolved VIN keeps recording ownership unassigned. */ }
}

export async function carAuthBody(credentials: CarCredentials, hash: (value: string) => Promise<string>) {
  const { id, secret, vinHash, carId, carSecret } = credentials;
  return {
    mode: "car", idHash: await hash(id), credHash: await hash(`${id}\0${secret}`),
    ...(vinHash && carId && carSecret ? {
      vinHash, carIdHash: await hash(carId), carCredHash: await hash(`${carId}\0${carSecret}`),
    } : {}),
  };
}

export const UNASSIGNED = "unassigned";
export function queueOwner(value: unknown): string {
  return typeof value === "string" && /^[a-f0-9]{16,64}$/.test(value) ? value : UNASSIGNED;
}
export function ownedBy(owner: unknown, account: string | null | undefined): boolean {
  return !!account && queueOwner(owner) !== UNASSIGNED && owner === account;
}
