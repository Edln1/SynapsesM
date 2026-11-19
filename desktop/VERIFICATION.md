# Synapses Windows preview verification — 19 November 2026

## 0.1.7 planner provider repair

The full desktop suite passes **127 tests with zero failures or skips**; independent review reran **29 planner/diagnostic tests**. A public, action-free request reproduced **HTTP 400 `output_parse_failed`** from `openai/gpt-oss-20b`. The existing service returned a valid strict-schema action from `openai/gpt-oss-120b`. These calls used public test wording without account identifiers, UI control or native actions.

The repaired client handles known format failures with one corrective 20B retry followed by one 120B strict-schema fallback, at most three attempts. Guest limits, upstream quotas, authentication, network and server errors are separately classified without retries. Caller attribution, cancellation, schema and all executor boundaries remain unchanged. Content-free diagnostics retain bounded HTTP status, fixed provider/model codes, attempt number and only a boolean for whether an account reference was present. Tests verify identity preservation, finite attempts, abort freshness, 5xx/HTML classification and privacy.

The local artifact is **319,332 bytes**, SHA-256 **E40DE21A05DA45D017B68F4CCDEBE95C1D360F6815219A9B8C7352BC2101EE5C**. The matching executable is **0.1.7.0**, SHA-256 **1CCA14B8E9D8A055832686EC414F95B37BC98A5FAB152142E20FFE2CC138A291**. All **23 runtime source files** match. Fresh-profile packaged smoke and the actual ASAR-to-hash-materialized-PS1 non-GUI self-test passed; PS1 is unchanged from 0.1.6. No own test processes remain. Evidence is `.preview/pc-agent-0.1.7-packaged/smoke.json` and `.preview/packaged-driver-selftest-result.json`. CI publishes its own installer checksum. Installed-user validation of this repair is still pending at packaging time.

## 0.1.6 model-planned PC tasks

The full desktop suite passes **119 tests with zero failures or skips**. Coverage includes the existing accepted-speech/native lease path plus structured planning, fixed tool argument mapping, observed-reference boundaries, native confirmations, cancellation races, unresolved failures, coherent bounded observations, Windows app/window/control fixtures and the isolated browser driver. The web suite remains at **134 passing tests** for the separately published voice/resize changes.

A real call to the existing hosted Groq proxy accepted the strict JSON schema. Live model tests with explicitly fake executors resolved an informal Codex launch request, and selected YouTube search-results navigation, an observed matching video, media playback, then completion. These tests establish planner behavior against fixtures; they did not open a real app or play a real video. A JSON-format provider rejection is retried once; rate-limit errors are not retried by this client.

Read-only Windows catalog discovery found the actual installed Codex identity (displayed by Windows as ChatGPT), Steam and Dota 2. The native PowerShell self-test loaded the actual UI Automation assemblies and compiled its Win32 helpers with the expected 40-byte x64 INPUT layout. It did not enumerate or inspect live windows, send input, launch apps or move windows. The fixed packaged script is read through ASAR-aware Node fs, hash-materialized and invoked with JSON stdin; model output is never executable script.

The local 0.1.6 unpacked artifact is `dist/win-unpacked/resources/app.asar`: **313,674 bytes**, SHA-256 **73E8AB7A81F4E7D6098C00FF015807B0D846D36FE11CBEB13C61CB3CEEA96BA8**. The matching executable SHA-256 is **7559797295FBB460E69B6248CEA0A3C89EE90ED21ECB9A2073398AE2A1C52FF8**, version **0.1.6.0**. CI builds its own installer and publishes a separate checksum.

All **23 packaged runtime source files** matched byte-for-byte, including the PowerShell script. The fresh-profile packaged shell smoke passed native controls, same-document visibility, tray/Quit and the read-only second-instance report. Actual packaged-ASAR require, hash materialization and the non-GUI driver self-test also passed; the 25,066-byte PS1 hash is **079890753BFE56A242BC337312E948C77D316C8CECF803C6F29216E8B6230CF5**. No unpacked runtime files are required, and no own test processes remain. Evidence is `.preview/pc-agent-0.1.6-packaged/smoke.json` and `.preview/packaged-driver-selftest-result.json`.

Physical microphone capture, reliable controls in arbitrary target apps, actual YouTube playback and DoorDash checkout have not been established by these fixture/model/build checks. Accessibility limits, custom canvases, elevated apps, provider limits and external-site changes remain material limitations. A successful native action requires observed readback; input delivery alone does not establish task completion.

After installing the frozen 0.1.6 build in the user's F: installation, the user reported that the requested flow worked. Its actual content-free diagnostic then recorded `complete`, step 3, `finish`, reason `none`; native voice recorded `command-complete` while enabled/listening stayed true. This is a real-user outcome in addition to the fixtures. No independent screen observation was performed, and this does not establish DoorDash checkout or reliable behavior in every application. The first installed attempt had a planner-service failure before a subsequent attempt completed, so provider reliability remains a limitation.

## 0.1.5 startup diagnostics

