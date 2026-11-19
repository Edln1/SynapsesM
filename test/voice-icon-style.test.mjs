import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const preference = 'synapses_sts_icon_style';
const iconAttribute = 'data-voice-icon-style';
const choiceAttribute = 'data-voice-icon-choice';

function productionSource() {
  const from = html.indexOf('  var iconStyleButtons =');
  const to = html.indexOf('  function _cxHov', from);
  assert.ok(from !== -1 && to > from, 'The real icon menu setup is required');
  return html.slice(from, to);
}

class Element extends EventTarget {
  attributes = new Map();
  classList = new Set();
  dataset = {};

  constructor(choice) {
    super();
    if (choice) {
      this.setAttribute(choiceAttribute, choice);
      this.dataset.voiceIconChoice = choice;
    }
  }

  getAttribute(name) { return this.attributes.get(name) ?? null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }

  click() {
    const event = new Event('click', { cancelable: true });
    this.dispatchEvent(event);
    this.onclick?.({ target: this, currentTarget: this, preventDefault() {}, stopPropagation() {} });
  }
}

function fixture({ storage = new Map(), denyStorage = false } = {}) {
  const btn = new Element();
  const classic = new Element('classic');
  const ring = new Element('ring');
  let voiceChanges = 0;
  const nodes = { '#avaCxIconClassic': classic, '#avaCxIconRing': ring };
  const context = vm.createContext({
    btn,
    ctxMenu: {
      querySelector: selector => nodes[selector] ?? null,
      querySelectorAll: selector => {
        assert.equal(selector, `[${choiceAttribute}]`);
        return [classic, ring];
      }
    },
    document: { getElementById: id => id === 'topNavVoiceBtn' ? btn : null },
    localStorage: {
      getItem(key) {
        if (denyStorage) throw new Error('Storage blocked');
        return storage.get(key) ?? null;
      },
      setItem(key, value) {
        if (denyStorage) throw new Error('Storage blocked');
        storage.set(key, value);
      }
    },
    window: { _topNavVoiceActive: true, toggleTopNavVoice() { voiceChanges++; } }
  });
  vm.runInContext(productionSource(), context);
  return { btn, classic, ring, storage, voiceChanges: () => voiceChanges };
}

function verifySelection({ btn, classic, ring }, value) {
  assert.equal(btn.getAttribute(iconAttribute), value);
  assert.equal(classic.getAttribute('aria-pressed'), String(value === 'classic'));
  assert.equal(ring.getAttribute('aria-pressed'), String(value === 'ring'));
}

test('the two icon choices update the same live speech button and preserve its voice state', () => {
  const f = fixture();
  verifySelection(f, 'classic');
  f.btn.classList.add('tnv-speak');

  f.ring.click();
  verifySelection(f, 'ring');
  assert.equal(f.storage.get(preference), 'ring');
  assert.equal(f.btn.classList.has('tnv-speak'), true);
  assert.equal(f.voiceChanges(), 0);

  f.classic.click();
  verifySelection(f, 'classic');
  assert.equal(f.storage.get(preference), 'classic');
  assert.equal(f.btn.classList.has('tnv-speak'), true);
  assert.equal(f.voiceChanges(), 0);
});

test('the saved choice restores and unknown or inaccessible storage falls back to Classic', () => {
  verifySelection(fixture({ storage: new Map([[preference, 'ring']]) }), 'ring');
  verifySelection(fixture({ storage: new Map([[preference, 'unexpected']]) }), 'classic');
  const unavailable = fixture({ denyStorage: true });
  verifySelection(unavailable, 'classic');
  unavailable.ring.click();
  verifySelection(unavailable, 'ring');
});

test('Ring only clears the button interior during both active speech states', () => {
  const activeRing = '#topNavVoiceBtn\\[data-voice-icon-style=["\']ring["\']\\]:is\\(\\.tnv-on\\s*,\\s*\\.tnv-speak\\)';
  assert.match(html, new RegExp(activeRing + '\\s*\\{[^}]*background\\s*:\\s*transparent\\s*!important'));
  assert.match(html, new RegExp(activeRing + '\\s*>\\s*:is\\(#tnvMicIcon\\s*,\\s*#tnvWaveIcon\\)\\s*\\{[^}]*visibility\\s*:\\s*hidden\\s*!important'));
});
