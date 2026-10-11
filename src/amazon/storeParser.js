import * as cheerio from 'cheerio';
import { asinFromUrl } from './constants.js';

/**
 * Parse an Amazon brand-store page (server HTML or Playwright-rendered DOM).
 *
 *  - nav: the `"nav":{...}` JSON embedded in the page lists every sub-page
 *    ({ pageId, title, href }).
 *  - products: featured "product" tiles carry JSON with asin/availability/
 *    merchant/price; rendered grids expose `data-csa-c-item-id="amzn1.asin.X"`
 *    plus the tile title/link. Both sources are merged by ASIN.
 */
export function parseStorePage(html) {
  const nav = parseNav(html);
  const products = new Map();

  // 1) Embedded product JSON (server-side tiles).
  const productJsonRe = /"products"\s*:\s*\[\s*\{\s*"asin"\s*:\s*"([A-Z0-9]{10})"/g;
  let m;
  while ((m = productJsonRe.exec(html)) !== null) {
    const asin = m[1];
    const window = html.slice(m.index, m.index + 6000);
    const entry = products.get(asin) || { asin, source: 'store-json' };
    entry.title = entry.title || pickJson(window, 'title') || null;
    entry.availabilityText = pickJson(window, 'primaryMessage') || entry.availabilityText || null;
    entry.availabilityType = pickJsonAfter(window, '"availability"', 'type') || entry.availabilityType || null;
    entry.merchantId = pickJson(window, 'encryptedMerchantId') || entry.merchantId || null;
    entry.merchantName = pickJson(window, 'merchantName') || entry.merchantName || null;
    const price = /"priceToPay"[\s\S]{0,400}?"displayString"\s*:\s*"([^"]+)"/.exec(window);
    entry.priceText = price ? price[1] : entry.priceText || null;
    products.set(asin, entry);
  }

  // 2) Rendered tiles.
  const $ = cheerio.load(html || '');
  $('[data-csa-c-item-id^="amzn1.asin."]').each((_, el) => {
    const node = $(el);
    const asin = asinFromUrl(node.attr('data-csa-c-item-id'));
    if (!asin) return;
    const link = node.find('a[href*="/dp/"]').first();
    const title =
      clean(link.attr('title')) ||
      clean(node.find('img[alt]').first().attr('alt')) ||
      clean(node.find('[data-testid*="title"], .ProductTile__title, h3, h4').first().text()) ||
      null;
    const priceText = clean(node.find('.a-price .a-offscreen').first().text()) || null;
    const entry = products.get(asin) || { asin, source: 'store-tile' };
    entry.title = entry.title || title;
    entry.priceText = entry.priceText || priceText;
    entry.url = entry.url || (link.attr('href') ? absolutize(link.attr('href')) : null);
    products.set(asin, entry);
  });

  // 3) Any other product links in the grid.
  $('a[href*="/dp/"]').each((_, a) => {
    const asin = asinFromUrl($(a).attr('href'));
    if (!asin || products.has(asin)) return;
    const title = clean($(a).attr('title')) || clean($(a).find('img[alt]').first().attr('alt')) || null;
    products.set(asin, { asin, title, source: 'store-link', url: absolutize($(a).attr('href')) });
  });

  return { nav, products: [...products.values()] };
}

/** Sub-pages from the embedded `"nav":{...}` object. */
export function parseNav(html) {
  const out = new Map();
  const re = /"pageId"\s*:\s*"([0-9A-Fa-f-]{36})"\s*,\s*"title"\s*:\s*"([^"]*)"\s*,\s*"href"\s*:\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(html || '')) !== null) {
    if (!out.has(m[1])) out.set(m[1], { pageId: m[1], title: decodeJsonString(m[2]), href: decodeJsonString(m[3]) });
  }
  return [...out.values()];
}

function pickJson(window, key) {
  const m = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`).exec(window);
  return m ? decodeJsonString(m[1]) : null;
}

function pickJsonAfter(window, anchor, key) {
  const idx = window.indexOf(anchor);
  if (idx < 0) return null;
  return pickJson(window.slice(idx, idx + 400), key);
}

function decodeJsonString(s) {
  try {
    return JSON.parse(`"${s}"`);
  } catch {
    return s;
  }
}

function absolutize(href) {
  try {
    return new URL(href, 'https://www.amazon.com.mx').toString();
  } catch {
    return href;
  }
}

function clean(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