The desktop suite passes **68 tests with zero skips**. The real production Whisper/Flux accepted-ASR chain still reaches the real restricted host/parser in fixtures, including thirteen supported direct/polite, DoorDash and YouTube-search forms per provider with no language-model fallthrough. YouTube “play” requests honestly return search results rather than claiming playback. The portable test requires the tagged web source in CI and fails if it is absent. New tests execute the actual native permission handler: hidden microphone consent delayed by 2.5 seconds remains within the original 30-second grant, while Stop or expiry before approval denies it. Native grant lifetime was already retained through client return; no visibility or grant expansion was added.

Startup, capture permission, listening and stop events now persist only **version, time, enabled, listening, phase and stopReasonCode** in `pc-voice-status.json` under this app's user-data folder. Tests verify that neither the preload payload nor this file carries transcripts, URLs, search terms, account identifiers or session tokens. The first failure survives generic cleanup; a new attempt or successful listening resets recovered errors. `command-complete` is recorded only after the actual system-browser launch promise resolves, with no destination recorded.

Fixed command codes now distinguish missing target, invalid target, unsupported grammar, empty/nonpublic/failed/timed-out DNS, rejected browser launch and revoked lease. Tests exercise each failure without persisting injected error details. Command-only failures reset at the next command while genuine startup/stop failures stay primary. The shared hosted PC speech path separately verifies that playback completes before legacy recording resumes and Flux does not acquire a second legacy recorder.

The client exposes a separate read-only, bounded diagnostic getter of codes, booleans and timings. Simulated delayed-capture/error fixtures verify its startup lifecycle; they do not establish successful physical capture. The hosted speech provider/fallback implementation is verified separately in the web source. The parent observed the installed preview's host enabled/listening status, but a successful real spoken browser command remains unverified. The user's exact phrase “open YouTube” was already supported; added polite forms are broader test coverage, not an established explanation for that user's failure.

The new `--pc-voice-report` switch samples a fixed trusted-page expression into a strictly sanitized `pc-voice-runtime.json`. Its second-instance branch runs before restore; cold report-only startup creates no window. Tests reject unknown/private fields and verify only booleans, enumerated codes/configuration, numeric counters and the fixed speech-routing snapshot survive serialization. The next real-user report is needed to distinguish an effective-page/hook/provider/client gate from unsupported phrasing; simulated fixtures alone do not establish an end-to-end live session.

The final `--dir` build produced `dist/win-unpacked/resources/app.asar`: **224,170 bytes**, SHA-256 **C00038C844202AE0EE0ACAB465C87FE227F442C2748938E5716B0D24D3EBF779**. All **17 runtime source files** were read back and matched exactly. `Synapses.exe` is **249,979,904 bytes**, version **0.1.5.0**, company **Synapses**, SHA-256 **FAEA88D179BA11855D8486DBA7114404637DBFCD3E7F12B1831247E24E8B6278**. CI builds the installer separately and must publish its own checksum.

The packaged fresh-profile smoke passed, including the real native diagnostic file's exact six-field schema/version, seven-method Windows voice capability with no Node globals or window bridge, native maximize/restore, same-document visibility and tray lifecycle/Quit. A real second process requested `--pc-voice-report` and wrote the runtime snapshot while the primary's visibility, focus and minimized state stayed unchanged. The fresh snapshot reported hook version 1, `/v2/listen`, Flux, the repaired header and no service-worker controller; capture was off as expected. Evidence is ignored `.preview/pc-voice-0.1.5-final-packaged/smoke.json`. These checks use no installed user profile, computer-use tools or physical microphone.

## Earlier 0.1.4 tray-start correction

Fifty-one desktop tests pass with no failures or skips, independently rerun by the reviewer. Focused regressions preserve visible, hidden and minimized window states throughout tray Start, including a user changing state while startup awaits. Hidden consent is unparented; its completion must match the same current document, native generation, lease and unexpired startup allowance. Stop and setup timeout restore normal background throttling and hidden microphone denial.

The actual production Whisper and Flux accepted-ASR handlers were executed through the real hosted ask hook, packaged client, native host and parser into a simulated browser launcher. Plain “open YouTube,” “open browser” and “search for …” reach that launcher without falling through to the language model. A wake prefix remains optional. These fixtures use simulated audio tracks and browser launch, not a physical microphone or live speech recognition.

The final `--dir` build produced `dist/win-unpacked/resources/app.asar`: **206,809 bytes**, SHA-256 **DB97497B508CA641EEB8FAC69EF532FED37D3F9B3B3942BEC57A4835BA831025**. All **15 runtime source files** were read back and matched exactly. `Synapses.exe` is **249,979,904 bytes**, version **0.1.4.0**, company **Synapses**, SHA-256 **9CF300BCD6E4F4A578DA7621311CC2B710C2A64A4A59E5CBE3FFD50C50DE8682**. The installer is built separately by CI and must use that artifact's own checksum.

The packaged fresh-profile smoke passed. Its trusted remote renderer exposes exactly the seven-method Windows voice capability while Node globals and the separate window-control bridge remain absent. Sandbox and context isolation are enabled; native maximize/restore, same-document visibility and tray hide/restore/Open/second-instance/Quit checks pass. Evidence is under ignored `.preview/pc-voice-0.1.4-packaged/smoke.json`. The microphone/cleanup path is simulated, and this smoke does not assert real OS microphone capture or pointer hit-testing. No installed user profile or computer-use tool was used.

## Earlier 0.1.3 voice capability

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
