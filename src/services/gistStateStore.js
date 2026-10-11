import { retry } from '../utils/retry.js';
import { nowIso } from '../utils/time.js';
import { normalizeSharedState, pickNewer, readJsonOrNull, writeJson } from './stateStore.js';

/**
 * Shared state in a secret GitHub Gist, so the PC runner and the GitHub Actions
 * runner see the same per-ASIN status, dedupe keys and heartbeats.
 *
 *  load(): GET /gists/{id} → file content (raw_url when truncated) → newest of
 *          gist vs local fallback file (by savedAt).
 *  save(): PATCH /gists/{id} with retry; always mirrors to the local file so a
 *          gist outage never loses state.
 *
 * Requires a CLASSIC personal access token with only the `gist` scope.
 */
export class GistStateStore {
  constructor({ gistId, token, fileName = 'pokemon-restock-state.json', apiUrl = 'https://api.github.com', localFallbackPath, logger }) {
    this.gistId = gistId;
    this.token = token;
    this.fileName = fileName;
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.localFallbackPath = localFallbackPath;
    this.logger = logger;
    this.backend = 'gist';
    this.lastSaveOk = null;
  }

  get #headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'amazon-mx-pokemon-restock',
    };
  }

  async load() {
    const local = this.localFallbackPath ? normalizeOrNull(await readJsonOrNull(this.localFallbackPath)) : null;
    try {
      const gist = await retry(() => this.#request(`/gists/${this.gistId}`), {
        retries: 3,
        baseMs: 800,
        shouldRetry: isTransient,
        onRetry: ({ attempt, error }) => this.logger?.warn('Reintentando lectura del gist.', { attempt, error: error.message }),
      });
      const file = gist?.files?.[this.fileName];
      if (!file) {
        this.logger?.info('El gist aún no tiene el archivo de estado; se empieza de cero.', { fileName: this.fileName });
        return local;
      }
      let content = file.content;
      if (file.truncated && file.raw_url) {
        const res = await fetch(file.raw_url, { headers: this.#headers, signal: AbortSignal.timeout(30_000) });
        if (!res.ok) throw httpError('gist raw', res.status, await safeText(res));
        content = await res.text();
      }
      const remote = normalizeOrNull(safeJson(content));
      const chosen = pickNewer(remote, local);
      this.logger?.info('Estado compartido cargado desde el gist.', {
        savedAt: remote?.savedAt || null,
        savedBy: remote?.savedBy || null,
        usedLocalFallback: chosen !== remote,
      });
      return chosen;
    } catch (err) {
      this.logger?.warn('No se pudo leer el gist; usando archivo local.', { error: err.message });
      return local;
    }
  }

  async save(state) {
    const normalized = normalizeSharedState(state);
    normalized.savedAt = nowIso();
    const body = JSON.stringify({ files: { [this.fileName]: { content: JSON.stringify(normalized, null, 2) } } });
    try {
      await retry(() => this.#request(`/gists/${this.gistId}`, { method: 'PATCH', body }), {
        retries: 3,
        baseMs: 1000,
        shouldRetry: isTransient,
        onRetry: ({ attempt, error }) => this.logger?.warn('Reintentando escritura del gist.', { attempt, error: error.message }),
      });
      this.lastSaveOk = true;
      this.logger?.debug('Estado compartido guardado en el gist.', { bytes: body.length });
    } catch (err) {
      this.lastSaveOk = false;
      this.logger?.error('No se pudo guardar el gist; el estado queda solo en el archivo local.', { error: err.message });
    }
    if (this.localFallbackPath) await writeJson(this.localFallbackPath, normalized);
  }

  async #request(path, init = {}) {
    const res = await fetch(`${this.apiUrl}${path}`, {
      ...init,
      headers: { ...this.#headers, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw httpError('gist api', res.status, await safeText(res));
    return res.json();
  }
}

/** Create the secret gist that will hold the shared state. Returns its id. */
export async function createStateGist({ token, fileName = 'pokemon-restock-state.json', description = 'Pokémon Restock Monitor — estado compartido', apiUrl = 'https://api.github.com', initialState }) {
  const res = await fetch(`${apiUrl.replace(/\/$/, '')}/gists`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'amazon-mx-pokemon-restock',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ description, public: false, files: { [fileName]: { content: JSON.stringify(initialState, null, 2) } } }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw httpError('crear gist', res.status, await safeText(res));
  const data = await res.json();
  return { id: data.id, url: data.html_url, scopes: res.headers.get('x-oauth-scopes') };
}

function normalizeOrNull(raw) {
  return raw ? normalizeSharedState(raw) : null;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function httpError(what, status, body) {
  const err = new Error(`${what} falló con HTTP ${status}: ${String(body).slice(0, 200)}`);
  err.status = status;
  return err;
}

function isTransient(err) {
  const s = err?.status;
  return s == null || s === 429 || (s >= 500 && s < 600);
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
