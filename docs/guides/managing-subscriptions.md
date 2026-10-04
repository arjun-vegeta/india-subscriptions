# Managing subscriptions

After this page you will know how to pause, resume, change the plan of, cancel and refund a subscription, and exactly where each gateway differs, so you check before you promise a customer something.

Every method takes the gateway first. An operation a gateway cannot do throws `SubscriptionError` with code `UNSUPPORTED`. Ask first with `subs.capabilities(provider)` (see the [capability matrix](../reference/generated/capabilities.md)).

```ts
import { CancelMode, ChangeTiming, Provider } from 'india-subscriptions';
import { subs } from './billing';

export async function manage(subscriptionId: string, paymentId: string) {
  const capabilities = subs.capabilities(Provider.Razorpay);

  if (capabilities.pause) await subs.pause(Provider.Razorpay, subscriptionId);
  if (capabilities.resume) await subs.resume(Provider.Razorpay, subscriptionId);

  if (capabilities.changePlan) {
    await subs.update(Provider.Razorpay, subscriptionId, {
      planId: 'plan_new',
      timing: ChangeTiming.AtPeriodEnd,
    });
  }

  const charges = await subs.charges.list(Provider.Razorpay, subscriptionId);
  await subs.charges.refund(Provider.Razorpay, { chargeId: paymentId, refundId: 'refund_1', amount: 5000 });

  // Keep access until the paid period ends where the gateway allows it; otherwise stop now.
  const mode = capabilities.cancelAtPeriodEnd ? CancelMode.AtPeriodEnd : CancelMode.Immediately;
  const cancelled = await subs.cancel(Provider.Razorpay, subscriptionId, { mode });
  return { charges: charges.length, status: cancelled.status };
}
```

## Pause and resume

| | Razorpay | Cashfree | PayU |
|---|---|---|---|
| Pause | Now only. `resumeAt` is `UNSUPPORTED`. Refused with `CONFLICT` during a trial, because Razorpay would cancel it. Only `active` subscriptions. | Periodic plans through Cashfree. On-demand: the scheduler stops raising debits. `resumeAt` is `UNSUPPORTED` for periodic plans. | Through the scheduler only. `resumeAt` works: the scheduler resumes by itself. |
| Resume | Now only. A UPI subscription paused by the customer can only be resumed by them. | Periodic: **`nextChargeAt` is required**. On-demand: the scheduler resumes. | Through the scheduler; `nextChargeAt` optional. |

For merchant-scheduled subscriptions, pause stops the scheduler and leaves the mandate valid at the gateway. Cycles that fell due while paused are never billed retroactively. A halted schedule can also be resumed, which re-opens the failed cycle or skips it: see [Running the scheduler](./scheduler.md).

## Change plan, quantity or amount

`subs.update(provider, id, changes)` takes at least one of `planId`, `quantity`, `remainingCycles`, `amount`, `nextChargeAt`, `mandateEndsAt`, plus `timing` (`ChangeTiming.Immediately` by default, or `AtPeriodEnd`) and `notifyCustomer`.

| | Razorpay | Cashfree | PayU |
|---|---|---|---|
| `planId` | Yes, for cards. **Not** for UPI or eMandate subscriptions. Only `authenticated` and `active`. | Periodic plans only (`CHANGE_PLAN`). To change the amount, create a plan with it and move to it. | `UNSUPPORTED` |
| `quantity` | Yes | `UNSUPPORTED` | `UNSUPPORTED` |
| `amount` | `UNSUPPORTED`: switch plan | Periodic: `UNSUPPORTED`. On-demand: applied to the schedule, within the mandate ceiling. | UPI mandate: sent to PayU and the customer must approve it. Applied to the schedule too. |
| `remainingCycles`, `nextChargeAt` | `remainingCycles` and `nextChargeAt` (as `start_at`; may be rejected) | `UNSUPPORTED` for periodic. On-demand: applied to the schedule. | Applied to the schedule |
| `mandateEndsAt` | `UNSUPPORTED` | `UNSUPPORTED` (cancel and create a new one) | UPI only |
| `timing: AtPeriodEnd` | Yes (`cycle_end`) | `UNSUPPORTED` | `UNSUPPORTED` |

