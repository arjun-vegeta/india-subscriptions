import { describe, expect, it } from 'vitest';
import { ErrorCode, HttpMethod } from '../../src/constants.js';
import { PhonePeTokenManager, tokenRefreshAt } from '../../src/providers/phonepe/index.js';
import type { PhonePeTokenResponse } from '../../src/providers/phonepe/schemas.js';
import { SUBSCRIPTION_STATUS_SC_SUBSTATUS, TOKEN_RESPONSE_A_AUTH, A_AUTH_EXPIRES_AT_MS, A_AUTH_ISSUED_AT_MS, ERROR_BAD_REQUEST } from './fixtures.js';
import {
  CLIENT_ID,
  CLIENT_SECRET,
  CLIENT_VERSION,
  HOUR,
  NOW,
  O_BEARER,
  PRODUCTION_API,
  PRODUCTION_TOKEN_URL,
  SANDBOX_API,
  SANDBOX_TOKEN_URL,
  TEST_TOKEN,
  everythingIn,
  makeProvider,
  rejection,
  route,
  tokenBody,
} from './helpers.js';
import { Environment } from '../../src/constants.js';

const STATUS_PATH = '/checkout/v2/subscriptions/Sub123/status';
const statusRoute = (response: Record<string, unknown> = {}) =>
  route(HttpMethod.Get, STATUS_PATH, { json: SUBSCRIPTION_STATUS_SC_SUBSTATUS, ...response });

