#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
[ -f "$ROOT/.backend.pid" ] && kill "$(cat "$ROOT/.backend.pid")" 2>/dev/null || true
[ -f "$ROOT/.overlay.pid" ] && kill "$(cat "$ROOT/.overlay.pid")" 2>/dev/null || true
pkill -f "uvicorn app.main:app.*8000" >/dev/null 2>&1 || true
printf "CallPilot stopped.\n"
