'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const vm = require('node:vm');
const { createBrowserActions } = require('../src/browser-actions.cjs');

function fixture(t, options = {}) {
  const state = { active: true, url: 'about:blank', text: 'Example public page', title: 'Example', x: 0, y: 0, loads: [], scripts: [], inputs: [], windows: [], nodes: [], checks: 0 };
  class Input {
    constructor(tag, label, type = 'text') { this.tagName = tag; this.attrs = { 'aria-label': label }; this.type = type; this.isConnected = true; this.disabled = false; this._value = ''; this.href = ''; }
    getAttribute(name) { return this.attrs[name] || ''; }
    getBoundingClientRect() { return { width: 120, height: 28, left: 20, top: 20, right: 140, bottom: 48 }; }
    closest() { return this.form || null; }
    focus() { document.activeElement = this; }
    click() { this.clicked = (this.clicked || 0) + 1; if (this.onclick) this.onclick(); }
    dispatchEvent() {}
    get value() { return this._value; } set value(value) { this._value = value; }
  }
  class Textarea extends Input {}
  class Select extends Input {}
  const document = { title: state.title, body: {}, activeElement: null, querySelectorAll: () => state.nodes };
  Object.defineProperty(document.body, 'innerText', { get: () => state.text });
  const location = {}; Object.defineProperty(location, 'href', { get: () => state.url });
  const sandbox = { document, location, innerWidth: 1200, innerHeight: 820, HTMLInputElement: Input, HTMLTextAreaElement: Textarea, HTMLSelectElement: Select, Event,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
    scrollBy: (x, y) => { state.x += x; state.y += y; } };
  Object.defineProperty(sandbox, 'scrollX', { get: () => state.x }); Object.defineProperty(sandbox, 'scrollY', { get: () => state.y });
  const context = vm.createContext(sandbox);
  const session = new EventEmitter();
  session.webRequest = { onBeforeRequest: (_filter, callback) => { state.request = callback; } };
  session.setPermissionRequestHandler = callback => { state.permission = callback; };
  session.setPermissionCheckHandler = callback => { state.permissionCheck = callback; };
  session.setDevicePermissionHandler = callback => { state.devicePermission = callback; };
  class Contents extends EventEmitter {
    constructor() { super(); this.session = session; this.navigationHistory = { canGoBack: () => state.loads.length > 1, goBack: () => { state.url = state.loads.at(-2); } }; }
    getURL() { return state.url; }
    isLoadingMainFrame() { return false; }
    stop() { state.stoppedLoads = (state.stoppedLoads || 0) + 1; }
    setWindowOpenHandler(callback) { state.popup = callback; }
    async loadURL(url) {
      const request = await new Promise(resolve => state.request({ url, resourceType: 'mainFrame' }, resolve));
      if (request.cancel) throw Error('request blocked');
      this.emit('did-start-navigation', {}, url, false, true);
      state.url = url; state.loads.push(url); this.emit('did-finish-load');
    }
    async executeJavaScriptInIsolatedWorld(world, scripts, userGesture) {
      state.scripts.push({ world, userGesture });
      return vm.runInContext(scripts[0].code, context);
    }
    sendInputEvent(value) { state.inputs.push(value); if (value.type === 'keyUp' && value.keyCode === 'Enter') state.text = 'Search results'; }
  }
  class BrowserWindow extends EventEmitter {
    constructor(config) { super(); this.config = config; this.webContents = new Contents(); state.windows.push(this); }
    isDestroyed() { return this.closed === true; }
    destroy() { this.closed = true; this.webContents.emit('destroyed'); this.emit('closed'); }
  }
  const driver = createBrowserActions({ BrowserWindow, assertActive: options.assertActive || (() => { state.checks++; return state.active; }), lookupHost: options.lookupHost || (async () => [{ address: '8.8.8.8' }]), pause: options.pause || (async () => {}), makeToken: (() => { let i = 0; return () => 'observed-' + (++i); })(), dnsTimeoutMs: 25 });
  t.after(() => driver.close());
  const node = (tag, label, type) => { const el = new Input(tag, label, type); state.nodes.push(el); return el; };
  return { state, driver, node, context, document };
}