describe('PhonePe token: the request', () => {
  it('posts the documented form to the sandbox token URL and sends the token as "O-Bearer <token>" [A-AUTH]', async () => {
    const t = makeProvider([statusRoute()]);
    await t.provider.getSubscription('Sub123');

    const [token] = t.tokenCalls();
    expect(token).toMatchObject({ method: 'POST', url: SANDBOX_TOKEN_URL });
    expect(token?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    // The four form fields of [A-AUTH], and nothing else.
    expect(token?.form).toEqual({
      client_id: CLIENT_ID,
      client_version: CLIENT_VERSION,
      client_secret: CLIENT_SECRET,
      grant_type: 'client_credentials',
    });

    const [api] = t.apiCalls();
    expect(api).toMatchObject({ method: 'GET', url: `${SANDBOX_API}${STATUS_PATH}` });
    expect(api?.headers.authorization).toBe(O_BEARER());
    expect(api?.headers.authorization).not.toMatch(/^Bearer /);
  });

  it('uses the production hosts in production: identity-manager for the token, /apis/pg for the rest [A-AUTH, A-GOLIVE]', async () => {
    const t = makeProvider([{ method: HttpMethod.Get, url: `${PRODUCTION_API}${STATUS_PATH}`, json: SUBSCRIPTION_STATUS_SC_SUBSTATUS }], {
      environment: Environment.Live,
    });
    await t.provider.getSubscription('Sub123');
    expect(t.tokenCalls()[0]?.url).toBe(PRODUCTION_TOKEN_URL);
    expect(t.apiCalls()[0]?.url).toBe(`${PRODUCTION_API}${STATUS_PATH}`);
  });

  it('sends a numeric clientVersion as text', async () => {
    const t = makeProvider([statusRoute()], { config: { clientVersion: 1 } });
    await t.provider.getSubscription('Sub123');
    expect(t.tokenCalls()[0]?.form?.client_version).toBe('1');
  });

  it('honours tokenUrl and apiUrl overrides', async () => {
    const t = makeProvider(
      [
        { method: HttpMethod.Post, url: 'https://proxy.example/token', json: tokenBody(NOW.getTime()) },
        { method: HttpMethod.Get, url: `https://proxy.example/pg${STATUS_PATH}`, json: SUBSCRIPTION_STATUS_SC_SUBSTATUS },
      ],
      { config: { apiUrl: 'https://proxy.example/pg/', tokenUrl: 'https://proxy.example/token' }, tokens: 0 },
    );
    await t.provider.getSubscription('Sub123');
    expect(t.calls.map((call) => call.url)).toEqual(['https://proxy.example/token', `https://proxy.example/pg${STATUS_PATH}`]);
  });
});

describe('PhonePe token: caching, expiry, sharing', () => {
  it('caches the token across calls: one token request for many API calls', async () => {
    const t = makeProvider([statusRoute(), statusRoute(), statusRoute()]);
    await t.provider.getSubscription('Sub123');
    await t.provider.getSubscription('Sub123');
    await t.provider.getSubscription('Sub123');
    expect(t.tokenCalls()).toHaveLength(1);
    expect(t.apiCalls().map((call) => call.headers.authorization)).toEqual([O_BEARER(), O_BEARER(), O_BEARER()]);
  });

  it('works with the verbatim [A-AUTH] response (expires_in null, expires_at in epoch seconds) and renews it 5 minutes before expires_at', async () => {
    const t = makeProvider(
      [
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: TOKEN_RESPONSE_A_AUTH },
        statusRoute(),
        statusRoute(),
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(A_AUTH_EXPIRES_AT_MS - 4 * 60 * 1000, 'second-token') },
        statusRoute(),
      ],
      { tokens: 0 },
    );
    t.clock.set(A_AUTH_ISSUED_AT_MS);
    await t.provider.getSubscription('Sub123');
    // Six days later: still the first token.
    t.clock.set(A_AUTH_ISSUED_AT_MS + 6 * 24 * HOUR);
    await t.provider.getSubscription('Sub123');
    expect(t.tokenCalls()).toHaveLength(1);
    expect(t.apiCalls()[1]?.headers.authorization).toBe(O_BEARER(TOKEN_RESPONSE_A_AUTH.access_token));

    // 4 minutes before expires_at: inside the 5 minute margin, so the token is renewed.
    t.clock.set(A_AUTH_EXPIRES_AT_MS - 4 * 60 * 1000);
    await t.provider.getSubscription('Sub123');
    expect(t.tokenCalls()).toHaveLength(2);
    expect(t.apiCalls()[2]?.headers.authorization).toBe(O_BEARER('second-token'));
  });

  it('refreshes an expired token with the injected clock and uses the new token from then on', async () => {
    const t = makeProvider(
      [
        // The first token lives one hour.
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(NOW.getTime(), 'short-lived-token', 3600) },
        statusRoute(),
        // The second is issued two hours later and lives a week.
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(NOW.getTime() + 2 * HOUR, 'renewed-token') },
        statusRoute(),
        statusRoute(),
      ],
      { tokens: 0 },
    );
    await t.provider.getSubscription('Sub123');
    t.clock.advanceMs(2 * HOUR);
    await t.provider.getSubscription('Sub123');
    await t.provider.getSubscription('Sub123');
    expect(t.tokenCalls()).toHaveLength(2);
    expect(t.apiCalls().map((call) => call.headers.authorization)).toEqual([
      O_BEARER('short-lived-token'),
      O_BEARER('renewed-token'),
      O_BEARER('renewed-token'),
    ]);
  });

  it('shares ONE in-flight token request between concurrent calls', async () => {
    const t = makeProvider([statusRoute(), statusRoute(), statusRoute(), statusRoute(), statusRoute()]);
    await Promise.all(Array.from({ length: 5 }, () => t.provider.getSubscription('Sub123')));
    // A second token request would hit "unexpected request" (only one token route is scripted).
    expect(t.tokenCalls()).toHaveLength(1);
    expect(t.apiCalls()).toHaveLength(5);
  });

  it('does not cache a failed token request: the next call asks again', async () => {
    const t = makeProvider(
      [
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, status: 503, json: { code: 'INTERNAL_SERVER_ERROR', message: 'try again' } },
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(NOW.getTime()) },
        statusRoute(),
      ],
      { tokens: 0 },
    );
    const first = await rejection(() => t.provider.getSubscription('Sub123'));
    expect(first.code).toBe(ErrorCode.ProviderUnavailable);
    await t.provider.getSubscription('Sub123');
    expect(t.tokenCalls()).toHaveLength(2);
  });

  it('a token that arrives already due for renewal (a skewed clock) serves its own call and is not cached', async () => {
    const stale = tokenBody(NOW.getTime() - 30 * 24 * HOUR);
    const t = makeProvider(
      [
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: stale },
        statusRoute(),
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(NOW.getTime()) },
        statusRoute(),
      ],
      { tokens: 0 },
    );
    await t.provider.getSubscription('Sub123');
    await t.provider.getSubscription('Sub123');
    expect(t.tokenCalls()).toHaveLength(2);
  });
});

