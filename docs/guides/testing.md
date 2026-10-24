# Testing your integration

After this page you will be able to test your own code against the library without calling a gateway, simulate a webhook with a valid signature, control the clock, and run the repeatable checks against gateway test environments.

There are three levels, and you want all of them before going live.

| Level | What it proves | Needs |
|---|---|---|
| Unit tests with a fake `fetch` | Your code calls the library correctly and handles what comes back | Nothing |
| Gateway test mode or sandbox | The gateway really accepts what the adapter sends | Test keys |
| The [going-live checklist](./going-live.md) | The adapter's assumptions hold | Test keys and time |

## 1. A fake `fetch`

Every adapter takes an options object as its second argument with a `fetch` of your own. Give it a function that returns what the gateway would, and nothing leaves the process. The library's own tests do this with a scripted fetch (`test/helpers/mock-fetch.ts` in the repository).

```ts
import { Currency, IntervalUnit, Provider, RazorpayApi, createSubscriptions, razorpay } from 'india-subscriptions';

const NOW = new Date('2026-11-17T06:30:00.000Z');

const plan = {
  id: 'plan_00000000000001',
  entity: 'plan',
  interval: 1,
  period: 'monthly',
  item: { id: 'item_1', active: true, name: 'Pro monthly', amount: 49900, unit_amount: 49900, currency: Currency.INR, type: 'plan', created_at: 1, updated_at: 1 },
  notes: {},
  created_at: 1,
};
const subscription = {
  id: 'sub_00000000000001',
  entity: 'subscription',
  plan_id: plan.id,
  status: RazorpayApi.RazorpaySubscriptionStatus.Created,
  quantity: 1,
  notes: {},
  start_at: 1_800_000_000,
  total_count: 120,
  paid_count: 0,
  short_url: 'https://rzp.io/i/test',
  created_at: 1,
};

/** Answers by URL, like the real gateway would. */
const fakeFetch = async (url: string): Promise<Response> => {
  const body = url.endsWith('/v1/plans') ? plan : subscription;
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
};

export async function trialSubscription() {
  const subs = createSubscriptions({
    providers: [razorpay({ keyId: 'rzp_test_key', keySecret: 'secret' }, { fetch: fakeFetch, now: () => NOW })],
  });
  return subs.create(Provider.Razorpay, {
    plan: { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } },
    customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
    trial: { days: 14 },
  });
}
```

`now` is the clock the adapter uses (a trial of 14 days is exactly 14 days after `NOW`). The billing scheduler takes the same `now` option, so you can move time forward in a test and call `tick()`.

## 2. Simulating a webhook

A webhook is a signed HTTP request. Sign your fake body the way the gateway does, and your route (or `subs.webhooks.parse`) sees a genuine event:

```ts
import { createHmac } from 'node:crypto';
import { EventType, Provider, RazorpayApi, createSubscriptions, razorpay } from 'india-subscriptions';

const WEBHOOK_SECRET = 'test_webhook_secret';

export async function simulateCharged(subscriptionBody: object) {
  const rawBody = JSON.stringify({
    entity: 'event',
    event: RazorpayApi.RazorpayWebhookEvent.Charged,
    contains: ['subscription'],
    payload: { subscription: { entity: subscriptionBody } },
    created_at: 1_800_000_000,
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

  const subs = createSubscriptions({
    providers: [razorpay({ keyId: 'rzp_test_key', keySecret: 'secret', webhookSecret: WEBHOOK_SECRET })],
  });
  const [event] = await subs.webhooks.parse(Provider.Razorpay, {
    rawBody,
    headers: { 'x-razorpay-signature': signature, 'x-razorpay-event-id': 'evt_1' },
  });
  return event?.type === EventType.SubscriptionCharged ? event.id : undefined;
}
```

Also test the unhappy path: change one byte of the body and expect `SIGNATURE_INVALID`.

## 3. The gateway test environments

Use each gateway's test mode while you build.

