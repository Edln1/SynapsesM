Synapses Desktop 0.1.3 preview brings the full Synapses web app into a dedicated Windows x64 window, with a slim black titlebar and minimize, maximize/restore and close controls.

- Ordinary X stops voice and hides the window to the system tray, preserving your work. An explicitly enabled live PC voice session can keep listening there.
- Click/double-click the tray icon or choose **Open Synapses** to restore it. **Quit Synapses** exits through the existing unsaved-work check.
- **Start PC voice** in the tray or installed app's Ava menu enables an explicit listening session. Say “Ava open YouTube,” “Ava search for …,” or “Ava stop PC voice.”
- Tray-start foregrounds for account/microphone access, then returns to the tray only after capture is live. Stop PC voice revokes the session without showing the window.
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
