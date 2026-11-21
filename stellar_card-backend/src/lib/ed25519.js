// @ts-check
// Ed25519 asymmetric signing for outbound webhook payloads.
//
// Unlike the shared-secret HMAC scheme in hmac.js, this lets webhook
// consumers verify payload authenticity using only the platform's
// PUBLIC key — no shared secret distribution required.
//
// Signing payload: `${timestamp}.${rawBody}` (timestamp is Unix ms as a
// decimal string). Consumers reconstruct the same string and call
// nacl_verify / crypto.verify / libsodium depending on their runtime.
//
// Headers produced:
//   X-Signature-Ed25519: base64url(signature_bytes)
//   X-Webhook-Timestamp:  <unix ms>
//
// The public key is published at /.well-known/jwks.json as a JWK with
// kty=OKP, crv=Ed25519 so standard JWKS clients can consume it.

'use strict';

const crypto = require('crypto');

/**
 * Generate a new Ed25519 key pair.
 * In production the private key is stored in an env/secret vault and
 * the public key is served from /.well-known/jwks.json.
 *
 * @returns {{ privateKey: crypto.KeyObject, publicKey: crypto.KeyObject }}
 */
function generateKeyPair() {
  return crypto.generateKeyPairSync('ed25519');
}

/**
 * Load the platform Ed25519 private key from an environment variable.
 * The variable must hold a PEM-encoded PKCS#8 private key (the standard
 * output format of `openssl genpkey -algorithm ED25519`).
 *
 * @param {string} [pem]  PEM string; defaults to process.env.WEBHOOK_ED25519_PRIVATE_KEY.
 * @returns {crypto.KeyObject}
 */
function loadPrivateKey(pem) {
  const src = pem ?? process.env.WEBHOOK_ED25519_PRIVATE_KEY;
  if (!src) {
    throw new Error(
      'Ed25519 private key not configured. ' +
        'Set WEBHOOK_ED25519_PRIVATE_KEY to a PEM-encoded PKCS#8 Ed25519 private key.',
    );
  }
  return crypto.createPrivateKey(src);
}

/**
 * Load the platform Ed25519 public key.
 * Derives from the private key when only PEM_PRIVATE is set; also
 * accepts an explicit PEM public key string.
 *
 * @param {string} [pem]  PEM string; defaults to deriving from the private key.
 * @returns {crypto.KeyObject}
 */
function loadPublicKey(pem) {
  if (pem) return crypto.createPublicKey(pem);
  const priv = loadPrivateKey();
  return crypto.createPublicKey(priv);
}

/**
 * Sign a webhook payload.
 *
 * @param {object} args
 * @param {string | Buffer} args.rawBody       Raw request body bytes.
 * @param {crypto.KeyObject}  args.privateKey  Ed25519 private key.
 * @param {number}  [args.now]                 Injected clock (ms). Defaults to Date.now().
 * @returns {{ signature: string, timestamp: string }}
 *   signature — base64url-encoded Ed25519 signature
 *   timestamp — Unix epoch ms as a decimal string
 */
function signWebhookPayload({ rawBody, privateKey, now = Date.now() }) {
  const timestamp = String(now);
  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const payload = `${timestamp}.${bodyStr}`;
  const sigBuf = crypto.sign(null, Buffer.from(payload, 'utf8'), privateKey);
  return {
    signature: sigBuf.toString('base64url'),
    timestamp,
  };
}

/**
 * Verify an inbound Ed25519 webhook signature.
 *
 * @param {object} args
 * @param {string | Buffer} args.rawBody         Raw request body bytes.
 * @param {string}          args.signatureHeader  Value of X-Signature-Ed25519 header.
 * @param {string}          args.timestamp        Value of X-Webhook-Timestamp header.
 * @param {crypto.KeyObject} args.publicKey       Ed25519 public key.
 * @param {number}  [args.maxSkewMs]              Replay window (default 10 min).
 * @param {number}  [args.now]                    Injected clock (ms).
 * @returns {{ ok: true } | { ok: false, reason: 'missing_fields' | 'timestamp_expired' | 'bad_signature' }}
 */
function verifyWebhookSignature({
  rawBody,
  signatureHeader,
  timestamp,
  publicKey,
  maxSkewMs = 10 * 60 * 1000,
  now = Date.now(),
}) {
  if (!signatureHeader || !timestamp || rawBody === undefined || rawBody === null) {
    return { ok: false, reason: 'missing_fields' };
  }

  if (typeof timestamp !== 'string' || !/^\d+$/.test(timestamp)) {
    return { ok: false, reason: 'missing_fields' };
  }

  const ts = parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > maxSkewMs) {
    return { ok: false, reason: 'timestamp_expired' };
  }

  let sigBuf;
  try {
    sigBuf = Buffer.from(signatureHeader, 'base64url');
    if (sigBuf.length !== 64) return { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }

  const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const payload = `${timestamp}.${bodyStr}`;

  try {
    const valid = crypto.verify(null, Buffer.from(payload, 'utf8'), publicKey, sigBuf);
    return valid ? { ok: true } : { ok: false, reason: 'bad_signature' };
  } catch {
    return { ok: false, reason: 'bad_signature' };
  }
}

/**
 * Export the public key as a JWK suitable for inclusion in a JWKS document.
 *
 * @param {crypto.KeyObject} publicKey
 * @param {string} [kid]  Key ID (defaults to 'webhook-ed25519-1').
 * @returns {object} JWK
 */
function publicKeyToJwk(publicKey, kid = 'webhook-ed25519-1') {
  const jwk = publicKey.export({ format: 'jwk' });
  return {
    ...jwk,
    use: 'sig',
    alg: 'EdDSA',
    kid,
  };
}

module.exports = {
  generateKeyPair,
  loadPrivateKey,
  loadPublicKey,
  signWebhookPayload,
  verifyWebhookSignature,
  publicKeyToJwk,
};
