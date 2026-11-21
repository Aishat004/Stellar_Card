/**
 * Helpers for concurrent integration tests (#1014).
 *
 * Provides a small utility for running N tasks in parallel and
 * asserting they all succeed, returning structured results so callers
 * can inspect individual outcomes without swallowing failures.
 */

'use strict';

/**
 * Run `tasks` concurrently and return an object summarising results.
 *
 * Uses Promise.allSettled so a single failure does not short-circuit
 * the other agents — this matches the production behaviour where
 * independent agents make independent requests.
 *
 * @template T
 * @param {Array<() => Promise<T>>} tasks
 * @returns {Promise<{ succeeded: T[]; failed: Array<{ index: number; reason: unknown }> }>}
 */
async function runConcurrently(tasks) {
  const settled = await Promise.allSettled(tasks.map((t) => t()));

  const succeeded = [];
  const failed = [];

  for (let i = 0; i < settled.length; i++) {
    const result = settled[i];
    if (result.status === 'fulfilled') {
      succeeded.push(result.value);
    } else {
      failed.push({ index: i, reason: result.reason });
    }
  }

  return { succeeded, failed };
}

/**
 * Assert that all tasks produced unique values for the given key.
 *
 * @template T
 * @param {T[]} items
 * @param {keyof T} key
 * @param {string} [label]
 */
function assertUnique(items, key, label = String(key)) {
  const values = items.map((item) => item[key]);
  const unique = new Set(values);
  if (unique.size !== values.length) {
    const dupes = values.filter((v, i) => values.indexOf(v) !== i);
    throw new Error(
      `assertUnique(${label}): expected ${values.length} unique values, got ${unique.size}. ` +
        `Duplicates: ${dupes.join(', ')}`,
    );
  }
}

module.exports = { runConcurrently, assertUnique };
