import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ava-app-entry.js', import.meta.url), 'utf8');
class FakeElement extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag; this.document = document; this.children = []; this.attrs = new Map();
    this.hidden = false; this.open = false; this.dataset = {}; this.inert = false; this.style = {};
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
  }
  set id(value) { this._id = value; this.document.nodes.set(value, this); }
  get id() { return this._id; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...values) { values.forEach(value => { this.children.push(value); value.parentNode = this; }); }
  appendChild(value) { this.append(value); return value; }
  insertBefore(value, reference) { const i = this.children.indexOf(reference); if (i < 0) return this.appendChild(value); this.children.splice(i, 0, value); value.parentNode = this; return value; }
  remove() { if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(value => value !== this); this.document.nodes.delete(this.id); }
  getClientRects() { return this.hidden || this.style.display === 'none' ? [] : [{}]; }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  click() { this.dispatchEvent(new Event('click')); }
  closest(name) { return name === 'button' && this.tagName === 'button' ? this : null; }
}
function setup({ search = '?ava-app=1', signedIn = true, auth = false, welcome = false, chatReady = true } = {}) {
  const document = new EventTarget(); document.nodes = new Map();
  document.documentElement = new FakeElement('html', document); document.body = new FakeElement('body', document);
  document.readyState = 'complete'; document.hidden = false;
  document.createElement = tag => new FakeElement(tag, document);
  document.getElementById = id => document.nodes.get(id) || null;
  function element(id, hidden) { const node = document.createElement(id === 'acClose' || id === 'acMainChat' ? 'button' : 'div'); node.id = id; node.hidden = hidden; document.body.append(node); return node; }
  const authNode = element('authModal', !auth), welcomeNode = element('avaWelcome', !welcome), chat = element('avaCompanionChat', true);
  element('acClose', false); element('acMainChat', false); element('acConfirm', true);
  let time = 1000, next = 0; const tasks = new Map();
  const schedule = (fn, delay = 0) => { const id = ++next; tasks.set(id, { at: time + delay, fn }); return id; };
  const clear = id => tasks.delete(id);
  function advance(ms) { time += ms; for (let count = 0; count < 100; count++) { const entry = [...tasks].filter(([,value]) => value.at <= time).sort((a,b) => a[1].at - b[1].at)[0]; if (!entry) return; tasks.delete(entry[0]); entry[1].fn(); } throw Error('Timer loop did not settle.'); }
  const window = new EventTarget(); let opens = 0, closes = 0;
  window.location = { search };
  window.CustomEvent = class extends Event { constructor(name, options) { super(name); this.detail = options.detail; } };
  window.MutationObserver = class { observe() {} disconnect() {} };
  window.getComputedStyle = node => ({ display: node.style.display || 'block', visibility: node.style.visibility || 'visible' });
  window.currentUser = signedIn ? { id: 'real-owner', email: 'owner@example.test', isGuest: false } : null;
  window.avaCompanionChatBridge = { uiKey: () => window.currentUser ? 'real-owner|owner@example.test' : 'guest' };
  const chatOptions = [];
  function makeChatReady() { window.avaCompanionChatOpen = async options => { opens++; chatOptions.push(options); chat.hidden = false; return { status: 'opened' }; }; }
  if (chatReady) makeChatReady();
  window.avaCompanionChatClose = () => { closes++; chat.hidden = true; document.body.inert = false; };
  const calls = []; window.avaFloatingOpenAction = action => { calls.push(action); return action; };
  const context = vm.createContext({ window, document, URLSearchParams, Date: { now: () => time }, setTimeout: schedule, clearTimeout: clear, Promise, Map, Set });
  const inject = () => vm.runInContext(source, context);
  const events = []; window.addEventListener('ava:app-ready', event => events.push(event.detail));
  inject();
  return { window, document, authNode, welcomeNode, chat, advance, inject, makeChatReady, calls, events, chatOptions,
    get opens() { return opens; }, get closes() { return closes; } };
}
async function settle(f, ms = 250) { f.advance(ms); for (let i = 0; i < 8; i++) await Promise.resolve(); }

