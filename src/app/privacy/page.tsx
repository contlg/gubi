import type { Metadata } from "next";
import { BORROW_SERVER, withBasePath } from "@/lib/borrow-mode";

export const metadata: Metadata = {
  title: "개인정보처리방침 · Gubi",
};

/**
 * 개인정보처리방침 — 구글 로그인(OAuth) 앱 게시에 필요한 공개 페이지.
 * 실제 저장 방식(auth-session·drive-records·raw-log·oauth-links)과 맞춰 쓴다.
 */
export default function PrivacyPage() {
  if (BORROW_SERVER) return <CarPrivacy />;
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-[15px] leading-relaxed text-primary dark:text-primary">
      <a href={withBasePath("/log")} className="mb-6 inline-block text-[15px] text-secondary">
        ← 돌아가기
      </a>
      <h1 className="mb-1 text-2xl font-bold">개인정보처리방침</h1>
      <p className="mb-8 text-sm text-secondary">Gubi · 시행일 2026년 10월 6일</p>

      <h2 className="mt-6 mb-2 text-lg font-semibold">1. 모으는 정보</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          계정: 아이디·비밀번호로 가입하면 기기에서 바꾼 해시(되돌릴 수 없는 값)만 받습니다.
          카카오·구글로 로그인하면 그 서비스의 고유 번호와 표시 이름을 받습니다. 구글 이메일은
          이름이 없을 때 화면 표시용으로만 씁니다.
        </li>
        <li>
          주행 기록: 기록을 켠 동안의 위치 경로, 속도, 거리, 시간, 출발·도착 주소, 이동수단.
        </li>
        <li>
          센서 기록(사용자가 켠 경우에만): 휴대폰 가속도·회전 센서 값과 GPS 원본. 터널 속도 보정
          등 기능 개선에 씁니다.
        </li>
        <li>코스 추천에 입력한 출발지·목적지와 검색 조건(이 기기에만 저장).</li>
      </ul>

      <h2 className="mt-6 mb-2 text-lg font-semibold">2. 쓰는 곳</h2>
      <p>
        주행 기록 저장·조회, 내비게이션 안내, 코스 추천, 로그인 유지에만 씁니다. 광고나 판매에
        쓰지 않고, 제3자에게 넘기지 않습니다.
      </p>

      <h2 className="mt-6 mb-2 text-lg font-semibold">3. 외부로 보내는 정보</h2>
      <p>
        길찾기·장소·유가 정보를 받기 위해 좌표나 경로를 카카오, Google Places, 오피넷,
        국가교통정보센터에 보냅니다. 이때 계정 정보는 보내지 않습니다.
      </p>

      <h2 className="mt-6 mb-2 text-lg font-semibold">4. 보관과 삭제</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>정보는 운영자가 관리하는 서버 한 대에 저장됩니다.</li>
        <li>로그인 유지 기간은 30일입니다.</li>
        <li>
          앱의 프로필 – 계정 삭제를 누르면 계정, 모든 주행 기록, 센서 기록, 연결된 소셜 계정
          정보가 바로 지워지고 모든 기기에서 로그아웃됩니다.
        </li>
      </ul>

      <h2 className="mt-6 mb-2 text-lg font-semibold">5. 문의</h2>
      <p>
        개인정보 관련 문의는 앱 운영자에게 연락해 주세요. 문의 주소는 구글 로그인 화면의 개발자
        정보에 표시됩니다.
      </p>
    </main>
  );
}

/**
 * 차량 출시용(빌려 쓰기 모드) 처리방침 — 로그인·서버 기록 저장이 없는 실제 동작에 맞춘다.
 * 근거: borrow-mode.ts(로컬 사용자·사용자 데이터 API 차단), secure-store.ts(기기 암호화 — 주행 기록·주행 스냅샷·
 * 최근 목적지·즐겨찾기·검색 기록·출발 대기 코스, history.ts·log/page.tsx·page.tsx),
 * log/page.tsx(saveRecord 빌려 쓰기 분기·updateAddr·refreshFreeDrive·nav-route·regions),
 * pleos-feed.ts(PleosVehicle), RoadviewStrip·kakao-sdk(카카오 지도·로드뷰).
 */
