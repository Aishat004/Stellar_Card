// @ts-check
// Cursor-based (keyset) pagination helper for SQLite listing endpoints.
//
// OFFSET pagination degrades to O(N) on large tables because SQLite must
// scan and discard `offset` rows before returning `limit` results. Keyset
// pagination anchors the query on the last-seen row's (created_at, id) pair,
// letting the composite index satisfy the WHERE clause directly — O(log N +
// limit) regardless of page depth.
//
// Cursor format: base64url( JSON({ created_at, id }) ) — both values come
// from the row that ended the previous page, so the cursor is derived from
// real DB values and cannot be guessed or incremented by callers.

/**
 * Encode a row's (created_at, id) pair into an opaque cursor string.
 *
 * @param {{ created_at: string; id: string }} row
 * @returns {string}
 */
function encodeCursor(row) {
  const payload = JSON.stringify({ created_at: row.created_at, id: row.id });
  return Buffer.from(payload).toString('base64url');
}

/**
 * Decode an opaque cursor back into { created_at, id }.
 * Returns null when the cursor is absent, empty, or malformed so callers
 * can treat a bad cursor as "start from the beginning" or raise an error.
 *
 * @param {string | undefined | null} cursor
 * @returns {{ created_at: string; id: string } | null}
 */
function decodeCursor(cursor) {
  if (!cursor) return null;
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.created_at !== 'string' || typeof obj.id !== 'string') return null;
    return { created_at: obj.created_at, id: obj.id };
  } catch {
    return null;
  }
}

/**
 * Build keyset WHERE fragments for created_at DESC ordering.
 *
 * The index on (api_key_id, created_at DESC) means the planner can seek
 * directly to the anchor row. The secondary `id` tiebreak handles the rare
 * case where two rows share the same created_at timestamp.
 *
 * Rows qualify when:
 *   created_at < anchor.created_at
 *   OR (created_at = anchor.created_at AND id < anchor.id)
 *
 * @param {{ created_at: string; id: string }} anchor
 * @returns {{ clause: string; params: string[] }}
 */
function keysetClause(anchor) {
  return {
    clause: `(created_at < ? OR (created_at = ? AND id < ?))`,
    params: [anchor.created_at, anchor.created_at, anchor.id],
  };
}

/**
 * Slice a list result into the page, compute `has_more` and `next_cursor`.
 *
 * Pass `limit + 1` rows to the DB query, then call this function.  It trims
 * the extra row, sets `has_more`, and encodes the cursor from the last
 * returned row.
 *
 * @template {{ created_at: string; id: string }} T
 * @param {T[]} rows      - Up to `limit + 1` rows returned by the query.
 * @param {number} limit  - The requested page size (the +1 sentinel is not part of the page).
 * @returns {{ data: T[]; has_more: boolean; next_cursor: string | null }}
 */
function slicePage(rows, limit) {
  const has_more = rows.length > limit;
  const data = has_more ? rows.slice(0, limit) : rows;
  const next_cursor = has_more ? encodeCursor(data[data.length - 1]) : null;
  return { data, has_more, next_cursor };
}

module.exports = { encodeCursor, decodeCursor, keysetClause, slicePage };
