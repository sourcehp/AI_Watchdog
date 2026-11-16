# AI Watchdog for macOS — 설계 (승인됨 2026-11-17)

## 목적
Windows용 AI Watchdog(PowerShell+WPF, AIWatchdog.ps1 v4)을 macOS에서 쓰기 위한 이식.
AI 프로그램이 일하는 동안 맥을 깨워 두고, 일이 끝나면 화면 끄기·절전·종료를 실행한다.
UltraCat의 "깨어 있기" 아이디어만 참고하고 코드는 쓰지 않는다.

## 목표 / 비목표
- 목표: 작은 용량(수 MB), 지금 Windows 디자인(링·칩·설정 화면) 유지, 기존 언어 JSON 형식 재사용.
- 비목표(첫 버전): 자리 비움, 매일 끄기, 쉬는 시간, 화면 잠금, 휴대폰 알림 — 2단계.
- 빠지는 기능: 프로세스별 GPU 감시, 최대 절전(macOS에서 깔끔한 방법 없음).
- 실패 조건: 앱이 죽었는데 맥이 계속 깨어 있음 → `caffeinate -w <pid>`로 방지.

## 접근 방법
| 방식 | 용량 | 비고 |
|---|---|---|
| Electron | ~150MB | 용량 때문에 제외 |
| Tauri | ~10MB | 맥에 Rust 툴체인 필요 |
| **Swift + WKWebView (선택)** | ~1–3MB | Xcode Command Line Tools만 필요 |

사용자가 Swift + WKWebView를 선택.

## 구조
- `Sources/main.swift` 하나: 메뉴바 아이콘(NSStatusItem) + 창(NSPanel 안 WKWebView), 1초 타이머, 네이티브 측정·동작, JS 브리지.
- `Resources/ui/index.html` 하나(CSS·JS 포함): 화면과 판단 로직. Swift는 1초마다 측정값(JSON)을 넘기고, JS가 판정·렌더 후 필요한 동작(깨우기/절전 등)을 Swift에 요청.
- `Resources/lang/*.json`: 주어진 7개 언어 파일의 맥용 사본(Windows·트레이·최대 절전·PowerShell 문구 교체, 글꼴 제거).
- 설정: `~/Library/Application Support/AIWatchdog/settings.json`, 작업 기록 `sessions.csv`.
- `build.sh`: swiftc로 arm64+x86_64 유니버설 빌드, .app 번들 조립, ad-hoc 서명.

## 맥 대응
- 깨우기: `/usr/bin/caffeinate -i [-d] -w <pid>` 자식 프로세스, 필요 없으면 종료.
- 절전 `pmset sleepnow`, 화면 끄기 `pmset displaysleepnow`, 종료 `osascript -e 'tell app "System Events" to shut down'`.
- 프로세스: libproc(`proc_listallpids`, `proc_pidinfo` TASKINFO/BSDINFO)로 이름·부모·CPU 시간·메모리.
- 사용자 입력 없는 시간: `CGEventSource.secondsSinceLastEventType`.
- 메모리: `host_statistics64`, 네트워크: `getifaddrs` 바이트 합.
- 로그인 시 실행: `SMAppService.mainApp` (macOS 13+).

## 빌더 재량
- 기본 감시 대상의 맥 프로세스 이름(Claude, ChatGPT, codex, Cursor, Antigravity, ollama, LM Studio, python3)은 추정값 — 사용자가 맥에서 확인 후 조정.
- 아이콘·색은 Windows 팔레트 그대로.
