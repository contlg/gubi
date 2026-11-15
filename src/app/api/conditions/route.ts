import { NextRequest, NextResponse } from "next/server";

import { parseCoord } from "@/lib/params";
import { sunsetAt } from "@/lib/sun";
import type { ConditionAdjustments } from "@/lib/types";

/** WMO weather code 분류 */
const RAIN_CODES = new Set([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99]);
const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const FOG_CODES = new Set([45, 48]);

interface OpenMeteoResponse {
  current: {
    temperature_2m: number;
    precipitation: number;
    weather_code: number;
  };
}

export async function GET(req: NextRequest) {
  const origin = parseCoord(req.nextUrl.searchParams.get("origin"));
  if (!origin) {
    return NextResponse.json(
      { error: "origin(경도,위도) 파라미터가 필요합니다" },
      { status: 400 },
    );
  }

  try {
    const params = new URLSearchParams({
      latitude: String(origin.lat),
      longitude: String(origin.lng),
      current: "temperature_2m,precipitation,weather_code",
      timezone: "Asia/Seoul",
    });
    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`날씨 API 오류 ${res.status}`);
    const data = (await res.json()) as OpenMeteoResponse;

    const code = data.current.weather_code;
    const tempC = data.current.temperature_2m;
    const isRain = RAIN_CODES.has(code) || data.current.precipitation >= 0.5;
    const isSnow = SNOW_CODES.has(code);
    const isFog = FOG_CODES.has(code);
    const freezingRisk = tempC <= 1;

    const now = new Date();
    const sunset = sunsetAt(now, origin.lat, origin.lng);
    const minsToSunset = sunset
      ? (sunset.getTime() - now.getTime()) / 60_000
      : null;
    const sunsetSoon =
      minsToSunset !== null && minsToSunset > 0 && minsToSunset <= 150;

    const adjustments: ConditionAdjustments = {
      funMul: 1,
      mountainMul: 1,
      seaMul: 1,
    };
    const notes: string[] = [];

    if (isRain) {
      adjustments.funMul = 0.5;
      notes.push("비 · 와인딩 가중치 감소");
    }
    if (isFog) {
      adjustments.mountainMul = 0;
      notes.push("안개 · 산길 가점 제외");
    }
    if (isSnow || (freezingRisk && isRain)) {
      adjustments.funMul = Math.min(adjustments.funMul, 0.3);
      adjustments.mountainMul = 0;
      notes.push("결빙 위험 · 산길 가점 제외");
    }
    if (sunsetSoon) {
      adjustments.seaMul = 1.5;
      notes.push(
        `일몰 ${sunset!.toLocaleTimeString("ko-KR", {
          hour: "2-digit",
          minute: "2-digit",
          timeZone: "Asia/Seoul",
        })} — 해안도로에 노을 가점`,
      );
    }

    return NextResponse.json({
      tempC,
      weatherCode: code,
      sunset: sunset?.toISOString() ?? null,
      adjustments,
      notes,
    });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "조건 조회 실패" },
      { status: 502 },
    );
  }
}
