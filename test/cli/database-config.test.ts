import { describe, expect, it } from 'vitest';
import { DEFAULT_SCHEMA, DEFAULT_TABLE_PREFIX } from '../../src/postgres/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  DEFAULT_DATABASE_POOL_SIZE,
  EnvVar,
  MAX_DATABASE_POOL_SIZE,
  parseServiceEnv,
  schedulerEnabled,
  type EnvironmentVariables,
} from '../../src/service-config.js';

const API_KEY = 'a-long-random-service-api-key';
const PASSWORD = 'db-password-that-must-never-be-printed';
const URL = `postgres://billing:${PASSWORD}@db.internal:5432/billing`;
const RAZORPAY: EnvironmentVariables = { [EnvVar.RazorpayKeyId]: 'rzp_test_id', [EnvVar.RazorpayKeySecret]: 'rzp-secret' };

const parse = (env: EnvironmentVariables) => parseServiceEnv({ [EnvVar.ApiKey]: API_KEY, ...RAZORPAY, ...env });

function failure(env: EnvironmentVariables): string {
  try {
    parse(env);
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    const message = (error as SubscriptionError).message;
    expect(message).not.toContain(PASSWORD);
    expect(message).not.toContain('db.internal');
    return message;
  }
  throw new Error('expected parseServiceEnv to throw');
}

describe('DATABASE_URL', () => {
  it('is off by default: no database, and the scheduler follows its file', () => {
    const config = parse({});
    expect(config.database).toBeUndefined();
    expect(schedulerEnabled(config)).toBe(false);
    expect(schedulerEnabled(parse({ [EnvVar.SchedulerStoreFile]: '/tmp/scheduler.json' }))).toBe(true);
  });

  it('turns the database on with the default schema, prefix and pool size, and the scheduler with it', () => {
    const config = parse({ [EnvVar.DatabaseUrl]: URL });
    expect(config.database).toEqual({ url: URL, schema: DEFAULT_SCHEMA, tablePrefix: DEFAULT_TABLE_PREFIX, poolSize: DEFAULT_DATABASE_POOL_SIZE });
    expect(schedulerEnabled(config)).toBe(true);
  });

  it('treats a blank value as absent', () => {
    expect(parse({ [EnvVar.DatabaseUrl]: '   ' }).database).toBeUndefined();
  });

  it('accepts postgres:// and postgresql:// and nothing else, without echoing the value', () => {
    expect(parse({ [EnvVar.DatabaseUrl]: 'postgresql://u:p@h/db' }).database?.url).toBe('postgresql://u:p@h/db');
    for (const bad of [`mysql://billing:${PASSWORD}@db.internal/billing`, `${PASSWORD}`, `http://billing:${PASSWORD}@db.internal/x`]) {
      expect(failure({ [EnvVar.DatabaseUrl]: bad })).toContain(`${EnvVar.DatabaseUrl}: must be a postgres:// or postgresql:// connection string`);
    }
  });

  it('reads the schema, the table prefix and the pool size', () => {
    const config = parse({
      [EnvVar.DatabaseUrl]: URL,
      [EnvVar.DatabaseSchema]: 'billing',
      [EnvVar.DatabaseTablePrefix]: 'prod_',
      [EnvVar.DatabasePoolSize]: '25',
    });
    expect(config.database).toMatchObject({ schema: 'billing', tablePrefix: 'prod_', poolSize: 25 });
  });

  it.each([
    [EnvVar.DatabaseSchema, 'bad-schema'],
    [EnvVar.DatabaseSchema, '1schema'],
    [EnvVar.DatabaseSchema, `x${'y'.repeat(70)}`],
    [EnvVar.DatabaseTablePrefix, 'bad prefix'],
    [EnvVar.DatabaseTablePrefix, 'p'.repeat(60)],
  ])('refuses %s=%s, naming the variable and the rule', (name, value) => {
    const message = failure({ [EnvVar.DatabaseUrl]: URL, [name]: value });
    expect(message).toContain(`${name}: must be at most 63 characters of letters, digits and underscores`);
    expect(message).not.toContain(value);
  });

  it.each(['0', '201', 'ten', '1.5'])('refuses a pool size of %s', (value) => {
    expect(failure({ [EnvVar.DatabaseUrl]: URL, [EnvVar.DatabasePoolSize]: value })).toContain(`${EnvVar.DatabasePoolSize}:`);
  });

  it(`accepts a pool size up to ${MAX_DATABASE_POOL_SIZE}`, () => {
    expect(parse({ [EnvVar.DatabaseUrl]: URL, [EnvVar.DatabasePoolSize]: String(MAX_DATABASE_POOL_SIZE) }).database?.poolSize).toBe(MAX_DATABASE_POOL_SIZE);
  });

  it.each([EnvVar.DatabaseSchema, EnvVar.DatabaseTablePrefix, EnvVar.DatabasePoolSize])('needs DATABASE_URL when %s is set', (name) => {
    expect(failure({ [name]: name === EnvVar.DatabasePoolSize ? '5' : 'billing' })).toContain(`${EnvVar.DatabaseUrl}: is required when ${name} is set`);
  });
});

