import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config, summarizeConfig } from '../services/config.js';
import { logger } from '../services/logger.js';
import { createRunnerStore, createSharedStore } from '../services/stateStoreFactory.js';
import { createEmptyRunnerState, createEmptySharedState } from '../services/stateStore.js';
import { postDiscordMessage } from '../services/discordService.js';
import {
  MAX_EVENTS_PER_MESSAGE,
  buildDiscoveryMessage,
  buildHeartbeatMessage,
  buildStockAlertMessage,
  buildWarningMessage,
  buildWatchdogMessage,
} from '../services/alertBuilder.js';
import { buildWatchItems, loadWatchlist } from '../core/watchlist.js';
import { createTitleFilter } from '../core/titleFilter.js';
import { buildPlan, describeStep, dpStep } from '../core/planner.js';
import { applyObservation, createItemState, decideAlert, revertTransition } from '../core/statusMachine.js';
import { STATUS, classifyOffer } from '../amazon/offerClassifier.js';
import { createFetcher } from '../amazon/fetcher.js';
import { isDegraded, isHardBlock, validatePage } from '../amazon/pageValidator.js';
import { parseDetailPage } from '../amazon/dpParser.js';
import { parseSearchResults } from '../amazon/searchParser.js';
import { parseStorePage } from '../amazon/storeParser.js';
import { sanitizeHtml } from '../amazon/fixtureSanitizer.js';
import { PARSER_VERSION } from '../amazon/constants.js';
import { formatDateLocal, minutesSince, nowIso } from '../utils/time.js';
import { jitterMs } from '../utils/random.js';
import { sleep } from '../utils/retry.js';
import { slugify } from '../utils/hash.js';

/**
 * One monitor pass:
 *   gates (defer to PC / backoff) → flush pending alerts → plan → fetch & classify
 *   → hot-ASIN follow-ups → confirmations → alerts → warnings → persist.
 *
 * Exit code 0 unless something unexpected throws (so Task Scheduler / Actions
 * history only shows red for real failures).
 */

const APP_VERSION = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
const BACKOFF_MINUTES = [10, 20, 40, 80, 160];
const BACKOFF_CAP_MINUTES = 360;
const HOT_ASIN_MAX = 2;
const POSITIVE_STATUSES = new Set([STATUS.AMAZON_IN_STOCK, STATUS.AMAZON_PREORDER]);

