import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import { Environment, HttpMethod } from '../../src/constants.js';
import {
  GOOGLE_JWKS_URL,
  GOOGLE_PLAY_API_URL,
  GOOGLE_TOKEN_URL,
  googlePlay,
  type GooglePlayConfig,
  type GooglePlayProviderOptions,
} from '../../src/providers/googleplay/index.js';
import type { WebhookRequest } from '../../src/schemas.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';

/** Invented, recognisable in any leak. */
export const PACKAGE_NAME = 'com.example.app';
export const CLIENT_EMAIL = 'billing@example-project.iam.gserviceaccount.com';
export const PRIVATE_KEY_ID = '370ab79b4513eb9bad7c9bd16a95cb76b5b2a56a';
export const PUSH_AUDIENCE = 'https://merchant.example/hooks/google-play';
export const PUSH_EMAIL = 'pubsub-push@example-project.iam.gserviceaccount.com';

export const NOW = new Date('2026-11-22T06:00:00.000Z');
export const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const serviceKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
/** The service account key: generated for the tests. */
export const SERVICE_PRIVATE_KEY = serviceKeys.privateKey;
export const SERVICE_PUBLIC_KEY = serviceKeys.publicKey;
export const SERVICE_PRIVATE_PEM = serviceKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

export const TEST_TOKEN = 'ya29.test-access-token-0001';

/** The token response sample of https://developers.google.com/identity/protocols/oauth2/service-account ("Response handling"). */
export function tokenBody(token = TEST_TOKEN, expiresIn = 3600): Record<string, unknown> {
  return { access_token: token, scope: 'https://www.googleapis.com/auth/androidpublisher', token_type: 'Bearer', expires_in: expiresIn };
}

export const tokenRoute = (token = TEST_TOKEN, expiresIn = 3600): MockRoute => ({
  method: HttpMethod.Post,
  url: GOOGLE_TOKEN_URL,
  json: tokenBody(token, expiresIn),
});

export const api = (path: string, query = '') => `${GOOGLE_PLAY_API_URL}${path}${query}`;
export const P = `/applications/${PACKAGE_NAME}`;

export function route(method: HttpMethod, path: string, response: Partial<MockRoute> = {}, query = ''): MockRoute {
  return { method, url: api(path, query), json: {}, ...response };
}

export interface Harness {
  provider: ReturnType<typeof googlePlay>;
  calls: RecordedCall[];
  apiCalls: () => RecordedCall[];
  tokenCalls: () => RecordedCall[];
  remaining: () => number;
  clock: { now: Date; advanceMs(ms: number): void };
}

export function baseConfig(extra: Partial<GooglePlayConfig> = {}): GooglePlayConfig {
  return {
    packageName: PACKAGE_NAME,
    clientEmail: CLIENT_EMAIL,
    privateKey: SERVICE_PRIVATE_PEM,
    privateKeyId: PRIVATE_KEY_ID,
    environment: Environment.Test,
    ...extra,
  };
}

/** A provider on a scripted fetch. One token response is added in front of `routes` (more with `tokens`, none with 0). */
export function makeProvider(
  routes: MockRoute[] = [],
  extra: { config?: Partial<GooglePlayConfig>; options?: Partial<GooglePlayProviderOptions>; tokens?: number } = {},
): Harness {
  const clock = {
    now: new Date(NOW),
    advanceMs(ms: number) {
      clock.now = new Date(clock.now.getTime() + ms);
    },
  };
  const tokens = Array.from({ length: extra.tokens ?? 1 }, () => tokenRoute());
  const mock = mockFetch([...tokens, ...routes]);
  const provider = googlePlay(baseConfig(extra.config), {
    fetch: mock.fetch,
    now: () => clock.now,
    maxRetries: 0,
    generateId: () => '11111111-2222-4333-8444-555555555555',
    ...extra.options,
  });
  const isToken = (call: RecordedCall) => call.url === GOOGLE_TOKEN_URL;
  return {
    provider,
    calls: mock.calls,
    apiCalls: () => mock.calls.filter((call) => !isToken(call) && call.url !== GOOGLE_JWKS_URL),
    tokenCalls: () => mock.calls.filter(isToken),
    remaining: mock.remaining,
    clock,
  };
}

// ---------------------------------------------------------------------------
// Pub/Sub pushes
// ---------------------------------------------------------------------------

export const pushKeys = generateKeyPairSync('rsa', { modulusLength: 2048 });
export const PUSH_KID = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

/** Google's published key set as `https://www.googleapis.com/oauth2/v3/certs` returns it ("keys" of JWKs). */
export function jwksBody(...entries: Array<{ kid: string; key: KeyObject }>): Record<string, unknown> {
  return {
    keys: entries.map(({ kid, key }) => {
      const jwk = key.export({ format: 'jwk' });
      return { alg: 'RS256', use: 'sig', kty: jwk.kty, kid, n: jwk.n, e: jwk.e };
    }),
  };
}

export const jwksRoute = (entries = [{ kid: PUSH_KID, key: pushKeys.publicKey }], headers: Record<string, string> = { 'cache-control': 'public, max-age=23966, must-revalidate, no-transform' }): MockRoute => ({
  method: HttpMethod.Get,
  url: GOOGLE_JWKS_URL,
  json: jwksBody(...entries),
  headers,
});

export const b64url = (value: string | Buffer) => Buffer.from(value).toString('base64url');

/** Signs a JWT the way Pub/Sub does: RS256, claims in the shape of the documented sample. */
export function pushToken(
  claims: Record<string, unknown> = {},
  options: { key?: KeyObject; kid?: string; header?: Record<string, unknown> } = {},
): string {
  const header = { alg: 'RS256', kid: options.kid ?? PUSH_KID, typ: 'JWT', ...options.header };
  const body = {
    aud: PUSH_AUDIENCE,
    azp: '113774264463038321964',
    email: PUSH_EMAIL,
    sub: '113774264463038321964',
    email_verified: true,
    exp: NOW_SECONDS + 3000,
    iat: NOW_SECONDS - 600,
    iss: 'https://accounts.google.com',
    ...claims,
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(body))}`;
  const signature = sign('RSA-SHA256', Buffer.from(signingInput), options.key ?? pushKeys.privateKey);
  return `${signingInput}.${b64url(signature)}`;
}

/** The wrapped push body of https://cloud.google.com/pubsub/docs/push with `notification` as the message data. */
export function pushBody(notification: unknown, messageId = '136969346945'): string {
  return JSON.stringify({
    message: {
      attributes: { key: 'value' },
      data: Buffer.from(JSON.stringify(notification)).toString('base64'),
      messageId,
      message_id: messageId,
      publishTime: '2026-11-22T06:00:00.000Z',
    },
    subscription: 'projects/myproject/subscriptions/mysubscription',
  });
}

export function pushRequest(notification: unknown, options: { token?: string | null; messageId?: string } = {}): WebhookRequest {
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? pushToken()}`;
  return { rawBody: pushBody(notification, options.messageId), headers };
}

export const authenticatedConfig = { pushAudience: PUSH_AUDIENCE, pushServiceAccountEmail: PUSH_EMAIL };

/** Every string in `value`, for scans that must find no secret in an error. */
export function everythingIn(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (item instanceof Error ? { ...item, message: item.message } : item));
}
