import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRequire } from 'node:module';

const { create } = createRequire(import.meta.url)('../ava-voice-history.js');
const transcriptKey = 'synapses_companion_transcript';
const unusual = '<img src=x onerror="unexpected()">';

class Element extends EventTarget {
  constructor(tag, ownerDocument) {
    super();
    this.tagName = tag.toUpperCase();
    this.ownerDocument = ownerDocument;
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.className = '';
    this.style = {};
    this.open = false;
    this.hidden = false;
    this.modalOpens = 0;
    this.text = '';
  }

  set textContent(value) { this.replaceChildren(); this.text = String(value); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(value) { assert.equal(value, '', 'History must append real elements instead of injecting markup'); this.textContent = ''; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); if (name === 'id') this.id = String(value); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  removeAttribute(name) { this.attributes.delete(name); }

  append(...children) {
    for (const child of children) {
      if (typeof child === 'string') { this.text += child; continue; }
      if (child.tagName === '#FRAGMENT') { this.append(...child.children); continue; }
      child.remove();
      this.children.push(child);
      child.parentNode = this;
    }
  }

  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) {
    for (const child of this.children) child.parentNode = null;
    this.children = [];
    this.text = '';
    this.append(...children);
  }

  remove() {
    if (!this.parentNode) return;
    this.parentNode.children = this.parentNode.children.filter(child => child !== this);
    this.parentNode = null;
  }

