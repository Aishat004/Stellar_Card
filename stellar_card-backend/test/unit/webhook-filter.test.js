require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ALL_EVENTS,
  resolveEventType,
  parseFilter,
  shouldDispatch,
  validateEventFilter,
} = require('../../src/lib/webhook-filter');

// ---------------------------------------------------------------------------
// resolveEventType
// ---------------------------------------------------------------------------

describe('resolveEventType', () => {
  it('returns event_type field when present', () => {
    assert.equal(resolveEventType({ event_type: 'order.delivered' }), 'order.delivered');
  });

  it('maps status field to canonical event type', () => {
    assert.equal(resolveEventType({ status: 'delivered' }), 'order.delivered');
    assert.equal(resolveEventType({ status: 'failed' }), 'order.failed');
    assert.equal(resolveEventType({ status: 'expired' }), 'order.expired');
    assert.equal(resolveEventType({ status: 'pending_recovery' }), 'order.pending_recovery');
    assert.equal(resolveEventType({ status: 'refunded' }), 'order.refunded');
    assert.equal(resolveEventType({ status: 'refund_pending' }), 'order.refund_pending');
  });

  it('prefixes unknown status values with "order."', () => {
    assert.equal(resolveEventType({ status: 'custom_status' }), 'order.custom_status');
  });

  it('returns undefined when neither event_type nor status is present', () => {
    assert.equal(resolveEventType({}), undefined);
  });

  it('prefers event_type over status when both are present', () => {
    assert.equal(
      resolveEventType({ event_type: 'order.delivered', status: 'failed' }),
      'order.delivered',
    );
  });
});

// ---------------------------------------------------------------------------
// parseFilter
// ---------------------------------------------------------------------------

describe('parseFilter', () => {
  it('returns null for null input (wildcard)', () => {
    assert.equal(parseFilter(null), null);
  });

  it('returns null for undefined input', () => {
    assert.equal(parseFilter(undefined), null);
  });

  it('returns null for empty string', () => {
    assert.equal(parseFilter(''), null);
  });

  it('returns null for the wildcard string "*"', () => {
    assert.equal(parseFilter('*'), null);
  });

  it('returns null for an empty array', () => {
    assert.equal(parseFilter([]), null);
  });

  it('returns null when the array contains the wildcard "*"', () => {
    assert.equal(parseFilter(['order.delivered', '*']), null);
  });

  it('parses a JSON-encoded array string', () => {
    const result = parseFilter('["order.delivered","order.failed"]');
    assert.deepEqual(result, ['order.delivered', 'order.failed']);
  });

  it('passes through a plain array', () => {
    const result = parseFilter(['order.delivered', 'order.failed']);
    assert.deepEqual(result, ['order.delivered', 'order.failed']);
  });

  it('filters out non-string entries', () => {
    const result = parseFilter(['order.delivered', 42, null, 'order.failed']);
    assert.deepEqual(result, ['order.delivered', 'order.failed']);
  });

  it('returns null for invalid JSON', () => {
    assert.equal(parseFilter('{not_valid'), null);
  });
});

// ---------------------------------------------------------------------------
// shouldDispatch
// ---------------------------------------------------------------------------

describe('shouldDispatch', () => {
  it('always returns true for a null (wildcard) filter', () => {
    assert.equal(shouldDispatch({ status: 'delivered' }, null), true);
    assert.equal(shouldDispatch({ status: 'failed' }, null), true);
    assert.equal(shouldDispatch({}, null), true);
  });

  it('returns true when the payload event type is in the filter list', () => {
    const filter = ['order.delivered', 'order.failed'];
    assert.equal(shouldDispatch({ status: 'delivered' }, filter), true);
    assert.equal(shouldDispatch({ status: 'failed' }, filter), true);
  });

  it('returns false when the payload event type is NOT in the filter list', () => {
    const filter = ['order.delivered'];
    assert.equal(shouldDispatch({ status: 'failed' }, filter), false);
    assert.equal(shouldDispatch({ status: 'expired' }, filter), false);
  });

  it('returns true for an unresolvable event type (pass-through, no events swallowed)', () => {
    const filter = ['order.delivered'];
    assert.equal(shouldDispatch({}, filter), true);
  });

  it('uses the event_type field when present', () => {
    const filter = ['order.failed'];
    assert.equal(shouldDispatch({ event_type: 'order.failed', status: 'delivered' }, filter), true);
  });

  it('single-event subscription: delivered only', () => {
    const filter = ['order.delivered'];
    assert.equal(shouldDispatch({ status: 'delivered' }, filter), true);
    assert.equal(shouldDispatch({ status: 'failed' }, filter), false);
    assert.equal(shouldDispatch({ status: 'expired' }, filter), false);
  });

  it('two-event subscription: delivered + failed', () => {
    const filter = ['order.delivered', 'order.failed'];
    assert.equal(shouldDispatch({ status: 'delivered' }, filter), true);
    assert.equal(shouldDispatch({ status: 'failed' }, filter), true);
    assert.equal(shouldDispatch({ status: 'expired' }, filter), false);
  });
});

// ---------------------------------------------------------------------------
// validateEventFilter
// ---------------------------------------------------------------------------

describe('validateEventFilter', () => {
  it('accepts null (clear the filter)', () => {
    assert.equal(validateEventFilter(null), undefined);
  });

  it('accepts undefined (clear the filter)', () => {
    assert.equal(validateEventFilter(undefined), undefined);
  });

  it('accepts the wildcard string "*"', () => {
    assert.equal(validateEventFilter('*'), undefined);
  });

  it('accepts an empty array', () => {
    assert.equal(validateEventFilter([]), undefined);
  });

  it('accepts a valid array of known event types', () => {
    assert.equal(
      validateEventFilter(['order.delivered', 'order.failed', 'order.expired']),
      undefined,
    );
  });

  it('rejects a non-array, non-string, non-null value', () => {
    assert.ok(typeof validateEventFilter(42) === 'string');
    assert.ok(typeof validateEventFilter(true) === 'string');
  });

  it('rejects an array containing an unknown event type', () => {
    const result = validateEventFilter(['order.delivered', 'order.hacked']);
    assert.ok(typeof result === 'string');
    assert.ok(result.includes('order.hacked'));
  });

  it('rejects an array containing a non-string entry', () => {
    const result = validateEventFilter(['order.delivered', 42]);
    assert.ok(typeof result === 'string');
  });

  it('ALL_EVENTS constant equals "*"', () => {
    assert.equal(ALL_EVENTS, '*');
  });
});
