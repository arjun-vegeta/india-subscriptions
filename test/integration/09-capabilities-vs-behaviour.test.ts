/**
 * Seam 9: every adapter's `capabilities`, against what the adapter, the facade and the scheduler really do, and against
 * the capability table of the README. A `true` must work in a mocked flow; a `false` must surface as UNSUPPORTED, or be
 * handled by the facade / scheduler the way the README says.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CancelMode, ChangeTiming, ErrorCode, IntervalUnit, PaymentMethod, Provider, RefundStatus, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { CashfreeHeader, CashfreePath } from '../../src/providers/cashfree/constants.js';
import { PAYU_FREE_TRIAL_CONSENT_PAISE, PayUCommand, PayUConsentField } from '../../src/providers/payu/constants.js';
import { RazorpayEndpoint, RazorpayNoteKey } from '../../src/providers/razorpay/constants.js';
import { ScheduleStatus } from '../../src/scheduler/index.js';
import { CapabilitiesSchema, type Capabilities } from '../../src/schemas.js';
import { CF_FIRST_DUE, PAYU_COMPOSITE, PAYU_DUE, PAYU_MANDATE, setupCashfree, setupPayu } from './fakes.js';
import {
  CASHFREE_ADAPTER_TEST,
  CUSTOMER,
  Clock,
  RAZORPAY_ADAPTER_TEST,
  cashfreeProvider,
  fixtureJson,
  fixtureObject,
  pathOf,
  CASHFREE_BASE_PATH,
  payuProvider,
  razorpayProvider,
  rejection,
  scriptedFetch,
  wire,
} from './helpers.js';

const NOW = '2026-11-17T05:00:00.000Z';
const PLAN = { name: 'Pro monthly', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } } as const;

const adapters = (): Record<Provider, Capabilities> => {
  const clock = new Clock(NOW);
  const fetch = scriptedFetch(() => ({ status: 500 })).fetch;
  return {
    [Provider.Razorpay]: razorpayProvider(fetch, clock).capabilities,
    [Provider.Cashfree]: cashfreeProvider(fetch, clock).capabilities,
    [Provider.PayU]: payuProvider(fetch, clock).capabilities,
  };
};

describe('the capability objects', () => {
  it('are valid, say which gateway they describe, and are what the facade hands out', () => {
    const clock = new Clock(NOW);
    const fetch = scriptedFetch(() => ({ status: 500 })).fetch;
    for (const provider of [razorpayProvider(fetch, clock), cashfreeProvider(fetch, clock), payuProvider(fetch, clock)]) {
      const { subs } = wire(provider, clock, []);
      expect(CapabilitiesSchema.safeParse(provider.capabilities).success).toBe(true);
      expect(provider.capabilities.provider).toBe(provider.name);
      expect(subs.capabilities(provider.name)).toBe(provider.capabilities);
    }
  });

  it('merchantCharges, merchantPreDebitNotification and the lead hours tell the scheduler one coherent style per gateway', () => {
    const caps = adapters();
    expect(caps.razorpay).toMatchObject({ merchantCharges: false, merchantPreDebitNotification: false, scheduling: [SchedulingMode.Gateway] });
    expect(caps.razorpay.merchantChargeLeadHours).toBeUndefined();
    expect(caps.cashfree).toMatchObject({ merchantCharges: true, merchantPreDebitNotification: false, scheduling: [SchedulingMode.Gateway, SchedulingMode.Merchant] });
    expect(caps.cashfree.merchantChargeLeadHours).toBeGreaterThan(0);
    expect(caps.payu).toMatchObject({ merchantCharges: true, merchantPreDebitNotification: true, scheduling: [SchedulingMode.Merchant] });
    expect(caps.payu.merchantChargeLeadHours).toBeUndefined();
  });
});

describe('the README capability table against the capabilities objects', () => {
  const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
  const row = (label: string): string[] => {
    const line = readme.split('\n').find((candidate) => candidate.startsWith(`| ${label}`));
    if (!line) throw new Error(`README has no row "${label}"`);
    return line.split('|').slice(2, 5).map((cell) => cell.trim());
  };
  /** A cell that is not a plain "No": "Yes", "Yes, through the scheduler", "UPI and cards only", "Periodic plans". */
  const yes = (cell: string) => !/^no\b/i.test(cell);
  const flags = (select: (caps: Capabilities) => boolean) => {
    const caps = adapters();
    return [select(caps.razorpay), select(caps.cashfree), select(caps.payu)];
  };

  it.each([
    ['Free trial', (caps: Capabilities) => caps.trial],
    ['Upfront amount at sign-up', (caps: Capabilities) => caps.upfrontAmount],
    ['Quantity', (caps: Capabilities) => caps.quantity],
    ['Cancel at period end', (caps: Capabilities) => caps.cancelAtPeriodEnd],
    ['Change plan', (caps: Capabilities) => caps.changePlan],
    ['Refunds', (caps: Capabilities) => caps.refunds],
  ])('"%s" says Yes exactly where the capability is true', (label, select) => {
    expect(row(label).map(yes)).toEqual(flags(select));
  });

  it('"Who raises each recurring debit" matches `scheduling`', () => {
    expect(row('Who raises each recurring debit').map((cell) => cell.toLowerCase().includes('this library'))).toEqual(
      Object.values(adapters()).map((caps) => caps.scheduling.includes(SchedulingMode.Merchant)),
    );
  });

  it('"Signed webhooks" says Yes for fully signed gateways and qualifies PayU', () => {
    const [razorpay, cashfree, payu] = row('Signed webhooks');
    expect([razorpay, cashfree]).toEqual(['Yes', 'Yes']);
    expect(payu).toMatch(/only/i);
    expect(adapters().payu.signedWebhooks).toBe(false);
  });

  it('"Payment methods" lists what each adapter supports', () => {
    const names: Record<PaymentMethod, RegExp> = {
      [PaymentMethod.Upi]: /UPI/i,
      [PaymentMethod.Card]: /cards?/i,
      [PaymentMethod.ENach]: /eMandate|eNACH/i,
      [PaymentMethod.PhysicalNach]: /physical/i,
    };
    const caps = adapters();
    const cells = row('Payment methods');
    [caps.razorpay, caps.cashfree, caps.payu].forEach((capability, index) => {
      for (const method of Object.values(PaymentMethod)) expect(names[method].test(cells[index] as string)).toBe(capability.paymentMethods.includes(method));
    });
  });

  // DEFECT (see the report): the README promises PayU pause and resume ("Yes, through the scheduler") and
  // `subs.capabilities(provider)` "returns the same information at runtime", but the flags say false for PayU.
  it.fails('"Pause and resume" says Yes exactly where capabilities.pause and .resume are true (PayU: "Yes, through the scheduler", flags false)', () => {
    expect(row('Pause and resume').map(yes)).toEqual(flags((caps) => caps.pause && caps.resume));
  });

  it('...yet the facade really does pause and resume PayU (through the scheduler), which is what the README says', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    expect((await t.subs.pause(Provider.PayU, PAYU_COMPOSITE)).status).toBe(SubscriptionStatus.Paused);
    expect((await t.subs.resume(Provider.PayU, PAYU_COMPOSITE)).status).not.toBe(SubscriptionStatus.Paused);
    expect(row('Pause and resume')[2]).toMatch(/scheduler/i);
    expect(adapters().payu).toMatchObject({ pause: false, resume: false });
  });
});

