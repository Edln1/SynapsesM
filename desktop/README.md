# Synapses for Windows preview

An isolated Windows x64 desktop shell for the full `https://synapses.cloud/` app. It does not change the original web or Android projects.

The preview is unsigned, so Windows may show an unknown-publisher warning. No signing keys are included. The app uses the existing hosted service, account and service entitlements; it is not an offline model.

The black 32px titlebar has minimize, maximize/restore and close controls, a draggable area and the approved Synapses icon. Its accessible, non-draggable brand button invokes the existing web logo action to toggle navigation. The remote site fills the remaining window; its legacy window-drag overlays and resize handles are disabled only inside this desktop shell. Native resizing and Alt+F4 remain available; Ctrl+R reloads the site. The minimize button keeps normal taskbar behavior. X normally stops voice and hides the window to the system tray, keeping its work intact. Click/double-click the tray icon or choose **Open Synapses** to restore it. **Quit Synapses** closes the document through the existing unsaved-work check and exits.

Ordinary hiding waits for voice cleanup; if cleanup fails, the window remains visible. A separately enabled **PC voice** session can keep listening in the tray after live microphone capture is confirmed. Choose **Stop PC voice** in the tray to revoke it without opening the window. Quit, logout, page navigation and microphone loss revoke the session. Voice is off by default.

Account cookies and site data persist in this app's own Electron profile. They are separate from a normal browser and from the Ava Android package. Existing email/password sign-in is retained; external-browser OAuth callback association is not configured by this preview and needs separate validation.

The remote site has no Node integration or window-control bridge. A narrow Windows voice preload is exposed only to exact trusted Synapses main frames; native handlers independently recheck that frame, origin and session. A sandboxed local titlebar owns the separate window/navigation-control bridge. Its navigation command can only click the existing logo on a trusted Synapses document. HTTPS navigation stays inside exact `synapses.cloud` / `www.synapses.cloud` origins; validated user-initiated external links open in the system browser. TLS verification and web security remain enabled.

Microphone requests require trusted top-level Synapses content, audio-only access and explicit native consent. An intentional tray start can acquire the microphone while hidden during its original 30-second setup window; subsequent hidden recovery requires its active listening lease. Hidden permission dialogs are unparented and never restore the app. Late approvals must still match the current document, lease and unexpired setup. Other capture/device permissions are denied. The desktop shell adds no recorder, model provider, API key or account bypass.

## PC voice

Version 0.1.7 fixes a reproduced planner-provider failure: the smaller model can return `output_parse_failed` while producing a structured action. Format failures get one bounded retry and then a strict-JSON fallback to the existing larger model. Account attribution, cancellation and tool permissions remain in force. Quota, format, authentication and network failures have separate diagnostics; raw provider responses and user data are not logged.

Version 0.1.6 adds an LLM task loop to the explicit Windows PC voice session. Natural requests are planned through the existing Groq proxy, executed with fixed local tools, and checked against observed results. The model cannot supply executable JavaScript, PowerShell, paths, selectors or arbitrary shell commands. App/window/control references come from native discovery. Ordinary speech-to-speech and mobile remain separate.

Examples include opening installed apps such as Codex, Steam or Dota 2; moving a discovered window to another display; selecting a named visible control in the current browser; and searching then playing a YouTube video in the controlled browser. These are requests, not required exact phrases. Codex's Windows display name can be ChatGPT; its package identity supplies the Codex alias.

The native controller uses Windows accessibility controls, which are unavailable in some applications, custom canvases and elevated windows. The controlled browser uses observed DOM references and checks actual media playback. It does not attach to arbitrary existing browser tabs; existing windows are accessed through Windows accessibility. Unsupported or unverified steps return a limitation rather than claiming success. This is a preview, not universal or error-free PC control.

Native consent describes PC control and the needed app/window/page information sent to the existing model service. Password fields are excluded. Sensitive actions require concrete native confirmation; the model cannot approve itself. Stop, logout, navigation, microphone loss, task replacement and Quit cancel pending work. Idle controlled-browser playback can remain open after Stop; an in-flight browser action is retired to prevent late execution. Tasks are bounded to 12 planning steps and 90 seconds.

`pc-task-status.json` contains only fixed phase/action names, step counts, version/time and failure codes, without transcripts, window titles, URLs, account IDs or tokens. Physical microphone and actual target-app behavior still require user testing; model-plus-fixture tests are not hardware validation.

### Earlier website-only mode (0.1.5)

Choose **Start PC voice** in the tray or the installed app's Ava menu. Tray Start preserves the window exactly: visible stays visible, hidden stays hidden, and minimized stays minimized. It never shows, focuses, restores or auto-hides the app. Sign in first; a failed account or microphone check reports failure without opening the app. The app asks to reload when the cached page lacks the required voice hook.

