'use strict';

const { isDoorDashStore, verifyDoorDashRestaurant } = require('./doordash-restaurant.cjs');

const PRICE = /(?:(?:(?:CA|US|AU|NZ)?\$|[€£]|CAD|USD)\s*\d+(?:[.,]\d{2})?)/i;
const PRICE_SEPARATOR = /(?:\s*[,|·•–—-]\s*|\s+)/;
const PRICE_SUFFIX = new RegExp(PRICE_SEPARATOR.source + PRICE.source + '$', 'i');
const CALORIE_SUFFIX = /\s*\[\d+(?:[.,]\d+)?\s+(?:cals?|calories|kcal)\]$/i;
const ADD_TO_CART = new RegExp('^add to (?:cart|order)(?:' + PRICE_SEPARATOR.source + PRICE.source + ')?$', 'i');
const RESTAURANT_NAME = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}\s&'’.,()!+–-]*$/u;
const MCDONALDS_NAME = /^(?:mc\s*donald['’]?\s*s|mcodanlds)$/i;
const DOORDASH_SCOPE = /\s+(?:on|in|via|through|using)\s+(?:the\s+)?door\s*dash(?:\s+(?:app|website|page))?$/i;
const OPEN_DOORDASH = /^(?:open(?: up)?|visit|go to)\s+(?:the\s+)?door\s*dash(?:\s+(?:app|website))?[\s,;:.]+(?:(?:and(?:\s+then)?|then)\s+)?/i;
const MENU_CHAIN = /^(?:go to|find|open)\s+(.+?)(?:\s*[,;:.]+\s*|\s+)(?:(?:and(?:\s+then)?|then)\s+)?(open|show|find|order|buy|get)\s+(.+)$/i;
const MENU_ARTICLE = /^(?:(?:me\s+)?(?:an?|one|the)\s+|me\s+)/i;
const MENU_OPEN_ACTION = /^(?:open|show|find)$/i;
const CURRENT_MENU_SCOPE = /\s+(?:here|(?:on|from|in)\s+(?:this|the(?:\s+current)?)\s+(?:menu|page))$/i;
const NAMED_MENU_SCOPE = /\s+(?:on|from|in)\s+(?:the\s+)?(.+?)\s+(?:menu|page)$/i;
const NAMED_PC_TARGET = /^(?:google|youtube|you tube|steam|codex|chatgpt|chat gpt|edge|chrome|firefox|explorer|file explorer|door dash|doordash)$/i;
const ACTION_SEQUENCE = /\b(?:then|(?:and|or)\s+(?:also\s+)?(?:open|go|search|find|look|order|buy|add|checkout|check out|pay|select|click|read|show|move|scroll|type|play|close|stop))\b/i;
const EXTERNAL_SCOPE = /\s+(?:(?:via|through|using)\s+.+|(?:on|in)\s+(?:the\s+)?(?:uber\s*eats|skipthedishes|skip the dishes|grub\s*hub|postmates|deliveroo|google|google maps|yelp|instacart))$/i;
const NATIVE_OR_BROWSER_SCOPE = /\b(?:app(?:lication)?|browser|website|web page|tab|window|screen|desktop|laptop|file|folder|settings|taskbar|start menu|computer)\b/i;
const EXPLICIT_ADDRESS = /\b(?:https?|www)\b|\.[a-z]{2,63}(?:\s|$)/i;

function spokenRequest(text) {
  if (typeof text !== 'string' || text.length > 300 || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text.trim().replace(/^(?:hey\s+)?ava[\s,:]+/i, '')
    .replace(/^(?:please\s+)?(?:(?:can|could|would|will) you\s+|i(?:'|’)d like to\s+|i (?:want|need) to\s+)?(?:please\s+)?/i, '')
    .replace(/[.!?]+$/, '').replace(/(?:[\s,]+(?:for me|please))+$/i, '').trim();
}

function restaurantName(value) {
  const name = value.trim().replace(/\s+/g, ' ');
  if (!name || name.length > 100 || !RESTAURANT_NAME.test(name) || ACTION_SEQUENCE.test(name) || EXPLICIT_ADDRESS.test(name) || NATIVE_OR_BROWSER_SCOPE.test(name)) return null;
  if (EXTERNAL_SCOPE.test(name) || /\b(?:checkout|check out|payments?|for delivery|near me|on my pc)\b/i.test(name)) return null;
  return MCDONALDS_NAME.test(name) ? 'McDonald’s' : name;
}

function menuItem(value) {
  const item = value.trim().replace(MENU_ARTICLE, '').replace(/\s+/g, ' ');
  if (!item || item.length > 100 || ACTION_SEQUENCE.test(item) || EXTERNAL_SCOPE.test(item) || EXPLICIT_ADDRESS.test(item)) return null;
  if (/\b(?:checkout|check out|payments?|place (?:the|an) order)\b/i.test(item) || /^(?:(?:my|your)\s+)?(?:cart|orders?|account|profile|app|website)$/i.test(item)) return null;
  return item;
}

function parseDoorDashMenuRequest(text, { onDoorDash = false } = {}) {
  const command = spokenRequest(text);
  const explicitlyDoorDash = OPEN_DOORDASH.test(command) || DOORDASH_SCOPE.test(command);
  const body = command.replace(OPEN_DOORDASH, '').replace(DOORDASH_SCOPE, '');
  if (onDoorDash || explicitlyDoorDash) {
    const chain = MENU_CHAIN.exec(body);
    if (chain) {
      const query = restaurantName(chain[1]);
      const item = menuItem(chain[3]);
      if (!query || !item) return null;
      return MENU_OPEN_ACTION.test(chain[2]) ? { query, item, openOnly: true } : { query, item };
    }
  }
  const request = /^(?:order|buy|get)\s+(.+?)\s+from\s+(.+)$/i.exec(body);
  if (!request) return null;
  const item = menuItem(request[1]);
  const query = restaurantName(request[2]);
  if (!item || !query || (!explicitlyDoorDash && !onDoorDash && !MCDONALDS_NAME.test(query))) return null;
  return { query, item };
}

function parseDoorDashCurrentItemRequest(text) {
  const request = /^(open|show|find|order|buy|get)\s+(.+)$/i.exec(spokenRequest(text).replace(DOORDASH_SCOPE, ''));
  if (!request) return null;
  const body = request[2].replace(CURRENT_MENU_SCOPE, '');
  const scope = NAMED_MENU_SCOPE.exec(body);
  const query = scope ? restaurantName(scope[1]) : null;
  if (scope && !query) return null;
  const name = scope ? body.slice(0, scope.index) : body;
  if (/\s+from\s+/i.test(name)) return null;
  const item = menuItem(name);
  if (!item || /^(?:my|your|our|how)\s+/.test(item.toLowerCase()) || NATIVE_OR_BROWSER_SCOPE.test(item) || NAMED_PC_TARGET.test(item)) return null;
  return { item, ...(query ? { query } : {}), ...(MENU_OPEN_ACTION.test(request[1]) ? { openOnly: true } : {}) };
}

function parseDoorDashRestaurantFollowUp(text) {
  const command = spokenRequest(text).replace(DOORDASH_SCOPE, '');
  if (MCDONALDS_NAME.test(command)) return 'McDonald’s';
  const request = /^(?:go to|find|search for)\s+(.+)$/i.exec(command);
  if (!request || /^(?:(?:my|your|this|that|a|the)\s+)?(?:cart|checkout|orders?|page|app|account|profile|browser|desktop|window|screen)\b/i.test(request[1])) return null;
  if (NAMED_PC_TARGET.test(request[1])) return null;
  return restaurantName(request[1]);
}

function itemName(value) {
  return typeof value === 'string' ? value.trim().replace(PRICE_SUFFIX, '').replace(CALORIE_SUFFIX, '').replace(/[®™©]/g, '').normalize('NFKC').toLowerCase().trim().replace(/\s+/g, ' ') : '';
}

function shown(control) {
  return control && typeof control.ref === 'string' && control.ref && !control.disabled && !control.hidden && control.visible !== false;
}

function pageControls(page) {
  return Array.isArray(page.controls) ? page.controls : [];
}

function findDoorDashMenuSearch(page, restaurantUrl) {
  if (!isDoorDashStore(page) || !verifyDoorDashRestaurant(page, restaurantUrl)) return null;
  const fields = pageControls(page).filter(control => shown(control) && control.kind === 'input' && !control.dialog &&
    control.needsConfirmation === false && /^(?:search|text)$/.test(control.inputType) && /^search (?:store )?menu$/i.test(control.label));
  if (fields.length !== 1) return null;
  const { ref, label } = fields[0];
  return { ref, label };
}

function itemLink(href, base, restaurantUrl) {
  if (typeof href !== 'string' || !href) return null;
  try {
    const url = new URL(href, base);
    if (!verifyDoorDashRestaurant({ url: url.href }, restaurantUrl)) return null;
    const itemKey = ['item_id', 'itemId', 'menu_item_id', 'menuItemId'].find(key => url.searchParams.get(key));
    return itemKey && /^[a-z0-9_-]{1,120}$/i.test(url.searchParams.get(itemKey)) ? url : null;
  } catch {
    return null;
  }
}

function displayedPrice(label) {
  const amounts = label.match(new RegExp(PRICE.source, 'gi')) || [];
  return amounts.length === 1 ? amounts[0].replace(/\s+/g, '').toUpperCase() : null;
}

function identicalCard(first, next) {
  const price = displayedPrice(first.label);
  const title = itemName(first.menuTitle);
  return !!price && price === displayedPrice(next.label) && first.kind === next.kind &&
    (first.href || '') === (next.href || '') && (first.label === next.label || !!title && title === itemName(next.menuTitle));
}

function findDoorDashMenuItem(page, item, restaurantUrl) {
  const name = itemName(item);
  if (!name || !verifyDoorDashRestaurant(page, restaurantUrl)) return null;
  const candidates = pageControls(page).filter(control => {
    if (!shown(control) || control.needsConfirmation !== false || control.dialog || typeof control.label !== 'string') return false;
    if (itemName(control.label) !== name && itemName(control.menuTitle) !== name) return false;
    if (control.kind === 'link') return !!itemLink(control.href, page.url, restaurantUrl);
    return control.kind === 'button' && !control.href;
  });
  if (!candidates.length || candidates.slice(1).some(control => !identicalCard(candidates[0], control))) return null;
  const { ref, label, href = '', menuTitle } = candidates[0];
  return { ref, label, href, dialogTitle: '', ...(itemName(label) !== name ? { menuTitle } : {}) };
}

function itemDialog(page, item) {
  const name = itemName(item);
  const dialogs = Array.isArray(page.dialogs) ? page.dialogs : [];
  const matches = dialogs.filter(dialog => dialog?.id && name && itemName(dialog.title) === name);
  return matches.length === 1 ? matches[0] : null;
}

function isDoorDashMenuItemOpen(page, item, restaurantUrl, match) {
  if (!verifyDoorDashRestaurant(page, restaurantUrl)) return false;
  if (itemDialog(page, item)) return true;
  const target = itemLink(match?.href, page.url, restaurantUrl);
  if (!target) return false;
  const current = new URL(page.url);
  return current.pathname === target.pathname && current.search === target.search;
}

function findDoorDashAddToCart(page, item, restaurantUrl) {
  if (!verifyDoorDashRestaurant(page, restaurantUrl)) return null;
  const dialog = itemDialog(page, item);
  if (!dialog) return null;
  const controls = pageControls(page).filter(control => shown(control) && control.kind === 'button' && !control.href && control.dialog === dialog.id && ADD_TO_CART.test(control.label));
  if (controls.length !== 1) return null;
  return { ref: controls[0].ref, label: controls[0].label, dialogTitle: dialog.title };
}

module.exports = { parseDoorDashMenuRequest, parseDoorDashCurrentItemRequest, parseDoorDashRestaurantFollowUp, findDoorDashMenuSearch, findDoorDashMenuItem, isDoorDashMenuItemOpen, findDoorDashAddToCart };
