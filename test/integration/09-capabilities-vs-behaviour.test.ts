/**
 * Seam 9: every adapter's `capabilities`, against what the adapter, the facade and the scheduler really do, and against
 * the capability table of the README. A `true` must work in a mocked flow; a `false` must surface as UNSUPPORTED, or be
 * handled by the facade / scheduler the way the README says.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createSubscriptions } from '../../src/client.js';
import type { SubscriptionProvider } from '../../src/provider.js';
import { CancelMode, ChangeTiming, ChargeStatus, ErrorCode, EventType, IntervalUnit, PaymentMethod, Provider, RefundStatus, SchedulingMode, SubscriptionStatus } from '../../src/constants.js';
import { CashfreeHeader, CashfreePath } from '../../src/providers/cashfree/constants.js';
import { PAYU_FREE_TRIAL_CONSENT_PAISE, PayUCommand, PayUConsentField } from '../../src/providers/payu/constants.js';
import { RazorpayEndpoint, RazorpayNoteKey } from '../../src/providers/razorpay/constants.js';
import { ScheduleStatus } from '../../src/scheduler/index.js';
import { CapabilitiesSchema, type Capabilities } from '../../src/schemas.js';
import { CF_FIRST_DUE, PAYU_COMPOSITE, PAYU_DUE, PAYU_MANDATE, PP_DUE, PP_REFERENCE, PT_DUE, PT_REFERENCE, paytmProvider, phonepeProvider, setupCashfree, setupPayu, setupPaytm, setupPhonePe } from './fakes.js';
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

type BuiltAdapter = typeof Provider.Razorpay | typeof Provider.Cashfree | typeof Provider.PayU | typeof Provider.PhonePe | typeof Provider.Paytm;

/** The capabilities each adapter reports itself (`provider(name).capabilities`). */
const adapters = (): Record<BuiltAdapter, Capabilities> => {
  const clock = new Clock(NOW);
  const fetch = scriptedFetch(() => ({ status: 500 })).fetch;
  return {
    [Provider.Razorpay]: razorpayProvider(fetch, clock).capabilities,
    [Provider.Cashfree]: cashfreeProvider(fetch, clock).capabilities,
    [Provider.PayU]: payuProvider(fetch, clock).capabilities,
    [Provider.PhonePe]: phonepeProvider(fetch, clock).capabilities,
    [Provider.Paytm]: paytmProvider(fetch, clock).capabilities,
  };
};

/** What `subs.capabilities(name)` says, with a scheduler configured: the adapter's capabilities plus what the facade and scheduler add. */
function effective(): Record<BuiltAdapter, Capabilities> {
  const clock = new Clock(NOW);
  const fetch = scriptedFetch(() => ({ status: 500 })).fetch;
  const of = (provider: SubscriptionProvider) => wire(provider, clock, []).subs.capabilities(provider.name);
  return {
    [Provider.Razorpay]: of(razorpayProvider(fetch, clock)),
    [Provider.Cashfree]: of(cashfreeProvider(fetch, clock)),
    [Provider.PayU]: of(payuProvider(fetch, clock)),
    [Provider.PhonePe]: of(phonepeProvider(fetch, clock)),
    [Provider.Paytm]: of(paytmProvider(fetch, clock)),
  };
}

