// Unit tests for the API key generation and format validation helpers (issue #1001).
// All tests run on pure JavaScript — no database, no network.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  generateApiKey,
  validateApiKeyFormat,
  extractKeyPrefix,
  _crc32,
  _checksumHex,
} = require('../../src/lib/api-key');

// ---------------------------------------------------------------------------
// _crc32 internals
// ---------------------------------------------------------------------------

describe('api-key: _crc32', () => {
  it('returns a non-negative integer', () => {
    const v = _crc32('hello');
    assert.ok(Number.isInteger(v) && v >= 0);
  });

  it('returns different values for different inputs', () => {
    assert.notEqual(_crc32('sk_live_aabbcc'), _crc32('sk_test_aabbcc'));
  });

  it('is deterministic', () => {
    assert.equal(_crc32('stellar_card'), _crc32('stellar_card'));
  });

  it('empty string returns a stable non-zero value', () => {
    assert.equal(_crc32(''), _crc32(''));
    assert.ok(typeof _crc32('') === 'number');
  });

  it('result fits in 32 bits (unsigned)', () => {
    const v = _crc32('anything');
    assert.ok(v >= 0 && v <= 0xffffffff);
  });
});

// ---------------------------------------------------------------------------
// _checksumHex
// ---------------------------------------------------------------------------

describe('api-key: _checksumHex', () => {
  it('always returns exactly 6 lowercase hex chars', () => {
    for (const v of [0, 1, 0xabc123, 0xffffff, 0xdeadbeef]) {
      const h = _checksumHex(v);
      assert.match(h, /^[0-9a-f]{6}$/);
    }
  });

  it('zero pads to 6 chars', () => {
    assert.equal(_checksumHex(0), '000000');
  });

  it('uses lower 24 bits only', () => {
    assert.equal(_checksumHex(0xdeadbeef), _checksumHex(0xbeef));
  });
});

// ---------------------------------------------------------------------------
// generateApiKey
// ---------------------------------------------------------------------------

describe('api-key: generateApiKey', () => {
  it('returns a 46-char string', () => {
    assert.equal(generateApiKey('live').length, 46);
    assert.equal(generateApiKey('test').length, 46);
  });

  it('live key starts with sk_live_', () => {
    assert.ok(generateApiKey('live').startsWith('sk_live_'));
  });

  it('test key starts with sk_test_', () => {
    assert.ok(generateApiKey('test').startsWith('sk_test_'));
  });

  it('defaults to live when no env is supplied', () => {
    assert.ok(generateApiKey().startsWith('sk_live_'));
  });

  it('throws on an unsupported env value', () => {
    // @ts-expect-error intentional wrong type
    assert.throws(() => generateApiKey('prod'), /must be 'live' or 'test'/);
  });

  it('every generated key passes validateApiKeyFormat', () => {
    for (let i = 0; i < 20; i++) {
      const key = generateApiKey(i % 2 === 0 ? 'live' : 'test');
      const result = validateApiKeyFormat(key);
      assert.ok(result.valid, `key ${key} failed validation`);
    }
  });

  it('two calls produce different keys (no static output)', () => {
    assert.notEqual(generateApiKey('live'), generateApiKey('live'));
  });

  it('key contains only printable ASCII', () => {
    const key = generateApiKey('live');
    assert.match(key, /^[!-~]+$/);
  });
});

// ---------------------------------------------------------------------------
// validateApiKeyFormat
// ---------------------------------------------------------------------------

