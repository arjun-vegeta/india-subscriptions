import { describe, expect, it } from 'vitest';
import { Provider } from '../../src/constants.js';
import {
  ReportKind,
  ReportStatus,
  SessionStatus,
  type EntitlementRecord,
  type PurchaseSessionRecord,
  type PurchaseStore,
  type ReportRecord,
} from '../../src/purchase/index.js';
import { FakeClock, MINUTE, T0 } from './helpers.js';

export const session = (fields: Partial<PurchaseSessionRecord> = {}): PurchaseSessionRecord => ({
  id: 'ps_1',
  platform: 'web',
  product: 'pro',
  policy: 'gateways',
  status: SessionStatus.Open,
  customerRef: 'c1',
  reference: 'ref1',
  options: [
    {
      channel: 'gateway',
      provider: Provider.Razorpay,
      checkout: { kind: 'redirect', url: 'https://pay.example/1' },
      handle: 'sub_1',
    },
  ],
  attempts: [],
  createdAt: T0,
  expiresAt: '2026-11-23T10:30:00.000Z',
  customer: { name: 'A' },
  kind: 'subscription',
  amount: 100,
  trial: false,
  ...fields,
});

export const entitlement = (fields: Partial<EntitlementRecord> = {}): EntitlementRecord => ({
  id: 'ent_1',
  customerRef: 'c1',
  sessionId: 'ps_1',
  product: 'pro',
  kind: 'subscription',
  provider: Provider.Razorpay,
  channel: 'gateway',
  platform: 'web',
  subscriptionId: 'sub_1',
  status: 'active',
  updatedAt: T0,
  amount: 100,
  ...fields,
});

export const report = (fields: Partial<ReportRecord> = {}): ReportRecord => ({
  id: 'ext_1',
  kind: ReportKind.Transaction,
  status: ReportStatus.Queued,
  sessionId: 'ps_1',
  customerRef: 'c1',
  product: 'pro',
  createdAt: T0,
  dueBy: '2026-11-23T10:30:00.000Z',
  attempts: 0,
  nextAttemptAt: T0,
  ...fields,
});


/** Builds a store under test. `now` is the lock clock, in epoch milliseconds. */
export type StoreFactory = (options?: { now?: () => number }) => Promise<PurchaseStore>;

export interface PurchaseStoreSuiteOptions {
  /**
   * True (the default) when the store judges lock expiry on a clock the test can inject. A store that asks the
   * database for the time sets it to false and tests expiry itself.
   */
  injectableClock?: boolean;
}

