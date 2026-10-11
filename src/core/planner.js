import { dpUrl, searchUrl, storePageUrl } from '../amazon/constants.js';
import { isWithinHourRange, minutesSince } from '../utils/time.js';
import { shuffle } from '../utils/random.js';

/**
 * Decide which pages one run will load, within a request budget.
 *
 *   every run   : 1 seller-filtered search (alternating query) + every priority-1 ASIN
 *   periodic    : discovery searches (hourly) OR a brand-store sweep (daily, Playwright)
 *   remainder   : round-robin over priority 2–3 ASINs
 *   reserve     : 1 request kept for confirming a positive transition
 *
 * Pure: returns the steps plus the next cursor/parity to persist.
 */
export function buildPlan({ items, tasks = {}, now = new Date(), budget = 8, watchlist, cursor = 0, parity = 0, p1Cursor = 0, config, onlyAsin = null, merchantId }) {
  const steps = [];
  const cost = () => steps.length;

  if (onlyAsin) {
    steps.push(dpStep(onlyAsin, merchantId, 1));
    return { steps, cursor, parity, p1Cursor, reserve: Math.max(0, budget - 1), periodic: null, budget };
  }

  const active = items.filter((i) => i.active !== false);
  const reserve = budget >= 4 ? 1 : 0;
  const usable = Math.max(1, budget - reserve);

  // 1) Seller-filtered search: cheap "Amazon México offers X" signal + discovery.
  const filteredQueries = watchlist.queries?.filtered || [];
  let nextParity = parity;
  if (filteredQueries.length) {
    const q = filteredQueries[((parity % filteredQueries.length) + filteredQueries.length) % filteredQueries.length];
    steps.push({ type: 'search', query: q, filtered: true, purpose: 'filtered', url: searchUrl(q, { merchantId }) });
    nextParity = (parity + 1) % filteredQueries.length;
  }

  // 2) Priority-1 ASINs every run. When the budget cannot hold all of them
  //    (e.g. after a block halved it), rotate the window so none is starved.
  const p1 = active.filter((i) => i.priority === 1).sort(byAsin);
  let nextP1Cursor = 0;
  if (p1.length) {
    const slots = Math.max(0, usable - cost());
    if (p1.length <= slots) {
      for (const it of p1) steps.push(dpStep(it.asin, merchantId, 1));
    } else {
      const start = ((p1Cursor % p1.length) + p1.length) % p1.length;
      for (let k = 0; k < slots; k += 1) steps.push(dpStep(p1[(start + k) % p1.length].asin, merchantId, 1));
      nextP1Cursor = (start + slots) % p1.length;
    }
  }

  // 3) One periodic task per run (discovery is cheaper, so it goes first).
  let periodic = null;
  const discoveryQueries = watchlist.queries?.discovery || [];
  const discoveryDue = discoveryQueries.length > 0 && minutesSince(tasks.discoverySearch?.lastAt, now) >= config.tasks.discoveryIntervalMin;
  const storePages = storePageIds(watchlist);
  const storeDue =
    config.tasks.storeSweepEnabled &&
    storePages.length > 0 &&
    minutesSince(tasks.storeSweep?.lastAt, now) >= config.tasks.storeSweepIntervalMin &&
    isWithinHourRange(now, config.timezone, config.tasks.storeSweepHours);

  if (discoveryDue && cost() < usable) {
    periodic = 'discovery';
    for (const q of discoveryQueries) {
      if (cost() >= usable) break;
      steps.push({ type: 'search', query: q, filtered: false, purpose: 'discovery', url: searchUrl(q) });
    }
  } else if (storeDue && cost() < usable) {
    periodic = 'store';
    for (const pageId of storePages) {
      if (cost() >= usable) break;
      steps.push({ type: 'store', pageId, url: storePageUrl(pageId), scrolls: 4 });
    }
  }

  // 4) Round-robin over the rest.
  const rest = active.filter((i) => i.priority >= 2).sort(byAsin);
  let nextCursor = cursor;
  if (rest.length && periodic !== 'store') {
    const start = ((cursor % rest.length) + rest.length) % rest.length;
    const take = Math.min(rest.length, Math.max(0, usable - cost()));
    for (let k = 0; k < take; k += 1) {
      const it = rest[(start + k) % rest.length];
      steps.push(dpStep(it.asin, merchantId, it.priority));
    }
    nextCursor = (start + take) % rest.length;
  } else if (!rest.length) {
    nextCursor = 0;
  }

  // Randomize request order; store pages stay last and in configured order.
  const storeSteps = steps.filter((s) => s.type === 'store');
  const others = shuffle(steps.filter((s) => s.type !== 'store'));
  return { steps: [...others, ...storeSteps], cursor: nextCursor, parity: nextParity, p1Cursor: nextP1Cursor, reserve, periodic, budget };
}

export function dpStep(asin, merchantId, priority = 2) {
  return { type: 'dp', asin, priority, url: dpUrl(asin, { smid: merchantId }) };
}

/** Sub-pages first (that is where the product grids live), main page last. */
export function storePageIds(watchlist) {
  const ids = [];
  for (const id of watchlist.store?.subPageIds || []) if (!ids.includes(id)) ids.push(id);
  if (watchlist.store?.mainPageId && !ids.includes(watchlist.store.mainPageId)) ids.push(watchlist.store.mainPageId);
  return ids;
}

export function describeStep(step) {
  if (step.type === 'dp') return `dp:${step.asin}`;
  if (step.type === 'search') return `search${step.filtered ? '[amazon]' : ''}:${step.query}`;
  return `store:${step.pageId}`;
}

const byAsin = (a, b) => a.asin.localeCompare(b.asin);
