import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ErrorCode } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { ReportStatus, SessionStatus } from '../../src/purchase/index.js';
import {
  FilePurchaseStore,
  PURCHASE_STORE_FORMAT,
  PURCHASE_STORE_MODE,
  PURCHASE_STORE_VERSION,
} from '../../src/purchase-file-store.js';
import { MINUTE, T0 } from '../purchase/helpers.js';
import { entitlement, purchaseStoreSuite, report, session } from '../purchase/store-suite.js';

let dir: string;
const open: FilePurchaseStore[] = [];
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-purchase-store-'));
});
afterEach(async () => {
  for (const store of open.splice(0)) await store.close();
  await rm(dir, { recursive: true, force: true });
});

let counter = 0;
async function openStore(path = join(dir, 'purchases.json'), options: { now?: () => number } = {}): Promise<FilePurchaseStore> {
  const store = await FilePurchaseStore.open(path, options);
  open.push(store);
  return store;
}

// Every behaviour the memory store is held to (copies, ordering, lookups, the lock, the outbox and its lease).
purchaseStoreSuite('FilePurchaseStore', async (options) => {
  counter += 1;
  const store = await FilePurchaseStore.open(join(dir, `suite-${counter}.json`), options);
  open.push(store);
  return store;
});

describe('FilePurchaseStore: the file', () => {
  it('creates the file and its directory at startup, with mode 0600, in the documented format', async () => {
    const path = join(dir, 'nested', 'deeper', 'purchases.json');
    await openStore(path);
    const written = JSON.parse(await readFile(path, 'utf8'));
    expect(written).toEqual({
      format: PURCHASE_STORE_FORMAT,
      version: PURCHASE_STORE_VERSION,
      sessions: [],
      entitlements: [],
      reports: [],
    });
    if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(PURCHASE_STORE_MODE);
  });

  it('tightens the mode of an existing file', async () => {
    if (process.platform === 'win32') return;
    const path = join(dir, 'purchases.json');
    await (await openStore(path)).close();
    const { chmod } = await import('node:fs/promises');
    await chmod(path, 0o644);
    await openStore(path);
    expect((await stat(path)).mode & 0o777).toBe(PURCHASE_STORE_MODE);
  });

  it('everything a resolved write saved is there after reopening, byte for byte', async () => {
    const path = join(dir, 'purchases.json');
    const first = await openStore(path);
    await first.saveSession(session());
    await first.saveSession(session({ id: 'ps_2', reference: 'r2', status: SessionStatus.Completed }));
    await first.saveEntitlement(entitlement());
    expect(await first.enqueueReport(report())).toBe(true);
    // No close: a crash right after the writes resolved must lose nothing.
    const second = await openStore(path);
    expect((await second.getSession('ps_2'))?.status).toBe(SessionStatus.Completed);
    expect((await second.getSession('ps_1'))?.options[0]?.handle).toBe('sub_1');
    expect((await second.getEntitlement('ent_1'))?.status).toBe('active');
    expect((await second.getReport('ext_1'))?.status).toBe(ReportStatus.Queued);
  });

  it('leaves no temporary file behind and never writes a torn file under concurrent writes', async () => {
    const path = join(dir, 'purchases.json');
    const store = await openStore(path);
    await Promise.all(Array.from({ length: 25 }, (_, i) => store.saveSession(session({ id: `ps_${i}`, reference: `r${i}` }))));
    expect(await readdir(dir)).toEqual(['purchases.json']);
    const reopened = await openStore(path);
    for (let i = 0; i < 25; i += 1) expect(await reopened.getSession(`ps_${i}`)).toBeDefined();
  });

  it('does not change what is stored when a write is refused', async () => {
    const store = await openStore();
    await store.saveSession(session());
    const bad = { ...session(), status: 'nonsense' } as unknown as ReturnType<typeof session>;
    const error = await store.saveSession(bad).catch((e: unknown) => e);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Validation);
    expect((await store.getSession('ps_1'))?.status).toBe(SessionStatus.Open);
    // The refusal names fields, never values.
    expect((error as SubscriptionError).message).not.toContain('nonsense');
    // And the store still writes.
    await store.saveSession(session({ id: 'ps_2', reference: 'r2' }));
    expect(await store.getSession('ps_2')).toBeDefined();
  });

  it('refuses writes after close, and close waits for the writes in flight', async () => {
    const path = join(dir, 'purchases.json');
    const store = await openStore(path);
    const pending = store.saveSession(session());
    await store.close();
    await pending;
    expect(await (await openStore(path)).getSession('ps_1')).toBeDefined();
    const error = await store.saveSession(session({ id: 'ps_9', reference: 'r9' })).catch((e: unknown) => e);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Internal);
  });
});

