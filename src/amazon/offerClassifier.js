import { AMAZON_MX_MERCHANT_ID } from './constants.js';

/**
 * Turn parsed product-page facts into one status. Pure function.
 *
 *   amazon_in_stock   Amazon México is the buybox seller and the item is buyable now
 *   amazon_preorder   Amazon México is the seller and the buybox is a pre-order
 *   out_of_stock      no buyable Amazon México offer (Amazon listing OOS, or no buybox at all)
 *   third_party_only  another seller holds the buybox (FBA resellers included — the
 *                     fulfiller being "Amazon" is NEVER a seller signal)
 *   ambiguous         the page did not expose enough to decide (never alerts)
 */

export const STATUS = Object.freeze({
  UNKNOWN: 'unknown',
  AMAZON_IN_STOCK: 'amazon_in_stock',
  AMAZON_PREORDER: 'amazon_preorder',
  OUT_OF_STOCK: 'out_of_stock',
  THIRD_PARTY_ONLY: 'third_party_only',
  DELISTED: 'delisted',
  AMBIGUOUS: 'ambiguous',
});

export const OOS_RE = /no disponible por el momento|temporalmente sin stock|no sabemos si|actualmente no disponible|\bagotado\b|no disponible\b|sin existencias/i;
export const IN_STOCK_RE = /^\s*disponible\b|\ben stock\b|s[oó]lo queda|quedan?\s+\d+|normalmente se env[ií]a|hay m[aá]s en camino|disponible para env|env[ií]o en \d/i;
export const PREORDER_TEXT_RE = /se lanzar[áa]|pre-?orden|pre-?venta|preventa|\breserva|disponible el \d|a la venta el \d/i;
const AMAZON_NAME_RE = /^amazon(\.com\.mx| m[eé]xico)?\.?$/i;

export function classifyOffer(parsed, { merchantId = AMAZON_MX_MERCHANT_ID } = {}) {
  const reasons = [];
  const availability = parsed.availabilityText || '';

  let amazonSeller = false;
  let sellerConfidence = 'high';
  if (parsed.merchantId) {
    amazonSeller = parsed.merchantId === merchantId;
    reasons.push(`merchantId=${parsed.merchantId}${amazonSeller ? ' (Amazon México)' : ''}`);
  } else if (parsed.merchantName && AMAZON_NAME_RE.test(parsed.merchantName) && !parsed.merchantHasSellerLink) {
    amazonSeller = true;
    sellerConfidence = 'medium';
    reasons.push(`merchantName="${parsed.merchantName}" sin link de vendedor`);
  } else if (parsed.merchantName) {
    reasons.push(`merchantName="${parsed.merchantName}"`);
  } else {
    reasons.push('sin vendedor en el buybox');
  }

  const oos = OOS_RE.test(availability);
  const inStock = !oos && IN_STOCK_RE.test(availability);
  const preorderText = PREORDER_TEXT_RE.test(availability);
  const preorder = preorderText || Boolean(parsed.preorderButton);
  const buyable = Boolean(parsed.addToCart || parsed.buyNow);

  if (availability) reasons.push(`availability="${availability}"`);
  else reasons.push('sin texto de disponibilidad');
  reasons.push(`buyable=${buyable}${parsed.buttonLabels?.length ? ` [${parsed.buttonLabels.join(' | ')}]` : ''}`);
  if (parsed.fulfiller) reasons.push(`fulfiller="${parsed.fulfiller}"`);

  const flags = { amazonSeller, buyable, preorder, preorderText, preorderButton: Boolean(parsed.preorderButton), oos, inStock };
  const done = (status, confidence) => ({ status, confidence, reasons, flags });

  if (amazonSeller && preorder && buyable) {
    return done(STATUS.AMAZON_PREORDER, preorderText && parsed.preorderButton && sellerConfidence === 'high' ? 'high' : 'medium');
  }
  if (amazonSeller && buyable && !oos) {
    if (inStock && sellerConfidence === 'high') return done(STATUS.AMAZON_IN_STOCK, 'high');
    return done(STATUS.AMAZON_IN_STOCK, availability ? 'medium' : 'low');
  }
  if (amazonSeller && (oos || !buyable)) {
    reasons.push('listing de Amazon México sin oferta comprable');
    return done(STATUS.OUT_OF_STOCK, oos ? 'high' : 'medium');
  }
  if (!amazonSeller && parsed.merchantId && buyable) {
    return done(STATUS.THIRD_PARTY_ONLY, 'high');
  }
  if (!amazonSeller && parsed.merchantId && !buyable) {
    reasons.push('buybox de tercero sin botón de compra');
    return done(STATUS.THIRD_PARTY_ONLY, 'low');
  }
  if (!parsed.merchantId) {
    if ((parsed.seeAllBuyingChoices || parsed.unqualifiedBuyBox) && parsed.offerCount > 0) {
      reasons.push(`sin buybox; ${parsed.offerCount} oferta(s) de terceros`);
      return done(STATUS.THIRD_PARTY_ONLY, 'low');
    }
    if (parsed.unqualifiedBuyBox && !buyable) {
      reasons.push('buybox no calificado: el listing existe pero ninguna oferta es comprable');
      return done(STATUS.OUT_OF_STOCK, 'high');
    }
    if (oos || !buyable || parsed.seeAllBuyingChoices) {
      reasons.push('sin buybox ganador');
      return done(STATUS.OUT_OF_STOCK, oos ? 'high' : 'medium');
    }
  }
  reasons.push('combinación no reconocida');
  return done(STATUS.AMBIGUOUS, 'low');
}
