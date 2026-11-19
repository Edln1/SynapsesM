import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const require = createRequire(import.meta.url);
const { create } = require('../ava-read-aloud.js');

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function fixture(extra = {}, factory = create) {
  const context = { ownerKey: 'owner-a', threadId: 'thread-a', voiceActive: false };
  const requests = [], audios = [], states = [], urls = [], revoked = [], values = new Map();
  const storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const options = {
    getContext: () => context,
    cleanText: text => String(text || '').replace(/@@AVA_SOURCES_HTML@@[\s\S]*$/, '').trim(),
    synthesize(text, controller) {
      const pending = deferred(); requests.push({ ...pending, text, controller }); return pending.promise;
    },
    createAudio() {
      const audio = { muted: false, volume: 1, src: '', currentTime: 0, pauses: 0, loads: 0, calls: [],
        playImpl: () => Promise.resolve(),
        play() { this.calls.push({ src: this.src, muted: this.muted, volume: this.volume }); return this.playImpl(); },
        pause() { this.pauses++; },
        removeAttribute(name) { if (name === 'src') this.src = ''; },
        load() { this.loads++; },
      };
      audios.push(audio); return audio;
    },
    createObjectURL(blob) { const url = 'blob:ava-' + (urls.length + 1); urls.push({ blob, url }); return url; },
    revokeObjectURL(url) { revoked.push(url); },
    onState: value => states.push(value),
    ...extra,
  };
  const api = factory(options);
  function reply(text = 'Hello from Ava.', responseId = 'reply-1', overrides = {}) {
    return { text, ownerKey: context.ownerKey, threadId: context.threadId, responseId, ...overrides };
  }
  async function enable() { api.setEnabled(true); await settle(); return audios[0]; }
  async function speak(value = reply()) {
    const pending = api.complete(value); requests.at(-1).resolve(new Blob(['real provider audio']));
    return pending;
  }
  return { api, context, requests, audios, states, urls, revoked, values, storage, options, reply, enable, speak };
}

test('default off creates no audio or provider requests, and an unverified owner cannot enable it', async () => {
  const f = fixture(); assert.deepEqual(f.api.state, { enabled: false, status: 'idle', error: null });
  assert.equal((await f.api.complete(f.reply())).reason, 'disabled'); assert.equal(f.requests.length, 0); assert.equal(f.audios.length, 0);
  f.context.ownerKey = ''; f.api.contextChanged(); f.api.setEnabled(true);
  assert.equal(f.api.state.enabled, false); assert.equal(f.audios.length, 0); f.api.destroy();
});

test('explicit enable synchronously primes a silent owned audio element and the actual reply reuses it', async () => {
  const f = fixture(); f.api.setEnabled(true);
  assert.equal(f.audios.length, 1); const audio = f.audios[0];
  assert.match(audio.calls[0].src, /^data:audio\/wav;base64,/); assert.equal(audio.calls[0].muted, true); assert.equal(audio.calls[0].volume, 0);
  assert.equal(f.api.state.status, 'idle', 'Silent priming never claims Ava is speaking'); await settle();
  assert.equal(audio.muted, false); assert.equal(audio.volume, 1);
  await f.speak(f.reply('Speak this.@@AVA_SOURCES_HTML@@ do not read sources'));
  assert.equal(f.requests[0].text, 'Speak this.'); assert.equal(f.audios.length, 1); assert.equal(audio.calls.at(-1).src, 'blob:ava-1');
  assert.equal(audio.calls.at(-1).muted, false); assert.equal(f.api.state.status, 'speaking');
  audio.onended(); assert.equal(f.api.state.status, 'idle'); assert.deepEqual(f.revoked, ['blob:ava-1']); f.api.destroy();
});

test('completed response IDs deduplicate while loading, speaking and after ending', async () => {
  const f = fixture(); const audio = await f.enable(); const pending = f.api.complete(f.reply());
  assert.equal((await f.api.complete(f.reply())).reason, 'duplicate'); assert.equal(f.requests.length, 1);
  f.requests[0].resolve(new Blob(['audio'])); await pending;
  assert.equal((await f.api.complete(f.reply())).reason, 'duplicate'); audio.onended();
  assert.equal((await f.api.complete(f.reply())).reason, 'duplicate'); assert.equal(f.requests.length, 1); f.api.destroy();
});

