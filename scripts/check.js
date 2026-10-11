#!/usr/bin/env node
/**
 * Inspección manual de una página de Amazon México con el MISMO pipeline que
 * usa el monitor (fetch → validar → parsear → clasificar). Nunca alerta ni toca
 * el estado. Útil para calibrar selectores y capturar fixtures.
 *
 *   npm run check -- B0H8SV3WJ8                      producto (buybox fijado a Amazon México vía smid)
 *   npm run check -- B0H8SV3WJ8 --no-smid            producto sin fijar vendedor
 *   npm run check -- B0H8SV3WJ8 --smid A3IWELYEROHRHA
 *   npm run check -- B0H8SV3WJ8 --aod                vista "todas las ofertas" (requiere --rendered para ver ofertas)
 *   npm run check -- --search "pokemon tcg 30th celebration" [--filtered]
 *   npm run check -- --store 3EAD7EF0-A888-4987-AE79-E89B389F5947   (siempre renderizado)
 *   opciones: --rendered  --save-fixture <nombre>  --html-out <ruta>  --json
 */
import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { config } from '../src/services/config.js';
import { logger } from '../src/services/logger.js';
import { createFetcher } from '../src/amazon/fetcher.js';
import { dpUrl, searchUrl, storePageUrl, isAsin, AMAZON_MX_MERCHANT_ID } from '../src/amazon/constants.js';
import { validatePage } from '../src/amazon/pageValidator.js';
import { parseDetailPage } from '../src/amazon/dpParser.js';
import { classifyOffer } from '../src/amazon/offerClassifier.js';
import { parseSearchResults } from '../src/amazon/searchParser.js';
import { parseStorePage } from '../src/amazon/storeParser.js';
import { sanitizeHtml } from '../src/amazon/fixtureSanitizer.js';
import { loadWatchlist } from '../src/core/watchlist.js';
import { createTitleFilter } from '../src/core/titleFilter.js';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    smid: { type: 'string' },
    'no-smid': { type: 'boolean', default: false },
    aod: { type: 'boolean', default: false },
    rendered: { type: 'boolean', default: false },
    search: { type: 'string' },
    filtered: { type: 'boolean', default: false },
    store: { type: 'string' },
    'save-fixture': { type: 'string' },
    'html-out': { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (values.help || (!positionals.length && !values.search && !values.store)) {
  console.log(`Uso:
  npm run check -- <ASIN> [--no-smid | --smid ID] [--aod] [--rendered] [--save-fixture nombre] [--html-out ruta] [--json]
  npm run check -- --search "consulta" [--filtered] [--rendered] [--save-fixture nombre]
  npm run check -- --store <pageId> [--save-fixture nombre]`);
  process.exit(0);
}

const log = logger.child({ script: 'check' });

async function main() {
  let step;
  if (values.store) {
    step = { type: 'store', pageId: values.store, url: storePageUrl(values.store), scrolls: 4 };
  } else if (values.search) {
    const merchantId = values.filtered ? config.amazon.merchantId : null;
    step = { type: 'search', query: values.search, filtered: Boolean(merchantId), url: searchUrl(values.search, { merchantId }) };
  } else {
    const asin = String(positionals[0]).toUpperCase();
    if (!isAsin(asin)) throw new Error(`ASIN inválido: ${positionals[0]}`);
    const smid = values['no-smid'] ? null : values.smid || AMAZON_MX_MERCHANT_ID;
    step = { type: 'dp', asin, url: dpUrl(asin, { smid, aod: values.aod }) };
  }

  const fetchMode = values.rendered || step.type === 'store' ? 'playwright' : config.scrape.fetchMode === 'auto' ? 'auto' : 'static';
  const cfg = { ...config, scrape: { ...config.scrape, fetchMode, mockHtmlDir: config.scrape.mockHtmlDir } };
  const fetcher = createFetcher({ config: cfg, logger: log });

  const started = Date.now();
  let res;
  try {
    res = await fetcher.fetchPage(step);
  } finally {
    await fetcher.close();
  }
  const validation = validatePage({ type: step.type, ...res });

  const report = {
    url: step.url,
    method: res.method,
    status: res.status,
    finalUrl: res.finalUrl,
    bytes: res.bytes,
    elapsedMs: res.elapsedMs ?? Date.now() - started,
    kind: validation.kind,
    severity: validation.severity,
    reason: validation.reason,
    error: res.error || null,
  };

  if (values['html-out'] && res.html) {
    await mkdir(path.dirname(values['html-out']), { recursive: true });
    await writeFile(values['html-out'], res.html, 'utf8');
    report.htmlOut = values['html-out'];
  }

  if (validation.kind === 'ok') {
    if (step.type === 'dp') {
      const parsed = parseDetailPage(res.html);
      const classification = classifyOffer(parsed, { merchantId: config.amazon.merchantId });
      report.parsed = parsed;
      report.classification = classification;
    } else if (step.type === 'search') {
      const results = parseSearchResults(res.html);
      const filter = await safeTitleFilter();
      report.search = {
        hasMainSlot: results.hasMainSlot,
        noResults: results.noResults,
        total: results.cards.length,
        organic: results.organic.length,
        cards: results.cards.map((c) => ({ ...c, titleFilter: filter ? filter.evaluate(c.title) : null })),
      };
    } else if (step.type === 'store') {
      report.store = parseStorePage(res.html);
    }
  }

  if (values['save-fixture']) {
    report.fixture = await saveFixture(values['save-fixture'], step, res, validation, report);
  }

  if (values.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(step, report);
  }
  return validation.kind === 'network_error' ? 1 : 0;
}

async function safeTitleFilter() {
  try {
    const wl = await loadWatchlist(config.watchlistFile);
    return createTitleFilter(wl.titleFilter);
  } catch {
    return null;
  }
}

async function saveFixture(name, step, res, validation, report) {
  const dir = path.join('test', 'fixtures');
  await mkdir(dir, { recursive: true });
  const safeName = name.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const htmlPath = path.join(dir, `${safeName}.html.gz`);
  const metaPath = path.join(dir, `${safeName}.meta.json`);
  const sanitized = sanitizeHtml(res.html || '');
  await writeFile(htmlPath, gzipSync(Buffer.from(sanitized, 'utf8')));
  const meta = {
    capturedAt: new Date().toISOString(),
    type: step.type,
    asin: step.asin || null,
    query: step.query || null,
    pageId: step.pageId || null,
    url: step.url,
    method: res.method,
    status: res.status,
    kind: validation.kind,
    bytes: Buffer.byteLength(sanitized),
    classification: report.classification ? { status: report.classification.status, confidence: report.classification.confidence } : null,
    merchantId: report.parsed?.merchantId || null,
    availabilityText: report.parsed?.availabilityText || null,
  };
  await writeFile(metaPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  return { htmlPath, metaPath };
}

function printReport(step, r) {
  const line = (k, v) => console.log(`  ${k.padEnd(18)} ${v == null ? '—' : v}`);
  console.log(`\n== ${step.type.toUpperCase()} ${step.asin || step.query || step.pageId || ''}`);
  line('URL', r.url);
  line('Método', r.method);
  line('HTTP', `${r.status}${r.finalUrl && r.finalUrl !== r.url ? `  → ${r.finalUrl}` : ''}`);
  line('Tamaño', `${(r.bytes / 1024).toFixed(0)} KB en ${r.elapsedMs} ms`);
  line('Validación', `${r.kind}${r.reason ? ` (${r.reason})` : ''}`);
  if (r.error) line('Error', r.error);

  if (r.parsed) {
    const p = r.parsed;
    console.log('\n  -- Página de producto');
    line('ASIN', p.asin);
    line('Título', p.title);
    line('merchantID', `${p.merchantId || '—'}${p.merchantId === AMAZON_MX_MERCHANT_ID ? '  ← Amazon México' : ''}`);
    line('Vendedor', `${p.merchantName || '—'}${p.merchantHasSellerLink ? ' (con link de vendedor)' : ''}`);
    line('Enviado por', p.fulfiller);
    line('Disponibilidad', p.availabilityText);
    line('Botones', p.buttonLabels.join(' | ') || '—');
    line('Precio', p.priceText ? `${p.priceText} (${p.priceAmount})` : null);
    line('Ofertas (olp)', p.olpText);
    line('Ver todas', p.seeAllBuyingChoices);
    line('Lanzamiento', p.releaseDateText);
    line('Variaciones', p.twister.childAsins.length ? p.twister.childAsins.join(', ') : '—');
    line('Imagen', p.image);
    console.log('\n  -- Clasificación');
    line('Estado', `${r.classification.status} (confianza ${r.classification.confidence})`);
    for (const reason of r.classification.reasons) console.log(`    · ${reason}`);
  }

  if (r.search) {
    console.log(`\n  -- Búsqueda: ${r.search.total} tarjetas (${r.search.organic} orgánicas)${r.search.noResults ? ' · SIN RESULTADOS' : ''}`);
    for (const c of r.search.cards) {
      const flags = [c.sponsored ? 'PATROCINADO' : null, c.unavailable ? 'NO-DISPONIBLE' : null, c.titleFilter?.ok ? '30TH✓' : null].filter(Boolean).join(',');
      console.log(`    ${c.asin}  ${(c.priceText || '').padEnd(10)}  ${truncate(c.title, 80)}  ${flags}`);
    }
  }

  if (r.store) {
    console.log(`\n  -- Tienda: ${r.store.nav.length} páginas en nav, ${r.store.products.length} productos`);
    for (const p of r.store.nav) console.log(`    nav ${p.pageId}  ${p.title}`);
    for (const p of r.store.products.slice(0, 60)) {
      console.log(`    ${p.asin}  ${(p.priceText || '').padEnd(10)}  ${truncate(p.title, 70)}  ${p.merchantId || ''} ${p.availabilityType || ''}`);
    }
  }

  if (r.fixture) console.log(`\n  Fixture guardado: ${r.fixture.htmlPath} (+ ${r.fixture.metaPath})`);
  if (r.htmlOut) console.log(`  HTML guardado: ${r.htmlOut}`);
  console.log('');
}

function truncate(s, n) {
  const t = String(s ?? '');
  return t.length <= n ? t : t.slice(0, n - 1) + '…';
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`check falló: ${err.message}`);
    process.exit(1);
  });