function CarPrivacy() {
  const h2 = "mt-6 mb-2 text-lg font-semibold";
  return (
    <main className="mx-auto max-w-2xl px-5 py-10 text-[15px] leading-relaxed text-primary dark:text-primary">
      <a href={withBasePath("/log")} className="mb-6 inline-block text-[15px] text-secondary">
        ← 돌아가기
      </a>
      <h1 className="mb-1 text-2xl font-bold">개인정보처리방침</h1>
      <p className="mb-8 text-sm text-secondary">Gubi 차량 앱 · 시행일 2026년 11월 13일</p>

      <h2 className={h2}>1. 계정</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>가입·로그인이 없습니다. 이름·이메일·전화번호를 받지 않습니다.</li>
        <li>처음 실행할 때 이 기기 안에서만 쓰는 무작위 번호를 만듭니다. 서버로 보내지 않습니다.</li>
      </ul>

      <h2 className={h2}>2. 모으는 정보</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>주행 중 위치와 지나온 경로, 속도, 가속·감속·좌우 G(쏠림).</li>
        <li>주행 요약: 거리, 시간, 최고·평균 속도, 출발·도착 주소, 코스 이름.</li>
        <li>
          차에서 읽는 정보: 배터리 잔량·용량, 기어, 크루즈 설정 속도, 누적 주행거리, 핸들 각도·브레이크.
          이 기기 안에서 화면 표시와 도착 배터리 계산에만 쓰고 밖으로 보내지 않습니다.
        </li>
        <li>최근 목적지·즐겨찾기·코스 검색 조건(이 기기에만 저장).</li>
      </ul>

      <h2 className={h2}>3. 보관 장소</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          주행 기록, 주행 중 이어 가기용 경로, 최근 목적지·즐겨찾기, 코스 검색 기록, 출발을 기다리는
          코스는 이 기기에만 저장하고, 기기 안 열쇠로 암호화합니다(AES-GCM). 열쇠는 기기 밖으로 꺼낼
          수 없습니다.
        </li>
        <li>
          예외: 주행 중 앱 화면이 닫히는 순간에는 주행 경로를 잃지 않게 잠깐 암호화 없이 저장했다가,
          바로 또는 다음 실행 때 다시 암호화합니다. 기기가 암호화를 지원하지 않으면 암호화 없이 저장합니다.
        </li>
        <li>
          앱이 꺼진 채 끝난 주행은 차 앱 안에 잠시 두었다가 다음 실행 때 기록 보관함으로 옮기고
          지웁니다.
        </li>
        <li>주행 중 안내를 이어 가려고 잠시 둔 경로는 주행을 마치면 지웁니다.</li>
      </ul>

      <h2 className={h2}>4. 외부로 보내는 정보</h2>
      <p className="mb-2">
        모두 https로 보냅니다. 무작위 번호·주행 기록·차 정보는 함께 보내지 않습니다.
      </p>
      <ul className="list-disc space-y-1 pl-5">
        <li>
          계산 서버: 코스 추천·장소 검색·길찾기를 할 때 출발·도착·경유 좌표와 검색어를 보냅니다. 이
          앱이 안내하는 동안에는 경로 다시 찾기와 교통 정보에 현재 위치와 경로를, 제한속도·단속카메라
          확인에 현재 위치와 진행 방향을 보냅니다. 주행 중에는 화면 주소 표시를 위해 현재 위치를
          10~30초마다, 대기 화면에서는 국내·해외 판단을 위해 한 번 보냅니다. 지난 기록을 열면 지나온
          시·군·구 표시를 위해 그 경로를 보냅니다. Gubi는 보낸 좌표를 저장하지 않습니다.
        </li>
        <li>
          계산 서버는 받은 좌표로 카카오, Google Places, 오피넷, 국가교통정보센터에 길·장소·교통
          정보를 묻습니다.
        </li>
        <li>
          지도·로드뷰: 카카오, OpenStreetMap·OpenFreeMap, Esri(위성)에서 화면에 보이는 지역의 지도
          조각과 로드뷰 사진을 받습니다. 이때 그 지역 위치와 기기의 인터넷 주소가 각 회사에 전달됩니다.
        </li>
        <li>
          현대 내비 연결: &lsquo;현대 내비로 안내&rsquo;를 고르면 코스 경로와 경유지를 차량 SDK로 차
          내비에 넘깁니다.
        </li>
      </ul>

      <h2 className={h2}>5. 보관 기간과 삭제</h2>
      <ul className="list-disc space-y-1 pl-5">
        <li>주행 기록은 직접 지울 때까지 이 기기에 남습니다. 기록 화면에서 하나씩 지울 수 있습니다.</li>
        <li>최근 검색은 코스 추천 화면의 &lsquo;전체 지우기&rsquo;로 지울 수 있습니다.</li>
        <li>앱을 지우거나 차량 설정에서 앱 데이터를 지우면 이 기기의 정보가 모두 지워집니다.</li>
        <li>
          &lsquo;기록 백업&rsquo;으로 만든 파일은 암호화되지 않은 사용자 본인의 파일입니다. 보관과 삭제는
          직접 관리해 주세요.
        </li>
      </ul>

      <h2 className={h2}>6. 문의</h2>
      <p>개인정보 관련 문의는 앱 마켓의 개발자 정보에 표시된 연락처로 해 주세요.</p>
    </main>
  );
}