On Razorpay an immediate change is prorated: an upgrade charges the difference, a downgrade refunds it through a credit note. A larger amount than the mandate ceiling always needs a new authorisation from the customer.

## Cancel now or at period end

`subs.cancel(provider, id, { mode })`. The default is `CancelMode.Immediately`: no further charges.

- `CancelMode.AtPeriodEnd` keeps the current paid period, then stops. Only **Razorpay** supports it; Cashfree and PayU throw `UNSUPPORTED`. Razorpay refuses it while no cycle is running (a trial) and in the final cycle. `subscription.cancelAtPeriodEnd` is true afterwards, but it is known only from the cancel call, not from a later fetch.
- On merchant-scheduled subscriptions, billing is stopped **first**, then the mandate is cancelled at the gateway. If the gateway call fails, billing stays stopped and the error is thrown so you can retry. Cancelling twice, or after completion, is fine.
- Cancelling is irreversible on every gateway. To let a customer return, create a new subscription.
- A customer can also cancel in their UPI app or bank portal; you learn it from `subscription.cancelled`.

If you want "cancel at period end" on a gateway that cannot do it, record the cancellation in your own database and call `cancel` when the period ends.

## Refunds

`subs.charges.refund(provider, { chargeId, refundId, amount?, reason?, subscriptionId? })`. Omit `amount` to refund the whole charge. `refundId` is your unique id for the refund.

| | Razorpay | Cashfree | PayU |
|---|---|---|---|
| `chargeId` | The payment id (`charge.id` from `charges.list`) | The payment id | PayU's payment id or your transaction id |
| `subscriptionId` | Not needed | **Required** | Not needed |
| Full refund | Omit `amount` | Omit `amount`: the adapter reads the charge first | Omit `amount` |
| Not possible | n/a | n/a | eNACH debits (banks do not support it, error 232) |
| Duplicate protection | Razorpay does **not** enforce your `refundId`: never retry after `OUTCOME_UNKNOWN` without checking the payment | Cashfree rejects a reused refund id | PayU rejects a reused token (error 106) |

A free-trial consent on PayU is a real ₹2 payment that is **not** refunded automatically. Refund it with `charges.refund` once the mandate is live.

`OUTCOME_UNKNOWN` on a refund means it may have happened. Read the charge (`charges.get`) and check `refundedAmount` before sending it again.

## PhonePe and Paytm

| | PhonePe | Paytm |
|---|---|---|
| Pause | `UNSUPPORTED` on the adapter; through the facade the scheduler pauses. The **customer** pauses and un-pauses in their UPI app, and a webhook tells you. | Paytm's Pause API (no date, so `resumeAt` is `UNSUPPORTED`) for Paytm-collected subscriptions; the scheduler for merchant-collected ones. |
| Resume | Through the scheduler. A customer's un-pause resumes billing; **your** pause is never undone by a gateway event. | Paytm's Resume API (no date), or the scheduler |
| Change plan, amount, quantity | `UNSUPPORTED`: cancel and create a new mandate | `UNSUPPORTED`: cancel and create a new subscription (Paytm documents no modify API) |
| Cancel | Immediately only (`CancelMode.AtPeriodEnd` is `UNSUPPORTED`). A never-authorised mandate answers `NOT_FOUND` at PhonePe; the facade then just stops the schedule. | Immediately only. Permanent. Repeating is safe. |
| Refund | `chargeId` is the debit's order id; only a completed debit; not older than 90 days | Only a successful debit; **not** for eNACH debits |

## Reading state

`subs.get` returns the subscription with its status, `nextChargeAt`, `paidCycles` and the gateway's own `providerStatus`. `subs.charges.list` returns the debits (newest first where the gateway orders them; PayU has no listing, so read debits by id). Use them to reconcile when a webhook might have been missed.
