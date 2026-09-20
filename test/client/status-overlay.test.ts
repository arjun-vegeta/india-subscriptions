import { describe, expect, it } from 'vitest';
import { overlaySchedule } from '../../src/client.js';
import { Currency, IntervalUnit, Provider, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import type { Subscription } from '../../src/schemas.js';
import { ScheduleStatus, type ScheduleRecord } from '../../src/scheduler/index.js';
import {
  AMOUNT,
  GatewayMethod,
  REFERENCE,
  T0,
  TRIAL_END,
  createAndAuthorize,
  immediateInput,
  makeWorld,
  plusHours,
  trialInput,
} from './helpers.js';

const PAYU = Provider.PayU;
const MONTHLY = { unit: IntervalUnit.Month, count: 1 } as const;

function gatewaySubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    provider: PAYU,
    id: 'mandate_1',
    status: SubscriptionStatus.Active,
    providerStatus: SubscriptionStatus.Active,
    scheduling: SchedulingMode.Merchant,
    amount: 1,
    interval: { unit: IntervalUnit.Day, count: 1 },
    raw: { gateway: true },
    ...overrides,
  };
}

function schedule(overrides: Partial<ScheduleRecord> = {}): ScheduleRecord {
  return {
    id: REFERENCE,
    provider: PAYU,
    subscriptionId: 'mandate_1',
    status: ScheduleStatus.Active,
    amount: AMOUNT,
    currency: Currency.INR,
    interval: MONTHLY,
    policy: { notifyLeadHours: 48, minNoticeHours: 24, maxAttempts: 3, retryIntervalHours: 24 },
    fingerprint: 'fp',
    firstChargeAt: TRIAL_END,
    anchorAt: TRIAL_END,
    anchorIndex: 0,
    cycleIndex: 0,
    paidCycles: 0,
    retrying: false,
    createdAt: T0,
    updatedAt: T0,
    ...overrides,
  };
}

