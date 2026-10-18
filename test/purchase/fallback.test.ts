import { describe, expect, it, vi } from 'vitest';
import { RouteOutcomeKind, RouteOutcomeResult } from '../../src/routing/index.js';
import { AttemptOutcome, FALLBACK_ERROR_CODES, SessionStatus } from '../../src/purchase/index.js';
import {
  CUSTOMER,
  CUSTOMER_REF,
  ErrorCode,
  LIFETIME,
  MONTHLY,
  Platform,
  Provider,
  harness,
  rejection,
  result,
  type Harness,
} from './helpers.js';

const start = (h: Harness, fields: Record<string, unknown> = {}) =>
  h.purchases.start({ platform: Platform.Web, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF, ...fields } as never);

describe('gateway fallback on start', () => {
  it.each(FALLBACK_ERROR_CODES.map((code) => [code]))('%s moves on to the next ranked gateway', async (code) => {
    const h = harness();
    h.host.failCreates(Provider.Razorpay, code);
    const session = await start(h);
    expect(session.options[0]!.provider).toBe(Provider.Cashfree);
    expect(session.attempts.map((a) => [a.provider, a.outcome, a.errorCode])).toEqual([
      [Provider.Razorpay, AttemptOutcome.Failed, code],
      [Provider.Cashfree, AttemptOutcome.Created, undefined],
    ]);
  });

  it.each([ErrorCode.Conflict, ErrorCode.NotFound, ErrorCode.UnexpectedResponse])(
    '%s is raised at once and no other gateway is tried',
    async (code) => {
      const h = harness();
      h.host.failCreates(Provider.Razorpay, code);
      const error = await rejection(start(h));
      expect(error.code).toBe(code);
      expect(h.host.callsOf('create', Provider.Cashfree)).toHaveLength(0);
      expect(await h.store.findSessionByReference(CUSTOMER_REF, 'anything')).toBeUndefined();
    },
  );

  it.each([ErrorCode.Validation, ErrorCode.Unsupported])(
    'a gateway that refuses the purchase with %s created nothing: the next gateway takes it',
    async (code) => {
      const h = harness();
      h.host.failCreates(Provider.Razorpay, code);
      const session = await start(h);
      expect(session.options[0]!.provider).toBe(Provider.Cashfree);
      expect(session.attempts.map((a) => [a.provider, a.outcome, a.errorCode])).toEqual([
        [Provider.Razorpay, AttemptOutcome.Failed, code],
        [Provider.Cashfree, AttemptOutcome.Created, undefined],
      ]);
    },
  );

  it('a refusal of an optional input is skipped too: the product\'s payment methods leave only one gateway, which then refuses', async () => {
    const h = harness({ catalog: [{ ...LIFETIME, paymentMethods: ['wallet'] }] });
    h.host.failCreates(Provider.Cashfree, ErrorCode.Validation);
    const error = await rejection(start(h, { product: LIFETIME.key }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(h.host.callsOf('payments.create')).toHaveLength(1);
  });

  it('records a refusal as a failure, never as unavailable, so a gateway that keeps refusing one purchase is not taken out of rotation', async () => {
    const h = harness();
    const record = vi.spyOn(h.router, 'record');
    h.host.failCreates(Provider.Razorpay, ErrorCode.Validation);
    h.host.failCreates(Provider.Cashfree, ErrorCode.Unsupported);
    await start(h);
    expect(record.mock.calls.map(([outcome]) => [outcome.provider, outcome.kind, outcome.result])).toEqual([
      [Provider.Razorpay, RouteOutcomeKind.Request, RouteOutcomeResult.Failure],
      [Provider.Cashfree, RouteOutcomeKind.Request, RouteOutcomeResult.Failure],
      [Provider.PhonePe, RouteOutcomeKind.Request, RouteOutcomeResult.Success],
    ]);
    for (let i = 0; i < 6; i += 1) {
      h.host.failCreates(Provider.Razorpay, ErrorCode.Validation);
      await start(h, { customerRef: `c${i}` });
    }
    const session = await start(h, { customerRef: 'c_after' });
    expect(session.options[0]!.routing?.candidates.find((c) => c.provider === Provider.Razorpay)?.eligible).toBe(true);
  });

  it('when every gateway refuses the purchase the error is VALIDATION and lists each refusal', async () => {
    const h = harness();
    h.host.failCreates(Provider.Razorpay, ErrorCode.Validation);
    h.host.failCreates(Provider.Cashfree, ErrorCode.Unsupported);
    h.host.failCreates(Provider.PhonePe, ErrorCode.Validation);
    const error = await rejection(start(h));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/Every gateway tried failed/);
    for (const gateway of [Provider.Razorpay, Provider.Cashfree, Provider.PhonePe]) expect(error.message).toContain(gateway);
    expect(error.message).toContain('UNSUPPORTED');
    expect((error.raw as Array<{ provider: string; code: string }>).map((f) => [f.provider, f.code])).toEqual([
      [Provider.Razorpay, ErrorCode.Validation],
      [Provider.Cashfree, ErrorCode.Unsupported],
      [Provider.PhonePe, ErrorCode.Validation],
    ]);
  });

  it('when a refusal and an outage are mixed the error stays PROVIDER_UNAVAILABLE', async () => {
    const h = harness();
    h.host.failCreates(Provider.Razorpay, ErrorCode.Validation);
    h.host.failCreates(Provider.Cashfree, ErrorCode.ProviderUnavailable);
    h.host.failCreates(Provider.PhonePe, ErrorCode.Validation);
    const error = await rejection(start(h));
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
  });

  it('a CONFLICT after a refusal still stops at once', async () => {
    const h = harness();
    h.host.failCreates(Provider.Razorpay, ErrorCode.Validation);
    h.host.failCreates(Provider.Cashfree, ErrorCode.Conflict);
    const error = await rejection(start(h));
    expect(error.code).toBe(ErrorCode.Conflict);
    expect(h.host.callsOf('create', Provider.PhonePe)).toHaveLength(0);
  });

  it('records every attempt with the router: unavailable for outages, failure for refusals, success for the one that worked', async () => {
    const h = harness();
    const record = vi.spyOn(h.router, 'record');
    h.host.failCreates(Provider.Razorpay, ErrorCode.Timeout);
    h.host.failCreates(Provider.Cashfree, ErrorCode.ProviderError);
    await start(h, { product: MONTHLY.key });
    // PhonePe is third in the ranking and takes subscriptions.
    expect(record.mock.calls.map(([outcome]) => [outcome.provider, outcome.kind, outcome.result])).toEqual([
      [Provider.Razorpay, RouteOutcomeKind.Request, RouteOutcomeResult.Unavailable],
      [Provider.Cashfree, RouteOutcomeKind.Request, RouteOutcomeResult.Failure],
      [Provider.PhonePe, RouteOutcomeKind.Request, RouteOutcomeResult.Success],
    ]);
  });

  it('records a refusal that is raised at once as a failure', async () => {
    const h = harness();
    const record = vi.spyOn(h.router, 'record');
    h.host.failCreates(Provider.Razorpay, ErrorCode.Conflict);
    await rejection(start(h));
    expect(record).toHaveBeenCalledWith({ provider: Provider.Razorpay, kind: RouteOutcomeKind.Request, result: RouteOutcomeResult.Failure });
  });

  it('when every gateway fails the error says so and lists each one', async () => {
    const h = harness();
    for (const gateway of [Provider.Razorpay, Provider.Cashfree, Provider.PhonePe]) h.host.failCreates(gateway, ErrorCode.ProviderUnavailable);
    const error = await rejection(start(h));
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
    expect(error.message).toMatch(/Every gateway tried failed/);
    for (const gateway of [Provider.Razorpay, Provider.Cashfree, Provider.PhonePe]) expect(error.message).toContain(gateway);
    expect(error.retryable).toBe(true);
    expect((error.raw as unknown[]).length).toBe(3);
  });

  it('after repeated outages the router stops offering the gateway', async () => {
    const h = harness();
    for (let i = 0; i < 5; i += 1) {
      h.host.failCreates(Provider.Razorpay, ErrorCode.Network);
      await start(h, { customerRef: `c${i}` });
    }
    const session = await start(h, { customerRef: 'c_next' });
    expect(session.options[0]!.routing?.candidates.find((c) => c.provider === Provider.Razorpay)?.eligible).toBe(false);
    expect(session.options[0]!.provider).toBe(Provider.Cashfree);
  });
});

describe('chooseAlternative', () => {
  const androidSession = async (h: Harness, product = MONTHLY.key) =>
    h.purchases.start({ platform: Platform.Android, product, customer: CUSTOMER, customerRef: CUSTOMER_REF });

  it('creates the gateway option and keeps the token', async () => {
    const h = harness();
    const session = await androidSession(h);
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' });
    expect(chosen.status).toBe(SessionStatus.AwaitingPayment);
    expect(chosen.externalTransactionToken).toBe('tok_1');
    expect(chosen.options.map((o) => o.provider)).toEqual([Provider.GooglePlay, Provider.Razorpay]);
    expect(chosen.options[1]!.routing?.provider).toBe(Provider.Razorpay);
  });

  it('twice with the same token returns the same gateway option and creates one mandate', async () => {
    const h = harness();
    const session = await androidSession(h);
    const first = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' });
    const second = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' });
    expect(second).toEqual(first);
    expect(h.host.callsOf('create', Provider.Razorpay)).toHaveLength(1);
  });

  it('racing calls with the same token create one mandate', async () => {
    const h = harness();
    const session = await androidSession(h);
    await Promise.all([
      h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' }),
      h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' }),
    ]);
    expect(h.host.callsOf('create', Provider.Razorpay)).toHaveLength(1);
  });

  it('a different token once the option exists is a CONFLICT', async () => {
    const h = harness();
    const session = await androidSession(h);
    await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' });
    const error = await rejection(h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_2' }));
    expect(error.code).toBe(ErrorCode.Conflict);
  });

  it('falls back to the next gateway and records the attempts in the session', async () => {
    const h = harness();
    const session = await androidSession(h);
    h.host.failCreates(Provider.Razorpay, ErrorCode.Timeout);
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' });
    expect(chosen.options[1]!.provider).toBe(Provider.Cashfree);
    expect(chosen.attempts.map((a) => a.provider)).toEqual([Provider.Razorpay, Provider.Cashfree]);
  });

  it('when every gateway fails the session keeps the attempts, not the token, and the call can be repeated', async () => {
    const h = harness();
    const session = await androidSession(h);
    for (const gateway of [Provider.Razorpay, Provider.Cashfree, Provider.PhonePe]) h.host.failCreates(gateway, ErrorCode.ProviderUnavailable);
    await rejection(h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' }));
    const after = await h.purchases.get(session.id);
    expect(after.attempts).toHaveLength(3);
    expect(after.externalTransactionToken).toBeUndefined();
    expect(after.options).toHaveLength(1);
    const retried = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_2' });
    expect(retried.externalTransactionToken).toBe('tok_2');
    expect(retried.options).toHaveLength(2);
  });

  it('is refused for a session that is not user choice', async () => {
    const h = harness();
    const web = await h.purchases.start({ platform: Platform.Web, product: MONTHLY.key, customer: CUSTOMER, customerRef: CUSTOMER_REF });
    expect((await rejection(h.purchases.chooseAlternative(web.id, { externalTransactionToken: 't' }))).code).toBe(ErrorCode.Validation);
    const ios = await h.purchases.start({ platform: Platform.Ios, product: MONTHLY.key, customer: CUSTOMER, customerRef: 'other' });
    expect((await rejection(h.purchases.chooseAlternative(ios.id, { externalTransactionToken: 't' }))).code).toBe(ErrorCode.Validation);
  });

  it('is refused for an unknown, expired or completed session', async () => {
    const h = harness();
    expect((await rejection(h.purchases.chooseAlternative('ps_missing', { externalTransactionToken: 't' }))).code).toBe(ErrorCode.NotFound);
    const expired = await androidSession(h);
    h.clock.advance(25 * 3_600_000);
    expect((await rejection(h.purchases.chooseAlternative(expired.id, { externalTransactionToken: 't' }))).code).toBe(ErrorCode.Conflict);

    const h2 = harness();
    const done = await androidSession(h2);
    await h2.purchases.complete(done.id, { provider: Provider.GooglePlay, result: result(done.options[0]!.handle) });
    expect((await rejection(h2.purchases.chooseAlternative(done.id, { externalTransactionToken: 't' }))).code).toBe(ErrorCode.Conflict);
  });

  it('a one-time purchase works the same way', async () => {
    const h = harness();
    const session = await androidSession(h, LIFETIME.key);
    const chosen = await h.purchases.chooseAlternative(session.id, { externalTransactionToken: 'tok_1' });
    expect(chosen.options[1]!.handle).toMatch(/^order_/);
    expect(h.host.callsOf('payments.create', Provider.Razorpay)).toHaveLength(1);
  });
});
