// Integration test for the per-IP limit on GET /v1/cards/visa/:amount.
// The limiter reads MPP_CHALLENGE_RATE_LIMIT when the router module loads,
// so the env var is set before the app helpers are required. This file runs
// in its own process, so the tiny limit does not leak into other suites.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// The shared env helper pins MPP_CHALLENGE_RATE_LIMIT to a large value, so
// it must load first; then override and load the app (which loads the router).
require('../helpers/env');
process.env.MPP_CHALLENGE_RATE_LIMIT = '3';
const { request, db } = require('../helpers/app');

beforeEach(() => {
  db.prepare(`DELETE FROM mpp_challenges`).run();
});

describe('GET /v1/cards/visa/:amount — per-IP rate limit', () => {
  it('returns 429 once the per-IP limit is exhausted, and creates no challenge row', async () => {
    for (let i = 0; i < 3; i++) {
      const ok = await request.get('/v1/cards/visa/10.00');
      assert.equal(ok.status, 402);
    }
    const before = db.prepare(`SELECT COUNT(*) AS n FROM mpp_challenges`).get().n;

    const limited = await request.get('/v1/cards/visa/10.00');
    assert.equal(limited.status, 429);
    assert.equal(limited.body.error, 'too_many_requests');

    const after = db.prepare(`SELECT COUNT(*) AS n FROM mpp_challenges`).get().n;
    assert.equal(after, before, 'a rate-limited request must not insert a challenge row');
  });
});
