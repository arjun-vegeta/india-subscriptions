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
import { IntervalUnit, Provider, createSubscriptions, razorpay } from 'india-subscriptions';

const NOW = new Date('2026-11-17T06:30:00.000Z');

const plan = {
  id: 'plan_00000000000001',
  entity: 'plan',
  interval: 1,
  period: 'monthly',
  item: { id: 'item_1', active: true, name: 'Pro monthly', amount: 49900, unit_amount: 49900, currency: 'INR', type: 'plan', created_at: 1, updated_at: 1 },
  notes: {},
  created_at: 1,
};
const subscription = {
  id: 'sub_00000000000001',
  entity: 'subscription',
  plan_id: plan.id,
  status: 'created',
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
import { EventType, Provider, createSubscriptions, razorpay } from 'india-subscriptions';

const WEBHOOK_SECRET = 'test_webhook_secret';

export function simulateCharged(subscriptionBody: object) {
  const rawBody = JSON.stringify({
    entity: 'event',
    event: 'subscription.charged',
    contains: ['subscription'],
    payload: { subscription: { entity: subscriptionBody } },
    created_at: 1_800_000_000,
  });
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(rawBody).digest('hex');

  const subs = createSubscriptions({
    providers: [razorpay({ keyId: 'rzp_test_key', keySecret: 'secret', webhookSecret: WEBHOOK_SECRET })],
  });
  const [event] = subs.webhooks.parse(Provider.Razorpay, {
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
| Cashfree | Sandbox keys. Use an **on-demand** plan: raise a charge, then call Cashfree's Simulate Payment API. Periodic charges only run on their real dates. | None yet. |
| PayU | The public test merchant PayU prints in its documentation, or your own test account. | `PAYU_TEST_KEY=... PAYU_TEST_SALT=... npx tsx scripts/payu-test-env-check.mts`. It refuses to run unless the environment is test, talks to PayU's test hosts only, never prints the salt, and (with Playwright installed) runs the browser flow: one ₹2 consent and one ₹1 test debit. PayU's test environment never captures a card debit, so a successful recurring debit cannot be observed there. |

Run the scripts from a checkout of this repository. They need the repository's dev dependencies, and they print a pass or fail table.

## 4. Testing the scheduler

Give the facade a `MemorySchedulerStore` and a controllable `now`, create a subscription, authorise it (`verifyCheckout` or a webhook), then move the clock past the notice time and call `subs.tick()`. The repository's scheduler tests do exactly this against scripted gateway responses. Assert on `TickResult` (`notified`, `charged`, `succeeded`, `failed`, `halted`) and on the `onEvent` events.

## 5. What to test in your own code

- Your webhook route returns 401 for a bad signature and 2xx only after the event is stored.
- Processing the same event twice changes nothing.
- A `subscription.halted` event suspends access, and a later `subscription.charged` restores it.
- Your verify route rejects a result for a different subscription than the one stored.
- A request that fails with `OUTCOME_UNKNOWN` is not retried blindly.