async function main() {
  const runId = Date.now().toString(36);
  const log = logger.child({ job: 'pokemon-restock', runner: config.runnerId, runId });
  const startedAt = Date.now();
  const now = new Date();
  const today = formatDateLocal(now, config.timezone);
  log.info('Iniciando monitor de restock.', { ...summarizeConfig(), appVersion: APP_VERSION, parserVersion: PARSER_VERSION });

  const runnerStore = createRunnerStore(config, log);
  const sharedStore = createSharedStore(config, log);
  const local = (await runnerStore.load()) || createEmptyRunnerState(config.runnerId);
  const shared = (await sharedStore.load()) || createEmptySharedState();
  const watchlist = await loadWatchlist(config.watchlistFile);
  const titleFilter = createTitleFilter(watchlist.titleFilter);
  const sentKeys = new Set(shared.sentKeys);
  const me = (shared.runners[config.runnerId] ||= { runCount: 0 });
  const forced = config.debug.forceRun;

  // ── Gate 1: a backup runner defers while the primary runner is alive ──
  if (config.failover.deferToPc && config.runnerId !== config.failover.primaryRunnerId && !forced) {
    const primary = shared.runners[config.failover.primaryRunnerId] || null;
    const ageMin = minutesSince(primary?.lastFinishedAt, now);
    if (primary && ageMin < config.failover.pcFreshMinutes && ['ok', 'partial'].includes(primary.lastOutcome)) {
      me.lastDeferAt = nowIso();
      me.lastOutcome = 'deferred';
      log.info('El runner principal está activo; cediendo la corrida.', { primary: config.failover.primaryRunnerId, ageMin: Math.round(ageMin) });
      await persistShared(sharedStore, shared, sentKeys);
      return 0;
    }
    if (ageMin >= config.failover.watchdogStaleMinutes) {
      const key = `watchdog:${today}`;
      if (!sentKeys.has(key)) {
        const payload = buildWatchdogMessage({
          primaryRunnerId: config.failover.primaryRunnerId,
          ageMinutes: primary ? ageMin : NaN,
          lastOutcome: primary?.lastOutcome,
          runnerId: config.runnerId,
          now,
        });
        const res = await safePost(payload, log, 'watchdog');
        if (res.posted) sentKeys.add(key);
      }
    }
  }

  // ── Gate 2: backoff after a block ──
  if (!forced && local.backoff.until && new Date(local.backoff.until) > now) {
    log.warn('En backoff tras un bloqueo; se omite esta corrida.', { until: local.backoff.until, level: local.backoff.level });
    me.lastStartedAt = nowIso();
    me.lastFinishedAt = nowIso();
    me.lastOutcome = 'backoff';
    await persistShared(sharedStore, shared, sentKeys);
    await runnerStore.save(local);
    return 0;
  }

  me.lastStartedAt = nowIso();
  me.runCount = (me.runCount || 0) + 1;
  me.appVersion = APP_VERSION;

  await flushPendingAlerts(shared, sentKeys, log);

  // ── Watch items (seeds + discoveries) ──
  let watchItems = buildWatchItems(watchlist, shared.items);
  if (config.debug.onlyAsin) {
    const only = config.debug.onlyAsin;
    watchItems = watchItems.filter((i) => i.asin === only);
    if (!watchItems.length) watchItems = [{ asin: only, label: only, priority: 1, source: 'adhoc', active: true, parentAsin: null }];
  }
  for (const w of watchItems) {
    const item = (shared.items[w.asin] ||= createItemState(w.asin, w));
    item.label = w.label || item.label;
    item.priority = w.priority;
    item.source = item.source || w.source;
    item.active = w.active !== false;
    if (w.parentAsin) item.parentAsin = w.parentAsin;
  }
  applySimulation(shared, config.debug.simulate, log);

  // ── Plan ──
  const budget = Math.max(1, Math.min(config.scrape.maxRequestsPerRun, local.budget.maxRequestsPerRun || Infinity));
  const plan = buildPlan({
    items: watchItems,
    tasks: shared.tasks,
    now,
    budget,
    watchlist,
    cursor: shared.tasks.roundRobinCursor || 0,
    parity: shared.tasks.filteredQueryParity || 0,
    p1Cursor: shared.tasks.p1Cursor || 0,
    config,
    onlyAsin: config.debug.onlyAsin || null,
    merchantId: config.amazon.merchantId,
  });
  log.info('Plan de la corrida.', { budget, reserve: plan.reserve, periodic: plan.periodic, steps: plan.steps.map(describeStep) });

  // ── Execute ──
  const ctx = {
    log,
    shared,
    watchlist,
    titleFilter,
    now,
    stats: { requests: 0, ok: 0, degraded: 0, hard: 0, network: 0, notfound: 0, alerts: 0 },
    transitions: [],
    discovered: [],
    hotAsins: new Set(),
    fetchedDp: new Set(),
    outcome: 'ok',
    deadline: startedAt + config.scrape.runDeadlineMs,
  };
  const fetcher = createFetcher({ config, logger: log, session: local.session });
  let reserveLeft = plan.reserve;

  try {
    for (const step of plan.steps) {
      if (Date.now() > ctx.deadline) {
        ctx.outcome = 'partial';
        log.warn('Se alcanzó el deadline de la corrida; se guarda lo obtenido.');
        break;
      }
      if (await executeStep(step, fetcher, ctx)) break;
    }

    // Fast path: the seller-filtered search says Amazon México lists an item as
    // available → look at its page right now instead of waiting for its turn.
    if (ctx.outcome !== 'blocked') {
      const hot = [...ctx.hotAsins].filter((a) => !ctx.fetchedDp.has(a)).slice(0, HOT_ASIN_MAX);
      for (const asin of hot) {
        if (reserveLeft <= 0 || Date.now() > ctx.deadline) break;
        reserveLeft -= 1;
        log.info('ASIN caliente según la búsqueda filtrada; verificando su página ahora.', { asin });
        if (await executeStep(dpStep(asin, config.amazon.merchantId, 1), fetcher, ctx)) break;
      }
    }

    // Confirmation: positive transitions without high confidence get one re-fetch.
    if (ctx.outcome !== 'blocked') {
      for (const t of ctx.transitions.filter((x) => x.transition.event && x.confirmed === null)) {
        if (Date.now() > ctx.deadline || reserveLeft <= 0) {
          revertTransition(t.item, t.transition);
          t.confirmed = false;
          log.warn('Sin presupuesto/tiempo para confirmar; se revierte y se reintenta en la próxima corrida.', { asin: t.item.asin });
          continue;
        }
        reserveLeft -= 1;
        await sleep(jitterMs(config.scrape.jitterMinMs, config.scrape.jitterMaxMs));
        const res = await fetcher.fetchPage(t.step);
        ctx.stats.requests += 1;
        const v = validatePage({ type: 'dp', ...res });
        if (v.kind !== 'ok') {
          revertTransition(t.item, t.transition);
          t.confirmed = false;
          log.warn('La confirmación no obtuvo una página válida; se revierte.', { asin: t.item.asin, kind: v.kind });
          continue;
        }
        const parsed2 = parseDetailPage(res.html);
        const cls2 = classifyOffer(parsed2, { merchantId: config.amazon.merchantId });
        if (cls2.status === t.transition.next) {
          t.confirmed = true;
          t.classification = cls2;
          applyObservation(t.item, { kind: 'ok', at: nowIso(), by: config.runnerId, method: res.method, classification: cls2, parsed: parsed2 });
          log.info('Transición confirmada con una segunda lectura.', { asin: t.item.asin, status: cls2.status });
        } else {
          revertTransition(t.item, t.transition);
          t.confirmed = false;
          log.warn('La confirmación discrepa; se revierte.', { asin: t.item.asin, first: t.transition.next, second: cls2.status });
        }
      }
    }
  } finally {
    try {
      local.session = await fetcher.exportSession();
    } catch (err) {
      log.warn('No se pudo exportar la sesión.', { error: err.message });
    }
    await fetcher.close();
  }

  // ── Alerts ──
  const alertable = [];
  for (const t of ctx.transitions) {
    if (!t.transition.event || t.confirmed === false) continue;
    const decision = decideAlert(t.item, t.transition, {
      now,
      cooldownMin: config.alerts.cooldownMin,
      alertOnFirstObservation: config.alerts.alertOnFirstObservation,
      sentKeys,
    });
    log.info('Decisión de alerta.', { asin: t.item.asin, event: t.transition.event, episode: t.item.episode, alert: decision.alert, reason: decision.reason });
    if (decision.alert) alertable.push({ ...t, key: decision.key });
  }
  for (const batch of chunk(alertable, MAX_EVENTS_PER_MESSAGE)) {
    const payload = buildStockAlertMessage({ events: batch.map(toEventView), config, runnerId: config.runnerId, now });
    const keys = batch.map((b) => b.key);
    let res;
    try {
      res = await postDiscordMessage(payload, config, log);
    } catch (err) {
      log.error('No se pudo publicar la alerta; queda pendiente para la próxima corrida.', { error: err.message, keys });
      shared.pendingAlerts.push({ at: nowIso(), keys, payload });
      continue;
    }
    if (res.posted) {
      for (const b of batch) {
        sentKeys.add(b.key);
        b.item.lastAlertAt = nowIso();
        b.item.lastEvent = b.transition.event;
      }
      ctx.stats.alerts += batch.length;
      await persistShared(sharedStore, shared, sentKeys); // make the dedupe durable right away
    } else if (res.dryRun) {
      log.info('Dry-run: alerta no publicada; las claves no se consumen.', { keys });
    }
  }

  // ── Block warning / backoff / discovery / heartbeat ──
  if (ctx.outcome === 'blocked' || ctx.stats.hard > 0) {
    applyBackoff(local, { hard: ctx.stats.hard > 0, now, log });
    const key = `blocked:${config.runnerId}:${today}`;
    if (!sentKeys.has(key)) {
      const payload = buildWarningMessage({
        title: `Amazon bloqueó al runner "${config.runnerId}"`,
        message:
          `${ctx.stats.degraded} página(s) degradada(s) en esta corrida (${ctx.stats.hard} bloqueo(s) duro(s), ${ctx.stats.network} error(es) de red).\n` +
          `Sin evasión: el monitor espera hasta ${local.backoff.until} y vuelve a intentar.`,
        runnerId: config.runnerId,
        now,
      });
      const res = await safePost(payload, log, 'warning');
      if (res.posted) sentKeys.add(key);
    }
  } else if (ctx.stats.degraded === 0 && ctx.stats.requests > 0) {
    relaxBackoff(local, now);
  }
  adaptBudget(local, ctx.stats, now, log);

  if (config.alerts.notifyOnDiscovery && ctx.discovered.length) {
    await safePost(buildDiscoveryMessage({ discovered: ctx.discovered, runnerId: config.runnerId, now }), log, 'discovery');
  }
  if (config.alerts.sendDailyHeartbeat) {
    const key = `heartbeat:${today}`;
    if (!sentKeys.has(key)) {
      const counts = countStatuses(shared.items);
      const res = await safePost(buildHeartbeatMessage({ counts, total: Object.keys(shared.items).length, runnerId: config.runnerId, now }), log, 'heartbeat');
      if (res.posted) sentKeys.add(key);
    }
  }

  // ── Persist ──
  shared.tasks.roundRobinCursor = plan.cursor;
  shared.tasks.filteredQueryParity = plan.parity;
  shared.tasks.p1Cursor = plan.p1Cursor;
  me.lastFinishedAt = nowIso();
  me.lastOutcome = ctx.outcome;
  shared.history = cap(
    [
      ...shared.history,
      {
        at: nowIso(),
        by: config.runnerId,
        outcome: ctx.outcome,
        method: fetcher.mode,
        requests: ctx.stats.requests,
        ok: ctx.stats.ok,
        degraded: ctx.stats.degraded,
        alerts: ctx.stats.alerts,
        discovered: ctx.discovered.length,
        durationMs: Date.now() - startedAt,
      },
    ],
    config.alerts.historyMax,
  );
  await persistShared(sharedStore, shared, sentKeys);
  local.runCounter = (local.runCounter || 0) + 1;
  local.lastRunAt = nowIso();
  await runnerStore.save(local);

  log.info('Corrida terminada.', {
    outcome: ctx.outcome,
    ...ctx.stats,
    discovered: ctx.discovered.length,
    durationMs: Date.now() - startedAt,
    stateBackend: sharedStore.backend,
    items: Object.keys(shared.items).length,
  });
  return 0;
}

