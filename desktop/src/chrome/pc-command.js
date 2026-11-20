'use strict';

const form = document.getElementById('pcCommandForm');
const input = document.getElementById('pcCommandInput');
const submit = document.getElementById('pcCommandRun');
const cancel = document.getElementById('pcCommandCancel');
const status = document.getElementById('pcCommandStatus');
const commands = window.synapsesPcCommand;
let running = false;

function syncControls() {
  input.readOnly = running;
  submit.disabled = running || !input.value.trim();
  cancel.hidden = !running;
}

input.addEventListener('input', syncControls);
form.addEventListener('submit', async event => {
  event.preventDefault();
  const command = input.value.trim();
  if (running || !command) return;
  running = true;
  cancel.disabled = false;
  syncControls();
  status.textContent = 'Working…';
  try {
    const result = await commands.run(command);
    if (result.ok) input.value = '';
    status.textContent = result.message;
  } catch {
    status.textContent = 'The PC command could not finish. Try again.';
  } finally {
    running = false;
    syncControls();
    if (document.hasFocus()) {
      input.focus();
      if (input.value) input.select();
    }
  }
});

cancel.addEventListener('click', async () => {
  cancel.disabled = true;
  if (running) status.textContent = 'Canceling…';
  try { await commands.cancel(); } catch {
    if (!running) return;
    cancel.disabled = false;
    status.textContent = 'Could not cancel the command. Try again.';
  }
});

commands.onProgress(message => { if (running) status.textContent = message; });
commands.onFocusInput(() => { if (!running) input.focus(); });
