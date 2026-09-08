#!/bin/bash
set -u
ROOT="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$ROOT/.callpilot-logs"
mkdir -p "$LOG_DIR"

start_backend(){
  if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then return 0; fi
  if [ -x "$ROOT/backend/.venv/bin/python" ]; then
    (cd "$ROOT/backend" && nohup "$ROOT/backend/.venv/bin/python" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 >>"$LOG_DIR/backend.log" 2>&1 & echo $! > "$ROOT/.backend.pid")
  fi
}

PACKAGED_APP="$(find "$ROOT/native-overlay/dist" -maxdepth 2 -iname "CallPilot AI.app" 2>/dev/null | head -1)"

start_companion(){
  if pgrep -f "$PACKAGED_APP" >/dev/null 2>&1 || pgrep -f "$ROOT/native-overlay.*electron" >/dev/null 2>&1; then return 0; fi
  if [ -d "$PACKAGED_APP" ]; then
    open "$PACKAGED_APP" >>"$LOG_DIR/overlay.log" 2>&1
  elif [ -d "$ROOT/native-overlay/node_modules/electron" ]; then
    # Fallback for a dev checkout that has not been packaged yet. Screen
    # Recording/Microphone permissions will not persist reliably in this mode
    # since the raw dev Electron binary has no stable signed app identity.
    (cd "$ROOT/native-overlay" && nohup npm start >>"$LOG_DIR/overlay.log" 2>&1 & echo $! > "$ROOT/.overlay.pid")
  fi
}

start_backend
start_companion
exit 0
