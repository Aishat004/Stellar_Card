// @ts-check
// API key generation and format validation.
//
// Key format (v2):  sk_{env}_{32 random hex chars}{6 hex CRC32 checksum}
//   env:            'live' or 'test'
//   random payload: 32 lowercase hex chars (128 bits of entropy)
//   checksum:       lower 24 bits of CRC32(prefix + random payload)
//                   as 6 lowercase hex chars
//
// Structure: sk_{env}_{32-char-payload}{6-char-checksum}
//            └──────┘└──────────────────────────────────┘
//              8 chars        38 chars = 46 total
//
// The checksum lets the middleware reject corrupted or mistyped keys
// before touching the database — no bcrypt work, no SQL, instant 401.
//
// Key prefix for DB lookup: 12 chars starting at offset 8
// (the first 12 hex chars of the random payload).  Matches the existing
// idx_api_keys_key_prefix index strategy.
//
// GitHub secret-scanning compatibility: the sk_live_ / sk_test_ prefix
// pattern follows Stripe/GitHub's well-known conventions; registering a
// custom secret-scanning pattern for /sk_(live|test)_[0-9a-f]{38}/ will
// prevent accidental commits from reaching upstream without raising
// false positives on arbitrary hex strings.

const crypto = require('crypto');

// CRC32 lookup table (Castagnoli polynomial: 0xEDB88320).
// Built once at module load; 256 entries × 4 bytes = 1 KiB — negligible.
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

/**
 * CRC32 of a UTF-8 string. Returns an unsigned 32-bit integer.
 * @param {string} str
 * @returns {number}
 */
function crc32(str) {
  let crc = 0xffffffff;
  for (let i = 0; i < str.length; i++) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ str.charCodeAt(i)) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Encode the lower 24 bits of a CRC32 value as 6 lowercase hex chars.
 * @param {number} checksum - Unsigned 32-bit CRC32 value.
 * @returns {string} 6-char hex string.
 */
function checksumHex(checksum) {
  return (checksum & 0xffffff).toString(16).padStart(6, '0');
}

/** @typedef {'live' | 'test'} ApiKeyEnv */

/**
 * Generate a new API key with prefix, random payload, and CRC32 checksum.
 *
 * @param {ApiKeyEnv} [env='live'] - 'live' for production keys, 'test' for sandbox.
 * @returns {string} The raw API key — show it to the user ONCE; store only the bcrypt hash.
 */
function generateApiKey(env = 'live') {
  if (env !== 'live' && env !== 'test') {
    throw new TypeError(`generateApiKey: env must be 'live' or 'test', got ${JSON.stringify(env)}`);
  }
  const payload = crypto.randomBytes(16).toString('hex'); // 32 hex chars = 128 bits
  const keyBody = `sk_${env}_${payload}`;
  const checksum = checksumHex(crc32(keyBody));
  return `${keyBody}${checksum}`;
}

// Precompiled regex for format-only check (env + 32 hex + 6 hex = 38 hex total).
const SK_PATTERN = /^sk_(live|test)_([0-9a-f]{38})$/;

/**
 * Validate the format and CRC32 checksum of an API key without touching the database.
 *
 * @param {unknown} key - The raw key to validate.
 * @returns {{ valid: true; env: ApiKeyEnv; payload: string; prefix: string } |
 *           { valid: false; reason: 'format' | 'checksum' }}
 */
function validateApiKeyFormat(key) {
  if (typeof key !== 'string') return { valid: false, reason: 'format' };

  const m = SK_PATTERN.exec(key);
  if (!m) return { valid: false, reason: 'format' };

  const env = /** @type {ApiKeyEnv} */ (m[1]);
  const hexPart = m[2]; // 32 random + 6 checksum
  const randomPart = hexPart.slice(0, 32);
  const providedCheck = hexPart.slice(32); // 6 chars

  // Recompute checksum over everything before the checksum suffix.
  const keyBody = `sk_${env}_${randomPart}`;
  const expectedCheck = checksumHex(crc32(keyBody));

  if (providedCheck !== expectedCheck) return { valid: false, reason: 'checksum' };

  return {
    valid: true,
    env,
    payload: randomPart,
    // First 12 chars of the random payload — the DB prefix index window.
    prefix: randomPart.slice(0, 12),
  };
}

/**
 * Extract the 12-char key_prefix from a validated API key for DB lookup.
 * Returns null if the key fails format validation.
 *
 * @param {string} key
 * @returns {string | null}
 */
function extractKeyPrefix(key) {
  const result = validateApiKeyFormat(key);
  return result.valid ? result.prefix : null;
}

module.exports = {
  generateApiKey,
  validateApiKeyFormat,
  extractKeyPrefix,
  /** @internal — exported for unit tests only */
  _crc32: crc32,
  /** @internal */
  _checksumHex: checksumHex,
};
