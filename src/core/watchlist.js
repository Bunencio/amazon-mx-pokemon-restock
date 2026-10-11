import { readFile } from 'node:fs/promises';
import { z } from 'zod';

const AsinSchema = z.string().regex(/^[A-Z0-9]{10}$/, 'ASIN inválido (10 caracteres A-Z0-9)');

const ItemSchema = z.object({
  asin: AsinSchema,
  label: z.string().optional(),
  priority: z.number().int().min(1).max(3).default(2),
  active: z.boolean().default(true),
});

const TitleFilterSchema = z
  .object({
    mustMatch: z.array(z.string()).default([]),
    anyOf: z.array(z.string()).default([]),
    tcgSignals: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
  })
  .default({});

export const WatchlistSchema = z.object({
  version: z.number().int().default(1),
  merchantId: z.string().optional(),
  titleFilter: TitleFilterSchema,
  queries: z
    .object({
      filtered: z.array(z.string()).default([]),
      discovery: z.array(z.string()).default([]),
    })
    .default({}),
  store: z
    .object({
      mainPageId: z.string().optional(),
      subPageIds: z.array(z.string()).default([]),
    })
    .default({}),
  items: z.array(ItemSchema).default([]),
  ignoreAsins: z.array(AsinSchema).default([]),
  defaults: z
    .object({
      discoveredPriority: z.number().int().min(1).max(3).default(2),
      maxDiscoveredItems: z.number().int().min(0).default(60),
    })
    .default({}),
});

export async function loadWatchlist(file = 'watchlist.json') {
  const raw = await readFile(file, 'utf8');
  return parseWatchlist(JSON.parse(raw));
}

export function parseWatchlist(json) {
  const parsed = WatchlistSchema.safeParse(json);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`watchlist.json inválido: ${issues}`);
  }
  return parsed.data;
}

/**
 * Merge the committed seeds with the ASINs discovered at runtime (kept in the
 * shared state). Seeds win on priority/label; ignored ASINs are dropped; the
 * number of discovered items is capped (oldest discoveries are dropped first).
 *
 * @returns {Array<{asin,label,priority,source,active,parentAsin}>}
 */
export function buildWatchItems(watchlist, stateItems = {}) {
  const ignore = new Set(watchlist.ignoreAsins || []);
  const out = new Map();

  for (const seed of watchlist.items) {
    if (ignore.has(seed.asin)) continue;
    const prev = stateItems[seed.asin] || {};
    out.set(seed.asin, {
      asin: seed.asin,
      label: seed.label || prev.title || seed.asin,
      priority: seed.priority,
      source: 'seed',
      active: seed.active,
      parentAsin: prev.parentAsin || null,
    });
  }

  const discovered = Object.values(stateItems)
    .filter((it) => it && it.asin && !out.has(it.asin) && !ignore.has(it.asin) && it.active !== false)
    .sort((a, b) => String(b.firstSeenAt || '').localeCompare(String(a.firstSeenAt || '')))
    .slice(0, watchlist.defaults.maxDiscoveredItems);

  for (const it of discovered) {
    out.set(it.asin, {
      asin: it.asin,
      label: it.label || it.title || it.asin,
      priority: it.priority || watchlist.defaults.discoveredPriority,
      source: it.source || 'discovered',
      active: true,
      parentAsin: it.parentAsin || null,
    });
  }

  return [...out.values()];
}
