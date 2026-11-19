import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script id="avaCompanionChatScript">([\s\S]*?)<\/script>/)?.[1];
const markup = html.match(/<section id="avaCompanionChat"[\s\S]*?<\/section>/)?.[0];
assert.ok(source && markup, 'Run the real companion script against its real control IDs');

class Element extends EventTarget {
  constructor(tag = 'div') {
    super(); this.tagName = tag.toUpperCase(); this.children = []; this.parentNode = null;
    this.dataset = {}; this.style = {}; this.attrs = new Map(); this.hidden = false;
    this.value = ''; this.disabled = false; this.inert = false; this.className = '';
    this.focuses = 0; this.scrollHeight = 700; this.scrollTop = 0; this.clientHeight = 600;
    const classes = new Set();
    this.classList = { contains: value => classes.has(value), add: value => classes.add(value),
      remove: value => classes.delete(value), toggle: (value, force) => {
        const enabled = force ?? !classes.has(value);
        if (enabled) classes.add(value); else classes.delete(value); return enabled;
      } };
  }
  set textContent(value) { this.text = String(value); this.children = []; }
  get textContent() { return (this.text || '') + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw Error('Home rendering must not inject HTML'); }
  appendChild(child) { if (child.parentNode) child.parentNode.children = child.parentNode.children.filter(x => x !== child); this.children.push(child); child.parentNode = this; return child; }
  append(...children) { children.forEach(child => this.appendChild(child)); }
  replaceChildren(...children) { this.children.forEach(child => { child.parentNode = null; }); this.children = []; this.text = ''; this.append(...children); }
  setAttribute(name, value) { this.attrs.set(name, String(value)); }
  getAttribute(name) { return this.attrs.get(name) ?? null; }
  querySelectorAll() { return []; }
  contains(child) { for (let node = child; node; node = node.parentNode) if (node === this) return true; return false; }
  getClientRects() { return this.hidden ? [] : [{}]; }
  focus() { this.focuses++; }
  get isConnected() { return true; }
  click() { const event = new Event('click', { cancelable: true }); this.onclick?.(event); this.dispatchEvent(event); }
}
function deferred() { let resolve; const promise = new Promise(yes => { resolve = yes; }); return { promise, resolve }; }
const alice = { id: 'owner-a', email: 'alice@example.test' };
const bob = { id: 'owner-b', email: 'bob@example.test' };
const storageKey = owner => 'synapses_ava_companion_v1_' + encodeURIComponent(owner.id);
function thread(id, { title = id, updated = 1, draft = '', messages = [{ id: id + '-m', role: 'user', text: id, status: 'done' }] } = {}) {
  return { id, title, updated, draft, messages };
}
function setup({ app = true, owner = alice, threads = [], active = threads[0]?.id ?? null, homeDraft = '', storage = new Map() } = {}) {
  let identity = owner, subscription = () => {}, writable = true;
  if (owner && !storage.has(storageKey(owner))) storage.set(storageKey(owner), JSON.stringify({ version: 1, owner: owner.id, threads, active, homeDraft }));
  const nodes = new Map(), document = new EventTarget();
  document.documentElement = new Element('html'); if (app) document.documentElement.classList.add('ava-app-mode');
  document.body = new Element('body'); document.activeElement = null; document.hidden = false;
  for (const match of markup.matchAll(/\bid="([^"]+)"/g)) { const node = new Element(); node.id = match[1]; nodes.set(node.id, node); }
  const root = nodes.get('avaCompanionChat'); root.hidden = true; root.dataset.history = 'false'; document.body.appendChild(root);
  for (const node of nodes.values()) if (node !== root) root.appendChild(node);
  nodes.get('acWelcome').appendChild(nodes.get('acHomeChats')); nodes.get('acConfirm').hidden = true;
  document.getElementById = id => nodes.get(id) || null; document.createElement = tag => new Element(tag);
  document.querySelector = () => null; document.querySelectorAll = () => [];
  const window = new EventTarget(), requests = [], gates = [], tasks = [], timers = new Map(); let timerId = 0;
  const bridge = {
    uiKey: () => identity ? identity.id + '|' + identity.email : 'guest',
    subscribe(fn) { subscription = fn; }, invalidate() {},
    async verify() { subscription(identity); return identity; }, current: () => identity,
    isCurrent: value => !!(identity && value && value.id === identity.id && value.email === identity.email),
    async check() { return identity ? { status: 'ready', owner: identity } : { status: 'signin' }; },
    send(options) { const pending = deferred(); requests.push({ ...pending, options }); return pending.promise; },
    async listTasks() { return { status: 'ok', tasks: tasks.slice() }; },
    async startTask(goal) { const task = { id: 'task-1', goal, stage: 'Queued', status: 'queued', createdAt: new Date().toISOString() }; tasks.push(task); return { status: 'ok', task }; },
    gate(status) { gates.push(status); }, voice() { return 'speech-to-speech'; }, action() {}, openMain() {},
  };
  window.avaCompanionChatBridge = bridge; window.matchMedia = () => ({ matches: app }); window.crypto = { randomUUID };
  const context = vm.createContext({ window, document, Event, URL, AbortController, crypto: window.crypto,
    navigator: { clipboard: { async writeText() {} } },
    localStorage: { getItem: key => storage.get(key) ?? null, setItem: (key, value) => { if (!writable) throw Error('Storage unavailable'); storage.set(key, value); } },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; }, clearTimeout: id => timers.delete(id),
    setInterval() {}, requestAnimationFrame: callback => callback(),
  });
  vm.runInContext(source, context);
  return { window, document, root, nodes, storage, requests, gates, tasks,
    input: nodes.get('acInput'), node: id => nodes.get(id),
    rows: () => nodes.get('acHomeChats').children.filter(child => child.className === 'ac-home-chat-row').map(row => row.children[0]),
    changeOwner(value) { identity = value; },
    disableStorageWrites() { writable = false; },
    draft(value) { nodes.get('acInput').value = value; nodes.get('acInput').dispatchEvent(new Event('input')); },
    submit() { nodes.get('acForm').dispatchEvent(new Event('submit', { cancelable: true })); },
    flushDraft() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } },
    saved(value = identity) { return JSON.parse(storage.get(storageKey(value)) || 'null'); },
  };
}

