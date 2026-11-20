'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createTrayTypingMode } = require('../src/tray-typing-mode.cjs');

function fixture() {
  let windowOpen = false;
  const events = [];
  const mode = createTrayTypingMode({
    openCommand() {
      events.push(windowOpen ? 'focus command' : 'open command');
      windowOpen = true;
    },
    closeCommand() {
      events.push('close command');
      windowOpen = false;
    },
    openSynapses: () => events.push('open Synapses'),
    onChange: () => events.push(mode.isEnabled() ? 'enable' : 'disable')
  });
  return { mode, events, closeFromWindow: () => { windowOpen = false; } };
}

test('tray click opens the main app until typing is enabled', () => {
  const { mode, events } = fixture();
  assert.equal(mode.isEnabled(), false);
  mode.click();
  mode.enable();
  mode.enable();
  mode.click();
  assert.deepEqual(events, ['open Synapses', 'enable', 'open command', 'focus command', 'focus command']);
});

test('closing the command window keeps its tray shortcut active', () => {
  const { mode, events, closeFromWindow } = fixture();
  mode.enable();
  closeFromWindow();
  assert.equal(mode.isEnabled(), true);
  mode.click();
  assert.deepEqual(events, ['enable', 'open command', 'open command']);
});

test('disabling typing closes the command window and restores tray clicks to the main app', () => {
  const { mode, events } = fixture();
  mode.enable();
  mode.disable();
  mode.disable();
  assert.equal(mode.isEnabled(), false);
  mode.click();
  assert.deepEqual(events, ['enable', 'open command', 'close command', 'disable', 'open Synapses']);
});
