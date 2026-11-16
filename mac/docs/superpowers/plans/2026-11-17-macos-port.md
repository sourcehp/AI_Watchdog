# AI Watchdog for macOS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 맥 메뉴바 앱(수 MB)으로 AI 프로그램 감시·깨우기·끝나면 절전/화면 끄기/종료.

**Architecture:** Swift가 측정(프로세스 CPU·입력 대기·메모리·네트워크)과 동작(caffeinate, pmset, 종료)을 맡고, WKWebView 안의 HTML/JS가 판정·화면·설정을 맡는다. 판정 로직은 DOM 없는 `logic.js`로 분리해 node로 테스트한다.

**Tech Stack:** Swift 5.9 (AppKit, WebKit, ServiceManagement), 바닐라 HTML/CSS/JS, node:test.

**Spec:** `docs/2026-11-17-macos-port-design.md`

## Global Constraints
- macOS 13 이상, 유니버설(arm64+x86_64), 외부 의존성 0.
- 깨우기: `/usr/bin/caffeinate -i [-d] -w <앱 pid>`.
- 설정 경로 `~/Library/Application Support/AIWatchdog/settings.json`, 기록 `sessions.csv`(`start,end,seconds,programs`).
- 언어 JSON 형식(code/name/order/culture/strings) 유지, 새 언어는 파일 추가만으로.
- 판정 규칙은 Windows v4와 동일: 사용량 기준 대상은 CPU ≥ cpuTh(기본 5%) 또는 하위 프로세스 CPU ≥ 1%/새 하위 프로세스면 활동, 유예 graceSec(기본 120초), 대기 idleMin(기본 10분), 절전·종료는 30초 예고 후 실행, 화면 끄기는 즉시.

## Review Focus
1. 앱이 비정상 종료 → caffeinate도 끝나야 함 (`-w` 사용, Task 3에서 확인).
2. 절전에서 깨어남 → CPU 기준선 초기화로 거짓 "작업 중" 없음 (Task 1 테스트 `resetAfterWake`).
3. 감시 대상이 안 떠 있음 → 자동 동작이 무장(armed)되지 않음 (Task 1 테스트 `notArmedWithoutWork`).
4. 사용자가 키보드를 쓰는 중 → 카운트다운 미룸 (Task 1 테스트 `userBusyDelays`).
5. 언어 파일에 키 누락 → 영어로 대체 (Task 2 테스트 `fallbackToEnglish`).

---

### Task 1: 판정 로직 (`ui/logic.js`)

**Files:** Create `Resources/ui/logic.js`, Test `test/logic.test.mjs`

**Interfaces — Produces:**
- `createState(settings) -> state`
- `ingest(state, sample, nowSec) -> void` — sample = `{procs:[{pid,ppid,name,cpuSec,mem}], userIdleSec, netBytes, memTotal, memUsed, cpuPct}`
- `step(state, nowSec) -> {hold:bool, display:bool, action: null|{kind:'screen'|'sleep'|'shutdown', delay:number}}`
- `view(state, nowSec) -> {mode:'off'|'none'|'working'|'force'|'countdown'|'pending'|'idle', ...}`
- `resetBaseline(state)`

- [ ] Step 1: 테스트 — `workingHoldsAwake`, `notArmedWithoutWork`, `countdownFiresAfterIdle` (graceSec+idleMin*60 후 sleep, delay 30), `screenActionImmediate` (delay 0), `userBusyDelays`, `childProcessCounts`, `aliveModeCounts`, `resetAfterWake`, `forceAwake`.
- [ ] Step 2: `node --test test` → FAIL.
- [ ] Step 3: 구현 (Windows `Update-Signals`/`Update-Hold`/`Update-Auto` 이식).
- [ ] Step 4: `node --test test` → PASS.

### Task 2: 맥용 언어 파일과 로더

**Files:** Create `Resources/lang/{en,ko,ja,zh,es,vi,th}.json`, `tools/maclang.mjs`, `Resources/ui/i18n.js`, Test `test/lang.test.mjs`

**Interfaces — Produces:** `makeT(langDoc, enDoc) -> (key)=>string`, `fmt(str, ...args)` ({0}, {0:0.#} 지원).

- [ ] Step 1: 테스트 — `allKeysPresent`(맥 en의 모든 키가 각 파일에), `noWindowsWords`(Windows/PowerShell/트레이/작업 표시줄/powercfg 등 없음), `fallbackToEnglish`, `fmtDecimals`.
- [ ] Step 2: FAIL 확인. Step 3: 원본 7개를 `tools/maclang.mjs`로 변환(키별 맥 문구 덮어쓰기, `font` 제거, hibernate 키 제거) + `i18n.js`. Step 4: PASS.

### Task 3: Swift 네이티브

**Files:** Create `Sources/Probe.swift`(libproc·CGEventSource·host_statistics64·getifaddrs), `Sources/Power.swift`(caffeinate 시작/정지, pmset, 종료, 로그인 항목), `Sources/App.swift`(NSStatusItem, NSPanel+WKWebView, 1초 타이머, 브리지)

**Interfaces — 브리지:**
- Swift → JS: `window.AW.tick(sampleJSON)`, `window.AW.init({langs, settings, sessions})`
- JS → Swift (`webkit.messageHandlers.aw.postMessage`): `{cmd:'hold', on, display}`, `{cmd:'act', kind}`, `{cmd:'save', settings}`, `{cmd:'log', line}`, `{cmd:'status', state}`(아이콘 색), `{cmd:'startup', on}`, `{cmd:'notify', title, body}`, `{cmd:'quit'}`, `{cmd:'procs'}`(실행 중 목록 요청)

- [ ] Step 1: 맥에서 `./build.sh` 컴파일 성공 (이 환경엔 swiftc 없음 → 사용자 맥에서 확인).

### Task 4: 화면 (`ui/index.html`, `ui/app.js`)

Windows XAML의 메인(링, 상태, 사용량, 감시 목록, "AI가 끝나면", 규칙 칩) · 감시 대상 · 설정 화면, 라이트/다크/시스템 테마. 2단계 규칙 칩은 숨김.
- [ ] Step 1: 브라우저 모의 브리지(`?mock`)로 node 없이 열어 확인, 스크린샷.

### Task 5: 빌드와 안내

**Files:** `build.sh`, `Info.plist`, `README.md`
- [ ] Step 1: `bash -n build.sh` 통과, README에 설치·첫 실행(우클릭→열기)·프로세스 이름 확인법.