describe('DATABASE_URL together with the files', () => {
  it('is an error with a scheduler store file, naming both variables', () => {
    const message = failure({ [EnvVar.DatabaseUrl]: URL, [EnvVar.SchedulerStoreFile]: '/tmp/scheduler.json' });
    expect(message).toContain(`${EnvVar.DatabaseUrl} and ${EnvVar.SchedulerStoreFile} cannot both be set`);
  });

  it('is an error with a purchase store file, naming both variables', () => {
    const message = failure({ [EnvVar.DatabaseUrl]: URL, [EnvVar.PurchasesFile]: '/tmp/p.json', [EnvVar.PurchaseStoreFile]: '/tmp/state.json' });
    expect(message).toContain(`${EnvVar.DatabaseUrl} and ${EnvVar.PurchaseStoreFile} cannot both be set`);
  });

  it('reports both conflicts in one pass, with every other problem', () => {
    const message = failure({
      [EnvVar.DatabaseUrl]: URL,
      [EnvVar.SchedulerStoreFile]: '/tmp/scheduler.json',
      [EnvVar.PurchasesFile]: '/tmp/p.json',
      [EnvVar.PurchaseStoreFile]: '/tmp/state.json',
      [EnvVar.Port]: 'many',
    });
    expect(message).toContain(`${EnvVar.DatabaseUrl} and ${EnvVar.SchedulerStoreFile}`);
    expect(message).toContain(`${EnvVar.DatabaseUrl} and ${EnvVar.PurchaseStoreFile}`);
    expect(message).toContain(`${EnvVar.Port}:`);
  });

  it('needs no purchase store file with a purchases file: the database is the store', () => {
    const config = parse({ [EnvVar.DatabaseUrl]: URL, [EnvVar.PurchasesFile]: '/tmp/p.json' });
    expect(config.purchasesFile).toBe('/tmp/p.json');
    expect(config.purchaseStoreFile).toBeUndefined();
  });

  it('still needs the purchase store file without a database, and says the database is the other way', () => {
    const message = failure({ [EnvVar.PurchasesFile]: '/tmp/p.json' });
    expect(message).toContain(`${EnvVar.PurchaseStoreFile}: is required when ${EnvVar.PurchasesFile} is set`);
    expect(message).toContain(EnvVar.DatabaseUrl);
  });

  it('still needs a purchases file for a purchase store file', () => {
    expect(failure({ [EnvVar.PurchaseStoreFile]: '/tmp/state.json' })).toContain(`${EnvVar.PurchasesFile}: is required when ${EnvVar.PurchaseStoreFile} is set`);
  });

  it('warns about a missing public URL when purchases are kept in the database', () => {
    expect(parse({ [EnvVar.DatabaseUrl]: URL, [EnvVar.PurchasesFile]: '/tmp/p.json' }).warnings.join('\n')).toContain(EnvVar.PublicBaseUrl);
  });

  it('keeps the files working without a database', () => {
    const config = parse({ [EnvVar.SchedulerStoreFile]: '/tmp/s.json', [EnvVar.PurchasesFile]: '/tmp/p.json', [EnvVar.PurchaseStoreFile]: '/tmp/state.json' });
    expect(config).toMatchObject({ schedulerStoreFile: '/tmp/s.json', purchaseStoreFile: '/tmp/state.json', database: undefined });
  });
});
