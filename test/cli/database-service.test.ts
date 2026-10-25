/**
 * The service on PostgreSQL without a database: the driver is loaded through an injectable importer and replaced by a
 * recording pool, so what is checked here is the wiring (what is loaded, what is migrated, what is closed and when, what is
 * said and what is never said). The same service against a real database is in test/postgres/service.test.ts.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode, runCli } from '../../src/cli.js';
import { ErrorCode } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { LATEST_MIGRATION_VERSION } from '../../src/postgres/index.js';
import { DATABASE_DRIVER_PACKAGE, type DriverImporter } from '../../src/service-database.js';
import { EnvVar, type EnvironmentVariables } from '../../src/service-config.js';
import { buildService, runServe, silentLogger, type Logger, type RunningService } from '../../src/service.js';

const API_KEY = 'service-api-key-0123456789';
const PASSWORD = 'db-password-that-must-never-be-printed';
const HOST = 'db-host.internal.example';
const URL = `postgres://billing:${PASSWORD}@${HOST}:5432/billing`;
const SECRETS = [PASSWORD, HOST, URL];

const env: EnvironmentVariables = {
  [EnvVar.ApiKey]: API_KEY,
  [EnvVar.Port]: '0',
  [EnvVar.RazorpayKeyId]: 'rzp_test_id',
  [EnvVar.RazorpayKeySecret]: 'razorpay-key-secret-value',
  [EnvVar.DatabaseUrl]: URL,
  [EnvVar.SchedulerTickSeconds]: '3600',
};

function recordingLogger(): Logger & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    info: (m) => void lines.push(`info: ${m}`),
    warn: (m) => void lines.push(`warn: ${m}`),
    error: (m) => void lines.push(`error: ${m}`),
  };
}

/** Stands in for `pg.Pool`: records every statement, answers with no rows, and can hold the scheduler's query open. */
class RecordingPool {
  static last: RecordingPool | undefined;
  readonly statements: string[] = [];
  readonly events: string[] = [];
  readonly errorListeners: Array<(error: unknown) => void> = [];
  /** A promise the due-schedules query waits for; undefined: it answers at once. */
  hold: Promise<void> | undefined;
  unreachable: unknown;
  constructor(readonly config: { connectionString: string; max: number; connectionTimeoutMillis: number }) {
    RecordingPool.last = this;
  }
  on(_event: 'error', listener: (error: unknown) => void): this {
    this.errorListeners.push(listener);
    return this;
  }
  async query(text: string): Promise<{ rows: Array<Record<string, unknown>> }> {
    this.statements.push(text);
    if (this.unreachable !== undefined) throw this.unreachable;
    if (this.hold && text.includes('next_action_at <=')) {
      this.events.push('due-query-started');
      await this.hold;
      this.events.push('due-query-finished');
    }
    return { rows: [] };
  }
  async connect() {
    return { query: (text: string) => this.query(text), release: () => undefined };
  }
  async end(): Promise<void> {
    this.events.push('end');
  }
}

const withPool: DriverImporter = async () => ({ Pool: RecordingPool });

let running: RunningService | undefined;
afterEach(async () => {
  await running?.stop();
  running = undefined;
  RecordingPool.last = undefined;
});

async function failureOf(promise: Promise<unknown>): Promise<SubscriptionError> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SubscriptionError);
  for (const secret of SECRETS) expect((error as SubscriptionError).message).not.toContain(secret);
  return error as SubscriptionError;
}

