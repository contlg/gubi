import type { NextConfig } from "next";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const revisionHash = createHash("sha256").update(readFileSync("next.config.ts"));
function hashSources(directory: string) {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) hashSources(file);
    else if (entry.isFile()) revisionHash.update(file).update("\0").update(readFileSync(file)).update("\0");
  }
}
hashSources("src");
const webRevision = revisionHash.digest("hex").slice(0, 16);

const nextConfig: NextConfig = {
  devIndicators: false,
  env: { NEXT_PUBLIC_WEB_REVISION: webRevision },
  // [현대 Pleos 복사본] 에뮬레이터(10.0.2.2)에서 개발 서버 접속 허용
  allowedDevOrigins: ["10.0.2.2", "127.0.0.1", "fundrive.homesev.duckdns.org"],
  // 실행 중인 서버의 .next를 빌드가 덮으면 HTML은 옛 chunk 이름, 디스크는 새
  // chunk가 되어 화면이 하얗게 된다. 배포 검증은 NEXT_DIST_DIR=.next-stage로
  // 별도 생성한 뒤 서버를 멈춘 짧은 순간에만 교체한다.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  experimental: {
    // proxy가 Route Handler보다 먼저 body를 복제한다. 앱의 2MB 거부선을 넘긴
    // chunked 요청도 메모리에서 무한히 커지지 않도록 복제 자체를 3MB로 막는다.
    proxyClientMaxBodySize: "3mb",
  },
  // HTML 문서(플래너 /, fundrive /log)는 항상 재검증하게 한다.
  // 기본 프리렌더는 Cache-Control: s-maxage=1년이 붙어 폰 브라우저가 옛 화면을
  // 오래 붙잡는다("배포했는데 변화가 안 보임"의 원인). max-age=0+must-revalidate로
  // 매 요청 ETag 재검증 → 바뀌면 즉시 새 화면, 그대로면 304(가벼움).
  // 해시된 정적 자산(_next/static)은 별도 immutable 캐시라 영향 없음.
  async headers() {
    const revalidate = [
      { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
    ];
    return [
      { source: "/", headers: revalidate },
      { source: "/log", headers: revalidate },
    ];
  },
};

export default nextConfig;