test('late silent-prime completion cannot pause or mute real reply audio that has already started', async () => {
  const f = fixture(), audio = await f.enable(), priming = deferred(); f.api.setEnabled(false);
  audio.playImpl = () => priming.promise; f.api.setEnabled(true);
  audio.playImpl = () => Promise.resolve(); await f.speak(); const pauses = audio.pauses;
  priming.resolve(); await settle();
  assert.equal(f.api.state.status, 'speaking'); assert.equal(audio.src, 'blob:ava-1'); assert.equal(audio.pauses, pauses);
  assert.equal(audio.muted, false); assert.equal(audio.volume, 1); f.api.destroy();
});

test('mute aborts pending synthesis and a provider that ignores cancellation cannot play its stale result', async () => {
  const f = fixture(); const audio = await f.enable(); const pending = f.api.complete(f.reply());
  f.api.setEnabled(false); assert.equal(f.requests[0].controller.signal.aborted, true);
  f.requests[0].resolve(new Blob(['stale'])); assert.equal((await pending).status, 'ignored');
  assert.equal(f.urls.length, 0); assert.equal(audio.calls.length, 1); assert.equal(f.api.state.status, 'idle'); f.api.destroy();
});

test('owner changes and sign-out cancel requests, clear playback and never inherit another account preference', async () => {
  const f = fixture(); await f.enable(); const pending = f.api.complete(f.reply());
  f.context.ownerKey = 'owner-b'; f.api.contextChanged();
  assert.equal(f.api.state.enabled, false); assert.equal(f.requests[0].controller.signal.aborted, true);
  f.requests[0].resolve(new Blob(['owner-a private audio'])); assert.equal((await pending).status, 'ignored'); assert.equal(f.urls.length, 0);
  await f.enable(); await f.speak(f.reply('Owner B reply', 'reply-b')); f.context.ownerKey = ''; f.api.contextChanged();
  assert.equal(f.api.state.enabled, false); assert.equal(f.audios[0].src, ''); assert.deepEqual(f.revoked, ['blob:ava-1']); f.api.destroy();
});

test('a thread switch cancels old audio and stale completions even if contextChanged was missed by the caller', async () => {
  const f = fixture(); await f.enable(); const pending = f.api.complete(f.reply());
  f.context.threadId = 'thread-b'; f.requests[0].resolve(new Blob(['old thread audio']));
  assert.equal((await pending).status, 'ignored'); assert.equal(f.urls.length, 0); assert.equal(f.api.state.enabled, true);
  assert.equal((await f.api.complete(f.reply('Wrong thread', 'bad', { threadId: 'thread-a' }))).reason, 'context');
  await f.speak(f.reply('Current thread', 'new')); f.context.threadId = 'thread-c'; f.api.contextChanged();
  assert.equal(f.audios[0].src, ''); assert.equal(f.api.state.status, 'idle'); f.api.destroy();
});

test('S2S context suppresses read-aloud without starting any capture and cancels only owned audio', async () => {
  const f = fixture(); f.context.voiceActive = true; f.api.setEnabled(true);
  assert.equal(f.audios.length, 0); assert.equal((await f.api.complete(f.reply())).reason, 'context'); assert.equal(f.requests.length, 0);
  f.context.voiceActive = false; f.api.contextChanged(); await f.speak();
  const external = { paused: false }; f.context.voiceActive = true; f.api.contextChanged();
  assert.equal(f.audios[0].src, ''); assert.equal(external.paused, false); assert.equal(f.api.state.enabled, true); f.api.destroy();
});

test('blocked playback is honest and a user-tap retry plays the same cached audio without another synthesis call', async () => {
  const f = fixture(), audio = await f.enable();
  audio.playImpl = () => Promise.reject(Object.assign(new Error('User activation required'), { name: 'NotAllowedError' }));
  assert.equal((await f.speak()).status, 'blocked'); assert.equal(f.api.state.status, 'blocked'); assert.match(f.api.state.error, /Tap the speaker/);
  assert.equal(f.states.some(s => s.status === 'speaking'), false); audio.playImpl = () => Promise.resolve();
  const calls = audio.calls.length, retry = f.api.play(); assert.equal(audio.calls.length, calls + 1, 'Playback retry stays inside the click gesture');
  assert.equal((await retry).status, 'speaking'); assert.equal(f.requests.length, 1); assert.equal(f.audios.length, 1); f.api.destroy();
});

test('generic playback failures do not claim success and stale audio errors cannot overwrite a later retry', async () => {
  const f = fixture(), audio = await f.enable(), playing = deferred(); audio.playImpl = () => playing.promise;
  const pending = f.api.complete(f.reply()); f.requests[0].resolve(new Blob(['audio'])); await settle();
  const oldError = audio.onerror; oldError(); assert.equal(f.api.state.status, 'error'); assert.match(f.api.state.error, /Could not play/);
  audio.playImpl = () => Promise.resolve(); await f.api.retry(); assert.equal(f.api.state.status, 'speaking');
  playing.resolve(); assert.equal((await pending).status, 'ignored'); oldError(); assert.equal(f.api.state.status, 'speaking'); f.api.destroy();
});

