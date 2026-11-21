#!/usr/bin/env node
'use strict';

const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

const DEFAULT_WRITES = 1_000;
const DEFAULT_WORKERS = Math.min(8, os.availableParallelism());
const BUSY_TIMEOUT_MS = 5_000;

function parsePositiveInteger(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function parseArgs(args) {
  const options = { writes: DEFAULT_WRITES, workers: DEFAULT_WORKERS };
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(`Missing value for ${option}`);
    if (option === '--writes') options.writes = parsePositiveInteger(value, '--writes');
    else if (option === '--workers') options.workers = parsePositiveInteger(value, '--workers');
    else throw new Error(`Unknown option: ${option}`);
  }
  options.workers = Math.min(options.workers, options.writes);
  return options;
}

function runWorker({ dbPath, start, end }) {
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { timeout: BUSY_TIMEOUT_MS });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);

  const toOrdering = db.prepare(
    `UPDATE orders SET status = 'ordering', updated_at = datetime('now')
     WHERE id = ? AND status = 'pending_payment'`,
  );
  const toDelivered = db.prepare(
    `UPDATE orders SET status = 'delivered', updated_at = datetime('now')
     WHERE id = ? AND status = 'ordering'`,
  );
  const transitionOrder = db.transaction((id) => {
    if (toOrdering.run(id).changes !== 1 || toDelivered.run(id).changes !== 1) {
      throw new Error(`Order ${id} did not complete both state transitions`);
    }
  });

  let completed = 0;
  let busyErrors = 0;
  const errors = [];
  for (let orderNumber = start; orderNumber < end; orderNumber++) {
    try {
      transitionOrder(`bench-${orderNumber}`);
      completed++;
    } catch (error) {
      if (error.code === 'SQLITE_BUSY' || error.code?.startsWith('SQLITE_BUSY_')) busyErrors++;
      errors.push({ orderNumber, code: error.code || 'ERROR', message: error.message });
    }
  }

  db.close();
  return { completed, busyErrors, errors };
}

if (!isMainThread) {
  parentPort.postMessage(runWorker(workerData));
} else {
  function runWorkerThread(data) {
    return new Promise((resolve, reject) => {
      const worker = new Worker(__filename, { workerData: data });
      worker.once('message', resolve);
      worker.once('error', reject);
      worker.once('exit', (code) => {
        if (code !== 0) reject(new Error(`Benchmark worker exited with code ${code}`));
      });
    });
  }

  async function runBenchmark({ writes = DEFAULT_WRITES, workers = DEFAULT_WORKERS } = {}) {
    writes = parsePositiveInteger(writes, 'writes');
    workers = Math.min(parsePositiveInteger(workers, 'workers'), writes);
    const tempDir = mkdtempSync(path.join(os.tmpdir(), 'stellar-card-db-bench-'));
    const dbPath = path.join(tempDir, 'benchmark.sqlite');
    const originalDbPath = process.env.DB_PATH;
    let db;

    try {
      process.env.DB_PATH = dbPath;
      db = require('../src/db');
      const journalMode = db.pragma('journal_mode', { simple: true });
      if (String(journalMode).toLowerCase() !== 'wal') {
        throw new Error(`Expected SQLite WAL mode, got ${journalMode}`);
      }
      db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
      const insert = db.prepare(
        `INSERT INTO orders (id, status, amount_usdc) VALUES (?, 'pending_payment', '1.00')`,
      );
      db.transaction(() => {
        for (let orderNumber = 0; orderNumber < writes; orderNumber++) {
          insert.run(`bench-${orderNumber}`);
        }
      })();
      db.close();
      db = null;

      const versionDb = new (require('better-sqlite3'))(dbPath, { readonly: true });
      const sqliteVersion = versionDb.prepare('SELECT sqlite_version() AS version').get().version;
      versionDb.close();

      const startTime = performance.now();
      const results = await Promise.all(
        Array.from({ length: workers }, (_, workerNumber) =>
          runWorkerThread({
            dbPath,
            start: Math.floor((writes * workerNumber) / workers),
            end: Math.floor((writes * (workerNumber + 1)) / workers),
          }),
        ),
      );
      const elapsedMs = performance.now() - startTime;
      const completed = results.reduce((total, result) => total + result.completed, 0);
      const errors = results.flatMap((result) => result.errors);
      const busyErrors = results.reduce((total, result) => total + result.busyErrors, 0);
      const errorRate = ((writes - completed) / writes) * 100;
      const transactionsPerSecond = completed / (elapsedMs / 1_000);

      const verifyDb = new (require('better-sqlite3'))(dbPath, { readonly: true });
      const delivered = verifyDb.prepare(`SELECT COUNT(*) AS count FROM orders WHERE status = 'delivered'`).get().count;
      verifyDb.close();

      console.log('\nSQLite WAL order-write benchmark');
      console.log('--------------------------------');
      console.log(`Orders requested:       ${writes.toLocaleString()}`);
      console.log(`Workers:                ${workers}`);
      console.log(`Node.js:                ${process.version}`);
      console.log(`SQLite:                 ${sqliteVersion}`);
      console.log(`Completed transitions:  ${completed.toLocaleString()}`);
      console.log(`Verified delivered:     ${delivered.toLocaleString()}`);
      console.log(`Execution time:         ${elapsedMs.toFixed(2)} ms`);
      console.log(`Throughput (TPS):       ${transactionsPerSecond.toFixed(2)} transactions/sec`);
      console.log(`Error rate:             ${errorRate.toFixed(2)}% (${errors.length} errors)`);
      console.log(`SQLITE_BUSY errors:     ${busyErrors}`);
      console.log(`Journal mode:           ${journalMode}`);

      if (busyErrors > 0) throw new Error(`Expected zero SQLITE_BUSY errors, got ${busyErrors}`);
      if (errors.length > 0 || completed !== writes || delivered !== writes) {
        throw new Error(`Benchmark incomplete: ${errors.length} errors, ${delivered}/${writes} rows delivered`);
      }
      return { writes, workers, completed, delivered, elapsedMs, transactionsPerSecond, errorRate, busyErrors };
    } finally {
      if (db?.open) db.close();
      if (originalDbPath === undefined) delete process.env.DB_PATH;
      else process.env.DB_PATH = originalDbPath;
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  if (require.main === module) {
    try {
      runBenchmark(parseArgs(process.argv.slice(2))).catch((error) => {
        console.error(`Database benchmark failed: ${error.message}`);
        process.exitCode = 1;
      });
    } catch (error) {
      console.error(`Database benchmark failed: ${error.message}`);
      process.exitCode = 1;
    }
  }
}