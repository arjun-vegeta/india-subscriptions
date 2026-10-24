# Adding a gateway

After this page you will know the contract an adapter must meet, the files to create, how to prove it with the conformance suite, and the method that keeps an adapter honest: read the documentation first, write down the facts, build against documented samples, then verify in the sandbox.

PhonePe and Paytm were added this way. Their pages ([PhonePe](../gateways/phonepe.md), [Paytm](../gateways/paytm.md)) show the result.

## The method

1. **Read every documentation page** of the gateway's subscription product, and its official SDK. Do not work from memory.
2. **Write a fact sheet** before any code: endpoints, authentication, statuses and what each means, the exact signature formulas, limits, timings, retry behaviour, webhook events and payloads, test-mode behaviour. Cite the page for every fact, copy samples verbatim, and write "not stated" where the documentation is silent. Mark your own deductions as inferred. Record where pages contradict each other.
3. **Build against documented samples.** Tests use the documentation's sample payloads, copied verbatim with a comment naming the page, and assert the exact outgoing request and the normalised result.
4. **Verify in the sandbox.** Run the adapter against the gateway's test environment, record what differs from the documentation, fix the adapter, and keep the real payloads as fixtures.

## The adapter contract

An adapter implements `SubscriptionProvider` from `src/provider.ts`, usually by extending `BaseProvider`, which gives it an HTTP client (timeouts, safe retries), a clock, a `send` that maps failures to `SubscriptionError` and validates the response body, and `UNSUPPORTED` defaults for every optional operation. The interface:

