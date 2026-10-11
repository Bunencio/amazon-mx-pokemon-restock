import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieJar, parseSetCookie } from '../src/amazon/cookieJar.js';

const URL_DP = 'https://www.amazon.com.mx/dp/B0H8SV3WJ8?th=1';

test('stores domain cookies from Set-Cookie and sends them back', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(URL_DP, [
    'session-id=147-9067890-4792752; Domain=.amazon.com.mx; Expires=Sun, 10-Oct-2027 23:19:49 GMT; Path=/; Secure',
    'i18n-prefs=MXN; Domain=.amazon.com.mx; Expires=Sun, 10-Oct-2027 23:19:49 GMT; Path=/',
    'sst-acbmx=Sst1|abc; Domain=.amazon.com.mx; Path=/; Secure; HttpOnly; SameSite=Lax',
  ]);
  assert.equal(jar.size, 3);
  const header = jar.headerFor('https://www.amazon.com.mx/s?k=pokemon');
  assert.match(header, /session-id=147-9067890-4792752/);
  assert.match(header, /i18n-prefs=MXN/);
  assert.match(header, /sst-acbmx=Sst1\|abc/);
});

test('secure cookies are not sent over http and other domains get nothing', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(URL_DP, ['a=1; Domain=.amazon.com.mx; Path=/; Secure']);
  assert.equal(jar.headerFor('http://www.amazon.com.mx/'), '');
  assert.equal(jar.headerFor('https://www.amazon.com/'), '');
  assert.equal(jar.headerFor('https://m.media-amazon.com/'), '');
});

test('host-only cookies, default path and path matching', () => {
  const jar = new CookieJar();
  jar.storeFromResponse('https://www.amazon.com.mx/gp/aw/d/B0X', ['h=1']);
  const c = jar.toJSON()[0];
  assert.equal(c.hostOnly, true);
  assert.equal(c.domain, 'www.amazon.com.mx');
  assert.equal(c.path, '/gp/aw/d');
  assert.equal(jar.headerFor('https://www.amazon.com.mx/gp/aw/d/B0Y'), 'h=1');
  assert.equal(jar.headerFor('https://www.amazon.com.mx/gp/awesome'), '');
  assert.equal(jar.headerFor('https://amazon.com.mx/gp/aw/d/B0Y'), '');
});

test('Max-Age wins over Expires, expired cookies are dropped and replace existing', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(URL_DP, ['x=1; Domain=.amazon.com.mx; Path=/']);
  assert.equal(jar.size, 1);
  jar.storeFromResponse(URL_DP, ['x=gone; Domain=.amazon.com.mx; Path=/; Max-Age=0; Expires=Sun, 10-Oct-2027 23:19:49 GMT']);
  assert.equal(jar.size, 0);
});

test('rejects cookies for unrelated domains', () => {
  assert.equal(parseSetCookie('evil=1; Domain=evil.com', new URL(URL_DP)), null);
  assert.equal(parseSetCookie('', new URL(URL_DP)), null);
  assert.equal(parseSetCookie('=novalue', new URL(URL_DP)), null);
});

test('round-trips through JSON', () => {
  const jar = new CookieJar();
  jar.storeFromResponse(URL_DP, ['session-id=1; Domain=.amazon.com.mx; Path=/', 'ubid-acbmx=2; Domain=.amazon.com.mx; Path=/']);
  const copy = CookieJar.fromJSON(JSON.parse(JSON.stringify(jar.toJSON())));
  assert.equal(copy.headerFor(URL_DP), jar.headerFor(URL_DP));
});