test('the app live mic keeps Ava open and refreshes the header immediately without composer focus', async () => {
  const f = setup({ threads: [thread('one')], active: 'one' }); await f.window.avaCompanionChatOpen({ focus: false });
  let starts = 0, refreshes = 0;
  f.window.avaCompanionChatBridge.voice = () => { starts++; f.window._topNavVoiceActive = true; return 'speech-to-speech'; };
  f.window.avaAppEntry = { refresh: reason => { assert.equal(reason, 'voice-started'); refreshes++; } };
  f.node('acVoice').click();
  assert.equal(starts, 1); assert.equal(refreshes, 1); assert.equal(f.root.hidden, false); assert.equal(f.input.focuses, 0);
});

test('the ordinary desktop voice action keeps its existing handoff behavior', async () => {
  const f = setup({ app: false, threads: [thread('one')], active: 'one' }); await f.window.avaCompanionChatOpen({ focus: false });
  f.node('acVoice').click(); assert.equal(f.root.hidden, true);
});
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

function homeRow(f, id) {
  const open = f.rows().find(button => button.dataset.thread === id);
  const [, more, actions] = open.parentNode.children;
  return { open, more, actions, remove: actions.children[0] };
}

function point(element, type, { pointerType = 'touch', x = 18, y = 32 } = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, { pointerType, pointerId: 1, clientX: x, clientY: y });
  element.dispatchEvent(event);
  return event;
}

test('opening app Home never creates or saves an empty conversation', async () => {
  const f = setup(); await f.window.avaCompanionChatOpen({ home: true, focus: false });
  await f.window.avaCompanionChatHome(); f.window.avaCompanionChatClose(false);
  assert.equal(f.root.dataset.home, 'true'); assert.equal(f.saved().threads.length, 0);
  assert.equal(f.saved().active, null); assert.equal(f.input.focuses, 0);
});