test('ordinary site and non-exact flags do not initialize app mode', () => {
  for (const search of ['', '?ava-app=0', '?ava-app=true', '?not-ava-app=1']) {
    const f = setup({ search }); assert.equal(f.window.avaAppEntry, undefined); assert.equal(f.document.documentElement.classList.contains('ava-app-mode'), false); assert.equal(f.opens, 0);
  }
});
test('signed-in app opens the real existing chat once after legacy startup settles', async () => {
  const f = setup(); assert.equal(f.opens, 0); await settle(f); assert.equal(f.opens, 1); assert.equal(f.window.avaAppEntry.stage, 'chat');
  f.window.avaAppEntry.refresh(); await settle(f); assert.equal(f.opens, 1); assert.equal(f.events.length, 1); assert.equal(f.window.avaMobileEntry, f.window.avaAppEntry);
});
test('sign-in stays accessible and no chat is opened until an actual user exists', async () => {
  const f = setup({ signedIn: false, auth: true }); await settle(f); assert.equal(f.opens, 0); assert.equal(f.window.avaAppEntry.stage, 'auth');
  f.authNode.hidden = true; f.window.currentUser = { id: 'real-owner', email: 'owner@example.test' }; f.window.avaAppEntry.refresh(); await settle(f); assert.equal(f.opens, 1);
});
test('welcome gets its existing handoff before Ava opens', async () => {
  const f = setup({ welcome: true }); await settle(f); assert.equal(f.opens, 0); assert.equal(f.window.avaAppEntry.stage, 'welcome');
  f.welcomeNode.hidden = true; f.window.dispatchEvent(new Event('ava:welcome-closed')); await settle(f); await settle(f); assert.equal(f.opens, 1);
});
test('a pending but still-hidden welcome is not reported as a ready visible surface', async () => {
  const f = setup({ signedIn: false }); f.window.__avaWelcomePending = true;
  f.window.avaAppEntry.refresh(); await settle(f);
  assert.equal(f.window.avaAppEntry.stage, 'waiting'); assert.equal(f.events.length, 0); assert.equal(f.opens, 0);
  f.welcomeNode.hidden = false; f.window.avaAppEntry.refresh(); assert.equal(f.window.avaAppEntry.stage, 'welcome'); assert.equal(f.events.length, 1);
});
test('late chat availability waits for ava:chat-ready rather than using a fake screen', async () => {
  const f = setup({ chatReady: false }); await settle(f); assert.equal(f.opens, 0);
  f.makeChatReady(); f.window.dispatchEvent(new Event('ava:chat-ready')); await settle(f); assert.equal(f.opens, 1);
});
test('voice and account handoffs do not get a constant auto-reopen loop', async () => {
  const f = setup(); await settle(f); f.chat.hidden = true; f.window._topNavVoiceActive = true;
  f.window.avaAppEntry.refresh(); await settle(f); assert.equal(f.opens, 1); assert.equal(f.window.avaAppEntry.stage, 'voice');
  f.window._topNavVoiceActive = false; f.window.avaAppEntry.openMenu(); await settle(f); assert.equal(f.opens, 1); assert.equal(f.window.avaAppEntry.stage, 'tools');
  f.window.avaAppEntry.open(); await settle(f); assert.equal(f.opens, 2); assert.equal(f.window.avaAppEntry.stage, 'chat');
});
test('an auth gate opened over mobile chat closes chat and releases its inert background', async () => {
  const f = setup(); await settle(f); f.document.body.inert = true; f.authNode.hidden = false;
  f.window.avaAppEntry.refresh(); assert.equal(f.chat.hidden, true); assert.equal(f.document.body.inert, false); assert.equal(f.window.avaAppEntry.stage, 'auth'); assert.equal(f.opens, 1);
});
test('reinjection is idempotent and destroy restores ordinary site controls', async () => {
  const f = setup(); await settle(f); const api = f.window.avaAppEntry;
  f.inject(); await settle(f); assert.equal(f.window.avaAppEntry, api); assert.equal(f.opens, 1);
  api.destroy(); assert.equal(f.window.avaAppEntry, undefined); assert.equal(f.window.__avaMobileEntryReady, undefined); assert.equal(f.document.documentElement.classList.contains('ava-app-mode'), false);
  assert.equal(f.document.getElementById('acClose').getAttribute('aria-label'), null);
});
test('a native account bridge that warms without a DOM mutation gets a bounded startup retry', async () => {
  const f = setup({ signedIn: false });
  f.window.currentUser = { id: 'real-owner', email: 'owner@example.test' };
  await settle(f, 300); await settle(f, 300);
  assert.equal(f.opens, 1); assert.equal(f.window.avaAppEntry.stage, 'chat');
  // A later ordinary surface closure is deliberate, not an instruction to reopen.
  f.chat.hidden = true; f.window.avaAppEntry.refresh(); await settle(f, 30000); assert.equal(f.opens, 1);
});
test('native tools use an allowlisted intentional handoff and unknown actions have no effect', async () => {
  const f = setup(); await settle(f); const closes = f.closes;
  assert.equal(f.window.avaAppEntry.action('untrusted-other-action'), 'unavailable'); assert.equal(f.closes, closes); assert.equal(f.calls.length, 0);
  assert.equal(f.window.avaAppEntry.action('notes'), 'notes'); assert.deepEqual(f.calls, ['notes']);
  await settle(f); assert.equal(f.window.avaAppEntry.stage, 'tools'); assert.equal(f.opens, 1);
});

