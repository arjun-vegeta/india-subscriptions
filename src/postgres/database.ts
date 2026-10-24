import type { z } from 'zod';
import { ErrorCode } from '../constants.js';
import { SubscriptionError } from '../errors.js';
import type { PostgresQueryable } from './client.js';
import { SqlState } from './constants.js';

export type Row = Record<string, unknown>;

/** Field paths and messages only: record values (customer data) never go into an error. */
const MAX_REPORTED_ISSUES = 5;

/**
 * Runs statements for a store and turns driver failures into `SubscriptionError`. The message carries the SQLSTATE and
 * never the statement or its values; the driver's error stays on `cause`.
 */
export class Database {
  constructor(
    private readonly db: PostgresQueryable,
    private readonly owner: string,
  ) {}

  async rows(text: string, values: unknown[] = []): Promise<Row[]> {
    try {
      const result = await this.db.query(text, values);
      return [...result.rows];
    } catch (cause) {
      throw this.failure(cause);
    }
  }

  private failure(cause: unknown): SubscriptionError {
    const state = sqlStateOf(cause);
    if (state === SqlState.UndefinedTable) {
      return new SubscriptionError(
        ErrorCode.Config,
        `The ${this.owner} cannot find its PostgreSQL tables: run migratePostgres with the same schema and tablePrefix first`,
        { cause },
      );
    }
    return new SubscriptionError(
      ErrorCode.Internal,
      `The ${this.owner} could not complete a PostgreSQL statement${state === undefined ? '' : ` (${state})`}`,
      { cause },
    );
  }

  /** Reads the `record` column of a row and validates it against its schema. */
  parseRecord<S extends z.ZodType>(schema: S, row: Row | undefined, what: string): z.output<S> | undefined {
    if (row === undefined) return undefined;
    // pg returns jsonb already parsed; a driver that returns text is handled too.
    const raw = typeof row['record'] === 'string' ? safeJson(row['record']) : row['record'];
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      throw new SubscriptionError(
        ErrorCode.Internal,
        `The ${this.owner} holds a ${what} record that does not match its schema (${summarise(parsed.error)})`,
      );
    }
    return parsed.data;
  }
}

/** The SQLSTATE of a driver error, or of the driver error a `SubscriptionError` wraps. */
export function sqlStateOf(error: unknown): string | undefined {
  for (let current: unknown = error, depth = 0; depth < 3 && current instanceof Error; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && code.length === 5) return code;
    current = current.cause;
  }
  return undefined;
}

/** Refuses a record the store could not read again, so a bad write can never poison a row. */
export function validateRecord<S extends z.ZodType>(owner: string, schema: S, value: unknown, what: string): z.output<S> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new SubscriptionError(
      ErrorCode.Validation,
      `The ${owner} refused to save an invalid ${what} record (${summarise(parsed.error)})`,
    );
  }
  return parsed.data;
}

/** An instant as the database needs it, or `VALIDATION`. Offsets are fine: the database converts them to UTC. */
export function assertInstant(value: string, what: string): string {
  if (Number.isNaN(Date.parse(value))) {
    throw new SubscriptionError(ErrorCode.Validation, `${what} must be an ISO-8601 instant`);
  }
  return value;
}

/** A non-negative whole number of rows, clamped; anything else is zero. */
export function rowLimit(limit: number): number {
  return Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function summarise(error: z.ZodError): string {
  const shown = error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.map(String).join('.') : '(root)';
    return `${where}: ${issue.message}`;
  });
  const more = error.issues.length - shown.length;
  return more > 0 ? `${shown.join('; ')}; and ${more} more` : shown.join('; ');
}