test('Home shows every owned nonempty or draft conversation sorted by newest activity', async () => {
  const rows = Array.from({ length: 29 }, (_, i) => thread('chat-' + i, { updated: i + 1 }));
  rows.push(thread('draft', { updated: 50, draft: 'Unsent words', messages: [] }));
  const f = setup({ threads: rows, active: 'chat-3' }); await f.window.avaCompanionChatHome();
  assert.equal(f.rows().length, 30); assert.equal(f.rows()[0].dataset.thread, 'draft');
  assert.equal(f.rows()[1].dataset.thread, 'chat-28');
  f.window.avaCompanionChatClose(false); assert.equal(f.saved().active, 'chat-3');
});

test('Home omits empty conversations and treats saved titles and drafts as plain text', async () => {
  const title = '<img src=x onerror=alert(1)>', draft = '<script>not executable</script>';
  const f = setup({ threads: [thread('unsafe', { title, draft }), thread('empty', { messages: [] })] });
  await f.window.avaCompanionChatHome(); assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].children[0].textContent, title);
  assert.match(f.rows()[0].children[1].textContent, /<script>not executable<\/script>/);
  assert.equal(f.rows()[0].children[0].children.length, 0);
});

test('choosing a Home row opens that real conversation without focusing the composer', async () => {
  const f = setup({ threads: [thread('one'), thread('two', { draft: 'Keep this draft' })] });
  await f.window.avaCompanionChatHome(); f.rows().find(row => row.dataset.thread === 'two').click();
  assert.equal(f.root.dataset.home, 'false'); assert.equal(f.input.value, 'Keep this draft');
  assert.equal(f.input.focuses, 0); assert.ok(f.node('acMessages').children.length);
  assert.equal(f.saved().active, 'two');
});

test('holding a mobile conversation reveals Delete and requires confirmation before removing it', async () => {
  const f = setup({ threads: [thread('keep'), thread('remove', { title: 'Old chat', updated: 2 })], active: 'remove' });
  await f.window.avaCompanionChatHome();
  f.draft('Keep this Home draft');
  const row = homeRow(f, 'remove');
  assert.equal(row.more.getAttribute('aria-label'), 'More actions for Old chat');
  assert.equal(row.actions.hidden, true);
  point(row.open, 'pointerdown');
  f.flushDraft();
  point(row.open, 'pointerup');
  row.open.click();
  assert.equal(row.actions.hidden, false);
  assert.equal(row.more.getAttribute('aria-expanded'), 'true');
  assert.equal(f.root.dataset.home, 'true');
  assert.equal(f.node('acConfirm').hidden, true);
  assert.equal(f.saved().threads.length, 2);

  row.remove.click();
  assert.equal(f.node('acConfirm').hidden, false);
  assert.match(f.node('acDeleteMessage').textContent, /Old chat/);
  assert.equal(f.saved().threads.length, 2);
  f.node('acDeleteYes').click();
  assert.equal(f.node('acConfirm').hidden, true);
  assert.deepEqual(f.saved().threads.map(chat => chat.id), ['keep']);
  assert.equal(f.saved().active, 'keep');
  assert.equal(f.saved().homeDraft, 'Keep this Home draft');
  assert.equal(f.input.focuses, 0);
  assert.deepEqual(f.rows().map(button => button.dataset.thread), ['keep']);
});

test('movement or scrolling cancels a mobile hold and its release does not open the chat', async () => {
  for (const gesture of ['pointermove', 'scroll']) {
    const f = setup({ threads: [thread('kept')] });
    await f.window.avaCompanionChatHome();
    const row = homeRow(f, 'kept');
    point(row.open, 'pointerdown');
    if (gesture === 'pointermove') point(row.open, gesture, { y: 72 });
    else f.node('acScroll').dispatchEvent(new Event('scroll'));
    f.flushDraft();
    point(row.open, 'pointerup');
    row.open.click();
    assert.equal(row.actions.hidden, true, gesture);
    assert.equal(f.root.dataset.home, 'true', gesture);
    assert.equal(f.saved().threads.length, 1, gesture);
  }
});

