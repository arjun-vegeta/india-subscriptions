import { createHash } from 'node:crypto';
import { Environment, HttpMethod } from '../../src/constants.js';
import type { FetchLike } from '../../src/http.js';
import { phonepe, type PhonePeConfig, type PhonePeProviderOptions } from '../../src/providers/phonepe/index.js';
import type { WebhookRequest } from '../../src/schemas.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';

/** Credentials that appear nowhere in PhonePe's docs: invented, recognisable in any leak. */
export const CLIENT_ID = 'TEST_CLIENT_ID_PHONEPE';
export const CLIENT_SECRET = 'test-client-secret-never-real-9f3b7c';
export const CLIENT_VERSION = '1';
export const WEBHOOK_USERNAME = 'merchant_hook_user';
export const WEBHOOK_PASSWORD = 'merchant-hook-password-never-real';
export const RETURN_URL = 'https://merchant.example/phonepe/return';

export const NOW = new Date('2026-11-17T05:00:00.000Z');
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

/** [A-INTRO "Environments", A-GOLIVE] */
export const SANDBOX_API = 'https://api-preprod.phonepe.com/apis/pg-sandbox';
export const PRODUCTION_API = 'https://api.phonepe.com/apis/pg';
/** [A-AUTH, A-GOLIVE] */
export const SANDBOX_TOKEN_URL = 'https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token';
export const PRODUCTION_TOKEN_URL = 'https://api.phonepe.com/apis/identity-manager/v1/oauth/token';

export const TEST_TOKEN = 'test-access-token-0001';

/** A token response in the documented shape, valid `lifetimeSeconds` from `nowMs`. */
export function tokenBody(nowMs: number, token = TEST_TOKEN, lifetimeSeconds = 7 * 24 * 3600): Record<string, unknown> {
  const issued = Math.floor(nowMs / 1000);
  return {
    access_token: token,
    encrypted_access_token: token,
    expires_in: null,
    issued_at: issued,
    expires_at: issued + lifetimeSeconds,
    session_expires_at: issued + lifetimeSeconds,
    token_type: 'O-Bearer',
  };
}

export function tokenRoute(nowMs: number, token = TEST_TOKEN, environment: Environment = Environment.Test): MockRoute {
  return {
    method: HttpMethod.Post,
    url: environment === Environment.Test ? SANDBOX_TOKEN_URL : PRODUCTION_TOKEN_URL,
    json: tokenBody(nowMs, token),
  };
}

/** A response with no body and status 204, which `new Response('', { status: 204 })` cannot build. */
export const NO_CONTENT_HEADER = 'x-test-no-content';
export function noContent(route: Omit<MockRoute, 'status' | 'headers' | 'json' | 'text'>): MockRoute {
  return { ...route, status: 200, headers: { [NO_CONTENT_HEADER]: '1' } };
}

export interface Harness {
  provider: ReturnType<typeof phonepe>;
  calls: RecordedCall[];
  /** Every recorded call except the token requests. */
  apiCalls: () => RecordedCall[];
  tokenCalls: () => RecordedCall[];
  remaining: () => number;
  clock: { now: Date; set(iso: string | number): void; advanceMs(ms: number): void };
}

export function isTokenCall(call: RecordedCall): boolean {
  return call.url === SANDBOX_TOKEN_URL || call.url === PRODUCTION_TOKEN_URL;
}

/**
 * A provider on a scripted fetch. One token response is added in front of `routes` (more with `tokens`, none with `0`).
 * The clock is the one the provider uses, movable by the test.
 */
export function makeProvider(
  routes: MockRoute[] = [],
  extra: { config?: Partial<PhonePeConfig>; options?: Partial<PhonePeProviderOptions>; tokens?: number; environment?: Environment } = {},
): Harness {
  const environment = extra.environment ?? Environment.Test;
  const clock = {
    now: new Date(NOW),
    set(value: string | number) {
      this.now = new Date(value);
    },
    advanceMs(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const tokens = extra.tokens ?? 1;
  const tokenRoutes = Array.from({ length: tokens }, (_, index) =>
    tokenRoute(clock.now.getTime(), index === 0 ? TEST_TOKEN : `${TEST_TOKEN.slice(0, -4)}${String(index + 1).padStart(4, '0')}`, environment),
  );
  const mock = mockFetch([...tokenRoutes, ...routes]);
  const fetch: FetchLike = async (url, init) => {
    const response = await mock.fetch(url, init);
    return response.headers.get(NO_CONTENT_HEADER) ? new Response(null, { status: 204 }) : response;
  };
  let counter = 0;
  const provider = phonepe(
    {
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      clientVersion: CLIENT_VERSION,
      environment,
      redirectUrl: RETURN_URL,
      webhookUsername: WEBHOOK_USERNAME,
      webhookPassword: WEBHOOK_PASSWORD,
      ...extra.config,
    },
    {
      fetch,
      now: () => clock.now,
      maxRetries: 0,
      generateId: () => `sub_${String(++counter).padStart(8, '0')}`,
      ...extra.options,
    },
  );
  return {
    provider,
    calls: mock.calls,
    apiCalls: () => mock.calls.filter((call) => !isTokenCall(call)),
    tokenCalls: () => mock.calls.filter(isTokenCall),
    remaining: mock.remaining,
    clock,
  };
}

/** Route for an API path (sandbox host). */
export function route(method: HttpMethod, path: string, response: Omit<MockRoute, 'method' | 'url'> = {}): MockRoute {
  return { method, url: `${SANDBOX_API}${path}`, ...response };
}

export const O_BEARER = (token = TEST_TOKEN): string => `O-Bearer ${token}`;

/** Independent SHA-256 (hex) straight from node:crypto. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The `Authorization` value PhonePe sends with a webhook: `SHA256(username:password)` [G-UATCHECK, SDK CommonUtils]. */
export const WEBHOOK_AUTHORIZATION = sha256Hex(`${WEBHOOK_USERNAME}:${WEBHOOK_PASSWORD}`);

export function webhookRequest(body: unknown, authorization: string | undefined = WEBHOOK_AUTHORIZATION): WebhookRequest {
  return {
    rawBody: typeof body === 'string' ? body : JSON.stringify(body),
    headers: authorization === undefined ? {} : { authorization },
  };
}

export const CUSTOMER = { name: 'Ashish Kumar', email: 'ashish@example.com', phone: '9876543210' };

export const MONTHLY_PLAN = {
  name: 'Pro monthly',
  amount: 49900,
  interval: { unit: 'month', count: 1 },
} as const;

/** Epoch milliseconds of an ISO instant. */
export function ms(iso: string): number {
  return Date.parse(iso);
}

/** The text of an error and everything it carries, for "no secret leaks" assertions. */
export function everythingIn(error: unknown): string {
  if (error instanceof Error) {
    const own = Object.getOwnPropertyNames(error).map((key) => {
      const value = (error as unknown as Record<string, unknown>)[key];
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
    const cause = (error as { cause?: unknown }).cause;
    return [error.message, error.stack ?? '', ...own, cause !== undefined ? everythingIn(cause) : ''].join('\n');
  }
  return String(error);
}

export async function rejection(promise: Promise<unknown> | (() => Promise<unknown>)): Promise<Error & { code?: string; providerCode?: string; httpStatus?: number }> {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    return error as Error & { code?: string; providerCode?: string; httpStatus?: number };
  }
  throw new Error('expected the call to fail');
}
