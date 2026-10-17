import { verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorCode, HttpMethod } from '../../src/constants.js';
import { GoogleTokenManager, GOOGLE_PLAY_SCOPE, GOOGLE_TOKEN_URL, signAssertion, tokenRefreshAt } from '../../src/providers/googleplay/index.js';
import { SubscriptionError } from '../../src/errors.js';
import { SUBSCRIPTION_GET_SAMPLE } from './fixtures.js';
import {
  CLIENT_EMAIL,
  HOUR,
  NOW,
  NOW_SECONDS,
  PACKAGE_NAME,
  PRIVATE_KEY_ID,
  P,
  SERVICE_PRIVATE_KEY,
  SERVICE_PRIVATE_PEM,
  SERVICE_PUBLIC_KEY,
  TEST_TOKEN,
  api,
  everythingIn,
  makeProvider,
  route,
  tokenRoute,
} from './helpers.js';

const TOKEN = 'sub-token-1';
const GET_PATH = `${P}/purchases/subscriptionsv2/tokens/${TOKEN}`;
const getRoute = (response: Record<string, unknown> = {}) => route(HttpMethod.Get, GET_PATH, { json: SUBSCRIPTION_GET_SAMPLE, ...response });

function decodeJwt(jwt: string) {
  const [header = '', claims = '', signature = ''] = jwt.split('.');
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>,
    claims: JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<string, unknown>,
    signingInput: `${header}.${claims}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

describe('service account assertion [https://developers.google.com/identity/protocols/oauth2/service-account]', () => {
  it('is an RS256 JWT with the documented header and claims, signed with the service account key', () => {
    const jwt = signAssertion({
      clientEmail: CLIENT_EMAIL,
      privateKey: SERVICE_PRIVATE_KEY,
      privateKeyId: PRIVATE_KEY_ID,
      scope: GOOGLE_PLAY_SCOPE,
      audience: GOOGLE_TOKEN_URL,
      now: NOW,
    });
    const decoded = decodeJwt(jwt);
    expect(decoded.header).toEqual({ alg: 'RS256', typ: 'JWT', kid: PRIVATE_KEY_ID });
    expect(decoded.claims).toEqual({
      iss: CLIENT_EMAIL,
      scope: 'https://www.googleapis.com/auth/androidpublisher',
      aud: 'https://oauth2.googleapis.com/token',
      iat: NOW_SECONDS,
      exp: NOW_SECONDS + 3600,
    });
    // The signature is checked with node:crypto against the public half of the key.
    expect(verify('RSA-SHA256', Buffer.from(decoded.signingInput), SERVICE_PUBLIC_KEY, decoded.signature)).toBe(true);
  });

  it('has no kid when the key id is not configured', () => {
    const jwt = signAssertion({ clientEmail: CLIENT_EMAIL, privateKey: SERVICE_PRIVATE_KEY, scope: GOOGLE_PLAY_SCOPE, audience: GOOGLE_TOKEN_URL, now: NOW });
    expect(decodeJwt(jwt).header).toEqual({ alg: 'RS256', typ: 'JWT' });
  });
});

describe('access token: the request', () => {
  it('posts the documented form to the token endpoint, and the API call carries the token as a Bearer token', async () => {
    const t = makeProvider([getRoute()]);
    await t.provider.getSubscription(TOKEN);

    const [token] = t.tokenCalls();
    expect(token).toMatchObject({ method: 'POST', url: 'https://oauth2.googleapis.com/token' });
    expect(token?.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(Object.keys(token?.form ?? {}).sort()).toEqual(['assertion', 'grant_type']);
    expect(token?.form?.grant_type).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const assertion = decodeJwt(token?.form?.assertion ?? '');
    expect(assertion.claims.iss).toBe(CLIENT_EMAIL);
    expect(assertion.claims.iat).toBe(NOW_SECONDS);
    expect(verify('RSA-SHA256', Buffer.from(assertion.signingInput), SERVICE_PUBLIC_KEY, assertion.signature)).toBe(true);

    const [call] = t.apiCalls();
    expect(call).toMatchObject({ method: 'GET', url: api(GET_PATH) });
    expect(call?.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
  });

  it('accepts a private key whose line breaks are written as \\n (an environment variable)', async () => {
    const t = makeProvider([getRoute()], { config: { privateKey: SERVICE_PRIVATE_PEM.trim().replace(/\n/g, '\\n') } });
    await t.provider.getSubscription(TOKEN);
    expect(t.tokenCalls()).toHaveLength(1);
  });
});

describe('access token: caching', () => {
  it('reuses one token for many calls', async () => {
    const t = makeProvider([getRoute(), getRoute(), getRoute()]);
    await t.provider.getSubscription(TOKEN);
    await t.provider.getSubscription(TOKEN);
    await t.provider.getSubscription(TOKEN);
    expect(t.tokenCalls()).toHaveLength(1);
  });

  it('asks again once the token is within five minutes of its expiry (expires_in 3600)', async () => {
    const t = makeProvider([getRoute(), getRoute(), tokenRoute('ya29.second', 3600), getRoute()]);
    await t.provider.getSubscription(TOKEN);
    t.clock.advanceMs(HOUR - 6 * 60 * 1000);
    await t.provider.getSubscription(TOKEN);
    expect(t.tokenCalls()).toHaveLength(1);
    t.clock.advanceMs(2 * 60 * 1000);
    await t.provider.getSubscription(TOKEN);
    expect(t.tokenCalls()).toHaveLength(2);
    expect(t.apiCalls()[2]?.headers.authorization).toBe('Bearer ya29.second');
  });

  it('shares one in-flight token request between concurrent calls', async () => {
    const t = makeProvider([getRoute(), getRoute()]);
    await Promise.all([t.provider.getSubscription(TOKEN), t.provider.getSubscription(TOKEN)]);
    expect(t.tokenCalls()).toHaveLength(1);
  });

  it('on a 401 drops the token, gets a new one and repeats the call once', async () => {
    const t = makeProvider(
      [route(HttpMethod.Get, GET_PATH, { status: 401, json: { error: { code: 401, message: 'Request had invalid authentication credentials.', status: 'UNAUTHENTICATED' } } }), tokenRoute('ya29.fresh'), getRoute()],
    );
    const subscription = await t.provider.getSubscription(TOKEN);
    expect(subscription.id).toBe(TOKEN);
    expect(t.tokenCalls()).toHaveLength(2);
    expect(t.apiCalls().map((call) => call.headers.authorization)).toEqual([`Bearer ${TEST_TOKEN}`, 'Bearer ya29.fresh']);
  });

  it('gives up with AUTH when the second token is refused too', async () => {
    const refused = route(HttpMethod.Get, GET_PATH, { status: 401, json: { error: { message: 'no' } } });
    const t = makeProvider([refused, tokenRoute('ya29.fresh'), refused]);
    await expect(t.provider.getSubscription(TOKEN)).rejects.toMatchObject({ code: ErrorCode.Auth });
  });
});

describe('access token: failures never leak the key or the assertion', () => {
  it('a refused assertion is AUTH, names the cause, and carries neither the assertion nor the key', async () => {
    const t = makeProvider([], { tokens: 0 });
    const failing = makeProvider([{ method: HttpMethod.Post, url: GOOGLE_TOKEN_URL, status: 400, json: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } }], { tokens: 0 });
    const error = await failing.provider.getSubscription(TOKEN).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error).toMatchObject({ code: ErrorCode.Auth });
    expect((error as Error).message).toContain('invalid_grant');
    const text = everythingIn(error);
    expect(text).not.toContain(failing.tokenCalls()[0]?.form?.assertion ?? 'x');
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(SERVICE_PRIVATE_PEM.split('\n')[1] ?? 'x');
    expect(t.calls).toHaveLength(0);
  });

  it('the provider object does not expose the key to JSON.stringify or a spread', () => {
    const t = makeProvider([], { tokens: 0 });
    expect(JSON.stringify(t.provider)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify({ ...t.provider })).not.toContain(SERVICE_PRIVATE_PEM.split('\n')[1] ?? 'x');
  });
});

describe('tokenRefreshAt and GoogleTokenManager', () => {
  it('refreshes five minutes early, or at half the life of a short-lived token', () => {
    expect(tokenRefreshAt({ access_token: 'x', expires_in: 3600 }, 0)).toBe(3600_000 - 300_000);
    expect(tokenRefreshAt({ access_token: 'x', expires_in: 100 }, 0)).toBe(50_000);
    expect(tokenRefreshAt({ access_token: 'x' }, 0)).toBe(3600_000 - 300_000);
  });

  it('does not cache a token that is already due for renewal', async () => {
    let calls = 0;
    const manager = new GoogleTokenManager(
      () => {
        calls += 1;
        return Promise.resolve({ access_token: `t${calls}`, expires_in: 0 });
      },
      () => NOW,
    );
    expect(await manager.getToken()).toBe('t1');
    expect(await manager.getToken()).toBe('t2');
  });

  it('invalidate drops only the token that was rejected', async () => {
    let calls = 0;
    const manager = new GoogleTokenManager(() => Promise.resolve({ access_token: `t${++calls}`, expires_in: 3600 }), () => NOW);
    expect(await manager.getToken()).toBe('t1');
    manager.invalidate('some-older-token');
    expect(await manager.getToken()).toBe('t1');
    manager.invalidate('t1');
    expect(await manager.getToken()).toBe('t2');
  });
});

describe('the package name is part of every path', () => {
  it('uses the configured package name', async () => {
    const t = makeProvider([getRoute()]);
    await t.provider.getSubscription(TOKEN);
    expect(t.apiCalls()[0]?.url).toContain(`/applications/${PACKAGE_NAME}/`);
    expect(HttpMethod.Get).toBe('GET');
  });
});
