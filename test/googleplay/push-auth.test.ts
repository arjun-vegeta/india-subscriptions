import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, HttpMethod } from '../../src/constants.js';
import { GOOGLE_JWKS_URL } from '../../src/providers/googleplay/index.js';
import { RTDN_TEST } from './fixtures.js';
import {
  HOUR,
  NOW_SECONDS,
  PUSH_AUDIENCE,
  PUSH_EMAIL,
  PUSH_KID,
  authenticatedConfig,
  b64url,
  jwksRoute,
  makeProvider,
  pushBody,
  pushRequest,
  pushToken,
} from './helpers.js';

const config = { ...authenticatedConfig, packageName: 'com.some.thing' };
const setup = (extraRoutes = [jwksRoute()]) => makeProvider(extraRoutes, { config, tokens: 0 });
const reject = (error: unknown) => expect(error).toMatchObject({ code: ErrorCode.SignatureInvalid });

describe('push token verification [https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions]', () => {
  it('accepts a token signed by a published key with the configured audience and e-mail, and parses the notification', async () => {
    const t = setup();
    const events = await t.provider.parseWebhook(pushRequest(RTDN_TEST));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: EventType.Unknown, providerEventType: 'TEST_NOTIFICATION' });
    // Keys come from the discovery document's jwks_uri, with no credentials.
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]).toMatchObject({ method: 'GET', url: 'https://www.googleapis.com/oauth2/v3/certs' });
    expect(t.calls[0]?.headers.authorization).toBeUndefined();
  });

  it('accepts the Bearer scheme in any case and an audience list that contains ours', async () => {
    const t = setup();
    const request = pushRequest(RTDN_TEST);
    request.headers = { Authorization: `bearer ${pushToken({ aud: ['other', PUSH_AUDIENCE] })}` };
    await expect(t.provider.parseWebhook(request)).resolves.toHaveLength(1);
  });

  it('accepts the other issuer spelling Google uses, and email_verified as the string "true"', async () => {
    const t = setup();
    await expect(t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ iss: 'accounts.google.com', email_verified: 'true' }) }))).resolves.toHaveLength(1);
  });

  it('rejects a wrong audience', async () => {
    const t = setup();
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ aud: 'https://attacker.example' }) })).catch((e: unknown) => e));
  });

  it('rejects a wrong e-mail (another service account of the same project)', async () => {
    const t = setup();
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ email: 'someone-else@example-project.iam.gserviceaccount.com' }) })).catch((e: unknown) => e));
  });

  it('rejects an e-mail that is not verified', async () => {
    const t = setup();
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ email_verified: false }) })).catch((e: unknown) => e));
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ email_verified: undefined }) })).catch((e: unknown) => e));
  });

  it('rejects a token signed with a key Google does not publish (bad signature)', async () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const t = setup();
    const error = await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({}, { key: other.privateKey }) })).catch((e: unknown) => e);
    reject(error);
    expect((error as Error).message).toMatch(/signature does not match/);
  });

  it('rejects a token whose claims were changed after signing', async () => {
    const [header, , signature] = pushToken().split('.');
    const forged = `${header}.${b64url(JSON.stringify({ aud: PUSH_AUDIENCE, email: PUSH_EMAIL, email_verified: true, exp: NOW_SECONDS + 99999, iss: 'https://accounts.google.com' }))}.${signature}`;
    const t = setup();
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: forged })).catch((e: unknown) => e));
  });

  it('rejects an expired token, with a minute of skew allowed', async () => {
    const t = setup();
    const error = await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ exp: NOW_SECONDS - 120 }) })).catch((e: unknown) => e);
    reject(error);
    expect((error as Error).message).toMatch(/expired/);
    await expect(t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ exp: NOW_SECONDS - 30 }) }))).resolves.toHaveLength(1);
  });

  it('a token ages with the clock: valid now, expired later', async () => {
    const t = makeProvider([jwksRoute()], { config, tokens: 0 });
    const token = pushToken({ exp: NOW_SECONDS + 3000 });
    await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token }));
    t.clock.advanceMs(HOUR);
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token })).catch((e: unknown) => e));
  });

  it('rejects a token issued in the future', async () => {
    const t = setup();
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ iat: NOW_SECONDS + 3600 }) })).catch((e: unknown) => e));
  });

  it('rejects another issuer', async () => {
    const t = setup();
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ iss: 'https://evil.example' }) })).catch((e: unknown) => e));
  });

  it('rejects alg none and HMAC tokens: the algorithm is RS256 whatever the token says', async () => {
    const t = setup();
    const none = `${b64url(JSON.stringify({ alg: 'none', kid: PUSH_KID }))}.${b64url(JSON.stringify({ aud: PUSH_AUDIENCE, email: PUSH_EMAIL, email_verified: true, exp: NOW_SECONDS + 100, iss: 'https://accounts.google.com' }))}.`;
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: none })).catch((e: unknown) => e));
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({}, { header: { alg: 'HS256' } }) })).catch((e: unknown) => e));
    expect(t.calls).toHaveLength(0);
  });

  it.each([
    ['no Authorization header', null],
    ['a header that is not Bearer', 'Basic abc'],
    ['an empty bearer token', 'Bearer '],
    ['a token that is not a JWT', 'Bearer abc.def'],
  ])('rejects %s', async (_what, header) => {
    const t = setup();
    const request = pushRequest(RTDN_TEST, { token: null });
    if (header !== null) request.headers = { authorization: header };
    reject(await t.provider.parseWebhook(request).catch((e: unknown) => e));
    expect(t.calls).toHaveLength(0);
  });

  it('rejects a token with a key id Google does not publish, after one refetch', async () => {
    const t = setup([jwksRoute(), jwksRoute()]);
    const error = await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({}, { kid: 'unknown-kid' }) })).catch((e: unknown) => e);
    reject(error);
    expect((error as Error).message).toMatch(/does not publish/);
    // The first fetch loaded the keys; a second look for the same unknown id within a minute is not made.
    expect(t.calls).toHaveLength(1);
  });

  it('rejects a token on every request, not only the first', async () => {
    const t = setup();
    await t.provider.parseWebhook(pushRequest(RTDN_TEST));
    reject(await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ aud: 'x' }) })).catch((e: unknown) => e));
    await expect(t.provider.parseWebhook(pushRequest(RTDN_TEST))).resolves.toHaveLength(1);
  });

  it('nothing is parsed from a body whose token fails: no purchase is read', async () => {
    const t = setup();
    reject(await t.provider.parseWebhook({ rawBody: pushBody({ ...RTDN_TEST }), headers: {} }).catch((e: unknown) => e));
    expect(t.calls).toHaveLength(0);
  });
});