test('more actions and right-click expose the same Delete choice, and Keep preserves the chat', async () => {
  const f = setup({ threads: [thread('keep', { title: 'Keep this chat' })] });
  await f.window.avaCompanionChatHome();
  const row = homeRow(f, 'keep');
  row.more.click();
  assert.equal(row.actions.hidden, false);
  row.remove.click();
  f.node('acDeleteCancel').click();
  assert.equal(f.node('acConfirm').hidden, true);
  assert.equal(f.saved().threads.length, 1);
  assert.ok(row.remove.focuses > 1);
  row.more.click();
  assert.equal(row.actions.hidden, true);
  assert.equal(point(row.open, 'contextmenu', { pointerType: 'mouse' }).defaultPrevented, true);
  assert.equal(row.actions.hidden, false);
  assert.equal(f.root.dataset.home, 'true');
});

test('a stale mobile delete prompt cannot remove a conversation from the next account', async () => {
  const storage = new Map([[storageKey(bob), JSON.stringify({ version: 1, owner: bob.id, threads: [thread('same-id')] })]]);
  const f = setup({ storage, threads: [thread('same-id')] });
  await f.window.avaCompanionChatHome();
  const old = homeRow(f, 'same-id');
  old.more.click();
  old.remove.click();
  f.changeOwner(bob);
  await f.window.avaCompanionChatHome();
  old.remove.click();
  f.node('acDeleteYes').click();
  assert.equal(f.node('acConfirm').hidden, true);
  assert.equal(f.saved(alice).threads.length, 1);
  assert.equal(f.saved(bob).threads.length, 1);
});

test('failed device storage does not hide a conversation that was never deleted', async () => {
  const f = setup({ threads: [thread('unsaved')] });
  await f.window.avaCompanionChatHome();
  const row = homeRow(f, 'unsaved');
  row.more.click();
  row.remove.click();
  f.disableStorageWrites();
  f.node('acDeleteYes').click();
  assert.equal(f.saved().threads.length, 1);
  assert.equal(f.rows().length, 1);
  assert.match(f.node('acNotice').textContent, /storage is unavailable/i);
});

test('confirming deletion of an active reply stops it and prevents the late reply from restoring the chat', async () => {
  const f = setup();
  await f.window.avaCompanionChatHome();
  f.draft('Remove after this');
  f.submit();
  await settle();
  const pending = f.requests[0], threadId = f.saved().active;
  await f.window.avaCompanionChatHome();
  const row = homeRow(f, threadId);
  row.more.click();
  row.remove.click();
  assert.equal(pending.options.signal.aborted, false);
  f.node('acDeleteYes').click();
  assert.equal(pending.options.signal.aborted, true);
  pending.resolve({ status: 'complete', text: 'Late text', sources: [] });
  await settle();
  assert.equal(f.saved().threads.length, 0);
  assert.equal(f.rows().length, 0);
});

test('Home and conversation drafts are saved separately without changing the active conversation', async () => {
  const f = setup({ threads: [thread('one', { draft: 'Conversation draft' })] });
  await f.window.avaCompanionChatHome(); f.draft('Home draft'); f.flushDraft();
  f.rows()[0].click(); assert.equal(f.input.value, 'Conversation draft');
  f.draft('Edited conversation draft'); await f.window.avaCompanionChatHome(); f.flushDraft();
  assert.equal(f.input.value, 'Home draft'); assert.equal(f.saved().active, 'one');
  assert.equal(f.saved().threads[0].draft, 'Edited conversation draft'); assert.equal(f.saved().homeDraft, 'Home draft');
});

