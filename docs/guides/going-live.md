# Going-live checklist

After this page you will know what must be true before a real customer pays, and what to check in each gateway's test mode first.

## 1. Before you touch a gateway

- [ ] You read [How recurring payments work in India](../concepts/recurring-payments.md) and know which instruments and limits your plans need (for example, whether any debit exceeds ₹15,000).
- [ ] You walked through the [security checklist](./security.md).
- [ ] The gateway has enabled subscriptions on your account in **both** test and live mode (Razorpay: both; Cashfree: UPI Autopay is not self-serve and must be switched on for sandbox and production; PayU: ask your key account manager; Paytm: subscriptions are for enterprise merchants and must be enabled on your merchant id).
- [ ] You have test keys in a separate environment from live keys.

## 2. Run the gateway's checks in test mode

Work through the list for each gateway you will use. If a gateway behaves differently from what is described here, the fix belongs in `src/providers/<gateway>/`.

### Razorpay

- [ ] Run `scripts/razorpay-test-mode-check.mts` with test keys.
- [ ] Create a monthly subscription with `trial: { days: 14 }`, open the checkout with a test card, verify the result, and check the status is `trialing`. Check whether a `subscription.authenticated` webhook fires for a trial.
- [ ] Use **Charge this now**: a success gives `subscription.charged`; four failures give `subscription.pending` then `subscription.halted`.
- [ ] Create a subscription with no `totalCycles` and check Razorpay accepts the 10-year default.
- [ ] Try `update` with `nextChargeAt` and `notifyCustomer` and see whether Razorpay rejects them.
- [ ] Pause during a trial: it must be refused with `CONFLICT`, and pause on an `active` one must work.
- [ ] Cancel at period end, then fetch and see how it appears.
- [ ] Refund a charge and look at the webhooks.

### Cashfree

- [ ] Check the unit of amounts: create a ₹499 plan and see ₹499 in the Dashboard.
- [ ] Verify webhooks with the client secret, or set `webhookSecret` if your account has one.
- [ ] Create a periodic subscription with a trial and see the first charge date; try one longer than 14 days.
- [ ] Check the authorisation refund: ₹1 refunded; with `upfrontAmount`, not refunded.
- [ ] With an on-demand plan, raise a charge 48 hours ahead and one at the 13-day limit; check the cards cut-off.
- [ ] Return from checkout and confirm `verifyCheckout` fetches the subscription. With eNACH, confirm `pending_authorization` until `ACTIVE`.

### PayU

- [ ] Run `scripts/payu-test-env-check.mts` against the test environment.
- [ ] Complete a card consent, `verifyCheckout`, notice and debit on the test merchant. Know that PayU's test environment never captures a debit.
- [ ] On a merchant account with those flows enabled: UPI and eNACH registration, webhook delivery and signatures, mandate status and revoke, a refund, and a captured debit.
- [ ] Confirm the pre-debit lead time with PayU. The test environment enforces none.

### PhonePe

- [ ] Set up PhonePe's UAT sandbox: install the test app, pick a template, share your webhook URL with PhonePe's integration team.
- [ ] Create a subscription, approve the mandate in the test app, and check that the return URL carries `merchantSubscriptionId` and `verifyCheckout` reads an `ACTIVE` mandate.
- [ ] Notify, wait, redeem with the same order id; check one order-status path serves the notice, the debit and the refund, and what a repeated redeem does.
- [ ] Pause, un-pause and revoke in the test app and watch the webhooks. Serve the webhook over HTTPS only.
- [ ] Cancel a mandate that was never authorised and see the answer.

### Paytm

- [ ] Get subscriptions enabled on your staging merchant id; check each payment mode you need is enabled.
- [ ] Make one successful call to confirm your checksum setup.
- [ ] Create a merchant-mode subscription with a trial longer than a few days and raise the first debit: does Renew accept it inside the grace window? Does Transaction Status show the Renew order?
- [ ] Re-send a renew id and check Paytm refuses it. Try Paytm's own collection with a plain fixed plan.
- [ ] With a card and with UPI, check whether Pre-Notify is needed and how early.

### One-time payments

Do this on each gateway you take payments on.

