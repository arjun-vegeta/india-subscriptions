import type { z } from 'zod';
import { ErrorCode, type Provider } from './constants.js';

export interface SubscriptionErrorOptions {
  provider?: Provider;
  /** HTTP status returned by the gateway, when there was a response. */
  httpStatus?: number;
  /** The gateway's own error code, verbatim. */
  providerCode?: string;
  /** The parsed gateway response body, or validation issues, verbatim. */
  raw?: unknown;
  cause?: unknown;
}

const RETRYABLE: readonly ErrorCode[] = [
  ErrorCode.RateLimited,
  ErrorCode.ProviderUnavailable,
  ErrorCode.Network,
  ErrorCode.Timeout,
];

/** The only error type this library throws. Branch on `code`. */
export class SubscriptionError extends Error {
  readonly code: ErrorCode;
  readonly provider?: Provider;
  readonly httpStatus?: number;
  readonly providerCode?: string;
  readonly raw?: unknown;

  constructor(code: ErrorCode, message: string, options: SubscriptionErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SubscriptionError';
    this.code = code;
    this.provider = options.provider;
    this.httpStatus = options.httpStatus;
    this.providerCode = options.providerCode;
    this.raw = options.raw;
  }

  /** True when repeating the same call later is safe and may succeed. */
  get retryable(): boolean {
    return RETRYABLE.includes(this.code);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      provider: this.provider,
      httpStatus: this.httpStatus,
      providerCode: this.providerCode,
      retryable: this.retryable,
    };
  }
}

export function unsupported(provider: Provider, what: string, why?: string): SubscriptionError {
  return new SubscriptionError(
    ErrorCode.Unsupported,
    `${provider} does not support ${what}${why ? `: ${why}` : ''}`,
    { provider },
  );
}

export function invalid(message: string, provider?: Provider, raw?: unknown): SubscriptionError {
  return new SubscriptionError(ErrorCode.Validation, message, { provider, raw });
}

export function isSubscriptionError(value: unknown): value is SubscriptionError {
  return value instanceof SubscriptionError;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.length ? issue.path.join('.') : '(root)'}: ${issue.message}`)
    .join('; ');
}

/**
 * Validates caller input against a schema. Throws `VALIDATION` with the
 * offending paths, so a bad request never reaches a gateway.
 */
export function parseInput<S extends z.ZodType>(schema: S, value: unknown, what: string, provider?: Provider): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new SubscriptionError(ErrorCode.Validation, `Invalid ${what}: ${describeIssues(result.error)}`, {
    provider,
    raw: result.error.issues,
  });
}

/**
 * Validates a gateway response against a schema. Throws `UNEXPECTED_RESPONSE`
 * so a changed or malformed payload fails loudly instead of flowing through
 * as `undefined`.
 */
export function parseResponse<S extends z.ZodType>(schema: S, value: unknown, what: string, provider: Provider): z.output<S> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new SubscriptionError(
    ErrorCode.UnexpectedResponse,
    `${provider} returned an unexpected ${what}: ${describeIssues(result.error)}`,
    { provider, raw: value },
  );
}
