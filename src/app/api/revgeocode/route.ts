import { NextRequest, NextResponse } from "next/server";

import { isAbroad, placeNameAt } from "@/lib/place-names";
import { coordToAddress } from "@/lib/kakao";
import { parseCoord } from "@/lib/params";

export async function GET(req: NextRequest) {
  const coord = parseCoord(req.nextUrl.searchParams.get("coord"));
  if (!coord) {
    return NextResponse.json(
      { error: "coord(경도,위도) 파라미터가 필요합니다" },
      { status: 400 },
    );
  }
  // 한국 행정동이 없으면(해외·바다) 가까운 공항 이름이나 나라 이름으로
  const address = placeNameAt({ lat: coord.lat, lng: coord.lng }) ?? "";
  // 해외면 카카오 기반 기능(길찾기 등)을 숨기고 기록만 — 화면이 이 값으로 바뀐다
  const abroad = isAbroad({ lat: coord.lat, lng: coord.lng });
  // detail=1: 지도에서 고른 지점 — 건물명·도로명 주소까지(카카오). 실패하면 행정동으로.
  if (req.nextUrl.searchParams.get("detail") === "1") {
    try {
      const a = await coordToAddress(coord);
      const full = a?.road ?? a?.jibun;
      if (full) {
        return NextResponse.json({
          place: { name: a?.building || full, address: a?.building ? full : (a?.jibun && a.road ? a.jibun : address), coord },
          addressPrecision: a?.road ? "도로명" : "지번",
        });
      }
    } catch {
      // 카카오 실패 — 아래 행정동 응답
    }
  }
  return NextResponse.json({
    place: { name: "현재 위치", address, coord },
    addressPrecision: address ? "행정동" : "좌표",
    abroad,
  });
}
