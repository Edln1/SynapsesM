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

function setup({ android = true, avaApp = true, bridge = true } = {}) {
  const packets = [], timers = new Map(), finished = [], errors = [], sources = [];
  let now = 0, nextTimer = 0;
  const output = { active: true, accept: true, stops: 0,
    isAvailable() { return this.active; },
    enqueue(encoded, delay) {
      packets.push({ bytes: Buffer.from(encoded, 'base64'), delay, queuedAt: now });
      return this.accept;
    },
    stop() { this.stops++; },
  };
  const window = { speechSynthesis: { cancel() {} } };
  if (android) window.AndroidAva = {};
  if (bridge) window.avaAndroidCallAudio = output;
  const document = { documentElement: { classList: { contains: name => avaApp && name === 'ava-app-mode' } } };
  const context = vm.createContext({ window, document, btoa,
    performance: { now: () => now },
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(extract('var _actx = null;', 'var _ttsQueue = [];'), context);
  const master = {}, hardware = {};
  Object.assign(context, {
    _actx: {
      currentTime: 2,
      destination: hardware,
      createBuffer: (channels, length, sampleRate) => ({ duration: length / sampleRate, copyToChannel() {} }),
      createBufferSource() {
        const source = { connect(node) { this.output = node; }, start(at) { this.startAt = at; } };
        sources.push(source);
        return source;
      },
      createGain: () => ({ gain: { value: 1 }, connect(node) { this.output = node; } }),
    },
    _actxGain: master,
    _ensureAudioCtx() {},
    _ttsAllowSchedule: true, _vmGenId: 1, _wsCurrentGenId: 1, _voiceTurnId: 1,
    _pcmWaveQueue: [], _drivePcmWaveform() {}, _stopPcmWaveform() {},
    _fired: false, _speakIsStale: (turn, generation) => generation !== context._vmGenId || turn !== context._voiceTurnId,
    _thisTurn: 1, _thisGen: 1, _on: true, _wsIsLive: () => true, _showToastWithSpeech() {},
    _wireFlushResolver() {}, _ttsProvider: 'deepgram', _ws: { send() {} }, _wsReady: true,
    _wsResolvers: [], _wsClose() {}, _ttsQueue: [], _ttsPlayNext() {}, _ttsFinalizeSpeechEnd() {},
    _avaNativeVoice: false, _avaAvatarConnected: false, _vmActive: false, clean: 'Speaking reply',
    _abandonWsWait() {}, _endSpeakListen() { finished.push('listening'); },
    _registerTurnAbort() {}, _notifyAvaAppVoiceIssue: message => errors.push(message),
    toastHide() { finished.push('hidden'); }, record() {},
  });
  vm.runInContext([
    extract('function _scheduleChunk(arrayBuf, androidClip)', '// ── Breathing animation on mic button'),
    extract('function _wsSend(text)', 'async function _ttsPlayNext(genId)'),
    extract('      function _fireWsSpeak()', '\n      if (_wsIsLive()) {'),
    extract('function _ttsStopAll(force, fadeMs)', '// ── WebSocket management'),
    extract('  function _finishAvaAndroidReply()', '  function _desktopVoiceFluxFallback('),
  ].join('\n'), context);
  return { context, output, packets, timers, finished, errors, sources, master, hardware,
    advance(ms) { now += ms; },
  };
}

test('only new installed Ava Android sessions can activate the native website bridge', () => {
  const supported = setup();
  assert.equal(supported.context._getAvaAndroidCallAudio(), supported.output);
  assert.equal(setup({ android: false }).context._getAvaAndroidCallAudio(), null);
  assert.equal(setup({ avaApp: false }).context._getAvaAndroidCallAudio(), null);
  assert.equal(setup({ bridge: false }).context._getAvaAndroidCallAudio(), null);
});

test('WebSocket STS writes raw PCM to Android and keeps timing silent; typed playback still uses its own original output', () => {
  const f = setup(), pcm = new Int16Array([258, -256]).buffer;
  f.context._fireWsSpeak();
  f.context._scheduleChunk(pcm);
  assert.deepEqual([...f.packets[0].bytes], [2, 1, 0, 255]);
  assert.equal(f.packets[0].delay, 150);
  assert.equal(f.sources[0].output.gain.value, 0);
  assert.equal(f.sources[0].output.output, f.hardware);
  assert.equal(f.sources[0].startAt, 2.15);

  f.context._wsSend('Typed reply');
  f.context._scheduleChunk(pcm);
  assert.equal(f.sources[1].output, f.master);
  assert.equal(f.packets.length, 1);

  const older = setup({ bridge: false });
  older.context._fireWsSpeak();
  older.context._scheduleChunk(pcm);
  assert.equal(older.sources[0].output, older.master);
  assert.equal(older.packets.length, 0);
});

test('warm Android streaming buffers a short lead once, then schedules contiguous packets without gaps', () => {
  const f = setup();
  const pcm = new Int16Array(480).buffer;
  f.context._actxWarm = true;
  f.context._fireWsSpeak();
  f.context._scheduleChunk(pcm);
  assert.ok(f.packets[0].delay >= 75 && f.packets[0].delay <= 76);
  f.context._actx.currentTime += 0.02;
  f.advance(20);
  f.context._scheduleChunk(pcm);
  assert.ok(Math.abs(f.sources[1].startAt - f.sources[0].startAt - 0.02) < 1e-8);
  assert.equal(f.packets[1].delay, 0);

  const browser = setup({ bridge: false });
  browser.context._actxWarm = true;
  browser.context._fireWsSpeak();
  browser.context._scheduleChunk(pcm);
  assert.equal(browser.sources[0].startAt, browser.context._actx.currentTime);
});

test('live speech sends the same accents, natural pauses and punctuation as typed read-aloud', () => {
  const f = setup(), messages = [];
  Object.assign(f.context, {
    _ttsBusy: false, _busy: false, _busySince: 0, _bargeForceToast: false,
    btnState() {}, _wsOpen() {}, _avatarLive: () => true,
  });
  f.context._ws.send = data => messages.push(JSON.parse(data));
  vm.runInContext([
    extract('function _ttsClean(txt)', '/** Escape text for HTML attributes'),
    extract('  function speak(text, forTurn)', '  function _finishAvaAndroidReply()'),
  ].join('\n'), f.context);
  const reply = 'Ask José in São Paulo.\n\n“Déjà vu” — 你好。';
  f.context.speak(reply + '\u0000@@AVA_SOURCES_HTML@@sources only', 1);
  assert.equal(messages[0].text, f.context._ttsClean(reply));
  assert.match(messages[0].text, /José in São Paulo\.\n“Déjà vu” — 你好。/);
  assert.equal(messages[1].type, 'Flush');
});

test('long output is paced and a voice interrupt flushes the native buffer and cancels future writes', () => {
  const f = setup();
  const pcm = new Uint8Array(30 * 48000);
  for (let i = 0; i < pcm.length; i += 1) pcm[i] = i % 251;
  f.context._fireWsSpeak();
  f.context._scheduleChunk(pcm.buffer);
  const sent = Buffer.concat(f.packets.map(packet => packet.bytes));
  assert.ok(sent.length > 48000 && sent.length < pcm.length);
  assert.deepEqual(sent, Buffer.from(pcm.subarray(0, sent.length)));
  assert.ok(f.packets.every(packet => packet.bytes.length <= 16384));
  assert.equal(f.packets[0].delay, 150);
  assert.ok(f.packets.slice(1).every(packet => packet.delay === 0));

  let pump = f.timers.get(f.context._avaAndroidCallPumpTimer);
  assert.ok(pump);
  f.advance(3000);
  pump.fn();
  assert.ok(f.packets.length > sent.length / 16384);
  pump = f.timers.get(f.context._avaAndroidCallPumpTimer);
  const lastCount = f.packets.length;
  f.context._ttsStopAll(true);
  assert.equal(f.output.stops, 1);
  assert.equal(f.context._avaAndroidCallPumpTimer, null);
  pump.fn(); // Also safe if the canceled callback was already dispatched.
  assert.equal(f.packets.length, lastCount);
});

test('rejected or unavailable call audio clears the voice reply and never plays it through media', () => {
  for (const configure of [output => { output.active = false; }, output => { output.accept = false; }]) {
    const f = setup();
    configure(f.output);
    f.context._fireWsSpeak();
    f.context._scheduleChunk(new Int16Array([1, -1]).buffer);
    assert.equal(f.errors.length, 1);
    assert.match(f.errors[0], /Android call audio/);
    assert.equal(f.context._vmGenId, 2);
    assert.equal(f.sources[0].output.gain.value, 0);
    assert.deepEqual(f.finished, ['listening']);
    assert.equal(f.output.stops, 1);
  }
});

async function settle() {
  for (let i = 0; i < 16; i++) await Promise.resolve();
}

function mockCompressedReply(f) {
  const blob = new Blob(['compressed audio']);
  f.context.window.OfflineAudioContext = class {
    constructor(_channels, _length, rate) { assert.equal(rate, 24000); }
    async decodeAudioData(data) {
      assert.equal(data.byteLength, blob.size);
      const channels = [Float32Array.of(-1, 1, 1), Float32Array.of(-1, 0, -1)];
      return { length: 3, numberOfChannels: 2, getChannelData: channel => channels[channel] };
    }
  };
  Object.assign(f.context, {
    _elevenFetchFile: async () => blob, _ttsRestFetch: async () => blob,
    fetch: async () => ({ ok: true, blob: async () => blob }), _dgKey: 'test',
    Audio: class { constructor() { throw Error('Ava Android call audio must not play through media'); } },
  });
}

test('ElevenLabs, Hume REST, and Deepgram REST send the same decoded native PCM and finish once', async () => {
  for (const provider of ['elevenlabs', 'hume', 'deepgram']) {
    const f = setup();
    mockCompressedReply(f);
    f.context._ttsProvider = provider;
    f.context._ttsBusy = true;
    if (provider === 'elevenlabs') f.context._elevenSpeakOnce('Reply', 1, 1);
    else f.context._speakREST('Reply', 1, 1);
    await settle();
    assert.deepEqual([...f.packets[0].bytes], [0, 128, 0, 64, 0, 0], provider);
    assert.deepEqual(f.errors, [], provider);
    assert.equal(f.context._ttsBusy, true, provider);
    f.sources[0].onended();
    assert.equal(f.context._ttsBusy, false, provider);
    assert.deepEqual(f.finished, ['hidden'], provider);
    assert.ok([...f.timers.values()].some(timer => timer.ms === 180), provider);
  }
});

test('a compressed reply decoded after Stop cannot re-open or write to call audio', async () => {
  const f = setup();
  mockCompressedReply(f);
  let decoded;
  f.context._decodeAvaAndroidCallAudio = () => new Promise(resolve => { decoded = resolve; });
  f.context._elevenSpeakOnce('Reply', 1, 1);
  await settle();
  f.context._ttsStopAll(true);
  decoded(new Int16Array([1, 2]).buffer);
  await settle();
  assert.equal(f.packets.length, 0);
  assert.deepEqual(f.finished, []);
  assert.deepEqual(f.errors, []);
});
