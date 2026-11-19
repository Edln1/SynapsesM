import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const start = html.indexOf('function _tnvPositionToastToMic(toastEl, btn){');
const end = html.indexOf('function _tnvGlideToCenter(){', start);
assert.ok(start >= 0 && end > start, 'The real mic/caption positioning source is required');
const source = html.slice(start, end);

function fixture({ width = 1320, center = 1094, visible = true, viewport = true } = {}) {
  const frames = new Map();
  let sequence = 0;
  const classes = new Set(visible ? ['show'] : []);
  const style = { opacity: visible ? '1' : '0', setProperty(key, value) { this[key] = value; } };
  const window = new EventTarget();
  window.innerWidth = width;
  if (viewport) window.visualViewport = new EventTarget();
  const mic = { center, bottom: 44, width: 28, getBoundingClientRect() {
    return { left: this.center - this.width / 2, width: this.width, height: this.width, bottom: this.bottom };
  } };
  const toast = { style, isConnected: true, classList: { contains: value => classes.has(value) }, getBoundingClientRect() {
    // Browser layout for the existing CSS max-width and translateX(-50%).
    const width = Math.min(280, window.innerWidth - 28);
    const left = Number.parseFloat(style.left) - width / 2;
    return { left, right: left + width, width };
  } };
  const document = { getElementById: id => id === 'tnvToast' ? toast : id === 'topNavVoiceBtn' ? mic : null };
  const context = vm.createContext({ window, document, Date, isFinite,
    requestAnimationFrame(callback) { const id = ++sequence; frames.set(id, callback); return id; }
  });
  vm.runInContext(source, context);
  function frame() { const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(1)); }
  function settle() { for (let i = 0; frames.size && i < 6; i++) frame(); assert.equal(frames.size, 0); }
  return { window, mic, toast, style, classes, frames, context, frame, settle,
    resize() { window.dispatchEvent(new Event('resize')); },
    position() { context._tnvPositionToastToMic(toast, mic); settle(); }
  };
}

test('a caption follows its actual mic after the installed window widens, coalescing resize bursts', () => {
  const f = fixture();
  f.position();
  assert.equal(f.style.left, '1094px');
  f.window.innerWidth = 1543; f.mic.center = 1317; f.mic.bottom = 50;
  for (let i = 0; i < 10; i++) f.resize();
  assert.equal(f.frames.size, 1, 'A resize burst schedules one reposition');
  f.settle();
  assert.equal(f.style.left, '1317px');
  assert.equal(f.style.top, '60px');
  assert.equal(f.style['--tnv-arrow-left'], '50%');
  assert.equal(f.classes.has('show'), true);
});

test('visual viewport resize reuses existing edge clamping and caret geometry', () => {
  const f = fixture(); f.position();
  f.window.innerWidth = 760; f.mic.center = 720;
  f.window.visualViewport.dispatchEvent(new Event('resize')); f.settle();
  assert.equal(f.toast.getBoundingClientRect().right, 750);
  assert.equal(f.style.left, '610px');
  assert.ok(Math.abs(Number.parseFloat(f.style['--tnv-arrow-left']) - 89.285714) < 0.001);
});

test('hidden, dismissed or detached captions do not acquire a new anchor or reappear on resize', () => {
  const f = fixture({ visible: false });
  f.resize(); assert.equal(f.frames.size, 0); assert.equal(f.style.left, undefined);
  f.classes.add('show'); f.resize(); f.classes.delete('show'); f.settle();
  assert.equal(f.style.left, undefined);
  f.classes.add('show'); f.resize(); f.toast.isConnected = false; f.settle();
  assert.equal(f.style.left, undefined);
  assert.equal(f.style.opacity, '0');
});

test('mobile-width positioning and absent visualViewport retain the existing layout without voice side effects', () => {
  const f = fixture({ width: 390, center: 350, viewport: false });
  f.position();
  const existing = { left: f.style.left, top: f.style.top, arrow: f.style['--tnv-arrow-left'], transform: f.style.transform };
  f.resize(); f.settle();
  assert.deepEqual({ left: f.style.left, top: f.style.top, arrow: f.style['--tnv-arrow-left'], transform: f.style.transform }, existing);
  assert.equal(f.style.opacity, '1');
  assert.equal(f.classes.has('show'), true);
  assert.equal(f.window._topNavVoiceActive, undefined);
  assert.equal(f.window.synapsesDesktopVoiceClient, undefined);
});
