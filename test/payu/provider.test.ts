import { describe, expect, it } from 'vitest';
import { Environment, ErrorCode, PaymentMethod, Provider, SchedulingMode, ProviderKind } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { PayUConfigSchema, PayUProvider, payu } from '../../src/providers/payu/index.js';
import { CUSTOMER, KEY, MONTHLY_PLAN, SALT, TEST_API_URL, apiRoute, makeProvider, signPayment } from './helpers.js';

async function failure(run: () => unknown): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

describe('config validation', () => {
  const valid = { key: KEY, salt: SALT, environment: Environment.Test };

  it('accepts the minimal config and applies defaults', () => {
    const parsed = PayUConfigSchema.parse(valid);
    expect(parsed.consentHashLayout).toBe('six_pipes');
    expect(parsed.acceptUnsignedWebhooks).toBe(false);
  });

  it.each([
    ['no key', { salt: SALT, environment: 'test' }, 'key'],
    ['an empty key', { key: '', salt: SALT, environment: 'test' }, 'key'],
    ['no salt', { key: KEY, environment: 'test' }, 'salt'],
    ['no environment', { key: KEY, salt: SALT }, 'environment'],
    ['an unknown environment', { ...valid, environment: 'staging' }, 'environment'],
    ['a bad successUrl', { ...valid, successUrl: 'not a url' }, 'successUrl'],
    ['a bad failureUrl', { ...valid, failureUrl: 'nope' }, 'failureUrl'],
    ['an unknown hash layout', { ...valid, consentHashLayout: 'seven_pipes' }, 'consentHashLayout'],
    ['a bad apiUrl', { ...valid, apiUrl: 'x' }, 'apiUrl'],
  ])('%s is a CONFIG error naming the field', (_label, config, field) => {
    try {
      payu(config as never);
      throw new Error('expected an error');
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
      expect((error as SubscriptionError).message).toContain(field);
    }
  });

  it('never puts the salt in a config error, even when another field is wrong', () => {
    try {
      payu({ key: KEY, salt: 'super-secret-salt-value', environment: 'staging' } as never);
      throw new Error('expected an error');
    } catch (error) {
      const text = JSON.stringify({ message: (error as Error).message, json: (error as SubscriptionError).toJSON(), raw: (error as SubscriptionError).raw });
      expect(text).not.toContain('super-secret-salt-value');
    }
  });

  it('apiUrl overrides the postservice URL', async () => {
    const calls: string[] = [];
    const provider = payu(
      { ...valid, apiUrl: 'https://proxy.example/postservice.php?form=2' },
      {
        fetch: async (url) => {
          calls.push(url);
          return new Response(JSON.stringify({ status: 'active', authpayuid: '1', amount: '1.00' }), { status: 200 });
        },
      },
    );
    await provider.getSubscription('card:1');
    expect(calls).toEqual(['https://proxy.example/postservice.php?form=2']);
  });

  it('the live environment uses info.payu.in for commands', async () => {
    const calls: string[] = [];
    const provider = payu(
      { ...valid, environment: Environment.Live },
      {
        fetch: async (url) => {
          calls.push(url);
          return new Response(JSON.stringify({ status: 'active', authpayuid: '1', amount: '1.00' }), { status: 200 });
        },
      },
    );
    await provider.getSubscription('card:1');
    expect(calls).toEqual(['https://info.payu.in/merchant/postservice.php?form=2']);
  });
});

describe('capabilities', () => {
  it('declares exactly what PayU can do', () => {
    const { provider } = makeProvider();
    expect(provider).toBeInstanceOf(PayUProvider);
    expect(provider.name).toBe(Provider.PayU);
    expect(provider.capabilities).toEqual({
      provider: Provider.PayU,
      kind: ProviderKind.Gateway,
      scheduling: [SchedulingMode.Merchant],
      gatewayPlans: false,
      trial: true,
      upfrontAmount: true,
      quantity: false,
      pause: false,
      resume: false,
      cancel: true,
      cancelAtPeriodEnd: false,
      changePlan: false,
      merchantCharges: true,
      merchantPreDebitNotification: true,
      listCharges: false,
      refunds: true,
      signedWebhooks: false,
      idempotencyKeys: false,
      paymentMethods: [PaymentMethod.Card, PaymentMethod.Upi, PaymentMethod.ENach],
      oneTimePayments: false,
      oneTimePaymentMethods: [],
    });
  });
});