test('the controlled browser is a dedicated visible sandbox with no privileged preload or ordinary app session', async t => {
  const f = fixture(t); await f.driver.perform('open_url', { url: 'https://example.org/' });
  const config = f.state.windows[0].config;
  assert.equal(config.show, true); assert.equal(config.webPreferences.sandbox, true); assert.equal(config.webPreferences.nodeIntegration, false);
  assert.equal(config.webPreferences.contextIsolation, true); assert.equal(config.webPreferences.webSecurity, true); assert.equal(config.webPreferences.preload, undefined);
  assert.equal(config.webPreferences.partition, 'persist:synapses-agent-browser');
  assert.equal(f.state.permissionCheck(), false); assert.equal(f.state.devicePermission(), false);
  let permission; f.state.permission({}, 'media', value => { permission = value; }); assert.equal(permission, false);
  assert.ok(f.state.scripts.every(call => call.world === 1041));
});

test('real isolated snapshot references drive input and reject selectors, scripts, stale or forged references', async t => {
  const f = fixture(t), input = f.node('INPUT', 'Find a topic', 'search');
  const opened = await f.driver.perform('open_url', { url: 'https://example.org/' });
  assert.equal(opened.verified, true); const ref = opened.page.controls[0].ref;
  const text = '");globalThis.injectionExecuted=true;//';
  const typed = await f.driver.perform('type', { ref, text });
  assert.equal(typed.ok, true); assert.equal(typed.verified, true); assert.equal(input.value, text); assert.equal(f.context.injectionExecuted, undefined);
  assert.equal((await f.driver.perform('click', { selector: 'button' })).error, 'invalid_arguments');
  assert.equal((await f.driver.perform('click', { ref, script: 'alert(1)' })).error, 'invalid_arguments');
  assert.equal((await f.driver.perform('click', { ref })).error, 'stale_ref');
  assert.equal((await f.driver.perform('click', { ref: 'invented' })).error, 'stale_ref');
  assert.equal((await f.driver.perform('read_page')).verified, false);
});

test('risky actions require a trusted approval separate from model arguments and recheck changed controls', async t => {
  const f = fixture(t), send = f.node('BUTTON', 'Send message', 'button'); send.onclick = () => { f.state.text = 'Message submitted'; };
  let page = (await f.driver.perform('open_url', { url: 'https://example.org/' })).page;
  assert.equal((await f.driver.perform('click', { ref: page.controls[0].ref, confirmed: true })).error, 'invalid_arguments');
  const blocked = await f.driver.perform('click', { ref: page.controls[0].ref });
  assert.equal(blocked.confirmationRequired, true); assert.equal(send.clicked, undefined);
  const confirmed = await f.driver.perform('click', { ref: page.controls[0].ref }, { confirmed: true });
  assert.equal(confirmed.verified, true); assert.equal(send.clicked, 1);
  page = confirmed.page;
  send.attrs['aria-label'] = 'Purchase now';
  const again = await f.driver.perform('click', { ref: page.controls[0].ref }); assert.equal(again.needsConfirmation, true); assert.equal(send.clicked, 1);
});

test('Enter on an observed search input uses actual browser key events; non-search Enter requires approval', async t => {
  const f = fixture(t); f.node('INPUT', 'Search videos', 'search');
  let page = (await f.driver.perform('open_url', { url: 'https://example.org/' })).page;
  const result = await f.driver.perform('press', { ref: page.controls[0].ref, key: 'Enter' });
  assert.equal(result.verified, true); assert.deepEqual(f.state.inputs, [{ type: 'keyDown', keyCode: 'Enter' }, { type: 'keyUp', keyCode: 'Enter' }]);
  const message = f.node('INPUT', 'Message', 'text'); page = (await f.driver.perform('read_page')).page;
  const guarded = await f.driver.perform('press', { ref: page.controls[1].ref, key: 'Enter' }); assert.equal(guarded.needsConfirmation, true); assert.equal(message.clicked, undefined);
  assert.equal((await f.driver.perform('press', { ref: page.controls[0].ref, key: 'Control+L' })).error, 'unsupported_key');
});

test('HTTPS, public DNS and exact lease cancellation gate navigation before any late window or action', async t => {
  const f = fixture(t);
  for (const url of ['file:///C:/Windows', 'http://example.org/', 'https://127.0.0.1/', 'https://user:pass@example.org/']) assert.equal((await f.driver.perform('open_url', { url })).error, 'blocked_url');
  assert.equal(f.state.windows.length, 0);
  const privateHost = fixture(t, { lookupHost: async () => [{ address: '8.8.8.8' }, { address: '192.168.1.1' }] });
  assert.equal((await privateHost.driver.perform('open_url', { url: 'https://example.org/' })).error, 'blocked_address'); assert.equal(privateHost.state.windows.length, 0);
  let resolve; const late = fixture(t, { lookupHost: () => new Promise(done => { resolve = done; }) });
  const opening = late.driver.perform('open_url', { url: 'https://example.org/' }); late.state.active = false; resolve([{ address: '8.8.8.8' }]);
  assert.equal((await opening).error, 'canceled'); assert.equal(late.state.windows.length, 0);
});

