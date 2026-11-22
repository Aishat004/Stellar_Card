require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const { db, resetDb, createTestKey } = require('../helpers/app');
const bus = require('../../src/lib/event-bus');
const { streamDelivery } = require('../../src/mpp/wait-for-delivery');

function fakeRes() {
  const res = {
    chunks: [],
    ended: false,
    set() {
      return res;
    },
    flushHeaders() {},
    write(s) {
      res.chunks.push(s);
      return true;
    },
    end() {
      res.ended = true;
    },
  };
  return res;
}

function fakeReq() {
  const handlers = {};
  return {
    on(ev, fn) {
      handlers[ev] = fn;
    },
    close() {
      if (handlers.close) handlers.close();
    },
  };
}

const toEvent = (row) => ({ state: row.status, order_id: row.id });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('#969 SSE delivery stream', () => {
  let apiKeyId;

  beforeEach(async () => {
    resetDb();
    apiKeyId = (await createTestKey({ label: 'sse-test' })).id;
  });

  function seedOrder(status = 'pending_payment') {
    const id = uuidv4();
    db.prepare(
      `INSERT INTO orders (id, status, amount_usdc, payment_asset, api_key_id, created_at, updated_at)
       VALUES (?, ?, '10.00', 'usdc', ?, datetime('now'), datetime('now'))`,
    ).run(id, status, apiKeyId);
    return id;
  }

  it('ends immediately with the terminal state when the order is already delivered', () => {
    const orderId = seedOrder('delivered');
    const res = fakeRes();
    streamDelivery(fakeReq(), res, { orderId, toEvent });
    assert.equal(res.ended, true);
    assert.ok(res.chunks.some((c) => c.startsWith('event: delivery\n')));
    assert.ok(res.chunks.some((c) => c.includes('"state":"delivered"')));
  });

  it('waits on the bus and ends when the order is fulfilled', () => {
    const orderId = seedOrder();
    const res = fakeRes();
    streamDelivery(fakeReq(), res, { orderId, toEvent });
    assert.equal(res.ended, false);

    db.prepare(`UPDATE orders SET status = 'delivered' WHERE id = ?`).run(orderId);
    bus.emit('biz', { name: 'order.fulfilled', fields: { order_id: orderId } });

    assert.equal(res.ended, true);
    assert.ok(res.chunks.some((c) => c.includes('"state":"delivered"')));
  });

  it('ignores terminal events for other orders', () => {
    const orderId = seedOrder();
    const other = seedOrder();
    const req = fakeReq();
    const res = fakeRes();
    streamDelivery(req, res, { orderId, toEvent });

    db.prepare(`UPDATE orders SET status = 'delivered' WHERE id = ?`).run(other);
    bus.emit('biz', { name: 'order.fulfilled', fields: { order_id: other } });
    assert.equal(res.ended, false);

    // Close the stream so its timers don't outlive the test.
    req.close();
  });

  it('ends with a timeout event when the order stays in flight', async () => {
    const orderId = seedOrder();
    const res = fakeRes();
    streamDelivery(fakeReq(), res, { orderId, toEvent, timeoutMs: 20 });
    await sleep(60);
    assert.equal(res.ended, true);
    assert.ok(res.chunks.some((c) => c.startsWith('event: timeout\n')));
  });

  it('unsubscribes from the bus when the client disconnects', () => {
    const orderId = seedOrder();
    const before = bus.listenerCount();
    const req = fakeReq();
    const res = fakeRes();
    streamDelivery(req, res, { orderId, toEvent });
    assert.equal(bus.listenerCount(), before + 1);

    req.close();
    assert.equal(bus.listenerCount(), before);
  });
});
