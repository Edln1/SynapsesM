Synapses Desktop 0.1.8 preview improves PC voice website and search routing.

- Clear commands such as opening DoorDash or searching Google navigate directly in the Ava browser without waiting for a model response.
- A search scoped to DoorDash opens DoorDash first and continues through its browser controls.
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
