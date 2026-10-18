/**
 * Seam 18: an iOS purchase through the HTTP service, the purchase module and the real App Store adapter, with the signed
 * transactions and notifications of `test/appstore/` (a generated certificate chain, Apple's sample payloads) and a scripted
 * App Store Server API. The device's StoreKit result is a signed transaction; the server confirms it with Apple and binds it
 * to the order through the app account token.
 */
import { describe, expect, it } from 'vitest';
import { CheckoutKind, HttpMethod, Provider } from '../../src/constants.js';
import type { FetchLike } from '../../src/http.js';
import { createSubscriptions } from '../../src/client.js';
import { appStore } from '../../src/providers/appstore/index.js';
import { EntitlementsSchema, MemoryPurchaseStore, PurchaseSessionSchema, SessionStatus } from '../../src/purchase/index.js';
import { createHandler } from '../../src/server/index.js';
import {
  APP_ACCOUNT_TOKEN,
  NOW,
  ONE_TIME_ID,
  ORIGINAL_ID,
  SANDBOX_API,
  TRANSACTION_ID,
  config,
  notificationPayload,
  oneTimePayload,
  signJws,
  signedRenewal,
  signedTransaction,
  statusItem,
  statusResponse,
} from '../appstore/helpers.js';

const API_KEY = 'integration-api-key-0123456789';
const BASE = 'https://billing.example.com';
const CUSTOMER = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' };

const MONTHLY = {
  key: 'pro-monthly',
  kind: 'subscription',
  name: 'Pro monthly',
  amount: 49900,
  interval: { unit: 'month', count: 1 },
  appStore: { productId: 'com.example.pro.monthly' },
} as const;
const COINS = { key: 'coins-100', kind: 'one_time', name: '100 coins', amount: 9900, appStore: { productId: 'com.example.coins', consumable: true } } as const;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The App Store Server API: what Apple says about the subscription and about the one-time transaction. */
function appleApi(subscriptionStatus: number) {
  const calls: string[] = [];
  const fetch: FetchLike = async (url) => {
    calls.push(url.replace(SANDBOX_API, ''));
    if (url === `${SANDBOX_API}/inApps/v1/subscriptions/${TRANSACTION_ID}` || url === `${SANDBOX_API}/inApps/v1/subscriptions/${ORIGINAL_ID}`) return json(statusResponse([statusItem(subscriptionStatus)]));
    if (url === `${SANDBOX_API}/inApps/v1/transactions/${ONE_TIME_ID}`) return json({ signedTransactionInfo: signJws(oneTimePayload()) });
    return json({ errorCode: 4040010, errorMessage: 'Transaction id not found.' }, 404);
  };
  return { fetch, calls };
}