describe('loading the driver', () => {
  it('names the package to install when it is missing, and never loads it without DATABASE_URL', async () => {
    let loads = 0;
    const missing: DriverImporter = async () => {
      loads += 1;
      throw Object.assign(new Error(`Cannot find package 'pg' imported from /srv/app`), { code: 'ERR_MODULE_NOT_FOUND' });
    };
    const error = await failureOf(buildService(env, { logger: silentLogger, importDriver: missing }));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain(`${EnvVar.DatabaseUrl} is set, but the PostgreSQL driver is not installed`);
    expect(error.message).toContain(`npm install ${DATABASE_DRIVER_PACKAGE}`);

    const { [EnvVar.DatabaseUrl]: _unset, ...withoutDatabase } = env;
    const service = await buildService(withoutDatabase, { logger: silentLogger, importDriver: missing });
    expect(loads).toBe(1);
    expect(service.scheduler).toBeUndefined();
  });

  it('also recognises the CommonJS code for a missing package', async () => {
    const error = await failureOf(
      buildService(env, { logger: silentLogger, importDriver: async () => { throw Object.assign(new Error('x'), { code: 'MODULE_NOT_FOUND' }); } }),
    );
    expect(error.message).toContain('is not installed');
  });

  it('says it could not be loaded, with the error code, when the package is there but broken', async () => {
    const error = await failureOf(buildService(env, { logger: silentLogger, importDriver: async () => { throw Object.assign(new SyntaxError(`bad ${URL}`), { code: 'ERR_REQUIRE_ESM' }); } }));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain('could not be loaded (ERR_REQUIRE_ESM)');
  });

  it('refuses a module that has no Pool', async () => {
    const error = await failureOf(buildService(env, { logger: silentLogger, importDriver: async () => ({ default: {} }) }));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain('has no Pool');
  });

  it('finds the Pool on the module and on its default export', async () => {
    for (const driver of [{ Pool: RecordingPool }, { default: { Pool: RecordingPool } }]) {
      const service = await buildService(env, { logger: silentLogger, importDriver: async () => driver });
      await service.close();
    }
  });

  it('does not repeat the connection string when the driver refuses it', async () => {
    class Refusing {
      constructor() {
        throw Object.assign(new TypeError(`Invalid URL: ${URL}`), { code: 'ERR_INVALID_URL', input: URL });
      }
    }
    const error = await failureOf(buildService(env, { logger: silentLogger, importDriver: async () => ({ Pool: Refusing }) }));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain(EnvVar.DatabaseUrl);
    expect(error.cause).toBeUndefined();
  });
});

