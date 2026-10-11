/** Integer in [min, max] (inclusive). */
export function randomInt(min, max) {
  const lo = Math.ceil(Math.min(min, max));
  const hi = Math.floor(Math.max(min, max));
  return Math.floor(lo + Math.random() * (hi - lo + 1));
}

/** Random pause length between two bounds (ms). */
export function jitterMs(minMs, maxMs) {
  return randomInt(minMs, maxMs);
}

/** Fisher–Yates shuffle (returns a new array). */
export function shuffle(items) {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Random element (undefined for an empty array). */
export function pick(items) {
  if (!items || !items.length) return undefined;
  return items[Math.floor(Math.random() * items.length)];
}
