#!/bin/sh
# AI Watchdog 팬 도우미 설치·제거. 앱이 macOS 관리자 암호 창을 거쳐 root 로 실행함.
#   install <도우미 파일> <사용자 uid>   |   remove
set -eu
LABEL=com.nik.aiwatchdog.fanhelper
BIN=/Library/PrivilegedHelperTools/$LABEL
PLIST=/Library/LaunchDaemons/$LABEL.plist
DIR="/Library/Application Support/AIWatchdog"
CMD="$DIR/fan.json"

case "${1:-}" in
install)
  SRC="${2:-}"; OWNER="${3:-}"
  case "$OWNER" in ''|*[!0-9]*) echo "bad uid" >&2; exit 2 ;; esac
  [ -f "$SRC" ] || { echo "helper file not found" >&2; exit 2; }
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  mkdir -p /Library/PrivilegedHelperTools
  cp "$SRC" "$BIN"
  chown root:wheel "$BIN"; chmod 755 "$BIN"
  mkdir -p "$DIR"; chown root:wheel "$DIR"; chmod 755 "$DIR"
  rm -f "$CMD"
  printf '{"ts":0,"fans":[]}' > "$CMD"
  chown "$OWNER" "$CMD"; chmod 644 "$CMD"     # 앱(사용자)만 명령을 쓸 수 있음
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$BIN</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict>
</plist>
EOF
  chown root:wheel "$PLIST"; chmod 644 "$PLIST"
  launchctl bootstrap system "$PLIST"
  ;;
remove)
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  rm -f "$PLIST" "$BIN" "$CMD"
  rmdir "$DIR" 2>/dev/null || true
  ;;
*)
  echo "usage: $0 install <helper> <uid> | remove" >&2; exit 2 ;;
esac
