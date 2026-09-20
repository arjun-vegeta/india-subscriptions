import { ContentType, ErrorCode, HeaderName, HttpMethod, type Provider } from './constants.js';
import { safeEqual, sha256Hmac } from './crypto.js';
import { SubscriptionError } from './errors.js';
import type { FetchLike } from './http.js';
import type { SubscriptionEvent } from './schemas.js';

/** Headers on every delivery to the events webhook. */
export const EventsHeader = {
  /** Lower-case hex HMAC-SHA256 of the exact request body, keyed with the shared secret. */
  Signature: 'x-india-subscriptions-signature',
  /** Unix time in seconds at which the delivery was made. Informational: it is not part of the signed bytes. */
  Timestamp: 'x-india-subscriptions-timestamp',
} as const;
export type EventsHeader = (typeof EventsHeader)[keyof typeof EventsHeader];

/** How long one delivery may take before it counts as failed. */
export const DEFAULT_EVENTS_TIMEOUT_MS = 10_000;
const MILLIS_PER_SECOND = 1000;
const SUCCESS_STATUS_MIN = 200;
const SUCCESS_STATUS_MAX = 299;
/** A redirect is not followed: a 3xx counts as a failed delivery. */
const NO_REDIRECT = 'manual';

/** The JSON body of a delivery. */
export interface EventsDelivery {
  provider: Provider;
  events: SubscriptionEvent[];
}

export interface EventsForwarderOptions {
  url: string;
  secret: string;
  /** Defaults to global `fetch`. */
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Clock for the timestamp header, in epoch milliseconds. */
  now?: () => number;
}

/** The signature to send (or to expect) for a delivery body. */
export function signEventsBody(secret: string, rawBody: string): string {
  return sha256Hmac(secret, rawBody);
}

/** Constant-time check of the `x-india-subscriptions-signature` header against the exact body received. */
export function verifyEventsSignature(secret: string, rawBody: string, signature: string | null | undefined): boolean {
  return typeof signature === 'string' && safeEqual(signEventsBody(secret, rawBody), signature.trim().toLowerCase());
}

/** Only the origin of a URL: a webhook URL often carries a token in its path or query. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '(invalid url)';
  }
}

/**
 * Builds the `onEvents` hook that forwards each batch of verified, normalised
 * gateway webhook events to your own endpoint as signed JSON.
 *
 * It throws when the endpoint cannot be reached or does not answer 2xx; the
 * service then answers the gateway's webhook with 500, so the gateway retries
 * and no event is lost. Receivers should therefore be idempotent on event ids.
 * An empty batch sends nothing. The thrown message names the status or failure,
 * never the URL's path or the secret.
 */
export function createEventsForwarder(
  options: EventsForwarderOptions,
): (provider: Provider, events: SubscriptionEvent[]) => Promise<void> {
  const send: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));
  const timeoutMs = options.timeoutMs ?? DEFAULT_EVENTS_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const target = originOf(options.url);

  return async (provider, events) => {
    if (events.length === 0) return;
    const delivery: EventsDelivery = { provider, events };
    const body = JSON.stringify(delivery);
    let response: Response;
    try {
      response = await send(options.url, {
        method: HttpMethod.Post,
        headers: {
          [HeaderName.ContentType]: ContentType.Json,
          [EventsHeader.Signature]: signEventsBody(options.secret, body),
          [EventsHeader.Timestamp]: String(Math.floor(now() / MILLIS_PER_SECOND)),
        },
        body,
        redirect: NO_REDIRECT,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new SubscriptionError(
        timedOut ? ErrorCode.Timeout : ErrorCode.Network,
        `Events webhook at ${target} ${timedOut ? 'timed out' : 'could not be reached'}`,
        { provider, cause },
      );
    }
    // Drain the body so the connection can be reused.
    await response.arrayBuffer().catch(() => undefined);
    if (response.status < SUCCESS_STATUS_MIN || response.status > SUCCESS_STATUS_MAX) {
      throw new SubscriptionError(
        ErrorCode.ProviderUnavailable,
        `Events webhook at ${target} answered HTTP ${response.status}`,
        { provider, httpStatus: response.status },
      );
    }
  };
}
