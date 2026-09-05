#!/usr/bin/env bash
# FLASH - stop & unload the macOS launchd service.
set -euo pipefail

LABEL="com.flash.bot"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true
rm -f "$PLIST"

echo "FLASH bot service stopped."