'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { doorDashSearchUrl } = require('../src/doordash-restaurant.cjs');
const { createPcTaskRunner } = require('../src/pc-task-runner.cjs');
const { createPcTaskTools } = require('../src/pc-task-tools.cjs');

const utterance = 'order big mac from mcodanlds';
const restaurant = 'McDonald’s';
const store = 'https://www.doordash.com/store/mcdonalds-vancouver-123/';
const fartherStore = 'https://www.doordash.com/store/mcdonalds-vancouver-456/';
const menuCard = { ref: 'menu-big-mac', kind: 'button', label: 'Big Mac®', href: '', needsConfirmation: false };
const mealCard = { ...menuCard, ref: 'menu-meal', label: 'Big Mac® Meal' };
const dialog = { id: 'dialog-0', title: 'Big Mac®' };
const add = { ref: 'add-big-mac', kind: 'button', label: 'Add to order – $6.99', dialog: dialog.id, href: '', needsConfirmation: true };
const checkout = { ...add, ref: 'checkout', label: 'Place order' };

function page(controls, dialogs = [], url = store) {
  return { url, title: 'McDonald’s Menu', controls, dialogs };
}

function fixture({ current = page([mealCard, menuCard]), approved = true, addResult, afterScroll } = {}) {
  const trace = [];
  let visiblePage = current;
  let additions = 0;
  let plannerCalls = 0;
  const search = doorDashSearchUrl(restaurant);
  const question = 'Confirm “Add to order – $6.99” for Big Mac®.';
  const tools = createPcTaskTools({
    windows: {},
    assertActive: () => true,
    authorizeAction: async request => {
      trace.push(['confirm', request]);
      assert.deepEqual(request, { action: 'click', description: question });
      assert.equal(additions, 0);
      assert.equal(visiblePage.dialogs[0], dialog);
      return approved;
    },
    browser: {
      async perform(action, args, trusted) {
        trace.push([action, args, trusted]);
        if (action === 'read_page') return { ok: !!visiblePage, page: visiblePage };
        if (action === 'open_url') {
          assert.ok(args.url === search || args.url === store, 'Only the observed nearest store may open');
          visiblePage = args.url === search
            ? page([
              { label: 'McDonald’s • 2 mi', href: fartherStore },
              { label: 'McDonald’s • 800 m', href: store }
            ], [], search)
            : page([mealCard, menuCard]);
          return { ok: true, verified: true, page: visiblePage };
        }
        if (action === 'scroll') {
          assert.deepEqual(args, { direction: 'down', amount: 420 });
          if (!afterScroll) return { ok: true, verified: false, page: visiblePage };
          visiblePage = afterScroll;
          return { ok: true, verified: true, page: visiblePage };
        }
        assert.equal(action, 'click');
        if (args.ref === menuCard.ref) {
          assert.deepEqual(trusted, { confirmed: false, expectedControl: { label: menuCard.label, dialogTitle: '', href: '' } });
          visiblePage = page([checkout, add], [dialog]);
          return { ok: true, verified: true, page: visiblePage };
        }
        assert.equal(args.ref, add.ref, 'Only the observed Add control may be clicked');
        assert.deepEqual(trusted.expectedControl, { label: add.label, dialogTitle: dialog.title, href: '', confirm: true });
        if (!trusted.confirmed) return { ok: false, confirmationRequired: true, message: question };
        assert.equal(approved, true);
        additions++;
        if (addResult) return addResult;
        visiblePage = page([checkout]);
        return { ok: true, verified: true, page: visiblePage };
      }
    }
  });
  const runner = createPcTaskRunner({
    tools,
    assertActive: () => true,
    complete: async () => { plannerCalls++; throw Error('The direct DoorDash task should skip the planner'); }
  });
  return { runner, trace, search, additions: () => additions, plannerCalls: () => plannerCalls, visiblePage: () => visiblePage };
}

function clickedRefs(trace) {
  return trace.filter(([action]) => action === 'click').map(([, args, trusted]) => [args.ref, trusted.confirmed]);
}

