import { sleep } from '../utils/retry.js';

/**
 * Discord posting over REST (no gateway bot needed for a scheduled job).
 * Primary path: bot token + channel id. Fallback: webhook url.
 *
 * Retries: 429 (honouring retry_after), 5xx and network errors — up to 4 attempts.
 * 4xx other than 429 are configuration errors and are thrown immediately.
 */
const MAX_ATTEMPTS = 4;

export async function postDiscordMessage(payload, config, logger) {
  const mode = config.discord.mode;

  if (mode === 'dry-run' || mode === 'unconfigured') {
    logger?.info(`Discord en modo ${mode}; no se publica.`, {
      reason: mode === 'unconfigured' ? 'falta DISCORD_BOT_TOKEN+DISCORD_CHANNEL_ID (o DISCORD_WEBHOOK_URL)' : 'SEND_DISCORD=false',
      preview: previewPayload(payload),
    });
    return { posted: false, dryRun: true, mode };
  }

  const { url, headers } = endpointFor(mode, config);
  // Webhooks cannot carry message components (buttons); links stay in the embed.
  const body = JSON.stringify(mode === 'webhook' ? stripComponents(payload) : payload);

  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let res;
    try {
      res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15_000) });
    } catch (err) {
      lastError = err;
      logger?.warn('Error de red al publicar en Discord; reintentando.', { attempt, error: err.message });
      await sleep(1000 * attempt);
      continue;
    }
    if (res.ok) {
      logger?.info('Mensaje publicado en Discord.', { mode, status: res.status, embeds: payload.embeds?.length || 0 });
      return { posted: true, mode, status: res.status };
    }
    if (res.status === 429) {
      const retryAfter = await readRetryAfter(res);
      logger?.warn('Discord limitó la tasa; esperando.', { retryAfterMs: retryAfter, attempt });
      await sleep(retryAfter);
      continue;
    }
    const text = await safeText(res);
    if (res.status >= 500) {
      lastError = new Error(`Discord HTTP ${res.status}: ${text.slice(0, 300)}`);
      logger?.warn('Discord respondió 5xx; reintentando.', { attempt, status: res.status });
      await sleep(1000 * attempt);
      continue;
    }
    throw new Error(`Discord rechazó el mensaje (${mode}) HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  throw lastError || new Error('Discord: reintentos agotados.');
}

/** Authenticated GET against the Discord API (bot mode only). Used by `doctor`. */
export async function discordGet(path, config) {
  if (!config.discord.botToken) throw new Error('Sin DISCORD_BOT_TOKEN');
  const res = await fetch(`${config.discord.apiBase}${path}`, {
    headers: { Authorization: `Bot ${config.discord.botToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const text = await safeText(res);
  if (!res.ok) throw new Error(`Discord GET ${path} → HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function endpointFor(mode, config) {
  if (mode === 'bot') {
    return {
      url: `${config.discord.apiBase}/channels/${config.discord.channelId}/messages`,
      headers: { Authorization: `Bot ${config.discord.botToken}`, 'Content-Type': 'application/json' },
    };
  }
  const sep = config.discord.webhookUrl.includes('?') ? '&' : '?';
  return { url: `${config.discord.webhookUrl}${sep}wait=true`, headers: { 'Content-Type': 'application/json' } };
}

async function readRetryAfter(res) {
  try {
    const data = await res.clone().json();
    if (typeof data.retry_after === 'number') return Math.ceil(data.retry_after * 1000) + 250;
  } catch {
    /* fall through */
  }
  const header = res.headers.get('retry-after');
  const secs = header ? Number(header) : 1;
  return (Number.isFinite(secs) ? secs : 1) * 1000 + 250;
}

function stripComponents(payload) {
  const { components, ...rest } = payload;
  return rest;
}

function previewPayload(payload) {
  return {
    content: payload.content || '(sin contenido)',
    embedTitles: (payload.embeds || []).map((e) => e.title).filter(Boolean),
    buttons: (payload.components || []).flatMap((row) => (row.components || []).map((b) => b.label)),
  };
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
