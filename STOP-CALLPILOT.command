#!/bin/bash
ROOT="$(cd "$(dirname "$0")" && pwd)"
[ -f "$ROOT/.backend.pid" ] && kill "$(cat "$ROOT/.backend.pid")" 2>/dev/null || true
[ -f "$ROOT/.overlay.pid" ] && kill "$(cat "$ROOT/.overlay.pid")" 2>/dev/null || true
pkill -f "uvicorn app.main:app.*8000" >/dev/null 2>&1 || true
# .overlay.pid only tracks the `npm start` wrapper, not the Electron process
# tree it spawns, so explicitly kill the app binary too (packaged app first,
# dev-mode Electron process as a fallback).
pkill -f "$ROOT/native-overlay/dist/.*/CallPilot AI.app" >/dev/null 2>&1 || true
pkill -f "$ROOT/native-overlay.*[Ee]lectron" >/dev/null 2>&1 || true
printf "CallPilot stopped.\n"