describe('overlaySchedule', () => {
  it.each([
    [ScheduleStatus.Active, { paidCycles: 2, nextChargeAt: TRIAL_END }, SubscriptionStatus.Active],
    [ScheduleStatus.Paused, { paidCycles: 2 }, SubscriptionStatus.Paused],
    [ScheduleStatus.Halted, { paidCycles: 2 }, SubscriptionStatus.Halted],
    [ScheduleStatus.Cancelled, { paidCycles: 2 }, SubscriptionStatus.Cancelled],
    [ScheduleStatus.Completed, { paidCycles: 3, totalCycles: 3 }, SubscriptionStatus.Completed],
  ] as const)('schedule %s maps onto the subscription status', (status, extra, expected) => {
    expect(overlaySchedule(gatewaySubscription(), schedule({ status, ...extra })).status).toBe(expected);
  });

  it('a pending schedule leaves the gateway status alone', () => {
    const merged = overlaySchedule(
      gatewaySubscription({ status: SubscriptionStatus.Created }),
      schedule({ status: ScheduleStatus.PendingAuthorization }),
    );
    expect(merged.status).toBe(SubscriptionStatus.Created);
    expect(merged.trialEndsAt).toBeUndefined();
  });

  it('active with nothing paid and the first charge still ahead is a trial ending at that instant', () => {
    const merged = overlaySchedule(gatewaySubscription(), schedule({ nextChargeAt: TRIAL_END }), new Date(T0));
    expect(merged.status).toBe(SubscriptionStatus.Trialing);
    expect(merged.trialEndsAt).toBe(TRIAL_END);
    expect(merged.nextChargeAt).toBe(TRIAL_END);
  });

  it('is trialing only strictly before the first charge instant', () => {
    const before = overlaySchedule(gatewaySubscription(), schedule(), new Date(Date.parse(TRIAL_END) - 1));
    expect(before.status).toBe(SubscriptionStatus.Trialing);
    for (const now of [TRIAL_END, plusHours(TRIAL_END, 5)]) {
      const merged = overlaySchedule(gatewaySubscription(), schedule(), new Date(now));
      expect(merged.status).toBe(SubscriptionStatus.Active);
      expect(merged.trialEndsAt).toBeUndefined();
    }
  });

  it('active with something paid is never a trial, whatever the first charge instant', () => {
    const merged = overlaySchedule(gatewaySubscription(), schedule({ paidCycles: 1, firstChargeAt: TRIAL_END }), new Date(T0));
    expect(merged.status).toBe(SubscriptionStatus.Active);
  });

  it('a failed debit being retried reads past_due, with or without a trial, until it is paid', () => {
    const during = overlaySchedule(
      gatewaySubscription(),
      schedule({ retrying: true, lastFailure: { code: 'INSUFFICIENT_FUNDS', at: T0 }, nextChargeAt: plusHours(T0, 24) }),
      new Date(T0),
    );
    expect(during.status).toBe(SubscriptionStatus.PastDue);
    expect(during.trialEndsAt).toBeUndefined();
    const later = overlaySchedule(gatewaySubscription(), schedule({ retrying: true, paidCycles: 2 }), new Date(TRIAL_END));
    expect(later.status).toBe(SubscriptionStatus.PastDue);
    expect(overlaySchedule(gatewaySubscription(), schedule({ retrying: false, paidCycles: 2 }), new Date(TRIAL_END)).status).toBe(
      SubscriptionStatus.Active,
    );
  });

  it('paused, halted, cancelled and completed win over retrying, and a terminal gateway status wins over everything', () => {
    for (const status of [ScheduleStatus.Paused, ScheduleStatus.Halted, ScheduleStatus.Cancelled, ScheduleStatus.Completed] as const) {
      const expected = {
        [ScheduleStatus.Paused]: SubscriptionStatus.Paused,
        [ScheduleStatus.Halted]: SubscriptionStatus.Halted,
        [ScheduleStatus.Cancelled]: SubscriptionStatus.Cancelled,
        [ScheduleStatus.Completed]: SubscriptionStatus.Completed,
      }[status];
      expect(overlaySchedule(gatewaySubscription(), schedule({ status, retrying: true }), new Date(T0)).status).toBe(expected);
    }
    expect(
      overlaySchedule(gatewaySubscription({ status: SubscriptionStatus.Expired }), schedule({ retrying: true }), new Date(T0)).status,
    ).toBe(SubscriptionStatus.Expired);
  });

  it('active with nothing paid and no charge date stays active once the first charge instant has passed', () => {
    expect(overlaySchedule(gatewaySubscription(), schedule(), new Date(plusHours(TRIAL_END, 1))).status).toBe(SubscriptionStatus.Active);
  });

  it.each([SubscriptionStatus.Cancelled, SubscriptionStatus.Expired, SubscriptionStatus.Failed])(
    'a gateway status of %s beats an active schedule, but the schedule figures are still shown',
    (status) => {
      const merged = overlaySchedule(
        gatewaySubscription({ status }),
        schedule({ paidCycles: 2, totalCycles: 5, nextChargeAt: TRIAL_END }),
      );
      expect(merged.status).toBe(status);
      expect(merged.paidCycles).toBe(2);
      expect(merged.remainingCycles).toBe(3);
      expect(merged.amount).toBe(AMOUNT);
    },
  );

  it('the schedule is the source of amount, interval, cycle counts and next charge', () => {
    const merged = overlaySchedule(
      gatewaySubscription({ totalCycles: 99, nextChargeAt: '2030-01-01T00:00:00.000Z' }),
      schedule({ paidCycles: 1, totalCycles: 4, nextChargeAt: TRIAL_END }),
    );
    expect(merged).toMatchObject({
      amount: AMOUNT,
      interval: MONTHLY,
      totalCycles: 4,
      paidCycles: 1,
      remainingCycles: 3,
      nextChargeAt: TRIAL_END,
    });
  });

  it('falls back to the gateway totalCycles, and never reports negative remaining cycles', () => {
    const open = overlaySchedule(gatewaySubscription({ totalCycles: 6 }), schedule({ paidCycles: 1 }));
    expect(open.totalCycles).toBe(6);
    expect(open.remainingCycles).toBeUndefined();
    const over = overlaySchedule(gatewaySubscription(), schedule({ paidCycles: 5, totalCycles: 3 }));
    expect(over.remainingCycles).toBe(0);
  });

  it('clears a stale gateway nextChargeAt when the schedule has none (paused, halted, completed)', () => {
    const merged = overlaySchedule(
      gatewaySubscription({ nextChargeAt: '2030-01-01T00:00:00.000Z' }),
      schedule({ status: ScheduleStatus.Paused }),
    );
    expect(merged.nextChargeAt).toBeUndefined();
  });

  it('does not mutate its inputs and keeps everything else (raw, reference, checkout) intact', () => {
    const subscription = gatewaySubscription({ reference: REFERENCE, metadata: { a: 'b' } });
    const record = schedule({ nextChargeAt: TRIAL_END });
    const subscriptionBefore = structuredClone(subscription);
    const recordBefore = structuredClone(record);
    const merged = overlaySchedule(subscription, record);
    expect(subscription).toStrictEqual(subscriptionBefore);
    expect(record).toStrictEqual(recordBefore);
    expect(merged).not.toBe(subscription);
    expect(merged.raw).toBe(subscription.raw);
    expect(merged.reference).toBe(REFERENCE);
    expect(merged.metadata).toStrictEqual({ a: 'b' });
    expect(merged.providerStatus).toBe(subscription.providerStatus);
  });
});

describe('status of a subscription that has NO trial', () => {
  it('reads active, not trialing, after authorisation when no trial was requested', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world, immediateInput());
    const sub = await world.subs.get(PAYU, created.id);
    expect(sub.status).toBe(SubscriptionStatus.Active);
    expect(sub.trialEndsAt).toBeUndefined();
  });

  it('a real trial is reported as trialing with the trial end, and the gateway is asked for the base subscription only once per read', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world, trialInput());
    const before = world.gateway.callsTo(GatewayMethod.GetSubscription).length;
    const sub = await world.subs.get(PAYU, created.id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(TRIAL_END);
    expect(world.gateway.callsTo(GatewayMethod.GetSubscription).length - before).toBe(1);
  });

  it('a delayed start without a trial (startAt) is also reported as trialing: the documented intent of the overlay', async () => {
    const world = makeWorld();
    const { created } = await createAndAuthorize(world, immediateInput({ startAt: TRIAL_END }));
    const sub = await world.subs.get(PAYU, created.id);
    expect(sub.status).toBe(SubscriptionStatus.Trialing);
    expect(sub.trialEndsAt).toBe(TRIAL_END);
  });
});
