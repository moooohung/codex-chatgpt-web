# 포크의 CI와 자동 릴리스

저장소: [moooohung/codex-chatgpt-web](https://github.com/moooohung/codex-chatgpt-web).
[자동 빌드 다운로드](https://github.com/moooohung/codex-chatgpt-web/releases).

원본의 CI와 Release를 유지하며, 원본의 `85eaf7bb` 브랜치에 있던 Windows
broker probe는 현재의 오프라인 브로커·ACK·outer harness 테스트로 이식했다.
Copilot 리뷰, AI 에이전트, 유료 API 액션은 포함하지 않는다. GitHub의 표준
호스팅 러너를 사용하며 외부 서비스 키가 필요하지 않다.

원본의 `Dependabot Updates`는 GitHub가 관리하는 기능이다. 포크에서도 의존성
보안 알림과 보안 업데이트 PR 생성을 활성화했다. 자동 병합은 하지 않는다.

`main`에 푸시할 때마다 Release가 해당 SHA를 고정해 검증·빌드한다. 모든 대상이
성공하면 `v6.1.5-fork.<실행번호>.g<커밋12자리>` 형태의 프리릴리스를 게시한다.
실패한 빌드는 공개 릴리스로 승격하지 않는다. 같은 실행을 재실행하면 같은
태그를 사용한다. 수동 실행도 `main`에서 지원한다. 로컬 편집만으로 실행되지는
않으며, PR은 검증만 수행한다.

Windows x64, macOS arm64/x64, Linux arm64/x64의 앱과 런타임, 설치 스크립트,
라이선스, `checksums.txt`, `release-plan.json`을 게시한다. 모든 바이너리의
버전과 설치 스크립트는 생성한 태그와 일치한다. `release-plan.json`에 원본 SHA,
기본 버전과 생성된 버전을 보존한다. 포크 패키지의 업데이트 URL과 자산 검증은
포크 저장소에 묶는다.

자동 프리릴리스는 GitHub의 `latest` 정식 릴리스를 바꾸지 않는다. 정식 릴리스는
소스 버전과 일치하는 `v<버전>` 태그를 푸시해 게시한다. 런처의 기존 정식
업데이트 정책은 유지하므로 자동 프리릴리스는 Releases에서 직접 선택한다.

릴리스 게시만 `contents: write` 권한을 사용한다. CI와 빌드는 읽기 권한으로
실행한다. 게시 작업은 `actions: write`로 해당 실행의 중간 빌드 artifact만
삭제한다. 체크섬 검증과 공개 릴리스 게시가 성공한 뒤 삭제하며, 실패한 실행의
artifact는 1일 보존한다. 배포 파일은 Releases에 남는다.

버전 동기화는 Actions의 임시 체크아웃에서 수행하며 버전 커밋이나
추가 태그 푸시로 워크플로를 연쇄 실행하지 않는다. 앱의 로컬 설치와 guardian
재시작은 이 자동화에 포함되지 않는다.
