# Windows 전용 경량 브라우저 호스트 검토

2026-10-07, 브리지 작업 세션 01a1119c. 사용자의 최신 순서: **WebView2 시제품과 Electron 비교 먼저, 그다음 큰 대화 처리와 실패 탭 정리**. 운영 런처는 Electron을 유지한다. 아래 결과는 격리된 DEV 시제품의 오프라인 검증이며 운영 설치 또는 기존 기능 전체의 실사용 동등성을 뜻하지 않는다.

## 실행 가능한 DEV 시제품

`launcher/native-webview2/`에 Win32 + WebView2 호스트, 기존 React 메뉴와 Bun action backend 및 오프라인 비교 도구를 구현했다. 창·트레이·WebView2 controller는 Win32가 관리하며, 메뉴 UI도 WebView2에서 표시한다. 사용자가 선택한 최종 범위는 Browser/Setup/MCP/Accounts/Activity/Limits/Settings와 기존 기능 전체다. 현재 frozen preload의 실제 API 수는 **58개**이며 이름 전체가 일치하는 것을 확인했다. 이전 기록의 59개는 정정한다.

- 브라우저 fixture: profile 격리, 소유 CDP target, lease 중 close/quit 거부, 표시 복원, controller 8회 생성·제거.
- control fixture: bearer 인증, helper 소유권 거부, heartbeat/approval/end, 유지된 문서 재사용·해제, 활성 turn 중 런처 종료 거부.
- UI fixture: 7개 메뉴의 제목과 화면 전환 완료, 58개 API 이름의 전체 일치, 설정 저장과 잘못된 설정 거부, 페이지 오류 0.
- GUI fixture 3개: 패키지 실행 파일에서 부모 stdio backend 시작, 명시적 DEV 및 기본 DEV, 격리 descriptor의 부모 PID 일치, UI를 통한 정상 종료와 backend 종료. 별도 사례에서 테스트 소유 부모 프로세스가 사라지면 backend 서버도 종료됨을 확인했다. 운영 descriptor를 쓰지 않고 bridge daemon은 시작하지 않았다.
- controller 생성 도중 종료 fixture: 대기 중인 표시·줌·focus 명령을 취소하고 실제 controller 해제를 확인.
- 총 7개 고유 사례가 통과했다. action packaging 수정 뒤 영향받는 control/UI/GUI 사례를 재검증했고, 부모 종료 처리 추가 뒤 control 및 GUI 3개 사례를 다시 확인했다. C++ Release 빌드, TypeScript 검사, 변경 CJS 문법 검사를 별도로 수행했다.

DEV profile을 backend 인자로 전달하지 않던 오류, DEV 경로를 운영 profile 비교에 넣던 오류, TypeScript 의존성의 잘못된 상대 경로, 고해상도 초기 창 크기를 수정했다. 종료 전에 UI polling을 멈추고, 해제 중인 controller에 늦게 표시 명령을 보내지 않도록 했다. 활성 turn이 있으면 종료 전에 거부하므로 lease를 삭제해서 종료 검증을 통과시키지 않는다.

기존 launcher action은 패키지 생성 시 TypeScript AST로 추출한다. 실행 시에는 frozen `main.cjs` SHA256과 일치하는 action 묶음을 읽어 동일 handler를 등록한다. 패키지 backend에는 TypeScript compiler를 싣지 않는다. 순차 GUI 측정에서 전체 private bytes는 추출 이전 644.1/648.4 MiB, 패키지 action 적용 뒤 597.1/600.8 MiB, 최종 lifecycle 검증에서 599.6/600.8 MiB였다. 각 값은 Settings까지 7개 메뉴를 열어 본 뒤의 native host+Bun+WebView2 합계이며, ChatGPT 대화와 bridge daemon은 제외했다. 전체 Electron GUI의 동일 조건 baseline은 아직 없다.

