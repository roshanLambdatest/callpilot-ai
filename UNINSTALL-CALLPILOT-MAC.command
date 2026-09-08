#!/bin/bash
set -u
PLIST="$HOME/Library/LaunchAgents/com.callpilot.ai.plist"
launchctl bootout "gui/$(id -u)/com.callpilot.ai" >/dev/null 2>&1 || true
launchctl unload "$PLIST" >/dev/null 2>&1 || true
rm -f "$PLIST"
"$(cd "$(dirname "$0")" && pwd)/STOP-CALLPILOT.command" >/dev/null 2>&1 || true
echo "CallPilot auto-start was removed. The project files were left untouched."
read -r -p "Press Enter to close..."
