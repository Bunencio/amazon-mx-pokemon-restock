#!/usr/bin/env node
/**
 * Diagnóstico del entorno antes de activar el monitor: Node, TLS, Discord,
 * gist, Playwright, watchlist y una lectura real de Amazon (sin alertar).
 *
 *   npm run doctor            → todas las comprobaciones
 *   npm run doctor -- --quick → sin Playwright ni Amazon
 */
import { parseArgs } from 'node:util';
import { access, mkdir } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { config, resolveStateBackend, summarizeConfig } from '../src/services/config.js';
import { logger } from '../src/services/logger.js';
import { discordGet } from '../src/services/discordService.js';
import { loadWatchlist } from '../src/core/watchlist.js';
import { createFetcher } from '../src/amazon/fetcher.js';
import { validatePage } from '../src/amazon/pageValidator.js';
import { parseDetailPage } from '../src/amazon/dpParser.js';
import { classifyOffer } from '../src/amazon/offerClassifier.js';
import { dpUrl } from '../src/amazon/constants.js';

const { values } = parseArgs({ options: { quick: { type: 'boolean', default: false } } });
const log = logger.child({ script: 'doctor' });
const results = [];

function report(name, ok, detail, { critical = true } = {}) {
  results.push({ name, ok, detail, critical });
  const icon = ok ? '✓' : critical ? '✗' : '!';
  console.log(`  ${icon} ${name.padEnd(28)} ${detail}`);
}

async function probeTls(url) {
  const res = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'amazon-mx-pokemon-restock doctor' } });
  return res.status;
}

