Synapses Desktop 0.1.5 preview brings the full Synapses web app into a dedicated Windows x64 window, with a slim black titlebar and minimize, maximize/restore and close controls.

- Ordinary X stops voice and hides the window to the system tray, preserving your work. An explicitly enabled live PC voice session can keep listening there.
- Click/double-click the tray icon or choose **Open Synapses** to restore it. **Quit Synapses** exits through the existing unsaved-work check.
- **Start PC voice** in the tray or installed app's Ava menu enables an explicit listening session. Say “open YouTube,” “open browser,” “search for …,” or “stop PC voice.” Saying Ava first is optional.
- Tray Start now preserves the exact window state, including hidden and minimized windows. It never restores or auto-hides the app. A hidden microphone-consent dialog is independent of the main window; failed sign-in or microphone checks report failure without opening it. Stop PC voice also keeps the current window state.
- Hidden startup is limited to the original 30-second native tray intent. Expired, canceled or replaced sessions cannot gain microphone access from a late permission response.
- Startup diagnostics record the actual phase and an allowlisted failure code in the app's own user-data folder. They contain no transcripts, searches, account identifiers or session tokens; this preview still requires physical microphone validation.
- Common spoken forms such as “Are you able to open YouTube?” and “Open up You Tube for me” now reach the same restricted browser action. Private routing markers distinguish unsupported phrasing from a command that reached native code.
- “Open DoorDash” opens its website. YouTube search and “play … on YouTube” requests show search results; they do not start playback automatically.
- PC reply recording waits for playback completion and respects Flux capture ownership, preventing an early legacy recorder from capturing the reply. Content-free failure codes distinguish missing targets, DNS failures and rejected browser launches.
- Native actions are limited to verified public HTTPS websites/searches. Local addresses, files and computer commands are blocked; this capability is absent from the mobile/browser app.

- The top-left titlebar logo now invokes the existing Synapses navigation action.
- Legacy webpage window-drag overlays and resize handles are disabled only inside this shell so they cannot cover web controls.
- Same-document navigation keeps the app visible.

- Uses the existing Synapses account and hosted service; an internet connection is required.
- Keeps account data in this app's own profile, separate from a normal browser.
- The remote site has no Node integration. Its narrow Windows voice API requires the exact trusted main frame, user consent and a current lease. Window controls remain in separate local chrome.
- This preview is unsigned. Windows may show an unknown-publisher warning.
- Downloading the installer does not install or launch the app. Run it only when you choose to install.

The adjacent `.sha256` file and `release-manifest.json` describe this exact CI-built installer. Installation, account sign-in, OAuth and a completed voice call still need real-device validation; build checks do not establish those outcomes.
