'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createPcTaskRunner } = require('../src/pc-task-runner.cjs');

const request = 'See what office chairs IKEA has.';
const question = 'Would you like me to sort by cheapest?';
const searchUrl = 'https://www.ikea.com/ca/en/search/?q=office%20chairs';
const owner = { userId: 'shopping-owner' };
const staleRef = 'observed-before-question';
const freshRef = 'observed-after-answer';
const youtubeUrl = 'https://www.youtube.com/';
const unhandled = { handled: false, ok: false, message: '' };

function step(action, fields = {}) {
  return { action, target: null, value: null, secondary: null, direction: null, amount: null, message: '', ...fields };
}

function fixture(prompt = question, { now = Date.now } = {}) {
  const calls = [];
  const requests = [];
  let visibleUrl;
  const page = ref => ({
    url: visibleUrl,
    title: 'Office chairs - IKEA',
    controls: [{ ref, label: 'Price: Low to High', kind: 'button' }]
  });
  const runner = createPcTaskRunner({
    assertActive: () => true,
    now,
    complete: async payload => {
      const input = JSON.parse(payload.messages[1].content);
      requests.push(input);
      if (input.user_request !== request) return step('chat');
      if (!input.clarification) {
        if (!visibleUrl) return step('open_url', { target: searchUrl });
        return step('clarify', { message: prompt });
      }
      if (!calls.some(([action]) => action === 'click')) return step('click', { target: freshRef });
      return step('finish', { message: 'Sorted the IKEA chairs by lowest price.' });
    },
    tools: {
      open_url: async ({ target }) => {
        calls.push(['open_url', target]);
        visibleUrl = target;
        return { ok: true, verified: true, page: page(staleRef) };
      },
      read_page: async () => {
        calls.push(['read_page', visibleUrl]);
        return { ok: true, verified: false, page: page(freshRef) };
      },
      click: async ({ target }) => {
        calls.push(['click', target]);
        return { ok: true, verified: true, page: { ...page(freshRef), text: 'Sorted by Price: Low to High' } };
      }
    }
  });
  return { runner, calls, requests };
}

test('a spoken yes resumes the original request with a fresh browser observation', async () => {
  const { runner, calls, requests } = fixture();
  const first = await runner.run(request, owner);
  assert.equal(first.message, question);
  assert.equal(first.handled, true);
  assert.deepEqual(calls, [['open_url', searchUrl]]);

  const result = await runner.run('Yes.', owner);

  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /sorted.*lowest price/i);
  assert.deepEqual(calls, [['open_url', searchUrl], ['read_page', searchUrl], ['click', freshRef]]);
  assert.equal(requests[0].user_request, request);
  assert.equal(requests[2].user_request, request);
  assert.equal(requests[2].clarification.question, question);
  assert.match(requests[2].clarification.answer, /^yes[.!]?$/i);
  assert.match(JSON.stringify(requests[2].untrusted_tool_observations), new RegExp(freshRef));
  assert.doesNotMatch(JSON.stringify(requests[2].untrusted_tool_observations), new RegExp(staleRef));
  assert.deepEqual(await runner.run('Yes.', owner), unhandled);
  assert.equal(requests.length, 4);
  assert.equal(calls.filter(([action]) => action === 'click').length, 1);
});

test('a short answer naming the requested sort continues the same task', async () => {
  const { runner, calls, requests } = fixture();
  assert.equal((await runner.run(request, owner)).message, question);

  const answer = 'Yes, cheapest first.';
  const result = await runner.run(answer, owner);

  assert.equal(result.ok, true, result.message);
  assert.equal(requests[2].user_request, request);
  assert.deepEqual(requests[2].clarification, { question, answer });
  assert.equal(calls.filter(([action]) => action === 'open_url').length, 1);
  assert.deepEqual(calls.at(-1), ['click', freshRef]);
});

test('declining a clarification dismisses it without another planner call or action', async () => {
  const { runner, calls, requests } = fixture();
  assert.equal((await runner.run(request, owner)).message, question);

  const result = await runner.run('No, thanks.', owner);

  assert.equal(result.handled, true);
  assert.equal(result.ok, true);
  assert.deepEqual(await runner.run('Yes.', owner), unhandled);
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [['open_url', searchUrl]]);
});

test('canceling the voice task clears its clarification and an isolated yes stays unhandled', async () => {
  const { runner, calls, requests } = fixture();
  assert.equal((await runner.run(request, owner)).message, question);
  runner.cancel();

  assert.deepEqual(await runner.run('No.', owner), unhandled);
  assert.deepEqual(await runner.run('Yes.', owner), unhandled);
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [['open_url', searchUrl]]);
});

test('a different signed-in user cannot answer or revive the previous user’s clarification', async () => {
  const { runner, calls, requests } = fixture();
  assert.equal((await runner.run(request, owner)).message, question);

  assert.deepEqual(await runner.run('Yes.', { userId: 'other-owner' }), unhandled);
  assert.deepEqual(await runner.run('Yes.', owner), unhandled);
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [['open_url', searchUrl]]);
});

test('an expired clarification does not resume when the user eventually says yes', async () => {
  let now = Date.now();
  const { runner, calls, requests } = fixture(question, { now: () => now });
  assert.equal((await runner.run(request, owner)).message, question);
  now += 60 * 60 * 1000;

  assert.deepEqual(await runner.run('Yes.', owner), unhandled);
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [['open_url', searchUrl]]);
});

test('a later unrelated task replaces the pending question', async () => {
  const { runner, calls, requests } = fixture();
  assert.equal((await runner.run(request, owner)).message, question);

  assert.equal((await runner.run('Open YouTube.', owner)).ok, true);
  assert.deepEqual(await runner.run('Yes.', owner), unhandled);
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [['open_url', searchUrl], ['open_url', youtubeUrl]]);
});

test('an ambiguous yes does not choose among distinct options or call the planner', async () => {
  const { runner, calls, requests } = fixture('Should I sort by price or customer rating?');
  await runner.run(request, owner);

  const result = await runner.run('Yes.', owner);

  assert.equal(result.handled, true);
  assert.equal(result.ok, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [['open_url', searchUrl]]);
});

test('a planner question about paying or placing an order cannot be authorized by saying yes', async () => {
  const { runner, calls, requests } = fixture('Should I place the order and pay now?');
  await runner.run(request, owner);

  const result = await runner.run('Yes.', owner);

  assert.equal(result.ok, false);
  assert.equal(requests.length, 2);
  assert.deepEqual(calls, [['open_url', searchUrl]]);
});
