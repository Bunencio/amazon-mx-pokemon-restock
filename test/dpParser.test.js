import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDetailPage, parsePrice, parseTwister } from '../src/amazon/dpParser.js';
import { buildDpHtml } from './helpers/html.js';
import { hasFixture, loadFixture } from './helpers/fixtures.js';

test('parses an Amazon México buybox', () => {
  const p = parseDetailPage(buildDpHtml());
  assert.equal(p.asin, 'B0TEST0001');
  assert.equal(p.title, 'Pokémon TCG: 30th Celebration Elite Trainer Box');
  assert.equal(p.merchantId, 'AVDBXBAVVSXLQ');
  assert.equal(p.merchantName, 'Amazon México');
  assert.equal(p.merchantHasSellerLink, false);
  assert.equal(p.fulfiller, 'Amazon');
  assert.equal(p.availabilityText, 'Disponible');
  assert.equal(p.addToCart, true);
  assert.equal(p.buyNow, true);
  assert.deepEqual(p.buttonLabels, ['Agregar al carrito', 'Comprar ahora']);
  assert.equal(p.priceText, '$1,099.00');
  assert.equal(p.priceAmount, 1099);
  assert.equal(p.image, 'https://m.media-amazon.com/images/I/test-hires.jpg');
  assert.equal(p.isFdp, false);
});

test('parses a third-party seller with profile link and scarcity text', () => {
  const p = parseDetailPage(
    buildDpHtml({ merchantId: 'A3IWELYEROHRHA', merchantName: 'Tienda XYZ', sellerLink: true, availability: 'Sólo queda(n) 10 en stock.', olp: 'Nuevo (3) desde $1,099.00' }),
  );
  assert.equal(p.merchantId, 'A3IWELYEROHRHA');
  assert.equal(p.merchantName, 'Tienda XYZ');
  assert.equal(p.merchantHasSellerLink, true);
  assert.equal(p.availabilityText, 'Sólo queda(n) 10 en stock.');
  assert.equal(p.offerCount, 3);
});

test('falls back to the seller link when input#merchantID is missing', () => {
  const html = buildDpHtml({ merchantId: null, merchantName: 'Top Cards', sellerLink: true }).replace(
    "seller=null",
    'seller=A2A993G0CTMUA',
  );
  const p = parseDetailPage(html);
  assert.equal(p.merchantId, 'A2A993G0CTMUA');
});

test('detects disabled add-to-cart and pre-order labels', () => {
  const p = parseDetailPage(
    buildDpHtml({ availability: 'Este artículo se lanzará el 6 de noviembre de 2026.', addToCartLabel: 'Pre-ordenar', buyNowLabel: 'Pre-ordena ahora' }),
  );
  assert.equal(p.preorderButton, true);
  const disabled = parseDetailPage(buildDpHtml({ addToCartDisabled: true, buyNow: false }));
  assert.equal(disabled.addToCart, false);
  assert.equal(disabled.buyNow, false);
});

test('release date from detail bullets and twister children', () => {
  const p = parseDetailPage(buildDpHtml({ releaseBullet: '6 noviembre 2026', twister: { B0CHILD001: ['Lata A'], B0CHILD002: ['Lata B'] } }));
  assert.equal(p.releaseDateText, '6 noviembre 2026');
  assert.deepEqual(p.twister.childAsins, ['B0CHILD001', 'B0CHILD002']);
  assert.equal(p.twister.parentAsin, 'B0PARENT01');
  assert.equal(p.twister.labels.B0CHILD001, 'Lata A');
});

test('parsePrice handles MX and EU formats', () => {
  assert.equal(parsePrice('$1,099.00'), 1099);
  assert.equal(parsePrice('$589.00'), 589);
  assert.equal(parsePrice('1.099,00'), 1099);
  assert.equal(parsePrice('MXN 3,689'), 3689);
  assert.equal(parsePrice(''), null);
  assert.equal(parsePrice(null), null);
});

test('parseTwister ignores malformed JSON', () => {
  assert.deepEqual(parseTwister('"dimensionValuesDisplayData" : {bad json}'), { childAsins: [], parentAsin: null, labels: {} });
});

test('offer count parses both widget variants', () => {
  const a = parseDetailPage(buildDpHtml({ olp: 'Nuevo (3) desde $1,099.00' }));
  assert.equal(a.offerCount, 3);
  const b = parseDetailPage(buildDpHtml({ olp: '<style>.x{}</style><script>var y=1;</script>Otros vendedores en Amazon Comparar otras 19 opciones a partir de $2,799.00' }));
  assert.equal(b.offerCount, 19);
  assert.doesNotMatch(b.olpText, /var y=1|\.x\{\}/);
});

test('real fixture: 3P FBA reseller page (B0H8SV3WJ8)', { skip: !hasFixture('dp-3p-fba-B0H8SV3WJ8') }, () => {
  const p = parseDetailPage(loadFixture('dp-3p-fba-B0H8SV3WJ8'));
  assert.equal(p.asin, 'B0H8SV3WJ8');
  assert.match(p.title, /30th Celebration/);
  assert.notEqual(p.merchantId, 'AVDBXBAVVSXLQ');
  assert.equal(p.merchantHasSellerLink, true);
  assert.equal(p.fulfiller, 'Amazon');
  assert.match(p.availabilityText, /queda|Disponible|disponible/);
  assert.ok(p.priceAmount > 0);
  assert.ok(p.offerCount > 1, `offerCount=${p.offerCount} olp=${p.olpText}`);
  assert.match(p.image, /^https:\/\/m\.media-amazon\.com\//);
});

test('real fixture: Amazon México in stock', { skip: !hasFixture('dp-amazon-in-stock') }, () => {
  const p = parseDetailPage(loadFixture('dp-amazon-in-stock'));
  assert.equal(p.merchantId, 'AVDBXBAVVSXLQ');
  assert.equal(p.merchantName, 'Amazon México');
  assert.equal(p.addToCart, true);
  assert.ok(p.priceAmount > 0);
});
