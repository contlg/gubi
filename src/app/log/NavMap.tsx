"use client";

import { IconTarget } from "@/components/icons";

import { useEffect, useRef, useState } from "react";

import type { NavCam, NavManeuver } from "@/lib/navguide";
import type { LatLng } from "@/lib/types";
import { matchTrafficStates } from "@/lib/traffic-match";

/**
 * 자체 내비 실시간 지도 — 타일 캔버스 위에 경로·회전점·단속캠·현위치를
 * 그리고, 실제 내비처럼 진행방향이 위를 보게 회전(헤딩업)한다.
 * rAF로 위치·방향·줌을 보간해서 1초 GPS라도 부드럽게 따라간다.
 * RouteMap과 같은 이유(도메인 등록·키 불필요)로 OSM/Esri 타일.
 */

const TILE = 256;
// 내비 지도 전용 모드 키 — 기록 지도(RouteMap)의 선택과 분리, 기본은 일반
const MODE_KEY = "drivelog-navmap-mode-v1";
const ROT_KEY = "drivelog-nav-rotate-v1";
const TILT_KEY = "drivelog-nav-3d-v1";
/** 3D(눕힌 지도) 기울기 — 카카오 3D 보기 정도 */
const TILT_DEG = 50;

type MapMode = "map" | "sat";
const MODES: Record<
  MapMode,
  { label: string; url: (z: number, x: number, y: number) => string; attr: string; bg: string }
