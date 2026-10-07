# Windows 전용 경량 브라우저 호스트 검토

2026-10-07, 브리지 작업 세션 01a1119c. 범위는 교체 구조 검토이며, 새 브라우저를 구현하거나 운영 설치한 결과는 아니다.

전용 Win32 호스트에 시스템 WebView2를 붙이는 구조가 우선 후보다. 런처의 메뉴·탭·설정은 네이티브 UI로 표시하고, 웹 콘텐츠에만 WebView2를 사용한다. Electron과 WebView2를 동시에 상주시켜 두 웹 엔진을 유지하는 구성은 비교 후보에서 제외한다. 웹 엔진을 자체 구현하는 경우에는 HTML/CSS/JavaScript, 네트워크, 인증, GPU 합성까지 ChatGPT와 호환되어야 하므로 전용 호스트 개발과 별개의 큰 범위다.

## 확인한 설치 환경과 현재 비용

- 현재 PC: .NET 10 및 WebView2 Evergreen 155.0.4283.39 설치 확인.
- 현재 Electron 실행 파일의 프로세스 7개를 한 번 조회한 값: private bytes 합계 약 852.2 MiB, working set 합계 약 1,086 MiB. 탭 수가 바뀌는 활성 작업 중 스냅샷이며, 공유 메모리를 포함하는 working set 합계는 고유 물리 RAM 사용량이 아니다. 콘텐츠·GPU·Node helper를 포함하므로 이 수치를 호스트 교체 절감량으로 사용할 수 없다.
- 기존 런처는 Electron 메인 프로세스, React UI 렌더러, ChatGPT WebContentsView, `ELECTRON_RUN_AS_NODE` helper를 사용한다. ChatGPT의 DOM/JS 비용은 호스트를 바꾸어도 남는다.
- WebView2는 Chromium 기반 CDP를 지원한다. 여러 탭에 동일 환경을 사용하고, 같은 사용자 데이터 폴더 안에서 계정별 profile을 분리할 수 있다. 실제 절감률은 아직 측정하지 않았다.

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
