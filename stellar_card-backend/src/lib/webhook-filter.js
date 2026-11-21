// @ts-check
// Webhook event subscription filter.
//
// Each api_key row may store a JSON array of event-type strings in the
// `webhook_event_filter` column. When present and non-empty, only events
// whose `type` field (or `status` field, which doubles as event type in
// legacy payloads) appears in the list are dispatched to the agent's
// webhook URL. The special wildcard '*' (or an empty / null filter) means
// "all events" — the original behaviour before this feature was added.
//
// Valid event types that agents may subscribe to:
//   order.delivered  order.failed  order.expired  order.pending_recovery
//   order.refunded   order.refund_pending
//
// Callers derive the event type from the outbound payload using
// `resolveEventType(payload)`, which checks the `event_type` field first
// and falls back to mapping the `status` field for backwards-compatible
// payloads that pre-date this feature.

/** Wildcard: subscribe to every event type. */
const ALL_EVENTS = '*';

/**
 * Canonical set of recognised event types. Used for validation when an
 * agent updates their filter via the dashboard API.
 */
const KNOWN_EVENT_TYPES = new Set([
  'order.delivered',
  'order.failed',
  'order.expired',
  'order.pending_recovery',
  'order.refunded',
  'order.refund_pending',
]);

/**
 * Map of `status` field values (used in legacy payloads) to their canonical
 * event-type strings.
 * @type {Record<string, string>}
 */
const STATUS_TO_EVENT_TYPE = {
  delivered: 'order.delivered',
  failed: 'order.failed',
  expired: 'order.expired',
  pending_recovery: 'order.pending_recovery',
  refunded: 'order.refunded',
  refund_pending: 'order.refund_pending',
};

/**
 * Derive a canonical event type string from a webhook payload.
 *
 * @param {Record<string, unknown>} payload
 * @returns {string | undefined}
 */
function resolveEventType(payload) {
  if (typeof payload.event_type === 'string' && payload.event_type) {
    return payload.event_type;
  }
  if (typeof payload.status === 'string' && payload.status) {
    return STATUS_TO_EVENT_TYPE[payload.status] ?? `order.${payload.status}`;
  }
  return undefined;
}

/**
 * Parse a raw `webhook_event_filter` value from the database.
 *
 * Returns `null` (wildcard — all events) when the stored value is absent,
 * the wildcard string, or an empty array.
 *
 * @param {unknown} raw — the value from `api_keys.webhook_event_filter`
 * @returns {string[] | null} null = all events; string[] = explicit allowlist
 */
function parseFilter(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let arr;
  if (typeof raw === 'string') {
    if (raw === ALL_EVENTS) return null;
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    arr = raw;
  }
  if (!Array.isArray(arr) || arr.length === 0) return null;
  if (arr.includes(ALL_EVENTS)) return null;
  return arr.filter((x) => typeof x === 'string');
}

/**
 * Returns true when the event described by `payload` should be dispatched
 * to the webhook subscriber.
 *
 * A null/wildcard filter always passes. An explicit list passes only when the
 * payload's resolved event type appears in the list.
 *
 * @param {Record<string, unknown>} payload
 * @param {string[] | null} filter — parsed filter (null = all events)
 * @returns {boolean}
 */
function shouldDispatch(payload, filter) {
  if (filter === null) return true; // wildcard
  const eventType = resolveEventType(payload);
  if (!eventType) return true; // unknown type — pass through so we don't swallow events
  return filter.includes(eventType);
}

/**
 * Validate an array of event-type strings supplied by an agent via the
 * dashboard API. Returns an error string on failure, undefined on success.
 *
 * @param {unknown} value
 * @returns {string | undefined}
 */
function validateEventFilter(value) {
  if (value === null || value === undefined) return undefined; // clear the filter
  if (value === ALL_EVENTS) return undefined;
  if (!Array.isArray(value)) return 'webhook_event_filter must be an array of strings or "*"';
  for (const item of value) {
    if (typeof item !== 'string') return 'each webhook_event_filter entry must be a string';
    if (item !== ALL_EVENTS && !KNOWN_EVENT_TYPES.has(item)) {
      return `unknown event type "${item}"; valid types: ${[...KNOWN_EVENT_TYPES].join(', ')}`;
    }
  }
  return undefined;
}

module.exports = {
  ALL_EVENTS,
  KNOWN_EVENT_TYPES,
  resolveEventType,
  parseFilter,
  shouldDispatch,
  validateEventFilter,
};
