#!/usr/bin/env node
/**
 * Publica una alerta de PRUEBA en Discord con el mismo constructor que usa el
 * monitor, sin tocar el estado. Toma los datos de un fixture real (o de una
 * página en vivo con --live ASIN).
 *
 *   npm run test:alert                 → IN_STOCK con el fixture dp-amazon-in-stock
 *   npm run test:alert -- --preorder   → variante PREORDER
 *   npm run test:alert -- --no-mention → sin @rol
 *   npm run test:alert -- --live B0GR6N18F6
 *   npm run test:alert -- --dry        → solo imprime el payload
 */
import { parseArgs } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { config } from '../src/services/config.js';
import { logger } from '../src/services/logger.js';
import { parseDetailPage } from '../src/amazon/dpParser.js';
import { createFetcher } from '../src/amazon/fetcher.js';
import { dpUrl, isAsin } from '../src/amazon/constants.js';
import { buildStockAlertMessage } from '../src/services/alertBuilder.js';
import { postDiscordMessage } from '../src/services/discordService.js';
import { EVENT } from '../src/core/statusMachine.js';

const { values } = parseArgs({
  options: {
    preorder: { type: 'boolean', default: false },
    'no-mention': { type: 'boolean', default: false },
    live: { type: 'string' },
    dry: { type: 'boolean', default: false },
  },
});

const log = logger.child({ script: 'test-alert' });

async function main() {
  let parsed;
  if (values.live) {
    const asin = values.live.toUpperCase();
    if (!isAsin(asin)) throw new Error(`ASIN inválido: ${values.live}`);
    const fetcher = createFetcher({ config: { ...config, scrape: { ...config.scrape, fetchMode: 'playwright', mockHtmlDir: '' } }, logger: log });
    try {
      const res = await fetcher.fetchPage({ type: 'dp', asin, url: dpUrl(asin) });
      parsed = parseDetailPage(res.html);
    } finally {
      await fetcher.close();
    }
  } else {
    const file = 'test/fixtures/dp-amazon-in-stock.html.gz';
    if (!existsSync(file)) throw new Error(`Falta el fixture ${file}; usa --live <ASIN> o captura uno con "npm run check -- <ASIN> --rendered --save-fixture dp-amazon-in-stock".`);
    parsed = parseDetailPage(gunzipSync(readFileSync(file)).toString('utf8'));
  }

  const event = {
    asin: parsed.asin || 'B0TEST0001',
    title: `[PRUEBA] ${parsed.title || 'Producto de prueba'}`,
    event: values.preorder ? EVENT.PREORDER : EVENT.IN_STOCK,
    episode: 1,
    prevStatus: 'out_of_stock',
    price: parsed.priceAmount != null ? { amount: parsed.priceAmount, text: parsed.priceText, currency: 'MXN' } : null,
    availabilityText: values.preorder ? 'Este artículo se lanzará el 6 de noviembre de 2026.' : parsed.availabilityText,
    fulfiller: parsed.fulfiller || 'Amazon',
    image: parsed.image,
    releaseDateText: values.preorder ? '6 de noviembre de 2026' : null,
    firstObservation: false,
  };

  const mode = values.dry ? 'dry-run' : config.discord.botToken && config.discord.channelId ? 'bot' : config.discord.webhookUrl ? 'webhook' : 'unconfigured';
  const cfg = {
    ...config,
    discord: { ...config.discord, mode, mentionRoleId: values['no-mention'] ? '' : config.discord.mentionRoleId },
  };
  const payload = buildStockAlertMessage({ events: [event], config: cfg, runnerId: `${config.runnerId}-test` });
  console.log(JSON.stringify(payload, null, 2));

  const res = await postDiscordMessage(payload, cfg, log);
  console.log(res.posted ? `\nPublicado en Discord (${res.mode}).` : `\nNo publicado (${res.mode}).`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`test:alert falló: ${err.message}`);
    process.exit(1);
  });
