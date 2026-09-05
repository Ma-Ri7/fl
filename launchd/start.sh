#!/usr/bin/env bash
# FLASH - start the bot as a macOS launchd service (24/7, restart on crash, starts at login).
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PLIST="$DIR/launchd/com.flash.bot.plist"
LABEL="com.flash.bot"

if [ ! -f "$PLIST" ]; then
  echo "ERROR: $PLIST not found." >&2
  exit 1
fi

# Copy into ~/Library/LaunchAgents (the canonical location launchd scans).
mkdir -p "$HOME/Library/LaunchAgents"
cp "$PLIST" "$HOME/Library/LaunchAgents/$LABEL.plist"

# Load & start (kickstart ensures it is running even if already loaded but inactive).
launchctl load "$HOME/Library/LaunchAgents/$LABEL.plist" 2>/dev/null || true
launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true

echo "FLASH bot service started (label: $LABEL)."
echo "Logs:"
echo "  $DIR/logs/bot.out.log"
echo "  $DIR/logs/bot.err.log"
echo "Status: launchctl list | grep $LABEL"