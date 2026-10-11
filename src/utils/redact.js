/**
 * Secret redaction. Two layers:
 *   1. registerSecret(value) — exact known secret strings (tokens, keys, webhook
 *      urls, gist ids) are scrubbed from ANY logged string.
 *   2. redactKeys(obj) — defensively masks object keys whose name looks sensitive
 *      (tokens, cookies, authorization...). Cookie values never reach the logs.
 */

const KNOWN_SECRETS = new Set();

const SENSITIVE_KEY_RE = /(token|secret|api[-_]?key|authorization|auth|password|passwd|webhook|cookie|set-cookie|bearer|session-id|ubid)/i;

const MASK = '***REDACTED***';

/** Register a literal secret value so it is scrubbed from all future log output. */
export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 6) {
    KNOWN_SECRETS.add(value);
  }
}

/** Replace any registered secret substrings inside a string with the mask. */
export function redactString(input) {
  if (typeof input !== 'string' || input.length === 0) return input;
  let out = input;
  for (const secret of KNOWN_SECRETS) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  // Belt-and-suspenders: mask common token shapes even if not registered.
  out = out
    .replace(/\b(Bot\s+)[A-Za-z0-9._-]{20,}\b/g, `$1${MASK}`)
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{20,})\b/g, MASK)
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, MASK)
    .replace(/(discord(?:app)?\.com\/api\/webhooks\/\d+\/)[A-Za-z0-9._-]+/gi, `$1${MASK}`)
    .replace(/(session-id=)\d{3}-\d{7}-\d{7}/g, `$1${MASK}`);
  return out;
}

/** Deep-clone an object, masking values whose key name looks sensitive. */
export function redactKeys(value, seen = new WeakSet()) {
  if (value == null) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value !== 'object') return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redactKeys(v, seen));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    if (SENSITIVE_KEY_RE.test(key)) {
      out[key] = typeof val === 'string' && val.length ? MASK : val;
    } else {
      out[key] = redactKeys(val, seen);
    }
  }
  return out;
}
