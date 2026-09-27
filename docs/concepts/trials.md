# Trials, delayed starts and upfront amounts

After this page you will know how to ask for a free trial, a delayed start or an upfront amount, what the customer is actually charged at sign-up on each gateway, and what to watch for.

## Three inputs, three meanings

| Input | Meaning | Status until the first charge |
|---|---|---|
| `trial: { days: 14 }` or `trial: { endsAt }` | The customer authorises the mandate now. The **first charge happens when the trial ends.** | `trialing`, and `trialEndsAt` is set |
| `startAt` | The same date arithmetic, but you do not call it a trial. It delays the first charge. | `trialing` |
| `upfrontAmount` | A one-off amount (a setup fee or a paid trial) collected **together with the authorisation**. | n/a |

Pass either `trial` or `startAt`, not both: both set the date of the first charge. `trial.days` counts from the moment you create the subscription; `endsAt` and `startAt` are absolute instants. Both must be in the future. `mandateEndsAt` must be after the first charge.

While nothing has been charged yet, the subscription's status is `trialing` and `trialEndsAt` is the date the first charge is due.

```ts
import { IntervalUnit, Provider, createSubscriptions, razorpay } from 'india-subscriptions';

const subs = createSubscriptions({
  providers: [razorpay({ keyId: process.env.RAZORPAY_KEY_ID!, keySecret: process.env.RAZORPAY_KEY_SECRET! })],
});

// A 14-day trial, then ₹499 a month. The customer also pays a ₹99 setup fee now.
export function startWithFee(planId: string) {
  return subs.create(Provider.Razorpay, {
    plan: planId,
    customer: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
    trial: { days: 14 },
    upfrontAmount: 9900,
    upfrontLabel: 'Setup fee',
  });
}
```

## What the customer pays at sign-up

Authorising a card or UPI mandate needs a small real debit; the gateways differ in how much and whether they give it back.

| | Razorpay | Cashfree, periodic plan | Cashfree, on-demand plan | PayU |
|---|---|---|---|---|
| How a trial works | A future `start_at` | A future `subscription_first_charge_time` | The scheduler does not raise a debit until the trial ends | The scheduler does not raise a debit until the trial ends |
| Charged at authorisation, no upfront amount | **₹5**, refunded automatically (future start). The plan amount if the start is immediate (not refunded). | **₹1** for UPI and cards, refunded automatically. **₹0** for eNACH. | Same as periodic | **₹2** consent transaction (`free_trial`). **Not refunded automatically: you refund it.** |
| Charged with an `upfrontAmount` | The upfront amount (future start), or the upfront amount plus the plan amount (immediate start) | The upfront amount as the authorisation amount, not refunded. **UPI and cards only.** | Same | The upfront amount, at least ₹1, as the consent amount. eNACH: a few banks only. |
| Deadline to authorise | Before `start_at`, otherwise `expired` | The checkout session lasts 2 hours | `authorizationTimeoutHours` on the scheduler (optional) | Same |
| Upfront label | Yes (`upfrontLabel`) | Not supported | Not supported | Not applicable |

Two rules follow:

1. **Never promise "no charge" for a trial without checking.** On every gateway a card or UPI customer sees a small debit at sign-up. On Razorpay and Cashfree it is refunded; on PayU you must refund it yourself.
2. **An upfront amount is not a trial.** It is a real charge. If you want a "paid trial", pass an `upfrontAmount` and a `trial`.

## Gateway limits to know

- **Razorpay:** there is no separate trial field. Pausing a subscription that is still in its trial would cancel it irreversibly, so the library refuses with `CONFLICT`. Cancel it instead if that is what you mean.
- **Cashfree:** the first charge cannot happen before the earliest legal date for the method (T+1 or T+2 for UPI and cards, T+4 for eNACH). One FAQ line says the first charge date must be within 14 days of the request; whether that caps trial length is unclear, so check it in the sandbox before selling longer trials. eNACH never collects an upfront amount.
- **PayU:** UPI mandates start on the current date according to PayU's documentation; whether a future start date is honoured for UPI is one of the things to check. The mandate's end date is derived from `totalCycles`, else five years after the first debit.

## After the trial

At the end of the trial the first recurring charge is raised: by the gateway on Razorpay and Cashfree periodic plans, by the [scheduler](./scheduling.md) on PayU and Cashfree on-demand plans. You see `subscription.charged` (or a failure event) and the status moves from `trialing` to `active` (or `past_due`).

If a customer cancels during the trial, nothing is charged except what was taken at authorisation. See [Managing subscriptions](../guides/managing-subscriptions.md).
