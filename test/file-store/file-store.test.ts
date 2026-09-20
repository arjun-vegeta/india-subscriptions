import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChargeStatus, Currency, ErrorCode, IntervalUnit, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  CycleStatus,
  MemorySchedulerStore,
  ScheduleStatus,
  type CycleRecord,
  type ScheduleRecord,
  type SchedulerStore,
} from '../../src/scheduler/index.js';
import { FILE_STORE_FORMAT, FILE_STORE_MODE, FILE_STORE_VERSION, FileSchedulerStore } from '../../src/scheduler-file-store.js';

const T0 = '2026-01-01T00:00:00.000Z';
const HOUR = 60 * 60 * 1000;
const plusHours = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * HOUR).toISOString();

function schedule(id: string, overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id,
    provider: Provider.PayU,
    subscriptionId: `sub_${id}`,
    status: ScheduleStatus.Active,
    amount: 100,
    currency: Currency.INR,
    interval: { unit: IntervalUnit.Month, count: 1 },
    policy: { notifyLeadHours: 48, minNoticeHours: 24, maxAttempts: 3, retryIntervalHours: 24 },
    fingerprint: 'f',
    firstChargeAt: T0,
    anchorAt: T0,
    anchorIndex: 0,
    cycleIndex: 0,
    paidCycles: 0,
    retrying: false,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

function cycle(scheduleId: string, index: number): CycleRecord {
  return {
    scheduleId,
    index,
    status: CycleStatus.Pending,
    dueAt: T0,
    attemptDueAt: T0,
    attempt: 1,
    notificationRound: 1,
    attempts: [],
    createdAt: T0,
    updatedAt: T0,
  };
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-store-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const file = (): string => join(dir, 'scheduler.json');

/**
 * The observable contract of a `SchedulerStore` (the cases of
 * test/scheduler/memory-store.test.ts), run against both implementations.
 */
describe.each([
  ['MemorySchedulerStore', async (now?: () => number): Promise<SchedulerStore> => new MemorySchedulerStore({ now })],
  [
    'FileSchedulerStore',
    async (now?: () => number): Promise<SchedulerStore> => FileSchedulerStore.open(join(dir, 'contract.json'), { now }),
  ],
] as const)('%s: store contract', (_name, create) => {
  let store: SchedulerStore;
  beforeEach(async () => {
    store = await create();
  });

  it('copies records in and out', async () => {
    const original = schedule('a', { metadata: { k: 'v' } });
    await store.saveSchedule(original);
    original.amount = 999;
    original.metadata!.k = 'changed';

    const read = await store.getSchedule('a');
    expect(read?.amount).toBe(100);
    expect(read?.metadata).toEqual({ k: 'v' });

    read!.amount = 5;
    expect((await store.getSchedule('a'))?.amount).toBe(100);

    const c = cycle('a', 0);
    await store.saveCycle(c);
    c.attempts.push({ attempt: 1, chargeId: 'x', status: ChargeStatus.Failed, at: T0 });
    expect((await store.getCycle('a', 0))?.attempts).toHaveLength(0);
    (await store.getCycle('a', 0))!.attempt = 9;
    expect((await store.getCycle('a', 0))?.attempt).toBe(1);
  });

  it('returns undefined for missing records', async () => {
    expect(await store.getSchedule('nope')).toBeUndefined();
    expect(await store.getCycle('nope', 0)).toBeUndefined();
    expect(await store.listCycles('nope')).toEqual([]);
    expect(await store.findBySubscriptionId(Provider.PayU, 'nope')).toBeUndefined();
  });

  it('lists due schedules at or before an instant, oldest first, up to the limit', async () => {
    await store.saveSchedule(schedule('late', { nextActionAt: plusHours(T0, 5) }));
    await store.saveSchedule(schedule('early', { nextActionAt: plusHours(T0, 1) }));
    await store.saveSchedule(schedule('exact', { nextActionAt: plusHours(T0, 3) }));
    await store.saveSchedule(schedule('none'));
    await store.saveSchedule(schedule('cancelled', { status: ScheduleStatus.Cancelled, nextActionAt: plusHours(T0, 2) }));

    expect((await store.listDueSchedules(plusHours(T0, 3), 10)).map((s) => s.id)).toEqual(['early', 'cancelled', 'exact']);
    expect((await store.listDueSchedules(plusHours(T0, 3), 2)).map((s) => s.id)).toEqual(['early', 'cancelled']);
    expect(await store.listDueSchedules(T0, 10)).toEqual([]);
    expect((await store.listDueSchedules(plusHours(T0, 100), 10)).map((s) => s.id)).toHaveLength(4);
  });

  it('breaks nextActionAt ties by id', async () => {
    await store.saveSchedule(schedule('b', { nextActionAt: T0 }));
    await store.saveSchedule(schedule('a', { nextActionAt: T0 }));
    expect((await store.listDueSchedules(T0, 10)).map((s) => s.id)).toEqual(['a', 'b']);
    expect(await store.listDueSchedules(T0, 0)).toEqual([]);
  });

  it('follows nextActionAt as it changes', async () => {
    await store.saveSchedule(schedule('a', { nextActionAt: T0 }));
    expect(await store.listDueSchedules(T0, 10)).toHaveLength(1);
    const { nextActionAt: _removed, ...without } = schedule('a');
    await store.saveSchedule(without);
    expect(await store.listDueSchedules(T0, 10)).toHaveLength(0);
  });

  it('finds a schedule by provider and current subscription id, preferring the newest', async () => {
    await store.saveSchedule(schedule('old', { subscriptionId: 'shared', createdAt: T0 }));
    await store.saveSchedule(schedule('new', { subscriptionId: 'shared', createdAt: plusHours(T0, 1) }));
    await store.saveSchedule(schedule('other', { subscriptionId: 'shared', provider: Provider.Cashfree }));
    expect((await store.findBySubscriptionId(Provider.PayU, 'shared'))?.id).toBe('new');
    expect((await store.findBySubscriptionId(Provider.Cashfree, 'shared'))?.id).toBe('other');

    await store.saveSchedule(schedule('new', { subscriptionId: 'renamed', createdAt: plusHours(T0, 1) }));
    expect((await store.findBySubscriptionId(Provider.PayU, 'shared'))?.id).toBe('old');
  });

  it('lists cycles of one schedule ordered by index', async () => {
    await store.saveCycle(cycle('a', 2));
    await store.saveCycle(cycle('a', 0));
    await store.saveCycle(cycle('b', 0));
    await store.saveCycle(cycle('a', 1));
    expect((await store.listCycles('a')).map((c) => c.index)).toEqual([0, 1, 2]);
    expect(await store.listCycles('b')).toHaveLength(1);
  });

  it('upserts a cycle by (scheduleId, index)', async () => {
    await store.saveCycle(cycle('a', 0));
    await store.saveCycle({ ...cycle('a', 0), status: CycleStatus.Succeeded });
    expect(await store.listCycles('a')).toHaveLength(1);
    expect((await store.getCycle('a', 0))?.status).toBe(CycleStatus.Succeeded);
  });

  it('upserts a schedule by id', async () => {
    await store.saveSchedule(schedule('a'));
    await store.saveSchedule(schedule('a', { amount: 250 }));
    expect((await store.getSchedule('a'))?.amount).toBe(250);
    expect(await store.listDueSchedules(plusHours(T0, 1000), 10)).toEqual([]);
  });

  describe('locks', () => {
    it('grants a lock to exactly one of many concurrent callers', async () => {
      const tokens = await Promise.all(Array.from({ length: 10 }, () => store.acquireLock('a', 1000)));
      expect(tokens.filter((t) => t !== undefined)).toHaveLength(1);
    });

    it('locks are per schedule id, including ids that do not exist', async () => {
      expect(await store.acquireLock('a', 1000)).toBeDefined();
      expect(await store.acquireLock('b', 1000)).toBeDefined();
      expect(await store.acquireLock('a', 1000)).toBeUndefined();
    });

    it('releases only with the right token', async () => {
      const token = (await store.acquireLock('a', 1000))!;
      await store.releaseLock('a', 'wrong');
      expect(await store.acquireLock('a', 1000)).toBeUndefined();
      await store.releaseLock('a', token);
      expect(await store.acquireLock('a', 1000)).toBeDefined();
      await store.releaseLock('never-locked', 'x');
    });

    it('expires after the ttl, and a stale token cannot release the new holder', async () => {
      let now = 1_000;
      const timed = await create(() => now);
      const first = (await timed.acquireLock('a', 100))!;
      now = 1_099;
      expect(await timed.acquireLock('a', 100)).toBeUndefined();
      now = 1_100;
      const second = (await timed.acquireLock('a', 100))!;
      expect(second).not.toBe(first);

      await timed.releaseLock('a', first);
      expect(await timed.acquireLock('a', 100)).toBeUndefined();
      await timed.releaseLock('a', second);
      expect(await timed.acquireLock('a', 100)).toBeDefined();
    });
  });
});

describe('FileSchedulerStore: durability', () => {
  it('creates the file (and its directory) on open, with an empty store in it', async () => {
    const nested = join(dir, 'a', 'b', 'state.json');
    const store = await FileSchedulerStore.open(nested);
    expect(store.path).toBe(nested);
    const written = JSON.parse(await readFile(nested, 'utf8'));
    expect(written).toEqual({ format: FILE_STORE_FORMAT, version: FILE_STORE_VERSION, schedules: [], cycles: [] });
  });

  it('keeps everything across a restart', async () => {
    const first = await FileSchedulerStore.open(file());
    await first.saveSchedule(schedule('a', { nextActionAt: T0, reference: 'ref', metadata: { k: 'v' } }));
    await first.saveSchedule(schedule('b'));
    await first.saveCycle(cycle('a', 0));
    await first.saveCycle({ ...cycle('a', 1), attempts: [{ attempt: 1, chargeId: 'x', status: ChargeStatus.Failed, at: T0 }] });
    await first.close();

    const second = await FileSchedulerStore.open(file());
    expect((await second.getSchedule('a'))?.metadata).toEqual({ k: 'v' });
    expect((await second.getSchedule('b'))?.id).toBe('b');
    expect((await second.listCycles('a')).map((c) => c.index)).toEqual([0, 1]);
    expect((await second.getCycle('a', 1))?.attempts[0]?.chargeId).toBe('x');
    expect((await second.listDueSchedules(T0, 10)).map((s) => s.id)).toEqual(['a']);
    expect((await second.findBySubscriptionId(Provider.PayU, 'sub_a'))?.id).toBe('a');
  });

  it('is durable when a save resolves: a second reader sees it without the first closing', async () => {
    const store = await FileSchedulerStore.open(file());
    await store.saveSchedule(schedule('a'));
    const reader = await FileSchedulerStore.open(file());
    expect((await reader.getSchedule('a'))?.id).toBe('a');
  });

  it.skipIf(process.platform === 'win32')('writes the file with mode 0600 and tightens an existing file', async () => {
    const store = await FileSchedulerStore.open(file());
    await store.saveSchedule(schedule('a'));
    expect((await stat(file())).mode & 0o777).toBe(FILE_STORE_MODE);

    await chmod(file(), 0o644);
    await FileSchedulerStore.open(file());
    expect((await stat(file())).mode & 0o777).toBe(FILE_STORE_MODE);
    await store.saveSchedule(schedule('b'));
    expect((await stat(file())).mode & 0o777).toBe(FILE_STORE_MODE);
  });

  it('leaves no temp files behind', async () => {
    const store = await FileSchedulerStore.open(file());
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.saveSchedule(schedule(`s${i}`))));
    expect(await readdir(dir)).toEqual(['scheduler.json']);
  });

  it('serialises concurrent saves: the file is always whole and nothing is lost', async () => {
    const store = await FileSchedulerStore.open(file());
    const writes: Promise<void>[] = [];
    for (let i = 0; i < 40; i += 1) {
      writes.push(store.saveSchedule(schedule(`s${i}`, { nextActionAt: plusHours(T0, i) })));
      writes.push(store.saveCycle(cycle(`s${i % 5}`, i)));
      // A reader that opens the file mid-flight must never see a torn write.
      if (i % 8 === 0) writes.push(FileSchedulerStore.open(file()).then(() => undefined));
    }
    await Promise.all(writes);

    const reopened = await FileSchedulerStore.open(file());
    expect(await reopened.listDueSchedules(plusHours(T0, 1000), 100)).toHaveLength(40);
    let cycles = 0;
    for (let s = 0; s < 5; s += 1) cycles += (await reopened.listCycles(`s${s}`)).length;
    expect(cycles).toBe(40);
  });

  it('applies concurrent saves of one record in call order (last write wins)', async () => {
    const store = await FileSchedulerStore.open(file());
    await Promise.all([1, 2, 3, 4, 5].map((n) => store.saveSchedule(schedule('a', { amount: n }))));
    expect((await store.getSchedule('a'))?.amount).toBe(5);
    expect((await (await FileSchedulerStore.open(file())).getSchedule('a'))?.amount).toBe(5);
  });

  describe('refuses a file it did not write, and leaves it untouched', () => {
    const cases: [string, string][] = [
      ['garbage', 'this is not json {'],
      ['an empty file', ''],
      ['a JSON array', '[]'],
      ['another program\'s JSON', JSON.stringify({ hello: 'world' })],
      ['the wrong format name', JSON.stringify({ format: 'something-else', version: 1, schedules: [], cycles: [] })],
      ['a newer version', JSON.stringify({ format: FILE_STORE_FORMAT, version: FILE_STORE_VERSION + 1, schedules: [], cycles: [] })],
      [
        'a schedule record that is invalid',
        JSON.stringify({ format: FILE_STORE_FORMAT, version: FILE_STORE_VERSION, schedules: [{ id: 'x' }], cycles: [] }),
      ],
      [
        'a duplicated schedule id',
        JSON.stringify({
          format: FILE_STORE_FORMAT,
          version: FILE_STORE_VERSION,
          schedules: [schedule('dup'), schedule('dup')],
          cycles: [],
        }),
      ],
      [
        'a duplicated cycle',
        JSON.stringify({
          format: FILE_STORE_FORMAT,
          version: FILE_STORE_VERSION,
          schedules: [],
          cycles: [cycle('a', 0), cycle('a', 0)],
        }),
      ],
    ];

    it.each(cases)('%s', async (_label, content) => {
      await writeFile(file(), content, { mode: 0o600 });
      const error = await FileSchedulerStore.open(file()).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
      expect((error as SubscriptionError).message).toContain(file());
      expect(await readFile(file(), 'utf8')).toBe(content);
      expect(await readdir(dir)).toEqual(['scheduler.json']);
    });

    it('does not echo record values into the error', async () => {
      const bad = { ...schedule('x'), amount: 'SECRET-CUSTOMER-VALUE', customer: { email: 'private@example.com' } };
      await writeFile(file(), JSON.stringify({ format: FILE_STORE_FORMAT, version: FILE_STORE_VERSION, schedules: [bad], cycles: [] }));
      const error = (await FileSchedulerStore.open(file()).catch((e: unknown) => e)) as SubscriptionError;
      expect(error.message).not.toContain('SECRET-CUSTOMER-VALUE');
      expect(error.message).not.toContain('private@example.com');
    });
  });

  it('fails with INTERNAL_ERROR when the path cannot be read as a file', async () => {
    await mkdir(file());
    const error = (await FileSchedulerStore.open(file()).catch((e: unknown) => e)) as SubscriptionError;
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error.code).toBe(ErrorCode.Internal);
  });

  it('rejects an empty path', async () => {
    await expect(FileSchedulerStore.open('  ')).rejects.toMatchObject({ code: ErrorCode.Config });
  });

  it('refuses to save an invalid record, and the file stays loadable', async () => {
    const store = await FileSchedulerStore.open(file());
    await store.saveSchedule(schedule('good'));
    const before = await readFile(file(), 'utf8');
    await expect(store.saveSchedule({ ...schedule('bad'), amount: -5 })).rejects.toMatchObject({
      code: ErrorCode.Validation,
    });
    await expect(store.saveCycle({ ...cycle('x', 0), index: -1 })).rejects.toMatchObject({ code: ErrorCode.Validation });
    expect(await readFile(file(), 'utf8')).toBe(before);
    expect(await store.getSchedule('bad')).toBeUndefined();
    await FileSchedulerStore.open(file());
  });

  it('does not commit a save whose write failed, cleans up, and recovers once the path works again', async () => {
    const store = await FileSchedulerStore.open(file());
    await store.saveSchedule(schedule('kept'));
    // Make the rename onto the store path fail: a directory now sits there.
    await rm(file());
    await mkdir(file());

    const error = (await store.saveSchedule(schedule('lost')).catch((e: unknown) => e)) as SubscriptionError;
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error.code).toBe(ErrorCode.Internal);
    expect(await store.getSchedule('lost')).toBeUndefined();
    expect((await store.getSchedule('kept'))?.id).toBe('kept');
    expect(await readdir(dir)).toEqual(['scheduler.json']); // no temp file left

    await rm(file(), { recursive: true });
    await store.saveSchedule(schedule('after'));
    const reopened = await FileSchedulerStore.open(file());
    expect((await reopened.getSchedule('after'))?.id).toBe('after');
    expect((await reopened.getSchedule('kept'))?.id).toBe('kept'); // the earlier committed state is rewritten too
    expect(await reopened.getSchedule('lost')).toBeUndefined();
  });

  it('close() waits for in-flight saves and refuses later ones', async () => {
    const store = await FileSchedulerStore.open(file());
    const pending = store.saveSchedule(schedule('a'));
    await store.close();
    await pending;
    expect((await (await FileSchedulerStore.open(file())).getSchedule('a'))?.id).toBe('a');
    await expect(store.saveSchedule(schedule('b'))).rejects.toMatchObject({ code: ErrorCode.Internal });
    await expect(store.saveCycle(cycle('a', 0))).rejects.toMatchObject({ code: ErrorCode.Internal });
    expect((await store.getSchedule('a'))?.id).toBe('a');
  });

  it('keeps locks in memory only: a restart starts with none held', async () => {
    const first = await FileSchedulerStore.open(file());
    expect(await first.acquireLock('a', 60_000)).toBeDefined();
    const second = await FileSchedulerStore.open(file());
    expect(await second.acquireLock('a', 60_000)).toBeDefined();
  });
});
