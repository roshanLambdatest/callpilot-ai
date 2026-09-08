# CallPilot AI v4.3 — Native Mac, No Chrome Extension

CallPilot now runs entirely from the **macOS menu bar + private floating assistant**. There is no Chrome extension and no CallPilot-specific Chrome profile.

## Daily workflow

1. Log into your Mac — CallPilot starts automatically.
2. Open your normal Chrome and join Google Meet, Teams Web, Zoom Web, or Webex.
3. CallPilot detects the meeting URL and shows a macOS reminder if capture is not active.
4. Click the **CallPilot menu bar icon → Start Call**.
5. CallPilot captures system call audio plus your microphone, transcribes locally with Whisper, detects questions, retrieves the knowledge base, and uses Claude when configured.
6. Answers stay in the private Granola-style floating assistant.
7. When the detected browser meeting disappears, CallPilot waits 30 seconds and stops automatically. You can always use **Stop Call** from the menu bar.

## First install

Double-click `INSTALL-CALLPILOT-MAC.command` once. The installer copies the app to `~/Library/Application Support/CallPilot AI`, installs Python/Electron dependencies, asks for an optional Anthropic API key, and registers login startup.

The first time you press **Start Call**, macOS may ask for **Screen & System Audio Recording** and **Microphone** permissions. Grant them to CallPilot/Electron and restart CallPilot if macOS requests it. Local Whisper does not require an OpenAI API key.

## Menu bar

- **Start Call** — starts full system-audio + mic capture.
- **Stop Call** — stops immediately.
- **Open Assistant / Minimize Assistant** — toggles the floating Q&A panel.
- **Test Backend** — validates the local knowledge engine.
- **Quit CallPilot** — safely stops capture and exits.

## Private assistant

The assistant is a small floating ✦ when minimized. Click it to expand. The current customer **question and answer are always shown together**. It does not show the old waiting/source placeholder screen.

## Automatic meeting reminders

Meeting detection is local. On macOS the companion reads URLs/titles from running Chrome tabs via AppleScript; it does not inject code into your browser. Reminders have a cooldown so they do not spam you.

## Automatic stop

For detected browser meetings, CallPilot stops after the meeting URL disappears for 30 seconds. It also stops if the captured media stream ends. Because meeting UIs can change, **Stop Call remains available as a fail-safe**.

## Important macOS audio note

Current Electron/Chromium uses Apple audio-capture APIs on modern macOS. macOS 14.2+ requires an audio-capture usage description and user permission. If system audio is unavailable, CallPilot shows a clear menu-bar notification instead of pretending that transcription is active.

## Provider setup

`backend/.env`:

```env
TRANSCRIPTION_PROVIDER=local
LOCAL_WHISPER_MODEL=base.en
ANTHROPIC_API_KEY=your_key_here
ANTHROPIC_MODEL=claude-3-5-haiku-latest
```

Do not paste API keys into chat.
