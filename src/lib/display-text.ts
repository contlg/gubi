// 제공업체 장소명은 보존하고 앱이 만들었던 장식 형식만 화면에서 정리한다.
const AUTHORED_LABELS = [
  /^\u{1f30a} (해안 드라이브|바닷가 구간)$/u,
  /^\u{1f3de}\ufe0f? (강변 구간)$/u,
  /^\u{1f3d4}\ufe0f? (해발 [\d,]+m 정상부)$/u,
  /^\u{1f300} (헤어핀 구간|와인딩 구간)$/u,
  /^\u{1f6e3}\ufe0f? (코스 구간)$/u,
  /^\u{1f6a6} (무신호 약 [\d,]+km 연속|신호 거의 없음)$/u,
  /^\u{1f300} (헤어핀 [\d,]+개)$/u,
  /^\u{1f30a} (바닷가 밀착 [\d,]+km)$/u,
  /^\u26f0\ufe0f? (최고 해발 약 [\d,]+m)$/u,
  /^\u{1f4f8} (구간단속 있음|과속카메라 [\d,]+대|고정 단속카메라 없음)$/u,
];

const EMOJI_AND_MODIFIERS_REGEX =
  /(?:[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|[\uFE0E\uFE0F\u200D\u20E3]|\p{Extended_Pictographic})/gu;

export function stripEmoji(text: string): string {
  if (!text) return "";
  const cleaned = text.replace(EMOJI_AND_MODIFIERS_REGEX, (ch) =>
    ch === "©" || ch === "®" || ch === "™" ? ch : ""
  );
  return cleaned.replace(/\s+/g, " ").trim();
}

/** "A · B · C" → "A (B, C)" — 가운뎃점 나열 대신 핵심 + 괄호 추가 정보(유저, 2026-11-14) */
function parenize(text: string): string {
  const parts = text.split(" · ").map((t) => t.trim()).filter(Boolean);
  // 괄호 안 덧붙임의 붙은 가운뎃점("호반·물가")도 쉼표로 — 나열을 가운뎃점으로 잇지 않는다
  return parts.length > 1
    ? `${parts[0]} (${parts.slice(1).map((p) => p.replace(/\s*·\s*/g, ", ")).join(", ")})`
    : text;
}

export function cleanLabel(label: string): string {
  return parenize(cleanLabelRaw(label));
}

function cleanLabelRaw(label: string): string {
  if (!label) return "";
  const suffix = label.match(/(?: · (?:최단시간|주유 경유))+$/)?.[0] ?? "";
  const base = suffix ? label.slice(0, -suffix.length) : label;
  for (const template of AUTHORED_LABELS) {
    const match = template.exec(base);
    if (match) return match[1].replace(/^바닷가 밀착 /, "해안 구간 ") + suffix;
  }
  return stripEmoji(label);
}