async function main() {
  console.log('\nPokémon Restock Monitor — doctor\n');
  console.log('  Config:', JSON.stringify(summarizeConfig()));
  console.log('');

  // Node
  const major = Number(process.versions.node.split('.')[0]);
  report('Node.js', major >= 22, `v${process.versions.node}${major >= 22 ? '' : ' (se requiere ≥ 22)'}`);
  const nodeOptions = process.env.NODE_OPTIONS || '';
  report('NODE_OPTIONS', true, nodeOptions ? nodeOptions : '(vacío; run-monitor.cmd usa --use-system-ca para el proxy TLS local)', { critical: false });

  // TLS probes
  for (const [name, url] of [
    ['TLS amazon.com.mx', 'https://www.amazon.com.mx/robots.txt'],
    ['TLS discord.com', 'https://discord.com/api/v10/gateway'],
    ['TLS api.github.com', 'https://api.github.com/'],
  ]) {
    try {
      const status = await probeTls(url);
      report(name, status > 0 && status < 500, `HTTP ${status}`);
    } catch (err) {
      report(name, false, `error: ${err.message} (¿proxy TLS? prueba NODE_OPTIONS=--use-system-ca)`);
    }
  }

  // Watchlist + state dir
  try {
    const wl = await loadWatchlist(config.watchlistFile);
    report('watchlist.json', true, `${wl.items.length} ASIN(s), ${wl.queries.filtered.length} consulta(s) filtrada(s)`);
  } catch (err) {
    report('watchlist.json', false, err.message);
  }
  try {
    await mkdir(path.dirname(config.state.sharedFile), { recursive: true });
    await access(path.dirname(config.state.sharedFile), fsConstants.W_OK);
    report('Carpeta state/', true, path.dirname(config.state.sharedFile));
  } catch (err) {
    report('Carpeta state/', false, err.message);
  }

  // Discord
  if (config.discord.botToken) {
    try {
      const meUser = await discordGet('/users/@me', config);
      report('Discord bot', true, `${meUser.username}#${meUser.discriminator || '0'}`);
    } catch (err) {
      report('Discord bot', false, err.message);
    }
    if (config.discord.channelId) {
      try {
        const channel = await discordGet(`/channels/${config.discord.channelId}`, config);
        report('Discord canal', true, `#${channel.name} (guild ${channel.guild_id})`);
        if (config.discord.mentionRoleId && channel.guild_id) {
          try {
            const roles = await discordGet(`/guilds/${channel.guild_id}/roles`, config);
            const role = roles.find((r) => r.id === config.discord.mentionRoleId);
            report('Discord rol', Boolean(role), role ? `@${role.name}${role.mentionable ? '' : ' (no mencionable por todos; el bot necesita permiso "Mencionar todos los roles")'}` : 'rol no encontrado en ese servidor', { critical: false });
          } catch (err) {
            report('Discord rol', false, err.message, { critical: false });
          }
        }
      } catch (err) {
        report('Discord canal', false, `${err.message} (¿el bot tiene acceso al canal?)`);
      }
    } else {
      report('Discord canal', false, 'falta DISCORD_CHANNEL_ID');
    }
  } else if (config.discord.webhookUrl) {
    report('Discord webhook', true, 'configurado (sin botones de enlace)', { critical: false });
  } else {
    report('Discord', false, 'sin DISCORD_BOT_TOKEN/DISCORD_CHANNEL_ID ni DISCORD_WEBHOOK_URL (modo dry-run)', { critical: false });
  }
  report('SEND_DISCORD', true, config.discord.sendDiscord ? 'true (publica)' : 'false (dry-run local; run-monitor.cmd lo activa)', { critical: false });

  // Shared state backend
  const backend = resolveStateBackend(config);
  if (backend === 'gist') {
    try {
      const res = await fetch(`${config.github.apiUrl}/gists/${config.state.gistId}`, {
        headers: { Authorization: `Bearer ${config.state.gistToken}`, Accept: 'application/vnd.github+json', 'User-Agent': 'amazon-mx-pokemon-restock' },
        signal: AbortSignal.timeout(15_000),
      });
      const scopes = res.headers.get('x-oauth-scopes') || '';
      const ok = res.ok && /\bgist\b/.test(scopes);
      report('Gist compartido', ok, res.ok ? `HTTP ${res.status}; scopes: ${scopes || '(sin scopes → ¿token fine-grained? usa uno clásico)'}` : `HTTP ${res.status}`);
    } catch (err) {
      report('Gist compartido', false, err.message);
    }
  } else {
    report('Estado compartido', true, `backend ${backend}${backend === 'local' ? ' (sin gist: Actions no verá el latido del PC)' : ''}`, { critical: false });
  }

  if (!values.quick) {
    // Playwright + one real Amazon read
    const fetcher = createFetcher({ config: { ...config, scrape: { ...config.scrape, fetchMode: 'playwright', mockHtmlDir: '' } }, logger: log });
    try {
      const asin = (await loadWatchlist(config.watchlistFile).catch(() => null))?.items?.[0]?.asin || 'B0H8SV3WJ8';
      const res = await fetcher.fetchPage({ type: 'dp', asin, url: dpUrl(asin) });
      if (res.error && /Playwright/i.test(res.error)) {
        report('Playwright', false, res.error);
      } else {
        report('Playwright', true, `página cargada en ${res.elapsedMs} ms`);
        const v = validatePage({ type: 'dp', ...res });
        if (v.kind === 'ok') {
          const cls = classifyOffer(parseDetailPage(res.html), { merchantId: config.amazon.merchantId });
          report('Amazon (lectura real)', true, `${asin}: ${cls.status} (${cls.confidence})`);
        } else {
          report('Amazon (lectura real)', false, `${asin}: ${v.kind} — ${v.reason}`);
        }
      }
    } catch (err) {
      report('Playwright', false, err.message);
    } finally {
      await fetcher.close();
    }
  }

  const failures = results.filter((r) => !r.ok && r.critical);
  console.log(`\n${failures.length ? `${failures.length} comprobación(es) crítica(s) fallaron.` : 'Todo listo.'}\n`);
  return failures.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`doctor falló: ${err.message}`);
    process.exit(1);
  });
