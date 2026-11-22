// @ts-check
// Bounded wait for an order to reach a terminal state.
//
// MPP wants a single HTTP roundtrip where possible — the client has paid,
// the server verifies, and the card comes back in the 200. Card
// fulfillment (CTX invoice + payment + scrape + VCC callback) typically
// completes in ~5-30s after handlePayment dispatches, but we can't block
// indefinitely without triggering reverse-proxy timeouts. If the order
// is ready inside the bounded window we return it; otherwise the caller
// hands off to a 202 + Location response pointing at the receipt URL.

const db = require('../db');
const { subscribe } = require('../lib/event-bus');

const POLL_INTERVAL_MS = 250;

// SSE stream (#969). Agents hold one connection open instead of polling.
const STREAM_TIMEOUT_MS = parseInt(process.env.MPP_STREAM_TIMEOUT_MS || '120000', 10);
const HEARTBEAT_MS = 15_000;
// Bus events fired when an order reaches a terminal fulfilment state. The
// stream only wakes on these, so it never polls the database.
const TERMINAL_EVENTS = new Set(['order.fulfilled', 'order.failed']);

/**
 * Wait up to `timeoutMs` for order `orderId` to reach a terminal state.
 * Poll-based so the pattern is identical to /v1/orders/:id/stream and
 * requires no new infrastructure. The polling interval is short (250ms)
 * because this is the happy path for latency-sensitive clients.
 *
 * Returns:
 *   { state: 'delivered', order } — card details are populated on the row
 *   { state: 'failed', order }    — fulfillment failed; caller returns 4xx/5xx
 *   { state: 'timeout', order }   — still fulfilling; caller returns 202
 *
 * @param {{ orderId: string, timeoutMs: number }} opts
 */
async function waitForDelivery({ orderId, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  // Check once immediately — the happy path where the order is already
  // delivered by the time we start polling (e.g. watcher + MPP race).
  let order = loadOrder(orderId);
  if (order && isTerminal(order)) {
    return { state: classify(order), order };
  }
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    order = loadOrder(orderId);
    if (order && isTerminal(order)) {
      return { state: classify(order), order };
    }
  }
  return { state: 'timeout', order: order ?? null };
}

function loadOrder(orderId) {
  return /** @type {any} */ (db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId));
}

function isTerminal(order) {
  return order.status === 'delivered' || order.status === 'failed';
}

function classify(order) {
  return order.status === 'delivered' ? 'delivered' : 'failed';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Stream an order's delivery outcome over Server-Sent Events.
 *
 * Event-driven: subscribes to the in-process bus and reads the order row only
 * when a terminal fulfilment event for this order arrives. The subscription is
 * taken before the initial read, so a terminal event that lands in between is
 * not missed. A heartbeat comment keeps proxies from closing idle connections.
 *
 * Emits one `event: delivery` with `{ state, ... }` where state is 'delivered'
 * or 'failed' (body from `toEvent`), or `event: timeout` if the order is still
 * in flight after STREAM_TIMEOUT_MS. Then it ends the response. The agent can
 * reconnect or fall back to GET /v1/mpp/receipts/:id.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ orderId: string, toEvent: (row: any) => object, timeoutMs?: number }} opts
 */
function streamDelivery(req, res, { orderId, toEvent, timeoutMs = STREAM_TIMEOUT_MS }) {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders?.();
  res.write(': connected\n\n');

  let done = false;
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {NodeJS.Timeout | null} */
  let heartbeat = null;
  /** @type {NodeJS.Timeout | null} */
  let deadline = null;

  function cleanup() {
    if (heartbeat) clearInterval(heartbeat);
    if (deadline) clearTimeout(deadline);
    if (unsubscribe) unsubscribe();
  }

  function end(eventName, data) {
    if (done) return;
    done = true;
    cleanup();
    try {
      res.write(`event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
      res.end();
    } catch {
      /* socket already gone */
    }
  }

  // Returns true if the order is terminal and the stream has ended.
  function tryFinish() {
    const row = loadOrder(orderId);
    if (!row || !isTerminal(row)) return false;
    end('delivery', toEvent(row));
    return true;
  }

  unsubscribe = subscribe((evt) => {
    if (done) return;
    const e = /** @type {any} */ (evt);
    if (e.type !== 'biz' || !TERMINAL_EVENTS.has(e.name)) return;
    if (e.fields?.order_id !== orderId) return;
    tryFinish();
  });

  req.on('close', () => {
    done = true;
    cleanup();
  });

  if (tryFinish()) return;

  heartbeat = setInterval(() => {
    if (!done) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  deadline = setTimeout(
    () => end('timeout', { state: 'fulfilling', order_id: orderId }),
    timeoutMs,
  );
}

module.exports = { waitForDelivery, streamDelivery };
