import { redactKeys, redactString } from '../utils/redact.js';

/**
 * Tiny, dependency-free structured logger.
 *  - Leveled (error/warn/info/debug) via LOG_LEVEL.
 *  - JSON lines by default (machine-parseable in CI); pretty single-line locally.
 *  - Every message + metadata object passes through secret redaction.
 *
 * Convention for this project: every function that logs receives the parameter
 * under the name `logger` (never `log`) so a renamed argument can never silently
 * swallow output.
 */

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

function resolveLevel() {
  const lvl = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return lvl in LEVELS ? lvl : 'info';
}

const PRETTY = (() => {
  const v = (process.env.LOG_PRETTY || '').toLowerCase();
  if (v === 'true' || v === '1') return true;
  if (v === 'false' || v === '0') return false;
  return process.env.GITHUB_ACTIONS !== 'true'; // pretty locally, JSON in CI
})();

const COLORS = { error: '\x1b[31m', warn: '\x1b[33m', info: '\x1b[36m', debug: '\x1b[90m', reset: '\x1b[0m' };

function createLogger(bindings = {}) {
  const threshold = LEVELS[resolveLevel()];

  function emit(level, msg, meta) {
    if (LEVELS[level] > threshold) return;
    const safeMsg = redactString(typeof msg === 'string' ? msg : JSON.stringify(msg));
    const safeMeta = meta ? redactKeys(meta) : undefined;
    const record = { time: new Date().toISOString(), level, msg: safeMsg, ...bindings, ...(safeMeta ? { meta: safeMeta } : {}) };

    if (PRETTY) {
      const c = COLORS[level] || '';
      const tag = `${c}${level.toUpperCase().padEnd(5)}${COLORS.reset}`;
      const ctx = { ...bindings, ...(safeMeta || {}) };
      const ctxStr = Object.keys(ctx).length ? ' ' + redactString(JSON.stringify(ctx)) : '';
      writeLine(level, `${record.time} ${tag} ${safeMsg}${ctxStr}`);
    } else {
      writeLine(level, JSON.stringify(record));
    }
  }

  return {
    error: (msg, meta) => emit('error', msg, meta),
    warn: (msg, meta) => emit('warn', msg, meta),
    info: (msg, meta) => emit('info', msg, meta),
    debug: (msg, meta) => emit('debug', msg, meta),
    child: (extra) => createLogger({ ...bindings, ...extra }),
  };
}

function writeLine(level, line) {
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(line + '\n');
}

export const logger = createLogger();
export { createLogger };
