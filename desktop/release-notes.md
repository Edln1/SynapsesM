Synapses Desktop 0.1.16 preview verifies the DoorDash item before cart confirmation.

- “Add an Egg McMuffin to my cart” uses the menu in the Ava browser. Ava stops for ambiguous items. Changed item details require a fresh confirmation.
- The general planner can browse DoorDash. Cart changes use a separate exact-item workflow. You review and place the order in DoorDash.
- A temporary rate limit specific to the primary planner model can use the other configured model once.

- Ava rechecks the page after a DoorDash redirect before reporting whether it opened. If the requested restaurant is already open, Ava uses that page for the next menu request.
- If an item request starts before a delivery location is selected, Ava searches DoorDash for the restaurant and tries an available location. It uses the restaurant’s menu search when the exact item is not already visible.
- Say “Open DoorDash, go to McDonald’s, and open an Egg McMuffin” to open the item in one request. Ava uses the locations and items shown on DoorDash. An open request stops at the menu item.
- On an open DoorDash store page, say “Order an Egg McMuffin” to continue from that store and review adding it to the cart.
- After opening DoorDash, say “Go to McDonald’s” to continue in that browser. Ava uses the restaurant listings DoorDash shows.
- Say “Order a Big Mac from McDonald’s” or name another restaurant and item on DoorDash. Ava opens the matching menu item and asks before adding it when a clear Add button is available. Review the cart and finish checkout in DoorDash.
- If a PC voice task is interrupted, Ava stops working and leaves the browser open for you to continue.
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
- Stop PC voice, sign out or Quit to revoke control. Pending work is canceled. Tasks have step and time limits.
- PC replies wait for speech completion before recording again. Visible voice captions stay aligned when the app is resized.
- X hides Synapses to the tray. Start PC voice preserves the current window state. Quit exits the app.

This is an unsigned Windows x64 preview using the hosted Synapses service. It does not provide universal or error-free PC control. The adjacent checksum and release manifest describe the exact CI-built installer. Model tests, native fixtures and build checks do not establish successful physical microphone capture or reliable behavior in every target application.
