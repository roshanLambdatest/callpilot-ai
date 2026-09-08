#!/bin/bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
INSTALL_ROOT="$HOME/Library/Application Support/CallPilot AI"

# First run from Downloads/ZIP: copy to a stable per-user install location, then continue there.
if [ "$ROOT" != "$INSTALL_ROOT" ] && [ "${1:-}" != "--installed-copy" ]; then
  mkdir -p "$INSTALL_ROOT"
  /usr/bin/ditto "$ROOT" "$INSTALL_ROOT"
  chmod +x "$INSTALL_ROOT"/*.command "$INSTALL_ROOT/CallPilot AI.app/Contents/MacOS/CallPilot AI" 2>/dev/null || true
  exec "$INSTALL_ROOT/INSTALL-CALLPILOT-MAC.command" --installed-copy
fi
ROOT="$INSTALL_ROOT"
LOG_DIR="$ROOT/.callpilot-logs"
mkdir -p "$LOG_DIR"

ok(){ printf "\n✓ %s\n" "$1"; }
step(){ printf "\n▶ %s\n" "$1"; }
fail(){ printf "\n✗ %s\n" "$1"; read -r -p "Press Enter to close..."; exit 1; }

step "Checking requirements"
command -v python3 >/dev/null 2>&1 || fail "Python 3 is required. Install Python 3 first."
command -v npm >/dev/null 2>&1 || fail "Node.js/npm is required. Install Node.js LTS first."

if [ ! -f "$ROOT/backend/.env" ]; then cp "$ROOT/backend/.env.example" "$ROOT/backend/.env"; fi
# v4.1 uses local Whisper for transcription, so no OpenAI key is required.
if ! grep -Eq '^ANTHROPIC_API_KEY=.+$' "$ROOT/backend/.env"; then
  printf "\nCallPilot uses local Whisper for transcription. No OpenAI API key is required.\n"
  printf "Claude is recommended for knowledge-grounded answers.\n"
  read -r -s -p "Paste ANTHROPIC_API_KEY (or Enter to use demo answers): " KEY
  printf "\n"
  if [ -n "${KEY:-}" ]; then
    python3 - "$ROOT/backend/.env" "$KEY" <<'PYKEY'
import re,sys,os
p,key=sys.argv[1],sys.argv[2]
s=open(p).read() if os.path.exists(p) else ''
s=re.sub(r'^ANTHROPIC_API_KEY=.*$',f'ANTHROPIC_API_KEY={key}',s,flags=re.M) if re.search(r'^ANTHROPIC_API_KEY=.*$',s,re.M) else s+f'\nANTHROPIC_API_KEY={key}\n'
open(p,'w').write(s)
PYKEY
  fi
fi

step "Installing backend dependencies"
[ -d "$ROOT/backend/.venv" ] || python3 -m venv "$ROOT/backend/.venv"
"$ROOT/backend/.venv/bin/python" -m pip install -q -r "$ROOT/backend/requirements.txt" || fail "Python dependency installation failed."

step "Installing native CallPilot companion"
(cd "$ROOT/native-overlay" && npm install --silent) || fail "Native companion dependency installation failed."

step "Installing automatic startup at Mac login"
PLIST="$HOME/Library/LaunchAgents/com.callpilot.ai.plist"
mkdir -p "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.callpilot.ai</string>
<key>ProgramArguments</key><array><string>/bin/bash</string><string>$ROOT/AUTOSTART-CALLPILOT.command</string></array>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><false/>
<key>StandardOutPath</key><string>$LOG_DIR/autostart.log</string>
<key>StandardErrorPath</key><string>$LOG_DIR/autostart-error.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/com.callpilot.ai" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl load "$PLIST" 2>/dev/null || true
launchctl enable "gui/$(id -u)/com.callpilot.ai" >/dev/null 2>&1 || true

step "Starting CallPilot now"
"$ROOT/AUTOSTART-CALLPILOT.command"
sleep 3
if curl -fsS http://127.0.0.1:8000/health >/dev/null 2>&1; then ok "Backend is healthy"; else fail "Backend failed to start; check .callpilot-logs/backend.log"; fi

touch "$ROOT/.callpilot-installed"
mkdir -p "$HOME/Applications"
/usr/bin/ditto "$ROOT/CallPilot AI.app" "$HOME/Applications/CallPilot AI.app"
ok "CallPilot installation complete"
printf "\nFrom now on, CallPilot starts automatically when you log in to your Mac.\n"
printf "Use the Chrome window/profile labelled by CallPilot. When a supported meeting opens, you will get a reminder.\n"
printf "Click the CallPilot extension → Start Call once. It will stop itself when the meeting ends or the tab closes.\n\n"
read -r -p "Press Enter to close this installer..."
