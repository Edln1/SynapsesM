'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAmazonSearch, isAmazonCheapestSort, amazonSearchUrl, amazonSortedSearchUrl, matchesAmazonSearch } = require('../src/amazon-shopping.cjs');

test('spoken Amazon product searches keep the requested product and the requested sort', () => {
  for (const text of [
    'Go to Amazon and find 32GB RAM',
    'Open Amazon, then look for 32GB RAM',
    'Hey Ava, could you search Amazon for 32GB RAM?',
    'look up 32GB RAM on Amazon please.',
  ]) assert.deepEqual(parseAmazonSearch(text), { query: '32GB RAM', sortCheapest: false }, text);
  for (const text of [
    'Go to Amazon and find 32GB RAM and sort by cheapest',
    'find 32GB RAM on Amazon, sort the results by price low to high',
    'search for 32GB RAM sorted by cheapest on Amazon',
    'find the cheapest 32GB RAM on Amazon',
  ]) assert.deepEqual(parseAmazonSearch(text), { query: '32GB RAM', sortCheapest: true }, text);
  assert.deepEqual(parseAmazonSearch('find salt and pepper on Amazon'), { query: 'salt and pepper', sortCheapest: false });
});

test('a sort instruction is distinct from a bare answer or an unrelated request', () => {
  for (const text of ['sort by cheapest', 'sort them from low to high', 'lowest price first', 'cheapest first', 'least expensive first']) assert.equal(isAmazonCheapestSort(text), true, text);
  for (const text of ['yes', 'no', 'yes buy it', 'highest price', 'most expensive first', 'least affordable first', 'sort oldest first', 'cheapest laptop']) assert.equal(isAmazonCheapestSort(text), false, text);
  for (const text of ['find 32GB RAM', 'open Amazon', 'buy RAM on Amazon', 'find RAM on Amazon and buy it', 'go to Amazon and find RAM and then add it to my cart', 'search Amazon for RAM sorted by rating', 'find RAM on Amazon.example.com']) assert.equal(parseAmazonSearch(text), null, text);
});

test('sorting preserves regional marketplace, exact search, and filters, resetting pagination', () => {
  const source = 'https://www.amazon.ca/USB-HDD/s/ref=sr_pg_2?k=32GB+RAM&rh=p_89%3ACrucial&page=2&s=review-rank#results';
  const sorted = new URL(amazonSortedSearchUrl(source));
  assert.equal(sorted.origin, 'https://www.amazon.ca');
  assert.equal(sorted.pathname, '/s');
  assert.equal(sorted.searchParams.get('k'), '32GB RAM');
  assert.equal(sorted.searchParams.get('rh'), 'p_89:Crucial');
  assert.equal(sorted.searchParams.has('page'), false);
  assert.equal(sorted.hash, '');
  assert.deepEqual(sorted.searchParams.getAll('s'), ['price-asc-rank']);
  assert.equal(matchesAmazonSearch(source, '32gb ram', { sortCheapest: true }), false);
  assert.equal(matchesAmazonSearch(sorted.href, '32gb ram', { sortCheapest: true }), true);
  assert.equal(matchesAmazonSearch(sorted.href, '16GB RAM'), false);
  const direct = amazonSearchUrl('USB-C & RAM + hub', { sortCheapest: true, observedUrl: 'https://www.amazon.co.uk/dp/example' });
  assert.equal(new URL(direct).origin, 'https://www.amazon.co.uk');
  assert.equal(matchesAmazonSearch(direct, 'USB-C & RAM + hub', { sortCheapest: true }), true);
});

test('non-search pages and non-marketplace URLs cannot become a verified Amazon sort', () => {
  const invalid = [
    'https://www.amazon.ca/dp/123?k=RAM', 'https://www.amazon.com/s?k=', 'https://www.amazon.com/s?k=one&k=two',
    'https://www.amazon.ca.example.org/s?k=RAM', 'https://user@www.amazon.com/s?k=RAM',
    'http://www.amazon.com/s?k=RAM', 'https://www.amazon.com:444/s?k=RAM', 'https://www.amazon.com/gp/redirect.html?k=RAM',
    'https://sellercentral.amazon.com/s?k=RAM', null, '',
  ];
  for (const value of invalid) {
    assert.equal(amazonSortedSearchUrl(value), null);
    assert.equal(matchesAmazonSearch(value, 'RAM'), false);
  }
  assert.equal(amazonSearchUrl(''), null);
  assert.equal(amazonSearchUrl('RAM'), 'https://www.amazon.com/s?k=RAM');
});