test('spoken Big Mac request reuses the open store and adds only after explicit confirmation', async () => {
  const f = fixture();
  const result = await f.runner.run(utterance, { userId: 'same-owner' });

  assert.equal(result.ok, true);
  assert.match(result.message, /check your cart/i);
  assert.equal(f.additions(), 1);
  assert.equal(f.plannerCalls(), 0);
  assert.deepEqual(f.trace.map(([action]) => action), ['read_page', 'click', 'click', 'confirm', 'click']);
  assert.deepEqual(clickedRefs(f.trace), [[menuCard.ref, false], [add.ref, false], [add.ref, true]]);
});

test('spoken Big Mac request selects the closest observed branch when the store is not open', async () => {
  const f = fixture({ current: null });
  const result = await f.runner.run(utterance);

  assert.equal(result.ok, true);
  assert.equal(f.plannerCalls(), 0);
  assert.deepEqual(f.trace.filter(([action]) => action === 'open_url').map(([, args]) => args.url), [f.search, store]);
  assert.deepEqual(clickedRefs(f.trace), [[menuCard.ref, false], [add.ref, false], [add.ref, true]]);
});

test('a Big Mac Meal alone cannot satisfy the request and remains unselected', async () => {
  const initial = page([mealCard]);
  const f = fixture({ current: initial });
  const result = await f.runner.run(utterance);

  assert.equal(result.ok, false);
  assert.match(result.message, /couldn’t verify big mac on the McDonald’s menu/i);
  assert.equal(f.plannerCalls(), 0);
  assert.equal(f.visiblePage(), initial);
  assert.deepEqual(f.trace.map(([action]) => action), ['read_page', 'read_page', 'scroll']);
});

test('the first verified scroll can reveal the Big Mac without further scrolling', async () => {
  const f = fixture({ current: page([mealCard]), afterScroll: page([mealCard, menuCard]) });
  const result = await f.runner.run(utterance);

  assert.equal(result.ok, true);
  assert.equal(f.plannerCalls(), 0);
  assert.deepEqual(f.trace.map(([action]) => action), ['read_page', 'read_page', 'scroll', 'click', 'click', 'confirm', 'click']);
  assert.deepEqual(clickedRefs(f.trace), [[menuCard.ref, false], [add.ref, false], [add.ref, true]]);
});

test('declining the cart action leaves the item dialog open without adding or retrying', async () => {
  const f = fixture({ approved: false });
  const result = await f.runner.run(utterance);

  assert.match(result.message, /left big mac open/i);
  assert.equal(f.additions(), 0);
  assert.equal(f.plannerCalls(), 0);
  assert.deepEqual(f.visiblePage().dialogs, [dialog]);
  assert.deepEqual(f.trace.map(([action]) => action), ['read_page', 'click', 'click', 'confirm']);
  assert.deepEqual(clickedRefs(f.trace), [[menuCard.ref, false], [add.ref, false]]);
});

test('an uncertain cart action is never retried and leaves checkout to the user', async () => {
  const f = fixture({ addResult: { ok: false, error: 'navigation_timeout' } });
  const result = await f.runner.run(utterance);

  assert.equal(result.ok, false);
  assert.match(result.message, /check doordash before adding big mac again/i);
  assert.equal(f.additions(), 1);
  assert.equal(f.plannerCalls(), 0);
  assert.deepEqual(clickedRefs(f.trace), [[menuCard.ref, false], [add.ref, false], [add.ref, true]]);
});

const landingUrl = 'https://www.doordash.com/';
const restaurantFollowUp = "go to McDonald's";