| Gateway | How to test | Repeatable script |
|---|---|---|
| Razorpay | Test-mode keys. Use the Dashboard's **Charge this now** to simulate charges and failures. A test subscription can be updated only before any test charge beyond the authorisation. | `RAZORPAY_KEY_ID=rzp_test_xxx RAZORPAY_KEY_SECRET=xxx npx tsx scripts/razorpay-test-mode-check.mts`. API only (no checkout). Test-mode keys only; it leaves one plan and one cancelled subscription per run, because plans cannot be deleted. |
| PhonePe | UAT sandbox with PhonePe's test app and templates. The template must be set before you call the APIs. | None yet. |
| Paytm | Staging merchant id and key (subscriptions must be enabled on it). Test data appears in the Dashboard. | None yet. |
| Cashfree | Sandbox keys. Use an **on-demand** plan: raise a charge, then call Cashfree's Simulate Payment API. Periodic charges only run on their real dates. | None yet. |
| PayU | The public test merchant PayU prints in its documentation, or your own test account. | `PAYU_TEST_KEY=... PAYU_TEST_SALT=... npx tsx scripts/payu-test-env-check.mts`. It refuses to run unless the environment is test, talks to PayU's test hosts only, never prints the salt, and (with Playwright installed) runs the browser flow: one ₹2 consent and one ₹1 test debit. PayU's test environment never captures a card debit, so a successful recurring debit cannot be observed there. |
| Apple App Store | `Environment.Test` with a Sandbox Apple Account on a device, and the sandbox notification URL. Steps: [Setting up the App Store](./setting-up-app-store.md#test-with-a-sandbox-account). | None. |
| Google Play | License testers in Play Console, with `Environment.Test` so that test purchases are accepted (with `Environment.Live` they are refused). Steps: [Setting up Google Play](./setting-up-google-play.md#6-test-with-license-testers). | None. |

Run the scripts from a checkout of this repository. They need the repository's dev dependencies, and they print a pass or fail table.

## 4. Testing the scheduler

Give the facade a `MemorySchedulerStore` and a controllable `now`, create a subscription, authorise it (`verifyCheckout` or a webhook), then move the clock past the notice time and call `subs.tick()`. The repository's scheduler tests do exactly this against scripted gateway responses. Assert on `TickResult` (`notified`, `charged`, `succeeded`, `failed`, `halted`) and on the `onEvent` events.

## 5. Testing payments, routing and purchases

**One-time payments** are tested like subscriptions: give the adapter a `fetch` that answers what the gateway would, and call `subs.payments.create`, `verify` and `get`. A result's signature is computed the way the gateway's documentation says, so you can sign a genuine one and alter a byte for the forged one. Always include the case that matters most: a genuine result for another payment, verified with `expectedPaymentId`, must fail with `SIGNATURE_INVALID`.

**The router** is deterministic: the same capabilities, statistics, strategy and clock give the same decision. Feed it outcomes with `record` and assert on the decision, with no gateway call at all:

```ts title="routing-test.ts"
import { Environment, ProductKind, Provider, RouteOutcomeKind, RouteOutcomeResult, cashfree, createSubscriptions, razorpay } from 'india-subscriptions';

export async function decideAfterAnOutage() {
  const subs = createSubscriptions({
    providers: [
      razorpay({ keyId: 'rzp_test_key', keySecret: 'secret' }),
      cashfree({ clientId: 'id', clientSecret: 'secret', environment: Environment.Test }),
    ],
    routing: { strategy: { priority: [Provider.Razorpay, Provider.Cashfree] } },
  });
  // Five consecutive "unavailable" results open Razorpay's circuit.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await subs.router.record({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Request, result: RouteOutcomeResult.Unavailable });
  }
  const decision = await subs.router.route({ kind: ProductKind.OneTime, amount: 49900 });
  return decision.provider; // Cashfree
}
```

Both the router and `Purchases` take a `now` clock, so you can move time past the circuit breaker's cooldown, or a session's 24 hour expiry, without waiting.

**Purchase sessions** need no network to start on a store: starting a purchase on iOS creates the app account token and returns the App Store option without calling Apple. That makes the policy and the catalog testable on their own:

```ts title="purchases-test.ts"
import { generateKeyPairSync } from 'node:crypto';
import { Environment, IntervalUnit, MemoryPurchaseStore, Platform, ProductKind, appStore, createSubscriptions } from 'india-subscriptions';

export async function startOnAnIphone() {
  // Any P-256 key will do: nothing is signed or sent when a store purchase starts.
  const privateKey = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const subs = createSubscriptions({
    providers: [appStore({ bundleId: 'com.example.app', issuerId: 'test-issuer', keyId: 'TESTKEYID', privateKey, environment: Environment.Test })],
    purchases: {
      catalog: [
        {
          key: 'pro-monthly',
          kind: ProductKind.Subscription,
          name: 'Pro monthly',
          amount: 49900,
          interval: { unit: IntervalUnit.Month, count: 1 },
          appStore: { productId: 'com.example.app.pro.monthly' },
        },
      ],
      store: new MemoryPurchaseStore(),
    },
  });
  if (!subs.purchases) throw new Error('purchases are not configured');
  const session = await subs.purchases.start({
    platform: Platform.Ios,
    product: 'pro-monthly',
    customer: { email: 'asha@example.com' },
    customerRef: 'user_1',
  });
  return session.options[0]?.checkout.kind; // apple_storekit
}
```

To test a whole purchase (verification, the entitlement, a webhook, the report queue), script the provider's answers with a `fetch` as above and pass a `MemoryPurchaseStore` and a controllable `now`. `purchases.flush()` returns what it did with every queued report, and `FlushResult.overdue` is what to assert on for the 24 hour rule. On a device, use the App Store's sandbox and Play's license testers.

## 6. What to test in your own code

- Your webhook route returns 401 for a bad signature and 2xx only after the event is stored.
- Processing the same event twice changes nothing.
- A `subscription.halted` event suspends access, and a later `subscription.charged` restores it.
- Your verify route rejects a result for a different subscription than the one stored.
- A request that fails with `OUTCOME_UNKNOWN` is not retried blindly.
- Your payment verify route rejects a result for a different payment than the one stored (`expectedPaymentId`).
- A second purchase of a product the customer owns is refused with `CONFLICT`, and your app reads access from `entitlements`, not from its own state.
- Your mobile backend refuses a session or a customer that is not the signed-in user's, and never returns the service's API key to the app.
