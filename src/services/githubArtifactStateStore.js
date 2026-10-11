import AdmZip from 'adm-zip';
import { retry } from '../utils/retry.js';
import { normalizeSharedState, readJsonOrNull, writeJson } from './stateStore.js';

/**
 * GitHub-artifact-backed shared state (fallback for Actions runs without a gist).
 *
 *   load(): newest non-expired artifact named `artifactName` → zip → first .json.
 *           Needs `actions: read` on GITHUB_TOKEN. Falls back to the local file.
 *   save(): writes the local file; the workflow's upload-artifact step uploads it.
 *
 * Caveat: this state is NOT visible to the PC runner, so with this backend each
 * runner tracks items independently (see README, "Sin gist").
 */
export class GitHubArtifactStateStore {
  constructor({ apiUrl, repository, token, artifactName, localFilePath, logger }) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.repository = repository; // "owner/repo"
    this.token = token;
    this.artifactName = artifactName;
    this.localFilePath = localFilePath;
    this.logger = logger;
    this.backend = 'github-artifact';
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
    try {
      const artifact = await this.#findLatestArtifact();
      if (!artifact) {
        this.logger?.info('Sin artifact previo de estado; se intenta el archivo local.', { artifactName: this.artifactName });
        return this.#loadLocal();
      }
      this.logger?.info('Artifact de estado encontrado.', { id: artifact.id, created_at: artifact.created_at, size_in_bytes: artifact.size_in_bytes });
      const json = await this.#downloadArtifactJson(artifact);
      return json ? normalizeSharedState(json) : this.#loadLocal();
    } catch (err) {
      this.logger?.warn('Falló la carga del artifact; usando archivo local.', { error: err.message });
      return this.#loadLocal();
    }
  }

  async save(state) {
    await writeJson(this.localFilePath, normalizeSharedState(state));
    this.logger?.debug('Estado escrito para subirlo como artifact.', { filePath: this.localFilePath });
  }

  async #findLatestArtifact() {
    const url = `${this.apiUrl}/repos/${this.repository}/actions/artifacts?per_page=100&name=${encodeURIComponent(this.artifactName)}`;
    const res = await retry(() => fetchJson(url, { headers: this.#headers }), {
      retries: 3,
      baseMs: 800,
      shouldRetry: isTransient,
      onRetry: ({ attempt, error }) => this.logger?.warn('Reintentando listado de artifacts.', { attempt, error: error.message }),
    });
    const artifacts = Array.isArray(res?.artifacts) ? res.artifacts : [];
    return (
      artifacts
        .filter((a) => a.name === this.artifactName && !a.expired)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0] || null
    );
  }

  async #downloadArtifactJson(artifact) {
    const buf = await retry(
      () =>
        fetch(artifact.archive_download_url, { headers: this.#headers, redirect: 'follow' }).then(async (r) => {
          if (!r.ok) throw httpError('descarga de artifact', r.status, await safeText(r));
          return Buffer.from(await r.arrayBuffer());
        }),
      { retries: 3, baseMs: 800, shouldRetry: isTransient },
    );
    const zip = new AdmZip(buf);
    const entry = zip.getEntries().find((e) => e.entryName.toLowerCase().endsWith('.json'));
    if (!entry) return null;
    try {
      return JSON.parse(entry.getData().toString('utf8'));
    } catch (err) {
      this.logger?.warn('El JSON del artifact no se pudo parsear.', { error: err.message });
      return null;
    }
  }

  async #loadLocal() {
    const raw = await readJsonOrNull(this.localFilePath);
    return raw ? normalizeSharedState(raw) : null;
  }
}

async function fetchJson(url, opts) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw httpError('github api', res.status, await safeText(res));
  return res.json();
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