// ── step execution ───────────────────────────────────────────────────────────

/** Fetch + validate + dispatch one step. Returns true when the run must abort. */
async function executeStep(step, fetcher, ctx) {
  const { log, stats } = ctx;
  if (stats.requests > 0) await sleep(jitterMs(config.scrape.jitterMinMs, config.scrape.jitterMaxMs));
  const res = await fetcher.fetchPage(step);
  stats.requests += 1;
  const v = validatePage({ type: step.type, ...res });
  log.info('Página obtenida.', { step: describeStep(step), kind: v.kind, reason: v.reason, status: res.status, bytes: v.bytes, ms: res.elapsedMs, method: res.method });
  const at = nowIso();
  const item = step.type === 'dp' ? ctx.shared.items[step.asin] : null;
  if (step.type === 'dp') ctx.fetchedDp.add(step.asin);

  if (isDegraded(v)) {
    stats.degraded += 1;
    if (isHardBlock(v)) stats.hard += 1;
    if (v.severity === 'network') stats.network += 1;
    await saveDebugHtml(step, res, v.kind, log, { force: false });
    if (item) applyObservation(item, { kind: isHardBlock(v) ? 'blocked' : 'degraded', at, by: config.runnerId, method: res.method, reason: v.reason });
    if (isHardBlock(v)) {
      // A CAPTCHA / 5xx means the session is burned: stop right away, do not insist.
      ctx.outcome = 'blocked';
      log.warn('Bloqueo duro de Amazon; se aborta la corrida.', { kind: v.kind, reason: v.reason });
      return true;
    }
    if (stats.degraded >= 2) {
      ctx.outcome = 'blocked';
      log.warn('Dos páginas degradadas en la misma corrida; se aborta para no insistir.');
      return true;
    }
    return false;
  }

  if (v.kind === 'notfound') {
    stats.notfound += 1;
    if (item) {
      const t = applyObservation(item, { kind: 'notfound', at, by: config.runnerId, method: res.method });
      if (t.changed) log.warn('ASIN marcado como retirado tras varios 404.', { asin: step.asin });
    }
    return false;
  }

  stats.ok += 1;
  if (step.type === 'search') handleSearch(step, res.html, ctx);
  else if (step.type === 'dp') await handleDp(step, res, ctx, at);
  else if (step.type === 'store') handleStore(step, res.html, ctx);
  return false;
}

