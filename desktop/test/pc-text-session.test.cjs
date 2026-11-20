'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPcTextSession } = require('../src/pc-text-session.cjs');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function fixture() {
  const frame = {};
  const state = { voice: false, frame, account: { userId: 'account_1', frame }, verifies: 0, cancels: 0 };
  const calls = [];
  let id = 0;
  const session = createPcTextSession({
    verifyAccount() { state.verifies++; return state.verify ? state.verify() : state.account; },
    isDocumentCurrent(account) { return account.frame === state.frame; },
    voiceInUse: () => state.voice,
    runTask(text, options) {
      calls.push({ text, options, lease: session.currentLease() });
      return state.run ? state.run(text, options) : { handled: true, ok: true, message: 'Opened it.' };
    },
    cancelTask() { state.cancels++; },
    makeId: () => `typed-${++id}`
  });
  return { state, calls, session };
}

test('validates typed input before account verification or control work', async () => {
  const { state, calls, session } = fixture();
  for (const text of [null, '', '  ', 'line\nbreak', 'control\u007f', 'x'.repeat(1001)]) {
    assert.match((await session.run(text)).message, /up to 1,000 characters on one line/);
  }
  state.voice = true;
  assert.match((await session.run('Open YouTube')).message, /Stop PC Voice/);
  assert.equal(state.verifies, 0);
  assert.equal(calls.length, 0);
});

test('requires an account and rechecks voice ownership after verification', async () => {
  const { state, calls, session } = fixture();
  state.account = null;
  assert.match((await session.run('Open YouTube')).message, /Sign in/);
  const verify = deferred();
  state.verify = () => verify.promise;
  const first = session.run('Open YouTube');
  assert.deepEqual(session.state(), { busy: true, active: false });
  assert.match((await session.run('Open Steam')).message, /already running/);
  state.voice = true;
  verify.resolve({ userId: 'account_1', frame: state.frame });
  assert.match((await first).message, /Stop PC Voice/);
  assert.equal(calls.length, 0);
  assert.deepEqual(session.state(), { busy: false, active: false });
});

test('uses one verified account-scoped conversation ID while each turn has its own active lease', async () => {
  const { state, calls, session } = fixture();
  assert.deepEqual(await session.run('  Open YouTube  '), { ok: true, message: 'Opened it.' });
  assert.deepEqual(await session.run('yes'), { ok: true, message: 'Opened it.' });
  assert.equal(calls[0].text, 'Open YouTube');
  assert.equal(calls[1].text, 'yes');
  assert.equal(calls[0].options.voiceSessionId, calls[1].options.voiceSessionId);
  assert.notEqual(calls[0].lease, calls[1].lease);
  assert.equal(calls[0].lease.frame, state.frame);
  assert.equal(calls[0].lease.userId, 'account_1');
  assert.equal(session.currentLease(), null);

  state.account = { userId: 'another', frame: state.frame };
  await session.run('Open Steam');
  assert.notEqual(calls[1].options.voiceSessionId, calls[2].options.voiceSessionId);
  assert.equal(calls[2].options.userId, 'another');
  assert.equal(state.cancels, 1);
});

test('canceling verification drops the eventual response without touching the runner', async () => {
  const { state, calls, session } = fixture();
  const verify = deferred();
  state.verify = () => verify.promise;
  const run = session.run('Open Steam');
  assert.equal(session.cancel(), true);
  assert.match((await run).message, /stopped/);
  verify.resolve(state.account);
  await Promise.resolve();
  assert.equal(calls.length, 0);
  assert.equal(state.cancels, 0);
});

test('cancel revokes the active tool lease and follow-up state before a new command', async () => {
  const { state, calls, session } = fixture();
  const execution = deferred();
  state.run = () => execution.promise;
  const first = session.run('Open Steam');
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.active(), true);
  assert.equal(session.currentLease(), calls[0].lease);
  assert.equal(session.cancel(), true);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(session.currentLease(), null);
  assert.equal(state.cancels, 1);
  assert.match((await first).message, /stopped/);
  state.run = null;
  await session.run('Open YouTube');
  execution.resolve({ handled: true, ok: true, message: 'Stale result.' });
  assert.notEqual(calls[0].options.voiceSessionId, calls[1].options.voiceSessionId);
});

test('a different main document invalidates an outstanding lease and drops stale success', async () => {
  const { state, calls, session } = fixture();
  const execution = deferred();
  state.run = () => execution.promise;
  const command = session.run('Open Steam');
  await new Promise(resolve => setImmediate(resolve));
  state.frame = {};
  assert.equal(session.active(), false);
  execution.resolve({ handled: true, ok: true, message: 'Stale result.' });
  assert.match((await command).message, /stopped/);
  assert.equal(calls[0].options.signal.aborted, true);
  assert.equal(state.cancels, 1);
});

test('returns the existing planner outcome as text without an unhandled reply', async () => {
  const { state, session } = fixture();
  state.run = () => ({ handled: true, ok: false, message: 'The action was not approved.' });
  assert.deepEqual(await session.run('Open Steam'), { ok: false, message: 'The action was not approved.' });
  state.run = () => ({ handled: false, ok: false, message: '' });
  assert.match((await session.run('yes')).message, /Tell Ava what to do on your PC/);
});
