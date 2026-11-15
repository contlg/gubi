"use client";

import { IconPin } from "@/components/icons";

/**
 * 위치 권한 게이트 — 로그인 다음 관문. 권한 없이는 내비·기록이 동작 못 하므로
 * 앱 전체를 막고 회복 경로를 안내한다(웹=브라우저 설정 안내, 앱=설정 점프).
 * "checking"/"granted"는 부모(page.tsx)가 걸러내고, 여기엔 막는 상태만 온다.
 */
export type GeoPermBlocked = "prompt" | "denied" | "unsupported";

export default function LocationGate({
  geoPerm,
  isNative,
  onRequest,
  onRecheck,
}: {
  geoPerm: GeoPermBlocked;
  /** 안드로이드 앱(WebView) 여부 — 거부 시 설정 점프 버튼을 낸다 */
  isNative: boolean;
  /** "위치 권한 허용" — 웹은 getCurrentPosition 요청, 앱은 네이티브 브리지 */
  onRequest: () => void;
  /** "다시 확인" — 프롬프트 없이 현재 권한 상태를 다시 읽는다 */
  onRecheck: () => void;
}) {
  const native = isNative;
  const denied = geoPerm === "denied";
  const unsupported = geoPerm === "unsupported";
  const canJumpToSettings =
    denied &&
    native &&
    typeof window !== "undefined" &&
    !!window.DriveNative?.openAppSettings;

  return (
    <div className="min-h-screen bg-bg text-primary">
      <div className="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-7 px-7 py-10">
        <div className="flex flex-col items-start gap-5">
          <span className="grid h-14 w-14 place-items-center rounded-md bg-accent-surface text-[26px]">
            <IconPin size={24} className="h-6 w-6 text-accent-text" />
          </span>
          <div>
            <h1 className="text-[1.75rem] font-semibold leading-tight tracking-[-0.03em] text-primary">
              {unsupported ? "위치 지원 안 됨" : "위치 권한 필요"}
            </h1>
            <p className="mt-3 text-[15px] leading-relaxed text-secondary">
              {unsupported
                ? "위치를 지원하는 브라우저나 앱에서 열어 주세요."
                : "길 안내와 주행 기록에 위치 권한이 필요해요."}
            </p>
          </div>
        </div>

        {!unsupported && (
          <div className="flex flex-col gap-3">
            {/* 웹·앱 공통: 아직 안 물었으면(prompt) 요청, 앱은 거부여도
                requestLocation이 설정 점프까지 알아서 처리한다. */}
            {(!denied || native) && (
              <button
                type="button"
                onClick={onRequest}
                className="rounded-md bg-accent py-4 text-[15px] font-semibold text-primary transition-colors"
              >
                위치 권한 허용
              </button>
            )}

            {/* 웹에서 이미 거부됨: 브라우저가 재요청을 막으므로 설정에서
                직접 켜는 법을 안내하고, 켜고 돌아오면 자동으로 통과된다. */}
            {denied && !native && (
              <div className="rounded-md border border-line bg-raised px-4 py-4 text-[13px] leading-relaxed text-secondary">
                주소창의 자물쇠 메뉴에서 위치를 허용한 뒤 다시 확인해 주세요.
              </div>
            )}

            {/* 앱에서 거부됨: 설정 화면으로 바로 점프 */}
            {canJumpToSettings && (
              <button
                type="button"
                onClick={() => window.DriveNative?.openAppSettings?.()}
                className="rounded-md border border-line bg-raised py-4 text-[15px] font-semibold text-primary transition-colors"
              >
                설정 열기
              </button>
            )}

            <button
              type="button"
              onClick={onRecheck}
              className="rounded-md border border-line bg-raised py-4 text-[15px] font-semibold text-primary transition-colors"
            >
              다시 확인
            </button>
          </div>
        )}

        <p className="text-[13px] leading-relaxed text-secondary">
          위치 권한은
          {native ? " 휴대폰 설정에서" : " 브라우저 설정에서"} 변경할 수 있어요.
        </p>
      </div>
    </div>
  );
}
