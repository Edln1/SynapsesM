'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { pageOperation } = require('../src/browser-actions.cjs');
const { parseDoorDashMenuRequest, parseDoorDashRestaurantFollowUp, findDoorDashMenuItem, isDoorDashMenuItemOpen, findDoorDashAddToCart } = require('../src/doordash-menu.cjs');

const store = 'https://www.doordash.com/en-CA/store/mcdonalds-123/';
const item = 'Big Mac';
const title = 'Big Mac® [560.0 Cals]';
const card = { ref: 'item-a', kind: 'button', label: title + ' · CA$8.39', href: '', needsConfirmation: false };
const add = { ref: 'add', kind: 'button', label: 'Add to order – CA$8.39', href: '', dialog: 'dialog-0', needsConfirmation: true };
const details = { url: store, dialogs: [{ id: 'dialog-0', title }], controls: [add] };

test('the simple McDonald’s voice request selects a single menu item and brand', () => {
  for (const command of [
    'Order Big Mac from McDonalds.',
    "Hey Ava, could you please order me a Big Mac from McDonald's on DoorDash?",
    'I’d like to get a Big Mac from McDonald’s through the Door Dash app, please.',
    'order big mac from mcodanlds',
    'Buy one Big Mac from McDonalds for me.'
  ]) assert.deepEqual(parseDoorDashMenuRequest(command), { query: 'McDonald’s', item: command.includes('big mac') ? 'big mac' : item });
  for (const command of [
    'Big Mac from McDonalds', 'Order a Big Mac from a different restaurant',
    'Order a Big Mac from McDonalds and check out', 'Order a Big Mac from McDonalds on Uber Eats',
    'order Big Mac from McDonalds\ncheck out'
  ]) assert.equal(parseDoorDashMenuRequest(command), null, command);
});

test('any named restaurant and item can use DoorDash with explicit or observed context', () => {
  const taco = { query: 'Jack in the Box', item: 'taco' };
  assert.deepEqual(parseDoorDashMenuRequest('Order a taco from Jack in the Box on DoorDash'), taco);
  assert.deepEqual(parseDoorDashMenuRequest('Order a taco from Jack in the Box', { onDoorDash: true }), taco);
  assert.deepEqual(parseDoorDashMenuRequest('Could you order a chicken sandwich from Game of Wings on Door Dash?'), { query: 'Game of Wings', item: 'chicken sandwich' });
  assert.equal(parseDoorDashMenuRequest('Order a taco from Jack in the Box'), null);
  for (const command of [
    'Order a taco from Jack in the Box using a native app', 'Order a taco from Burger King on Uber Eats',
    'Order a taco from Burger King and open YouTube', 'Order a taco from burgerking.com',
    'Order a taco from Burger King and pay', 'Order a taco then checkout from Jack in the Box'
  ]) assert.equal(parseDoorDashMenuRequest(command, { onDoorDash: true }), null, command);
});

test('restaurant follow-ups preserve user phrasing without interpreting new or compound computer actions', () => {
  assert.equal(parseDoorDashRestaurantFollowUp('McDonald’s'), 'McDonald’s');
  assert.equal(parseDoorDashRestaurantFollowUp('Ava, go to Game of Wings please.'), 'Game of Wings');
  assert.equal(parseDoorDashRestaurantFollowUp('Find Jack in the Box.'), 'Jack in the Box');
  assert.equal(parseDoorDashRestaurantFollowUp('Search for Fish and Chips on DoorDash'), 'Fish and Chips');
  for (const command of ['Hello', 'Game of Wings', 'Find', 'Go to cart', 'Go to youtube.com', 'go to Steam', 'Go to DoorDash', 'Find the Start menu', 'Go to Game of Wings and click on it', 'Find Game of Wings then play the video', 'Search for Game of Wings on Google']) {
    assert.equal(parseDoorDashRestaurantFollowUp(command), null, command);
  }
});