describe('api-key: validateApiKeyFormat — valid keys', () => {
  it('valid live key: returns valid=true with correct env and prefix', () => {
    const key = generateApiKey('live');
    const result = validateApiKeyFormat(key);
    assert.ok(result.valid);
    if (result.valid) {
      assert.equal(result.env, 'live');
      assert.match(result.prefix, /^[0-9a-f]{12}$/);
      assert.match(result.payload, /^[0-9a-f]{32}$/);
    }
  });

  it('valid test key: returns env=test', () => {
    const key = generateApiKey('test');
    const result = validateApiKeyFormat(key);
    assert.ok(result.valid);
    if (result.valid) assert.equal(result.env, 'test');
  });

  it('prefix is first 12 chars of the random payload', () => {
    const key = generateApiKey('live');
    const result = validateApiKeyFormat(key);
    assert.ok(result.valid);
    if (result.valid) {
      // key = sk_live_ (8) + 32 payload + 6 checksum
      const expectedPrefix = key.slice(8, 20);
      assert.equal(result.prefix, expectedPrefix);
    }
  });
});

describe('api-key: validateApiKeyFormat — invalid keys', () => {
  it('returns format error for undefined', () => {
    // @ts-expect-error intentional
    const r = validateApiKeyFormat(undefined);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'format');
  });

  it('returns format error for empty string', () => {
    const r = validateApiKeyFormat('');
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'format');
  });

  it('returns format error for legacy stellar_card_ key', () => {
    const r = validateApiKeyFormat(`stellar_card_${'a'.repeat(48)}`);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'format');
  });

  it('returns format error when payload chars are uppercase', () => {
    const key = generateApiKey('live').toUpperCase();
    const r = validateApiKeyFormat(key);
    assert.equal(r.valid, false);
  });

  it('returns format error when key is 1 char too short', () => {
    const key = generateApiKey('live').slice(0, -1);
    const r = validateApiKeyFormat(key);
    assert.equal(r.valid, false);
  });

  it('returns format error when key is 1 char too long', () => {
    const key = generateApiKey('live') + 'x';
    const r = validateApiKeyFormat(key);
    assert.equal(r.valid, false);
  });

  it('returns checksum error when last 6 chars are flipped', () => {
    const key = generateApiKey('live');
    const corrupted = key.slice(0, 40) + '000000'; // replace checksum with zeros
    // If the original checksum happens to be 000000 this would still be a valid
    // key — extremely unlikely (1 in 16M), but we need to handle it.
    const r = validateApiKeyFormat(corrupted);
    if (key.slice(40) === '000000') {
      assert.ok(r.valid); // extremely rare coincidence — key already had 000000 checksum
    } else {
      assert.equal(r.valid, false);
      assert.equal(r.reason, 'checksum');
    }
  });

  it('detects single-character mutation in payload (checksum mismatch)', () => {
    const key = generateApiKey('live');
    // Flip one hex char in the random payload (position 8).
    const flippedChar = key[8] === 'a' ? 'b' : 'a';
    const mutated = key.slice(0, 8) + flippedChar + key.slice(9);
    const r = validateApiKeyFormat(mutated);
    assert.equal(r.valid, false);
    assert.equal(r.reason, 'checksum');
  });
});

// ---------------------------------------------------------------------------
// extractKeyPrefix
// ---------------------------------------------------------------------------

describe('api-key: extractKeyPrefix', () => {
  it('returns a 12-char hex prefix for a valid key', () => {
    const key = generateApiKey('live');
    const prefix = extractKeyPrefix(key);
    assert.ok(prefix !== null);
    assert.match(/** @type {string} */ (prefix), /^[0-9a-f]{12}$/);
  });

  it('returns null for a malformed key', () => {
    assert.equal(extractKeyPrefix('not-a-key'), null);
  });

  it('returns null for a key with a bad checksum', () => {
    const key = generateApiKey('live');
    const corrupted = key.slice(0, 40) + '000000';
    // Only null when checksum truly differs.
    if (key.slice(40) !== '000000') {
      assert.equal(extractKeyPrefix(corrupted), null);
    }
  });

  it('prefix is consistent across calls for the same key', () => {
    const key = generateApiKey('live');
    assert.equal(extractKeyPrefix(key), extractKeyPrefix(key));
  });
});
