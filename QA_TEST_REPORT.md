# CallPilot AI v4.3 QA Test Report

## Scope
Native macOS menu-bar lifecycle, no-extension architecture, browser meeting detection, reminders, capture start/stop, local transcription/RAG plumbing, overlay behavior, and failure recovery.

## Automated checks
- Backend API regression suite.
- Meeting URL allow-list and malicious lookalike rejection.
- Ended-title detection.
- 30-second automatic-stop grace-period logic.
- Duplicate/no-confirmed-meeting stop protection.
- JavaScript syntax checks for Electron main/capture/overlay/preload files.
- Shell syntax checks for installer/start/autostart/uninstall scripts.
- Info.plist validation.
- ZIP integrity validation.

## Failure cases explicitly handled
1. Start Call clicked twice → second start is ignored/idempotent.
2. Backend unavailable → capture is blocked and user receives a notification.
3. System audio permission missing → Start fails with actionable macOS permission guidance.
4. Microphone permission denied → continue with system call audio only and notify user.
5. Capture stream ends → CallPilot stops.
6. Meeting URL disappears briefly → 30-second grace period prevents immediate false stop.
7. Meeting really ends/tab closes → automatic stop after grace period.
8. Chrome is not running → companion remains healthy; no reminder spam.
9. Fake/lookalike meeting URL → not treated as a supported meeting.
10. Transcription request fails → capture remains alive and retries after a short delay.
11. Same question repeats in adjacent audio segments → duplicate answer suppression.
12. Claude unavailable/credit exhausted → backend provider resolution can fall back to demo mode rather than crashing.
13. Overlay minimized when answer arrives → unread indicator is shown; panel is not forced open.
14. Quit while capturing → capture is stopped before app exit.

## Real-Mac acceptance tests still required
These cannot be faithfully executed in this Linux packaging environment and must be verified on the target Mac:
- macOS Screen & System Audio Recording permission prompt and actual CoreAudio capture.
- microphone permission prompt.
- real Google Meet remote-party audio + local mic transcription.
- Teams Web / Zoom Web / Webex audio capture.
- sleep/wake during an active meeting.
- audio output device changes (AirPods ↔ speakers).
- long call (60+ minutes) memory/CPU behavior.
- full-screen sharing privacy behavior for the floating overlay on the exact meeting app/macOS combination.
