/**
 * Playwright-backed page loader (lazy import so the dependency stays optional).
 *
 * Used when plain HTTP is degraded (datacenter IPs get 503 / fallback pages)
 * and for pages that only render through JavaScript (brand-store grids).
 * It is an ordinary headless Chromium with es-MX locale and CDMX timezone — no
 * stealth plugins, no CAPTCHA handling.
 */
export async function createBrowserSession({ userAgent = null, timeoutMs = 45_000, storageState = null, logger } = {}) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    throw new Error(`Playwright no está disponible: ${err.message}`);
  }

  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const version = browser.version(); // e.g. "148.0.7700.0"
  const major = version.split('.')[0] || '148';
  const ua =
    userAgent ||
    `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;

  const context = await browser.newContext({
    userAgent: ua,
    locale: 'es-MX',
    timezoneId: 'America/Mexico_City',
    viewport: { width: 1366, height: 900 },
    ...(storageState ? { storageState } : {}),
  });

  // Skip heavy resources; the HTML is all we parse.
  await context.route('**/*', (route) => {
    const type = route.request().resourceType();
    if (type === 'image' || type === 'media' || type === 'font') return route.abort();
    return route.continue();
  });

  let pageCount = 0;

  async function fetchRendered(
    url,
    { waitForSelector = '#dp, #ppd, .s-main-slot, #captchacharacters, #all-offers-display, .stores-page', scrolls = 0 } = {},
  ) {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    pageCount += 1;
    const started = Date.now();
    try {
      const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const status = response?.status() ?? 0;
      await page.waitForSelector(waitForSelector, { timeout: Math.min(timeoutMs, 15_000) }).catch(() => {});
      for (let i = 0; i < scrolls; i += 1) {
        await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight)).catch(() => {});
        await page.waitForTimeout(700);
      }
      if (scrolls > 0) await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
      const html = await page.content();
      return { status, html, finalUrl: page.url(), method: 'playwright', elapsedMs: Date.now() - started, bytes: Buffer.byteLength(html) };
    } catch (err) {
      logger?.warn('Playwright render failed.', { url, error: err.message });
      return { status: 0, html: '', finalUrl: url, method: 'playwright', elapsedMs: Date.now() - started, bytes: 0, error: err.message };
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * Visit the home page once, like a person opening Amazon before browsing.
   * Only used for brand-new sessions (no storageState): deep-linking straight
   * into product pages with an empty cookie jar is a classic bot pattern.
   */
  async function warmUp(homeUrl = 'https://www.amazon.com.mx/') {
    const page = await context.newPage();
    page.setDefaultTimeout(timeoutMs);
    const started = Date.now();
    try {
      const response = await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      await page.waitForSelector('#nav-logo, #nav-main, #captchacharacters', { timeout: 10_000 }).catch(() => {});
      await page.waitForTimeout(1_200 + Math.floor(Math.random() * 1_300));
      const html = await page.content();
      return { status: response?.status() ?? 0, html, finalUrl: page.url(), method: 'playwright', elapsedMs: Date.now() - started, bytes: Buffer.byteLength(html) };
    } catch (err) {
      logger?.warn('Warm-up de la portada falló.', { error: err.message });
      return { status: 0, html: '', finalUrl: homeUrl, method: 'playwright', elapsedMs: Date.now() - started, bytes: 0, error: err.message };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async function exportStorageState() {
    return context.storageState();
  }

  async function close() {
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }

  return {
    fetchRendered,
    warmUp,
    exportStorageState,
    close,
    userAgent: ua,
    version,
    get pageCount() {
      return pageCount;
    },
  };
}