검토용 capsule은 `C:/Users/Administrator/.codex-chatgpt-web/builds/native-webview2-followup-20261007-01a1119c/prototype/`에 생성한다. `Launch-Prototype.ps1`은 capsule 아래 별도 DEV profile과 `--offline`으로 실행한다. capsule의 `prototype-package.json`에 소스 revision, 파일 해시와 외부 runtime 의존성을 기록한다. 설치된 WebView2와 명시된 R12 runtimeRoot가 필요하므로 독립적인 배포 release가 아니다. 로그인 지속성·마이그레이션, 실사용 setup/MCP/Native2 ACK, autostart, update feed와 guardian/rollback 통합은 후속 검증 범위다.

## 동일 viewport의 후속 비교

`comparison-final/comparison.json`은 725×431 CSS pixels, DPR 1, 동일 120만 자 `<pre>` 문서와 두 profile을 사용했다. 각 값은 1회 순차 측정의 프로세스 private bytes 합계이며 빈 bootstrap 탭 하나가 포함된다.

| 문서 탭 수/단계 | WebView2 전체 | 최소 Electron 전체 | WebView2 본체 | Electron 본체 |
| --- | ---: | ---: | ---: | ---: |
| 대기 | 139.1 MiB | 98.4 MiB | 3.8 MiB | 41.7 MiB |
| 1 | 334.1 MiB | 320.4 MiB | 3.7 MiB | 43.4 MiB |
| 2 | 520.2 MiB | 468.0 MiB | 3.9 MiB | 45.2 MiB |
| 4 | 870.0 MiB | 756.7 MiB | 3.9 MiB | 47.9 MiB |
| 4개 문서 탭 해제 뒤 | 191.3 MiB | 181.9 MiB | 3.9 MiB | 46.9 MiB |

WebView2 156.0.4314.8 beta와 Electron의 Chromium 146.0.7680.216으로 엔진 버전이 다르다. 각 단계의 scalar DOM 관찰 7회 중앙값은 native 0.35~0.54ms, Electron 0.34~0.50ms였다. 탭 선택 후 CDP 왕복은 native 0.50~0.59ms, Electron 0.98~1.06ms였다. native는 stdio, Electron 비교 shim은 loopback HTTP를 쓰므로 순수 엔진 선택 성능으로 해석하지 않는다. 짧은 idle CPU sample은 최대 약 0.057코어였으며 지속 부하 또는 누수 검증은 아니다.

4개 문서 해제 뒤 양쪽 controller inventory는 bootstrap만 남았다. 메모리는 크게 줄었지만 첫 대기 수준까지 돌아오지 않았고, 이 한 번의 release cycle로 메모리 누수 여부를 판정할 수 없다. 최소 host 비교에서는 메뉴 backend·bridge daemon/helper·공통 측정 harness를 제외했다. 위 GUI 전체 수치와 합치거나 운영 제품의 절감률로 환산하지 않는다. 실제 ChatGPT 페이지의 DOM, 모델/effort 선택, compaction, ACK 지연은 별도 문제다.

후속 증거는 `C:/Users/Administrator/.codex-chatgpt-web/builds/native-webview2-followup-20261007-01a1119c/`의 `build.json`, `comparison-final/`, `verification-final/`, `verification-packaged/`, `verification-lifecycle/`에 보존한다. 중간 `comparison/`은 대기 viewport가 달라 대기 비교 근거로 사용하지 않는다. 초기 실패 fixture가 남긴 오프라인 backend 4개는 실행 파일 경로와 `--offline` 신원을 확인해 정리했고, 최종 테스트 뒤 이 작업 소유 native/Bun 프로세스 잔류는 0개였다. Pro/인증된 prompt 전송은 모두 0회다.

## 이전 비교 기록

동일한 120만 자 로컬 문서와 viewport를 사용한 단일 순차 측정의 private bytes 합계는 다음과 같다. 각 행에는 문서 탭 외 빈 bootstrap 탭 하나가 포함된다.

| 문서 탭 수 | WebView2 전체 | 최소 Electron 전체 | WebView2 호스트 본체 | Electron 호스트 본체 |
| --- | ---: | ---: | ---: | ---: |
| 1 | 362.4 MiB | 342.3 MiB | 3.8 MiB | 43.3 MiB |
| 2 | 563.5 MiB | 486.8 MiB | 3.8 MiB | 44.6 MiB |
| 4 | 984.9 MiB | 774.4 MiB | 3.8 MiB | 46.5 MiB |

