/**
 * Decide whether an Amazon response is a real page we may parse, or something
 * that must NEVER be interpreted as "out of stock": fallback pages served to
 * suspicious clients, CAPTCHA walls, truncated bodies, HTTP errors.
 *
 * kind:     ok | fdp | captcha | challenge | tiny | notfound | http_error | network_error
 * severity: ok | soft | hard | network | notfound
 *   soft  → degraded page (fallback / JS challenge / truncated); keep the session, count it.
 *   hard  → explicit block (CAPTCHA, 403/429/503); back off and reset session.
 *
 * Real samples (2026-10-10, Node fetch from a residential IP):
 *   captcha   → Amazon robot check, ~4 KB, comment "api-services-support@amazon.com"
 *   challenge → Akamai Bot Manager interstitial, ~2.4 KB, meta refresh with `bm-verify=`
 */

const CAPTCHA_RE = /errors\/validateCaptcha|captchacharacters|Robot Check|api-services-support@amazon\.com|Escribe los caracteres que ves|Introduce los caracteres que ves/i;
const CHALLENGE_RE = /bm-verify=|triggerInterstitialChallenge|_sec\/verify|akam\/\d+\/|sec-cpt/i;
const FDP_RE = /<!--\s*Fallback Detail Page\s*-->|isFDPRequest\s*=\s*true/;
const NOT_FOUND_RE = /dogsofamazon|No pudimos encontrar esa p[áa]gina|Lo sentimos\. No pudimos encontrar/i;
const DP_CONTAINER_RE = /id="dp"|id="ppd"|id="centerCol"|id="dp-container"/;
const SEARCH_CONTAINER_RE = /s-main-slot|No se encontraron resultados|no coincide con ning/i;
const STORE_CONTAINER_RE = /stores-page|stores-container|"nav"\s*:\s*\{/;
const SIGNIN_RE = /\/ap\/signin/i;

export const MIN_BYTES = { dp: 150_000, search: 80_000, store: 50_000 };

export function validatePage({ type = 'dp', status = 0, html = '', finalUrl = '', error = null } = {}) {
  const bytes = html ? Buffer.byteLength(html) : 0;
  const result = (kind, reason, severity) => ({ kind, reason, severity, bytes, status });

  if (error) return result('network_error', error, 'network');
  if (status === 404) return result('notfound', 'HTTP 404', 'notfound');

  if (finalUrl && (/validateCaptcha/i.test(finalUrl) || SIGNIN_RE.test(finalUrl))) {
    return result('captcha', `redirigido a ${safePath(finalUrl)}`, 'hard');
  }
  if (html && bytes < 400_000 && CAPTCHA_RE.test(html.slice(0, 60_000))) {
    return result('captcha', 'página de verificación (captcha)', 'hard');
  }
  if (html && bytes < 400_000 && CHALLENGE_RE.test(html.slice(0, 60_000))) {
    return result('challenge', 'desafío JS anti-bot (Akamai bm-verify)', 'soft');
  }
  if (status === 503 || status === 429 || status === 403 || status === 401) {
    return result('http_error', `HTTP ${status}`, 'hard');
  }
  if (status < 200 || status >= 400) return result('http_error', `HTTP ${status || 'sin respuesta'}`, 'soft');

  if (type === 'dp' && FDP_RE.test(html)) return result('fdp', 'Fallback Detail Page (sin buybox)', 'soft');
  if (type === 'dp' && bytes < 400_000 && NOT_FOUND_RE.test(html.slice(0, 120_000))) {
    return result('notfound', 'página no encontrada', 'notfound');
  }

  const min = MIN_BYTES[type] ?? 50_000;
  if (bytes < min) return result('tiny', `${bytes} bytes < ${min}`, 'soft');

  if (type === 'dp' && !DP_CONTAINER_RE.test(html)) return result('tiny', 'sin contenedor #dp/#ppd/#centerCol', 'soft');
  if (type === 'search' && !SEARCH_CONTAINER_RE.test(html)) return result('tiny', 'sin .s-main-slot', 'soft');
  if (type === 'store' && !STORE_CONTAINER_RE.test(html)) return result('tiny', 'sin contenedor de tienda', 'soft');

  return result('ok', null, 'ok');
}

/** Degraded = anything that is not a parseable page and not a genuine 404. */
export function isDegraded(validation) {
  return validation.severity === 'soft' || validation.severity === 'hard' || validation.severity === 'network';
}

export function isHardBlock(validation) {
  return validation.severity === 'hard';
}

function safePath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