describe('tokenRefreshAt', () => {
  const NOW_MS = NOW.getTime();
  const base: PhonePeTokenResponse = { access_token: 'x' };

  it('expires_at in epoch seconds: renew 5 minutes before it', () => {
    const expirySeconds = Math.floor(NOW_MS / 1000) + 7200;
    expect(tokenRefreshAt({ ...base, expires_at: expirySeconds }, NOW_MS)).toBe(expirySeconds * 1000 - 5 * 60 * 1000);
  });

  it('expires_at in epoch milliseconds is read as milliseconds', () => {
    expect(tokenRefreshAt({ ...base, expires_at: NOW_MS + 7_200_000 }, NOW_MS)).toBe(NOW_MS + 7_200_000 - 5 * 60 * 1000);
  });

  it('a small expires_at is a lifetime in seconds ([A-AUTH] prose: "validity (in seconds)")', () => {
    expect(tokenRefreshAt({ ...base, expires_at: 3600 }, NOW_MS)).toBe(NOW_MS + 3_600_000 - 5 * 60 * 1000);
  });

  it('expires_in is a lifetime in seconds when expires_at is absent', () => {
    expect(tokenRefreshAt({ ...base, expires_in: 1800, expires_at: null }, NOW_MS)).toBe(NOW_MS + 1_800_000 - 5 * 60 * 1000);
  });

  it('a token that lives under ten minutes is renewed at half its life', () => {
    expect(tokenRefreshAt({ ...base, expires_in: 360 }, NOW_MS)).toBe(NOW_MS + 180_000);
  });

  it('no expiry at all: trusted for five minutes at most, renewed at half of that', () => {
    expect(tokenRefreshAt({ ...base }, NOW_MS)).toBe(NOW_MS + 150_000);
  });

  it('a manager built directly caches until that instant and invalidate() only drops the token it was told about', async () => {
    let issued = 0;
    let clock = NOW_MS;
    const manager = new PhonePeTokenManager(
      async () => ({ access_token: `tok${++issued}`, expires_in: 3600 }),
      () => new Date(clock),
    );
    expect(await manager.getToken()).toBe('tok1');
    manager.invalidate('some-older-token');
    expect(await manager.getToken()).toBe('tok1');
    manager.invalidate('tok1');
    expect(await manager.getToken()).toBe('tok2');
    clock += 3_400_000; // 56 minutes: past the 5 minute margin of a 60 minute token
    expect(await manager.getToken()).toBe('tok3');
  });
});

