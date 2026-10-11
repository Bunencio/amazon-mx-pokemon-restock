import { dpUrl, PARSER_VERSION } from '../amazon/constants.js';
import { EVENT, humanStatus } from '../core/statusMachine.js';

/**
 * Discord payload builders. Content is deterministic and comes straight from
 * the parsed page; nothing is generated.
 */

const COLOR = Object.freeze({ inStock: 0x2ecc71, preorder: 0x3498db, warning: 0xe74c3c, watchdog: 0xe67e22, info: 0x95a5a6 });
const LIMITS = Object.freeze({ title: 256, description: 4096, fieldName: 256, fieldValue: 1024, embedsPerMessage: 10, rowsPerMessage: 5 });

export const MAX_EVENTS_PER_MESSAGE = 5;

/**
 * @param {object} args
 * @param {Array<{asin,title,event,episode,prevStatus,price,availabilityText,fulfiller,image,releaseDateText,firstObservation}>} args.events
 */
export function buildStockAlertMessage({ events, config, runnerId = 'pc', parserVersion = PARSER_VERSION, now = new Date() }) {
  const batch = events.slice(0, MAX_EVENTS_PER_MESSAGE);
  const merchantId = config.amazon.merchantId;
  const embeds = [];
  const components = [];

  for (const ev of batch) {
    const isPreorder = ev.event === EVENT.PREORDER;
    const buyUrl = dpUrl(ev.asin, { smid: merchantId });
    const offersUrl = dpUrl(ev.asin, { smid: merchantId, aod: true });
    const title = truncate(`${isPreorder ? '🟣 Pre-orden en Amazon México' : '🟢 Disponible en Amazon México'}: ${ev.title || ev.asin}`, LIMITS.title);

    const lines = [];
    if (ev.firstObservation) lines.push('_(primera observación del monitor)_');
    if (ev.availabilityText) lines.push(`**${ev.availabilityText}**`);
    lines.push(`Vendido por **Amazon México**${ev.fulfiller ? ` · Enviado por ${ev.fulfiller}` : ''}`);
    if (isPreorder && ev.releaseDateText) lines.push(`Lanzamiento: ${ev.releaseDateText}`);
    if (config.discord.mode === 'webhook') lines.push(`[Comprar](${buyUrl}) · [Todas las ofertas](${offersUrl})`);

    const fields = [
      { name: 'Precio', value: ev.price?.text || (ev.price?.amount != null ? `$${ev.price.amount}` : '—'), inline: true },
      { name: 'ASIN', value: ev.asin, inline: true },
      { name: 'Episodio', value: `#${ev.episode ?? 1}`, inline: true },
      { name: 'Antes', value: humanStatus(ev.prevStatus), inline: true },
    ];

    embeds.push({
      title,
      url: buyUrl,
      description: truncate(lines.join('\n'), LIMITS.description),
      color: isPreorder ? COLOR.preorder : COLOR.inStock,
      fields: fields.map((f) => ({ ...f, name: truncate(f.name, LIMITS.fieldName), value: truncate(f.value, LIMITS.fieldValue) })),
      ...(ev.image ? { thumbnail: { url: ev.image } } : {}),
      footer: { text: `Pokémon Restock Monitor · ${runnerId} · ${parserVersion}` },
      timestamp: now.toISOString(),
    });

    components.push({
      type: 1,
      components: [
        { type: 2, style: 5, label: isPreorder ? 'Pre-ordenar en Amazon' : 'Comprar en Amazon', url: buyUrl },
        { type: 2, style: 5, label: 'Todas las ofertas', url: offersUrl },
      ],
    });
  }

  const mention = batch.some((ev) => (ev.event === EVENT.PREORDER ? config.alerts.mentionOnPreorder : config.alerts.mentionOnInStock));
  const { content, allowed_mentions } = buildMentions({ mention, config });

  return {
    content,
    embeds: embeds.slice(0, LIMITS.embedsPerMessage),
    components: components.slice(0, LIMITS.rowsPerMessage),
    allowed_mentions,
  };
}

export function buildWarningMessage({ title, message, url = null, runnerId = 'pc', now = new Date() }) {
  return simpleEmbed({ title: `⚠️ ${title}`, description: message, color: COLOR.warning, url, runnerId, now });
}

export function buildWatchdogMessage({ primaryRunnerId, ageMinutes, lastOutcome, runnerId = 'actions', now = new Date() }) {
  const mins = Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : null;
  return simpleEmbed({
    title: `🩺 Runner "${primaryRunnerId}" sin latido`,
    description:
      (mins == null ? `El runner principal nunca ha reportado.` : `El runner principal lleva **${mins} min** sin reportar (último resultado: ${lastOutcome || '—'}).`) +
      `\nGitHub Actions toma el relevo mientras tanto (puede recibir bloqueos de Amazon).`,
    color: COLOR.watchdog,
    runnerId,
    now,
  });
}

export function buildDiscoveryMessage({ discovered, runnerId = 'pc', now = new Date() }) {
  const lines = discovered.slice(0, 20).map((d) => `• [${d.asin}](${dpUrl(d.asin)}) — ${truncate(d.title || '(sin título)', 120)} _(${d.source})_`);
  if (discovered.length > 20) lines.push(`• +${discovered.length - 20} más`);
  return simpleEmbed({ title: `🔎 ${discovered.length} producto(s) 30th Celebration nuevo(s) en la watchlist`, description: lines.join('\n'), color: COLOR.info, runnerId, now });
}

export function buildHeartbeatMessage({ counts, total, runnerId = 'pc', now = new Date() }) {
  const lines = Object.entries(counts).map(([status, n]) => `• ${humanStatus(status)}: **${n}**`);
  return simpleEmbed({ title: `💓 Monitor activo · ${total} ASIN(s) vigilados`, description: lines.join('\n') || '—', color: COLOR.info, runnerId, now });
}

function simpleEmbed({ title, description, color, url = null, runnerId, now }) {
  return {
    content: '',
    embeds: [
      {
        title: truncate(title, LIMITS.title),
        description: truncate(description || '', LIMITS.description),
        color,
        ...(url ? { url } : {}),
        footer: { text: `Pokémon Restock Monitor · ${runnerId} · ${PARSER_VERSION}` },
        timestamp: now.toISOString(),
      },
    ],
    allowed_mentions: { parse: [] },
  };
}

function buildMentions({ mention, config }) {
  const roleId = config.discord.mentionRoleId;
  if (mention && roleId) return { content: `<@&${roleId}>`, allowed_mentions: { parse: [], roles: [roleId] } };
  return { content: '', allowed_mentions: { parse: [] } };
}

export function truncate(str, max) {
  const s = String(str ?? '');
  return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)) + '…';
}
