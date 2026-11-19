import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = (await readFile(new URL('../index.html', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');
function extract(start, end) {
  const first = html.indexOf(start), last = html.indexOf(end, first);
  assert.ok(first >= 0 && last > first, start);
  return html.slice(first, last);
}
const source = [
  extract('  function _micSessionCurrent(generation)', '  function _stopMicTracks'),
  extract('  setInterval(function() {\n    if (!_on) { _busySince = 0;', '  // ── Network flip recovery'),
  extract('  function transcribe(blob)', '  // ── Barge-in:')
].join('\n');

function fixture({ audioState = 'running', resume = () => {}, failStart = false, fetchResponse = { text: 'Could you tell me a story?' } } = {}) {
  let now = 1000, level = 128, nextId = 0;
  const intervals = new Map(), timeouts = new Map(), events = [], capture = [], requests = [];
  class Recorder {
    constructor() { this.state = 'inactive'; this.mimeType = 'audio/ogg;codecs=opus'; capture.push(this); }
    start() { if (failStart) throw Error('start failed'); this.state = 'recording'; }
    stop() { this.state = 'inactive'; this.ondataavailable({ data: new Blob([new Uint8Array(1300)]) }); this.onstop(); }
  }
  class AudioContext {
    constructor() { this.state = audioState; }
    createMediaStreamSource() { return { connect() {}, disconnect() {} }; }
    createAnalyser() { return { frequencyBinCount: 128, getByteTimeDomainData(samples) { samples.fill(level); } }; }
    resume() { events.push('resume'); return resume(this); }
    close() { this.state = 'closed'; }
  }
  class FormData {
    constructor() { this.fields = []; }
    append(...args) { this.fields.push(args); }
  }
  const window = { document: { documentElement: { classList: { contains: name => name === 'ava-app-mode' } } }, AudioContext };
  const context = vm.createContext({
    window, MediaRecorder: Recorder, FormData, Blob, AbortController,
    _on: true, _micSessionGeneration: 7, _stream: {}, _recorder: null, _recordTimer: null,
    _busy: false, _busySince: 0, _ttsBusy: false, _chunks: [], _bargingIn: false, _bargeTurnActive: false,
    _bargeAnalyser: null, _bargeNeedsDirectAnswer: false,
    _micTrackDead: () => false, _registerTurnAbort() {},
    Date: { now: () => now }, GROQ_PROXY: 'https://voice.test',
    console: { log() {}, warn() {} },
    setInterval: (run, delay) => { intervals.set(++nextId, { run, delay }); return nextId; },
    clearInterval: id => intervals.delete(id),
    setTimeout: (run, delay) => { timeouts.set(++nextId, { run, delay }); return nextId; },
    clearTimeout: id => timeouts.delete(id),
    fetch: async (url, opts) => { requests.push({ url, opts }); return { ok: true, json: async () => fetchResponse }; },
    btnState: value => events.push(value),
    ask: (text, options) => events.push([text, options.provider, options.generation]),
    stopAll() {
      events.push('stopped'); context._on = false; context._micSessionGeneration++;
      const old = context._recorder; context._recorder = null;
      if (old?.state === 'recording') old.stop();
    },
    _reportVoiceIssue: message => events.push(message),
  });
  vm.runInContext(source, context);
  return { context, events, capture, requests, timeouts, tick(delay, advance = delay, audio = 128) {
    now += advance; level = audio;
    for (const interval of intervals.values()) if (interval.delay === delay) interval.run();
  } };
}

const settle = () => new Promise(resolve => setImmediate(resolve));

test('mobile fallback stays listening while quiet and sends a completed turn through real Whisper routing', async () => {
  const f = fixture();
  f.context.record();
  assert.deepEqual(f.events, []);
  f.tick(33);
  assert.deepEqual(f.events, ['listen']);
  f.tick(1500, 18000);
  assert.equal(f.capture.length, 1);
  assert.equal(f.capture[0].state, 'recording');
  f.tick(33, 33, 170);
  f.tick(33, 33, 170);
  f.tick(33, 300);
  f.tick(33, 900);
  await settle();
  assert.deepEqual(f.events, ['listen', ['Could you tell me a story?', 'whisper', 7]]);
  assert.equal(f.requests[0].url, 'https://voice.test/groq-transcribe');
  assert.equal(f.requests[0].opts.body.fields[0][2], 'audio.ogg');
});

test('mobile fallback waits for suspended audio and reports a bounded failure', () => {
  const f = fixture({ audioState: 'suspended', resume: () => new Promise(() => {}) });
  f.context.record();
  f.tick(33);
  f.tick(33, 1200);
  assert.deepEqual(f.events, ['resume']);
  f.tick(33, 1400);
  assert.equal(f.events.at(-2), 'stopped');
  assert.match(f.events.at(-1), /audio could not start/i);
  assert.equal(f.context._recorder, null);
});

test('mobile fallback starts reading only after the capture context resumes', async () => {
  const f = fixture({ audioState: 'interrupted', resume: ctx => { ctx.state = 'running'; } });
  f.context.record();
  f.tick(33);
  await settle();
  assert.deepEqual(f.events, ['resume']);
  f.tick(33);
  assert.deepEqual(f.events, ['resume', 'listen']);
});

test('mobile recorder startup and native recorder errors surface without an automatic retry', () => {
  const startup = fixture({ failStart: true });
  startup.context.record();
  assert.equal(startup.context._on, false);
  assert.match(startup.events.at(-1), /recording could not start/i);
  assert.equal(startup.timeouts.size, 0);

  const interrupted = fixture();
  interrupted.context.record();
  interrupted.capture[0].onerror();
  assert.equal(interrupted.context._on, false);
  assert.match(interrupted.events.at(-1), /recording stopped/i);
  assert.equal(interrupted.timeouts.size, 0);
});

test('mobile Whisper rate limiting and timeout use visible restart messages', async () => {
  for (const kind of ['busy', 'timed out']) {
    const f = fixture();
    f.context.fetch = kind === 'busy' ? async () => ({ ok: false, status: 429 }) : async () => {
      const error = Error('aborted'); error.name = 'AbortError'; throw error;
    };
    f.context.transcribe({ type: 'audio/ogg' });
    await settle();
    assert.equal(f.events.at(-2), 'stopped');
    assert.match(f.events.at(-1), new RegExp(kind));
    assert.equal(f.timeouts.size, 0);
  }
});