Say **“open YouTube”**, **“open browser”**, **“open example.com”**, **“search for nearby coffee”**, or **“stop PC voice.”** Saying **Ava** first is optional while PC voice is enabled. “Open browser” opens the public Google home page in the system browser. Native parsing and DNS checks reject local/private addresses, files, unsupported URL schemes and stale sessions. Model replies do not authorize native actions. The capability does not exist in normal browsers or the Android app.

Common variants such as “Are you able to open YouTube?”, “Open up YouTube” and “Can you open You Tube for me?” use the same restricted browser action. Only anchored supported commands are recognized; quoted or reported instructions do not become actions.

“Open DoorDash” opens its public website. “Search YouTube for Michael Jackson”, “Go to YouTube and search for Michael Jackson” and “Play Michael Jackson on YouTube” open YouTube search results. They do not click a result or start playback; the spoken response explicitly asks you to choose a video. YouTube queries are limited to 500 characters. PC replies wait for speech playback to finish before the next legacy recording is armed, and Flux keeps its own continuous capture.

Only a bounded intentional tray-start attempt or an explicit PC voice lease disables background timer throttling. Stopping or timing out restores normal throttling and hidden microphone denial. A session cannot survive logout, page replacement or renderer failure; late consent and DNS responses cannot revive it.

For startup troubleshooting, the app writes `pc-voice-status.json` in its own user-data folder. This contains only app version, timestamp, enabled/listening flags, phase and an allowlisted stop-reason code. It contains no transcript, search query, account identifier or session token. A new attempt resets the reason; the first concrete failure is preserved through generic cleanup. `command-received` and `command-unrecognized` distinguish native routing from unsupported phrasing. `command-complete` is recorded only after the system-browser launch call resolves; it does not establish that the destination finished loading. This diagnostic records actual native status; passing simulated tests does not establish a successful physical microphone session.

Command failure codes distinguish an incomplete utterance, invalid target, unsupported grammar, empty/nonpublic/failed/timed-out DNS, rejected system-browser launch and a revoked lease. The next command clears an older command-only failure; genuine startup or stop failures remain primary. Error contents and targets are never added to the status file.

Running `Synapses.exe --pc-voice-report` requests an additional read-only `pc-voice-runtime.json` snapshot in the same user-data folder. An existing app handles this before its normal second-instance restore action, so its visibility, focus and minimized state stay unchanged. With no existing app, report-only startup creates no window and exits. The fixed probe records only host/client flags, bounded phase/reason codes, hook/provider repair flags, a service-worker boolean, actual Anam-native-running status and a sanitized speech-routing counter/flag snapshot. It records no speech, reply, URL, account, key or session identifier. No renderer code or destination can be supplied through this switch.

## Build

Use Node.js and npm, then run:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build:win
```

The locked tools are Electron **45.4.1** and electron-builder **26.18.0**. The current source version is **0.1.5**; its build output is `dist/Synapses-Setup-0.1.5.exe`, an NSIS installer for the current user. It does not request administrator rights, automatically launch after installation, or delete account data on uninstall. Code signing is deliberately disabled while executable icon and company metadata editing remain enabled.

This machine's global npm was missing an internal module. The verified build instead used an official npm 11.21.3 tarball unpacked under ignored `.cache/`; no system npm files were changed. Dependency installation and runtime downloads used the official npm/Electron distribution tooling.

The isolated smoke test can run with `electron . --smoke-test`. It uses a separate profile and verifies live full-site loading, the exact narrow Windows voice capability, native maximize/restore controls, visibility across same-document hash navigation and tray hide/restore/Quit lifecycle. The voice-cleanup smoke uses a stub, with no real capture. Unit fixtures exercise native lease/URL boundaries and the client against simulated live tracks. Its artifacts are ignored. The manual hidden renderer-input diagnostic is separate from the passing default policy tests and did not establish native OS pointer hit-testing. Compilation/smoke checks do not establish successful account sign-in, a completed real microphone/voice command, OAuth or installer/uninstaller behavior. No installation has been performed by this task.

Official implementation references: [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [permissions](https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler), [NSIS configuration](https://www.electron.build/nsis/).

## Release preparation

The installer exceeds GitHub's 100 MiB source-file limit. Use a release asset rather than committing it to the website repository. Copy the source allowlist below into that repository's `desktop/` directory, and copy `ci/publish-desktop.yml` to `.github/workflows/publish-desktop.yml`:

- `package.json`, `package-lock.json`
- `src/`, `test/`
- `assets/app.ico`, `assets/favicon.png`, `assets/favicon.svg`
- `README.md`, `VERIFICATION.md`, `release-notes.md`

Do not copy `node_modules`, `.cache`, `.preview`, `.git` or `dist` into source control. A tag such as `desktop-v0.1.5` triggers a build and prerelease publish using GitHub's temporary workflow token. A Linux preparation job validates the tag and archives only the desktop subtree. Windows downloads that archive without running Git checkout or creating an index, avoiding unrelated Windows-reserved paths in the host repository. The workflow also supports manual dispatch for an existing matching tag. It deliberately refuses to replace an already public version. The public checksum must come from the CI-built release asset; local build hashes can differ.
