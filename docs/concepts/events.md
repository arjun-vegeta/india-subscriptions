# Events

After this page you will know the two kinds of event the library produces, what each means, how to de-duplicate them and why you should not treat a webhook as the only source of truth.

## Gateway events

A **gateway event** is a gateway webhook that was verified and normalised. Every gateway sends its own names and shapes; you get one:

```text
{ id, provider, type, providerEventType, occurredAt?, subscriptionId?, subscription?, charge?, refund?, paymentId?, payment?, raw }
```

`type` is one of the `EventType` constants. `providerEventType` is the gateway's own event name, and `raw` is the gateway's payload, untouched.

| Event type | Means | Usual reaction |
|---|---|---|
| `subscription.authorized` | The customer authorised the mandate. | Record it. For merchant-scheduled gateways the scheduler activates billing. |
| `subscription.authorization_failed` | Authorisation failed. | Tell the customer; let them retry. |
| `subscription.activated` | The mandate is live and billing has started. | Grant access if you have not already. |
| `subscription.charged` | A recurring debit succeeded. `charge` has the amount. | Extend access, record the payment. |
| `subscription.charge_failed` | A debit failed. | Tell the customer. |
| `subscription.charge_scheduled` | The customer was told about an upcoming debit. | Informational. |
| `subscription.past_due` | A charge failed and is being retried. | Warn the customer; keep or limit access by policy. |
| `subscription.halted` | Retries are exhausted. | Suspend access; ask for a new payment method. |
| `subscription.paused`, `subscription.resumed` | Charging stopped or restarted (by you or the customer). | Mirror it. |
| `subscription.updated` | The plan, quantity or terms changed, or the mandate is awaiting the bank. | Re-read the subscription. |
| `subscription.cancelled` | Ended (by you, the customer or the bank). | End access. |
| `subscription.completed` | All cycles were collected. | End access or offer a renewal. |
| `subscription.expired` | The authorisation or the mandate lapsed. | Offer a new subscription. |
| `payment.succeeded`, `payment.failed` | A one-time payment succeeded or failed. `paymentId` and `payment` carry it. | Fulfil the order, or tell the customer. |
| `refund.succeeded`, `refund.failed` | A refund finished or failed. | Update your records. |
| `unknown` | A verified event this library does not normalise. | Inspect `raw`, or ignore it. |

Which gateway sends which event is on each gateway's page ([Razorpay](../gateways/razorpay.md#webhooks), [Cashfree](../gateways/cashfree.md#webhooks), [PayU](../gateways/payu.md#webhooks), [PhonePe](../gateways/phonepe.md#webhooks), [Paytm](../gateways/paytm.md#webhooks)). Not every gateway can produce every type: PayU's webhooks, for instance, carry no subscription id for a debit, so a debit is attributed to a cycle by the scheduler instead.

## Scheduler events

For merchant-scheduled gateways, the **billing scheduler** emits its own events: it chose the debit id, so it can tell you which cycle a debit belonged to and how it ended. They are passed to the `onEvent` listener, and the HTTP service forwards them to your events webhook.

| Event | Means |
|---|---|
| `schedule.registered`, `schedule.activated` | A schedule was created and billing started. |
| `schedule.paused`, `schedule.resumed`, `schedule.updated` | State changes you asked for, or a gateway told us about. |
| `schedule.cancelled`, `schedule.completed`, `schedule.halted` | The schedule ended. `halted` means retries ran out. |
| `notification.sent`, `notification.failed` | The pre-debit notice was accepted, or not. |
| `charge.succeeded` | A debit succeeded. |
| `charge.failed` | One attempt failed. A retry may follow; `cycle.failed` means none will. |
| `charge.outcome_unknown` | A call ended without a definite answer. It will be reconciled. |
| `charge.outcome_overdue` | The outcome is still unknown after the grace period. **A person should look at it.** |
| `charge.in_flight` | The schedule was paused or cancelled while a debit was already raised. The gateway may still debit the customer. |
| `cycle.failed`, `cycle.skipped` | A cycle ended without being collected. |

Each carries the schedule id, the gateway, the subscription id, the status of the schedule after the change and, where relevant, the cycle, attempt, debit id and amount. The exact fields are in [Scheduler records](../reference/generated/scheduler-records.md#schedulerevent), and the values in [Enumerations](../reference/generated/enums.md#schedulereventtype).

## De-duplication and ordering

- **Delivery is at least once.** Gateways redeliver; the service retries; the scheduler may emit the same change twice after a crash between saving and emitting. Every event has a stable `id`: record the ids you have processed and ignore repeats. Razorpay's `id` is the `x-razorpay-event-id` header. Cashfree sends none, so the library builds one from the event type, the entity id, its status and the event time. PayU's is built from the payment id and status, and PhonePe's from the event name and the ids in the payload. A scheduler event's id is `sevt_` plus a hash of its content.
- **Order is not guaranteed.** Do not assume `subscription.charged` arrives before `subscription.updated`. Make each handler idempotent and, when it matters, read the current state with `subs.get`.
- **Webhooks can be missed.** Gateways stop retrying after a while, and Cashfree does not replay at all. A nightly job that reads active subscriptions with `subs.get` is a cheap safeguard.

## Where events come from in your code

| You are using | Gateway events | Scheduler events |
|---|---|---|
| The library, in Node | The return value of `subs.webhooks.handle` | The `onEvent` option of the scheduler |
| The HTTP service | Your events webhook (`kind: "gateway"`) | Your events webhook (`kind: "scheduler"`) |

[Handling webhooks](../guides/webhooks.md) shows the code.
