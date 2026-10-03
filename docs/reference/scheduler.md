# The billing scheduler

`BillingScheduler` raises the debits of merchant-scheduled mandates. You normally never construct one: pass `scheduler: { store, ... }` to `createSubscriptions` and use `subs.tick()`. Construct it yourself to share one scheduler or to call its methods directly. For what it does, see [Scheduling](../concepts/scheduling.md); to run it, [Running the scheduler](../guides/scheduler.md).

## Options

`new BillingScheduler(options)` takes the policy and lock options in [Scheduler records and options, `SchedulerConfig`](./generated/scheduler-records.md#schedulerconfig), plus:

| Option | Meaning |
|---|---|
| `store` | A [`SchedulerStore`](#the-schedulerstore-contract). Required. |
| `resolveProvider(provider)` | Returns the adapter for a gateway. The scheduler only ever talks to the `SubscriptionProvider` interface. (`createSubscriptions` supplies it.) |
| `now` | Clock override for tests. |
| `onEvent(event)` | Called after each state change is stored, with a `SchedulerEvent`. Errors it throws are swallowed. It may run twice for one change if a worker crashes between storing and emitting: be idempotent. |

## Methods

| Method | Meaning |
|---|---|
| `register(input)` | Registers a schedule (`RegisterScheduleInput`). The id defaults to `scheduleIdFor(provider, reference ?? subscriptionId)`. The same id and data again returns the existing record; different data throws `CONFLICT`. With `awaitingAuthorization` it waits as `pending_authorization`. Throws `UNSUPPORTED` for a gateway that raises its own debits. |
| `activate(id, input?)` | Moves a `pending_authorization` schedule to `active`, optionally replacing `subscriptionId` and the first charge date. Revives a schedule cancelled by its authorisation timeout. |
| `attachSubscriptionId(id, subscriptionId)` | Records the id the mandate now has while the bank has not yet confirmed it. |
| `pause(id, { resumeAt? })` | Stops billing; a debit in flight is still reconciled. |
| `resume(id, { nextChargeAt?, skipFailedCycle? })` | Resumes a paused or halted schedule. Re-anchors the remaining cycles; missed cycles are never billed. For a halted schedule re-opens the failed cycle, or skips it with `skipFailedCycle`. |
| `cancel(id, { reason? })` | Cancels (idempotent). Does **not** call the gateway: use the client's `cancel`. |
| `update(id, input)` | `amount`, `nextChargeAt`, `remainingCycles`, `mandateEndsAt`; every field is applied or the call fails. `updateAmount(id, amount)` is shorthand. |
| `tick({ limit?, concurrency? })` | Does whatever is due. Returns a `TickResult`. |
| `handleEvent(event)` | Applies a normalised gateway event. Idempotent; takes the same lock as `tick`. |
| `get(id)`, `find(provider, ...keys)`, `findBySubscriptionId(provider, id)`, `listCycles(id)` | Queries. `find` tries the provider-scoped schedule id, then the stored gateway subscription id, then the bare key. |
| `now()` | The scheduler's clock. |

Also exported: `scheduleIdFor(provider, key)` (`provider:key`) and `awaitsActivation(schedule)`.

Methods other than `tick` wait up to `lockWaitMs` (5 seconds) for a busy lock and then throw `CONFLICT`.

## Policies

See the table in [Running the scheduler](../guides/scheduler.md#policies) and the generated [`SchedulePolicy`](./generated/scheduler-records.md#schedulepolicy).

## Events

[`SchedulerEvent`](./generated/scheduler-records.md#schedulerevent) with `type` from [`SchedulerEventType`](./generated/enums.md#schedulereventtype). What each means is in [Events](../concepts/events.md#scheduler-events).

## The `SchedulerStore` contract

Implement it on any database; the records are plain JSON ([`ScheduleRecord`](./generated/scheduler-records.md#schedulerecord), [`CycleRecord`](./generated/scheduler-records.md#cyclerecord)). A full PostgreSQL example is in [Running the scheduler](../guides/scheduler.md#implementing-schedulerstore-on-postgresql).

| Method | Contract |
|---|---|
| `getSchedule(id)` | The schedule or `undefined`. **Read your own writes.** Return the caller's own copy. |
| `saveSchedule(schedule)` | Upsert the whole record, last write wins. Durable when it resolves. Keep `nextActionAt` indexed. |
| `findBySubscriptionId(provider, subscriptionId)` | The schedule whose current `subscriptionId` matches, the newest if several. The id can change on activation: keep the index in step. |
| `findScheduleByChargeId(chargeId)` | The schedule of the cycle whose `chargeId` or `providerChargeId` matches. How a webhook that names only a debit finds its schedule. |
| `listDueSchedules(at, limit)` | Up to `limit` schedules with `nextActionAt` set and at or before `at`, oldest first. A hint, not a lease. Do not filter on `status`. May be eventually consistent but must never permanently miss a due schedule. |
| `getCycle(scheduleId, index)` | The cycle or `undefined`. |
| `saveCycle(cycle)` | Upsert by `(scheduleId, index)`. Durable when it resolves. |
| `listCycles(scheduleId)` | All cycles by `index` ascending. |
| `acquireLock(scheduleId, ttlMs)` | **Atomic.** At most one concurrent caller gets a token; the others get `undefined`. The lock expires after `ttlMs`; an expired lock is taken over. Never blocks. The schedule need not exist. |
| `releaseLock(scheduleId, token)` | Releases only if `token` is the current holder's. A stale token is a no-op. |

The scheduler saves a cycle first and the schedule second, and recovers from a crash between the two. A store that writes both in one transaction may, but need not. Stores shipped: `MemorySchedulerStore` and, from `india-subscriptions/server`, `FileSchedulerStore`.
