import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { create } = require('../ava-mobile-read-aloud.js');

function settle() {
  return new Promise(resolve => setImmediate(resolve));
}

function fixture(t) {
  const context = { ownerKey: 'owner', threadId: 'conversation', voiceActive: false };
  const requests = [], played = [];
  const labels = new WeakMap(), urls = new Map();
  let sequence = 0;
  const audio = {
    src: '', muted: false, volume: 1, currentTime: 0,
    play() {
      if (!this.muted && urls.has(this.src)) played.push(urls.get(this.src));
      return Promise.resolve();
    },
    pause() {},
    load() {},
    removeAttribute(name) { if (name === 'src') this.src = ''; },
  };
  const api = create({
    conversationScoped: true,
    getContext: () => context,
    createAudio: () => audio,
    cleanText: text => text.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\s+/g, ' ').trim(),
    synthesize(text, controller) {
      return new Promise(resolve => {
        requests.push({ text, signal: controller.signal, resolve() {
          const blob = new Blob([text]);
          labels.set(blob, text);
          resolve(blob);
        } });
      });
    },
    createObjectURL(blob) {
      const url = 'blob:reply-' + ++sequence;
      urls.set(url, labels.get(blob));
      return url;
    },
    revokeObjectURL(url) { urls.delete(url); },
  });
  t.after(() => api.destroy());
  api.setEnabled(true);
  const reply = text => ({ ownerKey: context.ownerKey, threadId: context.threadId, responseId: 'reply', text });
  return { api, context, audio, requests, played, reply };
}

test('mobile speech starts from an early portion of a long first sentence', async t => {
  const f = fixture(t);
  const first = 'Gather the useful details that the team can use to plan its day, '.repeat(5) +
    'and put these items in an order everyone can follow.';
  const partial = `${first} Keep going with the next part`;
  f.api.progress(f.reply(partial));
  await settle();
  assert.ok(f.requests.length > 0, 'The first audio request starts before model completion');
  assert.ok(partial.startsWith(f.requests[0].text), 'The first clip contains the beginning of the reply');
  assert.ok(f.requests[0].text.length < partial.length, 'The first clip leaves unfinished text for later');
  f.requests[0].resolve();
  await settle();
  assert.deepEqual(f.played, [f.requests[0].text]);
});

test('a bold opening sentence starts mobile narration before final text arrives', async t => {
  const f = fixture(t);
  f.api.progress(f.reply('**Start with the most useful detail**. The next sentence is still being written'));
  await settle();
  assert.equal(f.requests[0]?.text, 'Start with the most useful detail.');
});

test('a whitespace revision in the final reply preserves the first clip and plays every remaining sentence once', async t => {
  const f = fixture(t);
  const opening = 'Here is one practical way to get started.';
  const remainder = 'Set aside one afternoon to finish the remaining steps. Then review the result together.';
  f.api.progress(f.reply(`${opening} Set aside`));
  await settle();
  f.requests[0].resolve();
  await settle();
  assert.deepEqual(f.played, [opening]);
  const source = f.audio.src;
  const final = f.reply(`${opening.replace('one practical', 'one  practical')} ${remainder}`);
  const completion = f.api.complete(final);
  await settle();
  assert.equal(f.audio.src, source, 'An authoritative final reply does not cut off audio already playing');
  for (let index = 1; index < 8; index++) {
    if (f.audio.onended) f.audio.onended();
    await settle();
    const nextRequest = f.requests[index];
    if (!nextRequest) break;
    nextRequest.resolve();
    await settle();
  }
  await completion;
  await f.api.complete(final);
  assert.equal(f.played.join(' '), `${opening} ${remainder}`);
});

test('switching account aborts a prior conversation queue, even when synthesis resolves late', async t => {
  const f = fixture(t);
  f.api.progress(f.reply('This text belongs to the first owner. The rest is still arriving.'));
  await settle();
  const prior = f.requests[0];
  assert.ok(prior);
  f.context.ownerKey = 'second-owner';
  f.api.contextChanged();
  assert.equal(prior.signal.aborted, true);
  prior.resolve();
  await settle();
  assert.deepEqual(f.played, []);
  assert.equal(f.api.state.enabled, false);
});