function navigationFixture() {
  const opens = [];
  const requests = [];
  let visiblePage;
  const runner = createPcTaskRunner({
    assertActive: () => true,
    complete: async request => {
      requests.push(JSON.parse(request.messages[1].content).user_request);
      return { action: 'chat', target: null, value: null, secondary: null, direction: null, amount: null, message: '' };
    },
    tools: {
      read_page: async () => ({ ok: !!visiblePage, page: visiblePage }),
      open_url: async ({ target }) => {
        opens.push(target);
        if (target === landingUrl) visiblePage = { url: target, title: 'DoorDash', controls: [] };
        else if (target === store) visiblePage = { url: target, title: 'McDonald’s Menu', controls: [] };
        else {
          assert.match(decodeURIComponent(new URL(target).pathname), /^\/search\/store\/mcdonald['’]?s\/?$/i);
          visiblePage = { url: target, title: 'DoorDash Search', controls: [{ href: store, label: restaurant }] };
        }
        return { ok: true, verified: true, page: visiblePage };
      }
    }
  });
  return { runner, opens, requests };
}

test('after opening DoorDash, a separate McDonald’s request uses the same account’s verified DoorDash context', async () => {
  const { runner, opens, requests } = navigationFixture();
  const account = { userId: 'door-owner' };

  assert.equal((await runner.run('Open DoorDash', account)).ok, true);
  const result = await runner.run(restaurantFollowUp, account);

  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /mcdonald.+doordash/i);
  assert.equal(opens[0], landingUrl);
  assert.equal(opens.at(-1), store);
  assert.deepEqual(requests, []);
});

test('a different account cannot use the previous account’s DoorDash context', async () => {
  const { runner, opens, requests } = navigationFixture();

  assert.equal((await runner.run('Open DoorDash', { userId: 'first-owner' })).ok, true);
  const result = await runner.run(restaurantFollowUp, { userId: 'second-owner' });

  assert.notEqual(result.ok, true);
  assert.deepEqual(opens, [landingUrl]);
  assert.deepEqual(requests, [restaurantFollowUp]);
});

test('an explicit DoorDash order finds a different restaurant and item from observed pages', async () => {
  const restaurantName = 'Cedar Kitchen';
  const itemName = 'Spicy Chicken Sandwich';
  const searchUrl = doorDashSearchUrl(restaurantName);
  const storefront = 'https://www.doordash.com/store/cedar-kitchen-678/';
  const ref = 'menu-cedar-chicken';
  const item = { ref, label: itemName, kind: 'button', href: '', needsConfirmation: false };
  const calls = [];
  const runner = createPcTaskRunner({
    assertActive: () => true,
    complete: async () => { calls.push(['planner']); throw Error('Unexpected planner call'); },
    tools: {
      read_page: async () => { calls.push(['read']); return { ok: false }; },
      open_url: async ({ target }) => {
        calls.push(['open', target]);
        const page = {
          url: target,
          title: target === searchUrl ? 'DoorDash Search' : restaurantName,
          controls: target === searchUrl ? [{ href: storefront, label: restaurantName }] : [item]
        };
        return { ok: true, verified: true, page };
      },
      click: async ({ target }) => {
        calls.push(['click', target]);
        return { ok: true, verified: true, page: { url: storefront, dialogs: [{ id: 'dialog-chicken', title: itemName }], controls: [] } };
      }
    }
  });

  const result = await runner.run(`Order a ${itemName} from ${restaurantName} on DoorDash.`);

  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /opened spicy chicken sandwich/i);
  assert.deepEqual(calls, [['read'], ['open', searchUrl], ['open', storefront], ['click', ref]]);
});