  querySelectorAll(selector) {
    const matches = child => selector.startsWith('.') ? child.className.split(/\s+/).includes(selector.slice(1))
      : selector.startsWith('#') ? child.id === selector.slice(1) : child.tagName === selector.toUpperCase();
    return this.children.flatMap(child => [ ...(matches(child) ? [child] : []), ...child.querySelectorAll(selector) ]);
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  focus() { this.ownerDocument.activeElement = this; }
  showModal() { this.modalOpens++; this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  click() { const event = new Event('click', { cancelable: true }); this.onclick?.(event); this.dispatchEvent(event); }
}

function fixture(records) {
  const document = new EventTarget();
  const browser = new EventTarget(), frameMessages = [];
  browser.fetch = async () => ({ ok: true, text: async () => '<!doctype html><title>Classic</title><!-- AVA_VOICE_HISTORY_DATA -->' });
  document.defaultView = browser;
  document.createElement = tag => {
    const element = new Element(tag, document);
    if (tag === 'iframe') element.contentWindow = { postMessage: data => frameMessages.push(data) };
    return element;
  };
  document.createDocumentFragment = () => document.createElement('#fragment');
  document.createElementNS = (_, tag) => document.createElement(tag);
  document.body = document.createElement('body');
  document.documentElement = document.createElement('html');
  document.documentElement.append(document.body);
  document.querySelector = selector => document.documentElement.querySelector(selector);
  document.getElementById = id => document.querySelector('#' + id);
  const values = new Map([['unrelated-setting', 'keep me']]);
  if (records !== undefined) values.set(transcriptKey, typeof records === 'string' ? records : JSON.stringify(records));
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const view = create(document, () => storage);
  const dialog = () => document.getElementById('avaVoiceHistory');
  const all = selector => dialog()?.querySelectorAll(selector) || [];
  function message(source, type, origin = 'null') {
    browser.dispatchEvent(Object.assign(new Event('message'), { source, data: { type }, origin }));
  }
  return { view, dialog, all, storage, frameMessages, message };
}

function exchange(date, user, ava, session) { return { date, user, ava, session }; }

test('saved voice history opens as a modal with the latest sessions first', () => {
  const f = fixture([
    exchange('2026-11-17T13:00:00Z', 'Previous question', 'An old reply', 'previous'),
    exchange('2026-11-20T14:00:00Z', 'Legacy exchange', 'Saved before session IDs'),
    exchange('2026-11-22T14:30:00Z', 'Today’s first question', 'The first reply', 'latest'),
    exchange('2026-11-22T14:32:00Z', 'Follow-up', 'The second reply', 'latest'),
  ]);
  f.view.toggle();
  assert.equal(f.dialog().tagName, 'DIALOG');
  assert.equal(f.dialog().modalOpens, 1);
  const sessions = f.all('.avh-session');
  assert.equal(sessions.length, 3);
  assert.ok(sessions.every(button => button.tagName === 'BUTTON'));
  assert.match(sessions[0].textContent, /Today’s first question/);
  assert.match(sessions[1].textContent, /Legacy exchange/);
  assert.match(sessions[2].textContent, /Previous question/);

  assert.equal(f.view.close(), true);
  assert.equal(f.dialog()?.open ?? false, false);
  assert.equal(f.view.close(), false);
});

test('opening a session shows spoken turns as text and Back returns to the recent sessions', () => {
  const f = fixture([
    exchange('2026-11-22T14:30:00Z', 'Is this your example?', unusual, 'latest'),
    exchange('2026-11-22T14:32:00Z', 'Follow-up', 'The second reply', 'latest'),
  ]);
  f.view.toggle();
  f.all('.avh-session')[0].click();
  assert.deepEqual(f.all('.avh-message-text').map(node => node.textContent), [
    'Is this your example?', unusual, 'Follow-up', 'The second reply',
  ]);
  assert.equal(f.all('img').length, 0);
  f.all('.avh-back')[0].click();
  assert.equal(f.all('.avh-session').length, 1);
  assert.equal(f.all('.avh-message-text').length, 0);
});

test('empty or unreadable local storage opens the history empty state', () => {
  for (const records of [undefined, 'invalid JSON', { invalid: true }]) {
    const f = fixture(records);
    f.view.toggle();
    assert.equal(f.dialog().open, true);
    assert.equal(f.all('.avh-empty').length, 1);
    assert.equal(f.all('.avh-session').length, 0);
  }
});

test('clearing voice history requires confirmation and only clears the existing transcript key', () => {
  const f = fixture([exchange('2026-11-22T14:30:00Z', 'Keep until confirmed', 'The reply', 'latest')]);
  f.view.toggle();
  f.all('.avh-clear')[0].click();
  assert.ok(f.storage.getItem(transcriptKey));
  f.all('button').find(button => button.textContent.trim() === 'Cancel').click();
  assert.ok(f.storage.getItem(transcriptKey));

  f.all('.avh-clear')[0].click();
  f.all('button').filter(button => button.textContent.trim() === 'Clear history').at(-1).click();
  assert.deepEqual(JSON.parse(f.storage.getItem(transcriptKey) || '[]'), []);
  assert.equal(f.storage.getItem('unrelated-setting'), 'keep me');
  assert.equal(f.all('.avh-empty').length, 1);
});

test('Classic and List view share the same history, and only the active Classic frame can request clearing', async () => {
  const saved = exchange('2026-11-22T14:30:00Z', 'A recent voice chat', '</script>' + unusual, 'latest');
  const f = fixture([saved]); f.view.toggle();
  f.all('.avh-classic-toggle')[0].click();
  await new Promise(resolve => setImmediate(resolve));
  const frame = f.all('iframe')[0];
  assert.equal(frame.getAttribute('sandbox'), 'allow-scripts');
  assert.equal(f.dialog().dataset.view, 'classic');
  const data = frame.srcdoc.match(/id="avaClassicHistoryData">(.*?)<\/script>/)[1];
  assert.equal(data.includes('<'), false);
  const classic = JSON.parse(data);
  assert.deepEqual(classic.sessions.map(session => session.turns), [[saved]]);
  assert.equal(classic.page, 0);
  assert.equal(f.frameMessages.length, 0);
  f.message({}, 'COSMIC_CLEAR_TRANSCRIPT');
  f.message(frame.contentWindow, 'COSMIC_CLEAR_TRANSCRIPT', 'https://example.test');
  assert.equal(f.all('.avh-danger').length, 0);
  f.message(frame.contentWindow, 'COSMIC_CLEAR_TRANSCRIPT');
  assert.ok(f.storage.getItem(transcriptKey));
  f.all('.avh-danger')[0].click();
  assert.equal(f.storage.getItem(transcriptKey), null);
  assert.deepEqual(f.frameMessages.at(-1), { type: 'SYNAPSES_HISTORY', history: [] });
  f.all('.avh-classic-toggle')[0].click();
  assert.equal(f.dialog().dataset.view, 'list');
  assert.equal(f.all('iframe').length, 0);
  assert.equal(f.all('.avh-empty').length, 1);
});

test('Classic gets the same conversation order as List view and opens the selected chat', async () => {
  const older = exchange('2026-11-20T09:00:00Z', 'An older chat', 'Earlier answer', 'old');
  const newer = exchange('2026-11-23T09:00:00Z', 'A newer chat', 'Recent answer', 'new');
  const followUp = exchange('2026-11-20T10:00:00Z', 'An older follow-up', 'One more answer', 'old');
  const f = fixture([older, newer, followUp]); f.view.toggle();
  const rowTitles = f.all('.avh-session-title').map(node => node.textContent);
  assert.deepEqual(rowTitles, ['A newer chat', 'An older chat']);
  f.all('.avh-session')[1].click();
  f.all('.avh-classic-toggle')[0].click();
  await new Promise(resolve => setImmediate(resolve));
  const data = f.all('iframe')[0].srcdoc.match(/id="avaClassicHistoryData">(.*?)<\/script>/)[1];
  const classic = JSON.parse(data);
  assert.deepEqual(classic.sessions.map(session => session.title), rowTitles);
  assert.deepEqual(classic.sessions[classic.page].turns, [older, followUp]);
  assert.equal(classic.page, 1);
});
