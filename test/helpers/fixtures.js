import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const FIXTURE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixturePath(name) {
  return path.join(FIXTURE_DIR, name.endsWith('.gz') ? name : `${name}.html.gz`);
}

export function hasFixture(name) {
  return existsSync(fixturePath(name));
}

export function loadFixture(name) {
  const file = fixturePath(name);
  const buf = readFileSync(file);
  return file.endsWith('.gz') ? gunzipSync(buf).toString('utf8') : buf.toString('utf8');
}
