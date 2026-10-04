/**
 * The facade's "is a scheduler needed?" pre-flight in `create`: the effective scheduling mode (the plan's request, else the
 * gateway's default = the first of `capabilities.scheduling`, else the default for a plan id) decides, BEFORE any gateway call,
 * whether a missing scheduler is a `CONFIG` error. Real Paytm adapter (default merchant, gateway offered) on its stateful
 * fake, and the real Cashfree adapter (default gateway) on a scripted gateway.
 */
import { describe, expect, it } from 'vitest';
import { createSubscriptions } from '../../src/client.js';
import { Environment, ErrorCode, IntervalUnit, Provider, SchedulingMode } from '../../src/constants.js';
import { CASHFREE_BASE_URLS, CashfreePath, CashfreeSubscriptionStatus } from '../../src/providers/cashfree/constants.js';
import { paytm } from '../../src/providers/paytm/index.js';
import { MemorySchedulerStore } from '../../src/scheduler/index.js';
import { FakePaytm } from '../paytm/fake-gateway.js';
import { KEY, MID, SALT } from '../paytm/helpers.js';
import {
  CASHFREE_ADAPTER_TEST,
  CASHFREE_BASE_PATH,
  CUSTOMER,
  Clock,
  cashfreeProvider,
  fixtureObject,
  pathOf,
  rejection,
  scriptedFetch,
} from './helpers.js';

const NOW = '2026-01-01T05:00:00.000Z';
const PLAN = { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } } as const;

function paytmClient(withScheduler: boolean) {
  const clock = new Clock(NOW);
  const fake = new FakePaytm(clock.nowMs);
  const provider = paytm(
    { mid: MID, merchantKey: KEY, website: 'WEBSTAGING', environment: Environment.Test },
    { fetch: fake.fetch, now: clock.now, maxRetries: 0, generateSalt: () => SALT },
  );
  const subs = createSubscriptions({
    providers: [provider],
    ...(withScheduler ? { scheduler: { store: new MemorySchedulerStore({ now: clock.nowMs }), now: clock.now } } : {}),
  });
  return { subs, fake, clock };
}

describe('create pre-flight: Paytm (default merchant, gateway offered)', () => {
  const create = (t: ReturnType<typeof paytmClient>, plan: Record<string, unknown> | string, reference: string) =>
    t.subs.create(Provider.Paytm, {
      reference,
      plan: plan as never,
      customer: CUSTOMER,
      // UPI Autopay takes a future start date only today or one cycle from today (gateway mode); a month is one cycle.
      startAt: '2026-02-01T05:00:00.000Z',
    });

  it('a default plan without a scheduler is CONFIG before any gateway call (nothing is created, nothing cancelled)', async () => {
    const t = paytmClient(false);
    const error = await rejection(() => create(t, { ...PLAN }, 'pre_default'));
    expect(error.code).toBe(ErrorCode.Config);
    expect(t.fake.requests).toHaveLength(0);
    expect(t.fake.subscriptions.size).toBe(0);
  });

  it('an explicit merchant plan without a scheduler is CONFIG before any gateway call', async () => {
    const t = paytmClient(false);
    const error = await rejection(() => create(t, { ...PLAN, scheduling: SchedulingMode.Merchant }, 'pre_merchant'));
    expect(error.code).toBe(ErrorCode.Config);
    expect(t.fake.requests).toHaveLength(0);
  });

  it('a plan id (no mode) falls back to the gateway default: CONFIG before any gateway call', async () => {
    const t = paytmClient(false);
    const error = await rejection(() => create(t, 'plan_by_id', 'pre_planid'));
    expect(error.code).toBe(ErrorCode.Config);
    expect(t.fake.requests).toHaveLength(0);
  });

  it('an explicit gateway plan works without a scheduler: Paytm collects, no schedule exists', async () => {
    const t = paytmClient(false);
    const subscription = await create(t, { ...PLAN, scheduling: SchedulingMode.Gateway }, 'pre_gateway');
    expect(subscription.scheduling).toBe(SchedulingMode.Gateway);
    expect(t.fake.subscriptions.size).toBe(1);
  });

  it('with a scheduler a default plan is created and registered (merchant), and a gateway plan is created without a schedule', async () => {
    const t = paytmClient(true);
    const merchant = await create(t, { ...PLAN }, 'pre_sched_default');
    expect(merchant.scheduling).toBe(SchedulingMode.Merchant);
    expect(await t.subs.scheduler!.find(Provider.Paytm, 'pre_sched_default')).toBeDefined();

    const gateway = await create(t, { ...PLAN, scheduling: SchedulingMode.Gateway }, 'pre_sched_gateway');
    expect(gateway.scheduling).toBe(SchedulingMode.Gateway);
    expect(await t.subs.scheduler!.find(Provider.Paytm, 'pre_sched_gateway')).toBeUndefined();
  });
});

describe('create pre-flight: Cashfree (default gateway)', () => {
  const onDemand = fixtureObject(CASHFREE_ADAPTER_TEST, 'SUBSCRIPTION_CREATE_ON_DEMAND');
  const periodicPlan = {
    plan_id: 'plan_inline_1',
    plan_name: 'Premium Monthly',
    plan_type: 'PERIODIC',
    plan_max_cycles: 6,
    plan_recurring_amount: 499,
    plan_max_amount: 499,
    plan_interval_type: 'MONTH',
    plan_intervals: 1,
    plan_currency: 'INR',
    plan_note: null,
    plan_status: null,
  };
  const BASE = CASHFREE_BASE_URLS[Environment.Test];

  it('an inline plan without `scheduling` works with no scheduler configured (gateway default); an explicit merchant plan is CONFIG before any call', async () => {
    const clock = new Clock(NOW);
    const gateway = scriptedFetch((call) => {
      const path = pathOf(call.url, CASHFREE_BASE_PATH);
      if (call.method === 'POST' && path === CashfreePath.Subscriptions) {
        return { json: { ...onDemand, subscription_id: 'cf_pre_1', subscription_status: CashfreeSubscriptionStatus.Initialized, plan_details: periodicPlan } };
      }
      throw new Error(`unexpected Cashfree call ${call.method} ${path}`);
    });
    expect(BASE).toContain('https://');
    const subs = createSubscriptions({ providers: [cashfreeProvider(gateway.fetch, clock)] });

    const created = await subs.create(Provider.Cashfree, { reference: 'cf_pre_1', plan: { ...PLAN }, customer: CUSTOMER, returnUrl: 'https://merchant.example/return' });
    expect(created.scheduling).toBe(SchedulingMode.Gateway);
    expect(gateway.calls).toHaveLength(1);

    const before = gateway.calls.length;
    const error = await rejection(() =>
      subs.create(Provider.Cashfree, { reference: 'cf_pre_2', plan: { ...PLAN, scheduling: SchedulingMode.Merchant }, customer: CUSTOMER, returnUrl: 'https://merchant.example/return' }),
    );
    expect(error.code).toBe(ErrorCode.Config);
    expect(gateway.calls).toHaveLength(before);
  });
});
