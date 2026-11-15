# 굽이 (GUBI)

> 굽이 — 드라이브 코스 추천 앱

목적지가 없다면 운전할 시간과 원하는 길(와인딩·산길·해안도로·강변도로)만으로 출발지로 돌아오는 코스를, 목적지가 있다면 빠른 길 대신 바닷길·굽잇길을 거쳐 가는 경로를 추천합니다. 고른 코스는 Pleos Connect 순정 내비게이션으로 이어서 안내하고, 주행이 끝나면 차량에서 기록한 핸들·브레이크 데이터로 주행을 돌아볼 수 있습니다.

---

## 시연 영상

[`video/굽이-시연영상.mp4`](video/굽이-시연영상.mp4) (약 29초, 1920×1080) — 조건 선택 → 코스 추천 → 와인딩·강변·해안 코스 비교 → 바닷길 주행 안내 화면. 주행 장면은 위치 시뮬레이션 화면입니다.

---

## 1. APK 위치

| 항목 | 내용 |
|---|---|
| APK 파일 | [`apk/소풍나온수송대대_굽이_release.apk`](apk/소풍나온수송대대_굽이_release.apk) |
| 빌드 종류 | `prod` (release 용도, `debuggable false`) |
| 패키지 이름 | `dev.homesev.drivelog.pleos` |
| 버전 | 1.9.1 (versionCode 11) |

## 2. 테스트 환경

| 항목 | 내용 |
|---|---|
| Pleos Connect 에뮬레이터 | Pleos Connect **v2.1.0** ARM64 시스템 이미지 (Android API 34) |
| 화면 규격 | **2560 × 1440** (Pleos Connect v2.1.0 차량 프로필), RAM 4GB |
| 개발 PC | macOS (Apple Silicon), Android SDK command-line tools |
| 최소 / 대상 Android 버전 | minSdk 28 / targetSdk 34 (compileSdk 34) |
| 빌드 도구 | Android Gradle Plugin 8.8.2, Gradle 8.10 이상, Java 17 |

## 3. 실행 방법

### APK로 바로 실행

1. Android SDK의 AVD Manager에서 Pleos Connect v2.1.0 시스템 이미지로 에뮬레이터를 만들고 실행합니다.
2. APK를 설치합니다.
   ```bash
   adb install -r apk/소풍나온수송대대_굽이_release.apk
   ```
3. 앱 목록에서 **Gubi**를 실행하고, 위치 권한을 허용합니다.
4. 순환형/목적지형을 고르고 시간·길 종류를 선택한 뒤 **코스 추천** → 코스 선택 → **이 코스로 주행**을 누르면 순정 내비게이션 안내가 시작됩니다.

### 필요한 설정

- **인터넷 연결:** 코스 계산과 화면은 배포된 굽이 웹 서버에서 불러옵니다. 에뮬레이터가 인터넷에 연결되어 있어야 합니다.
- **위치:** 에뮬레이터의 Extended Controls → Location에서 출발 위치를 지정하거나 GPS 경로를 재생합니다.
- **차량 데이터:** 속도·배터리·주행거리·조향각 등은 Pleos 에뮬레이터의 Virtual Console(차량 데이터 시뮬레이션)로 바꿔 볼 수 있습니다.

### 소스에서 빌드

```bash
# 1) 웹(코스 추천 화면·API)
npm install
cp .env.example .env.local      # 카카오 API 키 등 값 입력
npx next dev -p 1016            # 시험 빌드는 10.0.2.2:1016/log 를 불러옵니다

# 2) Android 앱
cd android
gradle assembleCarTest          # 로컬 웹 서버에 연결하는 시험 빌드
gradle assembleProd             # 배포 서버에 연결하는 release 용도 빌드
```

Pleos SDK는 `android/settings.gradle`에 등록된 Pleos Playground 저장소(`nexus-playground.pleos.ai`)에서 받습니다.

---

## 4. 주요 기능

| 기능 | 설명 |
|---|---|
| 순환형 코스 추천 | 최대 운전시간, 길 종류(와인딩·산길·해안도로·강변도로·직선도로), 들를 곳(전망대·해변·카페 등)으로 출발지에 돌아오는 코스 추천 |
| 목적지형 코스 추천 | 빠른 길 대신 해안도로·굽잇길을 거쳐 가는 경로 추천, 해안도로 우회 정도(살짝·보통·최대) 선택 |
| 세부 조건 | 고속도로·유료도로 제외, 신호 적은 길, 터널 기피, 멀미 배려, 예산 |
| 순정 내비게이션 안내 | 코스의 주요 지점을 순정 내비게이션에 전달하고 통과할 때마다 다음 지점으로 교체 |
| 도착 배터리 예측 | 전기차의 배터리 잔량·용량과 내비게이션의 에너지 소모량으로 코스별 도착 시 배터리 계산 |
| 주행 기록 | 주행 후 핸들 각도·브레이크 사용을 시간별 그래프와 브레이크 횟수로 표시 |
| 주행 중 화면 제한 | 차량의 주행 제한 상태에 따라 설정 화면 잠금, 정차 시 해제 |

## 5. Pleos SDK 활용

| SDK | 용도 | 주요 파일 |
|---|---|---|
| NaviHelper 3.0.5 | `requestRouteWithWaypoints`로 코스 경유지 전달, `requestTrip`으로 거리·시간·에너지 소모량 조회, 경유지 도착·경로 변경·회전 안내 수신 | `android/java/dev/homesev/drivelog/pleos/PleosCourseGuide.java`, `RollingRouteSession.java`, `PleosTripDispatcher.java` |
| FusedLocation 1.1.3 | 차량 위치 수신, 다음 경유지 주변 영역 진입·이탈로 통과 판단 | `pleos/PleosLocationFeed.java`, `pleos/PleosProximity.java` |
| Vehicle 2.3.2 | 속도·배터리 잔량/용량·주행거리·기어·조향각·브레이크 수신 | `pleos/PleosVehicleFeed.java`, `pleos/VehicleTrace.java` |
| CarUxRestrictions (Android Car) | 주행 중 조작 제한 상태에 따른 화면 잠금 | `android/java/dev/homesev/drivelog/UxGate.java` |

개인정보 보호를 위해 차대번호는 기록하지 않고, 문·창문·공조 등 굽이에 필요 없는 차량 정보는 받지 않습니다(`pleos/PleosFeedModel.java`, `pleos/CarIdentity.java`).

## 6. 구현 현황

| 구분 | 내용 |
|---|---|
| 에뮬레이터에서 동작 확인 | 순정 내비게이션 코스 전달, 경유지 자동 교체, 차량 속도·배터리·주행거리 수신, 주행 중 화면 잠금 |
| 구현 완료(검증 진행 중) | 조향각·브레이크 주행 기록 그래프, 코스별 도착 배터리 계산 |
| 향후 계획 | 커브별 주행 분석·부드러운 운전 점수, 실제 주행 데이터 기반 추천 개선, 순정 내비게이션 경로 전체 전달(SDK 확장 시) |

## 7. 프로젝트 구조

```
android/            Pleos Connect용 Android 앱 (WebView + Pleos SDK 연결)
  java/.../pleos/   NaviHelper·FusedLocation·Vehicle SDK 연동 코드
src/app/            코스 추천 화면과 API (Next.js)
src/lib/            코스 계산·점수화·도로 정보 처리
apk/                제출용 APK
```
