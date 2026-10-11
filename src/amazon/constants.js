/** Amazon México facts verified on 2026-10-10 (see README "Cómo se decide el vendedor"). */
export const AMAZON_MX_MERCHANT_ID = 'AVDBXBAVVSXLQ';
export const AMAZON_MX_MARKETPLACE_ID = 'A1AM78C64UM0Y8';
export const BASE_URL = 'https://www.amazon.com.mx';

/** Bump when selectors/classification rules change (shown in alert footers). */
export const PARSER_VERSION = '2026.10.10';

export const ASIN_RE = /^[A-Z0-9]{10}$/;

export function isAsin(value) {
  return ASIN_RE.test(String(value || '').toUpperCase());
}

/** Product page. `smid` pins the buybox to a seller when that seller has an offer. */
export function dpUrl(asin, { smid = AMAZON_MX_MERCHANT_ID, aod = false, base = BASE_URL } = {}) {
  const params = new URLSearchParams();
  if (aod) params.set('aod', '1');
  if (smid) params.set('smid', smid);
  params.set('th', '1');
  params.set('psc', '1');
  return `${base}/dp/${asin}?${params.toString()}`;
}

/** Search results. With `merchantId`, only offers from that seller are listed (refinement p_6). */
export function searchUrl(query, { merchantId = null, base = BASE_URL } = {}) {
  const k = encodeURIComponent(String(query).trim()).replace(/%20/g, '+');
  let url = `${base}/s?k=${k}`;
  if (merchantId) url += `&rh=p_6%3A${merchantId}`;
  return url;
}

export function storePageUrl(pageId, { base = BASE_URL } = {}) {
  return `${base}/stores/page/${pageId}`;
}

export function sellerProfileUrl(merchantId, { base = BASE_URL } = {}) {
  return `${base}/sp?seller=${merchantId}`;
}

/** Extract an ASIN from an Amazon URL/path ("/dp/B0...", "/gp/product/B0...", "amzn1.asin.B0..."). */
export function asinFromUrl(url) {
  if (!url) return null;
  const m = /(?:\/dp\/|\/gp\/product\/|\/gp\/aw\/d\/|amzn1\.asin\.)([A-Z0-9]{10})(?![A-Z0-9])/i.exec(String(url));
  return m ? m[1].toUpperCase() : null;
}