- [ ] Create a payment of a small amount, pay it with a test method, `payments.verify` with `expectedPaymentId`, and `payments.get`. Check the status is `succeeded` and the amount is yours.
- [ ] Verify a genuine result of one payment against the id of another: it must fail with `SIGNATURE_INVALID`.
- [ ] Close the browser before returning, and check that the webhook (or a `payments.get` from your job) still completes the order.
- [ ] Refund part of the payment with a `refundId`, repeat the same call, and check one refund results. Look at the refund event.
- [ ] Check what the gateway refuses for your inputs: `expiresAt`, `paymentMethods`, `metadata` and the `reference` rules differ ([One-time payments](./one-time-payments.md#what-differs-per-gateway)).

### The browser helper

- [ ] Open each checkout you use in a real browser, with your Content-Security-Policy on.

## 2b. Routing

- [ ] Your strategy lists every gateway in `costs` (a gateway without an entry costs nothing, and would win every close call) and in `priority`.
- [ ] `limits` carries the per-debit ceiling each gateway's mandates allow without extra authentication (Rs 15,000 under the RBI e-mandate framework, with its exceptions).
- [ ] Ask `subs.router.route` for each kind of purchase you sell and read the decision: the gateway you expected, and a plausible reason for each one excluded.
- [ ] The statistics store is durable if you run more than one process or restart often. Success rates are shared through it; the circuit breaker is per process.
- [ ] You handle `NO_ROUTE`.

## 2c. The app stores and purchase sessions

Skip what you do not sell. [Selling on iPhone, Android and the web](./purchases.md) describes each step.

**Apple App Store**

- [ ] The Paid Apps Agreement is active, the products are approved, and the catalog's `appStore.productId` values match App Store Connect.
- [ ] `APP_STORE_ENVIRONMENT` is `live` with `APP_STORE_APP_APPLE_ID`; the Production Server URL is set with Version 2 and answers 200. See [Setting up the App Store](./setting-up-app-store.md).
- [ ] Buy a product with a sandbox account first, then a real one. Check the entitlement, a renewal notification and a refund notification.
- [ ] The iOS app has no button, link or text that steers customers to another way to pay.

**Google Play**

- [ ] The service account has its two permissions, the Pub/Sub push subscription has authentication on and matches `pushAudience` and `pushServiceAccountEmail`, and the test message arrived. See [Setting up Google Play](./setting-up-google-play.md).
- [ ] Buy with a license tester, then a real account. Check the purchase is acknowledged, the entitlement, and a renewal and a refund notification.
- [ ] A purchase interrupted before it reached your server is retried by the app until confirmed (Google refunds it after three days).

**User choice billing**

- [ ] You are enrolled, the app is enabled, and Google confirmed it by e-mail.
- [ ] Every product sold on Android has `taxRateBps`, `customer.state` is collected, `PUBLIC_BASE_URL` is `https`, and the hosted checkout is reachable from a phone.
- [ ] Choose the alternative with a license tester and check the first report reaches Google (`flush` sends it; a free trial reports an amount of 0). Check a renewal and a refund queue their reports.
- [ ] `flush` runs on a schedule (the service does it on every tick) and `FlushResult.overdue` pages someone.

**Sessions and entitlements**

- [ ] The purchase store is durable (`PURCHASE_STORE_FILE`, or your own implementation of `PurchaseStore`), and there is one service instance.
- [ ] Every provider's webhook goes through `subs.webhooks.handle`, so entitlements follow renewals, cancellations and refunds.
- [ ] A second purchase of a product the customer owns is refused with `CONFLICT`, and `duplicate_purchase` raises an alert.
- [ ] Your mobile backend holds the API key, authenticates the user and checks every session and customer against them. See [Mobile apps](./mobile-apps.md).

## 3. Webhooks

- [ ] Register the production URL with the gateway and send a real test event.
- [ ] Your route verifies the signature, stores the event, then answers 2xx, within 5 seconds.
- [ ] You tested a bad signature and a duplicate delivery. See [Handling webhooks](./webhooks.md).
- [ ] A job reconciles subscriptions with `subs.get`, and payments with `subs.payments.get`, in case a webhook is missed.
- [ ] If you use stores: Apple's notification URL and Google's push endpoint are set for production, and the routes are reachable without an API key and nowhere else.

## 4. Billing

- [ ] For PayU and Cashfree on-demand: a **durable** scheduler store, `tick()` running on a schedule, and alerts on `charge.outcome_overdue` and `schedule.halted`. See [Running the scheduler](./scheduler.md).
- [ ] You know what your product does in `past_due`, `halted` and `paused`. See [The subscription lifecycle](../concepts/lifecycle.md).
- [ ] Refund flows work, including the ₹2 PayU consent amount that is not refunded automatically.

## 5. The first live subscription

1. Switch to live keys and the live host (`Environment.Live`).
2. Subscribe with your own account for a small amount, with a one-day trial if the gateway allows it.
3. Watch the first webhook, the first debit and the first failure path in the gateway's Dashboard and in your logs.
4. Cancel it, and check the mandate is gone from your bank or UPI app.
5. Open to a small group before everyone.

## 6. Keep watching

Review the gateway's own documentation changes, run your checks again after upgrading this library, and subscribe to its releases. Verification is an ongoing job.
