import { NextRequest, NextResponse } from "next/server";

import { decodeValidPolyline, isLatLng } from "@/lib/api-validation";
import { readAuthSession } from "@/lib/auth-session";
import { getDirections, routePath } from "@/lib/kakao";
import { encodePolyline } from "@/lib/polyline";
import { jsonBodyError, readJsonBody } from "@/lib/request-json";
import { routeOverlapRatio } from "@/lib/route-similarity";
import { distanceM } from "@/lib/scoring/curvature";
import type { LatLng } from "@/lib/types";

// 카카오는 문서상 경유지 5개까지 받지만 실제 도로 스냅 조합에 따라 5개짜리
// 요청이 결과 없이 끝나는 경우가 있다. 앱의 기존 안정 경로와 같은 3개로
// 묶고, 전체 체크포인트를 12개로 제한해 출발 1회당 최대 4콜만 사용한다.
const MAX_CHECKPOINTS = 12;
const CONFIRM_WINDOW_MS = 10 * 60 * 1000;
const CONFIRM_LIMIT = 8;
const confirmAttempts = new Map<string, { count: number; resetAt: number }>();

function takeConfirmAttempt(account: string): boolean {
  const now = Date.now();
  if (confirmAttempts.size > 5_000) {
    for (const [key, value] of confirmAttempts) {
      if (value.resetAt <= now) confirmAttempts.delete(key);
    }
  }
  const current = confirmAttempts.get(account);
  if (!current || current.resetAt <= now) {
    confirmAttempts.set(account, { count: 1, resetAt: now + CONFIRM_WINDOW_MS });
    return true;
  }
  if (current.count >= CONFIRM_LIMIT) return false;
  current.count++;
  return true;
}

/** 경로 좌표에 가장 가까운 인덱스를 이전 경유지 뒤에서 찾아 순서를 지킨다. */
function orderedIndex(path: LatLng[], point: LatLng, from: number): number {
  let best = from;
  let bestD = Infinity;
  for (let i = from; i < path.length; i++) {
    const d = distanceM(path[i], point);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** 실제 경유지를 우선 보존하고 남는 슬롯을 경로 전체에 고르게 채운다. */
function checkpoints(path: LatLng[], vias: LatLng[]): LatLng[] {
  let from = 1;
  const indexed: { index: number; point: LatLng; named: boolean }[] = [];
  for (const via of vias.slice(0, MAX_CHECKPOINTS)) {
    const index = orderedIndex(path, via, from);
    indexed.push({ index, point: via, named: true });
    from = index;
  }
  const slots = Math.max(0, MAX_CHECKPOINTS - indexed.length);
  for (let i = 1; i <= slots; i++) {
    const index = Math.round((i * (path.length - 1)) / (slots + 1));
    indexed.push({ index, point: path[index], named: false });
  }
  indexed.sort((a, b) => a.index - b.index || Number(b.named) - Number(a.named));

  const out: LatLng[] = [];
  for (const entry of indexed) {
    if (
      entry.index <= 0 ||
      entry.index >= path.length - 1 ||
      out.some((point) => distanceM(point, entry.point) < 250)
    )
      continue;
    out.push(entry.point);
  }
  return out.slice(0, MAX_CHECKPOINTS);
}

/**
 * ITS/로컬 추천 경로를 실제 출발 시에만 카카오 도로망으로 최종 확인한다.
 * 최대 12개 체크포인트를 3경유 단위로 나눠 호출하고, 원 코스와 70% 이상
 * 겹칠 때만 경로·ETA를 채택한다. 카카오가 풍경 코스를 지름길로 바꾸면 거부한다.
 */
export async function POST(req: NextRequest) {
  const session = readAuthSession(req);
  if (!session) {
    return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  }
  if (!takeConfirmAttempt(session.idHash)) {
    return NextResponse.json(
      { error: "경로 확인 요청이 너무 많아요. 잠시 후 다시 시도해주세요" },
      { status: 429, headers: { "Retry-After": "600" } },
    );
  }
  let body: { path?: unknown; vias?: unknown };
  try {
    body = await readJsonBody(req);
  } catch (error) {
    const detail = jsonBodyError(error);
    return NextResponse.json({ error: detail.message }, { status: detail.status });
  }
  const original = decodeValidPolyline(body.path, 200_000, 20_000);
  if (!original || original.length < 2) {
    return NextResponse.json({ error: "올바른 path가 필요합니다" }, { status: 400 });
  }
  const namedVias = (Array.isArray(body.vias) ? body.vias : [])
    .filter(isLatLng)
    .slice(0, MAX_CHECKPOINTS);
  const stops = [
    original[0],
    ...checkpoints(original, namedVias),
    original[original.length - 1],
  ];

  try {
    const confirmed: LatLng[] = [];
    let durationSec = 0;
    let distanceMTotal = 0;
    let tollFare = 0;
    // 출발점 뒤 최대 4개 정류장 = 경유지 3 + 구간 도착지 1.
    for (let cursor = 1; cursor < stops.length; cursor += 4) {
      const group = stops.slice(cursor, cursor + 4);
      const destination = group[group.length - 1];
      const route = (
        await getDirections(stops[cursor - 1], destination, "RECOMMEND", {
          waypoints: group.slice(0, -1),
          alternatives: false,
        })
      )[0];
      // 도로망에 없는 OSM 샛길처럼 카카오가 정상 응답 안에서 경로 없음으로
      // 돌려주는 것은 장애가 아니다. 원본 독립 안내로 안전하게 폴백한다.
      if (!route) {
        return NextResponse.json({
          confirmed: false,
          reason: "카카오 도로망에서 확인할 수 없는 구간 — 원본 유지",
        });
      }
      durationSec += route.summary.duration;
      distanceMTotal += route.summary.distance;
      tollFare += route.summary.fare?.toll ?? 0;
      for (const point of routePath(route)) {
        const previous = confirmed[confirmed.length - 1];
        if (!previous || distanceM(previous, point) > 0.2) confirmed.push(point);
      }
    }

    if (confirmed.length < 2) throw new Error("카카오 확인 경로가 비어 있습니다");
    const overlap = routeOverlapRatio(original, confirmed);
    const originalM = original.slice(1).reduce(
      (sum, point, index) => sum + distanceM(original[index], point),
      0,
    );
    const distanceRatio = distanceMTotal / Math.max(1, originalM);
    if (overlap < 0.7 || distanceRatio < 0.7 || distanceRatio > 1.3) {
      return NextResponse.json({
        confirmed: false,
        overlap,
        distanceRatio,
        reason: "원 코스와 달라 원본 유지",
      });
    }
    return NextResponse.json({
      confirmed: true,
      path: encodePolyline(confirmed.map((p): [number, number] => [p.lat, p.lng])),
      durationSec: Math.round(durationSec),
      distanceM: Math.round(distanceMTotal),
      tollFare: Math.round(tollFare),
      overlap,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "카카오 최종 확인 실패" },
      { status: 502 },
    );
  }
}
