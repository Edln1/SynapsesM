'use strict';

const MARKETPLACE = /^(?:www\.)?amazon\.(?:com|ca|co\.uk|com\.au|com\.br|com\.mx|co\.jp|com\.tr|com\.be|de|fr|it|es|nl|se|pl|ie|in|sg|ae|sa|eg|co\.za)$/i;
const SITE_FIRST = /^(?:(?:go to|open|visit)\s+)?amazon\s*(?:,\s*|\s+)(?:(?:and then|and|then)\s+)?(?:find|search(?:\s+for)?|look\s+(?:for|up))\s+(.+)$/i;
const SITE_MIDDLE = /^search\s+(?:on\s+)?amazon\s+for\s+(.+)$/i;
const SITE_LAST = /^(?:find|search(?:\s+for)?|look\s+(?:for|up))\s+(.+?)\s+on\s+amazon$/i;
const SORT_VALUE = /^(?:the\s+)?(?:cheapest(?:\s+(?:first|ones?))?|(?:lowest|low)\s+prices?(?:\s+first)?|(?:price\s+)?low\s+to\s+high|(?:least\s+expensive|most\s+affordable)\s+first)$/i;
const SECOND_ACTION = /(?:\s+and(?:\s+then)?|\s+then|[,;])\s*(?:go|open|find|search|look|sort|order|add|buy|click|show|select|pick|purchase|pay|checkout|check out|send)\b/i;
const PRICE_ASC = 'price-asc-rank';

function command(text) {
  if (typeof text !== 'string' || text.length > 500 || /[\u0000-\u001f\u007f]/.test(text)) return '';
  return text.trim().replace(/^(?:hey\s+)?ava[\s,:]+/i, '')
    .replace(/^(?:please\s+)?(?:(?:could|can|would|will)\s+you\s+)?(?:please\s+)?/i, '')
    .replace(/[.!?]+$/, '').replace(/[,\s]+please$/i, '').trim();
}

function isAmazonCheapestSort(text) {
  const words = command(text).replace(/^(?:sort|order)(?:\s+(?:it|them|these|those|(?:the\s+)?(?:results|items)))?\s+(?:(?:by|from)\s+)?/i, '');
  return SORT_VALUE.test(words);
}

function splitSort(words) {
  const suffix = /(?:,\s*|\s+(?:and(?:\s+then)?|then)\s+|\s+)(sort(?:ed)?\s+.+)$/i.exec(words);
  if (!suffix || !isAmazonCheapestSort(suffix[1].replace(/^sorted\b/i, 'sort'))) return { words, sorted: false };
  return { words: words.slice(0, suffix.index).trim(), sorted: true };
}

function parseAmazonSearch(text) {
  const outer = splitSort(command(text));
  const match = SITE_FIRST.exec(outer.words) || SITE_MIDDLE.exec(outer.words) || SITE_LAST.exec(outer.words);
  if (!match) return null;
  const inner = splitSort(match[1]);
  const cheapest = /^(?:the\s+)?cheapest\s+/i;
  const query = inner.words.replace(cheapest, '').replace(/\s+/g, ' ').trim();
  if (!query || query.length > 240 || SECOND_ACTION.test(query) || /\bsort(?:ed)?\s+by\b/i.test(query)) return null;
  return { query, sortCheapest: outer.sorted || inner.sorted || cheapest.test(inner.words) };
}

function marketplaceUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port && MARKETPLACE.test(url.hostname) ? url : null;
}

function searchPage(value) {
  const url = marketplaceUrl(value);
  if (!url || !/^\/(?:[\w%-]+\/)?s(?:\/ref=[\w.-]+)?\/?$/.test(url.pathname) || url.searchParams.getAll('k').length !== 1 || !url.searchParams.get('k').trim()) return null;
  return url;
}

function amazonSearchUrl(query, { sortCheapest = false, observedUrl } = {}) {
  if (typeof query !== 'string' || !query.trim() || query.length > 240 || /[\u0000-\u001f\u007f]/.test(query)) return null;
  const url = new URL('/s', marketplaceUrl(observedUrl)?.origin || 'https://www.amazon.com');
  url.searchParams.set('k', query.trim());
  if (sortCheapest) url.searchParams.set('s', PRICE_ASC);
  return url.href;
}

function amazonSortedSearchUrl(observedUrl) {
  const url = searchPage(observedUrl);
  if (!url) return null;
  url.pathname = '/s';
  url.searchParams.set('s', PRICE_ASC);
  url.searchParams.delete('page');
  url.hash = '';
  return url.href;
}

function matchesAmazonSearch(observedUrl, query, { sortCheapest = false } = {}) {
  const url = searchPage(observedUrl);
  if (!url || typeof query !== 'string') return false;
  const normalize = value => value.trim().replace(/\s+/g, ' ').toLowerCase();
  return normalize(url.searchParams.get('k')) === normalize(query) &&
    (!sortCheapest || url.searchParams.getAll('s').length === 1 && url.searchParams.get('s') === PRICE_ASC);
}

module.exports = { parseAmazonSearch, isAmazonCheapestSort, amazonSearchUrl, amazonSortedSearchUrl, matchesAmazonSearch };
