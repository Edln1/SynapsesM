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

function setup({ android = true, avaApp = true, storage = new Map() } = {}) {
  const window = new EventTarget();
  if (android) window.AndroidAva = {};
  const document = { documentElement: { classList: { contains: name => avaApp && name === 'ava-app-mode' } } };
  const context = vm.createContext({ window, document, localStorage: {
    getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
  } });
  vm.runInContext(extract('var _actx = null;', 'var _ttsQueue = [];'), context);
  return { context, window, storage, document };
}

test('the volume setting is available in installed Android Ava and persists across restarts', () => {
  const { window, storage } = setup();
  const control = window.avaAndroidVoiceVolume;
  assert.equal(control.get(), 100);
  assert.equal(control.set(-10), 0);
  assert.equal(control.set(''), 0);
  assert.equal(control.set(null), 0);
  assert.equal(setup({ storage }).window.avaAndroidVoiceVolume.get(), 0);
  assert.equal(control.set(120), 100);
  assert.equal(control.set('34.6'), 35);
  assert.equal(control.set(Infinity), 35);
  assert.equal(setup({ storage }).window.avaAndroidVoiceVolume.get(), 35);
  assert.equal(setup({ android: false, storage }).window.avaAndroidVoiceVolume, undefined);

  const lateEntry = setup({ avaApp: false });
  assert.equal(lateEntry.window.avaAndroidVoiceVolume, undefined);
  lateEntry.document.documentElement.classList.contains = name => name === 'ava-app-mode';
  lateEntry.window.dispatchEvent(new Event('ava:app-stage-change'));
  assert.equal(lateEntry.window.avaAndroidVoiceVolume.get(), 100);
});

test('PCM replies get their own live gain while typed playback stays on the shared master', () => {
  const { window, context } = setup();
  const connections = [], gains = [];
  const master = { gain: { value: 0.7 } };
  const makeContext = () => ({
    currentTime: 2,
    createBuffer: () => ({ duration: 0.02, copyToChannel() {} }),
    createBufferSource: () => ({ connect: output => connections.push(output), start() {} }),
    createGain() {
      const control = { gain: { value: 1, setTargetAtTime(value, time) { this.last = { value, time }; } },
        connect(output) { this.output = output; } };
      gains.push(control);
      return control;
    },
  });
  Object.assign(context, {
    _actx: makeContext(), _actxGain: master, _ensureAudioCtx() {},
    _ttsAllowSchedule: true, _vmGenId: 1, _wsCurrentGenId: 1,
    _pcmWaveQueue: [], _drivePcmWaveform() {},
    _fired: false, _speakIsStale: () => false, _thisTurn: 1, _thisGen: 1,
    _on: true, _wsIsLive: () => true, _showToastWithSpeech() {},
    _wireFlushResolver() {}, _ttsProvider: 'deepgram', _ws: { send() {} },
    _wsReady: true, _wsResolvers: [], clean: 'Speaking reply', setTimeout() {},
  });
  vm.runInContext([
    extract('function _scheduleChunk(arrayBuf)', '(function(){\n  if (document.getElementById(\'_micBreathStyle\'))'),
    extract('function _wsSend(text)', 'async function _ttsPlayNext(genId)'),
    extract('      function _fireWsSpeak()', '\n      if (_wsIsLive()) {'),
  ].join('\n'), context);
  const pcm = new Int16Array([1, -1]).buffer;
  window.avaAndroidVoiceVolume.set(45);

  context._fireWsSpeak();
  context._scheduleChunk(pcm);
  assert.equal(connections[0], gains[0]);
  assert.equal(gains[0].gain.value, 0.45);
  assert.equal(gains[0].output, master);
  window.avaAndroidVoiceVolume.set(10);
  assert.deepEqual(gains[0].gain.last, { value: 0.1, time: 2 });
  assert.equal(master.gain.value, 0.7);

  context._wsSend('Typed reply');
  context._scheduleChunk(pcm);
  assert.equal(connections[1], master);
  assert.equal(gains.length, 1);

  context._actx = makeContext();
  context._fired = false;
  context._fireWsSpeak();
  context._scheduleChunk(pcm);
  assert.equal(connections[2], gains[1]);
  assert.equal(gains[1].gain.value, 0.1);
});

test('REST and ElevenLabs reply media use the setting before playback and update mid-reply', async () => {
  const { window, context } = setup();
  Object.assign(context, {
    _speakIsStale: () => false, _startAnalyser() {}, _stopAnalyser() {},
    _vmGenId: 1, _voiceTurnId: 1, _registerTurnAbort() {},
    _elevenFetchFile: async () => ({}), _on: false,
    toastHide() {}, URL: { createObjectURL: () => 'blob:reply', revokeObjectURL() {} },
    Audio: function() { this.volume = 1; this.play = async () => { this.startedAtVolume = this.volume; }; },
  });
  vm.runInContext([
    extract('  function _playAudio(a,', '  function speak(text, forTurn)'),
    extract('  function _elevenSpeakOnce(clean,', '  // Fallback: original REST-based TTS'),
  ].join('\n'), context);
  const typed = { volume: 0.9 }, music = { volume: 0.8 }, rest = new context.Audio();
  context._ttsAudioEls.push(typed);
  window.avaAndroidVoiceVolume.set(65);
  context._playAudio(rest, () => {}, 1, 1);
  context._elevenSpeakOnce('Speaking', 1, 1);
  await Promise.resolve();
  await Promise.resolve();
  const eleven = context._ttsAudioEls[2];
  assert.equal(rest.startedAtVolume, 0.65);
  assert.equal(eleven.startedAtVolume, 0.65);
  window.avaAndroidVoiceVolume.set(15);
  assert.equal(rest.volume, 0.15);
  assert.equal(eleven.volume, 0.15);
  assert.equal(typed.volume, 0.9);
  assert.equal(music.volume, 0.8);
  rest.onended();
  window.avaAndroidVoiceVolume.set(30);
  assert.equal(rest.volume, 0.15);
  assert.equal(eleven.volume, 0.3);
});
