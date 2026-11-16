#!/bin/bash
# 배포 파일 만들기: build/AI-Watchdog-mac.dmg (+ .zip)
#  - DMG 안: AI Watchdog.app + Applications 바로가기
#  - DMG를 열었을 때 디스크 아이콘 = 앱 아이콘 (내려받아도 유지)
#  - DMG 파일 자체 아이콘 = 앱 아이콘 (이 Mac에서. 인터넷으로 내려받으면 macOS가 지울 수 있음)
# 먼저 ./build.sh 로 앱을 만든 뒤 실행.
set -euo pipefail
cd "$(dirname "$0")"

APP="build/AI Watchdog.app"
ICON="Resources/icon/AppIcon-1024.png"
OUT="build/AI-Watchdog-mac.dmg"
[ -d "$APP" ] || { echo "먼저 ./build.sh 로 앱을 만드세요" >&2; exit 1; }

# 동기화 폴더(구글 드라이브 등)에서는 디스크 이미지 연결이 막힐 수 있어 임시 폴더에서 만듦
WORK="$(mktemp -d "${TMPDIR:-/tmp}/aiwd-dmg.XXXXXX")"
MNT=""
cleanup() { [ -n "$MNT" ] && hdiutil detach "$MNT" -quiet 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

echo "▶ 아이콘 도구"
xcrun swiftc -O tools/seticon.swift -o "$WORK/seticon"

echo "▶ DMG 내용"
mkdir "$WORK/src"
cp -R "$APP" "$WORK/src/"
ln -s /Applications "$WORK/src/Applications"
hdiutil create -volname "AI Watchdog" -srcfolder "$WORK/src" -fs HFS+ -format UDRW -ov "$WORK/rw.dmg" >/dev/null

echo "▶ 디스크 아이콘"
MNT="$(hdiutil attach -nobrowse -noverify -readwrite "$WORK/rw.dmg" | awk -F'\t' '/\/Volumes\//{print $NF}')"
"$WORK/seticon" "$ICON" "$MNT"
[ -f "$MNT/.VolumeIcon.icns" ] || { echo "디스크 아이콘을 넣지 못했어요" >&2; exit 1; }
hdiutil detach "$MNT" -quiet
MNT=""

echo "▶ 압축"
hdiutil convert "$WORK/rw.dmg" -format UDZO -imagekey zlib-level=9 -o "$WORK/final.dmg" >/dev/null
"$WORK/seticon" "$ICON" "$WORK/final.dmg" || echo "  (DMG 파일 자체 아이콘은 건너뜀)"
rm -f "$OUT"
cp "$WORK/final.dmg" "$OUT"

ditto -c -k --keepParent "$APP" build/AI-Watchdog-mac.zip
echo "✔ 완성: $OUT ($(du -h "$OUT" | cut -f1)), build/AI-Watchdog-mac.zip"
