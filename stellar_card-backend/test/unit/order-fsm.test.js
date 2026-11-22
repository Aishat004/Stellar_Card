// Unit tests for the order lifecycle FSM in src/orders/core.js.

require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { db, resetDb, seedOrder } = require('../helpers/app');
const {
  ORDER_TRANSITIONS,
  InvalidOrderTransitionError,
  canTransition,
  transitionOrder,
} = require('../../src/orders/core');

const STATES = Object.keys(ORDER_TRANSITIONS);

describe('order FSM — transition table', () => {
  it('only references known states as targets', () => {
    for (const [from, targets] of Object.entries(ORDER_TRANSITIONS)) {
      for (const to of targets) {
        assert.ok(STATES.includes(to), `${from} -> ${to} targets an unknown state`);
      }
    }
  });

  it('gives terminal states no outgoing edges', () => {
    for (const terminal of ['refunded', 'expired', 'rejected']) {
      assert.deepEqual(ORDER_TRANSITIONS[terminal], []);
    }
  });

  it('is frozen so callers cannot widen it at runtime', () => {
    assert.ok(Object.isFrozen(ORDER_TRANSITIONS));
    assert.ok(Object.isFrozen(ORDER_TRANSITIONS.pending_payment));
  });

  it('never allows a state to transition to itself', () => {
    for (const s of STATES) assert.equal(canTransition(s, s), false, `${s} -> ${s}`);
  });
});

describe('order FSM — canTransition', () => {
  it('allows the main happy path and the refund path', () => {
    assert.equal(canTransition('pending_payment', 'ordering'), true);
    assert.equal(canTransition('ordering', 'delivered'), true);
    assert.equal(canTransition('delivered', 'refund_pending'), true);
    assert.equal(canTransition('refund_pending', 'refunded'), true);
  });

  it('allows the approval flow', () => {
    assert.equal(canTransition('awaiting_approval', 'pending_payment'), true);
    assert.equal(canTransition('awaiting_approval', 'rejected'), true);
  });

  it('forbids leaving a terminal state', () => {
    assert.equal(canTransition('refunded', 'delivered'), false);
    assert.equal(canTransition('expired', 'pending_payment'), false);
    assert.equal(canTransition('rejected', 'pending_payment'), false);
  });

  it('forbids skipping steps', () => {
    assert.equal(canTransition('pending_payment', 'delivered'), false);
    assert.equal(canTransition('delivered', 'pending_payment'), false);
    assert.equal(canTransition('failed', 'delivered'), false);
  });

  it('rejects unknown and prototype-chain keys', () => {
    assert.equal(canTransition('nope', 'delivered'), false);
    assert.equal(canTransition('constructor', 'delivered'), false);
    assert.equal(canTransition('__proto__', 'delivered'), false);
  });
});

describe('order FSM — transitionOrder', () => {
  beforeEach(() => resetDb());

  const statusOf = (id) => db.prepare(`SELECT status FROM orders WHERE id = ?`).get(id).status;

  it('moves the row when the current status matches', () => {
    const id = seedOrder({ status: 'pending_payment' });
    assert.equal(transitionOrder({ id, from: 'pending_payment', to: 'ordering' }), true);
    assert.equal(statusOf(id), 'ordering');
  });

  it('returns false and leaves the row alone when another writer moved it first', () => {
    const id = seedOrder({ status: 'ordering' });
    // A concurrent writer already delivered this order.
    db.prepare(`UPDATE orders SET status = 'delivered' WHERE id = ?`).run(id);
    assert.equal(transitionOrder({ id, from: 'ordering', to: 'failed' }), false);
    assert.equal(statusOf(id), 'delivered');
  });

  it('throws InvalidOrderTransitionError for an edge that does not exist', () => {
    const id = seedOrder({ status: 'delivered' });
    assert.throws(
      () => transitionOrder({ id, from: 'delivered', to: 'pending_payment' }),
      (err) =>
        err instanceof InvalidOrderTransitionError &&
        err.from === 'delivered' &&
        err.to === 'pending_payment',
    );
    assert.equal(statusOf(id), 'delivered', 'an illegal edge must not write');
  });
});
