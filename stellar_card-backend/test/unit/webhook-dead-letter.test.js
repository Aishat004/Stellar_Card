// Dead-letter read side for webhook delivery (issue #973).
require('../helpers/env');

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { v4: uuidv4 } = require('uuid');
const db = require('../../src/db');
const { listDeadLetters } = require('../../src/lib/webhook-log');

function insertQueueRow({ attempts, delivered = 0, url = 'https://example.com/hook' }) {
  const id = uuidv4();
  db.prepare(
    `INSERT INTO webhook_queue (id, url, payload, secret, attempts, next_attempt, last_error, delivered)
     VALUES (?, ?, '{}', NULL, ?, ?, 'boom', ?)`,
  ).run(id, url, attempts, new Date().toISOString(), delivered);
  return id;
}

describe('webhook-log: listDeadLetters', () => {
  beforeEach(() => {
    db.prepare(`DELETE FROM webhook_queue`).run();
  });

  it('returns only undelivered rows that exhausted the retry budget', () => {
    const dead = insertQueueRow({ attempts: 4 }); // default ceiling is 3
    insertQueueRow({ attempts: 1 }); // still retrying
    insertQueueRow({ attempts: 4, delivered: 1 }); // delivered after all

    const rows = listDeadLetters();
    assert.deepEqual(
      rows.map((r) => r.id),
      [dead],
    );
    assert.equal(rows[0].attempts, 4);
    assert.equal(rows[0].last_error, 'boom');
  });

  it('does not expose the redacted payload or secret', () => {
    insertQueueRow({ attempts: 4 });
    const [row] = listDeadLetters();
    assert.equal('payload' in row, false);
    assert.equal('secret' in row, false);
  });

  it('honours the limit', () => {
    for (let i = 0; i < 3; i++) insertQueueRow({ attempts: 4 });
    assert.equal(listDeadLetters({ limit: 2 }).length, 2);
    assert.equal(listDeadLetters({ limit: 0 }).length, 1); // clamped to >= 1
  });
});
