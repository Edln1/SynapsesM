import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const globalAnchor = html.indexOf("var canvas=document.getElementById('globalBeamsCanvas');");
const globalStart = html.lastIndexOf('(function(){', globalAnchor);
const globalSource = html.slice(globalStart, html.indexOf('})();', globalAnchor) + 5);
const helpers = html.slice(html.indexOf('function _sunAuroraMobile()'), globalStart);
const chatAnchor = html.indexOf("var canvas=document.getElementById('chatBeamsCanvas');", globalAnchor);
const chatStart = html.lastIndexOf('(function(){', chatAnchor);
// Exercise the production chat drawing/size functions without unrelated UI handlers.
const chatSource = html.slice(chatStart, html.indexOf('  var _lastForcedRestartAt', chatAnchor)) + '\nresize();animate();})();';

function seeded() { let value = 123456789; return () => { value = (Math.imul(1664525, value) + 1013904223) >>> 0; return value / 4294967296; }; }
function setup({ width = 1320, height = 828, dpr = 1, coarse = false, theme = 'purple', app = false, chat = false } = {}) {
  const state = { width, height, coarse, theme, app, randomCalls: 0 }, frames = [], events = new Map(), clears = [], paints = [];
  const random = seeded(), math = Object.create(Math); math.random = () => { state.randomCalls++; return random(); };
  let gradient = null, at = [0, 0], angle = 0;
  const ctx = { setTransform(...args) { this.transform = args; }, clearRect(...args) { clears.push(args); },
    createLinearGradient(...args) { gradient = { args, stops: [] }; return { addColorStop(offset, color) { gradient.stops.push([offset, color]); }, gradient }; },
    save() {}, restore() {}, translate(x, y) { at = [x, y]; }, rotate(value) { angle = value; },
    fillRect(...rect) { paints.push({ at: at.slice(), angle, rect, gradient: this.fillStyle.gradient }); },
  };
  const canvas = { style: {}, getContext: () => ctx };
  const section = { offsetWidth: width, offsetHeight: height, classList: { contains: () => true } };
  const root = { getAttribute: name => name === 'data-theme' ? state.theme : null, classList: { contains: name => name === 'ava-app-mode' && state.app } };
  const document = { hidden: false, documentElement: root, addEventListener() {},
    getElementById(id) { return id === (chat ? 'chatBeamsCanvas' : 'globalBeamsCanvas') ? canvas : id === 'sec-chat' ? section : id === 'chatBeamsWrap' ? {} : null; } };
  const window = { get innerWidth() { return state.width; }, get innerHeight() { return state.height; }, devicePixelRatio: dpr,
    matchMedia(query) { return { matches: query.includes('pointer:coarse') ? state.coarse : query.includes('max-width:900px') ? state.width <= 900 : false }; },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); } };
  const context = vm.createContext({ window, document, Math: math, MutationObserver: class { observe() {} },
    requestAnimationFrame(fn) { frames.push(fn); return frames.length; }, setTimeout() {},
  });
  vm.runInContext(helpers + (chat ? chatSource : globalSource), context);
  return { state, window, canvas, section, ctx, clears, paints, frames, context,
    frame(time = 100) { const fn = frames.shift(); if (fn) fn(time); },
    resize(width, height) { state.width = width; state.height = height; section.offsetWidth = width; section.offsetHeight = height; for (const fn of events.get('resize') || []) fn(); },
  };
}

// Independent reference from the verified packaged Neutralino6 createBeam/drawBeam.
// Opacity, hue sampling, geometry and first-frame movement are retained verbatim.
function originalFirstFrame(width, height) {
  const random = seeded(), beams = [];
  for (let i = 0; i < 32; i++) {
    const angle = -35 + random() * 10;
    beams.push({ x: random() * width * 1.5 - width * .25, y: random() * height * 1.5 - height * .25,
      width: 35 + random() * 65, length: height * 2.5, angle, speed: .5 + random(), opacity: .10 + random() * .13,
      hue: 190 + random() * 70, pulse: random() * Math.PI * 2, pulseSpeed: .018 + random() * .025 });
  }
  return beams.map(beam => {
    beam.y -= beam.speed; beam.pulse += beam.pulseSpeed;
    const op = beam.opacity * (.8 + Math.sin(beam.pulse) * .2);
    return { at: [beam.x, beam.y], angle: beam.angle * Math.PI / 180, rect: [-beam.width / 2, 0, beam.width, beam.length],
      gradient: { args: [0, 0, 0, beam.length], stops: [[0, 0], [.1, op * .5], [.4, op], [.6, op], [.9, op * .5], [1, 0]].map(([offset, a]) => [offset, `hsla(${beam.hue},85%,65%,${a})`]) } };
  });
}