이전 실행은 DPR 2.5, WebView2 155.0.4283.39와 Electron 41.10.7/Chromium 146.0.7680.216이었다. 공통 Playwright 측정 harness, bridge daemon/helper와 전체 메뉴 backend는 합계에서 제외했다. 이 조건에서도 호스트 본체는 작아졌지만 전체 합계는 증가했다. 후속 실행과 엔진/DPR이 달라 전후 개선율을 계산하지 않는다.

증거는 `C:/Users/Administrator/.codex-chatgpt-web/builds/native-webview2-20261007-01a1119c/verification/` 및 `comparison-matched/comparison.json`에 보존했다. 이전 `comparison/comparison.json`은 viewport가 달라 절감 주장에 사용하지 않는다. 운영 계정/설정/descriptor는 시제품 테스트에서 변경하지 않았으며 Pro 테스트 전송은 0회다.

전용 Win32 호스트에 시스템 WebView2를 붙이는 구조를 사용했다. 현재 시제품은 기존 메뉴·설정을 React/WebView2로 재사용하며 순수 Win32 메뉴로 다시 구현하지 않았다. Electron과 WebView2를 동시에 유지하는 구조는 시제품에서 쓰지 않는다. 웹 엔진 자체 구현은 HTML/CSS/JavaScript, 네트워크, 인증, GPU 합성까지 ChatGPT와 호환되어야 하므로 전용 호스트와 별개의 범위다.

## 확인한 설치 환경과 현재 비용

- 이전 환경 조회: .NET 10 및 WebView2 Evergreen 155.0.4283.39. 후속 fixture가 실제 반환한 runtime은 156.0.4314.8 beta였다.
- 현재 Electron 실행 파일의 프로세스 7개를 한 번 조회한 값: private bytes 합계 약 852.2 MiB, working set 합계 약 1,086 MiB. 탭 수가 바뀌는 활성 작업 중 스냅샷이며, 공유 메모리를 포함하는 working set 합계는 고유 물리 RAM 사용량이 아니다. 콘텐츠·GPU·Node helper를 포함하므로 이 수치를 호스트 교체 절감량으로 사용할 수 없다.
- 기존 런처는 Electron 메인 프로세스, React UI 렌더러, ChatGPT WebContentsView, `ELECTRON_RUN_AS_NODE` helper를 사용한다. ChatGPT의 DOM/JS 비용은 호스트를 바꾸어도 남는다.
- WebView2는 Chromium 기반 CDP를 지원한다. 여러 탭에 동일 환경을 사용하고, 같은 사용자 데이터 폴더 안에서 계정별 profile을 분리할 수 있다. 위 시제품의 제한된 비교에서는 전체 메모리 절감이 확인되지 않았다.

## 교체 경계

| 기존 계약 | 새 호스트에 필요한 구현 | 현재 근거 |
| --- | --- | --- |
| descriptor v3, pid, loopback CDP/control, owned surface ID→target ID | 필드를 보존하는 호스트 descriptor, 원자적 갱신, 살아 있는 target 확인 | `src/launcher-browser-host.ts:36`, `:84`, `:230` |
| 계정별 쿠키/캐시/로그인 격리 | 공유 WebView2 환경 안의 계정별 profile, 동시 작업 소유권 | `launcher/electron/browser-host.cjs:709`, 공식 multi-profile 문서 |
| acquire/heartbeat/end 및 유지된 대화 | 현재 control 계약과 같은 turn lease, 종료/재사용 규칙 | `launcher/electron/control-server.cjs:161`, `:353` |
| stdio browser helper | 기존 helper 스크립트를 bundled Node/Bun으로 실행하는 경로 검증 | `src/adapters/chatgpt-web/launcher-helper-client.ts:333` |
| 모델/effort 선택과 Native2 도구 | 기존 Playwright worker와 capture→observe→ACK 계약 유지 | `src/adapters/chatgpt-web/browser-worker.ts:3269` |
| 트레이 복원·탭 전환 | HWND/viewport 복원, 페이지 준비 및 첫 화면 표시 확인, 작업 중 문서 유지 | `launcher/electron/browser-host.cjs:2087`, `:2181` |
| 런처 교체·복구 | 기존 guardian 준비 ACK 후 교체, complete/healthyAt 및 새 PID 증거 | `scripts/schedule-bridge-maintenance.ps1:273` |

