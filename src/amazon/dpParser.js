import * as cheerio from 'cheerio';
import { asinFromUrl } from './constants.js';

/**
 * Parse an Amazon México product (detail) page into plain facts. No decisions
 * here — `offerClassifier.js` turns these facts into a status.
 *
 * Selectors verified on real pages (2026-10-10):
 *   input#merchantID                      → buybox seller id (AVDBXBAVVSXLQ = Amazon México)
 *   [data-csa-c-slot-id="odf-feature-text-desktop-merchant-info"] .offer-display-feature-text-message
 *                                         → "Amazon México" (no link) or seller name
 *   a#sellerProfileTriggerId[href*=seller=] → third-party seller link
 *   [data-csa-c-slot-id="odf-feature-text-desktop-fulfiller-info"] … → "Amazon" (FBA) / seller
 *   #availability .primary-availability-message → "Disponible" / "Sólo queda(n) N en stock." / "No disponible por el momento."
 *   .priceToPay .a-offscreen              → "$1,099.00"
 *   #add-to-cart-button / #buy-now-button
 */

export const PREORDER_BUTTON_RE = /pre-?orden|pre-?venta|preventa|reserv/i;

export function parseDetailPage(html) {
  const $ = cheerio.load(html || '');
  // Inline scripts/styles pollute `.text()` (e.g. the offers widget ships CSS + JS).
  $('script, style, noscript').remove();
  const text = (selector) => clean($(selector).first().text());

  const asin =
    attr($, 'input#ASIN', 'value') ||
    attr($, '[data-csa-c-asin]', 'data-csa-c-asin') ||
    asinFromUrl(attr($, 'link[rel="canonical"]', 'href')) ||
    null;

  const title = text('#productTitle') || titleFromHead($('title').text()) || null;

  const sellerLink = $('a#sellerProfileTriggerId').first();
  const sellerLinkId = sellerIdFromHref(sellerLink.attr('href'));
  const merchantIdRaw = clean(attr($, 'input#merchantID', 'value')).toUpperCase();
  const merchantId = /^[A-Z0-9]{10,16}$/.test(merchantIdRaw) ? merchantIdRaw : sellerLinkId || null;

  const merchantName =
    text('[data-csa-c-slot-id="odf-feature-text-desktop-merchant-info"] .offer-display-feature-text-message') ||
    clean(sellerLink.text()) ||
    text('#tabular-buybox .tabular-buybox-text[tabular-attribute-name="Vendido por"]') ||
    merchantFromLegacy($('#merchant-info').first().text()) ||
    null;

  const fulfiller =
    text('[data-csa-c-slot-id="odf-feature-text-desktop-fulfiller-info"] .offer-display-feature-text-message') ||
    text('#tabular-buybox .tabular-buybox-text[tabular-attribute-name="Enviado por"]') ||
    null;

  const availabilityText =
    firstNonEmpty([
      text('#availability .primary-availability-message'),
      text('#availability span'),
      text('#availability'),
      text('#outOfStock'),
      text('#availabilityInsideBuyBox_feature_div'),
    ]) || null;

  const addToCartEl = $('#add-to-cart-button').first();
  const buyNowEl = $('#buy-now-button').first();
  const addToCart = addToCartEl.length > 0 && !isDisabled(addToCartEl);
  const buyNow = buyNowEl.length > 0 && !isDisabled(buyNowEl);

  const buttonEls = [addToCartEl, buyNowEl, $('input[name="submit.preorder"]').first(), $('[id*="preorder"]').first()];
  const buttonLabels = dedupe(buttonEls.filter((el) => el.length > 0).map((el) => buttonLabel($, el)).filter(Boolean));
  const preorderButton = buttonLabels.some((label) => PREORDER_BUTTON_RE.test(label));

  const priceText =
    firstNonEmpty([
      text('#corePrice_feature_div .priceToPay .a-offscreen'),
      text('#apex_desktop .priceToPay .a-offscreen'),
      text('.priceToPay .a-offscreen'),
      text('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen'),
      text('#corePrice_desktop .a-price .a-offscreen'),
      text('#price_inside_buybox'),
      text('#priceblock_ourprice'),
      text('#desktop_buybox .a-price .a-offscreen'),
    ]) || null;
  const priceAmount = parsePrice(priceText);

  const image = attr($, '#landingImage', 'data-old-hires') || attr($, '#landingImage', 'src') || attr($, '#imgTagWrapperId img', 'src') || null;

  const olpText = text('#olpLinkWidget_feature_div') || null;
  const offerCount = parseOfferCount(olpText);
  const buyboxText = clean($('#buybox, #desktop_buybox, #rightCol').text());
  const seeAllBuyingChoices = $('#buybox-see-all-buying-choices').length > 0 || /ver (todas las )?opciones de compra/i.test(buyboxText);
  // "Unqualified" buybox: the listing exists but no offer qualifies for the buybox
  // (observed on B0H7818YHY: merchantID="", no availability text, "Ver opciones de compra").
  const unqualifiedBuyBox = $('#unqualifiedBuyBox_feature_div').length > 0;

  const releaseDateText = findReleaseDate($, availabilityText);
  const twister = parseTwister(html);
  const isFdp = /<!--\s*Fallback Detail Page\s*-->|isFDPRequest\s*=\s*true/.test(html || '');

  return {
    asin,
    title,
    merchantId,
    merchantName,
    merchantHasSellerLink: sellerLink.length > 0,
    fulfiller,
    availabilityText,
    addToCart,
    buyNow,
    buttonLabels,
    preorderButton,
    priceText,
    priceAmount,
    currency: 'MXN',
    image,
    olpText,
    offerCount,
    seeAllBuyingChoices,
    unqualifiedBuyBox,
    releaseDateText,
    twister,
    isFdp,
  };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function attr($, selector, name) {
  const v = $(selector).first().attr(name);
  return v == null ? '' : String(v).trim();
}

function clean(s) {
  return String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function firstNonEmpty(values) {
  return values.find((v) => v && v.length) || '';
}

function dedupe(arr) {
  return [...new Set(arr)];
}

function titleFromHead(headTitle) {
  const t = clean(headTitle);
  if (!t) return '';
  return t.replace(/\s*:\s*Amazon\.com\.mx.*$/i, '').trim();
}

function sellerIdFromHref(href) {
  if (!href) return null;
  const m = /[?&;]seller=([A-Z0-9]{10,16})/i.exec(String(href).replace(/&amp;/g, '&'));
  return m ? m[1].toUpperCase() : null;
}

function merchantFromLegacy(legacyText) {
  const t = clean(legacyText);
  if (!t) return '';
  const m = /vendido(?: y enviado)? por\s+(.+?)(?:\.|$| y enviado)/i.exec(t);
  return m ? clean(m[1]) : '';
}

function isDisabled(el) {
  if (el.attr('disabled') != null) return true;
  const wrapperClass = el.closest('.a-button').attr('class') || '';
  return /a-button-disabled/.test(wrapperClass);
}

function buttonLabel($, el) {
  const direct = el.attr('value') || el.attr('title') || el.attr('aria-label');
  if (direct) return clean(direct);
  const labelledBy = el.attr('aria-labelledby');
  if (labelledBy) {
    const txt = labelledBy
      .split(/\s+/)
      .map((id) => clean($(`#${cssEscape(id)}`).text()))
      .filter(Boolean)
      .join(' ');
    if (txt) return txt;
  }
  return clean(el.text());
}

function cssEscape(id) {
  return String(id).replace(/([ !"#$%&'()*+,./:;<=>?@[\\\]^`{|}~])/g, '\\$1');
}

/** "$1,099.00" → 1099; "1.099,00" → 1099; null when unparseable. */
export function parsePrice(text) {
  if (!text) return null;
  const m = /(\d[\d.,]*)/.exec(String(text));
  if (!m) return null;
  let raw = m[1];
  const hasComma = raw.includes(',');
  const hasDot = raw.includes('.');
  if (hasComma && hasDot) {
    // Whichever separator comes last is the decimal one.
    raw = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (hasComma) {
    raw = /^\d{1,3}(,\d{3})+$/.test(raw) ? raw.replace(/,/g, '') : raw.replace(',', '.');
  } else if (hasDot && /^\d{1,3}(\.\d{3})+$/.test(raw)) {
    raw = raw.replace(/\./g, '');
  }
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : null;
}

/**
 * Offer count from the "other sellers" widget. Observed variants:
 *   "Nuevo (3) desde $1,099.00"  ·  "Comparar otras 19 opciones a partir de $2,799.00"
 */
function parseOfferCount(olpText) {
  if (!olpText) return null;
  const m =
    /\((\d+)\)/.exec(olpText) ||
    /otras?\s+(\d+)\s+opci/i.exec(olpText) ||
    /(\d+)\s+(?:ofertas?|opciones)\b/i.exec(olpText) ||
    /(\d+)\s+(?:nuevos?|usados?)\s+desde/i.exec(olpText);
  return m ? Number(m[1]) : null;
}

const RELEASE_LABEL_RE = /fecha de lanzamiento|sali[oó] a la venta|release date|fecha en que/i;

function findReleaseDate($, availabilityText) {
  const fromAvailability = /se lanzar[áa] el\s+(.+?)(?:\.|$)/i.exec(availabilityText || '');
  if (fromAvailability) return clean(fromAvailability[1]);

  let found = null;
  $('#detailBullets_feature_div li, #detailBulletsWrapper_feature_div li').each((_, li) => {
    if (found) return;
    const t = clean($(li).text());
    if (RELEASE_LABEL_RE.test(t)) {
      const parts = t.split(':');
      found = clean(parts.slice(1).join(':')) || null;
    }
  });
  if (found) return found;

  $('#productDetails_detailBullets_sections1 tr, #productDetails_techSpec_section_1 tr, #prodDetails tr').each((_, tr) => {
    if (found) return;
    const th = clean($(tr).find('th').first().text());
    if (RELEASE_LABEL_RE.test(th)) found = clean($(tr).find('td').first().text()) || null;
  });
  return found;
}

/** Variation (twister) data embedded as JSON in the page scripts. */
export function parseTwister(html) {
  const out = { childAsins: [], parentAsin: null, labels: {} };
  if (!html) return out;
  const m = /"dimensionValuesDisplayData"\s*:\s*(\{[^{}]*\})/.exec(html);
  if (m) {
    try {
      const data = JSON.parse(m[1]);
      for (const [asin, labels] of Object.entries(data)) {
        if (/^[A-Z0-9]{10}$/.test(asin)) {
          out.childAsins.push(asin);
          out.labels[asin] = Array.isArray(labels) ? labels.map((l) => clean(l)).join(' / ') : clean(String(labels));
        }
      }
    } catch {
      /* ignore malformed JSON */
    }
  }
  const p = /"parentAsin"\s*:\s*"([A-Z0-9]{10})"|"parent_asin"\s*:\s*"([A-Z0-9]{10})"/.exec(html);
  if (p) out.parentAsin = p[1] || p[2] || null;
  return out;
}