async function handleDp(step, res, ctx, at) {
  const { log, shared } = ctx;
  const parsed = parseDetailPage(res.html);
  const classification = classifyOffer(parsed, { merchantId: config.amazon.merchantId });
  const item = (shared.items[step.asin] ||= createItemState(step.asin, { source: 'adhoc', priority: 2 }));

  if (parsed.twister?.childAsins?.length) {
    for (const child of parsed.twister.childAsins) {
      if (child === step.asin) continue;
      const label = parsed.twister.labels[child] || child;
      registerDiscovered(ctx, { asin: child, title: `${parsed.title || item.title || step.asin} — ${label}` }, 'twister', { parentAsin: parsed.twister.parentAsin || step.asin });
    }
  }
  if (parsed.asin && parsed.asin !== step.asin) {
    item.redirectedTo = parsed.asin;
    log.info('La página responde con otro ASIN (redirección/fusión).', { asin: step.asin, redirectedTo: parsed.asin });
  }

  if (classification.status === STATUS.AMBIGUOUS) {
    applyObservation(item, { kind: 'ambiguous', at, by: config.runnerId, method: res.method, reason: classification.reasons.join(' | ') });
    await saveDebugHtml(step, res, 'ambiguous', log, { force: true });
    log.warn('Clasificación ambigua; el estado no cambia.', { asin: step.asin, reasons: classification.reasons });
    return;
  }

  const transition = applyObservation(item, { kind: 'ok', at, by: config.runnerId, method: res.method, classification, parsed });
  log.info('Producto clasificado.', {
    asin: step.asin,
    status: classification.status,
    confidence: classification.confidence,
    prev: transition.prev,
    changed: transition.changed,
    event: transition.event,
    availability: parsed.availabilityText,
    merchantId: parsed.merchantId,
    price: parsed.priceText,
  });
  if (transition.changed) {
    ctx.transitions.push({ item, step, transition, classification, parsed, confirmed: classification.confidence === 'high' ? true : null });
  }
}

