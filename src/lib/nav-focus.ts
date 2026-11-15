/**
 * 차의 "경로 안내 주인" 자리(내비 포커스) — 이 앱이 직접 안내("이 앱으로 안내")할
 * 때만 잡고, 안내가 끝나면 내려놓는다. 다른 내비가 자리를 가져가면 안내를 바로
 * 멈추고 기록만 남긴다(자리를 다시 빼앗지 않는다).
 *
 * 브리지 함수는 모두 선택 사항이다. 일반 브라우저·옛 앱처럼 함수가 없으면 막지
 * 않는다(지금까지와 같다).
 */

export const NAV_FOCUS_LOST_EVENT = "drivenative-navfocus-lost";
/** 자리를 못 받았을 때 한 줄 상태 */
export const NAV_FOCUS_REFUSED_TEXT = "다른 내비 안내 중 (기록만)";
/** 안내 도중 다른 내비가 자리를 가져갔을 때 한 줄 상태 */
export const NAV_FOCUS_LOST_TEXT = "다른 내비로 안내 넘어감 (기록만)";

export type NavFocusBridge = {
  requestNavFocus?: () => boolean;
  abandonNavFocus?: () => void;
  hasNavFocus?: () => boolean;
} | null | undefined;

export type NavFocus = {
  /** 안내 직전에 부른다. false면 안내하지 말고 기록만 한다. */
  acquire(): boolean;
  /** 안내가 끝나면 부른다. 잡고 있을 때만 브리지에 알린다. */
  release(): void;
  /** 다른 앱이 가져갔다는 알림을 받았을 때 — 내려놓기 신호를 다시 보내지 않는다. */
  markLost(): void;
  held(): boolean;
  /** 잡고 있다고 믿는데 차가 아니라고 하면 true(화면 복귀 때 놓친 알림 확인용). */
  lostSilently(): boolean;
};

export function createNavFocus(bridge: () => NavFocusBridge): NavFocus {
  let held = false;
  return {
    acquire() {
      if (held) return true;
      const b = bridge();
      if (typeof b?.requestNavFocus !== "function") {
        held = true;
        return true;
      }
      let granted: unknown;
      try {
        granted = b.requestNavFocus();
      } catch {
        // 브리지 오류는 옛 앱과 같게 본다(안내 허용)
        granted = true;
      }
      held = granted !== false;
      return held;
    },
    release() {
      if (!held) return;
      held = false;
      try {
        bridge()?.abandonNavFocus?.();
      } catch {
        // 내려놓기 실패는 무시 — 차가 다음 요청 때 다시 정한다
      }
    },
    markLost() {
      held = false;
    },
    held: () => held,
    lostSilently() {
      if (!held) return false;
      try {
        const b = bridge();
        if (typeof b?.hasNavFocus !== "function") return false;
        return b.hasNavFocus() === false;
      } catch {
        return false;
      }
    },
  };
}