test('the history control goes to Home in the app and keeps the desktop drawer behavior', async () => {
  const f = setup({ threads: [thread('one')] }); await f.window.avaCompanionChatHome(); f.rows()[0].click();
  f.node('acHistory').click(); await settle(); assert.equal(f.root.dataset.home, 'true');
  assert.equal(f.root.dataset.history, 'false'); assert.equal(f.node('acSearch').focuses, 0);
  const desktop = setup({ app: false, threads: [thread('one')] });
  await desktop.window.avaCompanionChatOpen({ home: true }); desktop.node('acHistory').click();
  assert.equal(desktop.root.dataset.home, 'false'); assert.equal(desktop.root.dataset.history, 'true');
  assert.equal(desktop.node('acSearch').focuses, 1);
});

test('a Home message starts a new real thread and preserves the existing conversation draft', async () => {
  const f = setup({ threads: [thread('old', { draft: 'Existing draft' })] });
  await f.window.avaCompanionChatHome(); f.draft('A new question'); f.submit(); await settle();
  assert.equal(f.requests.length, 1); assert.equal(f.root.dataset.home, 'false');
  assert.equal(f.requests[0].options.messages.length, 1);
  assert.equal(f.requests[0].options.messages[0].content, 'A new question');
  assert.equal(f.saved().threads.find(row => row.id === 'old').draft, 'Existing draft');
  assert.equal(f.saved().threads.length, 2); assert.equal(f.saved().homeDraft, '');
  f.requests[0].resolve({ status: 'complete', text: 'A real backend result fixture', sources: [] }); await settle();
});

test('returning Home keeps an in-flight reply running and does not render it over Home', async () => {
  const f = setup(); await f.window.avaCompanionChatHome(); f.draft('Keep working'); f.submit(); await settle();
  const pending = f.requests[0]; await f.window.avaCompanionChatHome();
  pending.options.onChunk('Partial reply'); assert.equal(pending.options.signal.aborted, false);
  assert.equal(f.node('acMessages').children.length, 0); assert.equal(f.root.dataset.home, 'true');
  pending.resolve({ status: 'complete', text: 'Finished reply', sources: [] }); await settle();
  assert.equal(f.rows().length, 1); assert.match(f.rows()[0].textContent, /Finished reply/);
});

test('account changes clear old Home rows and drafts, and stale row handlers cannot reopen them', async () => {
  const f = setup({ threads: [thread('private')], homeDraft: 'Alice draft' });
  await f.window.avaCompanionChatHome(); const oldRow = f.rows()[0];
  f.changeOwner(bob); await f.window.avaCompanionChatHome(); oldRow.click();
  assert.equal(f.rows().length, 0); assert.equal(f.input.value, ''); assert.equal(f.root.dataset.home, 'true');
  f.window.avaCompanionChatClose(false); assert.equal(f.saved(bob).threads.length, 0);
  assert.equal(f.saved(alice).homeDraft, 'Alice draft');
});

test('Home drafts survive reopening for their owner without creating a conversation', async () => {
  const first = setup(); await first.window.avaCompanionChatHome(); first.draft('Come back to this'); first.flushDraft();
  const next = setup({ storage: first.storage }); await next.window.avaCompanionChatHome();
  assert.equal(next.input.value, 'Come back to this'); assert.equal(next.saved().threads.length, 0);
});

test('Home task submission uses the existing task service and keeps previous conversations intact', async () => {
  const f = setup({ threads: [thread('old')] }); await f.window.avaCompanionChatHome();
  f.node('acTaskMode').click(); f.draft('Research a useful topic'); f.submit(); await settle();
  assert.equal(f.tasks.length, 1); assert.equal(f.root.dataset.home, 'false');
  const saved = f.saved(); assert.equal(saved.threads.length, 2);
  assert.equal(saved.threads.find(row => row.id !== 'old').messages[1].taskId, 'task-1');
});

test('Home keeps the existing sign-in gate and never reads another owner cache for a guest', async () => {
  const storage = new Map([[storageKey(alice), JSON.stringify({ version: 1, owner: alice.id, threads: [thread('private')] })]]);
  const f = setup({ owner: null, storage }); await f.window.avaCompanionChatHome();
  assert.equal(f.rows().length, 0); f.draft('Guest question'); f.submit(); await settle();
  assert.deepEqual(f.gates, ['signin']); assert.equal(f.requests.length, 0);
});