descriptor의 helper 실행 파일 검증은 Electron 이름을 강제하지 않는다. 다만 새 실행 파일을 넣었다는 사실만으로 helper 호환성이 확인되는 것은 아니다. 기존 helper의 ready/shutdown, browser acquisition, progress forwarding, tool ACK를 별도로 실행해야 한다. 기존 Electron 로그인 저장소를 WebView2와 같은 저장소로 가정하지 않고 별도 테스트 profile에서 로그인 지속성을 검증한다.

## 최소 시제품과 비교 방법

1. 별도 개발 폴더의 네이티브 창, 1개 공유 WebView2 환경, 계정별 profile, CDP target 식별, 탭 전환 및 트레이 복원을 구현한다. 운영 descriptor와 계정 저장소를 사용하는 단계는 후속 통합이다.
2. 동일한 로컬 fixture로 대기/1탭/2탭/4탭, 32만·100만 자 대화, 모델/effort 선택, 도구 capture→observe→ACK, 창 숨김/복원/선택 탭 표시를 비교한다. 인증된 테스트 전송과 Pro 생성 없이 시작한다.
3. 프로세스 트리 전체 private bytes, CPU, 첫 화면 시간, CDP 응답시간, 유지된 대화 상태를 함께 기록한다. 엔진·콘텐츠·탭 수를 표시하고 cold/warm 실행을 구분한다. 동일 콘텐츠 대비 절감량과 기능 동등성이 나온 뒤 운영 전환 후보로 판단한다.

응답 대기 및 도구 ACK 대기 중인 탭은 활동 중이다. 사용자에게 안 보인다는 이유로 suspend/close하지 않는다. WebView2의 Low memory target, TrySuspend/Resume는 종료된 재개 가능한 탭에만 적용하는 후보이며, 성공 반환과 표시 복구를 확인해야 한다. GPU를 끄는 것은 기본 경량화 전략에 포함하지 않는다.

## 현재 흰 화면 조사와 관계

사용자는 트레이에서 연 창의 브라우저가 흰 화면이었다가 런처를 다시 열자 표시됐다고 보고했다. 실패 순간 native bounds/paint 증거가 없어 트레이 복원 결함을 확정하지 않았다. 읽기 전용 관찰에서는 정상 크기의 viewport 및, 새로 생성된 활성 탭의 `readyState=loading`, body 0을 확인했다.

별도로 8a1edb0e71bf/3612df23fd80의 첫 multipart 응답 관찰이 20초마다 실패해 탭이 반복 생성되는 기록이 있다. 실패 후 진단은 응답 그룹에 약 325,738자를 보고한다. 오류 검색의 무제한 wildcard는 325,500자 반복 문구 로컬 fixture에서 1초 내 완료되지 않았다. 이 검색을 짧은 오류 문구 범위로 제한하는 회귀 테스트를 추가했다. 이 재현은 운영의 모든 20초 오류나 트레이 흰 화면의 원인을 확정하는 증거가 아니다. 호스트 교체와 별도로 관찰 실패 경로의 검증이 필요하다.

## 공식 근거

- [WebView2 성능 지침](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/performance): 네이티브 초기 UI, 환경 공유, 메모리 API, 콘텐츠 비용, GPU 가속.
- [사용자 데이터 폴더와 profiles](https://learn.microsoft.com/en-us/microsoft-edge/webview2/concepts/user-data-folder): 같은 UDF 안의 profile 격리 및 브라우저 프로세스 공유.
- [WebView2 CDP 연결](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/devtools-mcp-server): Chromium CDP 호환과 remote-debugging port.

관련 읽기 전용 진단 및 오프라인 재현은 `scratch/bridge-tray-white-screen-20261007/`에 보존했다. 운영 런처 교체, 계정 설정 변경, Pro 테스트 전송은 이 검토에서 수행하지 않았다.
