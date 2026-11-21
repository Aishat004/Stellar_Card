// Unit tests for webhook-log.js latency and success-rate helpers (issue #1016).
// These tests exercise the pure helper functions without hitting the database.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

// _percentile is exported for testing without requiring a live DB.
const { _percentile } = require('../../src/lib/webhook-log');

describe('webhook-log: percentile helper', () => {
  it('returns the single element for a one-element array', () => {
    assert.equal(_percentile([42], 50), 42);
    assert.equal(_percentile([42], 95), 42);
    assert.equal(_percentile([42], 99), 42);
  });

  it('p50 on an odd-length array returns the middle value', () => {
    // sorted: [10, 20, 30, 40, 50] — 5 elements, p50 → index ceil(2.5)-1 = 2 → 30
    assert.equal(_percentile([10, 20, 30, 40, 50], 50), 30);
  });

  it('p50 on an even-length array returns the upper-middle value (nearest-rank)', () => {
    // sorted: [10, 20, 30, 40] — 4 elements, p50 → index ceil(2)-1 = 1 → 20
    assert.equal(_percentile([10, 20, 30, 40], 50), 20);
  });

  it('p95 picks the correct high-end bucket', () => {
    // 100 elements [1..100], p95 → index ceil(95)-1 = 94 → value 95
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(_percentile(arr, 95), 95);
  });

  it('p99 on 100 elements returns the 99th value', () => {
    const arr = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.equal(_percentile(arr, 99), 99);
  });

  it('p100 always returns the last (maximum) element', () => {
    assert.equal(_percentile([5, 10, 15, 20], 100), 20);
  });

  it('p0 always returns the first (minimum) element', () => {
    assert.equal(_percentile([5, 10, 15, 20], 0), 5);
  });

  it('handles uniform arrays (all same value)', () => {
    const arr = [150, 150, 150, 150, 150];
    assert.equal(_percentile(arr, 50), 150);
    assert.equal(_percentile(arr, 95), 150);
    assert.equal(_percentile(arr, 99), 150);
  });

  it('handles latency spike: p99 >> p50', () => {
    // 99 fast deliveries + 1 very slow one
    const arr = [...Array(99).fill(50), 5000].sort((a, b) => a - b);
    assert.equal(_percentile(arr, 50), 50);
    assert.equal(_percentile(arr, 99), 5000);
  });

  it('never returns a value outside the input range', () => {
    const arr = [10, 20, 30];
    for (const pct of [0, 25, 50, 75, 90, 99, 100]) {
      const v = _percentile(arr, pct);
      assert.ok(v >= 10 && v <= 30, `p${pct} = ${v} is outside [10, 30]`);
    }
  });
});

describe('webhook-log: deliverySuccessRate24h and deliveryLatencyStats24h export shape', () => {
  it('exports deliverySuccessRate24h as a function', () => {
    const { deliverySuccessRate24h } = require('../../src/lib/webhook-log');
    assert.equal(typeof deliverySuccessRate24h, 'function');
  });

  it('exports deliveryLatencyStats24h as a function', () => {
    const { deliveryLatencyStats24h } = require('../../src/lib/webhook-log');
    assert.equal(typeof deliveryLatencyStats24h, 'function');
  });
});
