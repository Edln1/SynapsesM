'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { createPcCommandWindow, PC_COMMAND_URL } = require('../src/pc-command-window.cjs');

function fixture({ run } = {}) {
  const handlers = new Map();
  const windows = [];
  const commands = [];
  const messages = [];
  let cancellations = 0;
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.visible = false;
      this.minimized = false;
      this.destroyed = false;
      this.focuses = 0;
      this.webContents = Object.assign(new EventEmitter(), {
        isDestroyed: () => this.destroyed,
        mainFrame: { url: '' },
        send: (channel, message) => messages.push([channel, message]),
        setWindowOpenHandler: handler => { this.handleOpen = handler; }
      });
      windows.push(this);
    }

    async loadURL(url) { this.webContents.mainFrame.url = url; }
    show() { this.visible = true; }
    focus() { this.focuses++; }
    close() { this.destroy(); }
    restore() { this.minimized = false; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    isVisible() { return this.visible; }
    isMinimized() { return this.minimized; }
    isDestroyed() { return this.destroyed; }
  }
  const controller = createPcCommandWindow({
    BrowserWindow: FakeWindow,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: channel => handlers.delete(channel) },
    icon: 'icon.ico',
    run: command => { commands.push(command); return run ? run(command) : { ok: true, message: 'Done.' }; },
    cancel: () => { cancellations++; }
  });
  function sender(win) {
    return { sender: win.webContents, senderFrame: win.webContents.mainFrame };
  }
  return { handlers, windows, commands, messages, controller, sender, cancellations: () => cancellations };
}

test('the tray command surface opens independently and only its exact visible top-level document can run commands', async () => {
  const f = fixture();
  const win = f.controller.open();
  const run = f.handlers.get('pc-command:run');
  assert.equal(win.options.parent, undefined);
  assert.deepEqual(
    [win.options.show, win.options.webPreferences.nodeIntegration, win.options.webPreferences.contextIsolation, win.options.webPreferences.sandbox],
    [false, false, true, true]
  );
  assert.equal(win.webContents.mainFrame.url, PC_COMMAND_URL);
  assert.equal(f.controller.dialogParent(), null);
  assert.equal((await run(f.sender(win), 'Open YouTube')).ok, false);
  win.emit('ready-to-show');
  assert.equal(f.controller.dialogParent(), win);
  assert.equal(f.controller.open(), win);
  assert.equal(f.windows.length, 1);
  assert.equal(win.focuses, 2);
  assert.deepEqual(win.handleOpen(), { action: 'deny' });

  await assert.rejects(run({ sender: {}, senderFrame: win.webContents.mainFrame }, 'Open YouTube'), /Untrusted/);
  await assert.rejects(run({ sender: win.webContents, senderFrame: { url: PC_COMMAND_URL } }, 'Open YouTube'), /Untrusted/);
  win.webContents.mainFrame.url = PC_COMMAND_URL + '?other=1';
  await assert.rejects(run(f.sender(win), 'Open YouTube'), /Untrusted/);
  win.webContents.mainFrame.url = PC_COMMAND_URL;
  assert.equal((await run(f.sender(win), '   ')).ok, false);
  assert.equal((await run(f.sender(win), 'x'.repeat(1001))).ok, false);
  assert.equal((await run(f.sender(win), 'Open\nYouTube')).ok, false);
  assert.deepEqual(await run(f.sender(win), '  Open YouTube  '), { ok: true, message: 'Done.' });
  assert.deepEqual(f.commands, ['Open YouTube']);
});

test('closing or canceling a running command revokes it once and suppresses late results', async () => {
  let finish;
  const f = fixture({ run: () => new Promise(resolve => { finish = resolve; }) });
  const win = f.controller.open();
  win.emit('ready-to-show');
  const run = f.handlers.get('pc-command:run');
  const cancel = f.handlers.get('pc-command:cancel');
  const first = run(f.sender(win), 'Open YouTube');
  f.controller.setProgress('running-tool');
  assert.deepEqual(f.messages, [['pc-command:progress', 'Working on your PC…']]);
  assert.equal((await run(f.sender(win), 'Open Wikipedia')).ok, false);
  assert.equal(cancel(f.sender(win)), true);
  f.controller.setProgress('observing');
  f.controller.close();
  finish({ ok: true, message: 'Late success.' });
  assert.deepEqual(await first, { ok: false, message: 'Command canceled.' });
  assert.equal(f.cancellations(), 1);
  assert.equal(f.messages.length, 1);
  assert.equal(f.controller.dialogParent(), null);
  const reopened = f.controller.open();
  assert.notEqual(reopened, win);
  f.controller.destroy();
  assert.equal(reopened.isDestroyed(), true);
  assert.equal(f.handlers.size, 0);
  assert.equal(f.controller.open(), null);
});

test('closing an idle command surface clears its follow-up context and can reopen', async () => {
  const f = fixture();
  const win = f.controller.open();
  win.emit('ready-to-show');
  await f.handlers.get('pc-command:run')(f.sender(win), 'Open YouTube');
  f.controller.close();
  assert.equal(f.cancellations(), 1);
  assert.notEqual(f.controller.open(), win);
});

test('typing remains available after a failed command and focus stays on the selected target app', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/chrome/pc-command.js'), 'utf8');
  const nodes = new Map();
  for (const id of ['pcCommandForm', 'pcCommandInput', 'pcCommandRun', 'pcCommandCancel', 'pcCommandStatus']) {
    const listeners = new Map();
    nodes.set(id, { listeners, addEventListener: (event, handler) => listeners.set(event, handler) });
  }
  let hasFocus = true;
  let result = { ok: false, message: 'Sign in to Synapses first.' };
  const commands = { run: async () => result, onProgress() {} };
  vm.runInNewContext(source, {
    document: { getElementById: id => nodes.get(id), hasFocus: () => hasFocus },
    window: { synapsesPcCommand: commands }
  });
  const input = nodes.get('pcCommandInput');
  let focused = 0;
  let selected = 0;
  input.focus = () => focused++;
  input.select = () => selected++;
  input.value = 'Open YouTube';
  const submit = nodes.get('pcCommandForm').listeners.get('submit');
  await submit({ preventDefault() {} });
  assert.equal(input.value, 'Open YouTube');
  assert.deepEqual([focused, selected], [1, 1]);
  hasFocus = false;
  result = { ok: true, message: 'Opened YouTube.' };
  await submit({ preventDefault() {} });
  assert.equal(input.value, '');
  assert.deepEqual([focused, selected], [1, 1]);
});
