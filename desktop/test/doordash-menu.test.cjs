'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const { pageOperation } = require('../src/browser-actions.cjs');
const { parseDoorDashMenuRequest, parseDoorDashCurrentItemRequest, parseDoorDashRestaurantFollowUp, findDoorDashMenuSearch, findDoorDashMenuItem, isDoorDashMenuItemOpen, findDoorDashAddToCart } = require('../src/doordash-menu.cjs');

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

test('chained DoorDash commands preserve which restaurant and item to open or order', () => {
  const mcmuffin = { query: 'McDonald’s', item: 'Egg McMuffin', openOnly: true };
  assert.deepEqual(parseDoorDashMenuRequest("open DoorDash go to McDonald's and open an Egg McMuffin"), mcmuffin);
  assert.deepEqual(parseDoorDashMenuRequest('Hey Ava: could you open the Door Dash app, and then find McDonalds, then show me an Egg McMuffin, please?'), mcmuffin);
  assert.deepEqual(parseDoorDashMenuRequest("Go to McDonald's and open an Egg McMuffin", { onDoorDash: true }), mcmuffin);
  assert.deepEqual(parseDoorDashMenuRequest('Open DoorDash. Find Game of Wings. Show me Buffalo Wings.'), { query: 'Game of Wings', item: 'Buffalo Wings', openOnly: true });
  assert.deepEqual(parseDoorDashMenuRequest('Open DoorDash and open Jack in the Box then get a taco'), { query: 'Jack in the Box', item: 'taco' });
  assert.deepEqual(parseDoorDashMenuRequest('Find Game of Wings and order a chicken sandwich on DoorDash'), { query: 'Game of Wings', item: 'chicken sandwich' });
  for (const command of [
    'Go to Game of Wings and open Buffalo Wings', 'Open DoorDash and go to McDonalds',
    'Open DoorDash, go to McDonalds and open an Egg McMuffin then check out',
    'Open DoorDash, find Jack in the Box and show me my cart',
    'Open DoorDash, go to Burger King and order a chicken sandwich on Uber Eats'
  ]) assert.equal(parseDoorDashMenuRequest(command), null, command);
});

test('short item commands can refer to the current restaurant or name its menu', () => {
  const mcmuffin = { item: 'Egg McMuffin' };
  assert.deepEqual(parseDoorDashCurrentItemRequest('Order an Egg McMuffin.'), mcmuffin);
  assert.deepEqual(parseDoorDashCurrentItemRequest('Hey Ava, please add an Egg McMuffin to my cart on DoorDash.', { orderingOnly: true }), mcmuffin);
  assert.deepEqual(parseDoorDashCurrentItemRequest('Add the Egg McMuffin to the cart'), mcmuffin);
  assert.equal(parseDoorDashCurrentItemRequest('Add an Egg McMuffin to my cart and check out'), null);
  assert.equal(parseDoorDashCurrentItemRequest('Add my cart to the cart'), null);
  assert.deepEqual(parseDoorDashCurrentItemRequest('Get me an Egg McMuffin here, please.'), mcmuffin);
  assert.deepEqual(parseDoorDashCurrentItemRequest('Can you order an Egg McMuffin from this menu?'), mcmuffin);
  assert.deepEqual(parseDoorDashCurrentItemRequest("Order an Egg McMuffin on the McDonald's page"), { ...mcmuffin, query:'McDonald’s' });
  assert.deepEqual(parseDoorDashCurrentItemRequest('Show me an Egg McMuffin in the current menu.'), { ...mcmuffin, openOnly: true });
  assert.deepEqual(parseDoorDashCurrentItemRequest('Open a taco from the Jack in the Box menu.'), { item:'taco', query:'Jack in the Box', openOnly: true });
  for (const command of [
    'Open YouTube', 'Open my browser', 'Find my order here', 'Show me the cart',
    'Order an Egg McMuffin and then check out', 'Order a taco from Jack in the Box',
    'Open burgerking.com', 'Get a Big Mac on Uber Eats'
  ]) assert.equal(parseDoorDashCurrentItemRequest(command), null, command);
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
  assert.equal(findDoorDashMenuItem({ ...page, controls: [...page.controls, { ...card, ref: 'duplicate-card' }] }, item, store).ref, card.ref);
  assert.equal(findDoorDashMenuItem({ ...page, controls: [...page.controls, { ...card, ref: 'other-price', label: title + ' · CA$8.99' }] }, item, store), null);
  assert.equal(findDoorDashMenuItem({ ...page, controls: [...page.controls, { ...card, ref: 'no-price', label: title }] }, item, store), null);
  for (const url of ['https://example.com/', 'https://www.doordash.com/search/store/mcdonalds/', store.replace('123', '999')]) {
    assert.equal(findDoorDashMenuItem({ ...page, url }, item, store), null, url);
  }
  assert.equal(findDoorDashMenuItem({ ...page, title: 'Page not found' }, item, store), null);
  assert.equal(findDoorDashMenuItem({ ...page, title: 'Verify you are human' }, item, store), null);
});

