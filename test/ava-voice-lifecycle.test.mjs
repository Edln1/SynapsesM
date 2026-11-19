import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
function extract(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing production source boundary: ${start}`);
  return html.slice(from, to);
}
const lifecycle = extract('  // AVA_MIC_LIFECYCLE_START', '  // AVA_MIC_LIFECYCLE_END');
const recovery = extract('  var _reacquiringMic = false;', '  setInterval(function() {');
const stopping = extract('  function stopAll() {', '  window._stsStopAll = stopAll;');

test('Ava app mode immediately docks the original waveform on activation and restores the mic on stop', () => {
  const states = [], dock = [];
  const document = {
    documentElement: { classList: { contains: name => name === 'ava-app-mode' } },
    body: { classList: { toggle() {} } }, getElementById: () => null
  };
  const window = { document, avaAppEntry: { refresh: () => dock.push(window._topNavVoiceActive) } };
  const context = vm.createContext({ document, window, TOP_BAR_HIDDEN: true, btnState: state => states.push(state) });
  vm.runInContext(extract('  function _setTopNavVoiceActive(v)', '  // True while Ava'), context);
  context._setTopNavVoiceActive(true);
  context._setTopNavVoiceActive(true);
  context._setTopNavVoiceActive(false);
  assert.deepEqual(states, ['listen', 'off']);
  assert.deepEqual(dock, [true, false]);
});

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function stream({ enabled = true } = {}) {
  const track = { enabled, readyState: 'live', stops: 0,
    stop() { this.stops++; this.readyState = 'ended'; } };
  return { track, getTracks: () => [track], getAudioTracks: () => [track] };
}
function setup() {
  const requests = [], messages = [], errors = [], timers = [];
  const context = vm.createContext({
    window: { _stream: null }, _on: true, _stream: null,
    navigator: { mediaDevices: { getUserMedia(constraints) {
      const pending = deferred(); requests.push({ ...pending, constraints }); return pending.promise;
    } } },
    console: { error: (...args) => errors.push(args), warn() {} },
    toast: message => messages.push(message), toastHide() {},
    _teardownBargeAnalyser() {}, _abortAllTurnRequests() {},
    _setTopNavVoiceActive(value) { context.window._topNavVoiceActive = value; },
    _voiceTurnId: 0, _recordTimer: null, _recorder: null,
    _busy: false, _busySince: 0, _ttsBusy: false, _bargeTurnActive: false,
    _chunks: [], _toastFull: '', btnState() {}, record() {},
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  });
  vm.runInContext(lifecycle + '\n' + recovery + '\n' + stopping, context);
  return { context, requests, messages, errors, timers };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }

test('watchdog recovery does not duplicate an initial capture request or its ready callback', async () => {
  const f = setup(), pending = f.context._acquireMic();
  assert.equal(f.context._acquireMic(), pending);
  f.context._reacquireMic();
  assert.equal(f.requests.length, 1);
  const mic = stream(); f.requests[0].resolve(mic);
  assert.equal(await pending, mic); await settle();
  assert.equal(f.context._stream, mic); assert.equal(f.context.window._stream, mic);
  assert.equal(f.timers.filter(timer => timer.delay === 300).length, 0);
});

test('actual watchdog recovery schedules recording for its own current acquisition', async () => {
  const f = setup(); f.context._reacquireMic();
  const mic = stream(); f.requests[0].resolve(mic); await settle();
  assert.equal(f.context._stream, mic); assert.equal(f.context._reacquiringMic, false);
  assert.equal(f.timers.filter(timer => timer.delay === 300).length, 1);
});

test('actual stopAll invalidates pending capture and stops its late returned tracks', async () => {
  const f = setup(), pending = f.context._acquireMic();
  f.context.stopAll();
  const mic = stream(); f.requests[0].resolve(mic);
  assert.equal(await pending, null);
  assert.equal(mic.track.stops, 1);
  assert.equal(f.context._stream, null); assert.equal(f.context.window._stream, null);
  assert.equal(f.context._on, false);
});

test('rapid stop/start waits for the old permission request before requesting capture again', async () => {
  const f = setup(), first = f.context._acquireMic();
  f.context.stopAll(); f.context._on = true;
  const second = f.context._acquireMic();
  assert.equal(f.requests.length, 1, 'Pending native capture requests must not overlap');
  const stale = stream(); f.requests[0].resolve(stale);
  assert.equal(await first, null); await settle();
  assert.equal(stale.track.stops, 1); assert.equal(f.requests.length, 2);
  const current = stream(); f.requests[1].resolve(current);
  assert.equal(await second, current); assert.equal(current.track.stops, 0);
  assert.equal(f.context._stream, current); assert.equal(f.context._on, true);
});

test('an old rejection and old error handler cannot stop or toast over a restarted session', async () => {
  const f = setup(), generation = f.context._micSessionGeneration;
  const first = f.context._acquireMic();
  f.context.stopAll(); f.context._on = true;
  const second = f.context._acquireMic();
  const error = Object.assign(new Error('old capture ended'), { name: 'NotReadableError' });
  f.requests[0].reject(error);
  assert.equal(await first, null); await settle();
  const current = stream(); f.requests[1].resolve(current); await second;
  f.context._micCaptureFailed(error, generation);
  assert.equal(f.context._on, true); assert.equal(current.track.stops, 0);
  assert.deepEqual(f.messages, []); assert.deepEqual(f.errors, []);
});

test('actual recovery does not restart recording after the session was stopped', async () => {
  const f = setup(); f.context._reacquireMic(); f.context.stopAll();
  const stale = stream(); f.requests[0].resolve(stale); await settle();
  assert.equal(stale.track.stops, 1); assert.equal(f.context._reacquiringMic, false);
  assert.equal(f.timers.filter(timer => timer.delay === 300).length, 0);
});

test('an unusable owned stream is stopped before requesting its replacement', async () => {
  const f = setup(), previous = stream({ enabled: false });
  f.context._stream = previous; f.context.window._stream = previous;
  const pending = f.context._acquireMic();
  assert.equal(previous.track.stops, 1); assert.equal(f.context._stream, null);
  const current = stream(); f.requests[0].resolve(current); await pending;
  f.context.stopAll();
  assert.equal(current.track.stops, 1); assert.equal(f.context.window._stream, null);
});

test('a replaced owned stream is also stopped when a current acquisition resolves', async () => {
  const f = setup(), pending = f.context._acquireMic(), replaced = stream();
  f.context._stream = replaced; f.context.window._stream = replaced;
  const current = stream(); f.requests[0].resolve(current); await pending;
  assert.equal(replaced.track.stops, 1); assert.equal(f.context._stream, current);
});

test('capture failure stops the session without claiming another app or retrying capture', async () => {
  const f = setup(), generation = f.context._micSessionGeneration;
  const pending = f.context._acquireMic();
  const error = Object.assign(new Error('capture device failed'), { name: 'NotReadableError' });
  f.requests[0].reject(error);
  await assert.rejects(pending, /capture device failed/);
  f.context._micCaptureFailed(error, generation); await settle();
  assert.equal(f.context._on, false); assert.equal(f.requests.length, 1);
  assert.match(f.messages[0], /Could not start microphone capture/);
  assert.doesNotMatch(f.messages[0], /another app/);
});

test('permission denial retains the existing permission gate and never opens a fallback capture', async () => {
  const f = setup(), generation = f.context._micSessionGeneration;
  const pending = f.context._acquireMic();
  const error = Object.assign(new Error('permission denied'), { name: 'NotAllowedError' });
  f.requests[0].reject(error); await assert.rejects(pending, /permission denied/);
  f.context._micCaptureFailed(error, generation); await settle();
  assert.match(f.messages[0], /allow microphone access/);
  assert.equal(f.requests.length, 1); assert.equal(f.requests[0].constraints.video, false);
});

test('voice pipeline failure is reported separately and releases the opened microphone', async () => {
  const f = setup(), mic = stream(); f.context._stream = mic; f.context.window._stream = mic;
  f.context._runMicReady(f.context._micSessionGeneration, () => {
    throw Object.assign(new Error('recorder initialization failed'), { name: 'NotReadableError' });
  });
  assert.equal(f.errors[0][0], 'Voice initialization error:');
  assert.match(f.messages[0], /Microphone opened, but voice could not start/);
  assert.equal(mic.track.stops, 1); assert.equal(f.context._on, false);
});

test('a stale ready callback cannot initialize a newer session', () => {
  const f = setup(), generation = f.context._micSessionGeneration;
  f.context.stopAll(); f.context._on = true;
  let started = 0; f.context._runMicReady(generation, () => { started++; });
  assert.equal(started, 0);
});
