/**
 * Seam 19: a Google Play purchase (the store policy on Android) through the HTTP service, the purchase module and the real
 * Google Play adapter with a scripted Developer API, then the real-time developer notifications Google pushes through
 * Pub/Sub, authenticated the way Google documents (an OIDC token in `Authorization`).
 */
import { describe, expect, it } from 'vitest';
import { CheckoutKind, Environment, HttpMethod, Provider } from '../../src/constants.js';
import type { FetchLike } from '../../src/http.js';
import { createSubscriptions } from '../../src/client.js';
import { GOOGLE_JWKS_URL, googlePlay } from '../../src/providers/googleplay/index.js';
import { EntitlementsSchema, MemoryPurchaseStore, PurchaseSessionSchema, SessionStatus } from '../../src/purchase/index.js';
import { createHandler } from '../../src/server/index.js';
import { SUBSCRIPTION_NEW, withState } from '../googleplay/fixtures.js';
import {
  NOW,
  P,
  PRIVATE_KEY_ID,
  PUSH_AUDIENCE,
  PUSH_EMAIL,
  SERVICE_PRIVATE_PEM,
  jwksBody,
  pushBody,
  pushKeys,
  pushToken,
  PUSH_KID,
  tokenBody,
} from '../googleplay/helpers.js';

const API_KEY = 'integration-api-key-0123456789';
const BASE = 'https://billing.example.com';
const ACCOUNT_ID = '6f1c2d0e-3a41-4d7c-9e3b-0a5c1e2f7b11';
const PURCHASE_TOKEN = 'google-purchase-token-0001';
const CUSTOMER = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210', state: 'Karnataka' };
const FUTURE = '2026-12-22T06:00:00Z';
const PAST = '2026-11-01T06:00:00Z';

const MONTHLY = {
  key: 'pro-monthly',
  kind: 'subscription',
  name: 'Pro monthly',
  amount: 49900,
  interval: { unit: 'month', count: 1 },
  googlePlay: { productId: 'sub_variant_plan01', basePlanId: 'monthly' },
} as const;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The Developer API as a stateful fake: the subscription's state and whether it was acknowledged. */
function developerApi() {
  const state = { subscription: withState({ ...SUBSCRIPTION_NEW, lineItems: [{ ...SUBSCRIPTION_NEW.lineItems[0], expiryTime: FUTURE }] }, 'SUBSCRIPTION_STATE_ACTIVE') as Record<string, unknown>, calls: [] as string[], jwksFetches: 0 };
  const fetch: FetchLike = async (url, init) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    const parsed = new URL(url);
    if (parsed.host === 'oauth2.googleapis.com') return json(tokenBody());
    if (url === GOOGLE_JWKS_URL) {
      state.jwksFetches += 1;
      return new Response(JSON.stringify(jwksBody({ kid: PUSH_KID, key: pushKeys.publicKey })), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600' } });
    }
    const path = parsed.pathname.replace('/androidpublisher/v3', '');
    state.calls.push(`${method} ${path}`);
    if (method === 'GET' && path === `${P}/purchases/subscriptionsv2/tokens/${PURCHASE_TOKEN}`) return json(state.subscription);
    if (method === 'POST' && path === `${P}/purchases/subscriptions/sub_variant_plan01/tokens/${PURCHASE_TOKEN}:acknowledge`) {
      state.subscription = { ...state.subscription, acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED' };
      return json({});
    }
    return json({ error: { code: 404, message: 'not found', status: 'NOT_FOUND' } }, 404);
  };
  return { state, fetch };
}

function setup() {
  const api = developerApi();
  const client = createSubscriptions({
    providers: [
      googlePlay(
        {
          packageName: 'com.example.app',
          clientEmail: 'billing@example-project.iam.gserviceaccount.com',
          privateKey: SERVICE_PRIVATE_PEM,
          privateKeyId: PRIVATE_KEY_ID,
          environment: Environment.Test,
          pushAudience: PUSH_AUDIENCE,
          pushServiceAccountEmail: PUSH_EMAIL,
        },
        { fetch: api.fetch, now: () => NOW, maxRetries: 0, generateId: () => ACCOUNT_ID },
      ),
    ],
    purchases: { catalog: [MONTHLY], store: new MemoryPurchaseStore(), now: () => NOW },
  });
  const handler = createHandler({ client, apiKey: API_KEY });
  const call = (method: string, path: string, options: { json?: unknown; body?: string; headers?: Record<string, string>; auth?: boolean } = {}) =>
    handler(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(options.auth === false ? {} : { authorization: `Bearer ${API_KEY}` }),
          ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
          ...options.headers,
        },
        body: options.json === undefined ? options.body : JSON.stringify(options.json),
      }),
    );
  return { api, client, call };
}

