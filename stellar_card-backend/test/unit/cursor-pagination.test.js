// Unit tests for the cursor-based pagination helper (issue #1010).
// All tests run on pure JavaScript without touching the database.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { encodeCursor, decodeCursor, keysetClause, slicePage } = require('../../src/lib/cursor-pagination');

// ---------------------------------------------------------------------------
// encodeCursor / decodeCursor round-trip
// ---------------------------------------------------------------------------

describe('cursor-pagination: encode/decode round-trip', () => {
  it('decodes what encodeCursor produced', () => {
    const row = { created_at: '2026-01-15T12:00:00.000Z', id: 'abc-123' };
    const cursor = encodeCursor(row);
    const decoded = decodeCursor(cursor);
    assert.deepEqual(decoded, row);
  });

  it('produces a URL-safe base64 string (no +, /, or = padding issues)', () => {
    const cursor = encodeCursor({ created_at: '2026-06-01T00:00:00.000Z', id: 'xyz' });
    assert.doesNotMatch(cursor, /[+/=]/);
  });

  it('decodeCursor returns null for undefined', () => {
    assert.equal(decodeCursor(undefined), null);
  });

  it('decodeCursor returns null for empty string', () => {
    assert.equal(decodeCursor(''), null);
  });

  it('decodeCursor returns null for garbage base64', () => {
    assert.equal(decodeCursor('!!!not-base64!!!'), null);
  });

  it('decodeCursor returns null when payload is missing id field', () => {
    const bad = Buffer.from(JSON.stringify({ created_at: '2026-01-01T00:00:00.000Z' })).toString('base64url');
    assert.equal(decodeCursor(bad), null);
  });

  it('decodeCursor returns null when payload is missing created_at field', () => {
    const bad = Buffer.from(JSON.stringify({ id: 'some-id' })).toString('base64url');
    assert.equal(decodeCursor(bad), null);
  });

  it('decodeCursor returns null when fields are non-string types', () => {
    const bad = Buffer.from(JSON.stringify({ created_at: 42, id: 99 })).toString('base64url');
    assert.equal(decodeCursor(bad), null);
  });
});

// ---------------------------------------------------------------------------
// keysetClause
// ---------------------------------------------------------------------------

describe('cursor-pagination: keysetClause', () => {
  it('returns a clause with three positional params', () => {
    const anchor = { created_at: '2026-03-10T08:00:00.000Z', id: 'row-id-7' };
    const { clause, params } = keysetClause(anchor);
    assert.ok(clause.includes('created_at < ?'));
    assert.ok(clause.includes('id < ?'));
    assert.equal(params.length, 3);
    assert.equal(params[0], anchor.created_at);
    assert.equal(params[1], anchor.created_at);
    assert.equal(params[2], anchor.id);
  });
});

// ---------------------------------------------------------------------------
// slicePage
// ---------------------------------------------------------------------------

describe('cursor-pagination: slicePage', () => {
  function makeRows(n) {
    return Array.from({ length: n }, (_, i) => ({
      id: `id-${n - i}`,
      created_at: `2026-01-${String(n - i).padStart(2, '0')}T00:00:00.000Z`,
    }));
  }

  it('has_more is false when rows <= limit', () => {
    const rows = makeRows(5);
    const { data, has_more, next_cursor } = slicePage(rows, 5);
    assert.equal(has_more, false);
    assert.equal(next_cursor, null);
    assert.equal(data.length, 5);
  });

  it('has_more is true when rows = limit + 1 (sentinel row present)', () => {
    const rows = makeRows(6); // limit is 5, sentinel = 6th
    const { data, has_more, next_cursor } = slicePage(rows, 5);
    assert.equal(has_more, true);
    assert.ok(next_cursor !== null);
    assert.equal(data.length, 5);
  });

  it('next_cursor encodes the last row of the returned page', () => {
    const rows = makeRows(6);
    const { data, next_cursor } = slicePage(rows, 5);
    const decoded = decodeCursor(next_cursor);
    assert.deepEqual(decoded, { id: data[4].id, created_at: data[4].created_at });
  });

  it('the sentinel row is not included in data', () => {
    const rows = makeRows(6);
    const { data } = slicePage(rows, 5);
    assert.equal(data.length, 5);
    assert.ok(!data.find((r) => r.id === rows[5].id));
  });

  it('empty result set: has_more false, no cursor', () => {
    const { data, has_more, next_cursor } = slicePage([], 20);
    assert.equal(has_more, false);
    assert.equal(next_cursor, null);
    assert.equal(data.length, 0);
  });

  it('single row within limit: no next cursor', () => {
    const rows = makeRows(1);
    const { data, has_more, next_cursor } = slicePage(rows, 20);
    assert.equal(has_more, false);
    assert.equal(next_cursor, null);
    assert.equal(data.length, 1);
  });

  it('cursor from page 1 decodes to values in that page', () => {
    // Simulate: 25 rows, limit 10 → page 1 returns 10 + sentinel
    const allRows = makeRows(25);
    const page1Input = allRows.slice(0, 11); // 10 + sentinel
    const { data: page1, next_cursor } = slicePage(page1Input, 10);
    assert.equal(page1.length, 10);

    const anchor = decodeCursor(next_cursor);
    assert.ok(anchor !== null);
    assert.equal(anchor.id, page1[9].id);
    assert.equal(anchor.created_at, page1[9].created_at);
  });
});
