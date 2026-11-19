import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../ava-app-entry.js', import.meta.url), 'utf8');
class FakeElement extends EventTarget {
  constructor(tag, document) {
    super(); this.tagName = tag; this.document = document; this.children = []; this.attrs = new Map();
    this.hidden = false; this.open = false; this.dataset = {}; this.inert = false; this.style = {};
    const properties = new Map();
    this.style.setProperty = (name, value, priority = '') => properties.set(name, { value, priority });
    this.style.getPropertyValue = name => properties.get(name)?.value || '';
    this.style.getPropertyPriority = name => properties.get(name)?.priority || '';
    this.style.removeProperty = name => properties.delete(name);
    const classes = new Set();
    this.classList = { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value) };
  }
  set id(value) { this._id = value; this.document.nodes.set(value, this); }
  get id() { return this._id; }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  removeAttribute(name) { this.attrs.delete(name); }
  append(...values) { values.forEach(value => { if (value.parentNode) value.parentNode.children = value.parentNode.children.filter(child => child !== value); this.children.push(value); value.parentNode = this; }); }
  appendChild(value) { this.append(value); return value; }
  insertBefore(value, reference) { if (!reference) return this.appendChild(value); if (value.parentNode) value.parentNode.children = value.parentNode.children.filter(child => child !== value); const i = this.children.indexOf(reference); if (i < 0) return this.appendChild(value); this.children.splice(i, 0, value); value.parentNode = this; return value; }
  contains(value) { for (let node = value; node; node = node.parentNode) if (node === this) return true; return false; }
  get nextSibling() { return this.parentNode?.children[this.parentNode.children.indexOf(this) + 1] || null; }
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
  function element(id, hidden) { const node = document.createElement(['acClose', 'acMainChat', 'acHistory', 'acNewTop', 'acVoice', 'topNavVoiceBtn'].includes(id) ? 'button' : 'div'); node.id = id; node.hidden = hidden; document.body.append(node); return node; }
  const authNode = element('authModal', !auth), welcomeNode = element('avaWelcome', !welcome), chat = element('avaCompanionChat', true);
  element('acClose', false); element('acMainChat', false); element('acConfirm', true); element('acNewTop', false); element('acVoice', false);
  const history = element('acHistory', false), actions = element('acTopActions', false); chat.appendChild(actions); actions.appendChild(history);
  const mic = element('topNavVoiceBtn', false), wave = element('tnvWaveIcon', false); mic.appendChild(wave);
  mic.style.setProperty('position', 'fixed', 'important'); mic.style.setProperty('top', '96px', 'important');
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
  window.avaCompanionChatClose = () => { closes++; chat.hidden = true; document.body.inert = false; mic.inert = false; };
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
test('the mobile history control becomes a compose shortcut on Home', async () => {
  const f = setup();
  const nav = f.document.getElementById('acHistory');
  nav.setAttribute('aria-label', 'Show conversations');
  nav.setAttribute('aria-expanded', 'false');
  nav.innerHTML = '<svg>history</svg>';
  const input = f.document.createElement('textarea'); input.id = 'acInput';
  let focused = 0; input.focus = () => { focused++; };
  f.chat.append(input);
  f.document.documentElement.classList.add('ava-app-handheld');
  f.chat.dataset.home = 'true';
  await settle(f);
  f.window.avaAppEntry.refresh();
  assert.equal(nav.getAttribute('aria-label'), 'New conversation');
  assert.match(nav.innerHTML, /M12 5v14/);
  const tap = new Event('click', { cancelable: true }); Object.defineProperty(tap, 'target', { value: nav });
  f.document.dispatchEvent(tap);
  assert.equal(tap.defaultPrevented, true);
  assert.equal(focused, 1);
  assert.equal(f.opens, 1);
  f.chat.dataset.home = 'false';
  f.window.avaAppEntry.refresh();
  assert.equal(nav.getAttribute('aria-label'), 'Back to conversations');
  assert.equal(nav.innerHTML, '<svg>history</svg>');
  const back = new Event('click', { cancelable: true }); Object.defineProperty(back, 'target', { value: nav });
  f.document.dispatchEvent(back);
  assert.equal(back.defaultPrevented, false);
  assert.equal(focused, 1);
  f.window.avaAppEntry.destroy();
  assert.equal(nav.getAttribute('aria-label'), 'Show conversations');
  assert.equal(nav.getAttribute('aria-expanded'), 'false');
});
test('signed-in app opens the real existing chat once after legacy startup settles', async () => {
  const f = setup(); assert.equal(f.opens, 0); await settle(f); assert.equal(f.opens, 1); assert.equal(f.window.avaAppEntry.stage, 'chat');
  assert.equal(f.chatOptions[0].focus, false);
  assert.equal(f.chatOptions[0].home, true);
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

test('the original animated voice icon docks in the chat header and stops the real session', async () => {
  const f = setup(); await settle(f); let stops = 0;
  const mic = f.document.getElementById('topNavVoiceBtn'), wave = f.document.getElementById('tnvWaveIcon'), originalParent = mic.parentNode;
  mic.inert = true;
  f.window._topNavVoiceActive = true;
  f.window.stopTopNavVoice = () => { stops++; f.window._topNavVoiceActive = false; };
  f.window.avaAppEntry.refresh();
  const dock = f.document.getElementById('avaAppVoiceDock');
  assert.equal(dock.parentNode, f.document.getElementById('acTopActions')); assert.equal(dock.hidden, false);
  assert.equal(mic.parentNode, dock); assert.equal(mic.inert, false); assert.equal(mic.children[0], wave);
  assert.equal(mic.style.getPropertyValue('position'), 'static'); assert.equal(mic.getAttribute('aria-label'), 'Stop voice conversation');
  const event = new Event('click', { cancelable: true }); Object.defineProperty(event, 'target', { value: mic }); f.document.dispatchEvent(event);
  await settle(f); assert.equal(stops, 1); assert.equal(dock.hidden, false); assert.equal(f.document.getElementById('acVoice').hidden, false); assert.equal(event.defaultPrevented, true);
  assert.equal(mic.parentNode, originalParent); assert.equal(mic.style.getPropertyValue('position'), 'fixed');
  assert.equal(f.window._topNavVoiceActive, false); assert.equal(f.opens, 1);
  f.window.avaAppEntry.destroy(); assert.equal(f.document.getElementById('avaAppVoiceDock'), null); assert.equal(f.document.getElementById('topNavVoiceBtn'), mic);
});

test('legacy mic relocation cannot leave the live icon inert outside the chat', async () => {
  const f = setup(); await settle(f); const mic = f.document.getElementById('topNavVoiceBtn'), wave = f.document.getElementById('tnvWaveIcon');
  f.window._topNavVoiceActive = true; f.window.avaAppEntry.refresh();
  f.document.body.appendChild(mic); mic.inert = true; mic.style.setProperty('position', 'fixed', 'important');
  f.window.avaAppEntry.refresh();
  assert.equal(mic.parentNode, f.document.getElementById('avaAppVoiceDock')); assert.equal(mic.inert, false); assert.equal(mic.children[0], wave);
  f.window.avaAppEntry.openMenu(); assert.equal(mic.parentNode, f.document.getElementById('avaAppVoiceDock'));
  assert.equal(f.chat.hidden, false); assert.equal(f.document.getElementById('avaAppMenu').open, true);
});

test('menu, setup, auth and welcome handoffs preserve chat isolation cleanup for the real mic', async () => {
  for (const handoff of ['setup', 'auth', 'welcome']) {
    const f = setup(); await settle(f); const mic = f.document.getElementById('topNavVoiceBtn');
    mic.inert = true; f.window._topNavVoiceActive = true; f.window.avaAppEntry.refresh();
    if (handoff === 'setup') { f.window.openAvaWelcome = () => { f.welcomeNode.hidden = false; }; f.window.avaAppEntry.showIntroduction(); }
    if (handoff === 'auth') { f.authNode.hidden = false; f.window.avaAppEntry.refresh(); }
    if (handoff === 'welcome') { f.welcomeNode.hidden = false; f.window.avaAppEntry.refresh(); }
    assert.equal(mic.parentNode, f.document.body, handoff); assert.equal(mic.inert, false, handoff);
  }
});

test('the compact menu stays over the conversation and the header phone opens Calls without placing one', async () => {
  const f = setup(); await settle(f); f.window.avaAppEntry.openMenu();
  assert.equal(f.chat.hidden, false); assert.equal(f.document.getElementById('avaAppMenu').open, true);
  f.window.avaAppEntry.showChat(); await settle(f);
  assert.equal(f.opens, 1); assert.equal(f.document.getElementById('avaAppMenu').open, false);
  const phone = f.document.getElementById('acNewTop'); assert.equal(phone.getAttribute('aria-label'), 'Open Calls');
  const event = new Event('click', { cancelable: true }); Object.defineProperty(event, 'target', { value: phone }); f.document.dispatchEvent(event);
  assert.deepEqual(f.calls, ['call-records']); assert.equal(event.defaultPrevented, true); assert.equal(f.chat.hidden, true);
});

test('one header slot holds the talk mic when idle and the original animated mic when live', async () => {
  const f = setup(); await settle(f);
  const dock = f.document.getElementById('avaAppVoiceDock'), talk = f.document.getElementById('acVoice'), animated = f.document.getElementById('topNavVoiceBtn');
  assert.equal(talk.parentNode, dock); assert.equal(talk.hidden, false); assert.equal(dock.hidden, false);
  f.window._topNavVoiceActive = true; f.window.avaAppEntry.refresh();
  assert.equal(talk.hidden, true); assert.equal(animated.parentNode, dock); assert.equal(animated.inert, false);
  f.window.avaAppEntry.destroy(); assert.equal(talk.parentNode, f.document.body); assert.equal(talk.hidden, false);
});

test('Back to Ava Home closes Calls through its real cleanup handlers and preserves draft/live call state', async () => {
  const f = setup(); await settle(f); f.window.avaAppEntry.action('calls');
  const trace = [], node = (id, tag = 'div') => { const n = f.document.createElement(tag); n.id = id; f.document.body.appendChild(n); return n; };
  const workspace = node('avaCallsWorkspace'), close = node('acwClose', 'button');
  f.chat.inert = true; close.addEventListener('click', () => { trace.push('workspace'); workspace.hidden = true; f.chat.inert = false; });
  const draft = node('callSuccessOverlay'); draft.classList.add('show'); const phone = node('csNewPhone'); phone.value = '+15550123456';
  f.window._csMinimizeForPulse = () => { trace.push('draft'); draft.classList.remove('show'); };
  f.window.csDismiss = () => { throw Error('must not acknowledge or cancel the call'); };
  const credits = node('avaCreditsDialog', 'dialog'); credits.showModal(); credits.addEventListener('close', () => trace.push('credits'));
  const oldOpen = f.window.avaCompanionChatOpen; f.window.avaCompanionChatOpen = options => { assert.equal(f.chat.inert, false); trace.push('chat'); return oldOpen(options); };
  f.window.avaAppEntry.home(); await settle(f);
  assert.deepEqual(trace, ['workspace', 'draft', 'credits', 'chat']); assert.equal(phone.value, '+15550123456');
  assert.equal(f.chatOptions.at(-1).home, true); assert.equal(f.chatOptions.at(-1).focus, false);
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

test('the real chat opener avoids automatic app keyboard focus while preserving explicit and desktop focus', async () => {
  const page = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const opener = page.match(/window\.avaCompanionChatOpen=async function\(options\)\{[\s\S]*?\n \};/);
  const focusHelper = page.match(/function focusComposer\(force\)\{[^\n]+/);
  const homeHelper = page.match(/function appHomeMode\(\)\{[^\n]+/);
  assert.ok(opener && focusHelper && homeHelper);
  async function open(appMode, options) {
    let focuses = 0;
    const window = {}, context = vm.createContext({
      window, document: { activeElement: null, documentElement: { classList: { contains: () => appMode } } },
      openVersion: 0, opened: false, focusBefore: null, root: { hidden: true }, lastUi: 'same',
      bridge: { uiKey: () => 'same', verify: async () => {}, current: () => null, invalidate() {} },
      state: { owner: null }, input: { focus: () => { focuses++; } }, current: () => ({}), homeView: false,
      mobileFocusMode() {}, notify() {}, ownerChanged() {}, createThread() {}, render() {}, syncTasks() {}, rememberDraft() {}, closeHistory() {},
      requestAnimationFrame: callback => callback()
    });
    vm.runInContext(focusHelper[0] + '\n' + homeHelper[0] + '\n' + opener[0], context); await window.avaCompanionChatOpen(options); return focuses;
  }
  assert.equal(await open(true), 0);
  assert.equal(await open(true, { focus: false }), 0);
  assert.equal(await open(true, { focus: true }), 1);
  assert.equal(await open(false), 1);
});

test('Ava sign-in branding preserves the real form action and restores its original copy on teardown', () => {
  const f = setup({ signedIn: false, auth: true });
  const form = f.document.createElement('div'); form.id = 'loginForm'; f.document.body.appendChild(form);
  const title = f.document.createElement('div'), subtitle = f.document.createElement('div'), submit = f.document.createElement('button');
  title.textContent = 'Welcome back'; subtitle.textContent = 'Original account copy'; submit.textContent = 'Sign In';
  const handler = () => {}; submit.onclick = handler;
  form.querySelector = selector => ({ '.auth-step-title': title, '.auth-step-sub': subtitle, '.modal-btn': submit })[selector];
  f.window.avaAppEntry.refresh();
  assert.equal(title.textContent, 'Sign in to Ava'); assert.equal(submit.onclick, handler);
  f.window.avaAppEntry.destroy();
  assert.equal(title.textContent, 'Welcome back'); assert.equal(subtitle.textContent, 'Original account copy'); assert.equal(submit.onclick, handler);
});