test('setup starts before chat for a late signed-in account and hands off once completed', async () => {
  const f = setup({ signedIn: false }); let needsSetup = true, starts = 0;
  f.window.avaWelcomeShouldStart = () => needsSetup;
  f.window.avaWelcomeMaybeStart = () => { starts++; f.welcomeNode.hidden = false; return true; };
  f.window.currentUser = { id: 'real-owner', email: 'owner@example.test' };
  f.window.avaAppEntry.refresh(); await settle(f);
  assert.equal(starts, 1); assert.equal(f.opens, 0); assert.equal(f.window.avaAppEntry.stage, 'welcome');
  needsSetup = false; f.welcomeNode.hidden = true; f.window.dispatchEvent(new Event('ava:welcome-closed'));
  await settle(f); await settle(f); assert.equal(f.opens, 1);
});

test('replaying introduction releases chat focus isolation and does not bypass sign-in', async () => {
  const f = setup(); await settle(f); let options;
  f.window.openAvaWelcome = value => { options = value; f.welcomeNode.hidden = false; };
  f.document.body.inert = true;
  assert.equal(f.window.avaAppEntry.showIntroduction(), true);
  assert.equal(f.chat.hidden, true); assert.equal(f.document.body.inert, false); assert.equal(options.replay, true);
  assert.equal(f.window.avaAppEntry.stage, 'welcome');
  f.welcomeNode.hidden = true; f.authNode.hidden = false;
  assert.equal(f.window.avaAppEntry.showIntroduction(), false);
});

test('setup starter enters the real Ava draft without sending a message', async () => {
  const f = setup(); await settle(f);
  f.window.avaAppEntry.stagePrompt('Help me plan the week'); await settle(f);
  assert.equal(f.chatOptions.at(-1).message, 'Help me plan the week');
  assert.equal(f.chatOptions.at(-1).send, false); assert.equal(f.window.avaAppEntry.stage, 'chat');
});

test('live voice stop is inside the chat boundary and only stops the real session', async () => {
  const f = setup(); await settle(f); let stops = 0;
  f.window._topNavVoiceActive = true;
  f.window.stopTopNavVoice = () => { stops++; f.window._topNavVoiceActive = false; };
  f.window.avaAppEntry.refresh();
  const bar = f.document.getElementById('avaAppVoiceBar'), stop = f.document.getElementById('avaAppVoiceStop');
  assert.equal(bar.parentNode, f.chat); assert.equal(bar.hidden, false); assert.equal(bar.inert, false);
  stop.click(); await settle(f); assert.equal(stops, 1); assert.equal(bar.hidden, true);
  assert.equal(f.window._topNavVoiceActive, false); assert.equal(f.opens, 1);
  f.window.avaAppEntry.destroy(); assert.equal(f.document.getElementById('avaAppVoiceBar'), null);
});

test('Ava first-run setup has its own per-account completion marker without changing desktop completion', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const line = page.split('\n').find(value => value.includes('window.avaWelcomeStorageKey=function'));
  assert.ok(line);
  function key(search, owner) {
    const window = { currentUser: owner };
    vm.runInNewContext(line, { window, currentUser: owner, location: { search }, URLSearchParams });
    return window.avaWelcomeStorageKey();
  }
  const owner = { id: 'owner-123', email: 'owner@example.test' };
  assert.equal(key('', owner), 'synapses_ava_welcome_v1_owner-123');
  assert.equal(key('?ava-app=1', owner), 'synapses_ava_app_welcome_v1_owner-123');
  assert.equal(key('?ava-app=1', { isGuest: true }), 'synapses_ava_app_welcome_v1_guest');
  assert.notEqual(key('?ava-app=1', owner), key('?ava-app=1', { id: 'other-owner' }));
});