| Member | Contract |
|---|---|
| `name`, `capabilities` | The gateway, and an honest [`Capabilities`](../reference/generated/models.md#capabilities) object. Never claim something the adapter throws `UNSUPPORTED` for. |
| `createPlan`, `getPlan` | Or `UNSUPPORTED`. |
| `createSubscription` | Returns the subscription with `checkout` instructions. |
| `getSubscription`, `cancelSubscription`, `pauseSubscription`, `resumeSubscription`, `updateSubscription` | Throw `UNSUPPORTED` for what the gateway cannot do. |
| `listCharges`, `getCharge`, `refundCharge` | Same. |
| `createPayment`, `getPayment`, `verifyPayment`, `refundPayment` | One-time payments. `UNSUPPORTED` by default (`capabilities.oneTimePayments: false`); see below. |
| `notifyCharge`, `createCharge` | For merchant-scheduled gateways only. |
| `verifyCheckout(result)` | Verifies what came back to the browser; throws `SIGNATURE_INVALID` if tampered. |
| `parseWebhook(request)` | Verifies the signature over the raw body and returns normalised events, each with a stable `id`. May return a promise: an adapter may need a network call to verify or to read the object an event names. |

### One-time payments

A gateway with `capabilities.oneTimePayments: true` lists the methods in `oneTimePaymentMethods` and meets this contract (the full text is in the doc comment of `SubscriptionProvider`):

1. `createPayment` returns a `Payment` with `status: created` and a `checkout` instruction. Every input has a place in the gateway's request or is refused with `UNSUPPORTED` or `VALIDATION` before any request: nothing is silently dropped.
2. `Payment.id` is the id that works for `getPayment`, `refundPayment` and webhooks from the moment `createPayment` returns, even when the gateway only creates its own payment id later. Razorpay and Cashfree use the order id, PayU the transaction id, PhonePe the merchant order id, and Paytm the order id.
3. `verifyPayment` verifies what came back to the browser (a signature, or by reading the order from the gateway) and returns `paid` with the `Payment`. A result for a different payment is for the facade to reject: it compares `expectedPaymentId` with `paymentId` and `reference`.
4. `getPayment` is the source of truth. An unknown gateway status is `pending`, never `succeeded` or `failed`.
5. `refundPayment` returns a `Refund` whose `chargeId` and `paymentId` are both the payment's id, and uses the caller's `refundId` as the gateway's idempotency where it has one.
6. Webhook events about a payment are `payment.succeeded` and `payment.failed` with `paymentId` and `payment`, and a refund event carries `paymentId`. The adapter must tell a payment event from a subscription debit.

### App stores

A provider with `capabilities.kind: 'store'` is not a gateway: the product lives in the store and the purchase starts on the device. The router never chooses it. Its `createSubscription` and `createPayment` make no purchase and no network call: they validate `storeProduct`, mint an account token and return `status: created` with that token as `id` and an `apple_storekit` or `google_play_billing` checkout. After the purchase, the device result goes to `verifyCheckout` or `verifyPayment`, which return the store's real id as `subscriptionId` or `paymentId` and the token as `reference` (the same pattern PayU uses: the id only exists after authorisation). The caller passes the token as the expected id, so a purchase made for one order cannot unlock another. Everything the store signs is verified before it is read, with `node:crypto`. Read [Apple App Store](../gateways/app-store.md) and [Google Play](../gateways/google-play.md) for the two adapters.

### If the merchant raises the debits

A gateway with `capabilities.merchantCharges: true` is billed by the scheduler, and its adapter must meet the contract written in the doc comment of `SubscriptionProvider` in `src/provider.ts`. In short:

1. `createSubscription` returns `amount`, `interval`, `startAt` and `scheduling: 'merchant'` (use `SchedulingMode.Merchant`). If the id only exists after authorisation, `verifyCheckout` returns it as `subscriptionId`.
2. `createCharge` with a `chargeId` must be safe to repeat: the scheduler may re-send the same id after an unknown outcome. Use `OUTCOME_UNKNOWN` for anything that may have taken effect.
3. `getCharge` answers `NOT_FOUND` only when the gateway has no trace of the debit.
4. Ids sent to the gateway are at most `MAX_GATEWAY_ID_LENGTH` characters of `GATEWAY_ID_PATTERN`.
5. Webhook events about a debit carry the merchant's debit id in `charge.id` or `charge.reference`; the scheduler then finds the schedule through `SchedulerStore.findScheduleByChargeId`, which matters when the webhook names no subscription (PayU).
6. `merchantPreDebitNotification: true` means the scheduler calls `notifyCharge`; if the gateway ties the notice and the debit to one order (PhonePe), `notifyCharge` returns it as `ChargeNotification.chargeId` and the scheduler debits under that id. `merchantChargeLeadHours` means the gateway notifies and the charge is raised ahead of the due date.

Read the full text in the source: this page only summarises it.

## File layout

```text
src/providers/<gateway>/
  constants.ts   endpoints, headers, statuses, event names, limits (each cites its source)
  schemas.ts     Zod schemas for the config, requests, responses and webhooks
  mapper.ts      pure functions: gateway payload -> unified model, lookup tables with fallbacks
  adapter.ts     the SubscriptionProvider implementation
  index.ts       public exports (factory, class, config schema and type)
```

Then register it:

1. Add the name to `Provider` in `src/constants.ts` (done for PhonePe and Paytm).
2. Export the factory, class and config schema from `src/index.ts`, and the gateway's constants as a namespace (`RazorpayApi`, `CashfreeApi` and `PayUApi` are the pattern; the names collide, so no `export *`).
3. Add its environment variables to `src/service-config.ts` and `.env.example`, and wire it in `src/service.ts`.
4. Run `npm run openapi` and regenerate the Python models.

## Tests

- Adapter tests against documented samples, asserting the exact request (method, URL, headers, body) and the normalised result. No real network calls: use `test/helpers/mock-fetch.ts`.
- Signature tests that compute the expected value independently with `node:crypto`. If the gateway has its own signing scheme (as Paytm's checksum does), add known-answer vectors from an independent implementation.
- The integration tests in `test/integration/`, which wire the real adapters through the real facade, including `10-exports.test.ts` for the public surface.
- **The conformance suite**, for merchant-scheduled gateways. Walk through it as follows.

### Passing the conformance suite

`test/helpers/merchant-adapter-conformance.ts` runs the adapter contract above through the **real** facade and the **real** scheduler against a scripted fake of the gateway. The suite never looks inside the adapter. You supply a `MerchantAdapterHarness` and call `describeMerchantAdapterConformance(harness)` in a test file; `test/integration/conformance.test.ts` does exactly that for every merchant-scheduled adapter.

1. **Write a fake gateway** with the same HTTP surface the adapter calls (see `test/integration/fakes.ts` for the existing ones). It keeps real state: which mandates exist, which notifications and debits it holds, and what it would answer. Drive it by the same `fetch` you give the adapter.
2. **Implement `ConformanceGateway` on it.** The suite drives the fake through a small, gateway-neutral interface:

| Method | What the fake does |
|---|---|
| `authorise(subscription)` | The customer authorises the mandate; returns what the merchant receives: a checkout result, a webhook, or both |
| `chargeRequestIds()`, `notificationIds()` | Every debit and notification request that reached the gateway, repeats included |
| `debitCount()` | How many times the customer would be debited. It must count a duplicate that the fake executes. |
| `holdNextCharge()`, `settle(chargeId, outcome)` | Keep the next debit in flight until the suite settles it as `succeeded` or `failed` |
| `loseNextChargeAnswer()`, `loseNextChargeRequest()` | The debit is executed but the answer is lost, or the request never arrives: `OUTCOME_UNKNOWN` |
| `hideDebitsUntil(iso)` (optional) | The status lookup does not see debits it holds until then (eventual consistency) |
| `debitWebhook(chargeId, outcome)` | The webhook for the end of a debit, signed as the adapter requires |
| `mandateWebhook(event)` (optional) | The customer paused, resumed or cancelled in their app |
| `dictatedChargeIds()` (optional) | For gateways where the notification dictates the debit id |

3. **Write the harness.** Name it, give a start instant and a first-charge instant at least four days apart, and set the flags: `rejectsDuplicateIds` (does the gateway refuse a debit id it already holds? if it executes duplicates, the adapter must protect itself) and `notificationDictatesChargeId`. Its `setup(clock)` builds a fresh adapter and gateway on the suite's clock (`ProviderOptions.now`) and returns a valid `CreateSubscriptionInput` with an inline plan.
4. **Run it.** The suite checks that one debit is raised per cycle, that ids fit `MAX_GATEWAY_ID_LENGTH` and `GATEWAY_ID_PATTERN`, that a lost answer is reconciled with `getCharge` and a lost request is re-sent under the same id with exactly one debit resulting, that a lagging status API never causes a second debit, that `getCharge` answers `NOT_FOUND` only for a debit the gateway has no trace of, that a webhook settles the cycle and a redelivery changes nothing, that a failed debit is retried under a **new** id, that customer pause, resume and cancel reach the schedule, and that cancel stops billing and can be repeated.

```ts fragment reason="the harness is test code that imports vitest, which the documentation does not install"
describeMerchantAdapterConformance({
  name: 'NewGateway',
  startAt: '2026-01-01T05:00:00.000Z',
  firstChargeAt: '2026-01-20T04:30:00.000Z',
  flags: { rejectsDuplicateIds: true, notificationDictatesChargeId: false },
  setup: (clock) => ({ adapter, gateway, createInput }), // built on clock.now and a scripted fake
});
```

## Documentation

1. Add the adapter to `ADAPTER_FACTORIES` in `scripts/generate-docs-reference.ts`, and its mapping tables to `regionContent` there. The capability matrix then includes it, and the tests require its page to carry the generated regions. Add it to the one-time payment and webhook tables of the guides that compare gateways ([One-time payments](../guides/one-time-payments.md#what-differs-per-gateway)).
2. Write the gateway page in `docs/gateways/`, following [Razorpay](../gateways/razorpay.md), [Cashfree](../gateways/cashfree.md), [PayU](../gateways/payu.md), [PhonePe](../gateways/phonepe.md) or [Paytm](../gateways/paytm.md): configuration, capabilities, how trials, upfront amounts and authorisation debits work, payment methods and their limits, status and webhook mappings, and gateway-specific behaviour. Put the generated regions in the page (`<!-- generated:begin capabilities <gateway> -->` and friends; the region names are in the generator).
3. Run `npm run docs:reference` and `npx vitest run test/docs`.

## Checklist

- [ ] Fact sheet written, with sources and contradictions.
- [ ] Adapter, mapper, schemas and constants, with no magic strings.
- [ ] Tests from documented samples; the conformance harness passes if merchant-scheduled.
- [ ] `capabilities` match what the adapter really does.
- [ ] Config, env vars, exports, OpenAPI and Python models updated.
- [ ] Gateway page and generated reference updated.
