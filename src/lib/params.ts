import {
  AVOID_OPTIONS,
  COAST_INTENSITIES,
  DRIVE_STYLES,
  WAYPOINT_TYPES,
  type AvoidOption,
  type CoastIntensity,
  type DriveStyle,
  type LatLng,
  type WaypointType,
} from "@/lib/types";

/** "해안도로,강변도로" 형태의 드라이브 종류 파싱 (허용 목록 외 값은 무시) */
export function parseDriveStyles(value: string | null): DriveStyle[] {
  if (!value) return [];
  return value
    .split(",")
    .filter((v): v is DriveStyle =>
      (DRIVE_STYLES as readonly string[]).includes(v),
    );
}

export function parseCoord(value: string | null): LatLng | null {
  if (!value) return null;
  const [lng, lat] = value.split(",").map(Number);
  if (
    !Number.isFinite(lng) ||
    !Number.isFinite(lat) ||
    lng < -180 ||
    lng > 180 ||
    lat < -90 ||
    lat > 90
  )
    return null;
  return { lat, lng };
}

/** "toll,motorway" 형태의 회피 옵션 파싱 (허용 목록 외 값은 무시) */
export function parseAvoid(value: string | null): AvoidOption[] {
  if (!value) return [];
  return value
    .split(",")
    .filter((v): v is AvoidOption =>
      (AVOID_OPTIONS as readonly string[]).includes(v),
    );
}

/** 해안도로 우회 강도 파싱 (허용 목록 외 값이면 기본 medium) */
export function parseCoastIntensity(value: string | null): CoastIntensity {
  return (COAST_INTENSITIES as readonly string[]).includes(value ?? "")
    ? (value as CoastIntensity)
    : "medium";
}

/** "전망대,카페" 형태의 경유지 종류 파싱 (허용 목록 외 값은 무시) */
export function parseWaypointTypes(value: string | null): WaypointType[] {
  if (!value) return [];
  return value
    .split(",")
    .filter((v): v is WaypointType =>
      (WAYPOINT_TYPES as readonly string[]).includes(v),
    );
}
