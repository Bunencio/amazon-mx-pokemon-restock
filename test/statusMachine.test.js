import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyObservation, createItemState, decideAlert, revertTransition, EVENT, alertKey } from '../src/core/statusMachine.js';
import { STATUS } from '../src/amazon/offerClassifier.js';

const T0 = '2026-10-10T12:00:00.000Z';
const ok = (status, extra = {}) => ({ kind: 'ok', at: T0, by: 'pc', method: 'playwright', classification: { status, confidence: 'high' }, ...extra });

test('first observation: out_of_stock does not alert, in_stock does (policy on)', () => {
  const item = createItemState('B0TEST0001', { label: 'ETB', priority: 1 });
  const t1 = applyObservation(item, ok(STATUS.OUT_OF_STOCK));
  assert.equal(t1.changed, true);
  assert.equal(t1.event, null);
  assert.equal(item.episode, 0);

  const item2 = createItemState('B0TEST0002');
  const t2 = applyObservation(item2, ok(STATUS.AMAZON_IN_STOCK));
  assert.equal(t2.event, EVENT.IN_STOCK);
  assert.equal(t2.firstObservation, true);
  assert.equal(item2.episode, 1);
  const on = decideAlert(item2, t2, { alertOnFirstObservation: true });
  assert.equal(on.alert, true);
  assert.equal(on.key, 'B0TEST0002:IN_STOCK:1');
  const off = decideAlert(item2, t2, { alertOnFirstObservation: false });
  assert.equal(off.alert, false);
});

test('restock episodes alert again after an out-of-stock interval; same episode never repeats', () => {
  const item = createItemState('B0TEST0001');
  applyObservation(item, ok(STATUS.OUT_OF_STOCK));
  const sent = new Set();
  const now = new Date('2026-10-10T13:00:00Z');

  const up1 = applyObservation(item, ok(STATUS.AMAZON_IN_STOCK, { at: '2026-10-10T12:10:00Z' }));
  const d1 = decideAlert(item, up1, { now, sentKeys: sent });
  assert.equal(d1.alert, true);
  sent.add(d1.key);
  item.lastAlertAt = '2026-10-10T12:10:00Z';

  // Still in stock: no transition, nothing to alert.
  const same = applyObservation(item, ok(STATUS.AMAZON_IN_STOCK, { at: '2026-10-10T12:20:00Z' }));
  assert.equal(same.changed, false);
  assert.equal(decideAlert(item, same, { now, sentKeys: sent }).alert, false);

  // Sold out, then back: new episode, new key.
  const down = applyObservation(item, ok(STATUS.THIRD_PARTY_ONLY, { at: '2026-10-10T12:30:00Z' }));
  assert.equal(down.event, null);
  assert.equal(item.episodeEndedAt, '2026-10-10T12:30:00Z');
  const up2 = applyObservation(item, ok(STATUS.AMAZON_IN_STOCK, { at: '2026-10-10T12:50:00Z' }));
  assert.equal(item.episode, 2);
  const d2 = decideAlert(item, up2, { now: new Date('2026-10-10T12:50:00Z'), sentKeys: sent, cooldownMin: 30 });
  assert.equal(d2.alert, true, d2.reason);
  assert.equal(d2.key, alertKey('B0TEST0001', EVENT.IN_STOCK, 2));
});

test('cooldown suppresses flapping and counts it', () => {
  const item = createItemState('B0TEST0001');
  applyObservation(item, ok(STATUS.OUT_OF_STOCK, { at: '2026-10-10T12:00:00Z' }));
  const up = applyObservation(item, ok(STATUS.AMAZON_IN_STOCK, { at: '2026-10-10T12:10:00Z' }));
  item.lastAlertAt = '2026-10-10T12:00:00Z';
  const d = decideAlert(item, up, { now: new Date('2026-10-10T12:10:00Z'), cooldownMin: 30 });
  assert.equal(d.alert, false);
  assert.match(d.reason, /cooldown/);
  assert.equal(item.suppressedFlaps, 1);
});

test('preorder → in_stock is a new IN_STOCK event; in_stock → preorder is not an event', () => {
  const item = createItemState('B0TEST0001');
  const pre = applyObservation(item, ok(STATUS.AMAZON_PREORDER));
  assert.equal(pre.event, EVENT.PREORDER);
  assert.equal(item.episode, 1);
  const live = applyObservation(item, ok(STATUS.AMAZON_IN_STOCK));
  assert.equal(live.event, EVENT.IN_STOCK);
  assert.equal(item.episode, 2);
  const odd = applyObservation(item, ok(STATUS.AMAZON_PREORDER));
  assert.equal(odd.changed, true);
  assert.equal(odd.event, null);
  assert.equal(item.episode, 2);
});

test('degraded / blocked / ambiguous observations never change status', () => {
  const item = createItemState('B0TEST0001');
  applyObservation(item, ok(STATUS.AMAZON_IN_STOCK));
  for (const kind of ['degraded', 'blocked', 'ambiguous']) {
    const t = applyObservation(item, { kind, at: T0, by: 'pc' });
    assert.equal(t.changed, false, kind);
    assert.equal(item.status, STATUS.AMAZON_IN_STOCK);
  }
  assert.equal(item.consecutiveDegraded, 2);
  const amb = applyObservation(item, ok(STATUS.AMBIGUOUS));
  assert.equal(amb.changed, false);
  assert.equal(item.lastObservation.kind, 'ambiguous');
  // an ok page resets the degraded counter
  applyObservation(item, ok(STATUS.AMAZON_IN_STOCK));
  assert.equal(item.consecutiveDegraded, 0);
});

test('three not-found observations delist; an ok page revives', () => {
  const item = createItemState('B0TEST0001');
  applyObservation(item, ok(STATUS.THIRD_PARTY_ONLY));
  for (let i = 0; i < 2; i += 1) assert.equal(applyObservation(item, { kind: 'notfound', at: T0 }).changed, false);
  const t = applyObservation(item, { kind: 'notfound', at: T0 });
  assert.equal(t.changed, true);
  assert.equal(item.status, STATUS.DELISTED);
  applyObservation(item, ok(STATUS.AMAZON_IN_STOCK));
  assert.equal(item.status, STATUS.AMAZON_IN_STOCK);
  assert.equal(item.consecutiveNotFound, 0);
});

test('facts are updated from the parsed page and a failed confirmation reverts', () => {
  const item = createItemState('B0TEST0001');
  applyObservation(item, ok(STATUS.OUT_OF_STOCK));
  const parsed = { title: 'ETB', image: 'https://img', priceAmount: 1099, priceText: '$1,099.00', currency: 'MXN', availabilityText: 'Disponible', merchantId: 'AVDBXBAVVSXLQ', merchantName: 'Amazon México', fulfiller: 'Amazon' };
  const up = applyObservation(item, ok(STATUS.AMAZON_IN_STOCK, { parsed }));
  assert.equal(item.title, 'ETB');
  assert.equal(item.price.amount, 1099);
  assert.equal(item.merchantId, 'AVDBXBAVVSXLQ');
  assert.equal(item.episode, 1);
  revertTransition(item, up);
  assert.equal(item.status, STATUS.OUT_OF_STOCK);
  assert.equal(item.episode, 0);
  assert.equal(item.lastObservation.kind, 'ambiguous');
});
