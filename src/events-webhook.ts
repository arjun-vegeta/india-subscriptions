/**
 * The events webhook of `india-subscriptions serve`: signing, delivery and verification.
 *
 * ## What is sent
 *
 * `POST EVENTS_WEBHOOK_URL`, `content-type: application/json`, body = an `EventsDelivery`
 * (`src/events-envelope.ts`): `{"kind":"gateway","provider":...,"events":[...]}` for gateway webhooks, or
 * `{"kind":"scheduler","events":[...]}` for billing scheduler events. Every event carries an `id`.
 *
 * ## How it is signed (implement this in any language)
 *
 * Two headers accompany every delivery:
 *
 * ```
 * x-india-subscriptions-timestamp: <unix time in whole seconds, decimal, e.g. 1767225600>
 * x-india-subscriptions-signature: <lower-case hex>
 * ```
 *
 * The signature is HMAC-SHA256, keyed with `EVENTS_WEBHOOK_SECRET` (UTF-8 bytes), over this exact string:
 *
 * ```
 * <timestamp> "." <raw request body>
 * ```
 *
 * that is the decimal timestamp exactly as it appears in the header, one full stop (U+002E), then the body bytes
 * exactly as received (UTF-8, before any JSON parsing). For example, timestamp `1767225600` and body
 * `{"kind":"scheduler","events":[]}` sign the text `1767225600.{"kind":"scheduler","events":[]}`.
 *
 * A receiver must (1) reject a missing or non-numeric timestamp, (2) recompute the signature and compare it in
 * constant time, (3) reject a timestamp more than 300 seconds from its own clock, in either direction. Answer 2xx
 * once the events are safely stored; anything else (or no answer within 10 seconds) is a failed delivery.
 * `verifyEventsSignature` does all three.
 *
 * ## Delivery guarantees
 *
 * - Gateway events: a failed delivery makes the gateway's webhook answer 500, so the gateway retries.
 * - Scheduler events: delivered in the background, in order, after the change is stored, so a failing
 *   receiver never affects billing. A failed batch is retried with exponential backoff a bounded number of times,
 *   then logged as an error with each event's id and type and dropped. The queue lives in memory: events not yet
 *   delivered when the process dies are lost, and the schedules themselves (the source of truth) stay available over
 *   the API. Either way delivery is at least once: de-duplicate on `id`.
 */
import { ContentType, ErrorCode, HeaderName, HttpMethod, type Provider } from './constants.js';
import { getHeader, safeEqual, sha256Hmac } from './crypto.js';
import { SubscriptionError } from './errors.js';
import {
  EventsDeliveryKind,
  toSchedulerWebhookEvent,
  type EventsDelivery,
  type SchedulerWebhookEvent,
} from './events-envelope.js';
import type { FetchLike } from './http.js';
import type { SubscriptionEvent } from './schemas.js';
import type { SchedulerEvent } from './scheduler/schemas.js';

/** Headers on every delivery to the events webhook. */
export const EventsHeader = {
  /** Lower-case hex HMAC-SHA256, keyed with the shared secret, of `<timestamp>.<exact request body>`. */
  Signature: 'x-india-subscriptions-signature',
  /** Unix time in whole seconds at which the delivery was signed. Covered by the signature. */
  Timestamp: 'x-india-subscriptions-timestamp',
} as const;
export type EventsHeader = (typeof EventsHeader)[keyof typeof EventsHeader];

/** Between the timestamp and the body in the signed string. */
export const SIGNED_STRING_SEPARATOR = '.';
/** How far a delivery's timestamp may be from the receiver's clock, in either direction. */
export const DEFAULT_TOLERANCE_SECONDS = 300;
/** How long one delivery may take before it counts as failed. */
export const DEFAULT_EVENTS_TIMEOUT_MS = 10_000;
/** Attempts per scheduler batch (the first and the retries) before it is given up on. */
export const DEFAULT_RELAY_MAX_ATTEMPTS = 5;
/** Wait before the first retry; it doubles each time. */
export const DEFAULT_RELAY_INITIAL_DELAY_MS = 1_000;
export const DEFAULT_RELAY_MAX_DELAY_MS = 30_000;
/** Scheduler events sent in one POST. */
export const DEFAULT_RELAY_BATCH_SIZE = 20;
/** Events waiting for delivery; beyond this the oldest are dropped (and logged). */
export const DEFAULT_RELAY_MAX_QUEUE = 1_000;
/** Each wait is randomised by up to this fraction either way, so retries do not synchronise. */
const RETRY_JITTER = 0.2;

const MILLIS_PER_SECOND = 1000;
const SUCCESS_STATUS_MIN = 200;
const SUCCESS_STATUS_MAX = 299;
const TIMESTAMP_PATTERN = /^\d{1,15}$/;
/** A redirect is not followed: a 3xx counts as a failed delivery. */
const NO_REDIRECT = 'manual';
/** `name` of the error `AbortSignal.timeout` rejects with. */
const TIMEOUT_ERROR_NAME = 'TimeoutError';

export type { EventsDelivery, SchedulerWebhookEvent };

