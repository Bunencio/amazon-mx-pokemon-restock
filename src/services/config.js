import 'dotenv/config';
import { registerSecret } from '../utils/redact.js';

/**
 * Centralized configuration, loaded once at import time.
 *
 *  - Secrets are OPTIONAL at load time so the worker can run in local dry-run
 *    mode without credentials. Each service checks what it needs when called.
 *  - SEND_DISCORD defaults to ON in GitHub Actions and OFF locally, so a local
 *    run never accidentally posts to Discord. run-monitor.cmd sets it to true.
 */

const env = process.env;
const isCI = env.GITHUB_ACTIONS === 'true';

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'y']);
const FALSY = new Set(['0', 'false', 'no', 'off', 'n', '']);

export function boolEnv(value, fallback) {
  if (value == null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (TRUTHY.has(s)) return true;
  if (FALSY.has(s)) return false;
  return fallback;
}

export function intEnv(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function strEnv(value, fallback = '') {
  const s = (value ?? '').toString().trim();
  return s.length ? s : fallback;
}

export function listEnv(value, fallback) {
  if (!value) return fallback;
  const arr = String(value)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return arr.length ? arr : fallback;
}

function oneOf(value, allowed, fallback) {
  const s = strEnv(value, fallback).toLowerCase();
  return allowed.includes(s) ? s : fallback;
}

const runnerId = strEnv(env.RUNNER_ID, isCI ? 'actions' : 'pc').toLowerCase();
const eventName = strEnv(env.GITHUB_EVENT_NAME);

const sendDiscord = boolEnv(env.SEND_DISCORD, isCI);
const botToken = strEnv(env.DISCORD_BOT_TOKEN);
const channelId = strEnv(env.DISCORD_CHANNEL_ID);
const webhookUrl = strEnv(env.DISCORD_WEBHOOK_URL);
const mentionRoleId = strEnv(env.DISCORD_MENTION_ROLE_ID);
const gistId = strEnv(env.GIST_ID);
const gistToken = strEnv(env.GIST_TOKEN);
const githubToken = strEnv(env.GITHUB_TOKEN);

// Register every secret so it can never leak into logs.
for (const s of [botToken, webhookUrl, gistToken, githubToken, gistId]) registerSecret(s);

const discordMode = !sendDiscord ? 'dry-run' : botToken && channelId ? 'bot' : webhookUrl ? 'webhook' : 'unconfigured';

export const config = Object.freeze({
  isCI,
  eventName,
  runnerId,
  timezone: strEnv(env.TIMEZONE, 'America/Mexico_City'),

  amazon: {
    baseUrl: 'https://www.amazon.com.mx',
    merchantId: strEnv(env.AMAZON_MERCHANT_ID, 'AVDBXBAVVSXLQ'),
    marketplaceId: 'A1AM78C64UM0Y8',
  },

  watchlistFile: strEnv(env.WATCHLIST_FILE, 'watchlist.json'),

  scrape: {
    // Playwright everywhere by default: on 2026-10-10 plain Node fetch from the PC's
    // residential IP got Amazon's robot check / Akamai interstitial while a real
    // Chromium received full pages. `static` stays available for experiments.
    fetchMode: oneOf(env.FETCH_MODE, ['static', 'playwright', 'auto'], 'playwright'),
    headerProfile: oneOf(env.HEADER_PROFILE, ['chrome', 'minimal'], 'chrome'),
    maxRequestsPerRun: intEnv(env.MAX_REQUESTS_PER_RUN, isCI ? 5 : 10),
    jitterMinMs: intEnv(env.JITTER_MIN_MS, 2_000),
    jitterMaxMs: intEnv(env.JITTER_MAX_MS, 5_000),
    runDeadlineMs: intEnv(env.RUN_DEADLINE_MS, 390_000),
    fetchTimeoutMs: intEnv(env.FETCH_TIMEOUT_MS, 20_000),
    renderTimeoutMs: intEnv(env.RENDER_TIMEOUT_MS, 45_000),
    maxBodyBytes: intEnv(env.MAX_BODY_BYTES, 6_000_000),
    saveDebugHtml: boolEnv(env.SAVE_DEBUG_HTML, isCI),
    debugDir: strEnv(env.DEBUG_DIR, 'debug'),
    mockHtmlDir: strEnv(env.MOCK_HTML_DIR),
  },

  tasks: {
    discoveryIntervalMin: intEnv(env.DISCOVERY_INTERVAL_MIN, 60),
    storeSweepEnabled: boolEnv(env.STORE_SWEEP_ENABLED, !isCI),
    storeSweepIntervalMin: intEnv(env.STORE_SWEEP_INTERVAL_MIN, 1440),
    storeSweepHours: strEnv(env.STORE_SWEEP_HOURS, '09-22'),
  },

  alerts: {
    alertOnFirstObservation: boolEnv(env.ALERT_ON_FIRST_OBSERVATION, true),
    cooldownMin: intEnv(env.ALERT_COOLDOWN_MIN, 30),
    mentionOnInStock: boolEnv(env.MENTION_ON_IN_STOCK, true),
    mentionOnPreorder: boolEnv(env.MENTION_ON_PREORDER, true),
    notifyOnDiscovery: boolEnv(env.NOTIFY_ON_DISCOVERY, false),
    sendDailyHeartbeat: boolEnv(env.SEND_DAILY_HEARTBEAT, false),
    sentKeysMax: intEnv(env.SENT_KEYS_MAX, 500),
    historyMax: intEnv(env.HISTORY_MAX, 200),
    pendingAlertMaxAgeMin: intEnv(env.PENDING_ALERT_MAX_AGE_MIN, 30),
  },

  failover: {
    deferToPc: boolEnv(env.DEFER_TO_PC, isCI),
    primaryRunnerId: strEnv(env.PRIMARY_RUNNER_ID, 'pc'),
    pcFreshMinutes: intEnv(env.PC_FRESH_MINUTES, 25),
    watchdogStaleMinutes: intEnv(env.WATCHDOG_STALE_MINUTES, 45),
  },

  discord: {
    mode: discordMode, // 'bot' | 'webhook' | 'dry-run' | 'unconfigured'
    sendDiscord,
    botToken,
    channelId,
    webhookUrl,
    mentionRoleId,
    apiBase: 'https://discord.com/api/v10',
  },

  state: {
    backend: oneOf(env.STATE_BACKEND, ['auto', 'gist', 'local', 'artifact'], 'auto'),
    gistId,
    gistToken,
    gistFileName: strEnv(env.GIST_FILE_NAME, 'pokemon-restock-state.json'),
    sharedFile: strEnv(env.STATE_FILE, 'state/shared.json'),
    runnerFile: strEnv(env.RUNNER_STATE_FILE, `state/runner-${runnerId}.json`),
    artifactName: strEnv(env.ARTIFACT_NAME, 'pokemon-restock-shared-state'),
  },

  github: {
    token: githubToken,
    repository: strEnv(env.GITHUB_REPOSITORY), // "owner/repo"
    apiUrl: strEnv(env.GITHUB_API_URL, 'https://api.github.com'),
    serverUrl: strEnv(env.GITHUB_SERVER_URL, 'https://github.com'),
    runId: strEnv(env.GITHUB_RUN_ID),
  },

  debug: {
    onlyAsin: strEnv(env.ONLY_ASIN).toUpperCase(),
    forceRun: boolEnv(env.FORCE_RUN, false),
    simulate: strEnv(env.SIMULATE),
  },

  log: {
    level: strEnv(env.LOG_LEVEL, 'info'),
    pretty: boolEnv(env.LOG_PRETTY, !isCI),
  },
});

/** Which shared-state backend will actually be used for this config. */
export function resolveStateBackend(cfg = config) {
  if (cfg.state.backend !== 'auto') return cfg.state.backend;
  if (cfg.state.gistId && cfg.state.gistToken) return 'gist';
  if (cfg.isCI && cfg.github.token && cfg.github.repository) return 'artifact';
  return 'local';
}

/** A secret-free view of config, safe to log at startup. */
export function summarizeConfig(cfg = config) {
  return {
    isCI: cfg.isCI,
    runnerId: cfg.runnerId,
    eventName: cfg.eventName || null,
    fetchMode: cfg.scrape.fetchMode,
    maxRequestsPerRun: cfg.scrape.maxRequestsPerRun,
    mock: Boolean(cfg.scrape.mockHtmlDir),
    discordMode: cfg.discord.mode,
    discordHasBotToken: Boolean(cfg.discord.botToken),
    discordHasChannel: Boolean(cfg.discord.channelId),
    discordHasRole: Boolean(cfg.discord.mentionRoleId),
    stateBackend: resolveStateBackend(cfg),
    deferToPc: cfg.failover.deferToPc,
    alertOnFirstObservation: cfg.alerts.alertOnFirstObservation,
    cooldownMin: cfg.alerts.cooldownMin,
    storeSweepEnabled: cfg.tasks.storeSweepEnabled,
    onlyAsin: cfg.debug.onlyAsin || null,
    simulate: cfg.debug.simulate || null,
  };
}