test('both normal aurora modes match original desktop beam geometry, continuous palette and alpha at full and compact widths', () => {
  for (const theme of ['purple', 'easyview']) for (const [width, height] of [[1400, 860], [1320, 828], [800, 600]]) {
    const f = setup({ width, height, theme });
    assert.equal(f.paints.length, 32);
    assert.deepEqual(JSON.parse(JSON.stringify(f.paints)), originalFirstFrame(width, height));
  }
});

test('restored aurora uses the original navy HTML base while Night and Ava retain their existing black rules', () => {
  const navy = html.match(/html:not\(\.ava-app-mode\)\[data-theme="purple"\][\s\S]*?\{background:#0c0c17!important;background-color:#0c0c17!important;\}/)?.[0];
  assert.ok(navy); assert.match(navy, /data-theme="easyview"/); assert.doesNotMatch(navy, /data-theme="trueblack"/);
  assert.match(html, /html,body\{background:#000000!important/);
  assert.match(html, /html\[data-theme="trueblack"\] #globalBeamsCanvas\{opacity:0!important;\}/);
  assert.doesNotMatch(html, /html\[data-theme="purple"\] #globalBeamsCanvas,html\[data-theme="trueblack"\]/);
});

test('True Black and Ava keep the global renderer dormant rather than repainting a CSS-hidden canvas', () => {
  for (const options of [{ theme: 'trueblack' }, { theme: 'pitchblack' }, { theme: 'purple', app: true }, { theme: 'easyview', app: true }]) {
    const f = setup(options); assert.equal(f.window._synPwr.beamsOn(), false); assert.equal(f.paints.length, 0); assert.equal(f.frames.length, 0);
  }
  assert.equal(setup({ theme: 'purple' }).window._synPwr.beamsOn(), true);
});

test('phone palette, half-resolution rendering and frame cap remain in place', () => {
  const f = setup({ width: 390, height: 844, dpr: 3, coarse: true, theme: 'easyview' });
  assert.equal(f.canvas.width, 195); assert.equal(f.canvas.height, 422); assert.equal(f.window._synPwr.gap(), 50);
  for (const paint of f.paints) { const hue = Number(paint.gradient.stops[2][1].match(/^hsla\(([^,]+)/)[1]); assert.ok(hue >= 228 && hue <= 238.5); }
});

test('shrinking and enlarging resize the real bitmap and clear the complete surface without reseeding or alpha accumulation', () => {
  const f = setup({ width: 1320, height: 828, dpr: 2 }), randomCalls = f.state.randomCalls;
  for (const [width, height] of [[800, 600], [1600, 900]]) {
    f.resize(width, height); f.frame(height);
    assert.equal(f.canvas.width, width * 2); assert.equal(f.canvas.height, height * 2);
    assert.equal(f.canvas.style.width, width + 'px'); assert.equal(f.canvas.style.height, height + 'px');
    assert.deepEqual(Array.from(f.clears.at(-1)), [0, 0, width, height]); assert.deepEqual(Array.from(f.ctx.transform), [2, 0, 0, 2, 0, 0]);
    assert.equal(f.state.randomCalls, randomCalls, 'Resize preserves the existing beam scene');
  }
});

test('chat layout changes update backing dimensions on its next existing frame, without a window resize event', () => {
  const f = setup({ chat: true }), randomCalls = f.state.randomCalls;
  f.section.offsetWidth = 980; f.section.offsetHeight = 700; f.frame();
  assert.equal(f.canvas.width, 980); assert.equal(f.canvas.height, 700); assert.equal(f.state.randomCalls, randomCalls);
  assert.deepEqual(Array.from(f.clears.at(-1)), [0, 0, 980, 700]);
});

test('switching from the cached phone-width Night palette to desktop Sun restores the original broad colors', () => {
  const f = setup({ width: 800, height: 600, theme: 'trueblack' });
  f.state.theme = 'easyview'; f.context.window._synPwr.view('*theme*'); f.frame();
  const hues = f.paints.map(p => Number(p.gradient.stops[2][1].match(/^hsla\(([^,]+)/)[1]));
  assert.ok(hues.some(h => h < 210)); assert.ok(hues.some(h => h > 250));
});
