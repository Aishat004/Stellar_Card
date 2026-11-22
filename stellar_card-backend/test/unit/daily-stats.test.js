// Unit tests for the daily order volume / revenue stats feature (issue #1008).
//
// Covers:
//   1. computeDailyStats — aggregation, idempotency, fee calculation.
//   2. getDailyStats     — retrieval ordering and limit.
//   3. msUntilNext0005UTC — scheduler timing helper.

'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');

const { db, resetDb } = require('../helpers/app');
const { computeDailyStats, getDailyStats } = require('../../src/lib/stats');
const { _msUntilNext0005UTC } = require('../../src/jobs');

// ── helpers ──────────────────────────────────────────────────────────────────

function insertKey(id = uuidv4()) {
  db.prepare(`INSERT OR IGNORE INTO api_keys (id, key_hash) VALUES (?, ?)`).run(id, `h-${id}`);
  return id;
}

function insertOrder({ id = uuidv4(), apiKeyId = null, status = 'delivered', amount = '10.00', date = '2026-11-21' } = {}) {
  db.prepare(
    `INSERT INTO orders (id, api_key_id, status, amount_usdc, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(id, apiKeyId, status, amount, `${date}T12:00:00Z`, `${date}T12:00:00Z`);
  return id;
}

// ── computeDailyStats ────────────────────────────────────────────────────────

describe('computeDailyStats', () => {
  beforeEach(() => resetDb());

  it('returns zero counts when no orders exist for the date', () => {
    const result = computeDailyStats('2026-11-21');
    assert.equal(result.date, '2026-11-21');
    assert.equal(result.total_orders, 0);
    assert.equal(parseFloat(result.total_volume), 0);
    assert.equal(parseFloat(result.total_fees), 0);
  });

  it('counts all orders for the date regardless of status', () => {
    const keyId = insertKey();
    insertOrder({ apiKeyId: keyId, status: 'delivered', amount: '20.00', date: '2026-11-21' });
    insertOrder({ apiKeyId: keyId, status: 'failed',    amount: '5.00',  date: '2026-11-21' });
    const result = computeDailyStats('2026-11-21');
    assert.equal(result.total_orders, 2);
  });

  it('only sums delivered orders into volume', () => {
    const keyId = insertKey();
    insertOrder({ apiKeyId: keyId, status: 'delivered', amount: '100.00', date: '2026-11-21' });
    insertOrder({ apiKeyId: keyId, status: 'failed',    amount: '50.00',  date: '2026-11-21' });
    insertOrder({ apiKeyId: keyId, status: 'expired',   amount: '25.00',  date: '2026-11-21' });
    const result = computeDailyStats('2026-11-21');
    assert.equal(parseFloat(result.total_volume), 100.0);
  });

  it('computes fees as 1% of delivered volume by default', () => {
    const keyId = insertKey();
    insertOrder({ apiKeyId: keyId, status: 'delivered', amount: '200.00', date: '2026-11-21' });
    const result = computeDailyStats('2026-11-21');
    assert.equal(parseFloat(result.total_fees), 2.0);
  });

  it('persists result to daily_stats table', () => {
    const keyId = insertKey();
    insertOrder({ apiKeyId: keyId, status: 'delivered', amount: '50.00', date: '2026-11-21' });
    computeDailyStats('2026-11-21');
    const row = /** @type {any} */ (
      db.prepare(`SELECT * FROM daily_stats WHERE date = '2026-11-21'`).get()
    );
    assert.ok(row, 'row must be persisted');
    assert.equal(row.total_orders, 1);
    assert.equal(parseFloat(row.total_volume), 50.0);
  });

  it('is idempotent — re-running overwrites without duplicating', () => {
    const keyId = insertKey();
    insertOrder({ apiKeyId: keyId, status: 'delivered', amount: '30.00', date: '2026-11-21' });
    computeDailyStats('2026-11-21');
    computeDailyStats('2026-11-21');
    const count = /** @type {any} */ (
      db.prepare(`SELECT COUNT(*) AS n FROM daily_stats WHERE date = '2026-11-21'`).get()
    );
    assert.equal(count.n, 1, 'must have exactly one row after re-run');
  });

  it('does not mix orders from different dates', () => {
    const keyId = insertKey();
    insertOrder({ apiKeyId: keyId, status: 'delivered', amount: '10.00', date: '2026-11-20' });
    insertOrder({ apiKeyId: keyId, status: 'delivered', amount: '20.00', date: '2026-11-21' });
    const result = computeDailyStats('2026-11-21');
    assert.equal(parseFloat(result.total_volume), 20.0);
    assert.equal(result.total_orders, 1);
  });
});

// ── getDailyStats ─────────────────────────────────────────────────────────────

describe('getDailyStats', () => {
  beforeEach(() => resetDb());

  it('returns rows ordered newest date first', () => {
    computeDailyStats('2026-11-19');
    computeDailyStats('2026-11-21');
    computeDailyStats('2026-11-20');
    const rows = getDailyStats();
    assert.equal(rows[0].date, '2026-11-21');
    assert.equal(rows[1].date, '2026-11-20');
    assert.equal(rows[2].date, '2026-11-19');
  });

  it('respects the limit parameter', () => {
    for (let i = 1; i <= 5; i++) {
      computeDailyStats(`2026-11-${String(i).padStart(2, '0')}`);
    }
    const rows = getDailyStats(3);
    assert.equal(rows.length, 3);
  });

  it('returns an empty array when no stats have been computed', () => {
    assert.deepEqual(getDailyStats(), []);
  });
});

// ── msUntilNext0005UTC ────────────────────────────────────────────────────────

describe('_msUntilNext0005UTC', () => {
  it('returns positive ms when called before 00:05 UTC today', () => {
    // 2026-11-22 00:00:00 UTC — 00:05 is still 5 min away
    const now = Date.UTC(2026, 10, 22, 0, 0, 0);
    const ms = _msUntilNext0005UTC(now);
    assert.equal(ms, 5 * 60 * 1000);
  });

  it('targets the NEXT day when called after 00:05 UTC', () => {
    // 2026-11-22 01:00:00 UTC — next 00:05 is tomorrow
    const now = Date.UTC(2026, 10, 22, 1, 0, 0);
    const ms = _msUntilNext0005UTC(now);
    const expected = Date.UTC(2026, 10, 23, 0, 5, 0) - now;
    assert.equal(ms, expected);
  });

  it('always returns a positive delay', () => {
    const ms = _msUntilNext0005UTC(Date.now());
    assert.ok(ms > 0, `expected positive delay, got ${ms}`);
    assert.ok(ms <= 24 * 60 * 60 * 1000, 'delay must not exceed 24 h');
  });
});
