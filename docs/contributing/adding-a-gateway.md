# Adding a gateway

After this page you will know the contract an adapter must meet, the files to create, how to prove it with the conformance suite, and the method that keeps an adapter honest: read the documentation first, write down the facts, build against documented samples, then verify in the sandbox.

PhonePe and Paytm are being added this way. Their pages ([PhonePe](../gateways/phonepe.md), [Paytm](../gateways/paytm.md)) are stubs until the adapters land.

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
| `notifyCharge`, `createCharge` | For merchant-scheduled gateways only. |
| `verifyCheckout(result)` | Verifies what came back to the browser; throws `SIGNATURE_INVALID` if tampered. |
| `parseWebhook(request)` | Verifies the signature over the raw body and returns normalised events, each with a stable `id`. |

### If the merchant raises the debits

A gateway with `capabilities.merchantCharges: true` is billed by the scheduler, and its adapter must meet the contract written in the doc comment of `SubscriptionProvider` in `src/provider.ts`. In short:

1. `createSubscription` returns `amount`, `interval`, `startAt` and `scheduling: 'merchant'` (use `SchedulingMode.Merchant`). If the id only exists after authorisation, `verifyCheckout` returns it as `subscriptionId`.
2. `createCharge` with a `chargeId` must be safe to repeat: the scheduler may re-send the same id after an unknown outcome. Use `OUTCOME_UNKNOWN` for anything that may have taken effect.
3. `getCharge` answers `NOT_FOUND` only when the gateway has no trace of the debit.
4. Ids sent to the gateway are at most `MAX_GATEWAY_ID_LENGTH` characters of `GATEWAY_ID_PATTERN`.
5. Webhook events about a debit carry the merchant's debit id in `charge.id` or `charge.reference`.
6. `merchantPreDebitNotification: true` means the scheduler calls `notifyCharge`; `merchantChargeLeadHours` means the gateway notifies and the charge is raised ahead of the due date.

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
- Signature tests that compute the expected value independently with `node:crypto`.
- **The conformance suite**, for merchant-scheduled gateways: `test/helpers/merchant-adapter-conformance.ts` runs the contract above through the real facade and the real scheduler against a scripted fake of the gateway. Write a harness (an adapter plus a scripted gateway) and call `describeMerchantAdapterConformance(harness)` in a test file. `test/integration/conformance.test.ts` shows how it is used.
- The integration tests in `test/integration/`, which wire the real adapters through the real facade, including `10-exports.test.ts` for the public surface.

## Documentation

1. Add the adapter to `ADAPTER_FACTORIES` in `scripts/generate-docs-reference.ts`. The capability matrix then includes it.
2. Replace the stub page in `docs/gateways/` with a full page, following [Razorpay](../gateways/razorpay.md), [Cashfree](../gateways/cashfree.md) or [PayU](../gateways/payu.md): configuration, capabilities, how trials, upfront amounts and authorisation debits work, payment methods and their limits, status and webhook mappings, and gateway-specific behaviour. Put the generated regions in the page (`<!-- generated:begin capabilities <gateway> -->` and friends; the region names are in the generator).
3. Run `npm run docs:reference` and `npx vitest run test/docs`.

## Checklist

- [ ] Fact sheet written, with sources and contradictions.
- [ ] Adapter, mapper, schemas and constants, with no magic strings.
- [ ] Tests from documented samples; conformance suite if merchant-scheduled.
- [ ] `capabilities` match what the adapter really does.
- [ ] Config, env vars, exports, OpenAPI and Python models updated.
- [ ] Gateway page, verification list and generated reference updated.
- [ ] Sandbox run done, or the page says plainly that it has not been.