describe('opening the database', () => {
  it('hands the driver the connection string, the pool size and a connection timeout, then migrates', async () => {
    const service = await buildService(
      { ...env, [EnvVar.DatabaseSchema]: 'billing', [EnvVar.DatabaseTablePrefix]: 'prod_', [EnvVar.DatabasePoolSize]: '7' },
      { logger: silentLogger, importDriver: withPool },
    );
    const pool = RecordingPool.last!;
    expect(pool.config).toMatchObject({ connectionString: URL, max: 7 });
    expect(pool.config.connectionTimeoutMillis).toBeGreaterThan(0);
    const sql = pool.statements.join('\n');
    expect(sql).toContain('SELECT 1');
    expect(sql).toContain('CREATE SCHEMA "billing"');
    expect(sql).toContain('"billing"."prod_schedules"');
    expect(sql).toContain('INSERT INTO "billing"."prod_migrations"');
    expect(LATEST_MIGRATION_VERSION).toBeGreaterThan(0);
    await service.close();
  });

  it('turns the scheduler on over the database store, with no store file', async () => {
    const service = await buildService(env, { logger: silentLogger, importDriver: withPool });
    expect(service.scheduler).toBeDefined();
    expect(service.store?.constructor.name).toBe('PostgresSchedulerStore');
    await service.close();
  });

  it('builds the purchase module over the database, with no store file', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-db-'));
    try {
      const file = join(dir, 'purchases.json');
      await writeFile(file, JSON.stringify({ catalog: [{ key: 'coins', kind: 'one_time', name: '100 coins', amount: 9900 }] }));
      const service = await buildService({ ...env, [EnvVar.PurchasesFile]: file }, { logger: silentLogger, importDriver: withPool });
      expect(service.purchases).toBeDefined();
      expect(service.purchaseStore?.constructor.name).toBe('PostgresPurchaseStore');
      await service.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('closes the pool when a later step of the start-up fails', async () => {
    const error = await failureOf(buildService({ ...env, [EnvVar.PurchasesFile]: '/nonexistent/purchases.json' }, { logger: silentLogger, importDriver: withPool }));
    expect(error.code).toBe(ErrorCode.Config);
    expect(RecordingPool.last?.events).toEqual(['end']);
  });

  it('fails with a clear error and closes the pool when the database cannot be reached, naming the code and nothing else', async () => {
    const importer: DriverImporter = async () => ({
      Pool: class extends RecordingPool {
        constructor(config: ConstructorParameters<typeof RecordingPool>[0]) {
          super(config);
          this.unreachable = Object.assign(new Error(`connect ECONNREFUSED ${HOST}:5432 for ${URL}`), { code: 'ECONNREFUSED' });
        }
      },
    });
    const error = await failureOf(buildService(env, { logger: silentLogger, importDriver: importer }));
    expect(error.code).toBe(ErrorCode.Internal);
    expect(error.message).toContain(`Cannot connect to the PostgreSQL database named by ${EnvVar.DatabaseUrl} (ECONNREFUSED)`);
    expect(error.cause).toBeUndefined();
    expect(RecordingPool.last?.events).toEqual(['end']);
  });

  it('refuses a schema written by a newer version of the library, as a configuration error', async () => {
    class NewerSchema extends RecordingPool {
      override async query(text: string) {
        const result = await super.query(text);
        return text.startsWith('SELECT version') ? { rows: [{ version: 999 }] } : result;
      }
    }
    const error = await failureOf(buildService(env, { logger: silentLogger, importDriver: async () => ({ Pool: NewerSchema }) }));
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain('upgrade the library');
  });

  it('reports a failed migration with the code only', async () => {
    class Denied extends RecordingPool {
      override async query(text: string) {
        if (text.startsWith('CREATE SCHEMA')) throw Object.assign(new Error(`permission denied for database billing (${URL})`), { code: '42501' });
        return super.query(text);
      }
    }
    const error = await failureOf(buildService(env, { logger: silentLogger, importDriver: async () => ({ Pool: Denied }) }));
    expect(error.code).toBe(ErrorCode.Internal);
    expect(error.message).toContain('The PostgreSQL migration failed');
    expect(RecordingPool.last?.events).toEqual(['end']);
  });

  it('logs a connection that fails while idle without the connection string, instead of crashing', async () => {
    const logger = recordingLogger();
    const service = await buildService(env, { logger, importDriver: withPool });
    for (const listener of RecordingPool.last!.errorListeners) listener(Object.assign(new Error(`terminating connection to ${HOST} ${URL}`), { code: '57P01' }));
    const output = logger.lines.join('\n');
    expect(output).toContain('a database connection failed (57P01)');
    for (const secret of SECRETS) expect(output).not.toContain(secret);
    await service.close();
  });
});

describe('the running service', () => {
  it('says which kind of store it uses and never where', async () => {
    const logger = recordingLogger();
    running = await runServe({ env, logger, importDriver: withPool });
    const output = logger.lines.join('\n');
    expect(output).toContain('billing scheduler: on (store PostgreSQL');
    expect(output).toContain('state store: PostgreSQL');
    for (const secret of [...SECRETS, 'razorpay-key-secret-value']) expect(output).not.toContain(secret);
  });

  it('closes the pool on shutdown, after the tick in flight', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    class Held extends RecordingPool {
      constructor(config: ConstructorParameters<typeof RecordingPool>[0]) {
        super(config);
        this.hold = hold;
      }
    }
    running = await runServe({ env, logger: silentLogger, importDriver: async () => ({ Pool: Held }) });
    const pool = RecordingPool.last!;
    await waitFor(() => pool.events.includes('due-query-started'));

    let stopped = false;
    const stopping = running.stop().then(() => {
      stopped = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stopped).toBe(false);
    expect(pool.events).not.toContain('end');

    release();
    await stopping;
    expect(pool.events).toEqual(['due-query-started', 'due-query-finished', 'end']);
    running = undefined;
  });

  it('closes the pool once when stopped twice', async () => {
    running = await runServe({ env, logger: silentLogger, importDriver: withPool });
    const pool = RecordingPool.last!;
    await running.stop();
    await running.stop();
    running = undefined;
    expect(pool.events.filter((event) => event === 'end')).toEqual(['end']);
  });

  it('closes the pool when it cannot listen', async () => {
    running = await runServe({ env, logger: silentLogger, importDriver: withPool });
    const taken = running.port;
    const first = RecordingPool.last!;
    const error = await runServe({ env: { ...env, [EnvVar.Port]: String(taken) }, logger: silentLogger, importDriver: withPool }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(RecordingPool.last).not.toBe(first);
    expect(RecordingPool.last?.events).toContain('end');
  });
});

describe('the command line', () => {
  const harness = () => {
    const out: string[] = [];
    const err: string[] = [];
    const environment: EnvironmentVariables = { ...env, [EnvVar.DatabaseUrl]: `postgres://billing:${PASSWORD}@127.0.0.1:1/billing` };
    return { io: { stdout: (t: string) => void out.push(t), stderr: (t: string) => void err.push(t), env: environment }, out, err };
  };

  it('exits non-zero with a clear message, and without the password, when the database is not reachable', async () => {
    const h = harness();
    expect(await runCli(['serve'], h.io)).toBe(ExitCode.Failure);
    const text = h.err.join('');
    expect(text).toContain(`Cannot connect to the PostgreSQL database named by ${EnvVar.DatabaseUrl}`);
    expect(text).not.toContain(PASSWORD);
    expect(h.out.join('')).not.toContain('listening on');
  });

  it('exits with the usage code for DATABASE_URL together with a store file, naming both', async () => {
    const h = harness();
    h.io.env = { ...h.io.env, [EnvVar.SchedulerStoreFile]: '/tmp/scheduler.json' };
    expect(await runCli(['serve'], h.io)).toBe(ExitCode.Usage);
    expect(h.err.join('')).toContain(`${EnvVar.DatabaseUrl} and ${EnvVar.SchedulerStoreFile} cannot both be set`);
    expect(h.err.join('')).not.toContain(PASSWORD);
  });
});

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