test('redirects, subframe requests and new tabs cannot escape the HTTPS/public-address gate', async t => {
  const f = fixture(t); await f.driver.perform('open_url', { url: 'https://example.org/' });
  let prevented = 0;
  for (const event of ['will-navigate', 'will-redirect', 'will-frame-navigate']) f.state.windows[0].webContents.emit(event, { url: 'file:///secret', preventDefault: () => { prevented++; } });
  assert.equal(prevented, 3);
  const request = await new Promise(resolve => f.state.request({ url: 'https://localhost/', resourceType: 'subFrame' }, resolve)); assert.equal(request.cancel, true);
  assert.deepEqual(f.state.popup({ url: 'javascript:alert(1)' }), { action: 'deny' }); await Promise.resolve();
  assert.deepEqual(f.state.loads, ['https://example.org/']);
  f.state.active = false;
  const revoked = await new Promise(resolve => f.state.request({ url: 'https://example.org/', resourceType: 'mainFrame' }, resolve)); assert.equal(revoked.cancel, true);
});

test('playing is reported only after actual media play state is observed; unchanged clicks are not verified', async t => {
  const f = fixture(t), video = f.node('VIDEO', 'Video', '');
  video.paused = true; video.ended = false; video.readyState = 4; video.play = async () => { video.paused = false; };
  let page = (await f.driver.perform('open_url', { url: 'https://example.org/' })).page;
  const played = await f.driver.perform('media_play', { ref: page.media[0].ref }); assert.equal(played.verified, true); assert.equal(played.message, 'Media is playing.');
  video.paused = true; video.play = async () => {};
  page = (await f.driver.perform('read_page')).page;
  const unobserved = await f.driver.perform('media_play', { ref: page.media[0].ref }); assert.equal(unobserved.verified, false); assert.notEqual(unobserved.message, 'Media is playing.');
  f.node('BUTTON', 'No visible effect', 'button'); page = (await f.driver.perform('read_page')).page;
  assert.equal((await f.driver.perform('click', { ref: page.controls[1].ref })).verified, false);
});

test('scroll verifies changed coordinates and explicit cancellation closes only the dedicated browser', async t => {
  const f = fixture(t); await f.driver.perform('open_url', { url: 'https://example.org/' });
  const scroll = await f.driver.perform('scroll', { direction: 'down', amount: 300 }); assert.equal(scroll.verified, true); assert.equal(scroll.page.scroll.y, 300);
  f.state.active = false; f.driver.cancel(); assert.equal(f.state.windows[0].closed, true);
  assert.equal((await f.driver.perform('read_page')).error, 'canceled');
});

test('stopping an idle agent preserves visible work and playback, drops references and allows a future lease to reobserve', async t => {
  const f = fixture(t), video = f.node('VIDEO', 'Video', '');
  video.paused = false; video.ended = false; video.readyState = 4;
  const page = (await f.driver.perform('open_url', { url: 'https://example.org/' })).page;
  f.state.active = false; f.driver.cancel({ keepIdleWindow: true });
  assert.equal(f.state.windows[0].closed, undefined); assert.equal(video.paused, false); assert.equal(f.state.stoppedLoads, 1);
  const publicResource = await new Promise(resolve => f.state.request({ url: 'https://cdn.example.org/segment', resourceType: 'media' }, resolve));
  assert.equal(publicResource.cancel, false, 'The detached public browser may continue buffering video');
  const privateResource = await new Promise(resolve => f.state.request({ url: 'https://localhost/segment', resourceType: 'media' }, resolve));
  assert.equal(privateResource.cancel, true);
  assert.equal((await f.driver.perform('read_page')).error, 'canceled');
  f.state.active = true;
  assert.equal((await f.driver.perform('click', { ref: page.controls[0].ref })).error, 'read_required');
  const observed = await f.driver.perform('read_page'); assert.equal(observed.ok, true); assert.equal(observed.page.media[0].playing, true);
  assert.notEqual(observed.page.controls[0].ref, page.controls[0].ref);
});