describe('the capability objects', () => {
  it('are valid and say which gateway they describe; the adapter\'s own view stays raw, the facade\'s view adds pause and resume where the scheduler provides them', () => {
    const clock = new Clock(NOW);
    const fetch = scriptedFetch(() => ({ status: 500 })).fetch;
    for (const provider of [razorpayProvider(fetch, clock), cashfreeProvider(fetch, clock), payuProvider(fetch, clock), phonepeProvider(fetch, clock), paytmProvider(fetch, clock)]) {
      const { subs } = wire(provider, clock, []);
      expect(CapabilitiesSchema.safeParse(subs.capabilities(provider.name)).success).toBe(true);
      expect(provider.capabilities.provider).toBe(provider.name);
      expect(subs.provider(provider.name).capabilities).toBe(provider.capabilities);
      const { pause, resume, ...rest } = subs.capabilities(provider.name);
      const { pause: rawPause, resume: rawResume, ...rawRest } = provider.capabilities;
      expect(rest).toEqual(rawRest);
      expect([pause, resume]).toEqual(provider.capabilities.merchantCharges ? [true, true] : [rawPause, rawResume]);
    }
  });

  it('without a scheduler the facade reports the adapter\'s capabilities untouched', () => {
    const clock = new Clock(NOW);
    const payu = payuProvider(scriptedFetch(() => ({ status: 500 })).fetch, clock);
    const subs = createSubscriptions({ providers: [payu] });
    expect(subs.capabilities(Provider.PayU)).toBe(payu.capabilities);
    expect(subs.capabilities(Provider.PayU)).toMatchObject({ pause: false, resume: false });
  });

  it('merchantCharges, merchantPreDebitNotification and the lead hours tell the scheduler one coherent style per gateway', () => {
    const caps = adapters();
    expect(caps.razorpay).toMatchObject({ merchantCharges: false, merchantPreDebitNotification: false, scheduling: [SchedulingMode.Gateway] });
    expect(caps.razorpay.merchantChargeLeadHours).toBeUndefined();
    expect(caps.cashfree).toMatchObject({ merchantCharges: true, merchantPreDebitNotification: false, scheduling: [SchedulingMode.Gateway, SchedulingMode.Merchant] });
    expect(caps.cashfree.merchantChargeLeadHours).toBeGreaterThan(0);
    expect(caps.payu).toMatchObject({ merchantCharges: true, merchantPreDebitNotification: true, scheduling: [SchedulingMode.Merchant] });
    expect(caps.payu.merchantChargeLeadHours).toBeUndefined();
    expect(caps.phonepe).toMatchObject({ merchantCharges: true, merchantPreDebitNotification: true, scheduling: [SchedulingMode.Merchant] });
    expect(caps.paytm).toMatchObject({ merchantCharges: true, merchantPreDebitNotification: true, scheduling: [SchedulingMode.Merchant, SchedulingMode.Gateway] });
    expect([caps.phonepe.merchantChargeLeadHours, caps.paytm.merchantChargeLeadHours]).toEqual([undefined, undefined]);
  });

  it('the facade adds pause and resume exactly where the adapter cannot do them itself: PhonePe (false -> true through the scheduler); Paytm and the rest are unchanged', () => {
    const raw = adapters();
    const facade = effective();
    expect([raw.phonepe.pause, raw.phonepe.resume, facade.phonepe.pause, facade.phonepe.resume]).toEqual([false, false, true, true]);
    expect([raw.paytm.pause, raw.paytm.resume, facade.paytm.pause, facade.paytm.resume]).toEqual([true, true, true, true]);
    for (const name of [Provider.PhonePe, Provider.Paytm]) {
      const { pause: _pause, resume: _resume, ...rest } = facade[name];
      const { pause: _rawPause, resume: _rawResume, ...rawRest } = raw[name];
      expect(rest).toEqual(rawRest);
    }
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
    const caps = effective();
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
      [adapters().razorpay, adapters().cashfree, adapters().payu].map((caps) => caps.scheduling.includes(SchedulingMode.Merchant)),
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
      [PaymentMethod.NetBanking]: /net ?banking/i,
      [PaymentMethod.Wallet]: /wallet/i,
    };
    const caps = adapters();
    const cells = row('Payment methods');
    [caps.razorpay, caps.cashfree, caps.payu].forEach((capability, index) => {
      for (const method of Object.values(PaymentMethod)) expect(names[method].test(cells[index] as string)).toBe(capability.paymentMethods.includes(method));
    });
  });

  it('"Pause and resume" says Yes exactly where subs.capabilities() says pause and resume work (PayU: "Yes, through the scheduler")', () => {
    expect(row('Pause and resume').map(yes)).toEqual(flags((caps) => caps.pause && caps.resume));
  });

  it('...and the facade really does pause and resume PayU (through the scheduler), which is what the README and the capabilities say', async () => {
    const t = setupPayu();
    await t.create();
    await t.verify();
    expect((await t.subs.pause(Provider.PayU, PAYU_COMPOSITE)).status).toBe(SubscriptionStatus.Paused);
    expect((await t.subs.resume(Provider.PayU, PAYU_COMPOSITE)).status).not.toBe(SubscriptionStatus.Paused);
    expect(row('Pause and resume')[2]).toMatch(/scheduler/i);
    expect(adapters().payu).toMatchObject({ pause: false, resume: false });
    expect(effective().payu).toMatchObject({ pause: true, resume: true });
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

  it('an idempotency key that is not a UUID is refused locally for Cashfree (its x-idempotency-key is `format: UUID`)', async () => {
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

describe('PhonePe: every flag', () => {
  it('gatewayPlans=false: plans are UNSUPPORTED and a plan id string is refused; quantity=false is UNSUPPORTED; paymentMethods must include UPI; idempotency is accepted and not sent', async () => {
    const t = setupPhonePe();
    const common = { reference: PP_REFERENCE, customer: CUSTOMER, startAt: PP_DUE };
    expect((await rejection(() => t.subs.plans.create(Provider.PhonePe, { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.plans.get(Provider.PhonePe, 'p'))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.create(Provider.PhonePe, { ...common, plan: 'plan_1' }))).code).toBe(ErrorCode.Validation);
    expect((await rejection(() => t.subs.create(Provider.PhonePe, { ...common, plan: { ...PLAN }, quantity: 2 }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.create(Provider.PhonePe, { ...common, plan: { ...PLAN }, paymentMethods: [PaymentMethod.Card] }))).code).toBe(ErrorCode.Validation);
    expect(t.fake.requests).toHaveLength(0);
    await t.subs.create(Provider.PhonePe, { ...common, plan: { ...PLAN }, quantity: 1, paymentMethods: [PaymentMethod.Upi], idempotencyKey: 'order-1-create' });
    expect(JSON.stringify(t.fake.requests)).not.toContain('order-1-create');
    expect(adapters().phonepe).toMatchObject({ gatewayPlans: false, quantity: false, idempotencyKeys: false, paymentMethods: [PaymentMethod.Upi] });
  });

  it('trial=true and upfrontAmount=true: a trial delays the first debit; the upfront amount is the setup order\'s amount', async () => {
    const t = setupPhonePe({ upfrontAmount: 9900 });
    await t.create();
    expect(t.fake.requests.find((request) => request.body?.merchantOrderId !== undefined)?.body).toMatchObject({ amount: 9900 });
    const trial = await t.subs.create(Provider.PhonePe, { reference: 'pp_trial', plan: { ...PLAN }, customer: CUSTOMER, trial: { days: 7 } });
    expect(trial.trialEndsAt).toBeDefined();
  });

  it('pause / resume / update (false) are UNSUPPORTED on the adapter; through the facade pause and resume work (the scheduler); cancelAtPeriodEnd and changePlan (false) are refused with no side effect; listCharges (false) is UNSUPPORTED', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    expect((await rejection(() => t.provider.pauseSubscription(PP_REFERENCE))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.provider.resumeSubscription(PP_REFERENCE))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.provider.updateSubscription(PP_REFERENCE, { amount: 100 }))).code).toBe(ErrorCode.Unsupported);
    expect((await t.subs.pause(Provider.PhonePe, PP_REFERENCE)).status).toBe(SubscriptionStatus.Paused);
    expect((await t.subs.resume(Provider.PhonePe, PP_REFERENCE)).status).not.toBe(SubscriptionStatus.Paused);

    const before = t.fake.requests.length;
    expect((await rejection(() => t.subs.cancel(Provider.PhonePe, PP_REFERENCE, { mode: CancelMode.AtPeriodEnd }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.update(Provider.PhonePe, PP_REFERENCE, { planId: 'x', timing: ChangeTiming.Immediately }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.update(Provider.PhonePe, PP_REFERENCE, { quantity: 2 }))).code).toBe(ErrorCode.Unsupported);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
    expect(t.fake.requests).toHaveLength(before);
    expect((await rejection(() => t.subs.charges.list(Provider.PhonePe, PP_REFERENCE))).code).toBe(ErrorCode.Unsupported);
  });

  it('merchantCharges and merchantPreDebitNotification (true): notify returns the order id the debit must use, and createCharge with it debits once the window opens', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    const notice = await t.subs.charges.notify(Provider.PhonePe, { subscriptionId: PP_REFERENCE, notificationId: 'manual_n_1', amount: 49900, debitAt: PP_DUE });
    expect(notice).toMatchObject({ accepted: true, chargeId: 'manual_n_1' });
    t.clock.advanceHours(24);
    const charge = await t.subs.charges.create(Provider.PhonePe, { subscriptionId: PP_REFERENCE, chargeId: notice.chargeId as string, amount: 49900 });
    expect(charge).toMatchObject({ status: ChargeStatus.Pending, amount: 49900 });
    expect(t.fake.debits.has('manual_n_1')).toBe(true);
  });

  it('signedWebhooks=true: a webhook without the right Authorization header is SIGNATURE_INVALID', async () => {
    const t = setupPhonePe();
    await t.create();
    await t.authoriseAndVerify();
    const good = t.fake.mandateWebhook(PP_REFERENCE, 'paused');
    expect(await t.subs.webhooks.parse(Provider.PhonePe, good)).toHaveLength(1);
    expect((await rejection(async () => t.subs.webhooks.parse(Provider.PhonePe, { ...good, headers: {} }))).code).toBe(ErrorCode.SignatureInvalid);
    expect((await rejection(async () => t.subs.webhooks.parse(Provider.PhonePe, { ...good, headers: { authorization: 'nope' } }))).code).toBe(ErrorCode.SignatureInvalid);
  });
});

describe('Paytm: every flag', () => {
  it('gatewayPlans=false: plans are UNSUPPORTED and a plan id string is refused; quantity=false is UNSUPPORTED; physical NACH is refused; idempotency is accepted and not sent', async () => {
    const t = setupPaytm();
    const common = { reference: PT_REFERENCE, customer: CUSTOMER, startAt: PT_DUE };
    expect((await rejection(() => t.subs.plans.create(Provider.Paytm, { name: 'Pro', amount: 49900, interval: { unit: IntervalUnit.Month, count: 1 } }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.plans.get(Provider.Paytm, 'p'))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.create(Provider.Paytm, { ...common, plan: 'plan_1' }))).code).toBe(ErrorCode.Validation);
    expect((await rejection(() => t.subs.create(Provider.Paytm, { ...common, plan: { ...PLAN }, quantity: 2 }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.create(Provider.Paytm, { ...common, plan: { ...PLAN }, paymentMethods: [PaymentMethod.PhysicalNach] }))).code).toBe(ErrorCode.Validation);
    expect(t.fake.requests).toHaveLength(0);
    await t.subs.create(Provider.Paytm, { ...common, plan: { ...PLAN }, idempotencyKey: 'order-1-create' });
    expect(JSON.stringify(t.fake.requests)).not.toContain('order-1-create');
    expect(adapters().paytm).toMatchObject({ gatewayPlans: false, quantity: false, idempotencyKeys: false });
  });

  it('trial=true and upfrontAmount=true: the upfront amount is the first payment of the initiate request', async () => {
    const t = setupPaytm();
    await t.subs.create(Provider.Paytm, { reference: 'pt_up', plan: { ...PLAN }, customer: CUSTOMER, startAt: PT_DUE, upfrontAmount: 9900 });
    expect(t.fake.requests[0]?.body).toMatchObject({ txnAmount: { value: '99.00' } });
    const trial = await t.subs.create(Provider.Paytm, { reference: 'pt_trial', plan: { ...PLAN }, customer: CUSTOMER, trial: { days: 7 } });
    expect(trial.trialEndsAt).toBeDefined();
  });

  it('pause and resume (true): Paytm\'s own API in gateway mode; cancelAtPeriodEnd, changePlan and update (false) are refused with no side effect; listCharges (false) is UNSUPPORTED', async () => {
    const t = setupPaytm({ scheduling: SchedulingMode.Gateway, startAt: '2026-02-01T05:00:00.000Z' });
    const subscription = await t.create();
    await t.authoriseAndVerify(subscription);
    expect((await t.subs.pause(Provider.Paytm, subscription.id)).status).toBe(SubscriptionStatus.Paused);
    expect((await t.subs.resume(Provider.Paytm, subscription.id)).status).toBe(SubscriptionStatus.Active);
    const before = t.fake.requests.length;
    expect((await rejection(() => t.subs.cancel(Provider.Paytm, subscription.id, { mode: CancelMode.AtPeriodEnd }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.update(Provider.Paytm, subscription.id, { planId: 'x', timing: ChangeTiming.Immediately }))).code).toBe(ErrorCode.Unsupported);
    expect(t.fake.requests).toHaveLength(before);
    // An amount change is only possible for a merchant-collected mandate: here Paytm collects, so it reads the mandate and refuses.
    expect((await rejection(() => t.subs.update(Provider.Paytm, subscription.id, { amount: 100 }))).code).toBe(ErrorCode.Unsupported);
    expect(t.fake.requests.length - before).toBe(1);
    expect((await rejection(() => t.subs.charges.list(Provider.Paytm, subscription.id))).code).toBe(ErrorCode.Unsupported);
  });

  it('merchant mode: cancelAtPeriodEnd is refused BEFORE billing stops, and update with a planId or quantity is UNSUPPORTED with the schedule untouched', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    await t.authoriseAndVerify(subscription);
    expect((await rejection(() => t.subs.cancel(Provider.Paytm, subscription.id, { mode: CancelMode.AtPeriodEnd }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.update(Provider.Paytm, subscription.id, { planId: 'x' }))).code).toBe(ErrorCode.Unsupported);
    expect((await rejection(() => t.subs.update(Provider.Paytm, subscription.id, { quantity: 2 }))).code).toBe(ErrorCode.Unsupported);
    expect((await t.scheduler.get(t.scheduleId))?.status).toBe(ScheduleStatus.Active);
  });

  it('merchantCharges and merchantPreDebitNotification (true): a manual pre-notify, then a renew naming it, 24 hours later', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    await t.authoriseAndVerify(subscription);
    const notice = await t.subs.charges.notify(Provider.Paytm, { subscriptionId: subscription.id, notificationId: 'manual_n_1', amount: 49900, debitAt: PT_DUE });
    expect(notice).toMatchObject({ accepted: true, invoiceNumber: 'manual_n_1' });
    t.clock.advanceHours(24);
    const charge = await t.subs.charges.create(Provider.Paytm, { subscriptionId: subscription.id, chargeId: 'manual_c_1', amount: 49900, invoiceNumber: notice.invoiceNumber });
    expect(charge).toMatchObject({ status: ChargeStatus.Pending, amount: 49900 });
    expect(t.fake.debits.get('manual_c_1')?.status).toBe('PENDING');
  });

  it('refunds=true: only a successful debit is refunded, through Paytm\'s refund API', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    await t.authoriseAndVerify(subscription);
    await t.subs.charges.notify(Provider.Paytm, { subscriptionId: subscription.id, notificationId: 'manual_n_2', amount: 49900, debitAt: PT_DUE });
    t.clock.advanceHours(24);
    await t.subs.charges.create(Provider.Paytm, { subscriptionId: subscription.id, chargeId: 'manual_c_2', amount: 49900, invoiceNumber: 'manual_n_2' });
    expect((await rejection(() => t.subs.charges.refund(Provider.Paytm, { chargeId: 'manual_c_2', refundId: 'rf_a' }))).code).toBe(ErrorCode.Validation);
    t.fake.settle('manual_c_2', ChargeStatus.Succeeded);
    expect(await t.subs.charges.refund(Provider.Paytm, { chargeId: 'manual_c_2', refundId: 'rf_a' })).toMatchObject({ status: RefundStatus.Pending, amount: 49900 });
  });

  it('signedWebhooks=true: a form whose CHECKSUMHASH is missing or wrong is SIGNATURE_INVALID', async () => {
    const t = setupPaytm();
    const subscription = await t.create();
    await t.authoriseAndVerify(subscription);
    const good = t.fake.mandateWebhook(EventType.SubscriptionPaused);
    expect(await t.subs.webhooks.parse(Provider.Paytm, good)).toHaveLength(1);
    const wrong = new URLSearchParams(good.rawBody);
    wrong.set('STATUS', 'ACTIVE');
    expect((await rejection(async () => t.subs.webhooks.parse(Provider.Paytm, { rawBody: wrong.toString(), headers: {} }))).code).toBe(ErrorCode.SignatureInvalid);
    wrong.delete('CHECKSUMHASH');
    expect((await rejection(async () => t.subs.webhooks.parse(Provider.Paytm, { rawBody: wrong.toString(), headers: {} }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('paymentMethods: UPI, cards and eNACH are accepted; the capability lists them', () => {
    expect([...adapters().paytm.paymentMethods].sort()).toEqual([PaymentMethod.Card, PaymentMethod.ENach, PaymentMethod.Upi].sort());
  });
});