> = {
  map: {
    label: "일반",
    url: (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`,
    attr: "© OpenStreetMap",
    bg: "#e7e5e4",
  },
  sat: {
    label: "위성",
    url: (z, x, y) =>
      `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    attr: "© Esri",
    bg: "#1c1917",
  },
};

// 실시간 소통 선 색 — 카카오 관례(1정체 빨강 – 4원활 초록), 0은 정보없음
const TRAFFIC_LINE: Record<number, string> = {
  1: "#ef4444", // 정체
  2: "#f97316", // 지체
  3: "#eab308", // 서행
  4: "#22c55e", // 원활
};
// 줌 보정 범위 — 확대는 +3(더 가까이). 축소는 -8까지 크게 열어 전체 경로·
// 넓은 지역을 볼 수 있게. z레벨이 zf 따라 낮아져 축소해도 화면당 타일 수는
// 거의 일정하므로(줌아웃해도 로딩 폭증 없음) 넓게 열어도 안전하다.
const ZMIN = -8;
const ZMAX = 4;

const mercX = (lng: number) => (lng + 180) / 360;
const mercY = (lat: number) => {
  const r = (lat * Math.PI) / 180;
  return (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
};

// 타일 캐시 — 컴포넌트 리마운트에도 유지되게 모듈 스코프.
// 값: 이미지 | "loading" | 실패시각(number, 재시도 백오프용)
const tileCache = new Map<string, HTMLImageElement | "loading" | number>();
const FAIL_RETRY_MS = 8000; // 실패 타일은 이 시간 뒤 재시도 (영구 회색 방지)
function getTile(mode: MapMode, z: number, x: number, y: number, onload: () => void) {
  const key = `${mode}/${z}/${x}/${y}`;
  const hit = tileCache.get(key);
  if (hit instanceof HTMLImageElement) return hit;
  if (hit === "loading") return null;
  // 실패 타일 — 백오프 안이면 아직 재시도 안 함
  if (typeof hit === "number" && performance.now() - hit < FAIL_RETRY_MS) return null;
  if (tileCache.size > 600) {
    // 오래된 것부터 절반 정리
    let n = 0;
    for (const k of tileCache.keys()) {
      tileCache.delete(k);
      if (++n >= 300) break;
    }
  }
  tileCache.set(key, "loading");
  const img = new Image();
  img.onload = () => {
    tileCache.set(key, img);
    onload();
  };
  img.onerror = () => tileCache.set(key, performance.now()); // 실패시각 기록 – 재시도
  img.src = MODES[mode].url(z, x, y);
  return null;
}

export interface NavMapProps {
  path: LatLng[];
  /** 최신 GPS 픽스 (엔진 스냅 좌표 — 차가 선 위를 탄다) */
  pos: LatLng | null;
  kmh: number;
  /** 진행방향(° 북 기준 시계) — 정지 중엔 null로 마지막 값 유지 */
  heading: number | null;
  /** 현재 스냅 세그먼트 — 지나온/남은 경로 구분 */
  alongIdx: number;
  /** 다음 회전의 경로 누적거리(m) — 교차로 통과 화살표 렌더용 */
  nextAt: number | null;
  maneuvers: NavManeuver[];
  cams: NavCam[];
  offRoute: boolean;
  /** 지나온 궤적 — 경로 안내 없이 기록만 할 때 그린다(path는 비움) */
  trace?: LatLng[];
  /** 개발자 옵션 "다른 내비 비교" — 출처별 단속카메라(공=공공, T=티맵, K=카카오)와 카카오 경로 */
  compare?: { cams: { lat: number; lng: number; src: "public" | "tmap" | "kakao"; limit: number }[]; route?: LatLng[] } | null;
  /** 실시간 소통 샘플 (state 1정체~4원활) — 남은 경로를 초록/노랑/빨강으로 */
  traffic?: { lat: number; lng: number; state: number }[];
  /** 코스 특별 구간(와인딩·해안·강변) — 출발부터 m, 교통색 위에 덧칠 */
  special?: { from: number; to: number; color: string }[];
  /** 오버레이(배너·정보바)에 안 가리게 컨트롤을 밀어넣는 여백(px) */
  insetTop?: number;
  insetBottom?: number;

  fullBleed?: boolean;
  /** 개발 서버: 지도 엔진(옛 지도 – 새 지도) 바꾸기 버튼 */
  engineToggle?: { label: string; onClick: () => void };
}

const lerpAngle = (a: number, b: number, t: number) => {
  const d = ((b - a + 540) % 360) - 180;
  return a + d * t;
};

export default function NavMap(props: NavMapProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  // localStorage lazy-init은 SSR과 어긋나면 버튼 하이라이트가 안 맞는다
  // (React는 hydration 속성 불일치를 패치 안 함) — 마운트 후 반영
  const [mode, setMode] = useState<MapMode>("map");
  const [headingUp, setHeadingUp] = useState(true);
  const [tilt, setTilt] = useState(false);
  const tiltRef = useRef(tilt);
  tiltRef.current = tilt;
  useEffect(() => {
    try {
      if (localStorage.getItem(MODE_KEY) === "sat") setMode("sat");
      if (localStorage.getItem(ROT_KEY) === "north") setHeadingUp(false);
      if (localStorage.getItem(TILT_KEY) === "1") setTilt(true);
    } catch {}
  }, []);
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const headingUpRef = useRef(headingUp);
  headingUpRef.current = headingUp;
  // 줌 보정은 순수 ref — 핀치마다 setState하면 매 프레임 리렌더로 랙이 걸린다.
  // 그리기 루프가 ref를 읽으므로 값만 바꾸고 forceRef로 리드로만 깨운다.
  const zoomNudgeRef = useRef(0);
  // 손가락 조작 — 드래그 이동(pan)·핀치 줌·두손가락 회전·따라가기 해제
  const panRef = useRef({ x: 0, y: 0 });
  // 두 손가락 수동 회전(rad) — 헤딩업/북고정 위에 덮어쓴다. recenter로 해제.
  const rotRef = useRef(0);
  const manualRotRef = useRef(false); // 수동 회전 중이면 자동 헤딩업 무시
  const drawnRotRef = useRef(0); // 매 프레임 실제 적용 회전 — 제스처 시작값 씨앗
  const forceRef = useRef(false); // 조작 중 정지 프레임에도 리드로 강제
  const interactRef = useRef(0); // 마지막 조작 시각 — 조작 중엔 고프레임·빠른 줌
  const [following, setFollowing] = useState(true);
  const followingRef = useRef(following);
  followingRef.current = following;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let raf = 0;
    let last = 0;
    // 보간 상태 — 목표(props)로 서서히 따라간다
    const anim = { lat: 0, lng: 0, heading: 0, zf: 16.4, init: false };
    // 픽스 사이 추측 항법 — 마지막 픽스에서 지금 속도·방향으로 굴린 자리를 목표로 삼는다.
    // 예전엔 픽스마다 목표가 1초치(시속 97이면 27m) 확 바뀌어 빨리 갔다 느려지길 반복해
    // 가까이서 보면 뚝뚝 끊겼다(카카오는 일정 속도로 미끄러진다).
    const fix = { lat: NaN, lng: NaN, at: 0 };
    let lastFrame = 0;
    // 경로 파생물(누적거리·데시메이션 간격) — path 교체 시에만 재계산
    const cache = {
      path: null as LatLng[] | null,
      cum: [] as number[],
      step: 1,
      lastPrefetch: 0,
      traffic: null as NavMapProps["traffic"] | null,
      tstate: null as Int8Array | null, // 경로 점별 소통상태(0=정보없음)
    };

    let tileArrived = false;
    let lastPropsKey = "";
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const P = propsRef.current;
      // 정지 중엔 프레임을 낮춰 배터리를 아낀다 (신호 대기). 단 손가락 조작
      // 중(최근 0.5s)엔 정차라도 30fps로 — 핀치·드래그가 뚝뚝 끊기지 않게.
      const interacting = now - interactRef.current < 500;
      // 달리는 중엔 매 프레임(60fps) — 30fps로는 가까이서 화살표가 계단처럼 움직였다
      if (now - last < (P.kmh < 3 && !interacting ? 100 : 12)) return;
      last = now;
      const fixPos = P.pos ?? P.path[0];
      if (!fixPos) return;
      if (fixPos.lat !== fix.lat || fixPos.lng !== fix.lng) {
        fix.lat = fixPos.lat;
        fix.lng = fixPos.lng;
        fix.at = now;
      }
      let target = fixPos;
      if (P.pos && P.kmh >= 3 && P.heading !== null) {
        // 최대 1.5초까지만 굴린다(GPS가 끊기면 거기서 멈춤)
        const d = (P.kmh / 3.6) * Math.min(1.5, (now - fix.at) / 1000);
        const hr = (P.heading * Math.PI) / 180;
        target = {
          lat: fix.lat + (d * Math.cos(hr)) / 111_320,
          lng: fix.lng + (d * Math.sin(hr)) / (111_320 * Math.cos((fix.lat * Math.PI) / 180)),
        };
      }
      // 프레임 간격과 무관하게 같은 빠르기로 따라가도록 시간 기반 계수
      const fdt = lastFrame ? Math.min(0.1, (now - lastFrame) / 1000) : 0.033;
      lastFrame = now;
      const follow = (tau: number) => 1 - Math.exp(-fdt / tau);
      // 화면(지도 상자) 크기 W·H와 차 앵커 A(화면 y)
      const box = canvas.parentElement;
      const W = box?.clientWidth ?? canvas.clientWidth;
      const H = box?.clientHeight ?? canvas.clientHeight;
      if (W === 0 || H === 0) return;
      const insTop = P.insetTop ?? 0;
      const insBottom = P.insetBottom ?? 0;
      const visH = Math.max(1, H - insTop - insBottom);
      const A = insTop + visH * (headingUpRef.current ? 0.68 : 0.5);
      // 3D: 캔버스를 차 앵커를 축으로 원근 기울인다(CSS). 기울이면 먼 쪽이 줄어들어 화면 위·옆이
      // 비니, 화면을 꽉 채우도록 캔버스를 위·옆으로 키워 그린다(앵커 위 dTop, 아래 dBot, 폭 wf배).
      let w = W, h = H, anchorY = A, css = "";
      if (tiltRef.current) {
        const th = (TILT_DEG * Math.PI) / 180, c = Math.cos(th), sn = Math.sin(th);
        const pp = Math.max(1.3 * H, (A * sn) / c + 200); // 원근 거리 — 지평선이 화면 위로 안 오게
        const dTop = Math.min((A * pp) / (pp * c - A * sn), 4 * H);
        const dBot = ((H - A) * pp) / (pp * c + (H - A) * sn);
        const wf = (pp + dTop * sn) / pp;
        w = Math.round(W * wf);
        h = Math.round(dTop + dBot);
        anchorY = dTop;
        css = `left:${Math.round((W - w) / 2)}px;top:${Math.round(A - dTop)}px;width:${w}px;height:${h}px;transform-origin:${w / 2}px ${dTop}px;transform:perspective(${Math.round(pp)}px) rotateX(${TILT_DEG}deg)`;
      }
      if (canvas.dataset.css !== css) {
        canvas.dataset.css = css;
        canvas.style.cssText = css ? `position:absolute;${css}` : "";
      }
      if (!anim.init) {
        anim.init = true;
        anim.lat = target.lat;
        anim.lng = target.lng;
        anim.heading = P.heading ?? 0;
      }
      // 속도 연동 줌 — 빠를수록 넓게
      // 110km/h 넘으면 300km/h까지 1.5단계 더 넓게
      const v0 = Math.max(P.kmh, 0);
      const zTarget =
        16.6 - (Math.min(v0, 110) / 110) * 1.5 - (Math.min(Math.max(v0 - 110, 0), 190) / 190) * 1.5 + zoomNudgeRef.current;
      // 아무것도 안 변했으면 그리기 자체를 건너뛴다 (정차 중 배터리)
      const dHead =
        P.heading === null
          ? 0
          : Math.abs(((P.heading - anim.heading + 540) % 360) - 180);
      const settled =
        Math.abs(target.lat - anim.lat) < 1e-7 &&
        Math.abs(target.lng - anim.lng) < 1e-7 &&
        Math.abs(zTarget - anim.zf) < 0.005 &&
        dHead < 0.3;
      const propsKey = `${P.alongIdx}|${P.nextAt}|${P.offRoute}|${modeRef.current}|${headingUpRef.current}|${P.path.length}|${w}x${h}|${P.compare?.cams.length ?? -1},${P.compare?.route?.length ?? -1}`;
      if (settled && !tileArrived && !forceRef.current && propsKey === lastPropsKey)
        return;
      lastPropsKey = propsKey;
      tileArrived = false;
      forceRef.current = false;

      // 달리는 중엔 차 속도만큼 스스로 굴러가고, GPS와의 차이는 0.6초에 걸쳐 메운다 —
      // 목표를 쫓기만 하면 늘 3m 뒤처지고 픽스마다 순간 속도가 출렁였다(NavMapGL과 같은 방식, 시뮬 측정)
      if (P.pos && P.kmh >= 3 && P.heading !== null) {
        const d = (P.kmh / 3.6) * fdt;
        const hr = (anim.heading * Math.PI) / 180;
        anim.lat += (d * Math.cos(hr)) / 111_320;
        anim.lng += (d * Math.sin(hr)) / (111_320 * Math.cos((anim.lat * Math.PI) / 180));
        anim.lat += (target.lat - anim.lat) * follow(0.6);
        anim.lng += (target.lng - anim.lng) * follow(0.6);
      } else {
        anim.lat += (target.lat - anim.lat) * follow(0.15);
        anim.lng += (target.lng - anim.lng) * follow(0.15);
      }
      if (P.heading !== null) anim.heading = lerpAngle(anim.heading, P.heading, follow(0.3));
      // 핀치 중엔 손가락을 바짝 따라가고, 평소 속도연동 줌은 부드럽게
      anim.zf += (zTarget - anim.zf) * follow(interacting ? 0.07 : 0.4);
      // 3D는 캔버스가 3배쯤 커져서 해상도를 조금 낮춰 프레임을 지킨다
      const dpr = Math.min(window.devicePixelRatio || 1, tiltRef.current ? 1.5 : 2);
      // 너비·높이 둘 다 확인 — 모바일 주소창 접힘 등 "세로만" 바뀔 때도 백킹
      // 스토어를 갱신해야 지도가 세로로 왜곡되지 않는다(너비만 보면 놓침).
      const tw = Math.round(w * dpr);
      const th = Math.round(h * dpr);
      if (canvas.width !== tw || canvas.height !== th) {
        canvas.width = tw;
        canvas.height = th;
      }
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      const m = modeRef.current;
      ctx.fillStyle = MODES[m].bg;
      ctx.fillRect(0, 0, w, h);

      const zf = anim.zf;
      const z = Math.max(3, Math.min(18, Math.round(zf)));
      const ts = TILE * 2 ** (zf - z); // 화면상 타일 한 변
      const scale = 2 ** zf * TILE; // 세계 픽셀 스케일
      const cx = mercX(anim.lng) * scale;
      const cy = mercY(anim.lat) * scale;
      // 드래그 이동(pan)은 화면 좌표로 앵커를 옮긴다 — 회전 전에 적용해
      // 손가락 방향 그대로 지도가 딸려온다. 현위치 셰브런도 같이 밀린다.
      const ax = w / 2 + panRef.current.x;
      // 현위치(차) 화면 앵커 — 하단 정보바(insetBottom)·상단 배너(insetTop)에
      // 가려지지 않게 '보이는' 지도 영역 기준으로 둔다. 전체 h 기준이면 차가
      // 정보바 뒤로 내려가 너무 낮게 보이고 전방 시야가 좁았다. 헤딩업은 보이는
      // 영역의 아래쪽(0.68, 위 2/3가 전방), 북고정은 중앙(0.5).
      const ay = anchorY + panRef.current.y;
      // 수동 회전 중이면 그 각도, 아니면 헤딩업(-heading)·북고정(0)
      const rot = manualRotRef.current
        ? rotRef.current
        : headingUpRef.current
          ? (-anim.heading * Math.PI) / 180
          : 0;
      drawnRotRef.current = rot; // 제스처 시작 씨앗용

      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(rot);

      // 회전해도 다 덮이게 반경으로 타일 범위 산정
      const r = Math.max(Math.hypot(w, h) * 0.72, Math.hypot(w / 2, Math.max(ay, h - ay)) * 1.05);
      const dirty = () => {
        tileArrived = true;
        last = 0; // 타일 도착 – 다음 프레임 강제 리드로
      };
      // zz 줌 타일로 (cx,cy) 둘레 반경 rad를 깐다 — 가까운 타일부터 요청(먼저 받게)
      const drawTiles = (zz: number, rad: number) => {
        const tsz = TILE * 2 ** (zf - zz);
        const sc = 2 ** zf * TILE;
        const ccx = mercX(anim.lng) * sc, ccy = mercY(anim.lat) * sc;
        const t0x = Math.floor((ccx - rad) / tsz), t1x = Math.floor((ccx + rad) / tsz);
        const t0y = Math.floor((ccy - rad) / tsz), t1y = Math.floor((ccy + rad) / tsz);
        const nz = 2 ** zz;
        const list: [number, number, number][] = [];
        for (let tx = t0x; tx <= t1x; tx++)
          for (let ty = t0y; ty <= t1y; ty++) {
            if (ty < 0 || ty >= nz) continue;
            const ex = (tx + 0.5) * tsz - ccx, ey = (ty + 0.5) * tsz - ccy;
            list.push([ex * ex + ey * ey, tx, ty]);
          }
        list.sort((p, q) => p[0] - q[0]);
        for (const [, tx, ty] of list) {
          const dx = tx * tsz - ccx;
          const dy = ty * tsz - ccy;
          const wrapX = ((tx % nz) + nz) % nz;
          const img = getTile(m, zz, wrapX, ty, dirty);
          if (img) {
            ctx.drawImage(img, dx, dy, tsz + 0.6, tsz + 0.6);
            continue;
          }
          // 목표 타일이 아직 없으면 상위(저해상) 타일의 해당 부분을 늘려 임시로
          // 깐다 — 회색 대신 흐릿한 지도가 보이고, 진짜 타일이 오면 위에 덮인다.
          for (let dz = 1; dz <= 4; dz++) {
            const pz = zz - dz;
            if (pz < 3) break;
            const f = 2 ** dz;
            const npz = 2 ** pz;
            const ptx = Math.floor(tx / f);
            const pty = Math.floor(ty / f);
            if (pty < 0 || pty >= npz) continue;
            const pwx = ((ptx % npz) + npz) % npz;
            const pimg = getTile(m, pz, pwx, pty, dirty);
            if (pimg) {
              const sub = TILE / f; // 부모 타일에서 이 타일이 차지하는 한 변(px)
              const sx = (((tx % f) + f) % f) * sub;
              const sy = (((ty % f) + f) % f) * sub;
              ctx.drawImage(pimg, sx, sy, sub, sub, dx, dy, tsz + 0.6, tsz + 0.6);
              break;
            }
          }
        }
      };
      if (tiltRef.current && z > 4) {
        // 3D: 먼 곳은 작게 보이니 한 단계 낮은 타일로 전체를, 차 둘레만 제 해상도로 위에 덮는다
        // (타일 수 절반쯤 — 지도 서버 부담·로딩 시간)
        drawTiles(z - 1, r);
        drawTiles(z, Math.min(r, H * 0.9));
      } else {
        drawTiles(z, r);
      }

      // 경로 파생물 — path가 바뀔 때만 재계산 (재탐색 포함)
      if (cache.path !== P.path) {
        cache.path = P.path;
        cache.cum = [0];
        for (let i = 1; i < P.path.length; i++) {
          const kxm = 111_320 * Math.cos((P.path[i].lat * Math.PI) / 180);
          cache.cum.push(
            cache.cum[i - 1] +
              Math.hypot(
                (P.path[i].lat - P.path[i - 1].lat) * 111_320,
                (P.path[i].lng - P.path[i - 1].lng) * kxm,
              ),
          );
        }
        // 긴 코스는 원거리 구간을 성기게 그린다 (근처는 항상 원본 해상도)
        cache.step = P.path.length > 2600 ? Math.ceil(P.path.length / 2000) : 1;
        cache.traffic = null; // path 교체 – 소통 재매칭
      }
      // 소통 샘플 – 경로 점별 상태 매칭 (path·traffic 바뀔 때만, 매 프레임 X)
      if (cache.traffic !== P.traffic) {
        cache.traffic = P.traffic;
        cache.tstate = matchTrafficStates(P.path, P.traffic);
      }

      // 경로 — 지나온 구간은 흐리게, 남은 구간은 선명하게
      const px = (p: LatLng) => mercX(p.lng) * scale - cx;
      const py = (p: LatLng) => mercY(p.lat) * scale - cy;

      // 기록 모드 궤적 — 경로 안내(path)가 없을 때 지나온 길을 초록으로 그린다
      const tr = P.trace;
      if (tr && tr.length > 1) {
        const stride = tr.length > 1500 ? Math.ceil(tr.length / 1200) : 1;
        for (const [color, width] of [
          ["rgba(0,0,0,0.5)", 7],
          ["#34d399", 4],
        ] as const) {
          ctx.beginPath();
          ctx.moveTo(px(tr[0]), py(tr[0]));
          for (let i = stride; i < tr.length; i += stride) ctx.lineTo(px(tr[i]), py(tr[i]));
          ctx.lineTo(px(tr[tr.length - 1]), py(tr[tr.length - 1]));
          // 마지막 픽스에서 끝나면 차보다 뒤처져 매초 툭 늘어난다 — 지금 그리는 차 위치까지 잇는다
          ctx.lineTo(px(anim), py(anim));
          ctx.strokeStyle = color;
          ctx.lineWidth = width;
          ctx.lineJoin = "round";
          ctx.lineCap = "round";
          ctx.stroke();
        }
      }

      // 비교용 카카오 경로 — 보라 점선(우리 경로 아래)
      const cr = P.compare?.route;
      if (cr && cr.length > 1) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(px(cr[0]), py(cr[0]));
        for (let i = 1; i < cr.length; i++) ctx.lineTo(px(cr[i]), py(cr[i]));
        ctx.setLineDash([10, 8]);
        ctx.strokeStyle = "#c026d3";
        ctx.lineWidth = 5;
        ctx.lineJoin = "round";
        ctx.stroke();
        ctx.restore();
      }

      // head/tail: 경로 점 앞·뒤에 덧붙일 점(차 위치) — 선을 차에서 딱 끊는다
      const drawIdx = (
        i0: number,
        i1: number,
        color: string,
        width: number,
        step: number,
        head?: LatLng,
        tail?: LatLng,
      ) => {
        if (i1 < i0 || (i1 === i0 && !head && !tail)) return;
        ctx.beginPath();
        if (head) {
          ctx.moveTo(px(head), py(head));
          ctx.lineTo(px(P.path[i0]), py(P.path[i0]));
        } else ctx.moveTo(px(P.path[i0]), py(P.path[i0]));
        for (let i = i0 + step; i < i1; i += step)
          ctx.lineTo(px(P.path[i]), py(P.path[i]));
        ctx.lineTo(px(P.path[i1]), py(P.path[i1]));
        if (tail) ctx.lineTo(px(tail), py(tail));
        ctx.strokeStyle = color;
        ctx.lineWidth = width;
        ctx.lineJoin = "round";
        ctx.lineCap = "round";
        ctx.stroke();
      };
      const n = P.path.length;
      const cut = Math.min(P.alongIdx + 1, n - 1);
      const nearEnd = Math.min(cut + 900, n - 1);
      const remainColor = P.offRoute ? "#f59e0b" : "#38bdf8";
      // 지나온/남은 경계 = 지금 그리는 차 위치를 현재 구간에 내린 점. 예전엔 경로 점(고속도로는
      // 수백 m 간격)에서 갈라 선이 한 구간씩 툭툭 줄었다.
      let carOn: LatLng | undefined;
      if (n >= 2 && P.alongIdx >= 0 && P.alongIdx < n - 1 && !P.offRoute) {
        const a = P.path[P.alongIdx], b = P.path[P.alongIdx + 1];
        const kx = Math.cos((a.lat * Math.PI) / 180);
        const bx = (b.lng - a.lng) * kx, by = b.lat - a.lat;
        const ox = (anim.lng - a.lng) * kx, oy = anim.lat - a.lat;
        const L = bx * bx + by * by;
        const t = L > 0 ? Math.max(0, Math.min(1, (ox * bx + oy * by) / L)) : 0;
        carOn = { lat: a.lat + by * t, lng: a.lng + (b.lng - a.lng) * t };
      }
      drawIdx(0, n - 1, "rgba(0,0,0,0.5)", 9, cache.step);
      if (carOn) drawIdx(0, P.alongIdx, "rgba(148,163,184,0.85)", 5.5, cache.step, undefined, carOn);
      else drawIdx(0, cut, "rgba(148,163,184,0.85)", 5.5, cache.step);
      drawIdx(nearEnd, n - 1, remainColor, 5.5, cache.step);
      // 남은 근거리 구간 — 소통 정보가 있으면 초록/노랑/빨강으로 색칠,
      // 경로 이탈 중엔 경로가 틀렸을 수 있어 색칠 없이 경고색으로만.
      const start0 = cut > 0 ? cut - 1 : 0;
      const ts0 = cache.tstate;
      if (ts0 && !P.offRoute) {
        let i = start0;
        while (i < nearEnd) {
          const col = TRAFFIC_LINE[ts0[i]] ?? remainColor;
          let j = i + 1;
          while (j < nearEnd && (TRAFFIC_LINE[ts0[j]] ?? remainColor) === col) j++;
          // 첫 조각은 차 위치에서 시작
          if (carOn && i === start0) drawIdx(cut, Math.max(cut, j), col, 6, 1, carOn);
          else drawIdx(i, j, col, 6, 1);
          i = j;
        }
      } else if (carOn) {
        drawIdx(cut, nearEnd, remainColor, 5.5, 1, carOn);
      } else {
        drawIdx(start0, nearEnd, remainColor, 5.5, 1);
      }

      // 다음 회전 통과 화살표 — 3km 안일 때만 (실내비의 흰 꺾임 화살표)
      if (P.nextAt !== null && cache.cum.length === n) {
        const along = cache.cum[Math.min(P.alongIdx, n - 1)];
        if (P.nextAt - along < 3000) {
          let i0 = Math.max(0, cut - 3);
          while (i0 < n - 1 && cache.cum[i0] < P.nextAt - 45) i0++;
          let i1 = i0;
          while (i1 < n - 1 && cache.cum[i1] < P.nextAt + 55) i1++;
          if (i1 > i0) {
            for (const [color, width] of [
              ["#0369a1", 10],
              ["#ffffff", 6],
            ] as const) {
              drawIdx(i0, i1, color, width, 1);
            }
            // 화살촉
            const a = P.path[Math.max(i0, i1 - 1)];
            const b = P.path[i1];
            const dir = Math.atan2(py(b) - py(a), px(b) - px(a));
            ctx.save();
            ctx.translate(px(b), py(b));
            ctx.rotate(dir);
            ctx.beginPath();
            ctx.moveTo(13, 0);
            ctx.lineTo(-4, -8.5);
            ctx.lineTo(-4, 8.5);
            ctx.closePath();
            ctx.fillStyle = "#ffffff";
            ctx.fill();
            ctx.strokeStyle = "#0369a1";
            ctx.lineWidth = 2;
            ctx.stroke();
            ctx.restore();
          }
        }
      }

      // 전방 타일 프리페치 — 900m 앞 타일을 미리 받아 셀룰러에서도 안 끊기게
      if (now - cache.lastPrefetch > 2500 && cache.cum.length === n) {
        cache.lastPrefetch = now;
        const along = cache.cum[Math.min(P.alongIdx, n - 1)];
        let j = cut;
        const cap = Math.min(cut + 2000, n - 1);
        while (j < cap && cache.cum[j] < along + 900) j++;
        const ahead = P.path[j];
        const atx = Math.floor((mercX(ahead.lng) * scale) / ts);
        const aty = Math.floor((mercY(ahead.lat) * scale) / ts);
        for (let dx2 = -1; dx2 <= 1; dx2++) {
          for (let dy2 = -1; dy2 <= 1; dy2++) {
            const ty2 = aty + dy2;
            if (ty2 < 0 || ty2 >= 2 ** z) continue;
            const wx = (((atx + dx2) % 2 ** z) + 2 ** z) % 2 ** z;
            getTile(m, z, wx, ty2, dirty);
          }
        }
      }

      // 회전점·단속캠 (화면 근처만)
      const near = (x: number, y: number) => Math.hypot(x, y) < r;
      for (const mv of P.maneuvers) {
        if (mv.type === "arrive") continue;
        const x = px(mv);
        const y = py(mv);
        if (!near(x, y)) continue;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fillStyle = "#fff";
        ctx.fill();
        ctx.strokeStyle = "#0284c7";
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
      ctx.font = "14px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      for (const c of P.cams) {
        const x = px(c);
        const y = py(c);
        if (!near(x, y)) continue;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(-rot); // 지도 회전과 관계없이 표시는 수평으로 유지한다.
        ctx.fillStyle = "#f4f4f5";
        ctx.fillRect(-9, -9, 18, 18);
        ctx.fillStyle = "#18181b";
        ctx.fillText("단", 0, 0);
        ctx.restore();
      }
      // 비교용 출처별 카메라 — 같은 장비면 세 글자가 모여 보이고, 빠진 출처가 바로 보인다
      if (P.compare?.cams.length) {
        const style = {
          public: { dx: -9, dy: -7, fill: "#71717a", t: "공" },
          tmap: { dx: 9, dy: -7, fill: "#dc2626", t: "T" },
          kakao: { dx: 0, dy: 8, fill: "#ca8a04", t: "K" },
        } as const;
        ctx.font = "bold 10px sans-serif";
        for (const c of P.compare.cams) {
          const x = px(c);
          const y = py(c);
          if (!near(x, y)) continue;
          const st = style[c.src];
          ctx.save();
          ctx.translate(x, y);
          ctx.rotate(-rot);
          ctx.beginPath();
          ctx.arc(st.dx, st.dy, 8, 0, Math.PI * 2);
          ctx.fillStyle = st.fill;
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 1.5;
          ctx.stroke();
          ctx.fillStyle = "#fff";
          ctx.fillText(st.t, st.dx, st.dy + 0.5);
          ctx.restore();
        }
        ctx.font = "14px sans-serif";
      }
      // 도착점
      const end = P.path[P.path.length - 1];
      if (end) {
        const x = px(end);
        const y = py(end);
        if (near(x, y)) {
          ctx.beginPath();
          ctx.arc(x, y, 6, 0, Math.PI * 2);
          ctx.fillStyle = "#ef4444";
          ctx.fill();
          ctx.strokeStyle = "#fff";
          ctx.lineWidth = 2.5;
          ctx.stroke();
        }
      }
      ctx.restore();

      // 현위치 셰브런 — 지도 회전(rot) 위에 실제 진행방향으로 돌린다.
      // 헤딩업(rot=-heading)이면 0=위, 북고정이면 heading, 수동회전이면 그만큼 더.
      ctx.save();
      ctx.translate(ax, ay);
      // 3D에선 눕힌 만큼 세로로 늘려 화살표가 납작해 보이지 않게
      if (tiltRef.current) ctx.scale(1, 1 / Math.cos((TILT_DEG * Math.PI) / 180));
      ctx.rotate((anim.heading * Math.PI) / 180 + rot);
      ctx.beginPath();
      ctx.moveTo(0, -13);
      ctx.lineTo(9.5, 9);
      ctx.lineTo(0, 4);
      ctx.lineTo(-9.5, 9);
      ctx.closePath();
      ctx.fillStyle = P.offRoute ? "#f59e0b" : "#22d3ee";
      ctx.fill();
      ctx.strokeStyle = "#0c4a6e";
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();

      // 나침반 (헤딩업일 때 북쪽 표시)
      ctx.save();
      ctx.translate(26, 26);
      ctx.beginPath();
      ctx.arc(0, 0, 13, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(12,10,9,0.55)";
      ctx.fill();
      ctx.rotate(rot);
      ctx.fillStyle = "#f87171";
      ctx.font = "bold 11px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("N", 0, -3.5);
      ctx.fillStyle = "#e7e5e4";
      ctx.beginPath();
      ctx.moveTo(0, 3);
      ctx.lineTo(3, 8);
      ctx.lineTo(-3, 8);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      ctx.font = "9px sans-serif";
      ctx.fillStyle = m === "sat" ? "rgba(255,255,255,0.55)" : "rgba(50,50,50,0.65)";
      ctx.textAlign = "right";
      ctx.textBaseline = "alphabetic";
      // 출처 표기는 화면 오른쪽 아래(3D면 그 자리에 해당하는 캔버스 위치)
      ctx.fillText(MODES[m].attr, (w + W) / 2 - 4, anchorY + (H - A) - 4);
    };

    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, []);

  // 손가락 조작 — 한 손가락 드래그로 이동, 두 손가락 핀치로 줌.
  // 드래그하면 따라가기가 풀려 "현재위치" 버튼이 뜬다.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let mode: "none" | "pan" | "pinch" = "none";
    let lx = 0,
      ly = 0,
      baseDist = 0,
      baseZoom = 0,
      baseAngle = 0, // 두 손가락 시작 각도(rad)
      baseRot = 0; // 제스처 시작 시점의 지도 회전
    const dist2 = (t: TouchList) => {
      const dx = t[0].clientX - t[1].clientX;
      const dy = t[0].clientY - t[1].clientY;
      return Math.hypot(dx, dy);
    };
    const angle2 = (t: TouchList) =>
      Math.atan2(t[1].clientY - t[0].clientY, t[1].clientX - t[0].clientX);
    const onStart = (e: TouchEvent) => {
      interactRef.current = performance.now();
      if (e.touches.length >= 2) {
        mode = "pinch";
        baseDist = dist2(e.touches);
        baseZoom = zoomNudgeRef.current;
        baseAngle = angle2(e.touches);
        baseRot = drawnRotRef.current; // 현재 화면 회전에서 이어서 돌린다(튐 방지)
      } else if (e.touches.length === 1) {
        mode = "pan";
        lx = e.touches[0].clientX;
        ly = e.touches[0].clientY;
      }
    };
    const onMove = (e: TouchEvent) => {
      interactRef.current = performance.now();
      if (mode === "pinch" && e.touches.length >= 2) {
        e.preventDefault();
        const d = dist2(e.touches);
        if (baseDist > 0) {
          // ref만 바꾸고 리드로만 깨운다 — setState 없이 매끄럽게
          zoomNudgeRef.current = Math.min(
            ZMAX,
            Math.max(ZMIN, baseZoom + Math.log2(d / baseDist)),
          );
        }
        // 두 손가락 비틀기 — 각도 변화를 지도 회전에 반영. 순수 확대/축소가
        // 회전을 건드리지 않게 임계(약 7°) 넘어야 수동 회전에 진입한다.
        let dAng = angle2(e.touches) - baseAngle;
        dAng = ((dAng + Math.PI) % (2 * Math.PI)) - Math.PI; // [-π,π] 정규화
        if (!manualRotRef.current && Math.abs(dAng) > 0.12) {
          manualRotRef.current = true;
          if (followingRef.current) setFollowing(false);
        }
        if (manualRotRef.current) rotRef.current = baseRot + dAng;
        forceRef.current = true;
      } else if (mode === "pan" && e.touches.length === 1) {
        e.preventDefault();
        const t = e.touches[0];
        panRef.current.x += t.clientX - lx;
        panRef.current.y += t.clientY - ly;
        lx = t.clientX;
        ly = t.clientY;
        forceRef.current = true;
        if (followingRef.current) setFollowing(false);
      }
    };
    const onEnd = (e: TouchEvent) => {
      if (e.touches.length === 0) mode = "none";
      else if (e.touches.length === 1) {
        mode = "pan";
        lx = e.touches[0].clientX;
        ly = e.touches[0].clientY;
      }
    };
    canvas.addEventListener("touchstart", onStart, { passive: false });
    canvas.addEventListener("touchmove", onMove, { passive: false });
    canvas.addEventListener("touchend", onEnd);
    canvas.addEventListener("touchcancel", onEnd);
    return () => {
      canvas.removeEventListener("touchstart", onStart);
      canvas.removeEventListener("touchmove", onMove);
      canvas.removeEventListener("touchend", onEnd);
      canvas.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  const recenter = () => {
    panRef.current = { x: 0, y: 0 };
    zoomNudgeRef.current = 0;
    rotRef.current = 0;
    manualRotRef.current = false; // 수동 회전 해제 – 헤딩업/북고정 복귀
    interactRef.current = performance.now();
    forceRef.current = true;
    setFollowing(true);
  };
  const nudgeZoom = (d: number) => {
    zoomNudgeRef.current = Math.min(ZMAX, Math.max(ZMIN, zoomNudgeRef.current + d));
    interactRef.current = performance.now();
    forceRef.current = true;
  };

  const btn = "rounded-md px-3 py-3 text-[11px] font-semibold";
  return (
    <div
      className={`relative h-full w-full overflow-hidden ${props.fullBleed ? "" : "rounded-md"}`}
    >
      <canvas ref={canvasRef} className="h-full w-full bg-panel" />
      <div
        className="absolute right-2 flex gap-1"
        style={{ top: 8 + (props.insetTop ?? 0) }}
      >
        {(Object.keys(MODES) as MapMode[]).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => {
              setMode(m);
              try {
                localStorage.setItem(MODE_KEY, m);
              } catch {}
            }}
            className={`${btn} ${mode === m ? "bg-accent text-primary" : "bg-bg text-secondary"}`}
          >
            {MODES[m].label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            // 토글은 수동 회전을 해제하고 헤딩업/북고정을 다시 적용
            manualRotRef.current = false;
            rotRef.current = 0;
            forceRef.current = true;
            setHeadingUp((v) => {
              try {
                localStorage.setItem(ROT_KEY, v ? "north" : "heading");
              } catch {}
              return !v;
            });
          }}
          className={`${btn} bg-bg text-secondary`}
        >
          {headingUp ? "회전" : "북쪽 고정"}
        </button>
        <button
          type="button"
          onClick={() => {
            forceRef.current = true;
            setTilt((v) => {
              try {
                localStorage.setItem(TILT_KEY, v ? "0" : "1");
              } catch {}
              return !v;
            });
          }}
          className={`${btn} ${tilt ? "bg-accent text-primary" : "bg-bg text-secondary"}`}
        >
          3D
        </button>
      </div>
      <div
        className="absolute right-2 flex flex-col gap-1"
        style={{ bottom: 8 + (props.insetBottom ?? 0) }}
      >
        {props.engineToggle && (
          <button type="button" onClick={props.engineToggle.onClick} className={`${btn} mb-1 bg-bg text-secondary`}>
            {props.engineToggle.label}
          </button>
        )}
        {!following && (
          <button
            type="button"
            onClick={recenter}
            className="mb-1 flex h-12 w-12 items-center justify-center rounded-sm border border-line bg-accent text-lg text-primary"
            aria-label="현재 위치로"
          >
            <IconTarget />
          </button>
        )}
        <button
          type="button"
          aria-label="확대"
          onClick={() => nudgeZoom(0.5)}
          className="h-12 w-12 rounded-md border border-line bg-bg text-base font-bold text-primary"
        >
          +
        </button>
        <button
          type="button"
          aria-label="축소"
          onClick={() => nudgeZoom(-0.5)}
          className="h-12 w-12 rounded-md border border-line bg-bg text-base font-bold text-primary"
        >
          −
        </button>
      </div>
    </div>
  );
}
