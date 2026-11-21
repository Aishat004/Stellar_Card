// @ts-check
// Webhook delivery log. Every outbound webhook firing (success or
// failure) gets persisted with request body, response code, latency,
// and signing info. Operators can replay or debug webhook problems
// from the dashboard without shelling into the server.
//
// Context discovery: fireWebhook() doesn't know which dashboard the
// payload belongs to, but nearly every webhook payload carries an
// `order_id`. We look up the owning dashboard via orders → api_keys →
// dashboards. If no order_id is present (e.g. a test webhook), the
// caller passes context explicitly.

/** @type {any} */
const db = require('../db');

// Defense-in-depth size caps on caller-supplied strings. Callers are
// expected to pre-truncate (fireWebhook already caps response body at
// 2000 chars), but enforcing the cap at the write boundary means any
// future caller that forgets doesn't flood the webhook_deliveries
// table. Same pattern as the audit.js truncation from the earlier
// audit cycle. Adversarial audit F2-webhook-log.
const MAX_URL_CHARS = 2048;
const MAX_RESPONSE_BODY_CHARS = 4096;
const MAX_ERROR_CHARS = 1024;
const MAX_SIGNATURE_CHARS = 256;

function clip(value, max) {
  if (value === null || value === undefined) return null;
  const s = typeof value === 'string' ? value : String(value);
  return s.length > max ? s.slice(0, max) : s;
}

const lookupByOrder = db.prepare(`
  SELECT o.api_key_id AS api_key_id, k.dashboard_id AS dashboard_id
  FROM orders o
  LEFT JOIN api_keys k ON o.api_key_id = k.id
  WHERE o.id = ?
`);

const insertStmt = db.prepare(`
  INSERT INTO webhook_deliveries (
    dashboard_id, api_key_id, url, method, request_body,
    response_status, response_body, latency_ms, error, signature
  ) VALUES (
    @dashboard_id, @api_key_id, @url, @method, @request_body,
    @response_status, @response_body, @latency_ms, @error, @signature
  )
`);

/**
 * @param {string | null | undefined} orderId
 * @returns {{ dashboardId: string | null; apiKeyId: string | null }}
 */
function deriveContextFromOrder(orderId) {
  if (!orderId) return { dashboardId: null, apiKeyId: null };
  const row = /** @type {any} */ (lookupByOrder.get(orderId));
  if (!row) return { dashboardId: null, apiKeyId: null };
  return { dashboardId: row.dashboard_id ?? null, apiKeyId: row.api_key_id ?? null };
}

/**
 * @typedef {Object} RecordInput
 * @property {string} url
 * @property {string} [method]
 * @property {unknown} requestBody
 * @property {number} [responseStatus]
 * @property {string} [responseBody]
 * @property {number} [latencyMs]
 * @property {string} [error]
 * @property {string} [signature]
 * @property {string | null} [dashboardId]
 * @property {string | null} [apiKeyId]
 */

/**
 * @param {RecordInput} input
 */
function recordWebhookDelivery(input) {
  try {
    let { dashboardId, apiKeyId } = input;
    if (!dashboardId && input.requestBody && typeof input.requestBody === 'object') {
      const orderId = /** @type {any} */ (input.requestBody).order_id;
      const derived = deriveContextFromOrder(orderId);
      dashboardId = derived.dashboardId;
      apiKeyId = apiKeyId ?? derived.apiKeyId;
    }
    if (!dashboardId) return; // unattributed deliveries don't get logged
    insertStmt.run({
      dashboard_id: dashboardId,
      api_key_id: apiKeyId ?? null,
      url: clip(input.url, MAX_URL_CHARS),
      method: input.method ?? 'POST',
      request_body: safeStringify(input.requestBody),
      response_status: input.responseStatus ?? null,
      response_body: clip(input.responseBody, MAX_RESPONSE_BODY_CHARS),
      latency_ms: input.latencyMs ?? null,
      error: clip(input.error, MAX_ERROR_CHARS),
      signature: clip(input.signature, MAX_SIGNATURE_CHARS),
    });
  } catch (err) {
    console.error(
      `[webhook-log] failed to persist delivery: ${/** @type {Error} */ (err).message}`,
    );
  }
}

