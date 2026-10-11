import { CookieJar } from './cookieJar.js';

/**
 * Plain-HTTP page fetcher that behaves like one ordinary Chrome tab:
 *  - consistent navigation headers derived from a single User-Agent,
 *  - a persistent cookie jar (Set-Cookie captured on every redirect hop),
 *  - Referer = previous page on the same origin,
 *  - manual redirects (≤ 5 hops), timeout, body size cap.
 *
 * COMPLIANCE: no CAPTCHA solving, no stealth tricks, no login. When Amazon
 * answers with a challenge or a degraded page we report it and back off.
 */

export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function chromeMajor(userAgent) {
  const m = /Chrome\/(\d+)/.exec(userAgent || '');
  return m ? m[1] : '148';
}

/**
 * Request headers. `profile`:
 *   chrome  — the full set Chrome sends on a top-level navigation (client hints, Sec-Fetch-*).
 *   minimal — only UA / Accept / Accept-Language (what a plain .NET or curl client sends).
 */
export function buildNavigationHeaders({ userAgent = DEFAULT_USER_AGENT, referer = null, cookie = '', profile = 'chrome' } = {}) {
  if (profile === 'minimal') {
    const minimal = {
      'User-Agent': userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
    };
    if (referer) minimal.Referer = referer;
    if (cookie) minimal.Cookie = cookie;
    return minimal;
  }
  const major = chromeMajor(userAgent);
  const headers = {
    'User-Agent': userAgent,
    Accept:
      'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Language': 'es-MX,es;q=0.9,en;q=0.8',
    'Sec-Ch-Ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not-A.Brand";v="99"`,
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': referer ? 'same-origin' : 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
  };
  if (referer) headers.Referer = referer;
  if (cookie) headers.Cookie = cookie;
  return headers;
}

export class AmazonHttpClient {
  constructor({ jar = new CookieJar(), userAgent = DEFAULT_USER_AGENT, timeoutMs = 20_000, maxBodyBytes = 6_000_000, headerProfile = 'chrome', logger } = {}) {
    this.jar = jar;
    this.userAgent = userAgent;
    this.headerProfile = headerProfile;
    this.timeoutMs = timeoutMs;
    this.maxBodyBytes = maxBodyBytes;
    this.logger = logger;
    this.lastUrl = null;
    this.requestCount = 0;
  }

  /**
   * GET a page. Never throws: network/timeout problems come back as
   * `{ status: 0, error }` so the caller can classify them.
   */
  async get(url) {
    const started = Date.now();
    let current = url;
    let redirects = 0;
    const hops = [];

    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const referer = sameOrigin(this.lastUrl, current) ? this.lastUrl : null;
        const headers = buildNavigationHeaders({ userAgent: this.userAgent, referer, cookie: this.jar.headerFor(current), profile: this.headerProfile });
        const res = await fetch(current, {
          method: 'GET',
          headers,
          redirect: 'manual',
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        this.requestCount += 1;

        const setCookies = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
        this.jar.storeFromResponse(current, setCookies);

        if (REDIRECT_STATUSES.has(res.status)) {
          const location = res.headers.get('location');
          await res.arrayBuffer().catch(() => {});
          if (!location || redirects >= MAX_REDIRECTS) {
            return { status: res.status, finalUrl: current, html: '', bytes: 0, redirects, hops, elapsedMs: Date.now() - started };
          }
          current = new URL(location, current).toString();
          redirects += 1;
          hops.push(current);
          continue;
        }

        const html = await readBodyCapped(res, this.maxBodyBytes);
        this.lastUrl = current;
        return { status: res.status, finalUrl: current, html, bytes: Buffer.byteLength(html), redirects, hops, elapsedMs: Date.now() - started };
      }
    } catch (error) {
      this.logger?.debug('HTTP fetch failed.', { url: current, error: error?.message });
      return {
        status: 0,
        finalUrl: current,
        html: '',
        bytes: 0,
        redirects,
        hops,
        elapsedMs: Date.now() - started,
        error: error?.name === 'TimeoutError' ? `timeout after ${this.timeoutMs} ms` : error?.message || String(error),
      };
    }
  }
}

function sameOrigin(a, b) {
  if (!a || !b) return false;
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function readBodyCapped(res, cap) {
  if (!res.body) return res.text();
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}
