# Security checklist

After this page you will have a list to walk through before real money moves. The library is built so that the dangerous mistakes are hard to make, but several are yours to avoid.

## Secrets

- [ ] Gateway secrets (`keySecret`, `clientSecret`, PayU's `salt`, webhook secrets) are read from the environment or a secret manager, never committed and never sent to the browser. The only things the browser receives are in the checkout instruction, which the library builds to exclude every secret.
- [ ] Test and live keys are different variables in different environments, so a test deployment cannot hold a live key.
- [ ] Error messages and logs never contain a secret: the library guarantees it for its own messages. Do not log `subscription.raw`, `charge.raw` or `event.raw` unfiltered: they are the gateway's responses and carry customer details.

## Verify everything the browser tells you

- [ ] You create the subscription on the server and store its id. The browser never decides the plan or amount.
- [ ] `verifyCheckout` is always called with `expectedSubscriptionId`, the id (or `reference`) **you** stored. Without it, a genuine result for another subscription would verify.
- [ ] You identify the customer from your own session, never from a field in the request body.
- [ ] You act on webhooks and on `verifyCheckout`, never on the status the browser reports.

## Webhooks

- [ ] Webhook routes read the **raw** body. Signatures are compared in constant time by the library.
- [ ] A bad signature answers 401 and nothing from the body is used.
- [ ] Razorpay: `webhookSecret` is set. Cashfree: the webhook is registered on the **Subscriptions** tab. PayU: `acceptUnsignedWebhooks` is off unless the route is behind an allow-list of PayU's published addresses.
- [ ] Events are de-duplicated on `event.id`, and handlers are idempotent.
- [ ] If you use the service's events webhook, you verify its signature, reject timestamps more than 300 seconds off your clock, and keep `EVENTS_WEBHOOK_SECRET` secret. See [Using it from any language](../getting-started/any-language.md#verifying-the-signature).

## The HTTP service

- [ ] `INDIA_SUBSCRIPTIONS_API_KEY` is long and random, stored as a secret and rotated when someone who knew it leaves.
- [ ] The service listens on loopback or a private network. Only `POST /v1/{provider}/webhooks` is reachable from outside. See [Running the HTTP service](./http-service.md#network-exposure-rules).
- [ ] You did not start it with `--allow-unauthenticated` unless something in front authenticates every request.
- [ ] The scheduler's state file (mode 0600) holds customer details and mandate ids: it is on an encrypted volume and backed up.

## Money

- [ ] Amounts you pass are integer paise computed on the server.
- [ ] You never retry a write that failed with `OUTCOME_UNKNOWN` without reading the current state. Refunds on Razorpay are not de-duplicated by the gateway.
- [ ] Alerts exist for `charge.outcome_overdue` and `schedule.halted`.

## Cards

- [ ] Customers enter card, UPI and bank details only into the gateway's own checkout. This library never receives card data. Do not add a flow that collects it yourself: it brings PCI scope with it.

## Browser

- [ ] Your Content-Security-Policy allows the gateway scripts and the PayU form action and nothing broader than needed.
- [ ] Return URLs are HTTPS and on your domain.

When every box is ticked, continue with the [going-live checklist](./going-live.md).