test('revoking a pending action closes the dedicated renderer and prevents a late validated click', async t => {
  let calls = 0, resolve;
  const f = fixture(t, { lookupHost: async () => ++calls === 3 ? new Promise(done => { resolve = done; }) : [{ address: '8.8.8.8' }] });
  const link = f.node('A', 'Public link', ''); link.href = 'https://other.example.org/';
  const page = (await f.driver.perform('open_url', { url: 'https://example.org/' })).page;
  const pending = f.driver.perform('click', { ref: page.controls[0].ref });
  for (let i = 0; i < 10 && !resolve; i++) await Promise.resolve();
  assert.equal(typeof resolve, 'function');
  f.state.active = false; f.driver.cancel({ keepIdleWindow: true });
  assert.equal(f.state.windows[0].closed, true);
  resolve([{ address: '8.8.8.8' }]);
  assert.equal((await pending).error, 'canceled'); assert.equal(link.clicked, undefined);
  f.state.active = true;
  assert.equal((await f.driver.perform('open_url', { url: 'https://new.example.org/' })).ok, true);
  assert.equal(f.state.windows.length, 2);
});

test('cancel rejects a pending renderer promise promptly rather than waiting for media or navigation forever', async t => {
  const f = fixture(t), video = f.node('VIDEO', 'Video', '');
  video.paused = true; video.ended = false; video.readyState = 0; video.play = () => new Promise(() => {});
  const page = (await f.driver.perform('open_url', { url: 'https://example.org/' })).page;
  const pending = f.driver.perform('media_play', { ref: page.media[0].ref });
  for (let i = 0; i < 15 && f.state.scripts.length < 3; i++) await Promise.resolve();
  f.state.active = false; f.driver.cancel({ keepIdleWindow: true });
  const result = await Promise.race([pending, new Promise(resolve => { const timer = setTimeout(() => resolve({ error: 'hung' }), 100); timer.unref(); })]);
  assert.equal(result.error, 'canceled'); assert.equal(f.state.windows[0].closed, true);
});

test('verification rereads the actual target after settling rather than trusting a transient type or play result', async t => {
  let input, undo = false;
  const f = fixture(t, { pause: async () => { if (undo) input.value = 'reverted by page'; } });
  input = f.node('INPUT', 'Search', 'search');
  const page = (await f.driver.perform('open_url', { url: 'https://example.org/' })).page;
  undo = true;
  assert.equal((await f.driver.perform('type', { ref: page.controls[0].ref, text: 'requested value' })).verified, false);
  let video, endPlayback = false;
  const media = fixture(t, { pause: async () => { if (endPlayback) video.paused = true; } });
  video = media.node('VIDEO', 'Video', ''); video.paused = true; video.ended = false; video.readyState = 4;
  video.play = async () => { video.paused = false; endPlayback = true; };
  const mediaPage = (await media.driver.perform('open_url', { url: 'https://example.org/' })).page;
  const played = await media.driver.perform('media_play', { ref: mediaPage.media[0].ref }); assert.equal(played.verified, false); assert.notEqual(played.message, 'Media is playing.');
});

test('manual window closure is reusable, old close events cannot clear a replacement, and only close permanently disposes', async t => {
  const f = fixture(t);
  await f.driver.perform('open_url', { url: 'https://example.org/' });
  const original = f.state.windows[0]; original.destroy();
  assert.equal((await f.driver.perform('open_url', { url: 'https://new.example.org/' })).ok, true);
  assert.equal(f.state.windows.length, 2);
  original.emit('closed');
  assert.equal((await f.driver.perform('read_page')).ok, true);
  assert.equal(f.state.windows.length, 2);
  f.driver.close();
  assert.equal((await f.driver.perform('open_url', { url: 'https://example.org/' })).error, 'canceled');
  assert.equal(f.state.windows.length, 2);
});

test('scroll cannot act on a replaced document or after an in-page navigation invalidates its observation', async t => {
  const f = fixture(t); await f.driver.perform('open_url', { url: 'https://example.org/' });
  vm.runInContext('globalThis.__synapsesControlledBrowserState = null', f.context);
  const stale = await f.driver.perform('scroll', { direction: 'down', amount: 300 });
  assert.equal(stale.error, 'stale_ref'); assert.equal(f.state.y, 0);
  await f.driver.perform('read_page');
  f.state.windows[0].webContents.emit('did-navigate-in-page', {}, 'https://example.org/#changed', true);
  assert.equal((await f.driver.perform('scroll', { direction: 'down' })).error, 'read_required');
  assert.equal(f.state.y, 0);
});

test('async lease verdicts cannot be mistaken for synchronous permission', async t => {
  for (const assertActive of [async () => false, async () => true, async () => { throw Error('denied'); }]) {
    const f = fixture(t, { assertActive });
    assert.equal((await f.driver.perform('open_url', { url: 'https://example.org/' })).error, 'canceled');
    assert.equal(f.state.windows.length, 0); assert.equal(f.state.loads.length, 0);
  }
});
