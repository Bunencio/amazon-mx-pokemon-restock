import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSearchResults } from '../src/amazon/searchParser.js';
import { buildSearchHtml } from './helpers/html.js';
import { hasFixture, loadFixture } from './helpers/fixtures.js';

test('parses cards, prices, availability and sponsored flag', () => {
  const html = buildSearchHtml([
    { asin: 'B0H8SV3WJ8', title: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: '$1,099.00' },
    { asin: 'B0GR6N18F6', title: 'Pokémon TCG: Mega Evolution—Chaos Rising Elite Trainer Box', price: '$1,099.00', unavailable: true },
    { asin: 'B0SPONSR01', title: 'Funko Pop Pokémon', price: '$299.00', sponsored: true },
    { asin: 'B0H8SV3WJ8', title: 'duplicado', price: '$1.00' },
  ]);
  const r = parseSearchResults(html);
  assert.equal(r.hasMainSlot, true);
  assert.equal(r.noResults, false);
  assert.equal(r.cards.length, 3);
  assert.equal(r.organic.length, 2);
  const etb = r.cards.find((c) => c.asin === 'B0H8SV3WJ8');
  assert.equal(etb.title, 'Pokémon TCG: 30th Celebration Elite Trainer Box');
  assert.equal(etb.priceAmount, 1099);
  assert.equal(etb.unavailable, false);
  assert.equal(etb.sponsored, false);
  assert.match(etb.url, /^https:\/\/www\.amazon\.com\.mx\/.*\/dp\/B0H8SV3WJ8/);
  assert.equal(r.cards.find((c) => c.asin === 'B0GR6N18F6').unavailable, true);
  assert.equal(r.cards.find((c) => c.asin === 'B0SPONSR01').sponsored, true);
});

test('no-results page', () => {
  const r = parseSearchResults(buildSearchHtml([], { noResults: true }));
  assert.equal(r.cards.length, 0);
  assert.equal(r.noResults, true);
});

test('real fixture: filtered search lists Amazon México offers', { skip: !hasFixture('search-filtered') }, () => {
  const r = parseSearchResults(loadFixture('search-filtered'));
  assert.ok(r.hasMainSlot);
  assert.ok(r.organic.length > 10, `only ${r.organic.length} organic cards`);
  for (const c of r.organic) {
    assert.match(c.asin, /^[A-Z0-9]{10}$/);
    assert.ok(c.title, `card ${c.asin} without title`);
  }
});
