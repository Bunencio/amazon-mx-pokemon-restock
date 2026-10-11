#!/usr/bin/env node
/**
 * Regenera test/mock/ a partir de los fixtures reales, con los nombres que espera
 * MOCK_HTML_DIR (dp-<ASIN>.html.gz, search-<slug>[-filtered].html.gz).
 *
 *   npm run mock:init
 *   MOCK_HTML_DIR=test/mock ONLY_ASIN=B0GR6N18F6 STATE_FILE=state/mock-shared.json RUNNER_STATE_FILE=state/mock-runner.json npm run monitor
 */
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const MAP = [
  ['dp-3p-fba-B0H8SV3WJ8.html.gz', 'dp-B0H8SV3WJ8.html.gz'],
  ['dp-amazon-in-stock.html.gz', 'dp-B0GR6N18F6.html.gz'],
  ['search-filtered.html.gz', 'search-pokemon-tcg-30th-celebration-filtered.html.gz'],
  ['search-unfiltered.html.gz', 'search-pokemon-tcg-30th-celebration.html.gz'],
  ['blocked-captcha-dp.html.gz', 'captcha.html.gz'],
];

const src = path.join('test', 'fixtures');
const dst = path.join('test', 'mock');
await mkdir(dst, { recursive: true });
for (const [from, to] of MAP) {
  try {
    await copyFile(path.join(src, from), path.join(dst, to));
    console.log(`  ${from} → ${to}`);
  } catch (err) {
    console.log(`  (omitido) ${from}: ${err.message}`);
  }
}
console.log(`Listo: ${dst}`);
