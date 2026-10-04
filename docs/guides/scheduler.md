# Running the scheduler

After this page you will be able to run the billing scheduler for PayU and for Cashfree on-demand plans: call `tick()` on a schedule, choose its policies, pick a store for development and for production, and implement your own store on PostgreSQL, including its lock.

Read [Gateway-scheduled and merchant-scheduled subscriptions](../concepts/scheduling.md) first if you have not: it explains what the scheduler does and why it never debits twice.

## Configure it

Pass a store, and optionally policy defaults and an event listener, to `createSubscriptions`. The client builds the scheduler for exactly the providers you gave it.

```ts title="billing-payu.ts"
import { Environment, MemorySchedulerStore, createSubscriptions, payu } from 'india-subscriptions';

export const subs = createSubscriptions({
  providers: [
    payu({
      key: process.env.PAYU_KEY!,
      salt: process.env.PAYU_SALT!,
      environment: Environment.Test,
      successUrl: 'https://shop.example.com/payu/success',
      failureUrl: 'https://shop.example.com/payu/failure',
    }),
  ],
  scheduler: { store: new MemorySchedulerStore() },
});
```

Creating a merchant-scheduled subscription without a scheduler throws `CONFIG`. Everything else (`create`, `get`, `pause`, `cancel`, webhooks) is the same as for any gateway.

## Run `tick()`

`tick()` does whatever is due and does nothing, without calling any gateway, when nothing is. It is safe to call from several workers and as often as you like. Call it every 5 to 15 minutes.

```ts
import { subs } from './billing-payu';

export async function runTick(): Promise<void> {
  const result = await subs.tick({ limit: 100 });
  console.log(
    `due=${result.due} notified=${result.notified} charged=${result.charged} succeeded=${result.succeeded} failed=${result.failed} halted=${result.halted}`,
  );
  for (const error of result.errors) console.error(`schedule ${error.scheduleId}: ${error.code}`);
}
```

Call `runTick` from a cron job, a cloud scheduler hitting a protected route of yours, or `setInterval` in a long-running process. One failing schedule is reported in `result.errors` and never stops the others. With the HTTP service, you do not need this: `serve` ticks every `SCHEDULER_TICK_SECONDS` (300 by default) and also exposes `POST /v1/scheduler/tick`.

## Policies

Policies are set as defaults on the scheduler (and per schedule when you register one yourself).

| Option | Default | Meaning |
|---|---|---|
| `notifyLeadHours` | 48 | Send the pre-debit notification this many hours before the due time (gateways that need it). |
| `minNoticeHours` | 24 | The minimum gap between an accepted notification and the debit (the RBI minimum). |
| `maxAttempts` | 3 | Debit attempts per cycle before the cycle fails and the schedule halts. |
| `retryIntervalHours` | 24 | Hours between a failed attempt and the next. |
| `unknownOutcomeGraceMinutes` | 30 | How long after a debit of unknown outcome before the same id may be sent again. |
| `chargeLeadHours` | none | For charge-in-advance gateways: raise the charge at least this far ahead. |
| `authorizationTimeoutHours` | none | Cancel a schedule still awaiting authorisation after this long. A customer who authorises later revives it. |
| `authorizationPollMinutes` | 60 | How often to ask the gateway whether a waiting mandate is live. 0 turns it off. |
| `debitAtIstTime` | none | Debit at this `HH:mm` IST on the due date. NPCI restricts UPI Autopay debits during peak hours (10:00 to 13:00 and 17:00 to 21:30 IST), so pick an off-peak time for UPI mandates. The first cycle is never moved earlier than its contractual instant. |
| `lockTtlMs`, `lockWaitMs` | 60000, 5000 | Lock lifetime if its owner dies, and how long API calls wait for a busy lock before `CONFLICT`. |

