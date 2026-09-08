# CallPilot Private Overlay

This Electron companion renders answers outside the browser and requests OS-level capture protection with `BrowserWindow.setContentProtection(true)`.

- Windows 10 2004+ / Windows 11: Electron maps this to `WDA_EXCLUDEFROMCAPTURE`, which is the strongest supported path for whole-display capture exclusion.
- macOS: Electron requests `NSWindowSharingNone`, but Electron documents that newer apps using ScreenCaptureKit may still capture the window. Treat this as **not guaranteed**.
- Linux: this demo does not claim capture exclusion.

Run:

```bash
npm install
npm start
```

Shortcut: `Alt+Space` toggles the overlay.
