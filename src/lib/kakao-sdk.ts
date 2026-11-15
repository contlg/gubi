/* eslint-disable @typescript-eslint/no-explicit-any */

declare global {
  interface Window {
    kakao?: any;
  }
}

let sdkPromise: Promise<void> | null = null;

/**
 * 카카오맵 JS SDK 로더 — 지도·로드뷰가 공유한다. REST 쿼터와 별개인
 * JS SDK라 호출량 걱정 없이 쓴다. autoload=false 후 kakao.maps.load로 초기화.
 */
export function loadKakaoSdk(): Promise<void> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      reject(new Error("카카오맵 SDK를 불러오지 못했습니다"));
    };
    const timeout = setTimeout(fail, 15000);
    script.src = `https://dapi.kakao.com/v2/maps/sdk.js?appkey=${process.env.NEXT_PUBLIC_KAKAO_JS_KEY}&autoload=false`;
    script.onload = () => {
      if (!window.kakao?.maps?.load) { fail(); return; }
      window.kakao.maps.load(() => { clearTimeout(timeout); resolve(); });
    };
    script.onerror = fail;
    document.head.appendChild(script);
  }).catch((error) => { sdkPromise = null; throw error; });
  return sdkPromise;
}