type Harness = ReturnType<typeof setup>;

async function purchase(t: Harness) {
  const started = await t.call(HttpMethod.Post, '/v1/purchases', { json: { platform: 'android', product: MONTHLY.key, customer: CUSTOMER, customerRef: 'cust_1' } });
  expect(started.status).toBe(201);
  const session = PurchaseSessionSchema.parse(await started.json());
  const done = await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, {
    json: { provider: Provider.GooglePlay, result: { purchaseToken: PURCHASE_TOKEN, productId: 'sub_variant_plan01' } },
  });
  return { session, done };
}

/** A Pub/Sub push of a subscription notification, with Google's OIDC token. */
function push(type: number, options: { token?: string | null; messageId?: string } = {}) {
  const notification = {
    version: '1.0',
    packageName: 'com.example.app',
    eventTimeMillis: String(NOW.getTime()),
    subscriptionNotification: { version: '1.0', notificationType: type, purchaseToken: PURCHASE_TOKEN },
  };
  const headers: Record<string, string> = {};
  if (options.token !== null) headers.authorization = `Bearer ${options.token ?? pushToken()}`;
  return { body: pushBody(notification, options.messageId ?? `msg-${type}`), headers };
}

describe('a Google Play purchase', () => {
  it('starts as a Play Billing purchase tied to the order by the obfuscated account id, without user choice billing', async () => {
    const t = setup();
    const started = await t.call(HttpMethod.Post, '/v1/purchases', { json: { platform: 'android', product: MONTHLY.key, customer: CUSTOMER, customerRef: 'cust_1' } });
    const session = PurchaseSessionSchema.parse(await started.json());
    expect(session).toMatchObject({ platform: 'android', policy: 'store' });
    expect(session.options).toEqual([
      expect.objectContaining({
        channel: 'store',
        provider: Provider.GooglePlay,
        handle: ACCOUNT_ID,
        checkout: {
          kind: CheckoutKind.GooglePlayBilling,
          productKind: 'subscription',
          productId: 'sub_variant_plan01',
          basePlanId: 'monthly',
          obfuscatedAccountId: ACCOUNT_ID,
          userChoiceBilling: false,
        },
      }),
    ]);
    expect(t.api.state.calls).toEqual([]);
  });

  it('completes from the purchase token: read from the Developer API, acknowledged once, owned', async () => {
    const t = setup();
    const { session, done } = await purchase(t);
    expect(done.status).toBe(200);
    expect(PurchaseSessionSchema.parse(await done.json())).toMatchObject({ status: SessionStatus.Completed, provider: Provider.GooglePlay, subscriptionId: PURCHASE_TOKEN });
    const get = `GET ${P}/purchases/subscriptionsv2/tokens/${PURCHASE_TOKEN}`;
    const ack = `POST ${P}/purchases/subscriptions/sub_variant_plan01/tokens/${PURCHASE_TOKEN}:acknowledge`;
    expect(t.api.state.calls.filter((call) => call === ack)).toHaveLength(1);
    expect(t.api.state.calls[0]).toBe(get);

    const owned = EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json());
    expect(owned.active).toBe(true);
    expect(owned.items[0]).toMatchObject({ product: MONTHLY.key, provider: Provider.GooglePlay, channel: 'store', platform: 'android', subscriptionId: PURCHASE_TOKEN, status: 'trialing' });

    // Completing again (the app retries) acknowledges nothing a second time and changes nothing.
    await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, { json: { provider: Provider.GooglePlay, result: { purchaseToken: PURCHASE_TOKEN } } });
    expect(t.api.state.calls.filter((call) => call === ack)).toHaveLength(1);
    expect(EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json()).items).toHaveLength(1);
  });

  it('refuses a purchase made for another order, and one for another product', async () => {
    const t = setup();
    t.api.state.subscription = { ...t.api.state.subscription, externalAccountIdentifiers: { obfuscatedExternalAccountId: 'someone-elses-account-id' } };
    const { session, done } = await purchase(t);
    expect(done.status).toBe(401);
    expect(((await done.json()) as { error: { code: string } }).error.code).toBe('SIGNATURE_INVALID');
    expect(PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Get, `/v1/purchases/${session.id}`)).json()).status).toBe(SessionStatus.Open);
    const wrongProduct = await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, {
      json: { provider: Provider.GooglePlay, result: { purchaseToken: PURCHASE_TOKEN, productId: 'other_product' } },
    });
    expect(wrongProduct.status).toBe(401);
  });
});

