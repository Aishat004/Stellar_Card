'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { describe, it } = require('node:test');

const backendDir = path.resolve(__dirname, '../..');

describe('SQLite WAL database benchmark', () => {
  it('runs 1,000 concurrent order transitions without SQLITE_BUSY', () => {
    const result = spawnSync(
      process.execPath,
      ['tooling/bench-db.js', '--writes', '1000', '--workers', '8'],
      { cwd: backendDir, encoding: 'utf8', timeout: 60_000 },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.match(result.stdout, /SQLite WAL order-write benchmark/);
    assert.match(result.stdout, /Orders requested:\s+1,000/);
    assert.match(result.stdout, /Verified delivered:\s+1,000/);
    assert.match(result.stdout, /Error rate:\s+0\.00% \(0 errors\)/);
    assert.match(result.stdout, /SQLITE_BUSY errors:\s+0/);
    assert.match(result.stdout, /Throughput \(TPS\):\s+[\d.]+ transactions\/sec/);
  });
});