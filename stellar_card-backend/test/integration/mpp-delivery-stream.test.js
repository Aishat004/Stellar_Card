require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { request, db, createTestKey, resetDb } = require('../helpers/app');

describe('GET /v1/mpp/receipts/:id/stream (#969)', () => {
  let apiKeyId;

  beforeEach(async () => {
    resetDb();
    apiKeyId = (await createTestKey({ label: 'mpp-stream' })).id;
  });

  function seedReceiptOrder(status) {
    const receiptId = `mpp_r_${uuidv4()}`;
    db.prepare(
      `INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, mpp_receipt_id, source, created_at, updated_at)
       VALUES (?, ?, '10.00', 'usdc', ?, ?, 'mpp', datetime('now'), datetime('now'))`,
    ).run(uuidv4(), status, apiKeyId, receiptId);
    return receiptId;
  }

  it('returns 404 for an unknown receipt', async () => {
    const res = await request.get('/v1/mpp/receipts/mpp_r_doesnotexist/stream');
    assert.equal(res.status, 404);
    assert.equal(res.body.error, 'receipt_not_found');
  });

  it('streams the terminal delivery event for a delivered order and closes', async () => {
    const receiptId = seedReceiptOrder('delivered');
    const res = await request.get(`/v1/mpp/receipts/${receiptId}/stream`).buffer(true);
    assert.equal(res.status, 200);
    assert.match(res.headers['content-type'], /text\/event-stream/);
    assert.match(res.text, /^: connected\n\nevent: delivery\n/);
    assert.match(res.text, /"state":"delivered"/);
    assert.match(res.text, new RegExp(`"receipt_id":"${receiptId}"`));
  });

  it('streams a failed terminal event for a failed order', async () => {
    const receiptId = seedReceiptOrder('failed');
    const res = await request.get(`/v1/mpp/receipts/${receiptId}/stream`).buffer(true);
    assert.equal(res.status, 200);
    assert.match(res.text, /"state":"failed"/);
  });
});