function safeStringify(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 8000);
  try {
    return JSON.stringify(value).slice(0, 8000);
  } catch {
    return String(value).slice(0, 8000);
  }
}

/**
 * @param {string} dashboardId
 * @param {{ limit?: number; apiKeyId?: string }} [opts]
 */
function listDeliveries(dashboardId, opts = {}) {
  const limit = Math.min(Math.max(1, opts.limit ?? 50), 200);
  const conditions = ['dashboard_id = @dashboard_id'];
  /** @type {Record<string, unknown>} */
  const params = { dashboard_id: dashboardId, limit };
  if (opts.apiKeyId) {
    conditions.push('api_key_id = @api_key_id');
    params.api_key_id = opts.apiKeyId;
  }
  return /** @type {any[]} */ (
    db
      .prepare(
        `SELECT id, dashboard_id, api_key_id, url, method, request_body,
                response_status, response_body, latency_ms, error, signature, created_at
         FROM webhook_deliveries
         WHERE ${conditions.join(' AND ')}
         ORDER BY id DESC LIMIT @limit`,
      )
      .all(params)
  ).map((r) => ({
    ...r,
    request_body: r.request_body ? safeParse(r.request_body) : null,
    response_body: r.response_body,
  }));
}

function safeParse(s) {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

/**
 * Returns the webhook delivery success rate over the past `windowMs`
 * milliseconds as a value in [0, 1], or `null` when there are no
 * deliveries in the window (avoids a misleading 0).
 *
 * A delivery is considered successful when `response_status` is in the
 * 2xx range; any row with a non-2xx status or a NULL status (transport
 * failure / no response received) counts as a failure.
 *
 * @param {{ windowMs?: number }} [opts]
 * @returns {number | null}
 */
function deliverySuccessRate24h(opts = {}) {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - windowMs).toISOString();
  const row = /** @type {any} */ (
    db
      .prepare(
        `SELECT
           COUNT(*) AS total,
           SUM(CASE WHEN response_status >= 200 AND response_status < 300 THEN 1 ELSE 0 END) AS successes
         FROM webhook_deliveries
         WHERE created_at >= ?`,
      )
      .get(since)
  );
  if (!row || row.total === 0) return null;
  return row.successes / row.total;
}

/**
 * Returns p50 / p95 / p99 latency statistics (in ms) for webhook deliveries
 * over the past `windowMs` milliseconds. Rows with NULL `latency_ms` are
 * excluded from percentile calculations.
 *
 * Returns `null` for a percentile when there are no measurable deliveries.
 *
 * @param {{ windowMs?: number }} [opts]
 * @returns {{ p50: number | null; p95: number | null; p99: number | null; count: number }}
 */
function deliveryLatencyStats24h(opts = {}) {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000;
  const since = new Date(Date.now() - windowMs).toISOString();
  const rows = /** @type {{ latency_ms: number }[]} */ (
    db
      .prepare(
        `SELECT latency_ms
         FROM webhook_deliveries
         WHERE created_at >= ? AND latency_ms IS NOT NULL
         ORDER BY latency_ms ASC`,
      )
      .all(since)
  );
  if (rows.length === 0) return { p50: null, p95: null, p99: null, count: 0 };
  const values = rows.map((r) => r.latency_ms);
  return {
    p50: percentile(values, 50),
    p95: percentile(values, 95),
    p99: percentile(values, 99),
    count: values.length,
  };
}

/**
 * Nearest-rank percentile on a pre-sorted array.
 * @param {number[]} sorted - ascending-sorted numeric array (non-empty)
 * @param {number} pct - percentile in [0, 100]
 * @returns {number}
 */
function percentile(sorted, pct) {
  const idx = Math.ceil((pct / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(idx, sorted.length - 1))];
}

module.exports = {
  recordWebhookDelivery,
  listDeliveries,
  deliverySuccessRate24h,
  deliveryLatencyStats24h,
  /** @internal — exported for unit tests only */
  _percentile: percentile,
};
