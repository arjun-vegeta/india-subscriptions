import { describe, expect, it } from 'vitest';
import { ErrorCode, HttpMethod } from '../../src/constants.js';
import { redactSecrets } from '../../src/providers/phonepe/auth.js';
import { ERROR_BAD_REQUEST, ERROR_INTERNAL_SERVER_ERROR, NOTIFICATION_STATUS_SC_NOTIFSTATUS } from './fixtures.js';
import {
  CLIENT_SECRET,
  TEST_TOKEN,
  WEBHOOK_AUTHORIZATION,
  WEBHOOK_PASSWORD,
  everythingIn,
  makeProvider,
  rejection,
  route,
  webhookRequest,
} from './helpers.js';

const SECRETS = [CLIENT_SECRET, TEST_TOKEN, WEBHOOK_PASSWORD, WEBHOOK_AUTHORIZATION, `O-Bearer ${TEST_TOKEN}`];

function expectClean(error: unknown): void {
  const text = everythingIn(error);
  for (const secret of SECRETS) expect(text).not.toContain(secret);
}

const BASE = { reference: 'sub_ref_1', plan: { name: 'Pro', amount: 49900, interval: { unit: 'month', count: 1 } }, customer: { name: 'A' }, returnUrl: 'https://merchant.example/r' } as const;

/** Every way an API call can fail, for a write and for a read: none may carry a secret, even when PhonePe echoes it. */
const FAILURES: [string, Parameters<typeof route>[2]][] = [
  ['400', { status: 400, json: ERROR_BAD_REQUEST }],
  ['401', { status: 401, json: { code: 'UNAUTHORIZED', message: 'bad token' } }],
  ['404', { status: 404, json: { code: 'SUBSCRIPTION_NOT_FOUND', message: 'nope' } }],
  ['500', { status: 500, json: ERROR_INTERNAL_SERVER_ERROR }],
  ['a non-JSON body', { status: 200, text: '<html>oops</html>' }],
  ['a body that echoes the Authorization header', { status: 400, json: { code: 'BAD_REQUEST', message: `rejected O-Bearer ${TEST_TOKEN}`, echo: { authorization: `O-Bearer ${TEST_TOKEN}`, secret: CLIENT_SECRET } } }],
  ['a dropped connection', { networkError: true }],
];

describe('no secret or token ever appears in an error', () => {
  it.each(FAILURES)('createSubscription failing with %s', async (_name, response) => {
    const t = makeProvider([route(HttpMethod.Post, '/checkout/v2/pay', response)], { tokens: 2 });
    expectClean(await rejection(() => t.provider.createSubscription(BASE as never)));
  });

  it.each(FAILURES)('getSubscription failing with %s', async (_name, response) => {
    const t = makeProvider([route(HttpMethod.Get, '/checkout/v2/subscriptions/Sub123/status', response), route(HttpMethod.Get, '/checkout/v2/subscriptions/Sub123/status', response)], { tokens: 2 });
    expectClean(await rejection(() => t.provider.getSubscription('Sub123')));
  });

  it.each(FAILURES)('getCharge failing with %s', async (_name, response) => {
    const t = makeProvider([route(HttpMethod.Get, '/checkout/v2/order/n_1/status?details=true', response), route(HttpMethod.Get, '/checkout/v2/order/n_1/status?details=true', response)], { tokens: 2 });
    expectClean(await rejection(() => t.provider.getCharge('Sub123', 'n_1')));
  });

  it.each(FAILURES)('refundCharge failing with %s', async (_name, response) => {
    const t = makeProvider([route(HttpMethod.Post, '/payments/v2/refund', response)]);
    expectClean(await rejection(() => t.provider.refundCharge({ chargeId: 'M1', refundId: 'R1', amount: 100 })));
  });

  it.each(FAILURES)('the redeem failing with %s', async (_name, response) => {
    const t = makeProvider([
      route(HttpMethod.Get, '/checkout/v2/order/n_1/status?details=true', { json: NOTIFICATION_STATUS_SC_NOTIFSTATUS }),
      route(HttpMethod.Post, '/checkout/v2/subscriptions/redeem', response),
    ]);
    t.clock.set(NOTIFICATION_STATUS_SC_NOTIFSTATUS.paymentFlow.validAfter + 3_600_000);
    expectClean(await rejection(() => t.provider.createCharge({ subscriptionId: 'Sub123', chargeId: 'n_1', amount: 100 })));
  });

  it('PhonePe echoing the token and the secret in an error body is scrubbed from message and raw, and the code survives', async () => {
    const t = makeProvider([
      route(HttpMethod.Post, '/checkout/v2/pay', {
        status: 400,
        json: { code: 'BAD_REQUEST', message: `rejected O-Bearer ${TEST_TOKEN}`, echo: { secret: CLIENT_SECRET, list: [TEST_TOKEN] } },
      }),
    ]);
    const error = await rejection(() => t.provider.createSubscription(BASE as never));
    expect(error).toMatchObject({ code: ErrorCode.Validation, httpStatus: 400, providerCode: 'BAD_REQUEST' });
    expect(error.message).toContain('[redacted]');
    expect(JSON.stringify((error as { raw?: unknown }).raw)).toContain('[redacted]');
    expectClean(error);
  });

  it('a webhook refused for its Authorization header names neither the password nor the expected digest', async () => {
    const t = makeProvider();
    const error = await rejection(async () => t.provider.parseWebhook(webhookRequest({ event: 'x', payload: {} }, 'wrong')));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expectClean(error);
  });

  it('a successful call returns nothing that carries the token or secret', async () => {
    const t = makeProvider([route(HttpMethod.Get, '/checkout/v2/subscriptions/Sub123/status', { json: { merchantSubscriptionId: 'Sub123', state: 'ACTIVE' } })]);
    const subscription = await t.provider.getSubscription('Sub123');
    const text = JSON.stringify(subscription);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
  });
});

describe('redactSecrets', () => {
  it('replaces in strings, arrays and plain objects, and reports whether anything changed', () => {
    const secret = 'a-very-long-secret-value';
    expect(redactSecrets({ a: `x ${secret} y`, b: [secret, 1], c: { d: secret }, e: 7 }, [secret])).toEqual({
      value: { a: 'x [redacted] y', b: ['[redacted]', 1], c: { d: '[redacted]' }, e: 7 },
      changed: true,
    });
    expect(redactSecrets({ a: 'nothing here' }, [secret]).changed).toBe(false);
  });

  it('ignores secrets that are too short to be told apart from ordinary text', () => {
    expect(redactSecrets('1 is 1', ['1'])).toEqual({ value: '1 is 1', changed: false });
  });
});
