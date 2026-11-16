#!/bin/bash
# AI Watchdog.app 만들기 (macOS 13 이상, Xcode Command Line Tools 필요: xcode-select --install)
set -euo pipefail
cd "$(dirname "$0")"

APP="build/AI Watchdog.app"
SDK="$(xcrun --show-sdk-path)"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

compile() {  # $1 = arm64 | x86_64
  xcrun swiftc -O -swift-version 5 -sdk "$SDK" -target "$1-apple-macos13.0" \
    -Xlinker -dead_strip Sources/*.swift -o "build/AIWatchdog-$1"
}

echo "▶ 컴파일 (Apple Silicon)"
compile arm64
if compile x86_64 2>/dev/null; then
  echo "▶ 인텔 맥용도 함께 묶음"
  lipo -create build/AIWatchdog-arm64 build/AIWatchdog-x86_64 -output "$APP/Contents/MacOS/AIWatchdog"
else
  echo "  (인텔용 컴파일은 건너뜀)"
  cp build/AIWatchdog-arm64 "$APP/Contents/MacOS/AIWatchdog"
fi
strip -x "$APP/Contents/MacOS/AIWatchdog"
rm -f build/AIWatchdog-*

cp Info.plist "$APP/Contents/"
mkdir -p "$APP/Contents/Resources/ui" "$APP/Contents/Resources/lang"
cp Resources/ui/index.html Resources/ui/app.css Resources/ui/app.js Resources/ui/logic.js Resources/ui/i18n.js "$APP/Contents/Resources/ui/"
cp Resources/lang/*.json "$APP/Contents/Resources/lang/"

codesign --force --sign - "$APP"     # 이 맥에서 쓰기 위한 임시 서명

echo "✔ 완성: $APP ($(du -sh "$APP" | cut -f1))"
echo "  /Applications 로 옮기려면:  mv \"$APP\" /Applications/"
