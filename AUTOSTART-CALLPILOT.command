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

start_companion(){
  if pgrep -f "$ROOT/native-overlay.*electron" >/dev/null 2>&1 || pgrep -f "$ROOT/native-overlay" >/dev/null 2>&1; then return 0; fi
  if [ -d "$ROOT/native-overlay/node_modules/electron" ]; then
    (cd "$ROOT/native-overlay" && nohup npm start >>"$LOG_DIR/overlay.log" 2>&1 & echo $! > "$ROOT/.overlay.pid")
  fi
}

start_backend
start_companion
exit 0