describe('Razorpay: every flag', () => {
  const NOWISO = '2026-03-13T10:00:00.000Z';
  function razorpaySetup() {
    const clock = new Clock(NOWISO);
    const plan = { ...fixtureJson<Record<string, unknown>>(RAZORPAY_ADAPTER_TEST, 'CREATE_PLAN_RESPONSE'), period: 'monthly', interval: 1 };
    const gateway = scriptedFetch((call) => {
      const path = pathOf(call.url).split('?')[0];
      if (path === RazorpayEndpoint.plans) return { json: plan };
      if (path === RazorpayEndpoint.subscriptions) return { json: { ...fixtureJson<Record<string, unknown>>(RAZORPAY_ADAPTER_TEST, 'CREATE_SUBSCRIPTION_RESPONSE'), quantity: 3 } };
      throw new Error(`unexpected ${call.method} ${path}`);
    });
    return { ...wire(razorpayProvider(gateway.fetch, clock), clock, gateway.calls), gateway };
  }

  it('gatewayPlans and quantity (true) work; merchantCharges and merchantPreDebitNotification (false) are UNSUPPORTED', async () => {
    const t = razorpaySetup();
    expect((await t.subs.plans.create(Provider.Razorpay, { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } })).id).toMatch(/^plan_/);
    const subscription = await t.subs.create(Provider.Razorpay, { plan: { ...PLAN }, customer: CUSTOMER, quantity: 3, totalCycles: 6 });
    expect(t.gateway.calls.at(-1)?.json).toMatchObject({ quantity: 3 });
    expect(subscription.quantity).toBe(3);
    expect((await rejection(() => t.subs.charges.create(Provider.Razorpay, { subscriptionId: 's', chargeId: 'c', amount: 100 }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.charges.notify(Provider.Razorpay, { subscriptionId: 's', notificationId: 'n', amount: 100, debitAt: NOWISO }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.create(Provider.Razorpay, { plan: { ...PLAN, scheduling: SchedulingMode.Merchant }, customer: CUSTOMER }))).code).toBe(ErrorCode.Unsupported);
  });

  it('idempotencyKeys=false: a key is accepted and silently not sent; paymentMethods cannot be enforced and is silently not sent either (accepted-and-ignored inputs)', async () => {
    const t = razorpaySetup();
    await t.subs.create(Provider.Razorpay, { plan: { ...PLAN }, customer: CUSTOMER, totalCycles: 6, idempotencyKey: 'order-1-create', paymentMethods: [PaymentMethod.Upi] });
    const sent = t.gateway.calls.at(-1)!;
    expect(Object.keys(sent.headers).filter((name) => name.includes('idempot'))).toEqual([]);
    expect(JSON.stringify(sent.json)).not.toMatch(/upi/i);
    expect(adapters().razorpay.idempotencyKeys).toBe(false);
  });
});

describe('Cashfree: every flag', () => {
  function cashfreeSetup() {
    const clock = new Clock(NOW);
    const onDemand = fixtureObject(CASHFREE_ADAPTER_TEST, 'SUBSCRIPTION_CREATE_ON_DEMAND');
    const plan = fixtureObject(CASHFREE_ADAPTER_TEST, 'PLAN_ENTITY_EXAMPLE');
    const gateway = scriptedFetch((call) => {
      const path = pathOf(call.url, CASHFREE_BASE_PATH);
      if (path === CashfreePath.Plans) return { json: plan };
      if (path === CashfreePath.Subscriptions) return { json: { ...onDemand, plan_details: { ...onDemand.plan_details, plan_type: 'PERIODIC', plan_recurring_amount: 499, plan_intervals: 1, plan_interval_type: 'MONTH' } } };
      throw new Error(`unexpected ${call.method} ${path}`);
    });
    return { ...wire(cashfreeProvider(gateway.fetch, clock), clock, gateway.calls), gateway };
  }
  const input = { reference: 'cf_caps', plan: { ...PLAN }, customer: { ...CUSTOMER, email: 'a@b.co' }, totalCycles: 6 } as const;

  it('gatewayPlans and idempotencyKeys (true) work; quantity (false), physical NACH and an upfront amount on eNACH are UNSUPPORTED before any request', async () => {
    const t = cashfreeSetup();
    expect((await t.subs.plans.create(Provider.Cashfree, { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } })).provider).toBe(Provider.Cashfree);
    await t.subs.create(Provider.Cashfree, { ...input, idempotencyKey: '47bf8872-46fe-11ee-be56-0242ac120002' });
    expect(t.gateway.calls.at(-1)?.headers[CashfreeHeader.IdempotencyKey]).toBe('47bf8872-46fe-11ee-be56-0242ac120002');
    const before = t.gateway.calls.length;
    expect((await rejection(() => t.subs.create(Provider.Cashfree, { ...input, quantity: 2 }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.create(Provider.Cashfree, { ...input, paymentMethods: [PaymentMethod.PhysicalNach] }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.create(Provider.Cashfree, { ...input, upfrontAmount: 5000, paymentMethods: [PaymentMethod.ENach] }))).code).toBe(ErrorCode.Unsupported);
    expect(t.gateway.calls).toHaveLength(before);
  });

  // DEFECT (see the report, low): the unified schema takes any 1..255 character idempotency key, Cashfree's header is a UUID.
  it.fails('an idempotency key that is not a UUID is refused locally for Cashfree (its x-idempotency-key is `format: UUID`)', async () => {
    const t = cashfreeSetup();
    const error = await rejection(() => t.subs.create(Provider.Cashfree, { ...input, idempotencyKey: 'order-1042-create' }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(t.gateway.calls.filter((call) => call.method === 'POST')).toHaveLength(0);
  });

  it('cancelAtPeriodEnd=false: on a merchant-scheduled subscription the facade refuses BEFORE stopping billing; planId is UNSUPPORTED too', async () => {
    const t = setupCashfree();
    await t.create();
    await t.activate();
    const error = await rejection(() => t.subs.cancel(Provider.Cashfree, t.reference, { mode: CancelMode.AtPeriodEnd }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
    expect((await rejection(() => t.subs.update(Provider.Cashfree, t.reference, { planId: 'other' }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.update(Provider.Cashfree, t.reference, { quantity: 2 }))).code).toBe(ErrorCode.Unsupported);
  });

  it('refunds and listCharges (true) on an on-demand subscription: the real calls go out, keyed by the merchant payment id the scheduler chose', async () => {
    const t = setupCashfree();
    await t.create();
    await t.activate();
    await t.tickAt('2026-01-18T04:30:00.000Z');
    const charges = await t.subs.charges.list(Provider.Cashfree, t.reference);
    expect(charges).toHaveLength(1);
    const chargeId = charges[0]!.id;
    expect(chargeId).toBe((t.fake.chargeCalls[0]!.json as { payment_id: string }).payment_id);
    const refund = await t.subs.charges.refund(Provider.Cashfree, { subscriptionId: t.reference, chargeId, refundId: 'rf_1', amount: 100 });
    expect(refund).toMatchObject({ chargeId, reference: 'rf_1' });
    expect(t.fake.gateway.calls.at(-1)?.json).toMatchObject({ payment_id: chargeId, refund_id: 'rf_1', refund_amount: 1 });
    expect(adapters().cashfree).toMatchObject({ refunds: true, listCharges: true });
  });
});

describe('PayU: every flag', () => {
  it('gatewayPlans=false: plans are UNSUPPORTED and a plan id string is refused; quantity=false is UNSUPPORTED; idempotency and paymentMethods are accepted and not sent', async () => {
    const t = setupPayu();
    expect((await rejection(() => t.subs.plans.create(Provider.PayU, { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.plans.get(Provider.PayU, 'p'))).code).toBe(ErrorCode.Unsupported);
    const common = { reference: 'caps_1', customer: CUSTOMER, startAt: PAYU_DUE };
    expect((await rejection(() => t.subs.create(Provider.PayU, { ...common, plan: 'plan_1' }))).code).toBe(ErrorCode.Validation);
    expect((await rejection(() => t.subs.create(Provider.PayU, { ...common, plan: { ...PLAN }, quantity: 2 }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.create(Provider.PayU, { ...common, plan: { ...PLAN, scheduling: SchedulingMode.Gateway } }))).code).toBe(ErrorCode.Unsupported);
    const created = await t.subs.create(Provider.PayU, { ...common, plan: { ...PLAN }, idempotencyKey: 'k', paymentMethods: [PaymentMethod.Upi] });
    expect(JSON.stringify((created.checkout as { fields: unknown }).fields)).not.toMatch(/idempot|upi/i);
    expect(t.calls).toHaveLength(0);
  });

  it('trial=true: a free trial is a INR 2.00 consent with free_trial=1; upfrontAmount=true: the upfront amount IS the consent amount', async () => {
    const t = setupPayu();
    const trial = await t.subs.create(Provider.PayU, { reference: 'caps_trial', plan: { ...PLAN }, customer: CUSTOMER, trial: { days: 14 } });
    const trialFields = (trial.checkout as { fields: Record<string, string> }).fields;
    expect(trialFields[PayUConsentField.Amount]).toBe((PAYU_FREE_TRIAL_CONSENT_PAISE / 100).toFixed(2));
    expect(trialFields[PayUConsentField.FreeTrial]).toBe('1');
    const upfront = await t.subs.create(Provider.PayU, { reference: 'caps_up', plan: { ...PLAN }, customer: CUSTOMER, startAt: PAYU_DUE, upfrontAmount: 9900 });
    const upfrontFields = (upfront.checkout as { fields: Record<string, string> }).fields;
    expect(upfrontFields[PayUConsentField.Amount]).toBe('99.00');
    expect(upfrontFields).not.toHaveProperty(PayUConsentField.FreeTrial);
  });

  it('pause / resume (false at the adapter) are UNSUPPORTED if called on the adapter, and work through the facade; cancelAtPeriodEnd and changePlan (false) are refused without side effects; listCharges (false) is UNSUPPORTED', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    expect((await rejection(() => t.provider.pauseSubscription(PAYU_COMPOSITE))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.provider.resumeSubscription(PAYU_COMPOSITE))).code).toBe(ErrorCode.Unsupported);
    t.fake.commands.length = 0;
    expect((await rejection(() => t.subs.cancel(Provider.PayU, PAYU_COMPOSITE, { mode: CancelMode.AtPeriodEnd }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.update(Provider.PayU, PAYU_COMPOSITE, { planId: 'x', timing: ChangeTiming.Immediately }))).code).toBe(ErrorCode.Unsupported);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
    expect(t.fake.commands).toEqual([]);
    expect((await rejection(() => t.subs.charges.list(Provider.PayU, PAYU_COMPOSITE))).code).toBe(ErrorCode.Unsupported);
  });

  it('refunds=true: a debit is looked up by txnid, then refunded with cancel_refund_transaction; merchantPreDebitNotification: eNACH is acknowledged without a request', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    await t.tickAt('2026-01-13T04:30:00.000Z');
    await t.tickAt(PAYU_DUE);
    const [debit] = t.fake.commandsNamed(PayUCommand.SiTransaction);
    t.fake.commands.length = 0;
    const refund = await t.subs.charges.refund(Provider.PayU, { subscriptionId: PAYU_COMPOSITE, chargeId: debit?.txnid as string, refundId: 'rf_1' });
    expect(t.fake.commands.map((entry) => entry.command)).toEqual([PayUCommand.VerifyPayment, PayUCommand.RefundTransaction]);
    expect(refund).toMatchObject({ chargeId: debit?.txnid, amount: 49900 });
    expect(refund.status).toBe(RefundStatus.Pending);

    t.fake.commands.length = 0;
    const notice = await t.subs.charges.notify(Provider.PayU, { subscriptionId: `enach:${PAYU_MANDATE}`, notificationId: 'n_enach', amount: 49900, debitAt: PAYU_DUE });
    expect(notice.accepted).toBe(true);
    expect(t.fake.commands).toEqual([]);
  });
});