function handleSearch(step, html, ctx) {
  const { log, shared, titleFilter } = ctx;
  const results = parseSearchResults(html);
  const matched = results.organic.filter((c) => titleFilter.test(c.title));
  let registered = 0;
  for (const c of matched) {
    if (registerDiscovered(ctx, c, step.filtered ? 'search_filtered' : 'search_discovery')) registered += 1;
  }

  if (step.filtered) {
    const listed = new Set(matched.map((c) => c.asin));
    for (const it of Object.values(shared.items)) {
      if (it.active === false) continue;
      if (listed.has(it.asin)) {
        it.amazonListedInSearch = true;
        it.searchMissStreak = 0;
      } else {
        it.searchMissStreak = (it.searchMissStreak || 0) + 1;
        if (it.searchMissStreak >= 3) it.amazonListedInSearch = false;
      }
    }
    for (const c of matched) {
      const it = shared.items[c.asin];
      if (it && !c.unavailable && !POSITIVE_STATUSES.has(it.status)) ctx.hotAsins.add(c.asin);
    }
  } else {
    shared.tasks.discoverySearch = { lastAt: nowIso() };
  }

  log.info('Búsqueda procesada.', {
    query: step.query,
    filtered: Boolean(step.filtered),
    cards: results.cards.length,
    organic: results.organic.length,
    matched: matched.length,
    nuevos: registered,
    listedAvailable: step.filtered ? matched.filter((c) => !c.unavailable).map((c) => c.asin) : undefined,
    noResults: results.noResults,
  });
}