The complete, current list with types is in [Scheduler records and options](../reference/generated/scheduler-records.md#schedulerconfig).

```ts
import { Environment, MemorySchedulerStore, SchedulerEventType, createSubscriptions, payu } from 'india-subscriptions';

export const subs = createSubscriptions({
  providers: [payu({ key: 'key', salt: 'salt', environment: Environment.Test, successUrl: 'https://shop.example.com/payu/ok' })],
  scheduler: {
    store: new MemorySchedulerStore(),
    maxAttempts: 4,
    retryIntervalHours: 48,
    authorizationTimeoutHours: 72,
    onEvent: (event) => {
      // Called after each change is stored. It may run twice for one change: be idempotent.
      if (event.type === SchedulerEventType.ChargeOutcomeOverdue) console.error('look at this debit', event.chargeId);
      if (event.type === SchedulerEventType.ScheduleHalted) console.warn('suspend access', event.subscriptionId);
    },
  },
});
```

A listener that throws never affects billing. Alert on `charge.outcome_overdue` and `schedule.halted`.

## Choosing a store

| Store | Use for | Survives restart | Several processes |
|---|---|---|---|
| `MemorySchedulerStore` | Tests and development | No | No |
| `FileSchedulerStore` (`india-subscriptions/server`) | One service process, small deployments. It is what `serve` uses. | Yes (atomic file rewrite, mode 0600) | **No**: a second process would not see the first one's writes or locks |
| Your own `SchedulerStore` | Production with more than one worker | Yes | Yes, if the lock is atomic |

**`MemorySchedulerStore` loses everything on restart.** A restarted process forgets every schedule: customers with a live mandate would never be billed. Never use it with real money.

```ts
import { FileSchedulerStore } from 'india-subscriptions/server';

export async function openStore(): Promise<FileSchedulerStore> {
  return FileSchedulerStore.open('/var/lib/billing/scheduler.json');
}
```

## Implementing `SchedulerStore` on PostgreSQL

The store is eight methods plus a lock. The records are plain JSON, so each fits in a `jsonb` column. What the scheduler relies on:

- **Durability.** A resolved `save*` is really stored. The scheduler writes a cycle as `charging` **before** it asks the gateway to debit a customer and relies on that write surviving a crash.
- **Read your own writes.** After `saveSchedule` resolves, any worker's `getSchedule` returns that version or a newer one. On a replicated database, read from the primary.
- **An atomic, non-blocking lock.** `acquireLock` returns a token to at most one of any number of concurrent callers, or `undefined` if the lock is held and has not expired. A lock expires after `ttlMs` so a crashed worker cannot block a schedule forever, and `releaseLock` deletes it only for the holder's own token.
- **`listDueSchedules`** returns schedules whose `nextActionAt` is at or before the given instant, oldest first. It is a hint, not a lease: two workers may get the same schedule, and the scheduler takes the lock and re-reads before acting. Index `nextActionAt`.
- **Own copies.** Returned objects must not share state with what is stored.
- **Lookups by id.** `findBySubscriptionId(provider, id)` and `findScheduleByChargeId(chargeId)` (a gateway webhook that names only a debit uses it) need indexes on the cycle's `chargeId` and `providerChargeId`.

The lock is the part people get wrong. It is a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()`: it inserts the row, or takes over a lock that has expired, and returns nothing if a live lock exists. It uses the database's `now()`, so workers with skewed clocks agree.

```sql
CREATE TABLE IF NOT EXISTS billing_locks (
  schedule_id text PRIMARY KEY,
  token       text NOT NULL,
  expires_at  timestamptz NOT NULL
);
```

The whole store, as a documented example file that is type-checked against the real `SchedulerStore` interface by this repository's tests:

```ts title="postgres-scheduler-store.ts" source="examples/postgres-scheduler-store.ts"
import { randomUUID } from 'node:crypto';
import {
  CycleRecordSchema,
  ScheduleRecordSchema,
  type CycleRecord,
  type Provider,
  type ScheduleRecord,
  type SchedulerStore,
} from 'india-subscriptions';

/**
 * The one thing this store needs from a Postgres client: run a statement with parameters and return its rows.
 * `pg.Pool#query(text, values)` has this shape. Typing against it keeps the example free of a dependency.
 */
export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<{ record?: unknown; token?: string }> }>;
}

