#!/bin/bash
# AI Watchdog.app 만들기 (macOS 13 이상, Xcode Command Line Tools 필요: xcode-select --install)
set -euo pipefail
cd "$(dirname "$0")"

APP="build/AI Watchdog.app"
SDK="$(xcrun --show-sdk-path)"
rm -rf build
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

compile() {  # $1 = arm64 | x86_64, $2 = 출력 이름, 나머지 = 소스
  local arch="$1" out="$2"; shift 2
  xcrun swiftc -O -swift-version 5 -sdk "$SDK" -target "$arch-apple-macos13.0" \
    -Xlinker -dead_strip "$@" -o "build/$out-$arch"
}
universal() {  # $1 = 출력 이름, $2 = .app 안의 경로, 나머지 = 소스
  local out="$1" dest="$2"; shift 2
  compile arm64 "$out" "$@"
  if compile x86_64 "$out" "$@" 2>/dev/null; then
    lipo -create "build/$out-arm64" "build/$out-x86_64" -output "$dest"
  else
    echo "  (인텔용 컴파일은 건너뜀: $out)"
    cp "build/$out-arm64" "$dest"
  fi
  strip -x "$dest"
  rm -f "build/$out-"*
}

echo "▶ 컴파일 (Apple Silicon + 인텔)"
universal AIWatchdog "$APP/Contents/MacOS/AIWatchdog" Sources/*.swift
echo "▶ 팬 도우미"
universal fanhelper "$APP/Contents/MacOS/aiwatchdog-fanhelper" Helper/main.swift Sources/SMC.swift

cp Info.plist "$APP/Contents/"

echo "▶ 앱 아이콘"
ICONSET=build/AppIcon.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s Resources/icon/AppIcon-1024.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) Resources/icon/AppIcon-1024.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/AppIcon.icns"
rm -rf "$ICONSET"
mkdir -p "$APP/Contents/Resources/ui" "$APP/Contents/Resources/lang"
cp Resources/ui/index.html Resources/ui/app.css Resources/ui/app.js Resources/ui/logic.js Resources/ui/i18n.js Resources/ui/meters.js "$APP/Contents/Resources/ui/"
cp Resources/fanhelper.sh "$APP/Contents/Resources/"
cp Resources/lang/*.json "$APP/Contents/Resources/lang/"

codesign --force --sign - "$APP/Contents/MacOS/aiwatchdog-fanhelper"   # 안쪽 실행 파일 먼저
codesign --force --sign - "$APP"     # 이 맥에서 쓰기 위한 임시 서명

echo "✔ 완성: $APP ($(du -sh "$APP" | cut -f1))"
echo "  /Applications 로 옮기려면:  mv \"$APP\" /Applications/"
