import { describe, expect, it } from 'vitest';
import { Subscriptions } from '../../src/client.js';
import { CheckoutKind, IntervalUnit, ProductKind } from '../../src/constants.js';
import { MemoryRoutingStatsStore, Router } from '../../src/routing/index.js';
import { MemoryPurchaseStore, Purchases, SessionStatus, type PurchaseHost } from '../../src/purchase/index.js';
import { StubProvider } from '../client/helpers.js';
import { CUSTOMER, CUSTOMER_REF, ErrorCode, Platform, rejection } from './helpers.js';

describe('Purchases over the real facade', () => {
  it('the facade satisfies PurchaseHost, and its checks bind a result to the order the session created', async () => {
    const stub = new StubProvider();
    stub.results.created.checkout = { kind: CheckoutKind.Redirect, url: 'https://gateway.example.test/authorize' };
    stub.results.verification.subscriptionId = stub.results.created.id;
    const subs = new Subscriptions({ providers: [stub] });
    const host: PurchaseHost = subs;
    const router = new Router({ capabilities: () => subs.providers.map((name) => subs.capabilities(name)), stats: new MemoryRoutingStatsStore() });
    const purchases = new Purchases({
      host,
      router,
      store: new MemoryPurchaseStore(),
      catalog: [
        {
          key: 'pro',
          kind: ProductKind.Subscription,
          name: 'Pro',
          amount: 59_000,
          interval: { unit: IntervalUnit.Month, count: 1 },
        },
      ],
    });

    const session = await purchases.start({ platform: Platform.Web, product: 'pro', customer: CUSTOMER, customerRef: CUSTOMER_REF });
    expect(session.options[0]).toMatchObject({ provider: stub.name, handle: 'sub_created' });

    // The stub's checkout result is for 'sub_created'; a session whose handle differs is refused by the facade.
    stub.results.verification.subscriptionId = 'sub_somebody_else';
    stub.results.verification.reference = 'somebody-else';
    const refused = await rejection(purchases.complete(session.id, { provider: stub.name, result: {} }));
    expect(refused.code).toBe(ErrorCode.SignatureInvalid);
    expect((await purchases.get(session.id)).status).toBe(SessionStatus.Open);

    stub.results.verification.subscriptionId = 'sub_created';
    const done = await purchases.complete(session.id, { provider: stub.name, result: {} });
    expect(done.status).toBe(SessionStatus.Completed);
    expect((await purchases.entitlements(CUSTOMER_REF)).active).toBe(true);
  });
});