test('a menu click requires one visible exact item and its verified restaurant', () => {
  const page = { url: store, controls: [
    { ...card, ref: 'meal', label: 'Big Mac® Meal' },
    { ...card, ref: 'hidden', visible: false },
    { ...card, ref: 'disabled', disabled: true },
    { ...card, ref: 'payment', label: 'Order Big Mac®', needsConfirmation: true },
    { ...card, ref: 'input', kind: 'input' },
    card
  ] };
  assert.deepEqual(findDoorDashMenuItem(page, item, store), { ref: card.ref, label: card.label, href: '', dialogTitle: '' });
  const semanticCard = { ...card, label: 'View item and customize', menuTitle: title };
  assert.deepEqual(findDoorDashMenuItem({ url: store, controls: [semanticCard] }, item, store), { ref: card.ref, label: semanticCard.label, href: '', dialogTitle: '', menuTitle: title });
  assert.equal(findDoorDashMenuItem({ url: store, controls: [{ ...semanticCard, label: 'Place order', needsConfirmation: true }] }, item, store), null);
  assert.equal(findDoorDashMenuItem({ ...page, controls: [...page.controls, { ...card, ref: 'other-card' }] }, item, store), null);
  for (const url of ['https://example.com/', 'https://www.doordash.com/search/store/mcdonalds/', store.replace('123', '999')]) {
    assert.equal(findDoorDashMenuItem({ ...page, url }, item, store), null, url);
  }
  assert.equal(findDoorDashMenuItem({ ...page, title: 'Page not found' }, item, store), null);
  assert.equal(findDoorDashMenuItem({ ...page, title: 'Verify you are human' }, item, store), null);
});

test('links must reveal an item on the same verified DoorDash listing', () => {
  const href = '/en-CA/store/mcdonalds-123/?item_id=9876';
  const link = { ...card, kind: 'link', href };
  const selected = findDoorDashMenuItem({ url: store, controls: [link] }, item, store);
  assert.equal(selected.href, href);
  assert.equal(isDoorDashMenuItemOpen({ url: new URL(href, store).href }, item, store, selected), true);
  assert.equal(isDoorDashMenuItemOpen({ url: store }, item, store, selected), false);
  for (const href of ['/checkout/', '/store/mcdonalds-999/?item_id=9876', 'https://example.com/en-CA/store/mcdonalds-123/?item_id=9876', store]) {
    assert.equal(findDoorDashMenuItem({ url: store, controls: [{ ...link, href }] }, item, store), null, href);
  }
});

test('the add button belongs to the exact item dialog and never treats checkout as cart preparation', () => {
  assert.equal(isDoorDashMenuItemOpen(details, item, store), true);
  assert.deepEqual(findDoorDashAddToCart(details, item, store), { ref: add.ref, label: add.label, dialogTitle: title });
  assert.equal(isDoorDashMenuItemOpen({ url: store, text: 'Big Mac® · $6.99', controls: [card] }, item, store), false);
  assert.equal(findDoorDashAddToCart({ ...details, dialogs: [{ id: 'dialog-0', title: 'Big Mac® Meal' }] }, item, store), null);
  assert.equal(findDoorDashAddToCart({ ...details, controls: [add, { ...add, ref: 'second-add' }] }, item, store), null);
  assert.equal(findDoorDashAddToCart({ ...details, controls: [{ ...add, dialog: null }] }, item, store), null);
  for (const label of ['Add', 'Add to cart and check out', 'Place order', 'Pay $6.99', 'Checkout']) {
    assert.equal(findDoorDashAddToCart({ ...details, controls: [{ ...add, label }] }, item, store), null, label);
  }
});

test('isolated snapshots scope visible controls to their dialog and guard against a changed item', async () => {
  const dialogTitle = { textContent: 'Big Mac®' };
  const box = { width: 100, height: 100, bottom: 200, right: 200, top: 100, left: 100 };
  const dialog = {
    matches: () => true,
    getBoundingClientRect: () => box,
    getAttribute: name => name === 'aria-labelledby' ? 'item-title' : '',
    querySelector: () => null
  };
  const button = {
    tagName: 'BUTTON', isConnected: true, type: 'button', innerText: 'Add to cart',
    getBoundingClientRect: () => box, getAttribute: () => '', closest: selector => selector === 'form' ? null : dialog,
    click() { this.clicked = true; }
  };
  const context = vm.createContext({
    document: {
      title: 'McDonald’s', body: { innerText: 'Big Mac®' }, getElementById: () => dialogTitle,
      querySelectorAll: selector => selector.startsWith('dialog') ? [dialog] : [button]
    }, location: { href: store }, innerHeight: 800, innerWidth: 1000, scrollX: 0, scrollY: 0,
    getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' })
  });
  const run = args => vm.runInContext(`(${pageOperation.toString()})(${JSON.stringify({ token: 'menu-test', ...args })})`, context);
  const snapshot = await run({ mode: 'snapshot' });
  assert.equal(snapshot.dialogs[0].title, 'Big Mac®');
  assert.equal(snapshot.controls[0].dialog, snapshot.dialogs[0].id);
  const ref = snapshot.controls[0].ref;
  const inspected = await run({ mode: 'inspect', ref });
  assert.equal(inspected.dialogTitle, 'Big Mac®');
  dialogTitle.textContent = 'Cheeseburger';
  assert.equal((await run({ mode: 'click', ref, fingerprint: inspected.fingerprint })).error, 'changed_control');
  assert.equal(button.clicked, undefined);
});