describe('FilePurchaseStore: the outbox', () => {
  it('of many concurrent enqueues of one id, exactly one stores', async () => {
    const store = await openStore();
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => store.enqueueReport(report({ attempts: i }))));
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await store.claimDueReports(T0, 10, MINUTE)).toHaveLength(1);
  });

  it('a lease is not written to the file: after a restart every queued report is claimable again', async () => {
    const path = join(dir, 'purchases.json');
    const first = await openStore(path);
    await first.enqueueReport(report());
    const [claimed] = await first.claimDueReports(T0, 1, 5 * MINUTE);
    expect(claimed?.leaseToken).toBeDefined();
    expect(await first.claimDueReports(T0, 1, 5 * MINUTE)).toEqual([]);
    const onDisk = JSON.parse(await readFile(path, 'utf8')) as { reports: Array<Record<string, unknown>> };
    expect(onDisk.reports[0]).not.toHaveProperty('leaseToken');
    expect(onDisk.reports[0]).not.toHaveProperty('leaseUntil');

    const second = await openStore(path);
    const [again] = await second.claimDueReports(T0, 1, 5 * MINUTE);
    expect(again?.id).toBe('ext_1');
    // The old claimer's token means nothing to the new process.
    expect(await second.saveReport({ ...again!, status: ReportStatus.Sent }, claimed!.leaseToken as string)).toBe(false);
    expect(await second.saveReport({ ...again!, status: ReportStatus.Sent, leaseToken: undefined, leaseUntil: undefined }, again!.leaseToken as string)).toBe(true);
  });

  it('a saved report is durable before saveReport resolves', async () => {
    const path = join(dir, 'purchases.json');
    const store = await openStore(path);
    await store.enqueueReport(report());
    const [claimed] = await store.claimDueReports(T0, 1, MINUTE);
    await store.saveReport(
      { ...claimed!, status: ReportStatus.Sent, sentAt: T0, leaseToken: undefined, leaseUntil: undefined },
      claimed!.leaseToken as string,
    );
    const stored = await (await openStore(path)).getReport('ext_1');
    expect(stored?.status).toBe(ReportStatus.Sent);
    expect(stored?.sentAt).toBe(T0);
  });
});

describe('FilePurchaseStore: a file that is not ours', () => {
  const cases: Array<[string, string]> = [
    ['not JSON', '{nope'],
    ['a different format', JSON.stringify({ format: 'something/else', version: 1, sessions: [], entitlements: [], reports: [] })],
    ['a different version', JSON.stringify({ format: PURCHASE_STORE_FORMAT, version: 99, sessions: [], entitlements: [], reports: [] })],
    ['a scheduler store file', JSON.stringify({ format: 'india-subscriptions/scheduler-store', version: 1, schedules: [], cycles: [] })],
    ['an invalid record', JSON.stringify({ format: PURCHASE_STORE_FORMAT, version: 1, sessions: [{ id: 'x' }], entitlements: [], reports: [] })],
  ];
  for (const [name, content] of cases) {
    it(`refuses ${name} with CONFIG and leaves it untouched`, async () => {
      const path = join(dir, 'foreign.json');
      await writeFile(path, content);
      const error = await FilePurchaseStore.open(path).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
      expect(await readFile(path, 'utf8')).toBe(content);
    });
  }

  it('refuses a file that holds one id twice', async () => {
    const path = join(dir, 'dup.json');
    const record = session();
    await writeFile(
      path,
      JSON.stringify({ format: PURCHASE_STORE_FORMAT, version: 1, sessions: [record, record], entitlements: [], reports: [] }),
    );
    const error = await FilePurchaseStore.open(path).catch((e: unknown) => e);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
    expect((error as SubscriptionError).message).toContain('twice');
  });

  it('needs a path', async () => {
    const error = await FilePurchaseStore.open('  ').catch((e: unknown) => e);
    expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
  });

  it('reports an unwritable location at startup', async () => {
    await writeFile(join(dir, 'plain'), 'x');
    const blocked = await FilePurchaseStore.open(join(dir, 'plain', 'purchases.json')).catch((e: unknown) => e);
    expect((blocked as SubscriptionError).code).toBe(ErrorCode.Internal);
  });
});
