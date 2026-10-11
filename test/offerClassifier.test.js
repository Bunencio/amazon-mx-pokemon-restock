import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOffer, STATUS } from '../src/amazon/offerClassifier.js';
import { parseDetailPage } from '../src/amazon/dpParser.js';
import { buildDpHtml } from './helpers/html.js';
import { hasFixture, loadFixture } from './helpers/fixtures.js';

const AMZ = 'AVDBXBAVVSXLQ';

function parsedWith(overrides) {
  return {
    asin: 'B0TEST0001',
    merchantId: AMZ,
    merchantName: 'Amazon México',
    merchantHasSellerLink: false,
    fulfiller: 'Amazon',
    availabilityText: 'Disponible',
    addToCart: true,
    buyNow: true,
    buttonLabels: ['Agregar al carrito', 'Comprar ahora'],
    preorderButton: false,
    offerCount: null,
    seeAllBuyingChoices: false,
    ...overrides,
  };
}

const CASES = [
  ['Amazon + Disponible → in stock (high)', {}, STATUS.AMAZON_IN_STOCK, 'high'],
  ['Amazon + scarcity text → in stock', { availabilityText: 'Sólo queda(n) 2 en stock.' }, STATUS.AMAZON_IN_STOCK, 'high'],
  ['Amazon + buttons but no availability text → in stock (low)', { availabilityText: null }, STATUS.AMAZON_IN_STOCK, 'low'],
  ['Amazon + No disponible → out of stock', { availabilityText: 'No disponible por el momento.', addToCart: false, buyNow: false }, STATUS.OUT_OF_STOCK, 'high'],
  ['Amazon + OOS text but stale button → out of stock', { availabilityText: 'No disponible por el momento.' }, STATUS.OUT_OF_STOCK, 'high'],
  ['Amazon + no buttons → out of stock (medium)', { availabilityText: null, addToCart: false, buyNow: false }, STATUS.OUT_OF_STOCK, 'medium'],
  ['Amazon + pre-order text + button → preorder (high)', { availabilityText: 'Este artículo se lanzará el 6 de noviembre de 2026.', preorderButton: true, buttonLabels: ['Pre-ordenar'] }, STATUS.AMAZON_PREORDER, 'high'],
  ['Amazon + pre-order button only → preorder (medium)', { availabilityText: null, preorderButton: true }, STATUS.AMAZON_PREORDER, 'medium'],
  ['Amazon + pre-order text only → preorder (medium)', { availabilityText: 'Este artículo se lanzará el 6 de noviembre de 2026.' }, STATUS.AMAZON_PREORDER, 'medium'],
  ['FBA reseller (fulfiller Amazon) → third party, never Amazon', { merchantId: 'A3IWELYEROHRHA', merchantName: 'Tienda XYZ', merchantHasSellerLink: true, availabilityText: 'Sólo queda(n) 10 en stock.' }, STATUS.THIRD_PARTY_ONLY, 'high'],
  ['third party without buttons → third party (low)', { merchantId: 'A3IWELYEROHRHA', merchantName: 'X', merchantHasSellerLink: true, addToCart: false, buyNow: false, availabilityText: null }, STATUS.THIRD_PARTY_ONLY, 'low'],
  ['no buybox, see all choices with offers → third party (low)', { merchantId: null, merchantName: null, addToCart: false, buyNow: false, availabilityText: null, seeAllBuyingChoices: true, offerCount: 2 }, STATUS.THIRD_PARTY_ONLY, 'low'],
  ['no buybox, OOS → out of stock', { merchantId: null, merchantName: null, addToCart: false, buyNow: false, availabilityText: 'No disponible por el momento.' }, STATUS.OUT_OF_STOCK, 'high'],
  ['unqualified buybox (listing without any buyable offer) → out of stock (high)', { merchantId: null, merchantName: null, addToCart: false, buyNow: false, availabilityText: null, unqualifiedBuyBox: true, seeAllBuyingChoices: true }, STATUS.OUT_OF_STOCK, 'high'],
  ['unqualified buybox but other offers exist → third party (low)', { merchantId: null, merchantName: null, addToCart: false, buyNow: false, availabilityText: null, unqualifiedBuyBox: true, offerCount: 4 }, STATUS.THIRD_PARTY_ONLY, 'low'],
  ['Amazon by name without link (no merchantID) → in stock (medium)', { merchantId: null }, STATUS.AMAZON_IN_STOCK, 'medium'],
  ['"Amazon" name WITH seller link is not trusted → ambiguous-ish (not Amazon)', { merchantId: null, merchantName: 'Amazon', merchantHasSellerLink: true }, STATUS.AMBIGUOUS, 'low'],
];

for (const [name, overrides, status, confidence] of CASES) {
  test(name, () => {
    const r = classifyOffer(parsedWith(overrides));
    assert.equal(r.status, status, r.reasons.join(' | '));
    assert.equal(r.confidence, confidence, r.reasons.join(' | '));
  });
}

test('end to end: synthetic Amazon page → in stock; synthetic 3P page → third party', () => {
  const amazon = classifyOffer(parseDetailPage(buildDpHtml()));
  assert.equal(amazon.status, STATUS.AMAZON_IN_STOCK);
  const third = classifyOffer(parseDetailPage(buildDpHtml({ merchantId: 'A3IWELYEROHRHA', merchantName: 'Tienda', sellerLink: true, availability: 'Sólo queda(n) 10 en stock.' })));
  assert.equal(third.status, STATUS.THIRD_PARTY_ONLY);
  assert.equal(third.flags.amazonSeller, false);
});

test('real fixture: 3P FBA page classifies as third_party_only', { skip: !hasFixture('dp-3p-fba-B0H8SV3WJ8') }, () => {
  const r = classifyOffer(parseDetailPage(loadFixture('dp-3p-fba-B0H8SV3WJ8')));
  assert.equal(r.status, STATUS.THIRD_PARTY_ONLY);
});

test('real fixture: Amazon in-stock page classifies as amazon_in_stock', { skip: !hasFixture('dp-amazon-in-stock') }, () => {
  const r = classifyOffer(parseDetailPage(loadFixture('dp-amazon-in-stock')));
  assert.equal(r.status, STATUS.AMAZON_IN_STOCK);
});

test('real fixture: listing without offers (unqualified buybox) → out_of_stock (high)', { skip: !hasFixture('dp-no-offers-B0H7818YHY') }, () => {
  const parsed = parseDetailPage(loadFixture('dp-no-offers-B0H7818YHY'));
  assert.equal(parsed.asin, 'B0H7818YHY');
  assert.equal(parsed.merchantId, null);
  assert.equal(parsed.unqualifiedBuyBox, true);
  assert.equal(parsed.seeAllBuyingChoices, true);
  assert.equal(parsed.addToCart, false);
  const r = classifyOffer(parsed);
  assert.equal(r.status, STATUS.OUT_OF_STOCK, r.reasons.join(' | '));
  assert.equal(r.confidence, 'high');
});