/** The signature of a delivery: hex HMAC-SHA256 over `<timestamp>.<rawBody>`. */
export function signEventsBody(secret: string, timestamp: string | number, rawBody: string): string {
  return sha256Hmac(secret, `${timestamp}${SIGNED_STRING_SEPARATOR}${rawBody}`);
}

export interface VerifyEventsOptions {
  /** Largest accepted distance between the delivery's timestamp and now, in seconds. Default 300. */
  toleranceSeconds?: number;
  /** Clock, in epoch milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

export type EventsHeaders = Headers | Record<string, string | string[] | undefined>;

function readHeader(headers: EventsHeaders, name: string): string | undefined {
  return headers instanceof Headers ? (headers.get(name) ?? undefined) : getHeader(headers, name);
}

function invalid(message: string): SubscriptionError {
  return new SubscriptionError(ErrorCode.SignatureInvalid, `Events webhook ${message}`);
}

/**
 * Checks a delivery you received: the timestamp header is present, numeric and within `toleranceSeconds` of now
 * (past or future), and the signature header matches `<timestamp>.<rawBody>` (constant-time compare). Pass the
 * body exactly as received, not re-serialised. Throws `SIGNATURE_INVALID` otherwise; returns when valid.
 */
export function verifyEventsSignature(
  secret: string,
  rawBody: string,
  headers: EventsHeaders,
  options: VerifyEventsOptions = {},
): void {
  const timestamp = readHeader(headers, EventsHeader.Timestamp)?.trim();
  const signature = readHeader(headers, EventsHeader.Signature)?.trim().toLowerCase();
  if (!timestamp) throw invalid('timestamp header is missing');
  if (!TIMESTAMP_PATTERN.test(timestamp)) throw invalid('timestamp header is not a Unix time in seconds');
  if (!signature) throw invalid('signature header is missing');
  if (!safeEqual(signEventsBody(secret, timestamp, rawBody), signature)) throw invalid('signature does not match');

  const toleranceSeconds = options.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((options.now ?? Date.now)() / MILLIS_PER_SECOND);
  const age = nowSeconds - Number(timestamp);
  if (age > toleranceSeconds) throw invalid('timestamp is too old');
  if (-age > toleranceSeconds) throw invalid('timestamp is in the future');
}

/** Only the origin of a URL: a webhook URL often carries a token in its path or query. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '(invalid url)';
  }
}

export interface EventsSenderOptions {
  url: string;
  secret: string;
  /** Defaults to global `fetch`. */
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Clock for the timestamp header, in epoch milliseconds. */
  now?: () => number;
}

/**
 * Signs and POSTs one delivery. Throws when the endpoint cannot be reached, times out, redirects or does not
 * answer 2xx. The message names the status or failure, never the URL's path or query, and never the secret.
 */
