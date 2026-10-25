# PostgreSQL stores

Exported from `india-subscriptions/postgres` (Node only). The entry point holds the three stores that let several servers share one database, and the migration that creates their tables. It has no database driver of its own: pass a [`pg`](https://node-postgres.com) `Pool`, or anything shaped like one. The scheduler's, the purchase module's and the router's own pages say what each store is for: [Running the scheduler](../guides/scheduler.md#running-it-on-postgresql), [Where it is stored](../guides/purchases.md#where-it-is-stored) and [Where the statistics live](../guides/routing.md#where-the-statistics-live). The HTTP service uses all three when `DATABASE_URL` is set ([Using PostgreSQL](../guides/http-service.md#using-postgresql)).

`pg` is an optional peer dependency of `india-subscriptions`:

```bash
npm install pg
```

## Exports

| Export | Meaning |
|---|---|
| `migratePostgres(pool, options?)` | Creates or upgrades the tables of all three stores. Resolves `{ applied, version }`. |
| `PostgresSchedulerStore` | A [`SchedulerStore`](./scheduler.md#the-schedulerstore-contract). `new PostgresSchedulerStore(pool, options?)`. |
| `PostgresPurchaseStore` | A `PurchaseStore`: sessions, entitlements and the report queue. `new PostgresPurchaseStore(pool, options?)`. |
| `PostgresRoutingStatsStore` | A `RoutingStatsStore`. `new PostgresRoutingStatsStore(pool, options?)`, with the extra option `retentionHours`. |
| `LATEST_MIGRATION_VERSION` | The highest schema version this version of the library creates. |
| `DEFAULT_SCHEMA`, `DEFAULT_TABLE_PREFIX` | The defaults of the two options below: `public` and `india_subscriptions_`. |
| `PostgresTable` | The names of the tables, after the prefix. |
| `PostgresPool`, `PostgresConnection`, `PostgresQueryable`, `PostgresQueryResult` | The slice of a driver the stores use. |
| `PostgresStoreOptions`, `PostgresRoutingStatsStoreOptions`, `MigrationResult` | The option and result types. |

## Options

Every store and `migratePostgres` take the same two options, and the same values must be passed to all of them:

| Option | Default | Meaning |
|---|---|---|
| `schema` | `public` | The schema that holds the tables. `migratePostgres` creates it when it does not exist. |
| `tablePrefix` | `india_subscriptions_` | Prepended to every table and index name, so several installations can share a schema. |

Both are checked as identifiers: at most 63 characters of letters, digits and underscores, not starting with a digit, and a prefix short enough that every table and index name stays within 63 characters, because PostgreSQL silently truncates longer names. An invalid value throws `CONFIG`. The values are quoted, and never sent as parameters, because PostgreSQL does not take parameters for identifiers; every other value in every statement is a bound parameter.

`PostgresRoutingStatsStore` adds `retentionHours`: how many hours of buckets to keep. Default 168 (seven days), at least 25 (the router's default window of 24 hours plus one hour of bucket rounding).

## `migratePostgres`

```text
migratePostgres(pool: PostgresPool, options?: PostgresStoreOptions): Promise<MigrationResult>
```

Versioned, idempotent, and safe to run from every instance at every start-up, at the same moment. It runs in one transaction that first takes an advisory lock derived from the schema name, so concurrent migrators queue instead of racing, and the ones that wait find the versions already recorded and do nothing. A failure rolls everything back, so the schema is never half-migrated. `CREATE SCHEMA` is only attempted when the schema is missing, so a role without that privilege can run it against a schema an administrator created.

`MigrationResult` is `{ applied: number[]; version: number }`: the versions this call applied (empty when the schema was current) and the version after it. A database that a newer version of the library migrated is refused with `CONFIG`.

## The tables

| Table | Holds |
|---|---|
| `migrations` | The versions applied, with their names and times. |
| `schedules`, `cycles`, `schedule_locks` | The billing scheduler: schedules and cycles as JSON, with the columns it queries by, and its locks. |
| `sessions`, `entitlements`, `reports`, `purchase_locks` | The purchase module: sessions, entitlements, the report queue with its leases, and its locks. |
| `routing_stats` | One row per provider, kind, payment method and UTC hour, with three counters. |

Records are kept whole in `jsonb` columns, so a record comes back with exactly the values it went in with. The columns beside them are what the queries sort and look up by.

## The driver

The stores need only this from a driver, which `pg.Pool` has:

| Member | Meaning |
|---|---|
| `query(text, values?)` | Runs one statement with bound parameters (`$1`, `$2`, ...) on any free connection and resolves `{ rows }`. |
| `connect()` | Resolves a connection with `query` and `release(destroy?)`, held for one transaction. `release(true)` discards the connection. |

The stores never open or close connections: creating the pool, handling its `error` event, and calling `pool.end()` on shutdown are yours.

## Errors

| Failure | Error |
|---|---|
| An invalid `schema` or `tablePrefix`, or a database migrated by a newer version of the library | `CONFIG` |
| A statement on tables that do not exist | `CONFIG`, telling you to run `migratePostgres` with the same options |
| A record that does not match its schema, written or read | `VALIDATION` on write; `INTERNAL_ERROR` on read |
| Any other statement that fails | `INTERNAL_ERROR`, naming the store and the SQLSTATE, with the driver's error as `cause`; never the SQL or its values |

## Requirements

PostgreSQL 13 or later (the purchase store uses `gen_random_uuid()`). At the default READ COMMITTED isolation level the upserts and locks are atomic; the locks stay correct at REPEATABLE READ and SERIALIZABLE. Point the pool at the primary, and keep `synchronous_commit` on.
