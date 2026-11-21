// @ts-check
// GET /.well-known/jwks.json — platform Ed25519 public key for webhook verification.
//
// Webhook consumers fetch this endpoint to obtain the platform public key,
// then use it to verify X-Signature-Ed25519 headers on incoming webhook
// deliveries without needing any shared secret.
//
// The response is intentionally public and unauthenticated.

'use strict';

const { Router } = require('express');
const { loadPublicKey, publicKeyToJwk } = require('../lib/ed25519');

const router = Router();

// Lazy-load and cache the JWK so we pay the key-parse cost once.
let cachedJwks = null;

function getJwks() {
  if (cachedJwks) return cachedJwks;
  try {
    const pub = loadPublicKey();
    const jwk = publicKeyToJwk(pub);
    cachedJwks = { keys: [jwk] };
  } catch (err) {
    // Key not configured — return empty key set rather than a 500.
    cachedJwks = { keys: [] };
  }
  return cachedJwks;
}

router.get('/.well-known/jwks.json', (_req, res) => {
  res
    .set('Cache-Control', 'public, max-age=3600')
    .set('Content-Type', 'application/json')
    .json(getJwks());
});

module.exports = router;
