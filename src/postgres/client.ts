/**
 * The slice of a PostgreSQL driver the stores need. `pg.Pool` satisfies it structurally, so the library has no driver
 * dependency; any other driver with the same two shapes works too.
 */

/** What a statement returns: its rows, as plain objects keyed by column name. */
export interface PostgresQueryResult {
  readonly rows: ReadonlyArray<Record<string, unknown>>;
  readonly rowCount?: number | null;
}

/** Runs one statement with bound parameters (`$1`, `$2`, ...). A pool runs it on any free connection. */
export interface PostgresQueryable {
  query(text: string, values?: unknown[]): Promise<PostgresQueryResult>;
}

/** One connection held for a transaction. `release(true)` discards the connection instead of returning it. */
export interface PostgresConnection extends PostgresQueryable {
  release(destroy?: boolean): void;
}

/** A pool: runs single statements, and hands out a connection to hold for a transaction. */
export interface PostgresPool extends PostgresQueryable {
  connect(): Promise<PostgresConnection>;
}

/** Where the tables live. Both values are validated as identifiers and quoted; neither is ever sent as a value. */
export interface PostgresStoreOptions {
  /** The schema holding the tables. Default `public`. `migratePostgres` creates it when it does not exist. */
  schema?: string;
  /** Prepended to every table and index name, so several installations can share one schema. Default `india_subscriptions_`. */
  tablePrefix?: string;
}
