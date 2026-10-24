import { ErrorCode } from '../constants.js';
import { SubscriptionError } from '../errors.js';
import type { PostgresStoreOptions } from './client.js';
import {
  DEFAULT_SCHEMA,
  DEFAULT_TABLE_PREFIX,
  IDENTIFIER_PATTERN,
  MAX_IDENTIFIER_BYTES,
  PostgresIndex,
  PostgresTable,
} from './constants.js';

/** Quotes an identifier: wraps it in double quotes and doubles any double quote inside. */
export function quoteIdentifier(identifier: string): string {
  if (identifier.includes('\0')) {
    throw new SubscriptionError(ErrorCode.Config, 'A PostgreSQL identifier cannot contain a zero byte');
  }
  return `"${identifier.replaceAll('"', '""')}"`;
}

/**
 * The quoted, schema-qualified names of every table and index. Built once per store from validated options: nothing
 * but these strings (and bound parameters) ever reaches a statement.
 */
export interface PostgresNames {
  /** The schema name as given (unquoted), for `CREATE SCHEMA` and the migration lock. */
  readonly schemaName: string;
  /** The quoted schema name. */
  readonly schema: string;
  /** The quoted table name without the schema. */
  readonly tableName: (table: PostgresTable) => string;
  /** The quoted, schema-qualified table name. */
  readonly table: (table: PostgresTable) => string;
  /** The quoted name of an index (indexes live in their table's schema). */
  readonly index: (index: PostgresIndex) => string;
}

/** Validates the options and resolves every name. Throws `CONFIG` for a schema or prefix that is not an identifier. */
export function resolveNames(options: PostgresStoreOptions = {}): PostgresNames {
  const schemaName = options.schema ?? DEFAULT_SCHEMA;
  const prefix = options.tablePrefix ?? DEFAULT_TABLE_PREFIX;
  assertIdentifier(schemaName, 'schema', 1);
  assertIdentifier(prefix, 'tablePrefix', 0);

  const longest = [...Object.values(PostgresTable), ...Object.values(PostgresIndex)].map((name) => prefix + name);
  const tooLong = longest.find((name) => name.length > MAX_IDENTIFIER_BYTES);
  if (tooLong !== undefined) {
    throw new SubscriptionError(
      ErrorCode.Config,
      `tablePrefix ${JSON.stringify(prefix)} is too long: PostgreSQL truncates identifiers to ${MAX_IDENTIFIER_BYTES} ` +
        `bytes, and ${JSON.stringify(tooLong)} would collide with another name`,
    );
  }

  const schema = quoteIdentifier(schemaName);
  return {
    schemaName,
    schema,
    tableName: (table) => quoteIdentifier(prefix + table),
    table: (table) => `${schema}.${quoteIdentifier(prefix + table)}`,
    index: (index) => quoteIdentifier(prefix + index),
  };
}

function assertIdentifier(value: unknown, option: string, minLength: number): asserts value is string {
  const valid =
    typeof value === 'string' &&
    value.length >= minLength &&
    value.length <= MAX_IDENTIFIER_BYTES &&
    (value === '' || IDENTIFIER_PATTERN.test(value));
  if (!valid) {
    throw new SubscriptionError(
      ErrorCode.Config,
      `The PostgreSQL ${option} must be at most ${MAX_IDENTIFIER_BYTES} characters of letters, digits and underscores, ` +
        'not starting with a digit',
    );
  }
}
