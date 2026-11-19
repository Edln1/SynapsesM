# Synapses for Windows preview

An isolated Windows x64 desktop shell for the full `https://synapses.cloud/` app. It does not change the original web or Android projects.

The preview is unsigned, so Windows may show an unknown-publisher warning. No signing keys are included. The app uses the existing hosted service, account and service entitlements; it is not an offline model.

The black 32px titlebar has minimize, maximize/restore and close controls, a draggable area and the approved Synapses icon. Its accessible, non-draggable brand button invokes the existing web logo action to toggle navigation. The remote site fills the remaining window; its legacy window-drag overlays and resize handles are disabled only inside this desktop shell. Native resizing and Alt+F4 remain available; Ctrl+R reloads the site. The minimize button keeps normal taskbar behavior. X normally stops voice and hides the window to the system tray, keeping its work intact. Click/double-click the tray icon or choose **Open Synapses** to restore it. **Quit Synapses** closes the document through the existing unsaved-work check and exits.

Ordinary hiding waits for voice cleanup; if cleanup fails, the window remains visible. A separately enabled **PC voice** session can keep listening in the tray after live microphone capture is confirmed. Choose **Stop PC voice** in the tray to revoke it without opening the window. Quit, logout, page navigation and microphone loss revoke the session. Voice is off by default.

Account cookies and site data persist in this app's own Electron profile. They are separate from a normal browser and from the Ava Android package. Existing email/password sign-in is retained; external-browser OAuth callback association is not configured by this preview and needs separate validation.

The remote site has no Node integration or window-control bridge. A narrow Windows voice preload is exposed only to exact trusted Synapses main frames; native handlers independently recheck that frame, origin and session. A sandboxed local titlebar owns the separate window/navigation-control bridge. Its navigation command can only click the existing logo on a trusted Synapses document. HTTPS navigation stays inside exact `synapses.cloud` / `www.synapses.cloud` origins; validated user-initiated external links open in the system browser. TLS verification and web security remain enabled.

Microphone requests require trusted top-level Synapses content, audio-only access and explicit native consent. Initial PC voice setup is foreground-bounded; hidden recovery is allowed only for its active listening lease. Other capture/device permissions are denied. The desktop shell adds no recorder, model provider, API key or account bypass.

## PC voice

Choose **Start PC voice** in the tray or the installed app's Ava menu. Starting from the tray can bring Synapses forward for account or microphone access, then returns it to the tray after capture is live. Starting in the page keeps it visible. The app asks to reload when the cached page lacks the required voice hook.

Say **“Ava open YouTube”**, **“Ava open example.com”**, **“Ava search for nearby coffee”**, or **“Ava stop PC voice.”** These commands open public HTTPS sites/search results in the system browser. Native parsing and DNS checks reject local/private addresses, files, unsupported URL schemes and stale sessions. Model replies do not authorize native actions. The capability does not exist in normal browsers or the Android app.

Only an explicit, live PC voice lease disables background timer throttling. Stopping it restores normal throttling and hidden microphone denial. A session cannot survive logout, page replacement or renderer failure; late consent and DNS responses cannot revive it.

## Build

Use Node.js and npm, then run:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build:win
```

The locked tools are Electron **45.4.1** and electron-builder **26.18.0**. The current source version is **0.1.3**; its build output is `dist/Synapses-Setup-0.1.3.exe`, an NSIS installer for the current user. It does not request administrator rights, automatically launch after installation, or delete account data on uninstall. Code signing is deliberately disabled while executable icon and company metadata editing remain enabled.

This machine's global npm was missing an internal module. The verified build instead used an official npm 11.21.3 tarball unpacked under ignored `.cache/`; no system npm files were changed. Dependency installation and runtime downloads used the official npm/Electron distribution tooling.

The isolated smoke test can run with `electron . --smoke-test`. It uses a separate profile and verifies live full-site loading, the exact narrow Windows voice capability, native maximize/restore controls, visibility across same-document hash navigation and tray hide/restore/Quit lifecycle. The voice-cleanup smoke uses a stub, with no real capture. Unit fixtures exercise native lease/URL boundaries and the client against simulated live tracks. Its artifacts are ignored. The manual hidden renderer-input diagnostic is separate from the passing default policy tests and did not establish native OS pointer hit-testing. Compilation/smoke checks do not establish successful account sign-in, a completed real microphone/voice command, OAuth or installer/uninstaller behavior. No installation has been performed by this task.

Official implementation references: [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [permissions](https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler), [NSIS configuration](https://www.electron.build/nsis/).

## Release preparation

The installer exceeds GitHub's 100 MiB source-file limit. Use a release asset rather than committing it to the website repository. Copy the source allowlist below into that repository's `desktop/` directory, and copy `ci/publish-desktop.yml` to `.github/workflows/publish-desktop.yml`:

- `package.json`, `package-lock.json`
- `src/`, `test/`
- `assets/app.ico`, `assets/favicon.png`, `assets/favicon.svg`
- `README.md`, `VERIFICATION.md`, `release-notes.md`

Do not copy `node_modules`, `.cache`, `.preview`, `.git` or `dist` into source control. A tag such as `desktop-v0.1.3` triggers a build and prerelease publish using GitHub's temporary workflow token. A Linux preparation job validates the tag and archives only the desktop subtree. Windows downloads that archive without running Git checkout or creating an index, avoiding unrelated Windows-reserved paths in the host repository. The workflow also supports manual dispatch for an existing matching tag. It deliberately refuses to replace an already public version. The public checksum must come from the CI-built release asset; local build hashes can differ.
