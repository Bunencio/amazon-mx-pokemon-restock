import { createHash } from 'node:crypto';

/**
 * Deterministic JSON stringify: object keys are sorted recursively so that two
 * logically-equal objects always produce the same string (and the same hash).
 */
export function stableStringify(value) {
  return JSON.stringify(sortValue(value));
}

function sortValue(value) {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortValue(value[key]);
    return out;
  }
  return value;
}

/** SHA-256 hex digest of a string. */
export function sha256Hex(input) {
  return createHash('sha256').update(String(input)).digest('hex');
}

/** Stable SHA-256 of any JSON-serializable value. */
export function hashObject(value) {
  return sha256Hex(stableStringify(value));
}

/** Short, stable hash (default 12 hex chars) — handy for keys and dedupe ids. */
export function shortHash(value, length = 12) {
  const hex = typeof value === 'string' ? sha256Hex(value) : hashObject(value);
  return hex.slice(0, length);
}

/** Turn arbitrary text into a stable, url/key-safe slug (accents stripped). */
export function slugify(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}