describe('Google\'s signing keys are fetched once and cached [OIDC page: "cache them using the cache directives"]', () => {
  it('serves many pushes from one fetch within max-age', async () => {
    const t = setup();
    for (let i = 0; i < 5; i += 1) await t.provider.parseWebhook(pushRequest(RTDN_TEST));
    expect(t.calls.filter((call) => call.url === GOOGLE_JWKS_URL)).toHaveLength(1);
  });

  it('fetches again once max-age has passed', async () => {
    const t = setup([jwksRoute(undefined, { 'cache-control': 'public, max-age=300' }), jwksRoute(undefined, { 'cache-control': 'public, max-age=300' })]);
    await t.provider.parseWebhook(pushRequest(RTDN_TEST));
    t.clock.advanceMs(299_000);
    await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ exp: NOW_SECONDS + 3000 }) }));
    expect(t.calls).toHaveLength(1);
    t.clock.advanceMs(2_000);
    await t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ exp: NOW_SECONDS + 3000 }) }));
    expect(t.calls).toHaveLength(2);
  });

  it('never caches for less than a minute, whatever max-age says', async () => {
    const t = setup([jwksRoute(undefined, { 'cache-control': 'max-age=0' })]);
    await t.provider.parseWebhook(pushRequest(RTDN_TEST));
    t.clock.advanceMs(30_000);
    await t.provider.parseWebhook(pushRequest(RTDN_TEST));
    expect(t.calls).toHaveLength(1);
  });

  it('an unknown key id looks again once Google may have rotated its keys', async () => {
    const rotated = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const t = setup([jwksRoute(), jwksRoute([{ kid: 'rotated-kid', key: rotated.publicKey }])]);
    await t.provider.parseWebhook(pushRequest(RTDN_TEST));
    t.clock.advanceMs(61_000);
    await expect(
      t.provider.parseWebhook(pushRequest(RTDN_TEST, { token: pushToken({ exp: NOW_SECONDS + 3000 }, { key: rotated.privateKey, kid: 'rotated-kid' }) })),
    ).resolves.toHaveLength(1);
    expect(t.calls).toHaveLength(2);
  });

  it('a failure to fetch the keys is not a rejection of the token: its own error, so Pub/Sub retries', async () => {
    const t = setup([{ method: HttpMethod.Get, url: GOOGLE_JWKS_URL, status: 503, json: {} }]);
    const error = await t.provider.parseWebhook(pushRequest(RTDN_TEST)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: ErrorCode.ProviderUnavailable });
  });

  it('keys of another type are skipped, the others still verify', async () => {
    const route = jwksRoute();
    (route.json as { keys: unknown[] }).keys.unshift({ kty: 'EC', kid: 'ec-key', crv: 'P-256', x: 'a', y: 'b' });
    const t = setup([route]);
    await expect(t.provider.parseWebhook(pushRequest(RTDN_TEST))).resolves.toHaveLength(1);
  });
});
