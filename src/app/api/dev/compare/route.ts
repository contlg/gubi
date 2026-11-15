import { NextRequest, NextResponse } from "next/server";

import { readAuthSession } from "@/lib/auth-session";
import { devCamsNear } from "@/lib/dev-compare";
import { getDirections, routePath } from "@/lib/kakao";

/**
 * 개발자 옵션 "다른 내비 비교" — 주행 지도에 겹쳐 그릴 자료.
 *  - GET ?lat&lng&r=2000            반경 안 단속카메라를 출처별로(공공·티맵·카카오)
 *  - GET ?route=1&olat&olng&dlat&dlng 같은 출발·도착의 카카오 길찾기 경로
 * 카메라 파일: data/speedcams.json(공공), data/tmap-cams.json, data/kakao-cams.json.
 * 서버 경고에 실제로 쓰는 자료(CAMS_REF)와 무관하게 셋 다 보여준다.
 */
export async function GET(req: NextRequest) {
  if (!readAuthSession(req)) return NextResponse.json({ error: "로그인이 필요합니다" }, { status: 401 });
  const q = req.nextUrl.searchParams;
  const num = (k: string) => Number(q.get(k));
  if (q.get("route") === "1") {
    const o = { lat: num("olat"), lng: num("olng") }, d = { lat: num("dlat"), lng: num("dlng") };
    if (![o.lat, o.lng, d.lat, d.lng].every(Number.isFinite)) return NextResponse.json({ error: "좌표" }, { status: 400 });
    try {
      const routes = await getDirections(o, d, "RECOMMEND", { alternatives: false });
      const path = routes[0] ? routePath(routes[0]) : [];
      return NextResponse.json({ path: path.map((p) => [Math.round(p.lat * 1e5) / 1e5, Math.round(p.lng * 1e5) / 1e5]) });
    } catch (e) {
      return NextResponse.json({ error: e instanceof Error ? e.message : "경로 실패" }, { status: 502 });
    }
  }
  const lat = num("lat"), lng = num("lng");
  const r = Math.min(5000, Math.max(200, num("r") || 2000));
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NextResponse.json({ error: "좌표" }, { status: 400 });
  return NextResponse.json(devCamsNear(lat, lng, r));
}
