import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTitleFilter, normalizeTitle } from '../src/core/titleFilter.js';

const watchlist = JSON.parse(readFileSync(new URL('../watchlist.json', import.meta.url), 'utf8'));
const filter = createTitleFilter(watchlist.titleFilter);

const POSITIVE = [
  'Pokémon TCG: 30th Celebration Elite Trainer Box (1 tarjeta promocional de arte completo, 9 paquetes de refuerzo y accesorios premium)',
  'Pokémon TCG: colección de carteles de celebración 30 (3 tarjetas promocionales, 1 póster y 3 refuerzos)',
  'Pok?mon TCG: 30th Celebration Mini Tin Pikachu',
  'Pokemon TCG 30th Celebration Booster Bundle',
  'Pokémon JCC: Celebración del 30 aniversario Caja de Entrenador Élite',
  'Pokémon TCG: 30th Celebration Ultra-Premium Collection—Day',
  'Pokémon TCG 30th Celebration Knock Out Collection',
];

const NEGATIVE = [
  'Pokémon TCG: Mega Evolution—Chaos Rising Elite Trainer Box, 1 Pieza',
  'Funko Pop! Games: Pokemon 30th Anniversary - Pikachu',
  'LEGO Pokémon 30th Anniversary Venusaur – Kit de Construcción',
  'Peluche Pokémon 30 Aniversario Pikachu 20 cm',
  'Exploding Kittens Exploding Pigeon, Juego de Mesa de Cartas',
  'Playera Pokémon 30th Celebration talla M',
  '',
];

for (const title of POSITIVE) {
  test(`acepta: ${title.slice(0, 60)}`, () => {
    const r = filter.evaluate(title);
    assert.equal(r.ok, true, r.reason);
  });
}

for (const title of NEGATIVE) {
  test(`rechaza: ${title.slice(0, 60) || '(vacío)'}`, () => {
    assert.equal(filter.test(title), false);
  });
}

test('normalizeTitle strips accents and lower-cases', () => {
  assert.equal(normalizeTitle('  Pokémon   Celebración  '), 'pokemon celebracion');
});

test('empty config accepts everything non-empty', () => {
  const f = createTitleFilter({});
  assert.equal(f.test('anything'), true);
  assert.equal(f.test(''), false);
});
