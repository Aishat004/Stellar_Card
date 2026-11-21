// Unit tests for the automated database backup job (#993).
// Verifies backup creation, Gzip compression, timestamped naming,
// and pruning of archives older than 14 days.
//
// Uses a real in-memory SQLite DB (via test helpers) and a tmp
// directory so no files leak between runs.

require('../helpers/env');

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Point BACKUP_DIR at a fresh temp dir before the jobs module loads.
const TEST_BACKUP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-backup-test-'));
process.env.BACKUP_DIR = TEST_BACKUP_DIR;

const { backupDatabase, pruneOldBackups, runDatabaseBackup } = require('../../src/jobs');

// ── Helpers ───────────────────────────────────────────────────────────────────

function listBackups() {
  return fs
    .readdirSync(TEST_BACKUP_DIR)
    .filter((f) => f.startsWith('db-backup-') && f.endsWith('.sqlite.gz'))
    .map((f) => path.join(TEST_BACKUP_DIR, f));
}

function clearBackups() {
  for (const f of fs.readdirSync(TEST_BACKUP_DIR)) {
    fs.unlinkSync(path.join(TEST_BACKUP_DIR, f));
  }
}

function touchOldBackup(daysAgo) {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  const p = path.join(TEST_BACKUP_DIR, `db-backup-${date}.sqlite.gz`);
  fs.writeFileSync(p, 'fake');
  // back-date mtime
  const ts = (Date.now() - daysAgo * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(p, ts, ts);
  return p;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('backupDatabase', () => {
  beforeEach(() => clearBackups());

  it('creates a .sqlite.gz archive in BACKUP_DIR', async () => {
    const archive = await backupDatabase();
    assert.ok(fs.existsSync(archive), 'archive file must exist');
    assert.ok(archive.endsWith('.sqlite.gz'), 'archive must have .sqlite.gz extension');
  });

  it('names the archive with today\'s date (YYYY-MM-DD)', async () => {
    const archive = await backupDatabase();
    const today = new Date().toISOString().slice(0, 10);
    assert.ok(
      path.basename(archive).includes(today),
      `expected date ${today} in filename, got ${path.basename(archive)}`,
    );
  });

  it('writes a valid Gzip file (magic bytes 1f 8b)', async () => {
    const archive = await backupDatabase();
    const buf = Buffer.alloc(2);
    const fd = fs.openSync(archive, 'r');
    fs.readSync(fd, buf, 0, 2, 0);
    fs.closeSync(fd);
    assert.equal(buf[0], 0x1f, 'first byte must be 0x1f (gzip magic)');
    assert.equal(buf[1], 0x8b, 'second byte must be 0x8b (gzip magic)');
  });

  it('does not leave a .tmp file behind', async () => {
    await backupDatabase();
    const tmps = fs.readdirSync(TEST_BACKUP_DIR).filter((f) => f.endsWith('.tmp'));
    assert.equal(tmps.length, 0, 'no .tmp files should remain after backup');
  });
});

describe('pruneOldBackups', () => {
  beforeEach(() => clearBackups());

  it('removes archives older than 14 days', () => {
    const old = touchOldBackup(15);
    pruneOldBackups();
    assert.ok(!fs.existsSync(old), 'archive older than 14 days must be removed');
  });

  it('keeps archives 14 days old or newer', () => {
    const recent = touchOldBackup(14);
    // Exactly 14 days — mtime is 14 * 86400s ago, which equals the cutoff.
    // The implementation uses strict < so this should be kept.
    pruneOldBackups();
    assert.ok(fs.existsSync(recent), 'archive at exactly 14 days must be kept');
  });

  it('returns the list of pruned paths', () => {
    const a = touchOldBackup(20);
    const b = touchOldBackup(16);
    const pruned = pruneOldBackups();
    assert.ok(pruned.includes(a), 'pruned list must include 20-day-old archive');
    assert.ok(pruned.includes(b), 'pruned list must include 16-day-old archive');
  });

  it('does not remove files that are not backup archives', () => {
    const unrelated = path.join(TEST_BACKUP_DIR, 'notes.txt');
    fs.writeFileSync(unrelated, 'keep me');
    pruneOldBackups();
    assert.ok(fs.existsSync(unrelated), 'non-backup files must not be removed');
  });
});

describe('runDatabaseBackup', () => {
  beforeEach(() => clearBackups());

  it('creates a backup and resolves without throwing', async () => {
    await assert.doesNotReject(() => runDatabaseBackup());
    assert.equal(listBackups().length, 1, 'exactly one archive expected');
  });

  it('prunes stale archives during the same run', async () => {
    touchOldBackup(20);
    await runDatabaseBackup();
    // The 20-day-old fake must be gone; today's real backup must exist.
    const remaining = listBackups();
    assert.equal(remaining.length, 1, 'only today\'s backup should remain');
    assert.ok(
      path.basename(remaining[0]).includes(new Date().toISOString().slice(0, 10)),
      'remaining archive must be dated today',
    );
  });
});

after(() => {
  try { fs.rmSync(TEST_BACKUP_DIR, { recursive: true, force: true }); } catch { /* cleanup best-effort */ }
});