describe('operations PayU cannot do are UNSUPPORTED', () => {
  it.each([
    ['createPlan', (p: PayUProvider) => p.createPlan({ name: 'x', amount: 100, interval: { unit: 'month', count: 1 } })],
    ['getPlan', (p: PayUProvider) => p.getPlan('plan_1')],
    ['pauseSubscription', (p: PayUProvider) => p.pauseSubscription('upi:1')],
    ['resumeSubscription', (p: PayUProvider) => p.resumeSubscription('upi:1')],
    ['listCharges', (p: PayUProvider) => p.listCharges('upi:1')],
  ])('%s', async (_name, run) => {
    const { provider, calls } = makeProvider();
    const error = await failure(() => run(provider));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.provider).toBe('payu');
    expect(calls).toHaveLength(0);
  });

  it('plan methods explain how to pass a plan', async () => {
    const { provider } = makeProvider();
    expect((await failure(() => provider.createPlan({ name: 'x', amount: 100, interval: { unit: 'month', count: 1 } }))).message).toContain(
      'inline',
    );
  });
});

/**
 * The salt signs everything. It must never leave through an error message, a log-shaped JSON, the raw payload an
 * error carries, a returned object or the form fields handed to the browser.
 */
describe('the salt never leaks', () => {
  it('not through any error this adapter throws', async () => {
    const attempts: (() => Promise<unknown>)[] = [];
    const bad = (body: unknown, status = 200) => makeProvider([apiRoute(body, status)]).provider;
    attempts.push(() => bad({ status: 0, msg: 'Invalid Hash.' }).getSubscription('card:1'));
    attempts.push(() => bad({ status: 0, message: 'nope' }).cancelSubscription('upi:1'));
    attempts.push(() => bad({ status: 0, message: 'nope' }).createCharge({ subscriptionId: 'card:1', chargeId: 'c', amount: 100 }));
    attempts.push(() => bad({ msg: 'boom' }, 500).notifyCharge({ subscriptionId: 'card:1', notificationId: 'n', amount: 100, debitAt: '2026-12-01T00:00:00.000Z' }));
    attempts.push(() => bad({ status: 0, msg: 'x', transaction_details: { c: { mihpayid: 'Not Found', status: 'Not Found' } } }).getCharge('card:1', 'c'));
    attempts.push(() => makeProvider([{ method: 'POST', url: TEST_API_URL, networkError: true }]).provider.createCharge({ subscriptionId: 'card:1', chargeId: 'c', amount: 100 }));
    attempts.push(() => makeProvider().provider.verifyCheckout({ ...signPayment({ status: 'success', txnid: 't', amount: '1.00' }), amount: '2.00' }));
    attempts.push(async () => makeProvider().provider.parseWebhook({ rawBody: 'a=b', headers: {} }));
    attempts.push(() => makeProvider().provider.createSubscription({ plan: 'p', customer: CUSTOMER }));
    attempts.push(() => makeProvider().provider.createSubscription({ plan: { ...MONTHLY_PLAN }, customer: { ...CUSTOMER, email: 'a!b@example.com' } }));

    for (const attempt of attempts) {
      const error = await failure(attempt);
      const everything = [
        error.message,
        JSON.stringify(error.toJSON()),
        JSON.stringify(error.raw ?? null),
        String(error.stack),
      ].join('\n');
      expect(everything).not.toContain(SALT);
    }
  });

  it('not in what a request sends: only the hash derived from it', async () => {
    const { provider, calls } = makeProvider([
      apiRoute({ status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { c: { mihpayid: 'Not Found', status: 'Not Found' } } }),
      apiRoute({ status: 1, message: 'ok', details: { c: { status: 'captured', transactionid: 'c', amount: '1.00' } } }),
    ]);
    await provider.createCharge({ subscriptionId: 'card:1', chargeId: 'c', amount: 100 });
    for (const call of calls) {
      expect(call.url + call.body + JSON.stringify(call.headers)).not.toContain(SALT);
      expect(Object.keys(call.form ?? {}).sort()).toEqual(['command', 'hash', 'key', 'var1']);
    }
  });

  it('not in what the adapter returns', async () => {
    const { provider } = makeProvider([apiRoute({ status: 'active', authpayuid: '1', amount: '1.00' })]);
    expect(JSON.stringify(await provider.getSubscription('card:1'))).not.toContain(SALT);
    expect(JSON.stringify(provider)).not.toContain(SALT);
    expect(Object.keys(provider).join()).not.toContain('salt');
  });
});
