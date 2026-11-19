import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const controller = await readFile(new URL('../ava-read-aloud.js', import.meta.url), 'utf8');
const source = html.match(/<script id="avaCompanionChatScript">([\s\S]*?)<\/script>/)?.[1];
const markup = html.match(/<section id="avaCompanionChat"[\s\S]*?<\/section>/)?.[0];
assert.ok(source && markup);

class Element extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag.toUpperCase(); this.document = document; this.children = []; this.parentNode = null;
    this.dataset = {}; this.style = {}; this.attrs = new Map(); this.hidden = false; this.disabled = false;
    this.value = ''; this.inert = false; this.className = ''; this.focuses = 0;
    this.scrollHeight = 700; this.scrollTop = 0; this.clientHeight = 600;
    const classes = new Set();
    this.classList = { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
      toggle(name, force) { const value = force ?? !classes.has(name); if (value) classes.add(name); else classes.delete(name); return value; } };
  }
  set id(value) { this._id = value; this.document.nodes.set(value, this); }
  get id() { return this._id; }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw Error('The read-aloud integration must not inject HTML'); }
  appendChild(child) { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(x => x !== child); this.children.push(child); child.parentNode = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  insertBefore(child, before) { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(x => x !== child); const at = this.children.indexOf(before); if (at < 0) return this.appendChild(child); this.children.splice(at, 0, child); child.parentNode = this; return child; }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = ''; this.append(...children); }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.document.nodes.delete(this.id); this.parentNode = null; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  querySelectorAll() { return []; }
  contains(child) { for (let node = child; node; node = node.parentNode) if (node === this) return true; return false; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  focus() { this.focuses++; }
  get isConnected() { return !!this.parentNode; }
  click() { if (this.disabled) return; const event = new Event('click', { cancelable: true }); this.onclick?.(event); this.dispatchEvent(event); }
}
const alice = { id: 'owner-a', email: 'alice@example.test' }, bob = { id: 'owner-b', email: 'bob@example.test' };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function settle() { for (let i = 0; i < 30; i++) await Promise.resolve(); }
function setup({ app = true, owner = alice, factory = 'real', preference = false } = {}) {
  let identity = owner, subscription = () => {}, checks = 0, voiceStarts = 0;
  const storage = new Map(); if (preference && owner) storage.set('synapses_ava_read_aloud_v1_' + owner.id, '1');
  const document = new EventTarget(); document.nodes = new Map(); document.documentElement = new Element('html', document);
  if (app) document.documentElement.classList.add('ava-app-mode');
  document.body = new Element('body', document); document.hidden = false; document.activeElement = null;
  document.createElement = tag => new Element(tag, document); document.createElementNS = (_, tag) => document.createElement(tag);
  document.createTextNode = value => { const node = new Element('#text', document); node.textContent = value; return node; };
  document.createDocumentFragment = () => new Element('#fragment', document);
  document.getElementById = id => document.nodes.get(id) || null; document.querySelector = () => null; document.querySelectorAll = () => [];
  for (const match of markup.matchAll(/\bid="([^"]+)"/g)) { const node = document.createElement('div'); node.id = match[1]; }
  const root = document.getElementById('avaCompanionChat'); root.hidden = true; root.dataset.history = 'false'; document.body.append(root);
  for (const node of document.nodes.values()) if (node !== root) root.append(node);
  document.getElementById('acWelcome').append(document.getElementById('acHomeChats')); document.getElementById('acConfirm').hidden = true;
  const window = new EventTarget(), requests = [], speech = [], audios = [], revoked = [], urls = [], observers = [], timers = new Map(); let timer = 0;
  const localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const bridge = {
    uiKey: () => identity ? identity.id + '|' + identity.email : 'guest', subscribe(fn) { subscription = fn; }, invalidate() {},
    async verify() { subscription(identity); return identity; }, current: () => identity,
    isCurrent: value => !!(identity && value && value.id === identity.id && value.email === identity.email),
    async check() { checks++; return identity ? { status: 'ready', owner: identity } : { status: 'signin' }; },
    send(options) { const pending = deferred(); requests.push({ ...pending, options }); return pending.promise; },
    async listTasks() { return { status: 'ok', tasks: [] }; }, gate() {}, action() {}, openMain() {},
    voice() { voiceStarts++; return 'speech-to-speech'; },
  };
  function Audio() {
    this.muted = false; this.volume = 1; this.src = ''; this.currentTime = 0; this.calls = []; this.pauses = 0;
    this.playImpl = () => Promise.resolve();
    this.play = function () { this.calls.push({ src: this.src, muted: this.muted, volume: this.volume }); return this.playImpl(); };
    this.pause = function () { this.pauses++; }; this.removeAttribute = function () { this.src = ''; }; this.load = function () {};
    audios.push(this);
  }
  window.avaCompanionChatBridge = bridge; window.matchMedia = () => ({ matches: app }); window.crypto = { randomUUID };
  window.localStorage = localStorage; window.AbortController = AbortController;
  window.URL = { createObjectURL(blob) { const url = 'blob:integration-' + (urls.length + 1); urls.push({ url, blob }); return url; }, revokeObjectURL(url) { revoked.push(url); } };
  window.MutationObserver = class { constructor(fn) { this.fn = fn; observers.push(this); } observe(target, options) { this.target = target; this.options = options; } disconnect() { this.target = null; } };
  const sandbox = vm.createContext({ window, document, Event, URL, AbortController, Audio, crypto: window.crypto, localStorage,
    navigator: { clipboard: { async writeText() {} }, mediaDevices: { getUserMedia() { throw Error('Read aloud must not start a mic'); } } },
    _ttsRestFetch(text, controller) { const pending = deferred(); speech.push({ ...pending, text, controller }); return pending.promise; },
    _ttsClean: text => String(text).split('@@AVA_SOURCES_HTML@@')[0].trim(),
    setTimeout(callback) { const id = ++timer; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    setInterval() {}, requestAnimationFrame: callback => callback(),
  });
  if (factory === 'real') vm.runInContext(controller, sandbox);
  else if (factory === 'throws') window.AvaReadAloud = { create() { throw Error('Unavailable'); } };
  vm.runInContext(source, sandbox);
  const node = id => document.getElementById(id);
  return { window, document, node, root, requests, speech, audios, storage, revoked, urls, observers,
    get checks() { return checks; }, get voiceStarts() { return voiceStarts; },
    async open() { await window.avaCompanionChatOpen({ home: true, focus: false }); },
    async submit(text = 'A typed question') { node('acInput').value = text; node('acForm').dispatchEvent(new Event('submit', { cancelable: true })); await settle(); },
    async final(text = 'A real completed reply') { requests.at(-1).resolve({ status: 'complete', text, sources: [] }); await settle(); },
    async audio() { speech.at(-1).resolve(new Blob(['provider audio fixture'])); await settle(); },
    owner(value) { identity = value; subscription(value); },
    liveVoice() { window._topNavVoiceActive = true; document.body.classList.add('voice-live'); for (const observer of observers) if (observer.target === document.body) observer.fn(); },
    stage(value) { const event = new Event('ava:app-stage-change'); event.detail = { stage: value }; window.dispatchEvent(event); },
  };
}

test('the app composer has one accessible thin speaker before Send, default off, without starting a mic', async () => {
  const f = setup(); await f.open(); const button = f.node('acReadAloud'), send = f.node('acSend');
  assert.ok(button); assert.equal(button.type, 'button'); assert.equal(button.getAttribute('aria-pressed'), 'false'); assert.equal(button.title, 'Read replies aloud');
  assert.match(button.className, /ac-icon/); assert.equal(button.children[0].getAttribute('width'), '16'); assert.equal(button.children[0].getAttribute('stroke-width'), '1.5');
  assert.equal(send.parentNode.children[send.parentNode.children.indexOf(send) - 1], button);
  assert.equal(f.audios.length, 0); assert.equal(f.voiceStarts, 0); await f.submit(); await f.final(); assert.equal(f.speech.length, 0);
});

test('only final verified typed replies use existing TTS; chunks/rerenders never speak and no second text-allowance check occurs', async () => {
  const f = setup(); await f.open(); const button = f.node('acReadAloud'); button.click(); await settle();
  assert.equal(button.getAttribute('aria-pressed'), 'true'); assert.equal(f.audios[0].calls[0].muted, true);
  await f.submit(); f.requests[0].options.onChunk('A partial answer'); await settle(); assert.equal(f.speech.length, 0);
  await f.final('Finished answer@@AVA_SOURCES_HTML@@ ignored source HTML'); assert.equal(f.speech.length, 1); assert.equal(f.speech[0].text, 'Finished answer'); assert.equal(f.checks, 1);
  assert.ok(f.speech[0].controller instanceof AbortController); await f.audio(); assert.equal(button.dataset.state, 'speaking'); assert.equal(button.dataset.playing, 'true');
  button.click(); assert.equal(button.getAttribute('aria-pressed'), 'false'); assert.equal(f.audios[0].src, ''); assert.deepEqual(f.revoked, ['blob:integration-1']); assert.equal(f.voiceStarts, 0);
  await f.window.avaCompanionChatHome(); assert.equal(f.speech.length, 1); assert.equal(f.node('acInput').focuses, 0);
});

test('blocked playback shows an honest notice and the same speaker retries cached audio on a user tap', async () => {
  const f = setup(); await f.open(); const button = f.node('acReadAloud'); button.click(); await settle(); await f.submit(); await f.final();
  const audio = f.audios[0]; audio.playImpl = () => Promise.reject(Object.assign(new Error('Gesture required'), { name: 'NotAllowedError' })); await f.audio();
  assert.equal(button.dataset.state, 'blocked'); assert.equal(button.dataset.playing, 'false'); assert.equal(button.title, 'Play this reply aloud'); assert.match(f.node('acNotice').textContent, /Tap the speaker/);
  audio.playImpl = () => Promise.resolve(); const calls = audio.calls.length; button.click(); assert.equal(audio.calls.length, calls + 1); await settle();
  assert.equal(button.dataset.state, 'speaking'); assert.equal(f.speech.length, 1); assert.equal(f.node('acNotice').textContent, ''); assert.equal(f.voiceStarts, 0);
});

test('returning Home cancels in-flight synthesis and a hidden completed reply is not sent to TTS', async () => {
  const f = setup(); await f.open(); f.node('acReadAloud').click(); await f.submit(); await f.final(); const pending = f.speech[0];
  await f.window.avaCompanionChatHome(); assert.equal(pending.controller.signal.aborted, true); pending.resolve(new Blob(['stale private audio'])); await settle();
  assert.equal(f.urls.length, 0); assert.equal(f.node('acReadAloud').dataset.state, 'idle');
  await f.submit('Another question'); await f.window.avaCompanionChatHome(); await f.final(); assert.equal(f.speech.length, 1);
});

test('account change stops speech, clears its owner toggle and blocks stale synthesis results', async () => {
  const f = setup(); await f.open(); f.node('acReadAloud').click(); await f.submit(); await f.final(); const pending = f.speech[0];
  f.owner(bob); assert.equal(pending.controller.signal.aborted, true); assert.equal(f.node('acReadAloud').getAttribute('aria-pressed'), 'false');
  pending.resolve(new Blob(['Alice audio'])); await settle(); assert.equal(f.urls.length, 0);
  f.owner(null); assert.equal(f.node('acReadAloud').disabled, true); assert.equal(f.voiceStarts, 0);
});

test('close, pagehide and navigation cancel pending speech and late provider results cannot start playback', async () => {
  for (const action of ['close', 'pagehide', 'tools']) {
    const f = setup(); await f.open(); f.node('acReadAloud').click(); await f.submit(); await f.final(); const pending = f.speech[0];
    if (action === 'close') f.window.avaCompanionChatClose(false); else if (action === 'pagehide') f.window.dispatchEvent(new Event('pagehide')); else f.stage(action);
    assert.equal(pending.controller.signal.aborted, true, action); pending.resolve(new Blob(['late audio'])); await settle(); assert.equal(f.urls.length, 0, action);
  }
});

test('new submissions and the real voice-live class stop owned speech while speaker controls never start S2S', async () => {
  const f = setup(); await f.open(); f.node('acReadAloud').click(); await f.submit(); await f.final(); await f.audio();
  await f.submit('Next typed question'); assert.equal(f.audios[0].src, ''); await f.final(); await f.audio();
  f.liveVoice(); assert.equal(f.audios[0].src, ''); assert.equal(f.node('acReadAloud').dataset.state, 'idle'); assert.equal(f.voiceStarts, 0);
});

test('failed or stopped model replies never create speech requests', async () => {
  for (const status of ['error', 'cancelled', 'rate-limited']) {
    const f = setup(); await f.open(); f.node('acReadAloud').click(); await f.submit(); f.requests[0].options.onChunk('Partial response');
    f.requests[0].resolve({ status, text: 'Not an accepted final reply', message: 'Fixture failure' }); await settle(); assert.equal(f.speech.length, 0, status);
  }
});

test('desktop and guests do not gain an active speaker, and unavailable controller scripts cannot break text chat', async () => {
  const desktop = setup({ app: false }); await desktop.open(); assert.equal(desktop.node('acReadAloud'), null);
  const guest = setup({ owner: null }); await guest.open(); assert.equal(guest.node('acReadAloud').disabled, true); guest.node('acReadAloud').click(); assert.equal(guest.audios.length, 0);
  for (const factory of ['missing', 'throws']) {
    const f = setup({ factory }); await f.open(); assert.equal(f.node('acReadAloud'), null); await f.submit(); await f.final(); assert.equal(f.requests.length, 1); assert.equal(f.speech.length, 0);
  }
  assert.ok(html.indexOf('<script src="ava-read-aloud.js?v=20261118-tts1"></script>') < html.indexOf('<script id="avaCompanionChatScript">'));
});

test('an owner preference restores the read mode without priming, speaking history or shifting mobile composer focus', async () => {
  const f = setup({ preference: true }); await f.open(); assert.equal(f.node('acReadAloud').getAttribute('aria-pressed'), 'true');
  assert.equal(f.audios.length, 0); assert.equal(f.speech.length, 0); assert.equal(f.node('acInput').focuses, 0);
  await f.submit(); await f.final(); assert.equal(f.speech.length, 1); assert.equal(f.audios.length, 0);
});
