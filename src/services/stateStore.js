import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { PARSER_VERSION } from '../amazon/constants.js';

/**
 * State shapes + a plain JSON-file store.
 *
 *  shared state  — what both runners (PC, Actions) must agree on: per-ASIN status,
 *                  dedupe keys, discoveries, heartbeats. Never contains secrets.
 *  runner state  — per-machine: Amazon session (cookies / Playwright storage),
 *                  backoff, adaptive budget. Never shared.
 */

export const SHARED_SCHEMA_VERSION = 1;
export const RUNNER_SCHEMA_VERSION = 1;

export function createEmptySharedState() {
  return {
    schemaVersion: SHARED_SCHEMA_VERSION,
    parserVersion: PARSER_VERSION,
    savedAt: null,
    savedBy: null,
    runners: {},
    tasks: { discoverySearch: { lastAt: null }, storeSweep: { lastAt: null }, roundRobinCursor: 0, filteredQueryParity: 0 },
    items: {},
    discovery: {},
    pendingAlerts: [],
    sentKeys: [],
    history: [],
  };
}

export function normalizeSharedState(raw) {
  const base = createEmptySharedState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    schemaVersion: SHARED_SCHEMA_VERSION,
    runners: isObject(raw.runners) ? raw.runners : {},
    tasks: { ...base.tasks, ...(isObject(raw.tasks) ? raw.tasks : {}) },
    items: isObject(raw.items) ? raw.items : {},
    discovery: isObject(raw.discovery) ? raw.discovery : {},
    pendingAlerts: Array.isArray(raw.pendingAlerts) ? raw.pendingAlerts : [],
    sentKeys: Array.isArray(raw.sentKeys) ? raw.sentKeys : [],
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

export function createEmptyRunnerState(runnerId) {
  return {
    schemaVersion: RUNNER_SCHEMA_VERSION,
    runnerId,
    session: null, // { cookies, userAgent, requestCount, playwrightStorageState }
    backoff: { level: 0, until: null, lastBlockAt: null, lastCleanAt: null },
    budget: { maxRequestsPerRun: null },
    runCounter: 0,
    lastRunAt: null,
  };
}

export function normalizeRunnerState(raw, runnerId) {
  const base = createEmptyRunnerState(runnerId);
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    schemaVersion: RUNNER_SCHEMA_VERSION,
    runnerId: raw.runnerId || runnerId,
    backoff: { ...base.backoff, ...(isObject(raw.backoff) ? raw.backoff : {}) },
    budget: { ...base.budget, ...(isObject(raw.budget) ? raw.budget : {}) },
  };
}

/** Pick the most recently saved of two shared-state candidates. */
export function pickNewer(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const ta = Date.parse(a.savedAt || 0) || 0;
  const tb = Date.parse(b.savedAt || 0) || 0;
  return tb > ta ? b : a;
}

/** Local JSON file store. `normalize` coerces whatever is on disk into a valid shape. */
export class JsonFileStore {
  constructor(filePath, { logger, normalize = (x) => x, backend = 'local-file' } = {}) {
    this.filePath = filePath;
    this.logger = logger;
    this.normalize = normalize;
    this.backend = backend;
  }

  async load() {
    try {
      const buf = await readFile(this.filePath, 'utf8');
      return this.normalize(JSON.parse(buf));
    } catch (err) {
      if (err.code === 'ENOENT') {
        this.logger?.info('Sin archivo de estado; se empieza de cero.', { filePath: this.filePath });
        return null;
      }
      this.logger?.warn('No se pudo leer el estado local; se empieza de cero.', { filePath: this.filePath, error: err.message });
      return null;
    }
  }

  async save(state) {
    await writeJson(this.filePath, this.normalize(state));
    this.logger?.debug('Estado guardado en archivo local.', { filePath: this.filePath });
  }
}

export async function writeJson(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

export async function readJsonOrNull(filePath) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
