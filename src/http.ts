import { ErrorCode, HttpMethod, type Provider } from './constants.js';
import { SubscriptionError } from './errors.js';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpOptions {
  /** Custom fetch (tests, proxies, instrumentation). Defaults to global fetch. */
  fetch?: FetchLike;
  /** Per-request timeout in milliseconds. Default 30000. */
  timeoutMs?: number;
  /** Automatic retries for requests that are safe to repeat. Default 2. */
  maxRetries?: number;
}

export interface HttpRequest {
  provider: Provider;
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * True only when repeating the request cannot create or charge anything
   * twice: reads, or writes protected by a gateway idempotency key.
   */
  idempotent: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  text: string;
  /** Parsed body, or undefined when the body is not JSON. */
  json: unknown;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RETRY_AFTER_HEADER = 'retry-after';
/** Never sleep longer than this on a gateway's Retry-After; the caller can retry later instead. */
const MAX_RETRY_AFTER_MS = 5000;

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  /** Overridable so tests don't wait for real backoff. */
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  constructor(options: HttpOptions = {}) {
    const globalFetch = (globalThis as { fetch?: FetchLike }).fetch;
    const chosen = options.fetch ?? globalFetch;
    if (!chosen) {
      throw new SubscriptionError(ErrorCode.Config, 'No fetch implementation found. Use Node 18+ or pass options.fetch.');
    }
    this.fetchImpl = options.fetch ? chosen : chosen.bind(globalThis);
    this.timeoutMs = positiveOr(options.timeoutMs, 30_000);
    this.maxRetries = Math.floor(nonNegativeOr(options.maxRetries, 2));
  }

  async send(request: HttpRequest): Promise<HttpResponse> {
    const attempts = request.idempotent ? this.maxRetries + 1 : 1;
    let lastError: SubscriptionError | undefined;

    let retryAfterMs: number | undefined;

    for (let attempt = 1; attempt <= attempts; attempt++) {
      if (attempt > 1) await this.sleep(retryAfterMs ?? backoffMs(attempt - 1));
      retryAfterMs = undefined;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      try {
        const response = await this.fetchImpl(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body,
          signal: controller.signal,
        });
        const text = await response.text();
        const result: HttpResponse = {
          status: response.status,
          headers: response.headers,
          text,
          json: parseJson(text),
        };
        if (RETRYABLE_STATUS.has(response.status) && attempt < attempts) {
          lastError = undefined;
          retryAfterMs = retryAfterToMs(response.headers.get(RETRY_AFTER_HEADER));
          continue;
        }
        return result;
      } catch (cause) {
        const timedOut = controller.signal.aborted;
        lastError = transportError(request, timedOut, this.timeoutMs, cause);
        if (!request.idempotent) throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new SubscriptionError(ErrorCode.Network, 'Request failed', { provider: request.provider });
  }
}

function transportError(
  request: HttpRequest,
  timedOut: boolean,
  timeoutMs: number,
  cause: unknown,
): SubscriptionError {
  const where = `${request.method} ${stripQuery(request.url)}`;
  if (!request.idempotent) {
    return new SubscriptionError(
      ErrorCode.OutcomeUnknown,
      `${where} was sent but no response was received${timedOut ? ` within ${timeoutMs}ms` : ''}. ` +
        'It may or may not have taken effect: fetch the current state before retrying.',
      { provider: request.provider, cause },
    );
  }
  return timedOut
    ? new SubscriptionError(ErrorCode.Timeout, `${where} timed out after ${timeoutMs}ms`, { provider: request.provider, cause })
    : new SubscriptionError(ErrorCode.Network, `${where} failed: ${describe(cause)}`, { provider: request.provider, cause });
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Honours a numeric Retry-After (seconds), capped so a request never stalls for long. */
function retryAfterToMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function backoffMs(retryNumber: number): number {
  return Math.min(250 * 2 ** (retryNumber - 1), 2000);
}

function parseJson(text: string): unknown {
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Maps an HTTP status from a gateway to this library's error codes.
 *
 * A 5xx on a request that is not idempotent is reported as OUTCOME_UNKNOWN:
 * gateways do return 502/504 for requests they went on to process.
 */
export function codeForStatus(status: number, idempotent: boolean): ErrorCode {
  if (status === 400 || status === 422) return ErrorCode.Validation;
  if (status === 401 || status === 403) return ErrorCode.Auth;
  if (status === 404) return ErrorCode.NotFound;
  if (status === 409) return ErrorCode.Conflict;
  if (status === 429) return ErrorCode.RateLimited;
  if (status >= 500) return idempotent ? ErrorCode.ProviderUnavailable : ErrorCode.OutcomeUnknown;
  return ErrorCode.ProviderError;
}

export function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

export function formEncode(fields: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) params.append(key, String(value));
  }
  return params.toString();
}

export function withQuery(url: string, query: Record<string, string | number | undefined>): string {
  const encoded = formEncode(query);
  if (!encoded) return url;
  const hashIndex = url.indexOf('#');
  const base = hashIndex === -1 ? url : url.slice(0, hashIndex);
  const fragment = hashIndex === -1 ? '' : url.slice(hashIndex);
  let separator = '?';
  if (base.includes('?')) separator = base.endsWith('?') || base.endsWith('&') ? '' : '&';
  return `${base}${separator}${encoded}${fragment}`;
}