/**
 * A `SchedulerStore` on PostgreSQL, safe for several workers.
 *
 * Records are kept whole in `jsonb` columns, with the few fields the scheduler queries by in real columns.
 * The lock is one atomic statement, and it uses the database's clock, so workers with skewed clocks agree.
 */
export class PostgresSchedulerStore implements SchedulerStore {
  constructor(private readonly db: Queryable) {}

  /** Run once at deploy time. */
  static readonly schema = `
    CREATE TABLE IF NOT EXISTS billing_schedules (
      id              text PRIMARY KEY,
      provider        text NOT NULL,
      subscription_id text NOT NULL,
      next_action_at  timestamptz,
      created_at      timestamptz NOT NULL,
      record          jsonb NOT NULL
    );
    CREATE INDEX IF NOT EXISTS billing_schedules_subscription ON billing_schedules (provider, subscription_id);
    CREATE INDEX IF NOT EXISTS billing_schedules_due ON billing_schedules (next_action_at) WHERE next_action_at IS NOT NULL;

    CREATE TABLE IF NOT EXISTS billing_cycles (
      schedule_id        text NOT NULL,
      idx                integer NOT NULL,
      charge_id          text,
      provider_charge_id text,
      record             jsonb NOT NULL,
      PRIMARY KEY (schedule_id, idx)
    );
    CREATE INDEX IF NOT EXISTS billing_cycles_charge ON billing_cycles (charge_id);
    CREATE INDEX IF NOT EXISTS billing_cycles_provider_charge ON billing_cycles (provider_charge_id);

    CREATE TABLE IF NOT EXISTS billing_locks (
      schedule_id text PRIMARY KEY,
      token       text NOT NULL,
      expires_at  timestamptz NOT NULL
    );
  `;

  async getSchedule(id: string): Promise<ScheduleRecord | undefined> {
    const { rows } = await this.db.query('SELECT record FROM billing_schedules WHERE id = $1', [id]);
    return rows[0] ? ScheduleRecordSchema.parse(rows[0].record) : undefined;
  }

