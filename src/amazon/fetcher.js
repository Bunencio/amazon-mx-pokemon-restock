import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { CookieJar } from './cookieJar.js';
import { AmazonHttpClient, DEFAULT_USER_AGENT } from './httpClient.js';
import { createBrowserSession } from './browserClient.js';
import { validatePage, isDegraded } from './pageValidator.js';
import { slugify } from '../utils/hash.js';

/**
 * One fetcher per run. Hides the transport (static HTTP, Playwright, or local
 * mock files) behind `fetchPage(step)` and exposes the session to persist.
 *
 * step = { type: 'dp'|'search'|'store', url, asin?, query?, filtered?, pageId?, scrolls? }
 * result = { status, html, finalUrl, method, elapsedMs, bytes, error? }
 */
export function createFetcher({ config, logger, session = null }) {
  const mode = config.scrape.mockHtmlDir ? 'mock' : config.scrape.fetchMode;
  const userAgent = session?.userAgent || DEFAULT_USER_AGENT;
  const jar = CookieJar.fromJSON(session?.cookies || []);
  const http = new AmazonHttpClient({
    jar,
    userAgent,
    timeoutMs: config.scrape.fetchTimeoutMs,
    maxBodyBytes: config.scrape.maxBodyBytes,
    headerProfile: config.scrape.headerProfile,
    logger,
  });

  let browser = null;
  let browserFailed = false;
  let requestCount = 0;

  async function getBrowser() {
    if (browser || browserFailed) return browser;
    try {
      browser = await createBrowserSession({
        userAgent: mode === 'playwright' ? null : userAgent,
        timeoutMs: config.scrape.renderTimeoutMs,
        storageState: session?.playwrightStorageState || null,
        logger,
      });
    } catch (err) {
      browserFailed = true;
      logger?.warn('No se pudo iniciar Playwright.', { error: err.message });
    }
    return browser;
  }

  async function fetchStatic(step) {
    requestCount += 1;
    const res = await http.get(step.url);
    return { ...res, method: 'static' };
  }

  async function fetchRendered(step) {
    const b = await getBrowser();
    if (!b) return { status: 0, html: '', finalUrl: step.url, method: 'playwright', elapsedMs: 0, bytes: 0, error: 'playwright no disponible' };
    requestCount += 1;
    return b.fetchRendered(step.url, { scrolls: step.scrolls || 0 });
  }

  async function fetchMock(step) {
    requestCount += 1;
    const candidates = mockFileNames(step).map((name) => path.join(config.scrape.mockHtmlDir, name));
    for (const file of candidates) {
      try {
        const buf = await readFile(file);
        const html = file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
        return { status: 200, html, finalUrl: step.url, method: 'mock', elapsedMs: 0, bytes: Buffer.byteLength(html), mockFile: file };
      } catch {
        /* try next candidate */
      }
    }
    return { status: 404, html: '', finalUrl: step.url, method: 'mock', elapsedMs: 0, bytes: 0, error: null, mockFile: null };
  }

  async function fetchPage(step) {
    if (mode === 'mock') return fetchMock(step);
    if (step.type === 'store' || mode === 'playwright') return fetchRendered(step);
    if (mode === 'static') return fetchStatic(step);
    // auto: static first, Playwright when the page is degraded.
    const first = await fetchStatic(step);
    const validation = validatePage({ type: step.type, ...first });
    if (!isDegraded(validation)) return first;
    logger?.info('Página degradada en modo estático; reintentando con Playwright.', { url: step.url, kind: validation.kind });
    const rendered = await fetchRendered(step);
    return rendered.error ? first : rendered;
  }

  async function exportSession() {
    const out = { cookies: jar.toJSON(), userAgent, requestCount: (session?.requestCount || 0) + requestCount };
    if (browser) {
      try {
        out.playwrightStorageState = await browser.exportStorageState();
      } catch {
        /* ignore */
      }
    }
    return out;
  }

  async function close() {
    if (browser) await browser.close().catch(() => {});
    browser = null;
  }

  return {
    mode,
    fetchPage,
    exportSession,
    close,
    get requestCount() {
      return requestCount;
    },
  };
}

/** File names the mock transport looks for, in order. */
export function mockFileNames(step) {
  const names = [];
  if (step.type === 'dp' && step.asin) names.push(`dp-${step.asin}`);
  if (step.type === 'search' && step.query) {
    const slug = slugify(step.query);
    if (step.filtered) names.push(`search-${slug}-filtered`);
    names.push(`search-${slug}`);
  }
  if (step.type === 'store' && step.pageId) names.push(`store-${step.pageId}`);
  return names.flatMap((n) => [`${n}.html`, `${n}.html.gz`]);
}