export function createEventsSender(options: EventsSenderOptions): (delivery: EventsDelivery) => Promise<void> {
  const send: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVENTS_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const target = originOf(options.url);
  const provider = (delivery: EventsDelivery): Provider | undefined =>
    delivery.kind === EventsDeliveryKind.Gateway ? delivery.provider : undefined;

  return async (delivery) => {
    const body = JSON.stringify(delivery);
    const timestamp = String(Math.floor(now() / MILLIS_PER_SECOND));
    let response: Response;
    try {
      response = await send(options.url, {
        method: HttpMethod.Post,
        headers: {
          [HeaderName.ContentType]: ContentType.Json,
          [EventsHeader.Timestamp]: timestamp,
          [EventsHeader.Signature]: signEventsBody(options.secret, timestamp, body),
        },
        body,
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === TIMEOUT_ERROR_NAME;
      throw new SubscriptionError(
        timedOut ? ErrorCode.Timeout : ErrorCode.Network,
        `Events webhook at ${target} ${timedOut ? 'timed out' : 'could not be reached'}`,
        { provider: provider(delivery), cause },
      );
    }
    // Drain the body so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    if (response.status < SUCCESS_STATUS_MIN || response.status > SUCCESS_STATUS_MAX) {
      throw new SubscriptionError(
        ErrorCode.ProviderUnavailable,
        `Events webhook at ${target} answered HTTP ${response.status}`,
        { provider: provider(delivery), httpStatus: response.status },
      );
    }
  };
}

/**
 * The `onEvents` hook for the service's raw gateway webhook route: forwards each batch of verified, normalised
 * gateway events as a `gateway` delivery. It throws when delivery fails; the service then answers the gateway's
 * webhook with 500, so the gateway retries and no event is lost. An empty batch sends nothing.
 */
export function createEventsForwarder(
  options: EventsSenderOptions,
): (provider: Provider, events: SubscriptionEvent[]) => Promise<void> {
  const send = createEventsSender(options);
  return async (provider, events) => {
    if (events.length === 0) return;
    await send({ kind: EventsDeliveryKind.Gateway, provider, events });
  };
}

// ---------------------------------------------------------------------------
// Scheduler events: background relay
// ---------------------------------------------------------------------------

/** What the relay needs to report to; `Logger` satisfies it. */
export interface EventsLog {
  error(message: string): void;
}

export interface SchedulerEventsRelayOptions extends EventsSenderOptions {
  logger: EventsLog;
  maxAttempts?: number;
  initialDelayMs?: number;
  maxDelayMs?: number;
  batchSize?: number;
  maxQueue?: number;
  /** Random number in [0, 1) for the retry jitter. Defaults to `Math.random`. */
  random?: () => number;
  /** Waits `ms`, resolving early when `signal` aborts. Defaults to a timer. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

export interface SchedulerEventsRelay {
  /** Queues an event for delivery and returns at once. Never throws. */
  enqueue(event: SchedulerEvent): void;
  /** Events waiting or being delivered. */
  pending(): number;
  /** Resolves when everything queued so far has been delivered or given up on. */
  idle(): Promise<void>;
  /** Stops retrying, waits for the delivery in flight, and logs what was dropped. */
  close(): Promise<void>;
}

function timerSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

function describeFailure(error: unknown): string {
  return error instanceof SubscriptionError ? `${error.code}: ${error.message}` : 'unexpected failure';
}

/**
 * Delivers scheduler events to the events webhook in the background. `enqueue` is synchronous and cannot fail, so
 * it is safe to call from the scheduler's `onEvent` listener: billing never waits for, or is affected by, the
 * receiver. Events are sent in order, in batches, one batch at a time; a failed batch is retried with exponential
 * backoff (1 s, 2 s, 4 s, ... capped, with jitter) up to `maxAttempts` times, then every event in it is logged as
 * an error with its id and type, and dropped.
 */
export function createSchedulerEventsRelay(options: SchedulerEventsRelayOptions): SchedulerEventsRelay {
  const send = createEventsSender(options);
  const log = options.logger;
  const maxAttempts = Math.max(1, options.maxAttempts ?? DEFAULT_RELAY_MAX_ATTEMPTS);
  const initialDelayMs = options.initialDelayMs ?? DEFAULT_RELAY_INITIAL_DELAY_MS;
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RELAY_MAX_DELAY_MS;
  const batchSize = Math.max(1, options.batchSize ?? DEFAULT_RELAY_BATCH_SIZE);
  const maxQueue = Math.max(1, options.maxQueue ?? DEFAULT_RELAY_MAX_QUEUE);
  const random = options.random ?? Math.random;
  const sleep = options.sleep ?? timerSleep;
  const target = originOf(options.url);

  const queue: SchedulerWebhookEvent[] = [];
  const stopping = new AbortController();
  let inFlight = 0;
  let pump: Promise<void> | undefined;

  const describeEvents = (events: SchedulerWebhookEvent[]): string =>
    events.map((event) => `${event.id} (${event.type})`).join(', ');

  async function deliver(batch: SchedulerWebhookEvent[]): Promise<void> {
    let lastFailure: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        await send({ kind: EventsDeliveryKind.Scheduler, events: batch });
        return;
      } catch (error) {
        lastFailure = error;
      }
      if (attempt === maxAttempts || stopping.signal.aborted) break;
      const base = Math.min(maxDelayMs, initialDelayMs * 2 ** (attempt - 1));
      await sleep(Math.round(base * (1 - RETRY_JITTER + 2 * RETRY_JITTER * random())), stopping.signal);
      if (stopping.signal.aborted) break;
    }
    for (const event of batch) {
      log.error(
        `scheduler event ${event.id} (${event.type}) was not delivered to ${target}, and is dropped: ${describeFailure(lastFailure)}`,
      );
    }
  }

  async function run(): Promise<void> {
    while (queue.length > 0 && !stopping.signal.aborted) {
      const batch = queue.splice(0, batchSize);
      inFlight = batch.length;
      try {
        await deliver(batch);
      } finally {
        inFlight = 0;
      }
    }
  }

  function start(): void {
    pump ??= run().finally(() => {
      pump = undefined;
      if (queue.length > 0 && !stopping.signal.aborted) start();
    });
  }

  return {
    enqueue(event) {
      try {
        if (stopping.signal.aborted) {
          const dropped = toSchedulerWebhookEvent(event);
          log.error(`scheduler event ${dropped.id} (${dropped.type}) was not delivered: the service is shutting down`);
          return;
        }
        queue.push(toSchedulerWebhookEvent(event));
        while (queue.length > maxQueue) {
          const [dropped] = queue.splice(0, 1);
          if (dropped) log.error(`scheduler event ${dropped.id} (${dropped.type}) was dropped: ${maxQueue} events are already waiting for ${target}`);
        }
        start();
      } catch {
        log.error('a scheduler event could not be queued for the events webhook');
      }
    },
    pending: () => queue.length + inFlight,
    async idle() {
      while (pump) await pump;
    },
    async close() {
      stopping.abort();
      while (pump) await pump;
      if (queue.length > 0) {
        const dropped = queue.splice(0);
        log.error(`${dropped.length} scheduler events were not delivered before shutdown: ${describeEvents(dropped)}`);
      }
    },
  };
}
