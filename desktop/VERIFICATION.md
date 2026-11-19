# Synapses Windows preview verification — 19 November 2026

Local backup installer: `dist/Synapses-Setup-0.1.0.exe`

- Version: **0.1.0**
- Size: **121,534,176 bytes** (115.9 MiB)
- SHA-256: **10C241B8BE4C5A698AE9BDDF014809042869AD27A3B904D18A5681EA01C70E53**
- Platform: Windows **x64** application payload in an NSIS installer
- Product/company/description: **Synapses**
- Authenticode: **NotSigned**, as intended for this preview
- Runtime: Electron **45.4.1**; packager: electron-builder **26.18.0**

The real NSIS build completed successfully, and 7-Zip archive testing reported `Everything is Ok`. The application executable contains Synapses product/company metadata and the approved favicon converted to ICO. The app archive's JavaScript, local header HTML/CSS, preload and icon assets were read back and exactly matched the final source files.

Five security test groups passed: exact HTTPS host boundaries, validated external links, first-party audio-only permission requests, local-main-frame-only window IPC and app export download boundaries.

Both source and packaged executable smoke tests loaded the full public `https://synapses.cloud/` site in an isolated profile. Actual local-header maximize and restore IPC succeeded. Remote-page evaluation found `require`, `process` and the local window bridge undefined. Last web preferences confirmed sandbox/context isolation enabled, Node integration disabled and no remote preload. The remote view bounds were 1320 × 828 below the 32px local titlebar. The smoke test closed through the native close bridge. Evidence is under ignored `.preview/packaged/`.

An additional isolated Electron permission probe used a **synthetic fake audio device**, with no real microphone capture. With the permission check handler always false, both calls reached the permission request handler: a denied call returned `NotAllowedError`; an approved call returned one audio track, which was immediately stopped. This verifies the intentional request-consent path without claiming an end-to-end physical microphone test. Evidence is `.preview/permission-probe.json`.

No installer was run, no user account was signed in, and no real voice call, external OAuth callback, installation or uninstallation was tested. The app requires the hosted service and internet. It is not an offline model or a code-signed production release.

## CI release preparation

`ci/publish-desktop.yml` is a prepared workflow for copying to the host repository's `.github/workflows/`. It expects this project at `desktop/`, uses Windows sparse checkout of that subtree to avoid unrelated Windows-reserved filenames, verifies `desktop-v<version>` against `package.json`, builds with Node 24, and transfers only the installer/checksum/manifest/release notes to a separate publishing job. Build permissions are read-only; publishing has repository contents write permission and uses only the temporary workflow token.

Publishing creates a draft first, uploads verified assets, then marks it as a prerelease. A rerun will not replace an already public release for the same version. The CI workflow was parsed and its permission/sparse-checkout boundaries checked locally; it has not been run or published by this task. A CI rebuild has its **own** installer hash, which must be used for the public download rather than the local backup hash above.