describe('real-time developer notifications', () => {
  const notify = (t: Harness, type: number, options: { token?: string | null; messageId?: string } = {}) => {
    const { body, headers } = push(type, options);
    // The push route takes no API key: Google authenticates the push with its own token in the same header.
    return t.call(HttpMethod.Post, '/v1/google_play/webhooks', { auth: false, body, headers });
  };
  const owned = async (t: Harness) => EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json());

  it('keeps the entitlement current: a renewal, a grace period, an expiry', async () => {
    const t = setup();
    await purchase(t);

    t.api.state.subscription = withState({ ...t.api.state.subscription, lineItems: [{ ...(t.api.state.subscription.lineItems as Array<Record<string, unknown>>)[0], expiryTime: '2027-01-22T06:00:00Z', offerPhase: { basePrice: {} } }] }, 'SUBSCRIPTION_STATE_ACTIVE');
    const renewed = await notify(t, 2);
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual({ received: 1 });
    expect((await owned(t)).items[0]).toMatchObject({ status: 'active', currentPeriodEnd: '2027-01-22T06:00:00.000Z' });

    t.api.state.subscription = withState(t.api.state.subscription, 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD');
    expect((await notify(t, 6)).status).toBe(200);
    expect((await owned(t)).items[0]?.status).toBe('past_due');
    expect((await owned(t)).active).toBe(true);

    t.api.state.subscription = withState({ ...t.api.state.subscription, lineItems: [{ ...(t.api.state.subscription.lineItems as Array<Record<string, unknown>>)[0], expiryTime: PAST }] }, 'SUBSCRIPTION_STATE_EXPIRED');
    expect((await notify(t, 13)).status).toBe(200);
    const ended = await owned(t);
    expect(ended.active).toBe(false);
    expect(ended.items[0]?.status).toBe('expired');
    // Google reads the notification again on a retry: handling it twice does the same as once.
    expect((await notify(t, 13)).status).toBe(200);
    expect((await owned(t)).items).toHaveLength(1);
  });

  it('rejects, with 401 and no change, a push without the OIDC token, with a token for another audience or another account, or an unsigned one', async () => {
    const t = setup();
    await purchase(t);
    const before = JSON.stringify(await owned(t));
    for (const token of [
      null,
      pushToken({ aud: 'https://attacker.example/hook' }),
      pushToken({ email: 'attacker@example-project.iam.gserviceaccount.com' }),
      pushToken({ email_verified: false }),
      pushToken({}, { key: pushKeys.privateKey, kid: 'unknown-key-id' }),
      'not.a.jwt',
    ]) {
      t.api.state.subscription = withState(t.api.state.subscription, 'SUBSCRIPTION_STATE_EXPIRED');
      const response = await notify(t, 13, { token });
      expect(response.status, String(token).slice(0, 20)).toBe(401);
    }
    expect(JSON.stringify(await owned(t))).toBe(before);
  });

  it('reads the purchase from Google for every notification: the notification itself carries only the token', async () => {
    const t = setup();
    await purchase(t);
    const calls = t.api.state.calls.length;
    const response = await notify(t, 2);
    expect(response.status).toBe(200);
    expect(t.api.state.calls.slice(calls)).toEqual([`GET ${P}/purchases/subscriptionsv2/tokens/${PURCHASE_TOKEN}`]);
  });

  it('answers a Pub/Sub message that is not a notification of this app with 4xx, so it is not redelivered forever', async () => {
    const t = setup();
    const response = await t.call(HttpMethod.Post, '/v1/google_play/webhooks', { auth: false, body: '{"message":{}}', headers: { authorization: `Bearer ${pushToken()}` } });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(response.status).toBeLessThan(500);
  });
});