function handleStore(step, html, ctx) {
  const { log, shared, titleFilter } = ctx;
  const parsed = parseStorePage(html);
  const matched = parsed.products.filter((p) => titleFilter.test(p.title));
  let registered = 0;
  for (const p of matched) {
    if (registerDiscovered(ctx, { asin: p.asin, title: p.title }, 'store')) registered += 1;
  }
  shared.tasks.storeSweep = { lastAt: nowIso() };
  log.info('Página de tienda procesada.', { pageId: step.pageId, products: parsed.products.length, matched: matched.length, nuevos: registered, nav: parsed.nav.length });
}

function registerDiscovered(ctx, card, source, extra = {}) {
  const asin = String(card.asin || '').toUpperCase();
  if (!/^[A-Z0-9]{10}$/.test(asin)) return false;
  if (ctx.watchlist.ignoreAsins.includes(asin)) return false;
  const existing = ctx.shared.items[asin];
  if (existing) {
    if (!existing.title && card.title) existing.title = card.title;
    if (!existing.image && card.image) existing.image = card.image;
    return false;
  }
  const discoveredCount = Object.values(ctx.shared.items).filter((i) => i.source !== 'seed').length;
  if (discoveredCount >= ctx.watchlist.defaults.maxDiscoveredItems) {
    ctx.log.warn('Tope de ASINs descubiertos alcanzado; se ignora el nuevo.', { asin, title: card.title });
    return false;
  }
  ctx.shared.items[asin] = createItemState(asin, {
    label: card.title || null,
    title: card.title || null,
    image: card.image || null,
    source,
    priority: ctx.watchlist.defaults.discoveredPriority,
    parentAsin: extra.parentAsin || null,
  });
  ctx.shared.discovery[asin] = { firstSeenAt: nowIso(), source, title: card.title || null };
  ctx.discovered.push({ asin, title: card.title || null, source });
  ctx.log.info('Nuevo ASIN descubierto; agregado a la watchlist.', { asin, source, title: card.title });
  return true;
}

// ── alerts & housekeeping ────────────────────────────────────────────────────

function toEventView(t) {
  return {
    asin: t.item.asin,
    title: t.item.title || t.item.label || t.item.asin,
    event: t.transition.event,
    episode: t.item.episode,
    prevStatus: t.transition.prev,
    price: t.item.price,
    availabilityText: t.item.availabilityText,
    fulfiller: t.item.fulfiller,
    image: t.item.image,
    releaseDateText: t.item.releaseDateText,
    firstObservation: t.transition.firstObservation,
  };
}

async function flushPendingAlerts(shared, sentKeys, log) {
  if (!shared.pendingAlerts.length) return;
  const keep = [];
  for (const pending of shared.pendingAlerts) {
    if (minutesSince(pending.at) > config.alerts.pendingAlertMaxAgeMin) {
      log.warn('Alerta pendiente descartada por antigüedad.', { keys: pending.keys, at: pending.at });
      continue;
    }
    try {
      const res = await postDiscordMessage(pending.payload, config, log);
      if (res.posted) {
        for (const key of pending.keys || []) {
          sentKeys.add(key);
          const asin = String(key).split(':')[0];
          if (shared.items[asin]) shared.items[asin].lastAlertAt = nowIso();
        }
        log.info('Alerta pendiente publicada.', { keys: pending.keys });
      } else {
        keep.push(pending);
      }
    } catch (err) {
      log.warn('La alerta pendiente volvió a fallar; se conserva.', { error: err.message });
      keep.push(pending);
    }
  }
  shared.pendingAlerts = keep;
}

async function safePost(payload, log, label) {
  try {
    return await postDiscordMessage(payload, config, log);
  } catch (err) {
    log.error(`No se pudo publicar el mensaje de ${label}.`, { error: err.message });
    return { posted: false, error: err.message };
  }
}

