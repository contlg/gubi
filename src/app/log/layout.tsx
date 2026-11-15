import type { Metadata, Viewport } from "next";

import { withBasePath } from "@/lib/borrow-mode";

/**
 * Gubi — 주행 기록 대시보드. 코스 추천과 같은 Next 앱이지만
 * 독립 페이지(사실상 별도 웹앱): drivelog.homesev.duckdns.org 가 Caddy에서
 * 이 경로로 리라이트된다. PWA로 홈화면 설치하면 앱처럼 뜬다.
 */
export const metadata: Metadata = {
  title: "Gubi",
  description: "주행 속도·거리·최고속도 기록",
  manifest: withBasePath("/log-manifest.json"),
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Gubi",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // 저시력 사용자가 확대할 수 있게 확대 허용(접근성) — 강제 금지 해제
  maximumScale: 5,
  userScalable: true,
  themeColor: "#0c0a09",
};

export default function LogLayout({ children }: { children: React.ReactNode }) {
  return children;
}
