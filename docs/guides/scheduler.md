# Running the scheduler

After this page you will be able to run the billing scheduler for PayU and for Cashfree on-demand plans: call `tick()` on a schedule, choose its policies, pick a store for development and for production, run the billing state on PostgreSQL so several workers can share it, and know what a store of your own for another database must guarantee.

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
| `FileSchedulerStore` (`india-subscriptions/server`) | One service process, small deployments. It is what `serve` uses with `SCHEDULER_STORE_FILE`. | Yes (atomic file rewrite, mode 0600) | **No**: a second process would not see the first one's writes or locks |
| `PostgresSchedulerStore` (`india-subscriptions/postgres`) | Production, one process or many. It is what `serve` uses with `DATABASE_URL`. | Yes | Yes: the lock and every write are single statements in the database |
| Your own `SchedulerStore` | A database other than PostgreSQL | Yes | Yes, if the lock is atomic |

**`MemorySchedulerStore` loses everything on restart.** A restarted process forgets every schedule: customers with a live mandate would never be billed. Never use it with real money.

```ts
import { FileSchedulerStore } from 'india-subscriptions/server';

export async function openStore(): Promise<FileSchedulerStore> {
  return FileSchedulerStore.open('/var/lib/billing/scheduler.json');
}
```

## Running it on PostgreSQL

`PostgresSchedulerStore` keeps schedules, cycles and locks in PostgreSQL 13 or later. The library has no database driver of its own: install [`pg`](https://node-postgres.com) and pass it a `Pool`. `migratePostgres` creates the tables.

```bash
npm install pg
```

```ts title="billing-postgres.ts"
import { Pool } from 'pg';
import { Environment, createSubscriptions, payu } from 'india-subscriptions';
import { PostgresSchedulerStore, migratePostgres } from 'india-subscriptions/postgres';

export async function buildClient() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  // An idle connection the server drops emits an error on the pool; without a listener it ends the process.
  pool.on('error', (error) => console.error('database connection failed', error.message));
  await migratePostgres(pool);

  const subs = createSubscriptions({
    providers: [
      payu({
        key: process.env.PAYU_KEY!,
        salt: process.env.PAYU_SALT!,
        environment: Environment.Test,
        successUrl: 'https://shop.example.com/payu/success',
        failureUrl: 'https://shop.example.com/payu/failure',
      }),
    ],
    scheduler: { store: new PostgresSchedulerStore(pool) },
  });
  return { subs, close: () => pool.end() };
}
```

Every worker runs the same code, against the same database. Call `close()` on shutdown, after the last tick has finished: the store never opens or closes connections itself.

**Migrations.** `migratePostgres(pool, options)` is versioned and idempotent, and it is safe to run from every worker at every start-up, at the same moment: the workers queue on a lock inside the database, and the ones that wait find the work already done. It creates the schema when it does not exist (a role without that privilege can run it against a schema an administrator created), and it rolls back completely when anything fails, so the schema is never half-migrated. A database that a newer version of the library migrated is refused with `CONFIG`: upgrade the library rather than run old code against a newer schema.

**Where the tables live.** Both `migratePostgres` and the store take the same two options: `schema` (default `public`) and `tablePrefix` (default `india_subscriptions_`). They are checked as identifiers, quoted, and never sent as values. The scheduler, the [purchase store](./purchases.md#where-it-is-stored) and the [routing statistics store](./routing.md#where-the-statistics-live) share one migration and one set of tables, so a deployment that uses all three migrates once. Give every installation that shares a database its own schema or prefix, and pass the same options everywhere.

**What it guarantees.**

- **Durable writes.** Each `save*` is one statement that has committed when it resolves, so the `charging` write the scheduler makes before it asks a gateway to debit a customer survives a crash.
- **Read your own writes.** Reads go to the same database. Point the pool at the primary rather than a replica, and keep `synchronous_commit` on.
- **One lock, one statement.** `acquireLock` inserts the lock row or takes over an expired one in a single statement, and never waits. Whether a lock has expired is decided by PostgreSQL's own clock, so workers whose clocks disagree still agree on who holds it.
- **Due schedules.** `listDueSchedules(at, limit)` compares against the `at` the scheduler passes, so the clock that decides what is due is the scheduler's own.
- **Copies and validation.** Rows are read into fresh objects, and a record is validated against its schema when it is written and when it is read.

At PostgreSQL's default READ COMMITTED isolation level the upserts and the lock are atomic; the lock stays correct at REPEATABLE READ and SERIALIZABLE too. A statement that fails rejects with `INTERNAL_ERROR` carrying the SQLSTATE and never the SQL or its values; missing tables reject with `CONFIG` and tell you to run `migratePostgres`.

`PostgresSchedulerStore` takes any object with `query(text, values)` and `connect()` that returns a connection with `query` and `release` (`PostgresPool`), which `pg.Pool` is. See [PostgreSQL stores](../reference/postgres.md).

## Writing your own store

For a database other than PostgreSQL, implement `SchedulerStore`: eight methods plus a lock. The records are plain JSON, so each fits in a JSON column. What the scheduler relies on:

- **Durability.** A resolved `save*` is really stored. The scheduler writes a cycle as `charging` **before** it asks the gateway to debit a customer and relies on that write surviving a crash.
- **Read your own writes.** After `saveSchedule` resolves, any worker's `getSchedule` returns that version or a newer one. On a replicated database, read from the primary.
- **An atomic, non-blocking lock.** `acquireLock` returns a token to at most one of any number of concurrent callers, or `undefined` if the lock is held and has not expired. A lock expires after `ttlMs` so a crashed worker cannot block a schedule forever, and `releaseLock` deletes it only for the holder's own token.
- **`listDueSchedules`** returns schedules whose `nextActionAt` is at or before the given instant, oldest first. It is a hint, not a lease: two workers may get the same schedule, and the scheduler takes the lock and re-reads before acting. Index `nextActionAt`.
- **Own copies.** Returned objects must not share state with what is stored.
- **Lookups by id.** `findBySubscriptionId(provider, id)` and `findScheduleByChargeId(chargeId)` (a gateway webhook that names only a debit uses it) need indexes on the cycle's `chargeId` and `providerChargeId`.

The lock is the part people get wrong. On a SQL database it is a single `INSERT ... ON CONFLICT DO UPDATE ... WHERE expires_at <= now()`: it inserts the row, or takes over a lock that has expired, and returns nothing if a live lock exists. Use the database's clock so workers with skewed clocks agree. The full contract, method by method, is in [The billing scheduler](../reference/scheduler.md#the-schedulerstore-contract), and `PostgresSchedulerStore` is the reference implementation.

::: warning Test your store
Before relying on any store, run the scheduler's own contract through it: two workers ticking at once must never both raise a debit for one schedule, and a crash between saving a cycle and the schedule must heal on the next tick. This repository's `test/scheduler/store-suite.ts` is the shared suite every shipped store passes, and `test/postgres/scheduler.test.ts` runs two real workers over one database.
:::

## Operating it

- **Alert on** `charge.outcome_overdue` (a debit whose outcome is still unknown after the grace period) and `schedule.halted`.
- **Do not run two schedulers on the file store.** For several workers use PostgreSQL.
- **Cancel the mandate at the gateway when you cancel a schedule.** The facade's `cancel` does both. Calling `scheduler.cancel` directly stops billing but does not call the gateway.
- Back up the store: it holds customer details and mandate ids. With PostgreSQL that is your database backup.
