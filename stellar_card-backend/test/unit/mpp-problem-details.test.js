// RFC 7807 (application/problem+json) error responses from the MPP router.
require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const supertest = require('supertest');
const { buildMppRouter } = require('../../src/mpp/router');

const app = express();
app.use('/v1', buildMppRouter());

function assertProblem(res, status, code) {
  assert.equal(res.status, status);
  assert.match(res.headers['content-type'], /^application\/problem\+json/);
  assert.equal(res.body.status, status);
  assert.equal(res.body.type, `urn:stellar-card:error:${code}`);
  assert.equal(typeof res.body.title, 'string');
  assert.equal(typeof res.body.detail, 'string');
  // Legacy short code is kept as an extension member.
  assert.equal(res.body.error, code);
}

describe('MPP router: RFC 7807 problem details', () => {
  it('invalid amount is a problem+json 400', async () => {
    const res = await supertest(app).get('/v1/cards/visa/abc');
    assertProblem(res, 400, 'invalid_amount');
    assert.equal(res.body.title, 'Bad Request');
  });

  it('out-of-bounds amount is a problem+json 400', async () => {
    const res = await supertest(app).get('/v1/cards/visa/10000.01');
    assertProblem(res, 400, 'amount_out_of_bounds');
  });

  it('unknown receipt is a problem+json 404', async () => {
    const res = await supertest(app).get('/v1/mpp/receipts/does-not-exist');
    assertProblem(res, 404, 'receipt_not_found');
    assert.equal(res.body.title, 'Not Found');
  });
});
