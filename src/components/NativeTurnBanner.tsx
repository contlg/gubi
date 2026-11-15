"use client";

import { IconNativeTurn } from "@/components/icons";
import { usePleosFeed } from "@/lib/pleos-feed";
import { nativeTurnDistance, nativeTurnLabel, nativeTurnVisible } from "@/lib/native-turn";
import type { GuideMode } from "@/lib/guided-start";

export function NativeTurnBanner({ mode, phase }: { mode: GuideMode; phase: string }) {
  const { connected, feed } = usePleosFeed();
  const [next, following] = feed?.tbt ?? [];
  if (!connected || !next || !nativeTurnVisible(mode, phase)) return null;
  return <section data-over-map aria-label="현대 내비 회전 안내" className="mt-2 rounded-md border border-line bg-panel px-4 py-3 text-primary">
    <div className="flex items-center gap-3">
      <IconNativeTurn type={next.type} size={24} className="h-8 w-8 shrink-0 text-accent-text" />
      <div className="min-w-0 flex-1">
        <p className="text-xl font-bold tabular-nums">{nativeTurnDistance(next.distanceM)}</p>
        <p className="truncate text-sm">{next.text || nativeTurnLabel(next.type)}</p>
      </div>
    </div>
    {following && <p className="mt-2 truncate text-xs text-secondary">이어서 {nativeTurnLabel(following.type)}</p>}
  </section>;
}