async function persistShared(store, shared, sentKeys) {
  shared.sentKeys = cap([...sentKeys], config.alerts.sentKeysMax);
  shared.savedBy = config.runnerId;
  shared.parserVersion = PARSER_VERSION;
  await store.save(shared);
}

function applyBackoff(local, { hard, now, log }) {
  const level = Math.min(BACKOFF_MINUTES.length, (local.backoff.level || 0) + 1);
  const minutes = Math.min(BACKOFF_CAP_MINUTES, BACKOFF_MINUTES[level - 1]);
  local.backoff = {
    ...local.backoff,
    level,
    until: new Date(now.getTime() + minutes * 60_000).toISOString(),
    lastBlockAt: nowIso(),
  };
  if (hard) local.session = null; // start a fresh browser session after a hard block
  log.warn('Backoff aplicado.', { level, minutes, hard, until: local.backoff.until });
}

function relaxBackoff(local, now) {
  local.backoff.lastCleanAt = nowIso();
  if ((local.backoff.level || 0) > 0 && minutesSince(local.backoff.lastBlockAt, now) > 24 * 60) local.backoff.level = 0;
}

function adaptBudget(local, stats, now, log) {
  const def = config.scrape.maxRequestsPerRun;
  const current = local.budget.maxRequestsPerRun || def;
  if (stats.degraded > 0 && stats.requests > 0) {
    local.budget.maxRequestsPerRun = Math.max(3, Math.floor(current / 2));
    if (local.budget.maxRequestsPerRun !== current) log.warn('Presupuesto reducido tras páginas degradadas.', { from: current, to: local.budget.maxRequestsPerRun });
    return;
  }
  // Recover one request per clean day until the configured default is back.
  const dayClean = minutesSince(local.backoff.lastBlockAt, now) > 24 * 60;
  const dayIncreaseCooldown = !local.budget.lastIncreaseAt || minutesSince(local.budget.lastIncreaseAt, now) > 24 * 60;
  if (current < def && dayClean && dayIncreaseCooldown) {
    local.budget.maxRequestsPerRun = Math.min(def, current + 1);
    local.budget.lastIncreaseAt = nowIso();
    log.info('Presupuesto restaurado parcialmente tras un día limpio.', { to: local.budget.maxRequestsPerRun });
  }
}

function applySimulation(shared, spec, log) {
  if (!spec) return;
  for (const pair of spec.split(',')) {
    const [asinRaw, statusRaw] = pair.split('=').map((s) => (s || '').trim());
    const asin = asinRaw.toUpperCase();
    const status = (statusRaw || '').toLowerCase();
    if (!/^[A-Z0-9]{10}$/.test(asin) || !Object.values(STATUS).includes(status)) {
      log.warn('SIMULATE ignorado (formato ASIN=status).', { pair });
      continue;
    }
    const item = (shared.items[asin] ||= createItemState(asin, { source: 'adhoc', priority: 1 }));
    item.status = status;
    item.since = nowIso();
    log.warn('SIMULATE aplicado: estado forzado antes de la corrida.', { asin, status });
  }
}

async function saveDebugHtml(step, res, kind, log, { force }) {
  if (!res.html) return;
  if (!force && !config.scrape.saveDebugHtml) return;
  try {
    await mkdir(config.scrape.debugDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const name = step.type === 'dp' ? step.asin : slugify(step.query || step.pageId || step.type);
    const file = path.join(config.scrape.debugDir, `${stamp}-${kind}-${step.type}-${name}.html`);
    await writeFile(file, sanitizeHtml(res.html), 'utf8');
    log.debug('HTML de depuración guardado.', { file });
  } catch (err) {
    log.debug('No se pudo guardar el HTML de depuración.', { error: err.message });
  }
}

function countStatuses(items) {
  const counts = {};
  for (const it of Object.values(items)) {
    if (it.active === false) continue;
    counts[it.status] = (counts[it.status] || 0) + 1;
  }
  return counts;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function cap(arr, max) {
  return arr.length > max ? arr.slice(arr.length - max) : arr;
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    logger.error('Error fatal en el monitor de restock.', { error: err?.message, stack: err?.stack });
    process.exit(1);
  });