test('store-menu search accepts only an unambiguous visible input owned by the verified store', () => {
  const field = { ref:'menu-search', label:'Search store menu', kind:'input', inputType:'search', needsConfirmation:false };
  const page = { url:store, controls:[
    { ...field, ref:'delivery', label:'Enter delivery address' },
    { ...field, ref:'door-dash-search', label:'Search DoorDash' },
    { ...field, ref:'menu-button', kind:'button' },
    { ...field, ref:'not-shown', visible:false },
    field
  ] };
  assert.deepEqual(findDoorDashMenuSearch(page, store), { ref:field.ref, label:field.label });
  assert.deepEqual(findDoorDashMenuSearch({ url:store, controls:[{ ...field, label:'Search menu', inputType:'text' }] }, store), { ref:field.ref, label:'Search menu' });
  assert.equal(findDoorDashMenuSearch({ ...page, controls:[...page.controls,{ ...field, ref:'second-menu-search' }] }, store), null);
  assert.equal(findDoorDashMenuSearch({ ...page, url:'https://www.doordash.com/business/mcdonalds-437107/' }, 'https://www.doordash.com/business/mcdonalds-437107/'), null);
  assert.equal(findDoorDashMenuSearch(page, store.replace('123', '999')), null);
  assert.equal(findDoorDashMenuSearch({ url:store, controls:[{ ...field, disabled:true }] }, store), null);
});

test('a conflicting menu name, variant, or quick-add label cannot identify the requested item', () => {
  for (const [label, menuTitle] of [
    ['Egg McMuffin® Meal', 'Egg McMuffin®'],
    ['Sausage McMuffin® with Egg · CA$8.39', 'Egg McMuffin®'],
    ['Egg McMuffin® · CA$7.49', 'Egg McMuffin® Meal'],
    ['Add to cart', 'Egg McMuffin®']
  ]) {
    const controls = [{ ...card, label, menuTitle }];
    assert.equal(findDoorDashMenuItem({ url: store, controls }, 'Egg McMuffin', store), null, label);
  }
  for (const requested of ['two Big Macs', 'Big Mac without pickles', 'Big Mac or a cheeseburger', 'Big Mac · CA$3.00']) {
    assert.equal(findDoorDashMenuItem({ url: store, controls: [card] }, requested, store), null, requested);
    assert.equal(findDoorDashAddToCart(details, requested, store), null, requested);
  }
});

test('a second modal blocks background menu clicks, cart actions and URL-only verification', () => {
  const href = store + '?item_id=123';
  const other = { id: 'dialog-1', title: 'Big Mac® Meal' };
  const field = { ref: 's', kind: 'input', inputType: 'search', label: 'Search menu', needsConfirmation: false };
  const layered = { url: href, dialogs: [...details.dialogs, other], controls: [card, add, field] };
  assert.equal(findDoorDashMenuSearch(layered, store), null);
  assert.equal(findDoorDashMenuItem(layered, item, store), null);
  assert.equal(findDoorDashAddToCart(layered, item, store), null);
  assert.equal(isDoorDashMenuItemOpen(layered, item, store, { href }), false);
  assert.equal(isDoorDashMenuItemOpen({ ...layered, dialogs: [other] }, item, store, { href }), false);
});

test('store-menu search recognizes the exact merchant label on a verified DoorDash store', () => {
  const field = { ref:'merchant-search', label:"Search McDonald's", kind:'input', inputType:'search', needsConfirmation:false };
  const global = { ...field, ref:'door-dash-search', label:'Search DoorDash' };
  const unrelated = { ...field, ref:'unrelated-merchant', label:"Search Wendy's" };
  const generic = { ...field, ref:'generic-search', label:'Search store menu' };
  const storeUrl = 'https://www.doordash.com/en/store/1242885/';
  const page = { url:storeUrl, title:'Order McDonald’s - Vancouver, BC Menu Delivery [Menu & Prices] | Vancouver - DoorDash', controls:[global, unrelated, field] };
  assert.deepEqual(findDoorDashMenuSearch(page, storeUrl), { ref:field.ref, label:field.label });
  assert.deepEqual(findDoorDashMenuSearch({ ...page, controls:[...page.controls, generic] }, storeUrl), { ref:generic.ref, label:generic.label });
  assert.equal(findDoorDashMenuSearch({ ...page, title:'DoorDash' }, storeUrl), null);
  assert.equal(findDoorDashMenuSearch({ ...page, controls:[global, unrelated] }, storeUrl), null);
  assert.equal(findDoorDashMenuSearch({ ...page, controls:[field, { ...field, ref:'duplicate-input' }] }, storeUrl), null);
  assert.equal(findDoorDashMenuSearch(page, storeUrl.replace('1242885', '1242886')), null);
  assert.deepEqual(findDoorDashMenuSearch({ url:store, controls:[field] }, store, 'McDonald’s'), { ref:field.ref, label:field.label });
  assert.equal(findDoorDashMenuSearch({ url:store, controls:[unrelated] }, store, 'Wendy’s'), null);
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
