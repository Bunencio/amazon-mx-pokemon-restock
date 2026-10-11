import { STATUS } from '../amazon/offerClassifier.js';
import { minutesSince, nowIso } from '../utils/time.js';

/**
 * Per-ASIN status machine. Pure functions over plain item objects.
 *
 * Only `ok` observations can change `status`. Degraded/blocked/ambiguous pages
 * never do — so a restock seen right after a blocked run still registers as a
 * genuine out_of_stock → amazon_in_stock transition (a new episode).
 *
 * Episodes: each positive transition (→ amazon_in_stock, → amazon_preorder)
 * increments `episode`. Alert dedupe keys include the episode number, so the
 * same episode never alerts twice but a later restock alerts again.
 */

export const EVENT = Object.freeze({ IN_STOCK: 'IN_STOCK', PREORDER: 'PREORDER' });

export const STATUS_LABEL_ES = Object.freeze({
  unknown: 'desconocido',
  amazon_in_stock: 'en stock (Amazon México)',
  amazon_preorder: 'pre-orden (Amazon México)',
  out_of_stock: 'agotado / sin oferta de Amazon',
  third_party_only: 'solo revendedores',
  delisted: 'retirado',
  ambiguous: 'ambiguo',
});

const NOT_FOUND_LIMIT = 3;

export function createItemState(asin, seed = {}, at = nowIso()) {
  return {
    asin,
    label: seed.label || null,
    priority: seed.priority || 2,
    source: seed.source || 'seed',
    parentAsin: seed.parentAsin || null,
    active: true,
    firstSeenAt: at,

    status: STATUS.UNKNOWN,
    since: null,
    lastSeenAt: null,
    lastOkAt: null,
    lastObservation: null,
    consecutiveDegraded: 0,
    consecutiveNotFound: 0,

    episode: 0,
    episodeStartedAt: null,
    episodeEndedAt: null,
    lastAlertAt: null,
    lastEvent: null,
    suppressedFlaps: 0,

    title: seed.title || null,
    image: seed.image || null,
    price: null,
    availabilityText: null,
    merchantId: null,
    merchantName: null,
    fulfiller: null,
    releaseDateText: null,

    amazonListedInSearch: false,
    searchMissStreak: 0,
    redirectedTo: null,
  };
}

/**
 * Apply one observation to an item (mutates it).
 *
 * observation = { kind: 'ok'|'ambiguous'|'degraded'|'blocked'|'notfound', at, by, method,
 *                 classification?: {status, confidence}, parsed?: dpParser output, reason? }
 * @returns {{changed:boolean, prev:string, next:string, event:string|null, firstObservation:boolean}}
 */
export function applyObservation(item, observation) {
  const at = observation.at || nowIso();
  let kind = observation.kind;
  const cls = observation.classification || null;
  if (kind === 'ok' && (!cls || cls.status === STATUS.AMBIGUOUS)) kind = 'ambiguous';

  item.lastSeenAt = at;
  item.lastObservation = {
    kind,
    at,
    by: observation.by || null,
    method: observation.method || null,
    status: cls?.status || null,
    confidence: cls?.confidence || null,
    reason: observation.reason || null,
  };

  const unchanged = { changed: false, prev: item.status, next: item.status, event: null, firstObservation: false };

  if (kind === 'ok') {
    item.consecutiveDegraded = 0;
    item.consecutiveNotFound = 0;
    item.lastOkAt = at;
    if (observation.parsed) updateFacts(item, observation.parsed, at);

    const prev = item.status;
    const next = cls.status;
    if (next === prev) return unchanged;

    let event = null;
    if (next === STATUS.AMAZON_IN_STOCK) {
      item.episode += 1;
      item.episodeStartedAt = at;
      event = EVENT.IN_STOCK;
    } else if (next === STATUS.AMAZON_PREORDER) {
      if (prev !== STATUS.AMAZON_IN_STOCK) {
        item.episode += 1;
        item.episodeStartedAt = at;
        event = EVENT.PREORDER;
      }
    } else if (prev === STATUS.AMAZON_IN_STOCK || prev === STATUS.AMAZON_PREORDER) {
      item.episodeEndedAt = at;
    }
    item.status = next;
    item.since = at;
    return { changed: true, prev, next, event, firstObservation: prev === STATUS.UNKNOWN };
  }

  if (kind === 'notfound') {
    item.consecutiveNotFound += 1;
    if (item.consecutiveNotFound >= NOT_FOUND_LIMIT && item.status !== STATUS.DELISTED) {
      const prev = item.status;
      item.status = STATUS.DELISTED;
      item.since = at;
      return { changed: true, prev, next: STATUS.DELISTED, event: null, firstObservation: false };
    }
    return unchanged;
  }

  if (kind === 'degraded' || kind === 'blocked') {
    item.consecutiveDegraded += 1;
    return unchanged;
  }

  return unchanged; // ambiguous
}

function updateFacts(item, parsed, at) {
  if (parsed.title) item.title = parsed.title;
  if (parsed.image) item.image = parsed.image;
  if (parsed.priceAmount != null) {
    item.price = { amount: parsed.priceAmount, text: parsed.priceText || null, currency: parsed.currency || 'MXN', at };
  }
  if (parsed.availabilityText !== undefined) item.availabilityText = parsed.availabilityText;
  item.merchantId = parsed.merchantId ?? null;
  item.merchantName = parsed.merchantName ?? null;
  item.fulfiller = parsed.fulfiller ?? null;
  if (parsed.releaseDateText) item.releaseDateText = parsed.releaseDateText;
}

/** Undo a transition whose confirmation re-fetch disagreed. */
export function revertTransition(item, transition) {
  if (!transition || !transition.changed) return;
  item.status = transition.prev;
  if (transition.event) {
    item.episode = Math.max(0, item.episode - 1);
    item.episodeStartedAt = null;
  }
  item.lastObservation = { ...(item.lastObservation || {}), kind: 'ambiguous', reason: 'confirmación fallida' };
}

export function alertKey(asin, event, episode) {
  return `${asin}:${event}:${episode}`;
}

/**
 * Should this transition produce a Discord alert?
 * @returns {{alert:boolean, key:string|null, reason:string}}
 */
export function decideAlert(item, transition, { now = new Date(), cooldownMin = 30, alertOnFirstObservation = true, sentKeys = new Set() } = {}) {
  if (!transition || !transition.event) return { alert: false, key: null, reason: 'sin evento' };
  const key = alertKey(item.asin, transition.event, item.episode);
  if (transition.firstObservation && !alertOnFirstObservation) {
    return { alert: false, key, reason: 'primera observación (ALERT_ON_FIRST_OBSERVATION=false)' };
  }
  if (sentKeys.has(key)) return { alert: false, key, reason: 'ya enviada' };
  const since = minutesSince(item.lastAlertAt, now);
  if (since < cooldownMin) {
    item.suppressedFlaps += 1;
    return { alert: false, key, reason: `cooldown (${Math.round(since)} < ${cooldownMin} min)` };
  }
  return { alert: true, key, reason: transition.firstObservation ? 'primera observación' : 'transición' };
}

export function humanStatus(status) {
  return STATUS_LABEL_ES[status] || status || '—';
}