function breakfastFixture() {
  const breakfast = { ...menuCard, ref: 'menu-mcmuffin', label: 'Egg McMuffin®' };
  const breakfastMeal = { ...breakfast, ref: 'menu-mcmuffin-meal', label: 'Egg McMuffin® Meal' };
  const breakfastDialog = { id: 'breakfast-dialog', title: breakfast.label };
  const addBreakfast = { ...add, ref: 'add-mcmuffin', label: 'Add to cart – $4.59', dialog: breakfastDialog.id };
  const question = 'Confirm “Add to cart – $4.59” for Egg McMuffin®.';
  const calls = [];
  const account = { userId: 'breakfast-owner' };
  let visiblePage;
  const tools = createPcTaskTools({
    windows: {},
    assertActive: () => true,
    authorizeAction: async request => {
      calls.push(['confirm', request]);
      assert.deepEqual(request, { action: 'click', description: question });
      return true;
    },
    browser: {
      async perform(action, args, trusted) {
        calls.push([action, args, trusted]);
        if (action === 'read_page') return { ok: !!visiblePage, page: visiblePage };
        if (action === 'open_url') {
          if (args.url === landingUrl) visiblePage = { url: args.url, title: 'DoorDash', controls: [] };
          else if ([store, fartherStore].includes(args.url)) visiblePage = page([breakfastMeal, breakfast], [], args.url);
          else {
            assert.match(decodeURIComponent(new URL(args.url).pathname), /^\/search\/store\/mcdonald['’]?s\/?$/i);
            visiblePage = {
              url: args.url, title: 'DoorDash Search', controls: [
                { href: fartherStore, label: 'McDonald’s • 2 mi' },
                { href: store, label: 'McDonald’s • 800 m' }
              ]
            };
          }
          return { ok: true, verified: true, page: visiblePage };
        }
        assert.equal(action, 'click');
        if (args.ref === breakfast.ref) {
          const checkoutInDialog = { ...checkout, dialog: breakfastDialog.id };
          visiblePage = page([addBreakfast, checkoutInDialog], [breakfastDialog], visiblePage.url);
        } else {
          assert.equal(args.ref, addBreakfast.ref, 'Only the observed breakfast Add control may be used');
          assert.equal(trusted.expectedControl.confirm, true);
          if (!trusted.confirmed) return { ok: false, confirmationRequired: true, message: question };
          visiblePage = page([checkout], [], visiblePage.url);
        }
        return { ok: true, verified: true, page: visiblePage };
      }
    }
  });
  const runner = createPcTaskRunner({
    tools,
    assertActive: () => true,
    complete: async () => {
      calls.push(['planner']);
      throw Object.assign(Error('Too many planner requests'), { code: 'planner_rate_limited' });
    }
  });
  return { runner, account, calls, breakfast, breakfastDialog, addBreakfast, visiblePage: () => visiblePage };
}

test('the combined Egg McMuffin command works without a planner and opens only the item', async () => {
  const utterance = "open DoorDash go to McDonald's and open an Egg McMuffin";
  for (const alreadyOpen of [false, true]) {
    const f = breakfastFixture();
    if (alreadyOpen) assert.equal((await f.runner.run('Open DoorDash', f.account)).ok, true);
    f.calls.length = 0;

    const result = await f.runner.run(utterance, f.account);

    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /opened egg mcmuffin/i);
    assert.equal(f.calls.some(([action]) => action === 'confirm' || action === 'planner'), false);
    assert.equal(f.calls.filter(([action]) => action === 'open_url').at(-1)[1].url, store);
    assert.deepEqual(clickedRefs(f.calls), [[f.breakfast.ref, false]]);
    assert.deepEqual(f.visiblePage().dialogs, [f.breakfastDialog]);
  }
});

test('order an Egg McMuffin uses the current store and confirms only the observed cart action', async () => {
  const f = breakfastFixture();
  const first = await f.runner.run("Open McDonald's on DoorDash", f.account);
  assert.equal(first.ok, true, first.message);
  const openStore = f.visiblePage().url;
  assert.ok([store, fartherStore].includes(openStore));
  f.calls.length = 0;

  const result = await f.runner.run('order an Egg McMuffin', f.account);

  assert.equal(result.ok, true, result.message);
  assert.match(result.message, /check your cart/i);
  assert.equal(f.visiblePage().url, openStore);
  assert.deepEqual(f.calls.map(([action]) => action), ['read_page', 'click', 'click', 'confirm', 'click']);
  assert.deepEqual(clickedRefs(f.calls), [[f.breakfast.ref, false], [f.addBreakfast.ref, false], [f.addBreakfast.ref, true]]);
});
