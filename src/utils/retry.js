/** Sleep helper that resolves after `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff + jitter.
 *
 * @param {(attempt:number) => Promise<T>} fn  The async operation to run.
 * @param {object}   [opts]
 * @param {number}   [opts.retries=3]      Max retry attempts after the first try.
 * @param {number}   [opts.baseMs=500]     Base delay before the first retry.
 * @param {number}   [opts.maxMs=10000]    Cap on any single backoff delay.
 * @param {number}   [opts.factor=2]       Exponential growth factor.
 * @param {boolean}  [opts.jitter=true]    Apply random jitter to avoid thundering herd.
 * @param {(err:Error)=>boolean} [opts.shouldRetry] Decide whether an error is retryable.
 * @param {(info:{attempt:number,delayMs:number,error:Error})=>void} [opts.onRetry]
 * @returns {Promise<T>}
 */
export async function retry(fn, opts = {}) {
  const { retries = 3, baseMs = 500, maxMs = 10_000, factor = 2, jitter = true, shouldRetry = () => true, onRetry } = opts;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fn(attempt);
    } catch (error) {
      attempt += 1;
      if (attempt > retries || !shouldRetry(error)) {
        throw error;
      }
      const raw = Math.min(maxMs, baseMs * factor ** (attempt - 1));
      const delayMs = jitter ? Math.round(raw / 2 + Math.random() * (raw / 2)) : raw;
      if (onRetry) onRetry({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }
}