test('a failed synthesis can be explicitly retried and uses the existing dependency again', async () => {
  const f = fixture(); await f.enable(); const pending = f.api.complete(f.reply());
  f.requests[0].reject(new Error('Provider failed with private diagnostic details')); assert.equal((await pending).status, 'error');
  assert.equal(f.api.state.error, 'Could not load speech. Try again.'); const retry = f.api.retry();
  assert.equal(f.requests.length, 2); f.requests[1].resolve(new Blob(['retry audio'])); assert.equal((await retry).status, 'speaking'); f.api.destroy();
});

test('new replies interrupt owned speech and captured callbacks from the old reply cannot stop the new one', async () => {
  const f = fixture(), audio = await f.enable(); await f.speak(); const oldEnd = audio.onended;
  await f.speak(f.reply('A new answer', 'reply-2')); assert.deepEqual(f.revoked, ['blob:ava-1']);
  oldEnd(); assert.equal(f.api.state.status, 'speaking'); assert.equal(audio.src, 'blob:ava-2');
  f.api.stop(); assert.equal(audio.src, ''); assert.deepEqual(f.revoked, ['blob:ava-1', 'blob:ava-2']); assert.equal(f.api.state.enabled, true); f.api.destroy();
});

test('disable during a pending play promise invalidates it and revokes only the controller URL', async () => {
  const f = fixture(), audio = await f.enable(), playing = deferred(); audio.playImpl = () => playing.promise;
  const pending = f.api.complete(f.reply()); f.requests[0].resolve(new Blob(['audio'])); await settle();
  f.api.setEnabled(false); playing.resolve(); assert.equal((await pending).status, 'ignored');
  assert.equal(f.api.state.enabled, false); assert.equal(f.api.state.status, 'idle'); assert.deepEqual(f.revoked, ['blob:ava-1']); f.api.destroy();
});

test('preferences are opt-in, scoped to verified owner and persist without starting audio on restore', async () => {
  const values = new Map(), storage = { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
  const a = fixture({ storage }); await a.enable(); assert.equal(values.get('synapses_ava_read_aloud_v1_owner-a'), '1'); a.api.destroy();
  const b = fixture({ storage }); assert.equal(b.api.state.enabled, true); assert.equal(b.audios.length, 0);
  b.context.ownerKey = 'owner-b'; b.api.contextChanged(); assert.equal(b.api.state.enabled, false);
  b.api.setEnabled(true); b.context.ownerKey = 'owner-a'; b.api.contextChanged(); assert.equal(b.api.state.enabled, true);
  b.api.setEnabled(false); assert.equal(values.get('synapses_ava_read_aloud_v1_owner-a'), '0'); b.api.destroy();
});

test('destroy is idempotent and late synthesis/priming completions cannot revive playback or state', async () => {
  const priming = deferred(), f = fixture(); f.api.setEnabled(true); await settle();
  f.audios[0].playImpl = () => priming.promise; f.api.setEnabled(false); f.api.setEnabled(true);
  const pending = f.api.complete(f.reply()); f.api.destroy(); f.api.destroy(); const count = f.states.length;
  priming.resolve(); f.requests[0].resolve(new Blob(['stale'])); await pending; await settle();
  assert.equal(f.states.length, count); assert.equal(f.urls.length, 0); assert.equal(f.api.state.enabled, false);
  assert.equal((await f.api.retry()).status, 'ignored'); assert.equal(f.api.toggle().enabled, false);
});

test('the browser UMD uses no microphone, speech-recognition, browser voice or global voice-state APIs', async () => {
  const source = await readFile(new URL('../ava-read-aloud.js', import.meta.url), 'utf8'); let forbidden = 0;
  const fail = () => { forbidden++; throw Error('Read aloud must not use capture or a different voice pipeline'); };
  const window = { AbortController, navigator: { mediaDevices: { getUserMedia: fail } }, SpeechRecognition: fail,
    speechSynthesis: { speak: fail, cancel: fail }, toggleTopNavVoice: fail, _ttsStopAll: fail };
  vm.runInNewContext(source, { window, Promise, Set, TypeError, Error, Object, JSON, String, encodeURIComponent });
  const f = fixture({}, window.AvaReadAloud.create); await f.enable(); await f.speak(); f.api.stop(); f.api.destroy(); assert.equal(forbidden, 0);
});
