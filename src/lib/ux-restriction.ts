import { useEffect, useState } from "react";

// 차가 움직이는 동안(UX 제한) 복잡한 화면을 막는다.
// 안드로이드: window.DriveNative.uxRestricted() + "drivenative-ux" 이벤트.
// 일반 브라우저(DriveNative 없음)는 제한 없음.
export const UX_RESTRICTION_EVENT = "drivenative-ux";

export function readUxRestricted(w: { DriveNative?: { uxRestricted?: () => boolean } } | undefined =
  typeof window === "undefined" ? undefined : window): boolean {
  try {
    return w?.DriveNative?.uxRestricted?.() === true;
  } catch {
    return false;
  }
}

export function useUxRestricted(): boolean {
  const [restricted, setRestricted] = useState(false);
  useEffect(() => {
    const update = () => setRestricted(readUxRestricted());
    update();
    window.addEventListener(UX_RESTRICTION_EVENT, update);
    return () => window.removeEventListener(UX_RESTRICTION_EVENT, update);
  }, []);
  return restricted;
}
