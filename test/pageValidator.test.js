import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePage, isDegraded, isHardBlock, MIN_BYTES } from '../src/amazon/pageValidator.js';
import { buildDpHtml, buildSearchHtml } from './helpers/html.js';
import { hasFixture, loadFixture } from './helpers/fixtures.js';

test('a real-looking product page is ok', () => {
  const html = buildDpHtml({ padTo: MIN_BYTES.dp + 1000 });
  const v = validatePage({ type: 'dp', status: 200, html, finalUrl: 'https://www.amazon.com.mx/dp/B0TEST00001' });
  assert.equal(v.kind, 'ok');
  assert.equal(isDegraded(v), false);
});

test('fallback detail page is degraded (soft), never ok', () => {
  const html = buildDpHtml({ fdp: true, padTo: MIN_BYTES.dp + 1000 });
  const v = validatePage({ type: 'dp', status: 200, html });
  assert.equal(v.kind, 'fdp');
  assert.equal(v.severity, 'soft');
  assert.equal(isDegraded(v), true);
  assert.equal(isHardBlock(v), false);
});

test('tiny body is degraded', () => {
  const v = validatePage({ type: 'search', status: 200, html: '<html><body>hola</body></html>' });
  assert.equal(v.kind, 'tiny');
  assert.equal(isDegraded(v), true);
});

test('captcha wall is a hard block', () => {
  const html = `<html><body><form method="get" action="/errors/validateCaptcha"><input id="captchacharacters"></form></body></html>`;
  const v = validatePage({ type: 'dp', status: 200, html });
  assert.equal(v.kind, 'captcha');
  assert.equal(isHardBlock(v), true);
});

test('redirect to captcha counts as hard block', () => {
  const v = validatePage({ type: 'dp', status: 200, html: 'x'.repeat(200_000), finalUrl: 'https://www.amazon.com.mx/errors/validateCaptcha?x=1' });
  assert.equal(v.kind, 'captcha');
});

test('503 is a hard block; 404 is notfound; network error is network', () => {
  assert.equal(validatePage({ type: 'dp', status: 503, html: '' }).severity, 'hard');
  assert.equal(validatePage({ type: 'dp', status: 404, html: '' }).kind, 'notfound');
  const n = validatePage({ type: 'dp', status: 0, html: '', error: 'timeout after 20000 ms' });
  assert.equal(n.kind, 'network_error');
  assert.equal(n.severity, 'network');
});

test('search page with the main slot is ok', () => {
  const html = buildSearchHtml([{ asin: 'B0H8SV3WJ8', title: 'Pokémon TCG: 30th Celebration Elite Trainer Box', price: '$1,099.00' }]).replace(
    '</body>',
    `<!-- ${' '.repeat(MIN_BYTES.search)} --></body>`,
  );
  const v = validatePage({ type: 'search', status: 200, html });
  assert.equal(v.kind, 'ok');
});

test('big page without the dp container is degraded', () => {
  const v = validatePage({ type: 'dp', status: 200, html: `<html><body>${'x'.repeat(MIN_BYTES.dp + 10)}</body></html>` });
  assert.equal(v.kind, 'tiny');
});

test('Akamai interstitial (bm-verify) is a soft challenge, never ok', () => {
  const html = `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="5; URL='/s?k=x&bm-verify=AAQAAAAO'" /></head><body><script>function triggerInterstitialChallenge(){}</script></body></html>`;
  const v = validatePage({ type: 'search', status: 200, html });
  assert.equal(v.kind, 'challenge');
  assert.equal(v.severity, 'soft');
  assert.equal(isDegraded(v), true);
});

test('real fixture: Amazon robot-check page → captcha (hard)', { skip: !hasFixture('blocked-captcha-dp') }, () => {
  const v = validatePage({ type: 'dp', status: 200, html: loadFixture('blocked-captcha-dp') });
  assert.equal(v.kind, 'captcha');
  assert.equal(isHardBlock(v), true);
});

test('real fixture: Akamai interstitial on search → challenge (degraded)', { skip: !hasFixture('blocked-soft-search') }, () => {
  const v = validatePage({ type: 'search', status: 200, html: loadFixture('blocked-soft-search') });
  assert.equal(v.kind, 'challenge');
  assert.equal(isDegraded(v), true);
  assert.equal(isHardBlock(v), false);
});