describe('PhonePe token: a 401 from an API call', () => {
  it('drops the token, fetches a new one ONCE and repeats a read once', async () => {
    const t = makeProvider(
      [
        statusRoute({ status: 401, json: { code: 'UNAUTHORIZED', message: 'token rejected' } }),
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(NOW.getTime(), 'fresh-token') },
        statusRoute(),
      ],
      { tokens: 1 },
    );
    const subscription = await t.provider.getSubscription('Sub123');
    expect(subscription.id).toBe('Sub123');
    expect(t.tokenCalls()).toHaveLength(2);
    expect(t.apiCalls().map((call) => call.headers.authorization)).toEqual([O_BEARER(), O_BEARER('fresh-token')]);
  });

  it('a second 401 is surfaced as AUTH: no third attempt', async () => {
    const t = makeProvider(
      [
        statusRoute({ status: 401, json: { code: 'UNAUTHORIZED', message: 'token rejected' } }),
        { method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: tokenBody(NOW.getTime(), 'fresh-token') },
        statusRoute({ status: 401, json: { code: 'UNAUTHORIZED', message: 'token rejected' } }),
      ],
      { tokens: 1 },
    );
    const error = await rejection(() => t.provider.getSubscription('Sub123'));
    expect(error.code).toBe(ErrorCode.Auth);
    expect(error.httpStatus).toBe(401);
    expect(t.apiCalls()).toHaveLength(2);
    expect(t.tokenCalls()).toHaveLength(2);
    expect(everythingIn(error)).not.toContain('fresh-token');
    expect(everythingIn(error)).not.toContain(TEST_TOKEN);
  });

  it('a 400 is not a token problem: no refresh', async () => {
    const t = makeProvider([statusRoute({ status: 400, json: ERROR_BAD_REQUEST })]);
    const error = await rejection(() => t.provider.getSubscription('Sub123'));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(t.tokenCalls()).toHaveLength(1);
  });
});

describe('PhonePe token: failures never leak the secret or a token', () => {
  it('a rejected token request is AUTH, names no secret and carries no raw body', async () => {
    const t = makeProvider(
      [
        {
          method: HttpMethod.Post,
          url: SANDBOX_TOKEN_URL,
          status: 401,
          // A body that (hypothetically) echoes credentials: nothing of it may reach the error.
          json: { errorCode: 'AUTH_FAILED', context: { client_secret: CLIENT_SECRET, access_token: 'echoed-token' } },
        },
      ],
      { tokens: 0 },
    );
    const error = await rejection(() => t.provider.getSubscription('Sub123'));
    expect(error.code).toBe(ErrorCode.Auth);
    expect(error.httpStatus).toBe(401);
    const text = everythingIn(error);
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain('echoed-token');
    expect((error as { raw?: unknown }).raw).toBeUndefined();
  });

  it('a 400 on the token endpoint (bad client_version) is also AUTH', async () => {
    const t = makeProvider([{ method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, status: 400, json: ERROR_BAD_REQUEST }], { tokens: 0 });
    const error = await rejection(() => t.provider.getSubscription('Sub123'));
    expect(error.code).toBe(ErrorCode.Auth);
  });

  it('a token response without access_token is UNEXPECTED_RESPONSE and echoes nothing', async () => {
    const t = makeProvider(
      [{ method: HttpMethod.Post, url: SANDBOX_TOKEN_URL, json: { encrypted_access_token: 'sneaky-token-value', expires_at: 5 } }],
      { tokens: 0 },
    );
    const error = await rejection(() => t.provider.getSubscription('Sub123'));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
    expect(everythingIn(error)).not.toContain('sneaky-token-value');
  });

  it('a dropped connection on the token request is NETWORK (a safe repeat), never OUTCOME_UNKNOWN', async () => {
    const t = makeProvider([], { tokens: 0, options: { maxRetries: 0 } });
    // No token route is scripted: the mock throws, like a dropped connection.
    const error = await rejection(() => t.provider.getSubscription('Sub123'));
    expect(error.code).toBe(ErrorCode.Network);
    expect(everythingIn(error)).not.toContain(CLIENT_SECRET);
  });

  it('the provider object does not expose the secret to JSON.stringify or spreads', () => {
    const t = makeProvider();
    expect(JSON.stringify(t.provider)).not.toContain(CLIENT_SECRET);
    expect(JSON.stringify({ ...t.provider })).not.toContain(CLIENT_SECRET);
    expect(Object.values(t.provider).join(' ')).not.toContain(CLIENT_SECRET);
  });
});