function setup(subscriptionStatus = 1) {
  const apple = appleApi(subscriptionStatus);
  const client = createSubscriptions({
    providers: [appStore(config(), { fetch: apple.fetch, now: () => NOW, maxRetries: 0, generateToken: () => APP_ACCOUNT_TOKEN })],
    purchases: { catalog: [MONTHLY, COINS], store: new MemoryPurchaseStore(), now: () => NOW },
  });
  const handler = createHandler({ client, apiKey: API_KEY });
  const call = (method: string, path: string, options: { json?: unknown; body?: string; auth?: boolean } = {}) =>
    handler(
      new Request(`${BASE}${path}`, {
        method,
        headers: {
          ...(options.auth === false ? {} : { authorization: `Bearer ${API_KEY}` }),
          ...(options.json === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: options.json === undefined ? options.body : JSON.stringify(options.json),
      }),
    );
  return { apple, client, call };
}

const START = (product: string, customerRef = 'cust_1') => ({ platform: 'ios', product, customer: CUSTOMER, customerRef });

describe('an iOS subscription', () => {
  it('starts as a StoreKit purchase tied to the order by the app account token, and creates nothing at Apple', async () => {
    const t = setup();
    const started = await t.call(HttpMethod.Post, '/v1/purchases', { json: START(MONTHLY.key) });
    expect(started.status).toBe(201);
    const session = PurchaseSessionSchema.parse(await started.json());
    expect(session).toMatchObject({ platform: 'ios', policy: 'store', status: SessionStatus.Open });
    expect(session.options).toHaveLength(1);
    expect(session.options[0]).toMatchObject({
      channel: 'store',
      provider: Provider.AppStore,
      handle: APP_ACCOUNT_TOKEN,
      checkout: { kind: CheckoutKind.AppleStoreKit, productId: 'com.example.pro.monthly', appAccountToken: APP_ACCOUNT_TOKEN },
    });
    expect(session.options[0]?.hostedUrl).toBeUndefined();
    expect(t.apple.calls).toEqual([]);
  });

  it('completes with the device\'s signed transaction, confirmed with Apple, and writes the entitlement', async () => {
    const t = setup();
    const session = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Post, '/v1/purchases', { json: START(MONTHLY.key) })).json());
    const done = await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, {
      json: { provider: Provider.AppStore, result: { signedTransaction: signedTransaction() } },
    });
    expect(done.status).toBe(200);
    expect(PurchaseSessionSchema.parse(await done.json())).toMatchObject({ status: SessionStatus.Completed, provider: Provider.AppStore, subscriptionId: ORIGINAL_ID });
    // The status came from Apple's Server API, not from what the device sent.
    // The device's transaction is read first; the purchase module then reads the subscription by its store id.
    expect(t.apple.calls).toEqual([`/inApps/v1/subscriptions/${TRANSACTION_ID}`, `/inApps/v1/subscriptions/${ORIGINAL_ID}`]);

    const owned = EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json());
    expect(owned.active).toBe(true);
    expect(owned.items[0]).toMatchObject({ product: MONTHLY.key, kind: 'subscription', provider: Provider.AppStore, channel: 'store', platform: 'ios', subscriptionId: ORIGINAL_ID, status: 'active' });
  });

  it('refuses a transaction of another order (another app account token), a forged one and a garbled one, leaving the session open', async () => {
    const t = setup();
    const session = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Post, '/v1/purchases', { json: START(MONTHLY.key) })).json());
    for (const signed of [
      signedTransaction({ appAccountToken: '11111111-1111-4111-8111-111111111111' }),
      signedTransaction({}, { chain: ['other-leaf', 'other-intermediate', 'other-root'] }),
      'garbage',
    ]) {
      const response = await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, { json: { provider: Provider.AppStore, result: { signedTransaction: signed } } });
      expect(response.status, signed.slice(0, 12)).toBe(401);
      expect(((await response.json()) as { error: { code: string } }).error.code).toBe('SIGNATURE_INVALID');
    }
    const after = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Get, `/v1/purchases/${session.id}`)).json());
    expect(after.status).toBe(SessionStatus.Open);
    expect(EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json()).items).toEqual([]);
  });

  it('is not completed when Apple says the subscription is not active', async () => {
    const t = setup(2);
    const session = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Post, '/v1/purchases', { json: START(MONTHLY.key) })).json());
    const done = await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, {
      json: { provider: Provider.AppStore, result: { signedTransaction: signedTransaction() } },
    });
    expect(PurchaseSessionSchema.parse(await done.json()).status).toBe(SessionStatus.Failed);
  });

  it('is never offered on another channel: the same customer cannot buy it again, on the web or on a phone', async () => {
    const t = setup();
    const session = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Post, '/v1/purchases', { json: START(MONTHLY.key) })).json());
    await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, { json: { provider: Provider.AppStore, result: { signedTransaction: signedTransaction() } } });
    const again = await t.call(HttpMethod.Post, '/v1/purchases', { json: { ...START(MONTHLY.key), reference: 'second-try' } });
    expect(again.status).toBe(409);
    // The web has no gateway in this deployment, which is its own, different refusal.
    const web = await t.call(HttpMethod.Post, '/v1/purchases', { json: { ...START(MONTHLY.key), platform: 'web' } });
    expect([409, 500]).toContain(web.status);
  });

  it('keeps the entitlement current from App Store Server Notifications: a renewal, a failed renewal, an expiry', async () => {
    const t = setup();
    const session = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Post, '/v1/purchases', { json: START(MONTHLY.key) })).json());
    await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, { json: { provider: Provider.AppStore, result: { signedTransaction: signedTransaction() } } });

    const notify = async (payload: Record<string, unknown>, data: Record<string, unknown> = {}) => {
      const signedPayload = signJws(notificationPayload(payload, data));
      // The route takes no API key: Apple signs the payload (JWS, certificate chain), and Apple sends no other header.
      return t.call(HttpMethod.Post, '/v1/app_store/webhooks', { auth: false, body: JSON.stringify({ signedPayload }) });
    };
    const status = async () => EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json());

    const renewed = await notify({ notificationType: 'DID_RENEW', notificationUUID: '11111111-1111-4111-8111-111111111111' }, { signedTransactionInfo: signedTransaction({ expiresDate: NOW.getTime() + 50 * 86_400_000 }) });
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toEqual({ received: 1 });
    const afterRenewal = await status();
    expect(afterRenewal.active).toBe(true);
    expect(afterRenewal.items[0]?.currentPeriodEnd).toBe(new Date(NOW.getTime() + 50 * 86_400_000).toISOString());

    const failed = await notify({ notificationType: 'DID_FAIL_TO_RENEW', notificationUUID: '22222222-2222-4222-8222-222222222222' }, { signedRenewalInfo: signedRenewal({ isInBillingRetryPeriod: true }), status: 3 });
    expect(failed.status).toBe(200);
    expect((await status()).items[0]?.status).toBe('past_due');

    const expired = await notify({ notificationType: 'EXPIRED', subtype: 'VOLUNTARY', notificationUUID: '33333333-3333-4333-8333-333333333333' }, { signedRenewalInfo: signedRenewal({ expirationIntent: 1 }), status: 2 });
    expect(expired.status).toBe(200);
    const ended = await status();
    expect(ended.active).toBe(false);

    // A notification that is not signed by Apple's chain answers 401 and changes nothing.
    const forged = await t.call(HttpMethod.Post, '/v1/app_store/webhooks', {
      auth: false,
      body: JSON.stringify({ signedPayload: signJws(notificationPayload({ notificationType: 'DID_RENEW' }, {}), { chain: ['other-leaf', 'other-intermediate', 'other-root'] }) }),
    });
    expect(forged.status).toBe(401);
  });
});

