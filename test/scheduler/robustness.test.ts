import { describe, expect, it } from 'vitest';
import { ErrorCode, Provider, type ErrorCode as ErrorCodeType } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { CycleStatus, MemorySchedulerStore } from '../../src/scheduler/index.js';
import { CreateBehaviour, DUE, Style, makeHarness, plusHours, registration } from './helpers.js';

const onDue = () => makeHarness({ style: Style.OnDue });

describe('unknown exceptions are never a definite failure', () => {
  it('a foreign exception after the request was sent is reconciled with getCharge, not retried under a new id', async () => {
    const h = onDue();
    h.provider.createScript = [CreateBehaviour.ForeignCreated];
    await h.scheduler.register(registration());

    const first = await h.tickAt(DUE);
    expect(first.failed).toBe(0);
    expect(first.errors).toHaveLength(1);
    expect(first.errors[0]?.code).toBe(ErrorCode.Internal);
    const cycle = await h.store.getCycle('sub_1', 0);
    expect(cycle).toMatchObject({ status: CycleStatus.Charging, attempt: 1, attempts: [] });
    expect(cycle?.lastError?.code).toBe(ErrorCode.Internal);

    const second = await h.tickAt(plusHours(DUE, 1));
    expect(second.errors).toHaveLength(0);
    expect(second.succeeded).toBe(1);
    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.createCalls).toHaveLength(1);
    expect(h.provider.gateway.size).toBe(1);
    expect((await h.store.getCycle('sub_1', 0))?.attempt).toBe(1);
  });

  it('a foreign exception the gateway never saw is re-created with the same charge id', async () => {
    const h = onDue();
    h.provider.createScript = [CreateBehaviour.ForeignLost];
    await h.scheduler.register(registration());
    await h.tickAt(DUE);
    await h.tickAt(plusHours(DUE, 1));

    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.createCalls).toHaveLength(2);
    expect(h.provider.createCalls[1]!.chargeId).toBe(h.provider.createCalls[0]!.chargeId);
    expect((await h.store.getCycle('sub_1', 0))?.status).toBe(CycleStatus.Succeeded);
  });

  it('a foreign exception from getCharge leaves the cycle charging and raises nothing new', async () => {
    const h = onDue();
    h.provider.createScript = [CreateBehaviour.UnknownLost];
    await h.scheduler.register(registration());
    await h.tickAt(DUE);
    h.provider.getCharge = async () => {
      throw new TypeError('adapter bug');
    };
    const result = await h.tickAt(plusHours(DUE, 1));
    expect(result.errors[0]?.code).toBe(ErrorCode.Internal);
    expect(h.provider.createCalls).toHaveLength(1);
    expect((await h.store.getCycle('sub_1', 0))?.status).toBe(CycleStatus.Charging);
  });

  it('a foreign exception from notifyCharge is recorded and retried', async () => {
    const h = makeHarness();
    await h.scheduler.register(registration());
    const real = h.provider.notifyCharge.bind(h.provider);
    h.provider.notifyCharge = async () => {
      throw new TypeError('adapter bug');
    };
    const failed = await h.tickAt(plusHours(DUE, -48));
    expect(failed.errors[0]?.code).toBe(ErrorCode.Internal);
    expect((await h.store.getCycle('sub_1', 0))?.status).toBe(CycleStatus.Pending);

    h.provider.notifyCharge = real;
    expect((await h.tickAt(plusHours(DUE, -47))).notified).toBe(1);
  });

  const definite: ErrorCodeType[] = [
    ErrorCode.ProviderError,
    ErrorCode.Validation,
    ErrorCode.Unsupported,
    ErrorCode.NotFound,
    ErrorCode.Auth,
    ErrorCode.Config,
  ];
  it.each(definite)('an explicit %s from createCharge is a failed attempt', async (code) => {
    const h = onDue();
    h.provider.createScript = [CreateBehaviour.ThrowConfigured];
    h.provider.createError = new SubscriptionError(code, 'refused', { provider: Provider.PayU });
    await h.scheduler.register(registration());

    const result = await h.tickAt(DUE);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(0);
    const cycle = await h.store.getCycle('sub_1', 0);
    expect(cycle).toMatchObject({ status: CycleStatus.Pending, attempt: 2 });
    expect(cycle?.attempts[0]?.failureCode).toBe(code);
  });

  const unknown: ErrorCodeType[] = [
    ErrorCode.OutcomeUnknown,
    ErrorCode.Timeout,
    ErrorCode.Network,
    ErrorCode.RateLimited,
    ErrorCode.ProviderUnavailable,
    ErrorCode.UnexpectedResponse,
    ErrorCode.SignatureInvalid,
    ErrorCode.Conflict,
    ErrorCode.Internal,
  ];
  it.each(unknown)('%s from createCharge is an unknown outcome, reconciled rather than retried', async (code) => {
    const h = onDue();
    h.provider.createScript = [CreateBehaviour.ThrowConfigured];
    h.provider.createError = new SubscriptionError(code, 'no definite answer', { provider: Provider.PayU });
    await h.scheduler.register(registration());

    const result = await h.tickAt(DUE);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.code).toBe(code);
    expect(await h.store.getCycle('sub_1', 0)).toMatchObject({ status: CycleStatus.Charging, attempt: 1, attempts: [] });

    // Next tick asks the gateway first.
    await h.tickAt(plusHours(DUE, 1));
    expect(h.provider.getCalls).toHaveLength(1);
    expect(h.provider.createCalls[1]?.chargeId).toBe(h.provider.createCalls[0]!.chargeId);
  });
});

describe('store failures', () => {
  it('are reported in TickResult.errors as INTERNAL_ERROR without stopping other schedules', async () => {
    class FlakyStore extends MemorySchedulerStore {
      broken = new Set<string>();
      override async getSchedule(id: string) {
        if (this.broken.has(id)) throw new Error('connection reset by peer');
        return super.getSchedule(id);
      }
    }
    const store = new FlakyStore();
    const h = makeHarness({ style: Style.OnDue, store });
    await h.scheduler.register(registration({ subscriptionId: 'bad' }));
    await h.scheduler.register(registration({ subscriptionId: 'good' }));
    store.broken.add('bad');

    const result = await h.tickAt(DUE);
    expect(result.errors).toEqual([expect.objectContaining({ scheduleId: 'bad', code: ErrorCode.Internal })]);
    expect(result.succeeded).toBe(1);
    expect(h.provider.createCalls.map((c) => c.subscriptionId)).toEqual(['good']);
  });
});
