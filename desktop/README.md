# Synapses for Windows preview

An isolated Windows x64 desktop shell for the full `https://synapses.cloud/` app. It does not change the original web or Android projects.

The preview is unsigned, so Windows may show an unknown-publisher warning. No signing keys are included. The app uses the existing hosted service, account and service entitlements; it is not an offline model.

The titlebar icon opens the existing Synapses navigation drawer. Legacy web drag and resize overlays are disabled inside this shell so the web logo and top-right icon toggle receive clicks. Same-document navigation keeps the app visible.

The black 32px titlebar has minimize, maximize/restore and close controls, a draggable area and the approved Synapses icon. The remote site fills the remaining window. Native resizing and Alt+F4 remain available; Ctrl+R reloads the site. Minimizing stops the existing voice session. Closing asks the hosted page to clean up and releases its web contents. There is no hidden system-tray background process.

Account cookies and site data persist in this app's own Electron profile. They are separate from a normal browser and from the Ava Android package. Existing email/password sign-in is retained; external-browser OAuth callback association is not configured by this preview and needs separate validation.

The remote site has no Node integration, preload or native bridge. A sandboxed local titlebar owns a small, sender-checked window-control bridge. HTTPS navigation stays inside exact `synapses.cloud` / `www.synapses.cloud` origins; validated user-initiated external links open in the system browser. TLS verification and web security remain enabled.

Microphone requests require trusted top-level Synapses content, an audio-only request, recent user input and explicit native consent. Other capture/device permissions are denied. Permission consent lasts for the running app session, and future microphone starts still require user input. The desktop shell adds no recorder, model provider, API key or account bypass.

## Build

Use Node.js and npm, then run:

```powershell
npm.cmd ci
npm.cmd test
npm.cmd run build:win
```

The locked tools are Electron **45.4.1** and electron-builder **26.18.0**. The current source version is **0.1.2**; its build output is `dist/Synapses-Setup-0.1.2.exe`, an NSIS installer for the current user. It does not request administrator rights, automatically launch after installation, or delete account data on uninstall. Code signing is deliberately disabled while executable icon and company metadata editing remain enabled.

This machine's global npm was missing an internal module. The verified build instead used an official npm 11.21.3 tarball unpacked under ignored `.cache/`; no system npm files were changed. Dependency installation and runtime downloads used the official npm/Electron distribution tooling.

The isolated smoke test can run with `electron . --smoke-test`. It uses a separate profile and verifies live full-site loading, remote isolation and native maximize/restore controls. Its artifacts are ignored. Compilation/smoke checks do not establish successful account sign-in, a completed microphone/voice call, OAuth or installer/uninstaller behavior. No installation has been performed by this task.

Official implementation references: [WebContentsView](https://www.electronjs.org/docs/latest/api/web-contents-view), [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [permissions](https://www.electronjs.org/docs/latest/api/session#sessetpermissionrequesthandlerhandler), [NSIS configuration](https://www.electron.build/nsis/).

## Release preparation

The installer exceeds GitHub's 100 MiB source-file limit. Use a release asset rather than committing it to the website repository. Copy the source allowlist below into that repository's `desktop/` directory, and copy `ci/publish-desktop.yml` to `.github/workflows/publish-desktop.yml`:

- `package.json`, `package-lock.json`
- `src/`, `test/`
- `assets/app.ico`, `assets/favicon.png`, `assets/favicon.svg`
- `README.md`, `VERIFICATION.md`, `release-notes.md`

Do not copy `node_modules`, `.cache`, `.preview`, `.git` or `dist` into source control. A tag such as `desktop-v0.1.2` triggers a build and prerelease publish using GitHub's temporary workflow token. A Linux preparation job validates the tag and archives only the desktop subtree. Windows downloads that archive without running Git checkout or creating an index, avoiding unrelated Windows-reserved paths in the host repository. The workflow also supports manual dispatch for an existing matching tag. It deliberately refuses to replace an already public version. The public checksum must come from the CI-built release asset; local build hashes can differ.
