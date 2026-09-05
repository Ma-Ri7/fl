#!/usr/bin/env bash
# FLASH - show current service status + last log lines.
LABEL="com.flash.bot"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== launchctl status ==="
launchctl list | grep "$LABEL" || echo "(not loaded)"

PID="$(launchctl list | awk -v l="$LABEL" '$2==l {print $1}')"
if [ -n "${PID:-}" ] && [ "$PID" != "-" ]; then
  echo ""
  echo "=== process ($PID) ==="
  ps -o pid,etime,cmd -p "$PID" || true
fi

echo ""
echo "=== last stdout (bot.out.log) ==="
tail -n 20 "$DIR/logs/bot.out.log" 2>/dev/null || echo "(no log yet)"
echo ""
echo "=== last stderr (bot.err.log) ==="
tail -n 20 "$DIR/logs/bot.err.log" 2>/dev/null || echo "(no log yet)"