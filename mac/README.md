# AI Watchdog for macOS

AI 프로그램이 일하는 동안 Mac을 깨워 두고, 일이 끝나면 화면 끄기·절전·종료를 합니다.
메뉴 막대에 사는 작은 앱입니다(약 1MB 안팎).

## 설치 (바로 쓰기)

1. [최신 버전 내려받기](https://github.com/sourcehp/AI_Watchdog/releases/latest/download/AI-Watchdog-mac.dmg) (`AI-Watchdog-mac.dmg`)
2. DMG를 열고 **AI Watchdog**를 **Applications** 폴더로 끌어다 놓습니다.
3. 응용 프로그램에서 AI Watchdog를 엽니다. 처음엔 "확인되지 않은 개발자" 경고가 나올 수 있어요.
   그러면 **시스템 설정 → 개인정보 보호 및 보안** 아래쪽의 **"그래도 열기"**를 한 번 누르면, 다음부터는 바로 열립니다.

## 직접 만들기 (개발용)


1. 터미널에서 개발 도구 설치 (이미 있으면 건너뜀):
   ```
   xcode-select --install
   ```
2. 이 폴더로 가서 빌드:
   ```
   cd ~/Downloads/aiwatchdog-mac
   chmod +x build.sh
   ./build.sh
   ```
3. 만들어진 `build/AI Watchdog.app`을 `/Applications` 폴더로 옮깁니다.
4. 나눠 줄 DMG가 필요하면 `./make-dmg.sh` → `build/AI-Watchdog-mac.dmg` (앱 아이콘이 붙은 DMG)

`mac/` 아래를 고쳐 main 브랜치에 올리면 GitHub Actions가 자동으로 빌드해 Releases에 새 버전을 올립니다.

## 처음 실행할 때 나올 수 있는 허용 창

- **알림**: 작업이 끝났다는 알림을 보내려면 허용하세요.
- **System Events 제어**: "AI가 끝나면 → 종료"를 처음 실행할 때 뜹니다. 허용해야 Mac을 끌 수 있어요.
  실수로 거절했다면 시스템 설정 → 개인정보 보호 및 보안 → 자동화에서 켜세요.

## 쓰는 법

- 메뉴 막대의 고리 아이콘을 누르면 창이 열립니다. 우클릭하면 짧은 메뉴(1시간 깨워 두기, 종료)가 나옵니다.
- 아이콘 색: 회색 = 쉬는 중/꺼짐, 주황 = AI 작업 중(깨워 두는 중), 파랑 = 끝나고 기다리는 중, 빨강 = 곧 절전·종료.
- **지켜보는 프로그램 → 관리**에서 감시할 앱을 켜고 끕니다. 목록에 없는 앱은 "실행 중인 프로그램에서 추가"로 넣습니다.

### 프로세스 이름 확인 (목록의 앱이 "꺼짐"으로만 보일 때)
기본 목록의 이름(claude, chatgpt, codex, cursor, antigravity, ollama, lm studio, python3)은 일반적인 이름입니다.
앱이 켜져 있는데 "꺼짐"으로 보이면 터미널에서 실제 이름을 확인하세요:
```
ps -axco command | sort -u | grep -i 이름일부
```
그다음 "실행 중인 프로그램에서 추가"로 그 이름을 추가하면 됩니다.
`Claude Helper (Renderer)` 같은 보조 프로세스는 자동으로 본 앱에 합산됩니다.

## 시스템 · 팬 · 토큰 탭
- **시스템**: CPU(사용자·시스템·온도), GPU, 메모리, 저장 공간, 배터리(성능 최대치·충전 횟수·전력), 네트워크.
- **팬**: 팬 속도와 CPU·GPU·배터리 온도. 자동 / 고정 / 온도 따라(커브) 중에 골라 **적용**합니다.
  처음 한 번 관리자 암호로 작은 **팬 도우미**를 설치해야 바꿀 수 있어요(보기만은 설치 없이 됨).
  AI Watchdog가 꺼지거나 멈추면 15초 안에 팬은 자동으로 돌아갑니다. 도우미는 설정 → 팬 도우미 지우기로 지웁니다.
- **토큰**: 이 Mac의 Claude Code 기록(`~/.claude/projects`)을 세어 총 토큰, API 정가로 친 금액, 날짜별 히트맵, 모델별 사용량을 보여 줍니다.
  구독 요금과는 다른 "API로 썼다면" 금액이에요.

## 파일 위치
- 설정: `~/Library/Application Support/AIWatchdog/settings.json`
- 작업 기록: `~/Library/Application Support/AIWatchdog/sessions.csv`
- 문제 기록: `~/Library/Application Support/AIWatchdog/debug.log` (화면 오류, 팬 도우미 설치 결과)
- 팬 도우미: `/Library/PrivilegedHelperTools/com.nik.aiwatchdog.fanhelper`, `/Library/LaunchDaemons/com.nik.aiwatchdog.fanhelper.plist`
- 언어 추가: `~/Library/Application Support/AIWatchdog/lang/` 에 `xx.json`을 넣고 앱을 다시 켜면 목록에 나타납니다.
  (형식은 `Resources/lang/en.json`과 같고, 빠진 문구는 영어로 표시됩니다.)

## Windows 버전과 다른 점
- 최대 절전, 프로그램별 GPU 감시는 macOS에서 지원하지 않아 뺐습니다. (전체 GPU 사용량은 보여 줍니다.)
- 자리 비움, 매일 끄기, 쉬는 시간, 화면 잠금, 휴대폰 알림은 다음 단계에서 추가합니다.
- 노트북 뚜껑을 닫으면 macOS가 강제로 잠재우므로 깨워 둘 수 없습니다 (외부 모니터·전원 연결 시 제외).

## 개발
- 판정 로직: `Resources/ui/logic.js` (테스트: `node --test test/*.test.mjs`)
- 화면: `Resources/ui/` — 브라우저 미리보기: `cd Resources && python3 -m http.server`, 그다음 `http://localhost:8000/ui/index.html?mock&lang=ko`
- Mac 측정·전원: `Sources/Probe.swift`, `Sources/Power.swift`, 창·메뉴 막대: `Sources/main.swift`
- Windows 언어 파일을 맥용으로 다시 변환: `node tools/maclang.mjs`
