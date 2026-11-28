import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function extract(start, end) {
  const from = html.indexOf(start), to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Missing production source boundary: ${start}`);
  return html.slice(from, to);
}
const lifecycle = extract('  // AVA_MIC_LIFECYCLE_START', '  // AVA_MIC_LIFECYCLE_END');
const recovery = extract('  var _reacquiringMic = false;', '  setInterval(function() {');
const watchdog = extract('  setInterval(function() {\n    if (!_on) { _busySince = 0; return; }', '  // ── Network flip recovery');
const foregroundRecovery = extract('    // Tab back: NEVER toast', '  } catch(eNet) {}');
const stopping = extract('  function stopAll() {', '  window._stsStopAll = stopAll;');

test('Ava app mode docks the mic immediately without claiming it is listening', () => {
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
  assert.deepEqual(states, ['off', 'off']);
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
function setup({ appMode = false } = {}) {
  const requests = [], messages = [], errors = [], timers = [], notices = [];
  const document = { documentElement: { classList: { contains: value => appMode && value === 'ava-app-mode' } } };
  const window = new EventTarget();
  window.document = document; window._stream = null;
  window.CustomEvent = class extends Event { constructor(name, options) { super(name); this.detail = options.detail; } };
  window.addEventListener('ava:voice-error', event => notices.push({ ...event.detail }));
  const context = vm.createContext({
    window, document, _on: true, _stream: null,
    navigator: { mediaDevices: { getUserMedia(constraints) {
      const pending = deferred(); requests.push({ ...pending, constraints }); return pending.promise;
    } } },
    console: { error: (...args) => errors.push(args), warn() {} },
    toast: message => messages.push(message), toastHide() {},
    _ensureBargeAnalyser() {}, _teardownBargeAnalyser() {}, _abortAllTurnRequests() {},
    _setTopNavVoiceActive(value) { context.window._topNavVoiceActive = value; },
    _voiceTurnId: 0, _recordTimer: null, _recorder: null,
    _busy: false, _busySince: 0, _ttsBusy: false, _bargeTurnActive: false, _bargingIn: false,
    _chunks: [], _toastFull: '', btnState() {}, record() {},
    setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; },
    clearTimeout() {},
  });
  vm.runInContext(lifecycle + '\n' + recovery + '\n' + stopping, context);
  return { context, requests, messages, errors, timers, notices };
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

test('returning to the Windows app keeps a long reply alive', () => {
  const f = setup();
  const handlers = new Map();
  let aborted = 0;
  f.context.document.addEventListener = (name, handler) => handlers.set(name, handler);
  f.context.window.synapsesDesktopVoice = {};
  Object.assign(f.context, {
    _busy: true, _ttsBusy: true, _busySince: Date.now() - 10000, _voiceTurnId: 42,
    _stream: stream(), _abortAllTurnRequests() { aborted++; },
  });
  vm.runInContext(foregroundRecovery, f.context);
  for (const visibility of ['hidden', 'visible']) {
    f.context.document.visibilityState = visibility;
    handlers.get('visibilitychange')();
  }
  assert.equal(aborted, 0);
  assert.equal(f.context._voiceTurnId, 42);
  assert.equal(f.context._ttsBusy, true);
});

test('the Windows app waits until a reply finishes before replacing the microphone', () => {
  const f = setup();
  let tick;
  f.context.window.synapsesDesktopVoice = {};
  Object.assign(f.context, {
    _busy: true, _ttsBusy: true, _busySince: Date.now() - 18000,
    _stream: stream({ enabled: false }),
    _actx: { currentTime: 6 }, _playbackTime: 9,
    setInterval(callback) { tick = callback; },
  });
  vm.runInContext(watchdog, f.context);
  tick();
  assert.equal(f.requests.length, 0);
  assert.equal(f.context._voiceTurnId, 0);
  assert.equal(f.context._ttsBusy, true);
  assert.ok(Date.now() - f.context._busySince < 1000);

  f.context._ttsBusy = false;
  f.context._busy = false;
  tick();
  assert.equal(f.requests.length, 1);
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

test('mobile permission denial emits an actionable notice without exposing raw media error details', async () => {
  const f = setup({ appMode: true });
  const generation = f.context._micSessionGeneration;
  const request = f.context._acquireMic();
  const error = Object.assign(new Error('Private native media details'), { name: 'NotAllowedError' });
  f.requests[0].reject(error);
  await assert.rejects(request);
  f.context._micCaptureFailed(error, generation);
  assert.equal(f.context._on, false);
  assert.equal(f.requests.length, 1);
  assert.equal(f.notices.length, 1);
  assert.deepEqual(Object.keys(f.notices[0]), ['message']);
  assert.match(f.notices[0].message, /mic(?:rophone)?|permission/i);
  assert.match(f.notices[0].message, /allow|settings|access/i);
  assert.doesNotMatch(f.notices[0].message, /Private native media details/);
});

test('the real mobile mic toggle gives an inline error when the WebView cannot acquire media', () => {
  const f = setup({ appMode: true });
  f.context._on = false;
  f.context.navigator.mediaDevices = null;
  f.context.location = { protocol: 'https:' };
  f.context.fetch = async () => ({ ok: true });
  f.context._desktopVoiceSpeechError = () => false;
  vm.runInContext(extract('  window.toggleTopNavVoice = function() {', '\n})();'), f.context);

  f.context.window.toggleTopNavVoice();

  assert.equal(f.context._on, false);
  assert.equal(f.context.window._topNavVoiceActive, false);
  assert.equal(f.requests.length, 0);
  const messages = f.notices.map(notice => notice.message).filter(Boolean);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /mic(?:rophone)?.*(?:support|start|access|capture)/i);
});

test('mobile Flux failure reports an inline error and releases the track if legacy recording cannot start', () => {
  const f = setup({ appMode: true }), mic = stream();
  f.context._stream = mic; f.context.window._stream = mic;
  let fluxStops = 0, legacyAttempts = 0;
  f.context.window._fluxSessionStop = () => { fluxStops++; };
  f.context.record = () => { legacyAttempts++; };
  vm.runInContext(extract('  function _desktopVoiceFluxFallback(', '  function _desktopVoiceSpeechError('), f.context);

  assert.equal(f.context._desktopVoiceFluxFallback(f.context._micSessionGeneration, 'asr_error'), true);
  assert.equal(fluxStops, 1);
  assert.equal(legacyAttempts, 1);
  assert.equal(mic.track.stops, 1);
  assert.equal(f.context._on, false);
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0].message, /(?:voice|speech recognition).*(?:start|listening)/i);
});

test('the original mobile waveform keeps its SVG and bar nodes across listening, PCM speech and analyser reset', () => {
  function node() {
    const attrs = new Map(), classes = new Set();
    return {
      style: {}, isConnected: true,
      classList: {
        add(...names) { names.forEach(name => classes.add(name)); },
        remove(...names) { names.forEach(name => classes.delete(name)); },
        contains(name) { return classes.has(name); }
      },
      setAttribute(name, value) { attrs.set(name, String(value)); }, getAttribute(name) { return attrs.get(name); },
      getBoundingClientRect() { return {}; }
    };
  }
  const mic = node(), wave = node(), group = node(), glow = node();
  const bars = Array.from({ length: 7 }, node), frames = [];
  wave.querySelectorAll = () => bars;
  wave.cloneNode = () => { throw Error('Ava mobile must keep the original waveform SVG'); };
  const ids = { topNavVoiceBtn: node(), tnvMicIcon: mic, tnvWaveIcon: wave, tnvBarsGroup: group, tnvGlowBlur: glow };
  const document = { getElementById: id => ids[id], documentElement: { classList: { contains: value => value === 'ava-app-mode' } } };
  const window = { document };
  const context = vm.createContext({
    document, window, _pcmWaveRaf: null, _wsAnalyserRaf: null, _analyserRaf: null, _actx: { currentTime: 0 },
    _pcmWaveQueue: [{ time: 0, sliceDur: 1, rms: [0, 1] }],
    requestAnimationFrame(callback) { frames.push(callback); return frames.length; }, cancelAnimationFrame() {}
  });
  vm.runInContext([
    extract('  function btnState(s) {', '  window._tnvBtnState = btnState;'),
    extract('function _drivePcmWaveform() {', '// Shared "speech has genuinely finished"'),
    extract('  function _stopAnalyser() {', '  // Exposed so the auto-brief announcer')
  ].join('\n'), context);

  context.btnState('listen');
  assert.equal(group.getAttribute('fill'), 'rgba(0,217,168,1)');
  context.btnState('speak');
  assert.match(group.getAttribute('fill'), /^(?:#a78bfa|rgb\(167,\s*139,\s*250\))$/i);
  context._drivePcmWaveform();
  assert.equal(group.getAttribute('fill'), 'rgb(34,211,238)');
  context._actx.currentTime = 1;
  frames.shift()();
  assert.equal(group.getAttribute('fill'), 'rgb(167,139,250)');
  context._stopAnalyser(); // While active, the PCM driver keeps ownership.
  assert.equal(group.getAttribute('fill'), 'rgb(167,139,250)');
  context._stopPcmWaveform();
  context._stopAnalyser();
  assert.equal(group.getAttribute('fill'), '#a78bfa');
  assert.equal(ids.tnvWaveIcon, wave);
  assert.equal(wave.querySelectorAll(), bars);
  assert.deepEqual(bars.map(bar => Number(bar.getAttribute('height'))), [4, 10, 18, 14, 10, 6, 3]);
  context.btnState('listen');
  assert.equal(group.getAttribute('fill'), 'rgba(0,217,168,1)');
});
