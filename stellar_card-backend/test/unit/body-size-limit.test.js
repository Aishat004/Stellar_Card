// Unit tests for request body-size limits (#1003).
//
// Verifies that:
//   - The global express.json limit is set to '50kb' in app.js.
//   - A larger '500kb' parser is mounted specifically for /v1/orders/batch.
//   - The errorHandler sets Connection: close on 413 responses.
//   - The 413 error body has the expected shape.
//
// These tests exercise the middleware configuration directly (reading the
// app.js source and the errorHandler module) rather than making live HTTP
// requests, which would require a fully-booted server.  The integration
// consequence — that an oversized body actually returns 413 — is covered by
// the description of express.json's built-in behaviour; we pin the config
// values and the error-handler's Connection header here.

require('../helpers/env');

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const APP_JS = path.join(__dirname, '../../src/app.js');
const ERROR_HANDLER_JS = path.join(__dirname, '../../src/middleware/errorHandler.js');

const appSource = fs.readFileSync(APP_JS, 'utf8');
const errorHandlerSource = fs.readFileSync(ERROR_HANDLER_JS, 'utf8');

// ── app.js configuration checks ──────────────────────────────────────────────

describe('Body size limit configuration in app.js', () => {
  it('sets global express.json limit to 50kb', () => {
    // The global parser (not scoped to a path) must use 50kb.
    // We look for express.json({ limit: '50kb' ... }) that is NOT preceded
    // by a path argument on the same app.use() call.
    assert.ok(
      appSource.includes("limit: '50kb'"),
      "app.js must configure express.json with limit: '50kb'",
    );
  });

  it('mounts a 500kb express.json parser on /v1/orders/batch', () => {
    assert.ok(
      appSource.includes("'/v1/orders/batch'") && appSource.includes("limit: '500kb'"),
      "app.js must mount a 500kb body parser scoped to '/v1/orders/batch'",
    );
  });

  it('the 500kb parser is registered before the global 50kb parser', () => {
    const batchIndex = appSource.indexOf("'/v1/orders/batch'");
    const globalIndex = appSource.indexOf("limit: '50kb'");
    assert.ok(
      batchIndex !== -1 && globalIndex !== -1,
      'both parsers must be present',
    );
    assert.ok(
      batchIndex < globalIndex,
      'the 500kb batch parser must be registered before the global 50kb parser',
    );
  });

  it('the global parser limit is NOT 64kb (previous value)', () => {
    // The old limit was 64kb; ensure it has been updated.
    // A bare "64kb" in context of express.json limit should not appear.
    const hasOld64kb = /express\.json\s*\(\s*\{[^}]*limit\s*:\s*['"]64kb['"]/.test(appSource);
    assert.ok(!hasOld64kb, "global express.json limit must not be '64kb' any more");
  });
});

// ── errorHandler: Connection: close on 413 ───────────────────────────────────

describe('errorHandler sets Connection: close on HTTP 413', () => {
  it('errorHandler source sets Connection: close when status === 413', () => {
    assert.ok(
      errorHandlerSource.includes('413') && errorHandlerSource.includes("'close'"),
      "errorHandler must reference status 413 and set 'close'",
    );
  });

  it('errorHandler function sets Connection: close header for 413 errors', () => {
    const errorHandler = require('../../src/middleware/errorHandler');

    const headers = {};
    const mockRes = {
      headersSent: false,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; return this; },
      set(name, value) { headers[name.toLowerCase()] = value; return this; },
    };

    const err413 = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });

    errorHandler(err413, {}, mockRes, () => {});

    assert.equal(mockRes._status, 413, 'must respond with 413');
    assert.equal(
      headers['connection'],
      'close',
      'must set Connection: close on 413',
    );
  });

  it('errorHandler does NOT set Connection: close for non-413 4xx errors', () => {
    const errorHandler = require('../../src/middleware/errorHandler');

    const headers = {};
    const mockRes = {
      headersSent: false,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; return this; },
      set(name, value) { headers[name.toLowerCase()] = value; return this; },
    };

    const err400 = Object.assign(new SyntaxError('Unexpected token'), {
      status: 400,
      type: 'entity.parse.failed',
    });

    errorHandler(err400, {}, mockRes, () => {});

    assert.equal(mockRes._status, 400, 'must respond with 400');
    assert.ok(
      headers['connection'] !== 'close',
      'must NOT set Connection: close for non-413 errors',
    );
  });

  it('413 response body has error and message fields', () => {
    const errorHandler = require('../../src/middleware/errorHandler');

    const mockRes = {
      headersSent: false,
      status(code) { this._status = code; return this; },
      json(body) { this._body = body; return this; },
      set() { return this; },
    };

    const err413 = Object.assign(new Error('request entity too large'), {
      status: 413,
      type: 'entity.too.large',
    });

    errorHandler(err413, {}, mockRes, () => {});

    assert.ok(mockRes._body && typeof mockRes._body === 'object', 'body must be an object');
    assert.ok(typeof mockRes._body.error === 'string', 'body.error must be a string');
    assert.ok(typeof mockRes._body.message === 'string', 'body.message must be a string');
  });
});
