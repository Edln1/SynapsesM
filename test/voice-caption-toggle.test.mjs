import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function extract(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from);
  assert.ok(from >= 0 && to > from, 'The real voice caption code is required');
  return html.slice(from, to);
}
const captions = extract("  var _toastFull = '';", '  function btnState(s) {');
const menu = extract("  ctxMenu.querySelector('#avaCxToastToggle').onclick", "  ctxMenu.querySelector('#avaCxModeSelf').onclick");
const preference = 'synapses_sts_toast_enabled';

class Element extends EventTarget {
  style = {};
  children = [];
  classes = new Set();
  classList = {
    contains: name => this.classes.has(name),
    add: name => this.classes.add(name),
    remove: name => this.classes.delete(name)
  };
  set innerHTML(value) {
    if (!value) this.children = [];
  }
  appendChild(child) { this.children.push(child); }
  getBoundingClientRect() { return { left: 80, bottom: 32, width: 28 }; }
}

function fixture(storage = new Map()) {
  const mic = new Element();
  const body = new Element();
  const toggle = new Element();
  const check = new Element();
  const notices = [];
  const timers = new Map();
  let sequence = 0;
  let now = 1000;
  const context = vm.createContext({
    _toast: null,
    _on: true,
    _ttsBusy: true,
    window: { matchMedia: () => ({ matches: true }) },
    document: { body, createElement: () => new Element(),
      getElementById: id => id === 'topNavVoiceBtn' ? mic : null },
    localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
    ctxMenu: { querySelector: id => id === '#avaCxToastToggle' ? toggle : check },
    showToast: message => notices.push(message),
    Date: { now: () => now },
    setTimeout(callback, delay) {
      const next = ++sequence;
      timers.set(next, { due: now + delay, callback });
      return next;
    },
    clearTimeout: timer => timers.delete(timer),
    // Repeated hover wiring and paint-only effects cannot alter the tested
    // menu state and do not need a real browser or clock.
    setInterval() {}, clearInterval() {}, requestAnimationFrame() {}
  });
  vm.runInContext(captions + '\n' + menu, context);
  function advance(ms) {
    const end = now + ms;
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
      if (!next || next[1].due > end) break;
      const [id, timer] = next;
      now = timer.due;
      timers.delete(id);
      timer.callback();
    }
    now = end;
  }
  const event = { stopPropagation() {} };
  return {
    context, storage, notices, check, advance,
    reply: text => context.toast(text),
    hover: () => mic.dispatchEvent(new Event('mouseenter')),
    toggle: () => toggle.onclick(event),
    visible: () => context._toast?.classList.contains('show') ?? false,
    displayedText: () => context._toast?.children[0]?.children[0]?.textContent,
    dismiss: () => context._toast.children[1].onclick(event)
  };
}

test('the right-click menu closes the current caption immediately and keeps new replies and a queued hover hidden', () => {
  const f = fixture();
  f.reply('Ava is still speaking.');
  f.context._holdBargeToast(2500);
  f.hover();
  assert.equal(f.visible(), true);

  f.toggle();
  assert.equal(f.visible(), false);
  assert.equal(f.context._on, true);
  assert.equal(f.context._ttsBusy, true);
  assert.equal(f.context.window._tnvToastEnabled(), false);
  assert.equal(f.storage.get(preference), '0');
  assert.equal(f.check.style.opacity, '0');
  assert.deepEqual(f.notices, ['Reply captions off']);

  f.reply('Another response.');
  assert.equal(f.visible(), false);
  f.advance(1000);
  assert.equal(f.visible(), false);
});

test('captions stay off after reload and re-enable restores the latest response', () => {
  const f = fixture(new Map([[preference, '0']]));
  f.reply('Newest spoken reply.');
  assert.equal(f.context.window._tnvToastEnabled(), false);
  f.hover();
  f.advance(1000);
  assert.equal(f.visible(), false);
  assert.equal(f.context._toast, null);

  f.toggle();
  assert.equal(f.visible(), true);
  assert.equal(f.displayedText(), 'Newest spoken reply.');
  assert.equal(f.storage.get(preference), '1');
  assert.equal(f.check.style.opacity, '1');
  assert.deepEqual(f.notices, ['Reply captions on']);
});

test('dismissing one caption when enabled still permits a hover reveal', () => {
  const f = fixture(new Map([[preference, '1']]));
  f.reply('A caption for this turn.');
  f.dismiss();
  assert.equal(f.visible(), false);
  assert.equal(f.context.window._tnvToastEnabled(), true);
  f.hover();
  f.advance(1000);
  assert.equal(f.visible(), true);
  assert.equal(f.displayedText(), 'A caption for this turn.');
  assert.equal(f.storage.get(preference), '1');
});