/** The behaviours every `PurchaseStore` must have (see the guarantees documented on the interface). */
export function purchaseStoreSuite(name: string, make: StoreFactory, options: PurchaseStoreSuiteOptions = {}): void {
  const injectableClock = options.injectableClock ?? true;
  describe(`${name}: sessions`, () => {
    it('reads its own writes and hands out copies', async () => {
      const store = await make();
      const original = session();
      await store.saveSession(original);
      original.status = SessionStatus.Completed;
      original.options[0]!.handle = 'changed';
      const read = await store.getSession('ps_1');
      expect(read?.status).toBe(SessionStatus.Open);
      expect(read?.options[0]?.handle).toBe('sub_1');
      read!.status = SessionStatus.Failed;
      expect((await store.getSession('ps_1'))?.status).toBe(SessionStatus.Open);
      expect(await store.getSession('missing')).toBeUndefined();
    });

    it('finds a session by customer and reference, the newest when several match', async () => {
      const store = await make();
      await store.saveSession(session({ id: 'old', createdAt: '2026-11-20T00:00:00.000Z' }));
      await store.saveSession(session({ id: 'new', createdAt: '2026-11-21T00:00:00.000Z' }));
      await store.saveSession(session({ id: 'other', customerRef: 'c2' }));
      expect((await store.findSessionByReference('c1', 'ref1'))?.id).toBe('new');
      expect((await store.findSessionByReference('c2', 'ref1'))?.id).toBe('other');
      expect(await store.findSessionByReference('c1', 'nope')).toBeUndefined();
    });

    it('finds a session by an option handle or by the id it completed with, per provider', async () => {
      const store = await make();
      await store.saveSession(session());
      await store.saveSession(session({ id: 'ps_2', reference: 'r2', provider: Provider.AppStore, subscriptionId: 'store_9', options: [] }));
      expect((await store.findSessionByHandle(Provider.Razorpay, 'sub_1'))?.id).toBe('ps_1');
      expect(await store.findSessionByHandle(Provider.Cashfree, 'sub_1')).toBeUndefined();
      expect((await store.findSessionByHandle(Provider.AppStore, 'store_9'))?.id).toBe('ps_2');
      expect(await store.findSessionByHandle(Provider.Razorpay, 'store_9')).toBeUndefined();
    });
  });

  describe(`${name}: entitlements`, () => {
    it('lists a customer\'s items newest first and finds one by the provider\'s id', async () => {
      const store = await make();
      await store.saveEntitlement(entitlement());
      await store.saveEntitlement(entitlement({ id: 'ent_2', subscriptionId: undefined, paymentId: 'pay_1', kind: 'one_time', updatedAt: '2026-11-22T11:00:00.000Z' }));
      await store.saveEntitlement(entitlement({ id: 'ent_3', customerRef: 'c2' }));
      expect((await store.listEntitlements('c1')).map((e) => e.id)).toEqual(['ent_2', 'ent_1']);
      expect((await store.findEntitlement(Provider.Razorpay, { subscriptionId: 'sub_1' }))?.id).toBe('ent_1');
      expect((await store.findEntitlement(Provider.Razorpay, { paymentId: 'pay_1' }))?.id).toBe('ent_2');
      expect(await store.findEntitlement(Provider.Cashfree, { subscriptionId: 'sub_1' })).toBeUndefined();
      expect(await store.listEntitlements('nobody')).toEqual([]);
    });

    it('saves by id (upsert) and returns copies', async () => {
      const store = await make();
      const record = entitlement();
      await store.saveEntitlement(record);
      record.status = 'cancelled';
      await store.saveEntitlement(entitlement({ updatedAt: '2026-11-22T12:00:00.000Z' }));
      const listed = await store.listEntitlements('c1');
      expect(listed).toHaveLength(1);
      expect(listed[0]?.status).toBe('active');
      listed[0]!.status = 'paused';
      expect((await store.getEntitlement('ent_1'))?.status).toBe('active');
    });
  });

  describe(`${name}: the report outbox`, () => {
    it('enqueue inserts only when the id is free and leaves the stored report alone', async () => {
      const store = await make();
      expect(await store.enqueueReport(report())).toBe(true);
      expect(await store.enqueueReport(report({ attempts: 9 }))).toBe(false);
      expect((await store.getReport('ext_1'))?.attempts).toBe(0);
      expect(await store.getReport('nope')).toBeUndefined();
    });

    it('claims due reports, most urgent first, with a lease, and never twice', async () => {
      const store = await make();
      await store.enqueueReport(report({ id: 'late', dueBy: '2026-11-24T00:00:00.000Z' }));
      await store.enqueueReport(report({ id: 'urgent', dueBy: '2026-11-23T00:00:00.000Z' }));
      await store.enqueueReport(report({ id: 'later', nextAttemptAt: '2026-11-22T12:00:00.000Z' }));
      await store.enqueueReport(report({ id: 'sent', status: ReportStatus.Sent }));
      const claimed = await store.claimDueReports(T0, 10, 5 * MINUTE);
      expect(claimed.map((r) => r.id)).toEqual(['urgent', 'late']);
      expect(claimed.every((r) => r.leaseToken && r.leaseUntil === '2026-11-22T10:35:00.000Z')).toBe(true);
      expect(claimed[0]?.leaseToken).not.toBe(claimed[1]?.leaseToken);
      expect(await store.claimDueReports(T0, 10, 5 * MINUTE)).toEqual([]);
      expect(await store.claimDueReports('2026-11-22T10:34:59.000Z', 10, 5 * MINUTE)).toEqual([]);
      expect((await store.claimDueReports('2026-11-22T10:35:00.000Z', 1, 5 * MINUTE)).map((r) => r.id)).toEqual(['urgent']);
    });

    it('respects the limit', async () => {
      const store = await make();
      for (const id of ['a', 'b', 'c']) await store.enqueueReport(report({ id }));
      expect(await store.claimDueReports(T0, 2, MINUTE)).toHaveLength(2);
      expect(await store.claimDueReports(T0, 0, MINUTE)).toEqual([]);
    });

    it('saveReport only accepts the holder of the lease', async () => {
      const store = await make();
      await store.enqueueReport(report());
      const [claimed] = await store.claimDueReports(T0, 1, MINUTE);
      expect(await store.saveReport({ ...claimed!, status: ReportStatus.Sent }, 'wrong-token')).toBe(false);
      expect((await store.getReport('ext_1'))?.status).toBe(ReportStatus.Queued);
      expect(await store.saveReport({ ...claimed!, status: ReportStatus.Sent }, claimed!.leaseToken as string)).toBe(true);
      expect((await store.getReport('ext_1'))?.status).toBe(ReportStatus.Sent);
      // A sent report is final.
      expect(await store.saveReport({ ...claimed!, status: ReportStatus.Queued }, claimed!.leaseToken as string)).toBe(false);
    });

    it('lists the queued reports whose deadline has passed, most overdue first', async () => {
      const store = await make();
      await store.enqueueReport(report({ id: 'a', dueBy: '2026-11-22T09:00:00.000Z' }));
      await store.enqueueReport(report({ id: 'b', dueBy: '2026-11-22T08:00:00.000Z', leaseUntil: '2026-11-22T11:00:00.000Z' }));
      await store.enqueueReport(report({ id: 'c', dueBy: T0 }));
      await store.enqueueReport(report({ id: 'd', dueBy: '2026-11-22T07:00:00.000Z', status: ReportStatus.Sent }));
      expect((await store.listOverdueReports(T0, 10)).map((r) => r.id)).toEqual(['b', 'a']);
      expect((await store.listOverdueReports(T0, 1)).map((r) => r.id)).toEqual(['b']);
    });
  });

  describe(`${name}: locks`, () => {
    it.runIf(injectableClock)('only one caller gets a lock, until it is released or expires', async () => {
      const clock = new FakeClock();
      const store = await make({ now: clock.epoch });
      const token = await store.acquireLock('k', 1000);
      expect(token).toBeDefined();
      expect(await store.acquireLock('k', 1000)).toBeUndefined();
      expect(await store.acquireLock('other', 1000)).toBeDefined();
      clock.advance(999);
      expect(await store.acquireLock('k', 1000)).toBeUndefined();
      clock.advance(1);
      const second = await store.acquireLock('k', 1000);
      expect(second).toBeDefined();
      expect(second).not.toBe(token);
      // A stale token cannot release the new holder's lock.
      await store.releaseLock('k', token as string);
      expect(await store.acquireLock('k', 1000)).toBeUndefined();
      await store.releaseLock('k', second as string);
      expect(await store.acquireLock('k', 1000)).toBeDefined();
    });

    it('of many concurrent callers exactly one wins', async () => {
      const store = await make();
      const tokens = await Promise.all(Array.from({ length: 20 }, () => store.acquireLock('k', 1000)));
      expect(tokens.filter((t) => t !== undefined)).toHaveLength(1);
    });

    it('releasing a lock nobody holds is a no-op', async () => {
      const store = await make();
      await expect(store.releaseLock('nothing', 'token')).resolves.toBeUndefined();
    });
  });
}
