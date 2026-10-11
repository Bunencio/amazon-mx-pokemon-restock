import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseWatchlist, buildWatchItems, loadWatchlist } from '../src/core/watchlist.js';

test('the committed watchlist.json is valid', async () => {
  const wl = await loadWatchlist(new URL('../watchlist.json', import.meta.url));
  assert.equal(wl.merchantId, 'AVDBXBAVVSXLQ');
  assert.ok(wl.items.some((i) => i.asin === 'B0H8SV3WJ8'));
  assert.ok(wl.queries.filtered.length >= 1);
});

test('rejects invalid ASINs', () => {
  assert.throws(() => parseWatchlist({ items: [{ asin: 'nope' }] }), /ASIN inválido/);
});

test('merges seeds with discovered items, applies ignore list and caps discoveries', () => {
  const wl = parseWatchlist({
    items: [{ asin: 'B0SEED0001', label: 'Seed', priority: 1 }, { asin: 'B0IGNORE01', priority: 1 }],
    ignoreAsins: ['B0IGNORE01', 'B0DISC0003'],
    defaults: { discoveredPriority: 3, maxDiscoveredItems: 2 },
  });
  const stateItems = {
    B0SEED0001: { asin: 'B0SEED0001', title: 'from state', parentAsin: 'B0PARENT01' },
    B0DISC0001: { asin: 'B0DISC0001', title: 'Disc 1', source: 'search_filtered', firstSeenAt: '2026-10-01T00:00:00Z' },
    B0DISC0002: { asin: 'B0DISC0002', title: 'Disc 2', source: 'store', firstSeenAt: '2026-10-05T00:00:00Z' },
    B0DISC0003: { asin: 'B0DISC0003', title: 'Ignored', source: 'store', firstSeenAt: '2026-10-09T00:00:00Z' },
    B0DISC0004: { asin: 'B0DISC0004', title: 'Disc 4 newest', source: 'twister', firstSeenAt: '2026-10-10T00:00:00Z' },
    B0INACTIV1: { asin: 'B0INACTIV1', title: 'off', active: false, firstSeenAt: '2026-10-10T00:00:00Z' },
  };
  const items = buildWatchItems(wl, stateItems);
  const asins = items.map((i) => i.asin);
  assert.deepEqual(asins, ['B0SEED0001', 'B0DISC0004', 'B0DISC0002']);
  const seed = items[0];
  assert.equal(seed.source, 'seed');
  assert.equal(seed.label, 'Seed');
  assert.equal(seed.priority, 1);
  assert.equal(seed.parentAsin, 'B0PARENT01');
  assert.equal(items[1].priority, 3);
  assert.equal(items[1].source, 'twister');
});

test('watchlist.json seeds: unique ASINs, valid priorities, a small priority-1 core', () => {
  const wl = JSON.parse(readFileSync(new URL('../watchlist.json', import.meta.url), 'utf8'));
  const asins = wl.items.map((i) => i.asin);
  assert.equal(new Set(asins).size, asins.length, 'duplicated ASIN in watchlist.json');
  for (const item of wl.items) assert.ok([1, 2, 3].includes(item.priority), item.asin);
  const p1 = wl.items.filter((i) => i.priority === 1).length;
  assert.ok(p1 >= 1 && p1 <= 7, `priority-1 items must stay within the per-run budget (got ${p1})`);
});
