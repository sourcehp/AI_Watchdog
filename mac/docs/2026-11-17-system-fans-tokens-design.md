# 시스템 · 팬 · 토큰 페이지 설계 (2026-11-17)

Nik의 요청: UltraCat에 있는 팬 제어, 시스템 상세, 토큰 사용량을 AI Watchdog에 "실제로 움직이게" 넣기.
UltraCat은 아이디어만 참고 (소스 비공개·라이선스 없음 → 코드·그림·배치 복사 금지).

## 확인한 사실 (MacBookPro18,3 · M1 Pro · macOS 26.6)
- SMC 읽기는 암호 없이 됨: 팬 2개(`FNum`, `F{i}Ac/Mn/Mx/Tg/Md`, flt), 온도 키 184개(`Tp*`/`Te*` CPU, `Tg*` GPU, `TB*T` 배터리).
- SMC 쓰기는 `kIOReturnNotPrivileged` → root 필요.
- 배터리: AppleSmartBattery (`CurrentCapacity`, `CycleCount`, `Temperature`/100, `AppleRawMaxCapacity`/`DesignCapacity`, `AdapterDetails.Watts`, `PowerTelemetryData.SystemPowerIn`/`SystemLoad`/`BatteryPower` mW).
- GPU 메모리: IOAccelerator `PerformanceStatistics["In use system memory"]`.
- 토큰: `~/.claude/projects/**/*.jsonl` (1,165개·1.9GB). `"usage"` 들어간 줄만 파싱하면 약 3초.
  같은 메시지가 파일 안·파일 사이에 중복 기록됨 → `message.id + requestId` 로 중복 제거하면 52.1억 토큰(UltraCat 51.9억과 일치).

## 결정 (Nik 확인)
- 팬 제어: **처음 한 번만 암호** — root 도우미(LaunchDaemon)를 설치. 앱 신호가 15초 끊기면 도우미가 팬을 자동으로 되돌림.
- 화면 배치: **위쪽 탭** — 창 폭 392px 유지. `지킴이 · 시스템 · 팬 · 토큰`.

## 디자인 방향
- 색: 기존 토큰 유지. 의미를 고정 — `lamp #E99A2C` = AI 활동·열, `moon #5566D4` = 식음·쉼, `rose #DA5442` = 위험·뜨거움, 나머지는 잉크 회색.
  온도 색: 45℃ 이하 moon → 70℃ lamp → 90℃ 이상 rose. 토큰 히트맵: lamp 단계(초록 잔디 아님 — "AI가 일한 날"을 앱의 주황으로).
- 글꼴: 본문 시스템 글꼴, **숫자는 SF Pro Rounded(`ui-rounded`) + 고정폭 숫자** — 계기판 눈금 같은 목소리. 크기 11.5 / 13 / 15 / 22 / 30.
- 상징은 한 곳에만: 메인의 고리를 **팬 페이지의 쌍둥이 고리**(왼쪽·오른쪽 팬)로 되풀이. 나머지 페이지는 조용한 목록(가는 구분선, 카드·아이콘 상자 없음).
- 움직임: 팬 고리 안의 날개가 실제 RPM에 비례해 돎(사용자가 값을 바꾸면 눈으로 확인). `prefers-reduced-motion`이면 멈춤.

```
지킴이 | 시스템 | 팬 | 토큰         ← 분절 탭, 현재 탭만 흰 바탕
──────────────────────────────
[팬]   ( 왼쪽 2,343 )  ( 오른쪽 2,507 )   쌍둥이 고리, arc = min..max 비율
       CPU 79℃ ▮  GPU 66℃ ▮  배터리 31℃ ▮
       [ 자동 | 고정 | 온도 따라 ]
       고정: 슬라이더(양쪽 같이 / 따로)   온도 따라: 4점 커브 끌기
       [적용]                          도우미 없음 → 설명 + [도우미 설치]
[시스템] CPU 51%  사용자 31 · 시스템 20 · 79℃   ── 60초 선 그래프
        GPU · 메모리 · 저장 공간 · 배터리 · 네트워크  (값 + 짧은 사실 + 막대)
[토큰]  52.1억 토큰          API 요금이면 $2,368
        오늘 · 사용한 날 · 연속
        20주 × 7일 히트맵(lamp 단계) — 칸을 누르면 아래 줄에 그날 내용
        모델별 막대 + 목록
```

## 구조
- Swift: `SMC.swift`(앱·도우미 공용 SMC 읽기/쓰기), `Sensors.swift`(온도·팬·배터리·저장 공간·네트워크·GPU 메모리),
  `Tokens.swift`(로그 증분 스캔, 파일별 캐시), `FanControl.swift`(도우미 설치/제거, 명령 파일), `Helper/main.swift`(root 도우미).
- JS: `meters.js`(DOM 없음, node 테스트) — 요금표·비용, 히트맵 칸·단계, 연속 일수, 커브 보간, 온도 단계.
- 다리: tick sample에 `fans`, `temps`, `fanHelper`(항상), `sys`(창이 보일 때). JS→Swift `fan{fans:[{mode,rpm}]}`, `fanInstall`, `fanRemove`, `tokens`. Swift→JS `AW.tokens(rows)`.
- 도우미: `/Library/PrivilegedHelperTools/com.nik.aiwatchdog.fanhelper` + `/Library/LaunchDaemons/com.nik.aiwatchdog.fanhelper.plist`.
  명령 파일 `/Library/Application Support/AIWatchdog/fan.json`(소유자 = 사용자). 도우미는 1초마다 읽고, 팬 번호·RPM을 min..max로 잘라 씀.
  `ts`가 15초 넘게 오래되면 모든 팬 자동. 시작할 때도 자동으로.
- Intel Mac: 읽기만(F0Md 없으면 제어 숨김). 팬 없는 Mac: 온도만.
