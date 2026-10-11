/**
 * Decide whether a product title belongs to the watched line (Pokémon TCG
 * 30th Celebration) using the regex lists from watchlist.json:
 *   mustMatch  — every pattern must match (e.g. "pok.?mon")
 *   anyOf      — at least one must match (30th / celebration / 30 aniversario)
 *   exclude    — none may match (funko, lego, peluche…)
 *   tcgSignals — at least one must match when the list is non-empty
 *
 * Titles are accent-stripped and lower-cased first, so patterns should be
 * written without accents ("celebraci[oó]n" still works).
 */
export function normalizeTitle(title) {
  return String(title ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function createTitleFilter(filterConfig = {}) {
  const compile = (patterns) => (patterns || []).map((p) => new RegExp(p, 'i'));
  const must = compile(filterConfig.mustMatch);
  const anyOf = compile(filterConfig.anyOf);
  const tcg = compile(filterConfig.tcgSignals);
  const exclude = compile(filterConfig.exclude);

  function evaluate(title) {
    const t = normalizeTitle(title);
    if (!t) return { ok: false, reason: 'sin título' };
    for (const re of must) {
      if (!re.test(t)) return { ok: false, reason: `no cumple mustMatch /${re.source}/` };
    }
    if (anyOf.length && !anyOf.some((re) => re.test(t))) return { ok: false, reason: 'sin señal 30th/celebration' };
    const excluded = exclude.find((re) => re.test(t));
    if (excluded) return { ok: false, reason: `excluido por /${excluded.source}/` };
    if (tcg.length && !tcg.some((re) => re.test(t))) return { ok: false, reason: 'sin señal de TCG' };
    return { ok: true, reason: 'ok' };
  }

  return {
    evaluate,
    test: (title) => evaluate(title).ok,
  };
}
