import type { LatLng } from "@/lib/types";

/**
 * 현재 위치를 한 번 빨리 얻는다 — Gubi·코스추천 공용(브라우저 전용).
 * - 앱(1.5+): 폰에 직접 묻는다. 구글 통합 위치(와이파이·기지국+GPS)라 카카오맵처럼
 *   바로 뜬다. 폰이 10분 안에 알던 위치가 있으면 그걸 즉시 쓴다.
 * - 웹·구버전 앱: 정밀 위치를 6초 기다리고, 못 잡으면 대략 위치(10분 캐시 허용)로.
 * 실패 사유는 Error.message로 구분한다(권한 거부 vs 못 찾음).
 */

interface NativeLoc {
  getLastLocation?: () => string;
  requestCurrentLocation?: (id: string) => void;
}

export function quickPosition(): Promise<LatLng> {
  const native = (window as unknown as { DriveNative?: NativeLoc }).DriveNative;
  if (native?.requestCurrentLocation) {
    try {
      const last = JSON.parse(native.getLastLocation?.() || "null");
      if (last && last.age <= 600_000 && last.acc <= 2000) {
        return Promise.resolve({ lat: last.lat, lng: last.lng });
      }
    } catch {}
    return new Promise((resolve, reject) => {
      const id = `l${Date.now()}${Math.floor(Math.random() * 1e6)}`;
      const w = window as unknown as {
        __driveLoc?: (id: string, loc: { lat: number; lng: number } | null) => void;
      };
      const prev = w.__driveLoc;
      const done = (ok: LatLng | null) => {
        clearTimeout(timer);
        if (ok) resolve(ok);
        else webPosition().then(resolve, reject); // 폰이 못 주면 웹 방식으로
      };
      const timer = setTimeout(() => done(null), 10_000);
      w.__driveLoc = (rid, loc) => {
        if (rid !== id) return prev?.(rid, loc);
        w.__driveLoc = prev;
        done(loc ? { lat: loc.lat, lng: loc.lng } : null);
      };
      native.requestCurrentLocation!(id);
    });
  }
  return webPosition();
}

export const LOCATION_DENIED = "위치 권한 필요 — 설정에서 허용해주세요";
export const LOCATION_NOT_FOUND = "현재 위치를 못 찾았어요";

function webPosition(): Promise<LatLng> {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("위치 미지원"));
    const ok = (pos: GeolocationPosition) =>
      resolve({ lat: pos.coords.latitude, lng: pos.coords.longitude });
    navigator.geolocation.getCurrentPosition(
      ok,
      (e) => {
        if (e.code === 1) {
          reject(new Error(LOCATION_DENIED));
          return;
        }
        // 정밀 위치 실패(실내 등) — 와이파이·기지국 대략 위치로 다시
        navigator.geolocation.getCurrentPosition(
          ok,
          () => reject(new Error(LOCATION_NOT_FOUND)),
          { enableHighAccuracy: false, timeout: 8000, maximumAge: 600_000 },
        );
      },
      { enableHighAccuracy: true, timeout: 6000, maximumAge: 30_000 },
    );
  });
}
