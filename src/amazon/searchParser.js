import * as cheerio from 'cheerio';
import { BASE_URL, asinFromUrl } from './constants.js';
import { parsePrice } from './dpParser.js';

/**
 * Parse an Amazon México search results page into cards.
 *
 * Sponsored cards ignore the seller refinement (p_6), so they are flagged and
 * excluded from any "Amazon México offers this ASIN" inference.
 */
const UNAVAILABLE_RE = /no disponible por el momento|no disponible\b|agotado/i;
const SPONSORED_RE = /\bPatrocinado\b/;

export function parseSearchResults(html, { base = BASE_URL } = {}) {
  const $ = cheerio.load(html || '');
  const cards = [];
  const seen = new Set();

  $('div[data-component-type="s-search-result"][data-asin]').each((_, el) => {
    const card = $(el);
    const asin = String(card.attr('data-asin') || '').trim().toUpperCase();
    if (!/^[A-Z0-9]{10}$/.test(asin) || seen.has(asin)) return;
    seen.add(asin);

    const title =
      clean(card.find('h2 a span').first().text()) ||
      clean(card.find('h2 span').first().text()) ||
      clean(card.find('[data-cy="title-recipe"] span').first().text()) ||
      clean(card.find('h2').first().text());

    const href = card.find('h2 a').first().attr('href') || card.find('a.a-link-normal.s-no-outline').first().attr('href') || '';
    const url = href ? absolutize(href, base) : `${base}/dp/${asin}`;

    const cardText = clean(card.text());
    const sponsored =
      card.find('.puis-sponsored-label-text, [data-component-type="sp-sponsored-result"], .s-sponsored-label-info-icon').length > 0 ||
      /\/sspa\/click/.test(href) ||
      card.find('a[href*="/sspa/click"]').length > 0 ||
      SPONSORED_RE.test(cardText);

    const priceText = clean(card.find('.a-price .a-offscreen').first().text()) || null;

    cards.push({
      asin,
      title: title || null,
      url,
      priceText,
      priceAmount: parsePrice(priceText),
      unavailable: UNAVAILABLE_RE.test(cardText),
      sponsored,
      image: card.find('img.s-image').first().attr('src') || null,
    });
  });

  const hasMainSlot = $('.s-main-slot').length > 0;
  const noResults = /No se encontraron resultados|no coincide con ning/i.test($('body').text());

  return { cards, organic: cards.filter((c) => !c.sponsored), hasMainSlot, noResults };
}

function absolutize(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    const asin = asinFromUrl(href);
    return asin ? `${base}/dp/${asin}` : href;
  }
}

function clean(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}
