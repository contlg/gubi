"use client";

import { useEffect, useState } from "react";
import { IconAlert } from "@/components/icons";
import CourseDetailInfo from "@/components/CourseDetailInfo";
import { arrivalText, courseEstimate, PLEOS_LABELS, requestPleosTrip, tripTarget, usePleosFeed, type PleosTrip } from "@/lib/pleos-feed";
import type { LatLng, RouteCandidate } from "@/lib/types";

export function PleosSafetyCard() {
  const { available, connected, feed } = usePleosFeed();
  if (!available || !connected) return null;
  // 제목·제한속도·'알림 없음'·주의지점은 빼고(사용자 요청) 앞 단속카메라와 도착 배터리만 보인다.
  const camera = feed?.cameras[0];
  const arrival = arrivalText(feed?.arrivalWh, feed?.vehicle.capacityWh, feed?.chargeStop);
  if (!camera && !arrival) return null;
  return <section aria-label="현대 전방 단속·도착 예상" className="rounded-md border border-line bg-panel px-4 py-3 text-primary">
    {camera && <p className={`font-semibold ${camera.overSpeed || camera.overSectionAvg ? "text-danger" : ""}`}>
      {PLEOS_LABELS[camera.type] ?? "단속카메라"} {Math.round(camera.remainM)}m (제한 {camera.limit ?? "정보 없음"})
      {(camera.overSpeed || camera.overSectionAvg) && " (과속 중)"}
    </p>}
    {arrival?.stop && <p className={`${camera ? "mt-2 " : ""}text-warn`}>{arrival.stop}</p>}
    {arrival && <p className={`${camera || arrival.stop ? "mt-2 " : ""}${arrival.shortage ? "text-danger" : "text-ok"}`}>
      {arrival.shortage && <IconAlert size={16} className="mr-1 inline-block h-4 w-4 align-text-bottom" />}
      {arrival.text}
    </p>}
  </section>;
}
const value = (v: number | string | null | undefined, suffix = "") => v == null ? "정보 없음" : `${typeof v === "number" ? Math.round(v * 10) / 10 : v}${suffix}`;
const gearName = (gear: string | null | undefined) => gear == null ? null : ({ GEAR_PARK: "P", GEAR_REVERSE: "R", GEAR_NEUTRAL: "N", GEAR_DRIVE: "D" }[gear] ?? gear.replace("GEAR_", ""));
export function PleosVehicleCard() {
  const { supported, feed, chargerOperators } = usePleosFeed();
  if (!supported) return null;
  const v = feed?.vehicle;
  return <details className="rounded-md border border-line bg-panel p-4 text-primary">
    <summary className="cursor-pointer truncate font-semibold">현대 차량 상태{v ? <> (배터리 {value(v.socPct, "%")})</> : " (확인 중)"}</summary>
    <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {[
        ["배터리 용량", value(v?.capacityWh == null ? null : v.capacityWh / 1000, " kWh")],
        ["크루즈 설정", value(v?.cruiseKmh, " km/h")], ["주행거리", value(v?.odometerKm, " km")],
      ].map(([label, text]) => <div key={label}><dt className="text-secondary">{label}</dt><dd>{text}</dd></div>)}
    </dl>
    <details className="mt-3 text-sm">
      <summary className="cursor-pointer">충전 사업자 {chargerOperators?.total ?? feed?.chargerOperatorCount ?? 0}곳</summary>
      <ul className="mt-2 space-y-1 text-secondary">
        {chargerOperators?.items.map((operator, index) => <li key={`${operator.id}-${index}`}>{operator.name}</li>)}
      </ul>
      {chargerOperators?.truncated && <p className="mt-2 text-secondary">일부 사업자만 표시해요</p>}
    </details>
  </details>;
}
function useCourseTrip(candidate: RouteCandidate, from: LatLng, destination: LatLng | null) {
  const { available, feed } = usePleosFeed();
  const target = available ? tripTarget(candidate.path, from, destination) : null;
  const key = available ? JSON.stringify([candidate.label, candidate.path, target]) : "";
  const [result, setResult] = useState<{ key: string; trip: PleosTrip } | null>(null);
  useEffect(() => {
    if (!available || !target) return;
    let active = true;
    requestPleosTrip(key, target, candidate.label).then((trip) => { if (active) setResult({ key, trip }); });
    return () => { active = false; };
  // key includes the full path and target; label is presentation only.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, key]);
  const trip = result?.key === key ? result.trip : null;
  const estimate = trip ? courseEstimate(trip, candidate.distanceM, feed?.vehicle) : null;
  return { available, target, trip, estimate };
}

export function PleosCourseBattery({ candidate, from, destination }: { candidate: RouteCandidate; from: LatLng; destination: LatLng | null }) {
  const { estimate } = useCourseTrip(candidate, from, destination);
  const text = estimate ? `약 ${Math.round(estimate.socPct)}%` : "정보 없음";
  return <CourseDetailInfo label={`도착 시 배터리 ${text}`} value={<span className="text-xl font-semibold tabular-nums">{text}</span>}>
    선택 코스 전체 거리 기준 추정치예요. 현대 빠른 길의 거리당 소모량과 현재 배터리 잔량·용량으로 계산해요.
    {estimate ? ` 소모 약 ${estimate.kWh.toFixed(1)} kWh.` : " 차량 정보나 경로 예상값이 없으면 계산할 수 없어요."}
  </CourseDetailInfo>;
}

export function PleosCourseEstimate({ candidate, from, destination, compact = false }: { candidate: RouteCandidate; from: LatLng; destination: LatLng | null; compact?: boolean }) {
  const { available, target, trip, estimate } = useCourseTrip(candidate, from, destination);
  if (!available) return null;
  let text = "배터리 정보 없음";
  let color = "text-secondary";
  if (target == null || (trip && !estimate)) {
    text = "배터리 정보 없음";
    color = "text-secondary";
  } else if (!trip) {
    text = "배터리 계산 중";
    color = "text-secondary";
  } else if (estimate) {
    const low = estimate.socPct < 15;
    text = `도착 시 배터리 ${Math.round(estimate.socPct)}%${low ? " (충전 필요)" : ""}`;
    color = low ? "text-danger" : "text-ok";
  }
  if (compact) {
    return <p className={`mt-1 text-xs ${color} [word-break:keep-all]`}>{text}</p>;
  }
  return <p className={`mt-3 text-xs leading-relaxed ${color}`}>{text}</p>;
}
