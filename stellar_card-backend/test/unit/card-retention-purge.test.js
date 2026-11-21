require('../helpers/env');

const Module = require('node:module');
const { beforeEach, it } = require('node:test');
const assert = require('node:assert/strict');

const jobsPath = require.resolve('../../src/jobs');
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (parent?.filename === jobsPath && request === './fulfillment') return {};
  return originalLoad.call(this, request, parent, isMain);
};

let purgeOldCards;
try {
  ({ purgeOldCards } = require('../../src/jobs'));
} finally {
  Module._load = originalLoad;
}

const db = require('../../src/db');

beforeEach(() => {
  db.prepare('DELETE FROM orders').run();
  db.prepare('DELETE FROM audit_log').run();
});

function seedCard({ id, expiry, status = 'delivered' }) {
  db.prepare(
    `INSERT INTO orders
      (id, status, amount_usdc, payment_asset, api_key_id,
       card_number, card_cvv, card_expiry, card_brand)
     VALUES (?, ?, '42.50', 'usdc', 'merchant-key-id',
             'sealed-pan', 'sealed-cvv', ?, 'Visa')`,
  ).run(id, status, expiry);
}

it('purges card data only after expiry plus 90 days and audits without losing accounting fields', async () => {
  seedCard({ id: 'expired-order', expiry: '11/25', status: 'refunded' });

  const purged = await purgeOldCards(new Date('2026-04-01T00:00:00.000Z'));

  assert.equal(purged, 1);
  const order = db
    .prepare(
      `SELECT id, status, amount_usdc, api_key_id, card_number, card_cvv, card_expiry, card_brand
       FROM orders WHERE id = ?`,
    )
    .get('expired-order');
  assert.deepEqual(order, {
    id: 'expired-order',
    status: 'refunded',
    amount_usdc: '42.50',
    api_key_id: 'merchant-key-id',
    card_number: null,
    card_cvv: null,
    card_expiry: null,
    card_brand: 'Visa',
  });

  const audit = db
    .prepare(
      `SELECT action, resource_type, resource_id, details FROM audit_log
       WHERE action = 'compliance.card_data_purged' AND resource_id = ?`,
    )
    .get('expired-order');
  assert.ok(audit);
  assert.equal(audit.resource_type, 'order');
  assert.deepEqual(JSON.parse(audit.details), {
    retention_days: 90,
    fields: ['card_number', 'card_cvv', 'card_expiry'],
  });
});

it('retains card data at the 90-day boundary and skips malformed expiry values', async () => {
  seedCard({ id: 'boundary-order', expiry: '12/25' });
  seedCard({ id: 'malformed-order', expiry: 'not-an-expiry' });

  const purged = await purgeOldCards(new Date('2026-03-31T23:59:59.999Z'));

  assert.equal(purged, 0);
  for (const id of ['boundary-order', 'malformed-order']) {
    const row = db.prepare(`SELECT card_cvv FROM orders WHERE id = ?`).get(id);
    assert.equal(row.card_cvv, 'sealed-cvv');
  }
});
