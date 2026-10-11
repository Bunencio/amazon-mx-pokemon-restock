import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildPlan, describeStep, storePageIds } from '../src/core/planner.js';

const config = {
  timezone: 'America/Mexico_City',
  tasks: { discoveryIntervalMin: 60, storeSweepEnabled: true, storeSweepIntervalMin: 1440, storeSweepHours: '00-24' },
};
const watchlist = {
  queries: { filtered: ['q1', 'q2'], discovery: ['d1', 'd2'] },
  store: { mainPageId: 'MAIN', subPageIds: ['SUB1', 'SUB2'] },
};
const items = [
  { asin: 'B0P1000001', priority: 1, active: true },
  { asin: 'B0P1000002', priority: 1, active: true },
  { asin: 'B0P2000001', priority: 2, active: true },
  { asin: 'B0P2000002', priority: 2, active: true },
  { asin: 'B0P2000003', priority: 3, active: true },
  { asin: 'B0P2000004', priority: 2, active: false },
];
const fresh = (now) => ({ discoverySearch: { lastAt: now.toISOString() }, storeSweep: { lastAt: now.toISOString() } });
const now = new Date('2026-10-10T18:00:00Z');
const base = { items, watchlist, config, merchantId: 'AVDBXBAVVSXLQ', now };

test('budget is never exceeded, P1 items are always present, one request stays in reserve', () => {
  const plan = buildPlan({ ...base, tasks: fresh(now), budget: 6, cursor: 0, parity: 0 });
  assert.equal(plan.reserve, 1);
  assert.ok(plan.steps.length <= 5, `steps=${plan.steps.length}`);
  const dps = plan.steps.filter((s) => s.type === 'dp').map((s) => s.asin);
  assert.ok(dps.includes('B0P1000001') && dps.includes('B0P1000002'));
  assert.equal(plan.steps.filter((s) => s.type === 'search' && s.filtered).length, 1);
  assert.ok(!dps.includes('B0P2000004'), 'inactive items are skipped');
  for (const s of plan.steps) assert.match(s.url, /^https:\/\/www\.amazon\.com\.mx\//);
});

test('round-robin cursor advances and wraps; filtered query parity alternates', () => {
  const p1 = buildPlan({ ...base, tasks: fresh(now), budget: 5, cursor: 0, parity: 0 }); // 1 search + 2 P1 + 1 rr
  const rr1 = p1.steps.filter((s) => s.type === 'dp' && s.priority >= 2).map((s) => s.asin);
  assert.deepEqual(rr1, ['B0P2000001']);
  assert.equal(p1.cursor, 1);
  assert.equal(p1.parity, 1);
  assert.equal(p1.steps.find((s) => s.filtered).query, 'q1');

  const p2 = buildPlan({ ...base, tasks: fresh(now), budget: 5, cursor: p1.cursor, parity: p1.parity });
  assert.deepEqual(p2.steps.filter((s) => s.type === 'dp' && s.priority >= 2).map((s) => s.asin), ['B0P2000002']);
  assert.equal(p2.steps.find((s) => s.filtered).query, 'q2');
  assert.equal(p2.parity, 0);

  const p3 = buildPlan({ ...base, tasks: fresh(now), budget: 5, cursor: 2, parity: 0 });
  assert.deepEqual(p3.steps.filter((s) => s.type === 'dp' && s.priority >= 2).map((s) => s.asin), ['B0P2000003']);
  assert.equal(p3.cursor, 0, 'wraps around');
});

test('discovery searches are added when due and take precedence over the store sweep', () => {
  const plan = buildPlan({ ...base, tasks: { discoverySearch: { lastAt: null }, storeSweep: { lastAt: null } }, budget: 8 });
  assert.equal(plan.periodic, 'discovery');
  assert.deepEqual(plan.steps.filter((s) => s.purpose === 'discovery').map((s) => s.query).sort(), ['d1', 'd2']);
  assert.equal(plan.steps.filter((s) => s.type === 'store').length, 0);
  assert.ok(plan.steps.length <= 7);
});

test('store sweep runs when due (discovery fresh), sub-pages first, no round-robin that run', () => {
  const plan = buildPlan({ ...base, tasks: { discoverySearch: { lastAt: now.toISOString() }, storeSweep: { lastAt: null } }, budget: 8 });
  assert.equal(plan.periodic, 'store');
  const store = plan.steps.filter((s) => s.type === 'store').map((s) => s.pageId);
  assert.deepEqual(store, ['SUB1', 'SUB2', 'MAIN']);
  assert.equal(plan.steps.filter((s) => s.type === 'dp' && s.priority >= 2).length, 0);
  assert.deepEqual(plan.steps.slice(-3).map((s) => s.type), ['store', 'store', 'store'], 'store pages stay last');
});

test('store sweep respects its hour window and the enabled flag', () => {
  const night = { ...config, tasks: { ...config.tasks, storeSweepHours: '09-22' } };
  const at3am = new Date('2026-10-10T09:00:00Z'); // 03:00 CDMX
  const p = buildPlan({ ...base, config: night, now: at3am, tasks: { discoverySearch: { lastAt: at3am.toISOString() }, storeSweep: { lastAt: null } }, budget: 8 });
  assert.equal(p.periodic, null);
  const disabled = { ...config, tasks: { ...config.tasks, storeSweepEnabled: false } };
  const p2 = buildPlan({ ...base, config: disabled, tasks: { discoverySearch: { lastAt: now.toISOString() }, storeSweep: { lastAt: null } }, budget: 8 });
  assert.equal(p2.periodic, null);
});

test('ONLY_ASIN produces a single dp step', () => {
  const plan = buildPlan({ ...base, tasks: fresh(now), budget: 8, onlyAsin: 'B0H8SV3WJ8' });
  assert.equal(plan.steps.length, 1);
  assert.equal(describeStep(plan.steps[0]), 'dp:B0H8SV3WJ8');
  assert.match(plan.steps[0].url, /smid=AVDBXBAVVSXLQ/);
});

test('tiny budgets still fetch at least one page', () => {
  const plan = buildPlan({ ...base, tasks: fresh(now), budget: 1 });
  assert.equal(plan.reserve, 0);
  assert.equal(plan.steps.length, 1);
});

test('storePageIds orders sub-pages first and dedupes', () => {
  assert.deepEqual(storePageIds({ store: { mainPageId: 'A', subPageIds: ['B', 'A', 'B'] } }), ['B', 'A']);
  assert.deepEqual(storePageIds({ store: {} }), []);
});