  async saveSchedule(schedule: ScheduleRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO billing_schedules (id, provider, subscription_id, next_action_at, created_at, record)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (id) DO UPDATE
         SET provider = EXCLUDED.provider,
             subscription_id = EXCLUDED.subscription_id,
             next_action_at = EXCLUDED.next_action_at,
             record = EXCLUDED.record`,
      [
        schedule.id,
        schedule.provider,
        schedule.subscriptionId,
        schedule.nextActionAt ?? null,
        schedule.createdAt,
        JSON.stringify(schedule),
      ],
    );
  }

  async findBySubscriptionId(provider: Provider, subscriptionId: string): Promise<ScheduleRecord | undefined> {
    const { rows } = await this.db.query(
      `SELECT record FROM billing_schedules
       WHERE provider = $1 AND subscription_id = $2
       ORDER BY created_at DESC LIMIT 1`,
      [provider, subscriptionId],
    );
    return rows[0] ? ScheduleRecordSchema.parse(rows[0].record) : undefined;
  }

  async findScheduleByChargeId(chargeId: string): Promise<ScheduleRecord | undefined> {
    const { rows } = await this.db.query(
      `SELECT s.record FROM billing_cycles c
       JOIN billing_schedules s ON s.id = c.schedule_id
       WHERE c.charge_id = $1 OR c.provider_charge_id = $1
       ORDER BY s.created_at DESC LIMIT 1`,
      [chargeId],
    );
    return rows[0] ? ScheduleRecordSchema.parse(rows[0].record) : undefined;
  }

  async listDueSchedules(at: string, limit: number): Promise<ScheduleRecord[]> {
    const { rows } = await this.db.query(
      `SELECT record FROM billing_schedules
       WHERE next_action_at IS NOT NULL AND next_action_at <= $1::timestamptz
       ORDER BY next_action_at ASC LIMIT $2`,
      [at, limit],
    );
    return rows.map((row) => ScheduleRecordSchema.parse(row.record));
  }

  async getCycle(scheduleId: string, index: number): Promise<CycleRecord | undefined> {
    const { rows } = await this.db.query('SELECT record FROM billing_cycles WHERE schedule_id = $1 AND idx = $2', [
      scheduleId,
      index,
    ]);
    return rows[0] ? CycleRecordSchema.parse(rows[0].record) : undefined;
  }

  async saveCycle(cycle: CycleRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO billing_cycles (schedule_id, idx, charge_id, provider_charge_id, record)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (schedule_id, idx) DO UPDATE
         SET charge_id = EXCLUDED.charge_id,
             provider_charge_id = EXCLUDED.provider_charge_id,
             record = EXCLUDED.record`,
      [cycle.scheduleId, cycle.index, cycle.chargeId ?? null, cycle.providerChargeId ?? null, JSON.stringify(cycle)],
    );
  }

  async listCycles(scheduleId: string): Promise<CycleRecord[]> {
    const { rows } = await this.db.query('SELECT record FROM billing_cycles WHERE schedule_id = $1 ORDER BY idx ASC', [
      scheduleId,
    ]);
    return rows.map((row) => CycleRecordSchema.parse(row.record));
  }

  /**
   * One atomic statement. The row is inserted, or taken over when its lock has expired. When the lock is held and
   * live, the WHERE clause is false, nothing is returned and the caller gets `undefined`. It never waits.
   */
  async acquireLock(scheduleId: string, ttlMs: number): Promise<string | undefined> {
    const token = randomUUID();
    const { rows } = await this.db.query(
      `INSERT INTO billing_locks (schedule_id, token, expires_at)
       VALUES ($1, $2, now() + $3 * interval '1 millisecond')
       ON CONFLICT (schedule_id) DO UPDATE
         SET token = EXCLUDED.token, expires_at = EXCLUDED.expires_at
         WHERE billing_locks.expires_at <= now()
       RETURNING token`,
      [scheduleId, token, ttlMs],
    );
    return rows[0]?.token;
  }

  /** Deletes the lock only if `token` still holds it: a lock that expired and was taken by someone else stays taken. */
  async releaseLock(scheduleId: string, token: string): Promise<void> {
    await this.db.query('DELETE FROM billing_locks WHERE schedule_id = $1 AND token = $2', [scheduleId, token]);
  }
}
```

Using it, with a `pg` pool (`pg.Pool` has the same `query(text, values)` shape the example asks for; the example is typed against that minimal interface so it needs no dependency here):

```ts
import { Environment, createSubscriptions, payu } from 'india-subscriptions';
import { PostgresSchedulerStore, type Queryable } from './postgres-scheduler-store';

export async function buildClient(pool: Queryable) {
  await pool.query(PostgresSchedulerStore.schema);
  return createSubscriptions({
    providers: [payu({ key: 'key', salt: 'salt', environment: Environment.Test, successUrl: 'https://shop.example.com/payu/ok' })],
    scheduler: { store: new PostgresSchedulerStore(pool) },
  });
}
```

::: warning Test your store
Before relying on any store, run the scheduler's own contract through it: two workers ticking at once must never both raise a debit for one schedule, and a crash between saving a cycle and the schedule must heal on the next tick. This repository's `test/scheduler/memory-store.test.ts` shows what a correct store must do.
:::

## Operating it

- **Alert on** `charge.outcome_overdue` (a debit whose outcome is still unknown after the grace period) and `schedule.halted`.
- **Do not run two schedulers on the file store.** For several workers use a shared store.
- **Cancel the mandate at the gateway when you cancel a schedule.** The facade's `cancel` does both. Calling `scheduler.cancel` directly stops billing but does not call the gateway.
- Back up the store: it holds customer details and mandate ids.
