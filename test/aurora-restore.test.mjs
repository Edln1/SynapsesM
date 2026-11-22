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
function setup({ width = 1320, height = 828, dpr = 1, coarse = false, theme = 'purple', classic = false, app = false, chat = false } = {}) {
  const state = { width, height, coarse, theme, classic, app, randomCalls: 0 }, frames = [], events = new Map(), clears = [], paints = [];
  const random = seeded(), math = Object.create(Math); math.random = () => { state.randomCalls++; return random(); };
  let gradient = null, at = [0, 0], angle = 0;
  const ctx = { setTransform(...args) { this.transform = args; }, clearRect(...args) { clears.push(args); },
    createLinearGradient(...args) { gradient = { args, stops: [] }; return { addColorStop(offset, color) { gradient.stops.push([offset, color]); }, gradient }; },
    save() {}, restore() {}, translate(x, y) { at = [x, y]; }, rotate(value) { angle = value; },
    fillRect(...rect) { paints.push({ at: at.slice(), angle, rect, gradient: this.fillStyle.gradient }); },
  };
  const canvas = { style: {}, getContext: () => ctx };
  const section = { offsetWidth: width, offsetHeight: height, classList: { contains: () => true } };
  const root = { getAttribute: name => name === 'data-theme' ? state.theme : null,
    hasAttribute: name => name === 'data-sun-classic' && state.classic,
    classList: { contains: name => name === 'ava-app-mode' && state.app } };
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
function originalFirstFrame(width, height, initialHue = sample => 190 + sample * 70) {
  const random = seeded(), beams = [];
  for (let i = 0; i < 32; i++) {
    const angle = -35 + random() * 10;
    beams.push({ x: random() * width * 1.5 - width * .25, y: random() * height * 1.5 - height * .25,
      width: 35 + random() * 65, length: height * 2.5, angle, speed: .5 + random(), opacity: .10 + random() * .13,
      hue: initialHue(random()), pulse: random() * Math.PI * 2, pulseSpeed: .018 + random() * .025 });
  }
  return beams.map(beam => {
    beam.y -= beam.speed; beam.pulse += beam.pulseSpeed;
    const op = beam.opacity * (.8 + Math.sin(beam.pulse) * .2);
    return { at: [beam.x, beam.y], angle: beam.angle * Math.PI / 180, rect: [-beam.width / 2, 0, beam.width, beam.length],
      gradient: { args: [0, 0, 0, beam.length], stops: [[0, 0], [.1, op * .5], [.4, op], [.6, op], [.9, op * .5], [1, 0]].map(([offset, a]) => [offset, `hsla(${beam.hue},85%,65%,${a})`]) } };
  });
}

test('Day and Void preserve the Neutralino desktop beam geometry, palette and source alpha', () => {
  for (const theme of ['purple', 'easyview']) for (const [width, height] of [[1400, 860], [1320, 828], [800, 600]]) {
    const f = setup({ width, height, theme });
    assert.equal(f.paints.length, 32);
    assert.deepEqual(JSON.parse(JSON.stringify(f.paints)), originalFirstFrame(width, height));
  }
});

test('Classic Sun uses the pre-change color sampling at wide and narrow widths', () => {
  for (const [width, height] of [[1400, 860], [800, 600]]) {
    const f = setup({ width, height, theme: 'easyview', classic: true });
    const preChangeHue = sample => {
      const index = Math.floor(sample * 8);
      return width <= 900 ? 228 + index * 1.5 : 190 + index * 70 / 8;
    };
    assert.deepEqual(JSON.parse(JSON.stringify(f.paints)), originalFirstFrame(width, height, preChangeHue));
    f.resize(width - 50, height - 50);
    assert.equal(f.canvas.width, (width - 50) * (width <= 900 ? .5 : 1));
  }
});

test('Day uses a navy base, dimmer moving beams and a desktop horizon', () => {
  const navy = html.match(/html:not\(\.ava-app-mode\)\[data-theme="purple"\][\s\S]*?\{background:#0c0c17!important;background-color:#0c0c17!important;\}/)?.[0];
  assert.ok(navy); assert.match(navy, /data-theme="easyview"\]:not\(\[data-sun-classic\]\)/); assert.doesNotMatch(navy, /data-theme="trueblack"/);
  assert.match(html, /html,body\{background:#000000!important/);
  assert.match(html, /html\[data-theme="trueblack"\] #globalBeamsCanvas\{opacity:0!important;\}/);
  assert.doesNotMatch(html.match(/<canvas id="globalBeamsCanvas"[^>]*>/)[0], /opacity:/);
  const desktop = html.slice(html.indexOf('#sunAuroraHorizon{display:none;'), html.indexOf('/* True Black only: Studio view'));
  assert.match(desktop, /@media \(hover:hover\) and \(pointer:fine\)/);
  const dayOnly = 'html:not(.ava-app-mode)[data-theme="easyview"]:not([data-sun-classic])';
  assert.ok(desktop.includes(`${dayOnly} #globalBeamsCanvas{opacity:.54;}`));
  assert.ok(desktop.includes(`${dayOnly} #chatBeamsWrap{opacity:0;}`));
  assert.ok(desktop.includes(`${dayOnly} #sunAuroraHorizon{opacity:1;}`));
  assert.match(desktop, /--sun-horizon-rise:22px;/);
  assert.match(desktop, /--sun-horizon-y:calc\(100% - var\(--sun-horizon-rise\)\);/);
  assert.match(desktop, /inset:auto 0 0;height:124px;/);
  assert.match(html, /<div id="sunAuroraHorizon" aria-hidden="true"><\/div>/);
});

test('the newer navy themes blend their desktop toolbar into the same background', () => {
  const start = html.indexOf('/* Let the navy background extend through the toolbar');
  const end = html.indexOf('/* The old canvas left color', start);
  const chrome = html.slice(start, end);
  assert.match(chrome, /html:not\(\.ava-app-mode,\.android-status-blend\)\[data-theme="easyview"\]:not\(\[data-sun-classic\]\) \.top-bar/);
  assert.match(chrome, /html:not\(\.ava-app-mode,\.android-status-blend\)\[data-theme="purple"\] \.top-bar/);
  assert.match(chrome, /background:transparent;border-bottom-color:transparent;box-shadow:none;/);
  assert.match(chrome, /backdrop-filter:none;-webkit-backdrop-filter:none;/);
  assert.doesNotMatch(chrome, /(?:height|margin|padding|position):/);
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

test('Classic Sun starts correctly after reload and the Sun toggle remembers it', () => {
  const attributes = new Map();
  const values = new Map([['_appTheme', 'sun-classic'], ['_darkVariant', 'purple']]);
  const root = {
    style: { removeProperty() {} },
    toggleAttribute(name, force) { if (force) attributes.set(name, ''); else attributes.delete(name); },
    setAttribute: (name, value) => attributes.set(name, value),
  };
  const themeCode = html.slice(html.indexOf('    function _synapsesBaseTheme'), html.indexOf('      /* Apply bottom-nav BEFORE first paint')) + '\n})();';
  const switcherStart = html.indexOf('// ── Theme Switcher');
  const switcher = html.slice(switcherStart, html.indexOf('\nfunction renderThemeCard(){', switcherStart));
  const toggleStart = html.indexOf('function toggleDayNight(){');
  const toggle = html.slice(toggleStart, html.indexOf('function _applyMainStatusBarChrome', toggleStart));
  const context = vm.createContext({
    document: { documentElement: root, body: root, getElementById() { return null; }, addEventListener() {} },
    localStorage: { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) },
    window: {}, renderThemeCard() {}, setTimeout() {}, _syncDayNightToggle() {}, _syncAndroidStatusBarForTheme() {},
  });
  vm.runInContext(themeCode, context);
  assert.equal(attributes.get('data-theme'), 'easyview');
  assert.ok(attributes.has('data-sun-classic'));
  vm.runInContext(switcher + toggle, context);
  assert.ok(context.window._getThemes().some(theme => theme.id === 'sun-classic' && theme.label === 'Classic Sun'));
  context.toggleDayNight();
  assert.equal(context.window._curTheme(), 'purple');
  assert.equal(attributes.get('data-theme'), 'purple');
  assert.ok(!attributes.has('data-sun-classic'));
  context.toggleDayNight();
  assert.equal(context.window._curTheme(), 'sun-classic');
  assert.equal(attributes.get('data-theme'), 'easyview');
  assert.ok(attributes.has('data-sun-classic'));
  context.window._applyTheme('easyview');
  context.toggleDayNight();
  context.toggleDayNight();
  assert.equal(context.window._curTheme(), 'easyview');
  assert.ok(!attributes.has('data-sun-classic'));
});
