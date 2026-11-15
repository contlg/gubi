
export function recordingId(): string {
  const source = typeof crypto === "undefined" ? undefined : crypto;
  try {
    if (typeof source?.randomUUID === "function") return source.randomUUID();
  } catch {
    // 암호화 API를 사용할 수 없으면 아래의 난수 식별자를 쓴다.
  }
  const bytes = new Uint8Array(16);
  try {
    if (typeof source?.getRandomValues !== "function") throw new Error("unavailable");
    source.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
