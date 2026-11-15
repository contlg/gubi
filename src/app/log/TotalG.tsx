"use client";

/**
 * 중력 포함 G(전체 G) — 폰 가속도(중력 포함) 크기 ÷ 9.81. 가만히 있으면 1.0G, 노면·선회·
 * 과속방지턱에서 오르내린다. 폰을 어느 방향으로 들고 있든 같은 값(앞뒤·좌우는 GForcePanel).
 * 0.5초 평균으로 손 떨림을 누르고, 최고·최저는 켜져 있는 동안(=기록 중) 유지.
 * 폰이 빨리 도는(초당 25° 넘는) 순간의 앞뒤 3초는 손에 들고 움직인 것이라 최고·최저에서 뺀다
 * (10-24 옌타이–인천: 순항 중 1.43G·0.76G가 폰을 초당 47° 돌리던 때였다. G가 튄 0.5초 자체는
 *  덜 돌고 앞뒤가 돌아서, 앞뒤를 빼야 걸러졌다 — 원본 재생 시 최고가 노면 충격 순간 1.31G로).
 * 그래서 값은 3초 기다렸다가 흔들림이 없으면 최고·최저에 넣는다.
 */

import { useEffect, useState } from "react";

const WIN_MS = 500;
const SHAKE_DPS = 25;
const SHAKE_PAD_MS = 3000;

export function useTotalG(active: boolean) {
  const [v, setV] = useState<{ g: number; max: number; min: number } | null>(null);
  useEffect(() => {
    if (!active) return;
    let sum = 0, n = 0, t0 = 0, max = 0, min = Infinity, first = 0, rot = 0, shakeAt = -Infinity;
    let pend: { t: number; g: number }[] = [];
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (a?.x == null || a.y == null || a.z == null) return;
      const now = performance.now();
      if (!t0) t0 = first = now;
      sum += Math.hypot(a.x, a.y, a.z) / 9.81;
      n++;
      const r = e.rotationRate;
      if (r) rot = Math.max(rot, Math.hypot(r.alpha ?? 0, r.beta ?? 0, r.gamma ?? 0));
      if (now - t0 < WIN_MS) return;
      const g = sum / n;
      sum = n = 0;
      t0 = now;
      if (rot > SHAKE_DPS) {
        shakeAt = now;
        pend = pend.filter((p) => now - p.t > SHAKE_PAD_MS); // 흔들리기 직전 3초도 버린다
      } else if (now - first > 1000 && now - shakeAt > SHAKE_PAD_MS) {
        // 켜진 직후 1초는 센서가 자리 잡는 중이라 뺀다
        pend.push({ t: now, g });
      }
      rot = 0;
      while (pend.length && now - pend[0].t > SHAKE_PAD_MS) {
        const p = pend.shift()!;
        max = Math.max(max, p.g);
        min = Math.min(min, p.g);
      }
      setV({ g, max, min: Number.isFinite(min) ? min : g });
    };
    window.addEventListener("devicemotion", onMotion);
    return () => {
      window.removeEventListener("devicemotion", onMotion);
      setV(null);
    };
  }, [active]);
  return v;
}
