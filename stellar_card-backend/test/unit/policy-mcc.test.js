require('../helpers/env');

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { createTestKey, resetDb } = require('../helpers/app');
const { checkPolicy } = require('../../src/policy');

describe('#980 merchant category restriction', () => {
  let apiKeyId;

  beforeEach(async () => {
    resetDb();
    apiKeyId = (await createTestKey({ label: 'mcc-test' })).id;
  });

  afterEach(() => {
    delete process.env.ORG_BLOCKED_MCCS;
  });

  it('blocks the default gambling and adult MCCs', () => {
    for (const mcc of ['7995', '5967']) {
      const r = checkPolicy(apiKeyId, '10.00', { mcc, persist: false });
      assert.equal(r.decision, 'blocked', `MCC ${mcc} should be blocked`);
      assert.equal(r.rule, 'blocked_mcc');
    }
  });

  it('approves an MCC that is not restricted', () => {
    const r = checkPolicy(apiKeyId, '10.00', { mcc: '5411', persist: false });
    assert.equal(r.decision, 'approved');
  });

  it('does not check the category when the caller supplies none', () => {
    const r = checkPolicy(apiKeyId, '10.00', { persist: false });
    assert.equal(r.decision, 'approved');
  });

  it('fails closed on a malformed MCC', () => {
    const r = checkPolicy(apiKeyId, '10.00', { mcc: 'gambling', persist: false });
    assert.equal(r.decision, 'blocked');
    assert.equal(r.rule, 'invalid_mcc');
  });

  it('honours the ORG_BLOCKED_MCCS override', () => {
    process.env.ORG_BLOCKED_MCCS = '5999';
    assert.equal(
      checkPolicy(apiKeyId, '10.00', { mcc: '5999', persist: false }).rule,
      'blocked_mcc',
    );
    assert.equal(
      checkPolicy(apiKeyId, '10.00', { mcc: '7995', persist: false }).decision,
      'approved',
    );
  });
});
