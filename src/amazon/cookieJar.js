/**
 * Minimal RFC 6265 cookie jar, serializable to JSON so one Amazon session can
 * survive across scheduled runs (a returning session looks far less suspicious
 * than a fresh anonymous visit every 10 minutes).
 *
 * Only what the monitor needs: Set-Cookie parsing (Domain/Path/Expires/Max-Age/
 * Secure), expiry, domain + path matching and a Cookie header builder.
 */
export class CookieJar {
  #cookies = new Map();

  constructor(entries = []) {
    for (const c of entries || []) {
      if (c && c.name && c.domain) this.#put({ ...c, path: c.path || '/' });
    }
  }

  static fromJSON(entries) {
    return new CookieJar(Array.isArray(entries) ? entries : []);
  }

  /** Plain array of cookie records (expired ones dropped). */
  toJSON() {
    this.#purgeExpired();
    return [...this.#cookies.values()].map((c) => ({ ...c }));
  }

  get size() {
    this.#purgeExpired();
    return this.#cookies.size;
  }

  clear() {
    this.#cookies.clear();
  }

  /** Ingest the Set-Cookie headers of a response to `url`. */
  storeFromResponse(url, setCookieHeaders = []) {
    const requestUrl = new URL(url);
    for (const header of setCookieHeaders || []) {
      const parsed = parseSetCookie(header, requestUrl);
      if (!parsed) continue;
      if (parsed.expired) {
        this.#cookies.delete(keyOf(parsed));
        continue;
      }
      this.#put(parsed);
    }
  }

  /** "name=value; name2=value2" for the cookies that apply to `url` (empty string if none). */
  headerFor(url) {
    this.#purgeExpired();
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    const path = u.pathname || '/';
    const secure = u.protocol === 'https:';
    const matched = [...this.#cookies.values()].filter(
      (c) => domainMatches(host, c) && pathMatches(path, c.path) && (!c.secure || secure),
    );
    matched.sort((a, b) => b.path.length - a.path.length);
    return matched.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  #put(cookie) {
    this.#cookies.set(keyOf(cookie), cookie);
  }

  #purgeExpired() {
    const now = Date.now();
    for (const [key, c] of this.#cookies) {
      if (c.expires && new Date(c.expires).getTime() <= now) this.#cookies.delete(key);
    }
  }
}

function keyOf(c) {
  return `${c.domain}|${c.path}|${c.name}`;
}

function domainMatches(host, cookie) {
  if (cookie.hostOnly) return host === cookie.domain;
  return host === cookie.domain || host.endsWith(`.${cookie.domain}`);
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/** Parse one Set-Cookie header. Returns null when the cookie must be ignored. */
export function parseSetCookie(header, requestUrl) {
  if (typeof header !== 'string' || !header.trim()) return null;
  const parts = header.split(';');
  const first = parts.shift().trim();
  const eq = first.indexOf('=');
  if (eq <= 0) return null;
  const name = first.slice(0, eq).trim();
  const value = first.slice(eq + 1).trim();
  if (!name) return null;

  const host = requestUrl.hostname.toLowerCase();
  let domain = host;
  let hostOnly = true;
  let path = null;
  let expires = null;
  let maxAge = null;
  let secure = false;
  let httpOnly = false;

  for (const raw of parts) {
    const attr = raw.trim();
    if (!attr) continue;
    const i = attr.indexOf('=');
    const key = (i >= 0 ? attr.slice(0, i) : attr).trim().toLowerCase();
    const val = i >= 0 ? attr.slice(i + 1).trim() : '';
    switch (key) {
      case 'domain': {
        const d = val.replace(/^\./, '').toLowerCase();
        if (!d) break;
        // Reject cookies for domains that don't cover the request host.
        if (host !== d && !host.endsWith(`.${d}`)) return null;
        domain = d;
        hostOnly = false;
        break;
      }
      case 'path':
        path = val.startsWith('/') ? val : null;
        break;
      case 'expires': {
        const t = Date.parse(val);
        if (Number.isFinite(t)) expires = new Date(t).toISOString();
        break;
      }
      case 'max-age': {
        const n = Number.parseInt(val, 10);
        if (Number.isFinite(n)) maxAge = n;
        break;
      }
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      default:
        break;
    }
  }

  if (maxAge != null) {
    expires = maxAge <= 0 ? new Date(0).toISOString() : new Date(Date.now() + maxAge * 1000).toISOString();
  }
  if (!path) path = defaultPath(requestUrl.pathname);

  const expired = Boolean(expires) && new Date(expires).getTime() <= Date.now();
  return { name, value, domain, hostOnly, path, expires, secure, httpOnly, expired };
}

/** RFC 6265 §5.1.4 default-path. */
function defaultPath(requestPath) {
  if (!requestPath || !requestPath.startsWith('/')) return '/';
  const idx = requestPath.lastIndexOf('/');
  if (idx <= 0) return '/';
  return requestPath.slice(0, idx);
}
