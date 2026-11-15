import "server-only";

/** 일반 API JSON 상한. 경로/기록은 클라이언트가 이보다 작게 묶어 보낸다. */
export const MAX_JSON_BODY_BYTES = 2 * 1024 * 1024;

export class RequestBodyTooLargeError extends Error {
  constructor() {
    super("요청 데이터가 너무 큽니다");
    this.name = "RequestBodyTooLargeError";
  }
}

/**
 * Content-Length가 없는 chunked 요청도 실제 읽은 바이트를 세어 중단한다.
 * req.json()처럼 본문 전체를 무제한 문자열로 만든 뒤 검사하지 않기 위한 헬퍼.
 */
export async function readJsonBody<T = unknown>(
  req: Request,
  maxBytes = MAX_JSON_BODY_BYTES,
): Promise<T> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new RequestBodyTooLargeError();
  }
  if (!req.body) throw new SyntaxError("JSON 본문이 비어 있습니다");

  const reader = req.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new RequestBodyTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(text) as T;
}

export function jsonBodyError(error: unknown): { message: string; status: number } {
  return error instanceof RequestBodyTooLargeError
    ? { message: error.message, status: 413 }
    : { message: "JSON 본문이 필요합니다", status: 400 };
}
