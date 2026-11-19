# Synapses Windows preview verification — 19 November 2026

## Final 0.1.3 voice capability

The final source adds an explicit Windows PC voice lease on top of the verified tray base. Forty-three desktop tests pass, covering wake-word parsing, public URL/DNS boundaries, exact-frame IPC, pending-consent cancellation, stale sessions, foreground setup/hidden capture rules, user-gesture forwarding, client account/track/error handling, tray lifecycle and asynchronous document readiness. Independent review also passed the focused real-source ASR hook tests.

The final `--dir` build produced `dist/win-unpacked/resources/app.asar`: **203,438 bytes**, SHA-256 **707A4FC567AC27B817618FBDE7A9EE6B261B32BE9EE989A4EB2526905DB2D1C3**. All **14 runtime source files** were read back and matched exactly. The accompanying `Synapses.exe` has version metadata 0.1.3.0 and SHA-256 **112151F5CDAAF273C7C988448D6F7328086923CA6D14A33D5633A01164A9E81D**. CI builds its installer separately and publishes that build's own checksum.

The actual fresh-profile source smoke confirmed the narrow seven-method `synapsesDesktopVoice` API is available in the trusted Windows renderer while `require`, `process` and the local window-control bridge remain absent. Sandbox/context isolation are enabled; hash navigation, maximize/restore and tray hide/restore/Quit checks passed. The configured remote preload is only `src/desktop-voice-preload.cjs`; current Electron omitted its legacy `preload` field from the preference getter, so the smoke verifies the actual exposed capability and the archive/source checks verify the configured file.

The final packaged fresh-profile smoke also passed those checks, with evidence at ignored `.preview/pc-voice-0.1.3-packaged-verified/smoke.json`. It caught and verified a corrected startup race: document generations now preserve visibility across hash/pushState changes while required CSS is pending, and optional voice-client setup cannot block the app surface.

PC voice is off by default. Background capture/throttling exceptions require the current explicit lease plus a live-track report. Native start consent, microphone permission and the existing account gate are retained. Stop, logout, navigation, renderer loss and Quit revoke it. Raw accepted ASR commands, never model replies, feed the restricted native browser parser. Cached pages lacking the versioned ASR hook must reload.

No physical microphone, live ASR session or real browser-opening voice command was exercised. Client tracks, browser launch and cleanup are simulated in the relevant fixtures; the real smoke checks the native capability boundary and window/tray lifecycle. No computer-use tools or installed user profile were used by these checks.

## Earlier local backups

Local backup installer: `dist/Synapses-Setup-0.1.0.exe`

Verified tray-base source/release target: **0.1.3** / **desktop-v0.1.3**. The existing local installer backup below remains 0.1.0. The 0.1.3 local build used `--dir` only; the installer is built separately by release CI.

The verified tray-base `dist/win-unpacked/resources/app.asar` is **173,024 bytes**, SHA-256 **02EAD98971A2B1BF90FA29BDC2C5B9F6F110183EB9EA61236BAEE062025FCDAD**. Packaged identity is 0.1.3, and all nine runtime source files were read back and matched exactly. The accompanying `Synapses.exe` has version metadata 0.1.3.0 and SHA-256 **D27936035B8689BAEFA775030CFFCE72E5C3C642CF5A8513439F4A1A5890DB9A**.

Thirteen policy/lifecycle tests passed. The final tray-base packaged fresh-profile smoke confirmed voice cleanup before X hides the window, a retained tray and document, click/double-click/Open menu restore, second-instance handler restore and explicit Quit completion. Voice cleanup was stubbed; no real microphone was used. Unit regressions cover cleanup failure, restore-versus-hide races, canceled Quit recovery and bounded explicit-Quit cleanup.

The final fresh-profile packaged smoke passed: four accessible local buttons, actual maximize/restore IPC, no remote Node/preload/native bridge, and the remote view visible both before and after hash navigation. Six policy groups pass, including the guard that prevents same-document navigation from hiding the app. An independent handler-only fixture confirmed production drawer/top-bar functions; the separate hidden `sendInputEvent` diagnostic did not deliver the expected center click and is not counted as pointer-hit verification. No computer-use tools or installed user profile were used by these tests.

- Version: **0.1.0**
- Size: **121,534,176 bytes** (115.9 MiB)
- SHA-256: **10C241B8BE4C5A698AE9BDDF014809042869AD27A3B904D18A5681EA01C70E53**
- Platform: Windows **x64** application payload in an NSIS installer
- Product/company/description: **Synapses**
- Authenticode: **NotSigned**, as intended for this preview
- Runtime: Electron **45.4.1**; packager: electron-builder **26.18.0**

The real NSIS build completed successfully, and 7-Zip archive testing reported `Everything is Ok`. The application executable contains Synapses product/company metadata and the approved favicon converted to ICO. The app archive's JavaScript, local header HTML/CSS, preload and icon assets were read back and exactly matched the final source files.

Six security test groups passed: exact HTTPS host boundaries, validated external links, first-party audio-only permission requests, local-main-frame-only window IPC, app export download boundaries and same-document navigation preservation.

Both source and packaged executable smoke tests loaded the full public `https://synapses.cloud/` site in an isolated profile. Actual local-header maximize and restore IPC succeeded. Remote-page evaluation found `require`, `process` and the local window bridge undefined. Last web preferences confirmed sandbox/context isolation enabled, Node integration disabled and no remote preload. The remote view bounds were 1320 × 828 below the 32px local titlebar. The smoke test closed through the native close bridge. Evidence is under ignored `.preview/packaged/`.

An additional isolated Electron permission probe used a **synthetic fake audio device**, with no real microphone capture. With the permission check handler always false, both calls reached the permission request handler: a denied call returned `NotAllowedError`; an approved call returned one audio track, which was immediately stopped. This verifies the intentional request-consent path without claiming an end-to-end physical microphone test. Evidence is `.preview/permission-probe.json`.

No installer was run, no user account was signed in, and no real voice call, external OAuth callback, installation or uninstallation was tested. The app requires the hosted service and internet. It is not an offline model or a code-signed production release.

## CI release preparation

`ci/publish-desktop.yml` is a prepared workflow for copying to the host repository's `.github/workflows/`. It expects this project at `desktop/`. A Linux preparation job checks out and validates the matching version tag, then archives only `HEAD:desktop`. Windows downloads and extracts this archive without any Git checkout/index, because Windows Git rejects an unrelated reserved filename even with sparse checkout. It builds with Node 24 and transfers only the installer/checksum/manifest/release notes to a separate publishing job. Only Linux preparation has repository read permission; the Windows build has no repository token permissions; publishing has repository contents write permission and uses only the temporary workflow token.

Publishing creates a draft first, uploads verified assets, then marks it as a prerelease. A rerun will not replace an already public release for the same version. The corrected CI workflow was parsed and its archive-transfer/permission boundaries checked locally; it has not been run or published by this task. A CI rebuild has its **own** installer hash, which must be used for the public download rather than the local backup hash above.