describe('an iOS one-time purchase', () => {
  it('goes through the same session: a consumable is completed from the signed transaction and owned until refunded', async () => {
    const t = setup();
    const session = PurchaseSessionSchema.parse(await (await t.call(HttpMethod.Post, '/v1/purchases', { json: START(COINS.key) })).json());
    expect(session.options[0]?.checkout).toMatchObject({ kind: CheckoutKind.AppleStoreKit, productId: 'com.example.coins' });

    const done = await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, {
      json: { provider: Provider.AppStore, result: { signedTransaction: signJws(oneTimePayload()) } },
    });
    expect(PurchaseSessionSchema.parse(await done.json())).toMatchObject({ status: SessionStatus.Completed, paymentId: ONE_TIME_ID });
    expect(t.apple.calls).toEqual([`/inApps/v1/transactions/${ONE_TIME_ID}`]);
    const owned = EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json());
    expect(owned.items[0]).toMatchObject({ product: COINS.key, kind: 'one_time', channel: 'store', platform: 'ios', paymentId: ONE_TIME_ID, status: 'active' });
    // A second completion of the same session changes nothing.
    await t.call(HttpMethod.Post, `/v1/purchases/${session.id}/complete`, { json: { provider: Provider.AppStore, result: { signedTransaction: signJws(oneTimePayload()) } } });
    expect(EntitlementsSchema.parse(await (await t.call(HttpMethod.Get, '/v1/entitlements/cust_1')).json()).items).toHaveLength(1);
  });

  it('the explicit-provider payment API is the same adapter: create makes no purchase, it mints the token', async () => {
    const t = setup();
    const payment = await t.client.payments.create(Provider.AppStore, { amount: 9900, customer: CUSTOMER, storeProduct: { productId: 'com.example.coins' } });
    expect(payment).toMatchObject({ id: APP_ACCOUNT_TOKEN, status: 'created', checkout: { kind: CheckoutKind.AppleStoreKit, appAccountToken: APP_ACCOUNT_TOKEN } });
    expect(t.apple.calls).toEqual([]);
  });
});
