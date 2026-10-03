import {
  EPOCH_MILLISECONDS_THRESHOLD,
  EPOCH_SECONDS_THRESHOLD,
  TOKEN_FALLBACK_LIFETIME_MS,
  TOKEN_REFRESH_MARGIN_MS,
} from './constants.js';
import type { PhonePeTokenResponse } from './schemas.js';

/**
 * The instant (epoch milliseconds) at which a token should be replaced: its documented expiry minus a safety margin.
 *
 * [A-AUTH] documents `expires_at` as "Token expiry timestamp in epoch" (its sample is epoch SECONDS) but its prose calls it
 * "the token's validity (in seconds)", and the sample's `expires_in` is `null`. So:
 *  - `expires_at` above 1e12 is epoch milliseconds, above 1e9 epoch seconds, anything smaller a lifetime in seconds;
 *  - else `expires_in` is a lifetime in seconds;
 *  - else the token is trusted for `TOKEN_FALLBACK_LIFETIME_MS` only.
 * The margin is `TOKEN_REFRESH_MARGIN_MS` ("3-5 minutes before its actual expiry" [G-UATCHECK]), or half the remaining
 * life for a token that lives less than twice that.
 */
export function tokenRefreshAt(response: PhonePeTokenResponse, nowMs: number): number {
  const expiresAt = response.expires_at;
  const expiresIn = response.expires_in;
  let expiryMs: number;
  if (typeof expiresAt === 'number' && expiresAt > 0) {
    if (expiresAt > EPOCH_MILLISECONDS_THRESHOLD) expiryMs = expiresAt;
    else if (expiresAt > EPOCH_SECONDS_THRESHOLD) expiryMs = expiresAt * 1000;
    else expiryMs = nowMs + expiresAt * 1000;
  } else if (typeof expiresIn === 'number' && expiresIn > 0) {
    expiryMs = nowMs + expiresIn * 1000;
  } else {
    expiryMs = nowMs + TOKEN_FALLBACK_LIFETIME_MS;
  }
  const remaining = expiryMs - nowMs;
  const margin = Math.min(TOKEN_REFRESH_MARGIN_MS, remaining / 2);
  return expiryMs - margin;
}

interface CachedToken {
  token: string;
  refreshAtMs: number;
}

/**
 * Keeps one OAuth access token per provider instance.
 *
 * - The token is cached until `tokenRefreshAt`, measured with the injected clock.
 * - Concurrent callers share ONE in-flight token request.
 * - `invalidate(token)` drops the cached token only if it is still the one that was rejected, so a 401 for an old token
 *   never throws away a newer one fetched meanwhile.
 * - A token that is already due for renewal when it arrives (a skewed clock) is used for the call that asked for it
 *   and not cached, so the next call asks again instead of looping.
 *
 * The token lives in a private field: it is invisible to `JSON.stringify`, `console.log` and spreads, and nothing in
 * this class puts it into an error.
 */
export class PhonePeTokenManager {
  readonly #fetchToken: () => Promise<PhonePeTokenResponse>;
  readonly #now: () => Date;
  #cached: CachedToken | undefined;
  #inflight: Promise<string> | undefined;

  constructor(fetchToken: () => Promise<PhonePeTokenResponse>, now: () => Date) {
    this.#fetchToken = fetchToken;
    this.#now = now;
  }

  async getToken(): Promise<string> {
    const cached = this.#cached;
    if (cached && this.#now().getTime() < cached.refreshAtMs) return cached.token;
    if (this.#inflight) return this.#inflight;
    const request = this.#renew().finally(() => {
      if (this.#inflight === request) this.#inflight = undefined;
    });
    this.#inflight = request;
    return request;
  }

  /** Forgets the cached token when it is `rejected` (the one an API call just had a 401 for). */
  invalidate(rejected: string): void {
    if (this.#cached?.token === rejected) this.#cached = undefined;
  }

  async #renew(): Promise<string> {
    const response = await this.#fetchToken();
    const nowMs = this.#now().getTime();
    const refreshAtMs = tokenRefreshAt(response, nowMs);
    this.#cached = refreshAtMs > nowMs ? { token: response.access_token, refreshAtMs } : undefined;
    return response.access_token;
  }
}
