// Unit tests for the Ed25519 webhook signing helpers in src/lib/ed25519.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  generateKeyPair,
  signWebhookPayload,
  verifyWebhookSignature,
  publicKeyToJwk,
  loadPrivateKey,
  loadPublicKey,
} = require('../../src/lib/ed25519');

const { privateKey, publicKey } = generateKeyPair();
const BODY = JSON.stringify({ event: 'order.fulfilled', order_id: 'abc-123' });
const NOW = 1700000000000;

describe('signWebhookPayload', () => {
  it('returns a base64url signature and a decimal timestamp string', () => {
    const { signature, timestamp } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW });
    assert.equal(timestamp, String(NOW));
    // base64url characters only
    assert.match(signature, /^[A-Za-z0-9_-]+=*$/);
    // Ed25519 signatures are always 64 bytes → 86 base64url chars (no padding needed)
    const decoded = Buffer.from(signature, 'base64url');
    assert.equal(decoded.length, 64);
  });

  it('produces different signatures for different bodies', () => {
    const { signature: s1 } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW });
    const { signature: s2 } = signWebhookPayload({
      rawBody: BODY + ' ',
      privateKey,
      now: NOW,
    });
    assert.notEqual(s1, s2);
  });

  it('produces different signatures for different timestamps', () => {
    const { signature: s1 } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW });
    const { signature: s2 } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW + 1 });
    assert.notEqual(s1, s2);
  });
});

describe('verifyWebhookSignature', () => {
  it('returns ok:true for a valid signature', () => {
    const { signature, timestamp } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW });
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: signature,
      timestamp,
      publicKey,
      now: NOW,
    });
    assert.deepEqual(result, { ok: true });
  });

  it('returns bad_signature for a tampered body', () => {
    const { signature, timestamp } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW });
    const result = verifyWebhookSignature({
      rawBody: BODY + 'tampered',
      signatureHeader: signature,
      timestamp,
      publicKey,
      now: NOW,
    });
    assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
  });

  it('returns bad_signature for a tampered signature', () => {
    const { signature, timestamp } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW });
    // flip one char
    const bad = signature.replace(signature[0], signature[0] === 'A' ? 'B' : 'A');
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: bad,
      timestamp,
      publicKey,
      now: NOW,
    });
    assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
  });

  it('returns timestamp_expired when timestamp is outside the replay window', () => {
    const { signature, timestamp } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW });
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: signature,
      timestamp,
      publicKey,
      now: NOW + 11 * 60 * 1000, // 11 min later
    });
    assert.deepEqual(result, { ok: false, reason: 'timestamp_expired' });
  });

  it('returns missing_fields when signature header is absent', () => {
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: '',
      timestamp: String(NOW),
      publicKey,
      now: NOW,
    });
    assert.deepEqual(result, { ok: false, reason: 'missing_fields' });
  });

  it('returns missing_fields for a non-numeric timestamp', () => {
    const { signature } = signWebhookPayload({ rawBody: BODY, privateKey, now: NOW });
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: signature,
      timestamp: 'not-a-number',
      publicKey,
      now: NOW,
    });
    assert.deepEqual(result, { ok: false, reason: 'missing_fields' });
  });

  it('rejects a signature from a different key pair', () => {
    const { privateKey: otherPriv, publicKey: otherPub } = generateKeyPair();
    const { signature, timestamp } = signWebhookPayload({ rawBody: BODY, privateKey: otherPriv, now: NOW });
    // verify with original publicKey — should fail
    const result = verifyWebhookSignature({
      rawBody: BODY,
      signatureHeader: signature,
      timestamp,
      publicKey,
      now: NOW,
    });
    assert.deepEqual(result, { ok: false, reason: 'bad_signature' });
  });
});

describe('publicKeyToJwk', () => {
  it('returns a JWK with kty=OKP and crv=Ed25519', () => {
    const jwk = publicKeyToJwk(publicKey);
    assert.equal(jwk.kty, 'OKP');
    assert.equal(jwk.crv, 'Ed25519');
    assert.equal(jwk.use, 'sig');
    assert.equal(jwk.alg, 'EdDSA');
    assert.ok(typeof jwk.x === 'string', 'x (public key material) must be present');
    assert.ok(!('d' in jwk), 'private key material must not appear in the JWK');
  });

  it('uses the provided kid', () => {
    const jwk = publicKeyToJwk(publicKey, 'my-key-id');
    assert.equal(jwk.kid, 'my-key-id');
  });
});

describe('loadPrivateKey', () => {
  it('loads a PEM-encoded private key', () => {
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
    const loaded = loadPrivateKey(/** @type {string} */ (pem));
    assert.equal(loaded.type, 'private');
    assert.equal(loaded.asymmetricKeyType, 'ed25519');
  });

  it('throws when no key is provided and env var is unset', () => {
    const saved = process.env.WEBHOOK_ED25519_PRIVATE_KEY;
    delete process.env.WEBHOOK_ED25519_PRIVATE_KEY;
    assert.throws(() => loadPrivateKey(), /not configured/);
    if (saved !== undefined) process.env.WEBHOOK_ED25519_PRIVATE_KEY = saved;
  });
});
