import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const archive = readFileSync(new URL('../ava-voice-history-classic.html', import.meta.url), 'utf8');
const classic = archive.match(/\/\/ [^\r\n]*pagination[^\r\n]*\r?\n([\s\S]*?)<\/script>/i)?.[1];
assert.ok(classic, 'The Classic runtime should include its pagination script.');

class Element extends EventTarget {
  constructor(tag) {
    super();
    this.tag = tag;
    this.children = [];
    this.style = {};
    this.disabled = false;
    this.text = '';
  }

  set textContent(text) { this.replaceChildren(); this.text = String(text); }
  get textContent() { return this.text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(markup) {
    assert.equal(markup, '', 'The archive should render saved text through the DOM.');
    this.replaceChildren();
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); return child; }
  replaceChildren(...children) {
    this.children = children.flatMap(child => child.tag === '#fragment' ? child.children : [child]);
    this.text = '';
  }
  setAttribute(name, value) { this[name] = String(value); }
  click() {
    const event = new Event('click');
    this.onclick?.(event);
    this.dispatchEvent(event);
  }
}

function renderClassic(data) {
  const nodes = new Map();
  function getElementById(id) {
    if (!nodes.has(id)) nodes.set(id, new Element('div'));
    return nodes.get(id);
  }
  getElementById('avaClassicHistoryData').textContent = JSON.stringify(data);
  const window = new EventTarget();
  const parent = { postMessage() {} };
  vm.runInNewContext(classic, {
    window, parent, document: {
      getElementById, createElement: tag => new Element(tag),
      createDocumentFragment: () => new Element('#fragment'),
    },
    setTimeout() { throw new Error('A Classic transcript should render its turns immediately.'); },
  }, { filename: 'ava-voice-history-classic.html' });
  const scroll = getElementById('chat-scroll');
  const navigation = getElementById('page-nav');
  return {
    messages: () => scroll.children.flatMap(row =>
      row.children.filter(child => child.className?.split(' ').includes('msg-body')).map(child => child.textContent)),
    notice: () => scroll.textContent,
    control: text => navigation.children.find(child => child.tag === 'button' && text.test(child.textContent)),
    clear: getElementById('clear-btn'),
  };
}

function session(title, latest, turns = 1) {
  return {
    title,
    latest: Date.parse(latest),
    turns: Array.from({ length: turns }, (_, index) => ({
      date: latest,
      user: `${title} question ${index + 1}`,
      ava: `${title} reply ${index + 1}`,
    })),
  };
}

function messages(session) {
  return session.turns.flatMap(turn => [turn.user, turn.ava]);
}

test('Classic shows all turns of the selected conversation without mixing adjacent conversations', () => {
  const newest = session('Newest', '2026-11-23T12:00:00Z');
  const selected = session('Selected', '2026-11-22T12:00:00Z', 12);
  const older = session('Older', '2026-11-20T12:00:00Z');
  selected.turns[0].ava = '<img src=x onerror=unexpected()>';
  const archive = renderClassic({ sessions: [newest, selected, older], page: 1 });

  assert.equal(archive.messages().length, 24);
  assert.deepEqual(archive.messages(), messages(selected));
});

test('Classic starts with the newest conversation and pages through the shared order', () => {
  const newest = session('Newest', '2026-11-23T12:00:00Z');
  const next = session('Next older', '2026-11-22T12:00:00Z');
  const oldest = session('Oldest', '2026-11-20T12:00:00Z');
  const archive = renderClassic({ sessions: [newest, next, oldest] });

  assert.deepEqual(archive.messages(), messages(newest));
  assert.equal(archive.control(/newer/i), undefined);
  archive.control(/older/i).click();
  assert.deepEqual(archive.messages(), messages(next));
  archive.control(/older/i).click();
  assert.deepEqual(archive.messages(), messages(oldest));
  assert.equal(archive.control(/older/i), undefined);
  archive.control(/newer/i).click();
  assert.deepEqual(archive.messages(), messages(next));
});

test('an empty Classic archive displays an empty state with no navigation or clear action', () => {
  const archive = renderClassic({ sessions: [], page: 0 });

  assert.deepEqual(archive.messages(), []);
  assert.match(archive.notice(), /no (?:voice conversations|transmissions)/i);
  assert.equal(archive.control(/older|newer/i), undefined);
  assert.equal(archive.clear.disabled, true);
});
