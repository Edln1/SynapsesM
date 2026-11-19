Synapses Desktop 0.1.11 preview handles DoorDash location follow-ups and unavailable listings.

- Clear commands such as opening DoorDash or searching Google navigate directly in the Ava browser without waiting for a model response.
- Say “Search for McDonald’s on DoorDash and go there” to search inside DoorDash and open a matching listing. If no matching branch appears, Ava can open DoorDash’s McDonald’s brand page, where you can select your location.
- Ava verifies the listing destination. If DoorDash requests a security check, the browser stays on that check for you to complete.
- “Any one” and “the closest one” can continue a recent restaurant search in the same PC voice session. Ava uses distances shown by DoorDash when available and tries another observed match if a listing is missing.
- A verified listing opening gets a confirmation. If a later step fails, Ava says what opened and what it could not verify.
- Page questions use the visible browser page or foreground window and can complete from observed content alone.
- Invalid tool arguments from the planner get a bounded correction and model fallback. The executor still validates public addresses and observed app and control references.

- Turn on **Start PC voice** in the tray or Ava menu. Normal speech-to-speech remains separate.
- Ask naturally to open an installed app, move a window to another monitor, or select a named visible control in your current app.
- The controller discovers apps and Windows accessibility controls. Codex, Steam and installed Steam games can be resolved from the actual catalog.
- A separate controlled browser can read public pages, search, select observed results and verify media playback. YouTube playback is reported only when playback is observed.
- The existing model service plans one step at a time, receives tool results and checks progress. No additional API key is bundled or required.
- Native consent describes PC control and the app/window/page information needed by the model. Password fields are excluded; consequential controls require a separate concrete confirmation.
- The model cannot execute arbitrary shell commands or JavaScript. Native tools accept only validated actions and observed references. Some custom interfaces, canvases and elevated windows are unsupported.
- Stop PC voice, sign out or Quit to revoke control. Pending work is canceled; tasks have step and time limits. Idle browser playback can remain open after Stop.
- PC replies wait for speech completion before recording again. Visible voice captions stay aligned when the app is resized.
- X hides Synapses to the tray. Start PC voice preserves the current window state. Quit exits the app.

This is an unsigned Windows x64 preview using the hosted Synapses service. It does not provide universal or error-free PC control. The adjacent checksum and release manifest describe the exact CI-built installer. Model tests, native fixtures and build checks do not establish successful physical microphone capture or reliable behavior in every target application.
