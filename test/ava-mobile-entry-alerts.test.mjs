import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const boot = html.match(/<head>\s*<script>([\s\S]+?)<\/script>/)[1];
const brief = html.slice(html.indexOf('function _synMaybeAutoBrief(force)'), html.indexOf('function onLogin()'));
const restore = html.match(/\/\* Remember whether Pulse was toggled on[^*]*\*\/([\s\S]*?)document\.addEventListener/)[1];

function launched(search, navigator) {
  const classes = new Set();
  const calls = { brief: 0, pulse: 0 };
  const ctx = vm.createContext({
    URLSearchParams, location: { search }, navigator, window: {}, Date: class extends Date { getHours() { return 10; } },
    document: { documentElement: {
      classList: { add: (...names) => names.forEach(name => classes.add(name)) },
      matches: selector => selector.slice(1).split('.').every(name => classes.has(name)), setAttribute() {},
    } },
    localStorage: { getItem: key => key === 'pulse-open' ? '1' : null, setItem() {} },
    _synGatherBriefContext() { calls.brief++; }, OPEN_KEY: 'pulse-open', _open: false,
    openPulse() { calls.pulse++; }, setTimeout: callback => callback(), currentUser: { name: 'Test' },
    _synSpokenFirstName: name => name,
  });
  vm.runInContext(boot, ctx);
  vm.runInContext(brief, ctx);
  vm.runInContext('_synMaybeAutoBrief()', ctx);
  vm.runInContext(restore, ctx);
  return { ctx, calls };
}

test('Ava on phones and tablets starts without the spoken welcome brief or restored Pulse panel', () => {
  for (const device of [
    { userAgent: 'Android AvaAndroid/0.1.2' }, { userAgent: 'iPhone' },
    { userAgent: 'Macintosh', platform: 'MacIntel', maxTouchPoints: 5 },
    { userAgentData: { mobile: true } },
  ]) {
    const { ctx, calls } = launched('?ava-app=1', device);
    assert.deepEqual(calls, { brief: 0, pulse: 0 });
    vm.runInContext('_synMaybeAutoBrief(true)', ctx);
    assert.equal(calls.brief, 1);
  }
});

test('regular Synapses and desktop Ava retain their signed-in brief and Pulse preference', () => {
  for (const [search, device] of [
    ['', { userAgent: 'Android' }], ['', { userAgent: 'Windows' }], ['?ava-app=1', { userAgent: 'Windows' }],
  ]) assert.deepEqual(launched(search, device).calls, { brief: 1, pulse: 1 });
});
