'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPcTaskRunner } = require('../src/pc-task-runner.cjs');

const utterance = 'Go to Amazon and find 32GB RAM';
const account = { userId: 'amazon-owner', voiceSessionId: 'voice-session' };
const search = 'https://www.amazon.ca/s?k=32GB+RAM';
const refined = search + '&rh=p_85%3A5690392011';

function fixture({ echoSort = true } = {}) {
  let visible = 'https://www.amazon.ca/';
  const opens = [];
  const runner = createPcTaskRunner({
    assertActive: () => true,
    complete: async () => { assert.fail('Amazon search and sort should run without the planner'); },
    tools: {
      read_page: async () => ({ ok: true, page: { url: visible, title: 'Amazon.ca' } }),
      open_url: async ({ target }) => {
        opens.push(target);
        visible = target === search ? refined : echoSort ? target : refined;
        return { ok: true, verified: true, page: { url: visible, title: '32GB RAM at Amazon.ca' } };
      }
    }
  });
  return { runner, opens, moveTo: url => { visible = url; } };
}

test('a spoken yes sorts the same regional Amazon search and preserves its filters', async () => {
  const f = fixture();
  const first = await f.runner.run(utterance, account);
  assert.equal(first.ok, true, first.message);
  assert.match(first.message, /would you like me to sort by lowest price/i);
  assert.deepEqual(f.opens, [search]);
  const sorted = await f.runner.run('Yes', account);
  assert.equal(sorted.ok, true, sorted.message);
  assert.equal(f.opens[1], refined + '&s=price-asc-rank');
  assert.equal((await f.runner.run('Yes', account)).handled, false);
  assert.equal(f.opens.length, 2);
});

test('a changed Amazon search and a different voice session cannot consume the sort offer', async () => {
  const f = fixture();
  await f.runner.run(utterance, account);
  f.moveTo('https://www.amazon.ca/s?k=other');
  assert.match((await f.runner.run('Yes', account)).message, /search changed/i);
  assert.deepEqual(f.opens, [search]);
  await f.runner.run(utterance, account);
  assert.equal((await f.runner.run('Yes', { ...account, voiceSessionId: 'fresh-session' })).handled, false);
  assert.deepEqual(f.opens, [search, search]);
});

test('Ava verifies the resulting Amazon sort before reporting it', async () => {
  const f = fixture({ echoSort: false });
  await f.runner.run(utterance, account);
  const sorted = await f.runner.run('Yes', account);
  assert.equal(sorted.ok, false);
  assert.match(sorted.message, /couldn’t verify the lowest-price sort/i);
});
