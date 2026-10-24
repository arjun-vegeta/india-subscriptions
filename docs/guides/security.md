# Security checklist

After this page you will have a list to walk through before real money moves. The library is built so that the dangerous mistakes are hard to make, but several are yours to avoid.

## Secrets

- [ ] Gateway secrets (`keySecret`, `clientSecret`, PayU's `salt`, webhook secrets) and store credentials (the App Store `.p8` key, the Google Play service account key) are read from the environment or a secret manager, never committed and never sent to the browser. The only things the browser receives are in the checkout instruction, which the library builds to exclude every secret.
- [ ] Test and live keys are different variables in different environments, so a test deployment cannot hold a live key.
- [ ] The App Store `.p8` file is downloadable once and Apple keeps no copy: it lives in a secret manager, and is revoked in App Store Connect if it may have leaked. The Google Play service account has only the two permissions the adapter needs (**View financial data** and **Manage orders and subscriptions**), and its JSON key is rotated when someone who knew it leaves.
- [ ] Error messages and logs never contain a secret: the library guarantees it for its own messages. Do not log `subscription.raw`, `charge.raw` or `event.raw` unfiltered: they are the gateway's responses and carry customer details.

## Verify everything the browser tells you

- [ ] You create the subscription on the server and store its id. The browser never decides the plan or amount.
- [ ] `verifyCheckout` is always called with `expectedSubscriptionId`, the id (or `reference`) **you** stored. Without it, a genuine result for another subscription would verify.
- [ ] `payments.verify` is always called with `expectedPaymentId`, the id **you** stored. A store purchase is verified against the account token your server minted, so one order cannot unlock another.
- [ ] You identify the customer from your own session, never from a field in the request body. With purchase sessions, `customerRef` comes from your authentication, and a session id or customer in a path is checked against the signed-in user.
- [ ] You read what a customer owns from `purchases.entitlements`, which is built from the providers' own answers, not from what an app says.
- [ ] You act on webhooks and on `verifyCheckout`, never on the status the browser reports.

## Webhooks

- [ ] Webhook routes read the **raw** body. Signatures are compared in constant time by the library.
- [ ] A bad signature answers 401 and nothing from the body is used.
- [ ] App Store: the webhook route accepts Apple's notifications and nothing is trusted that is not a verified JWS. Google Play: the Pub/Sub push subscription has authentication on, `pushAudience` and `pushServiceAccountEmail` are set, and `acceptUnauthenticatedWebhooks` is off.
- [ ] Razorpay: `webhookSecret` is set. Cashfree: the webhook is registered on the **Subscriptions** tab. PayU: `acceptUnsignedWebhooks` is off unless the route is behind an allow-list of PayU's published addresses.
- [ ] Events are de-duplicated on `event.id`, and handlers are idempotent.
- [ ] If you use the service's events webhook, you verify its signature, reject timestamps more than 300 seconds off your clock, and keep `EVENTS_WEBHOOK_SECRET` secret. See [Using it from any language](../getting-started/any-language.md#verifying-the-signature).

## Mobile apps and the hosted checkout

- [ ] **No app holds the service's API key.** Apps call your backend with the user's own credentials; your backend forwards the five purchase calls. See [Mobile apps](./mobile-apps.md).
- [ ] The hosted checkout (`GET /checkout/{sessionId}` and its return routes) is the one place customers' browsers reach the service. A session id is the credential: 192 bits, unguessable, and answered with the same empty 404 whether the session is unknown or expired. Do not log it or put it in analytics.
- [ ] `PUBLIC_BASE_URL` is `https`. The page holds no secret, is served with a strict Content-Security-Policy, and the return route redirects only to the `returnUrl` stored on the session, never to a value from the request.
- [ ] The `returnUrl` you give `start` is your own web address or app deep link. A `javascript:` or `data:` address is never redirected to.
- [ ] Only the webhook routes and the checkout routes are exposed publicly: [Network exposure rules](./http-service.md#network-exposure-rules).

## The HTTP service

- [ ] `INDIA_SUBSCRIPTIONS_API_KEY` is long and random, stored as a secret and rotated when someone who knew it leaves.
- [ ] The service listens on loopback or a private network. Only `POST /v1/{provider}/webhooks` is reachable from outside. See [Running the HTTP service](./http-service.md#network-exposure-rules).
- [ ] You did not start it with `--allow-unauthenticated` unless something in front authenticates every request.
- [ ] The scheduler's state file and the purchase store file (mode 0600) hold customer details, mandate ids and purchase ids: they are on an encrypted volume and backed up.

## Money

- [ ] Amounts you pass are integer paise computed on the server.
- [ ] You never retry a write that failed with `OUTCOME_UNKNOWN` without reading the current state. Refunds on Razorpay are not de-duplicated by the gateway.
- [ ] Alerts exist for `charge.outcome_overdue` and `schedule.halted`, for `duplicate_purchase` reported by purchase sessions, and for overdue reports to Google (`FlushResult.overdue`).
- [ ] Prices come from your catalog or your own price list, never from the browser or the app.

## Cards

- [ ] Customers enter card, UPI and bank details only into the gateway's own checkout. This library never receives card data. Do not add a flow that collects it yourself: it brings PCI scope with it.

## Browser

- [ ] Your Content-Security-Policy allows the gateway scripts and the PayU form action and nothing broader than needed. The hosted checkout sets its own.
- [ ] Return URLs are HTTPS and on your domain.

When every box is ticked, continue with the [going-live checklist](./going-live.md).
