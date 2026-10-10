import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorCode, HttpMethod, Provider, ProviderKind, SchedulingMode, PaymentMethod } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { HttpRequest, HttpResponse } from '../../src/http.js';
import { BaseProvider, type GatewayErrorInfo, type ProviderOptions } from '../../src/provider.js';
import type { Capabilities } from '../../src/schemas.js';
import { mockFetch, type MockRoute } from '../helpers/mock-fetch.js';

const BASE = 'https://gateway.example.test/v1';
const SECRET_HEADER = 'Basic c2VjcmV0LWtleS1zZWNyZXQ=';

const capabilities: Capabilities = {
  provider: Provider.Razorpay,
  kind: ProviderKind.Gateway,
  scheduling: [SchedulingMode.Gateway],
  gatewayPlans: true,
  trial: true,
  upfrontAmount: true,
  quantity: true,
  pause: false,
  resume: false,
  cancel: true,
  cancelAtPeriodEnd: false,
  changePlan: false,
  merchantCharges: false,
  merchantPreDebitNotification: false,
  listCharges: false,
  refunds: false,
  signedWebhooks: true,
  idempotencyKeys: true,
  paymentMethods: [PaymentMethod.Upi],
  oneTimePayments: false,
  oneTimePaymentMethods: [],
};

const thingSchema = z.object({ id: z.string(), amount: z.number().int() });

/** The smallest concrete adapter: implements only what the base class makes abstract. */
class TestProvider extends BaseProvider {
  readonly name = Provider.Razorpay;
  readonly capabilities = capabilities;

  constructor(options: ProviderOptions = {}) {
    super(options);
    this.http.sleep = async () => {};
  }

  protected describeError(response: HttpResponse): GatewayErrorInfo {
    const body = response.json as { error?: { description?: string; code?: string } } | undefined;
    return { message: body?.error?.description ?? (response.text || 'no body'), providerCode: body?.error?.code };
  }

  // --- test seams onto the protected plumbing ---
  fetchThing(request: Partial<HttpRequest> = {}) {
    return this.send({ method: HttpMethod.Get, url: `${BASE}/things/1`, idempotent: true, ...request }, thingSchema, 'thing');
  }
  rawCall(request: Partial<HttpRequest> = {}) {
    return this.sendRaw({ method: HttpMethod.Get, url: `${BASE}/things/1`, idempotent: true, ...request });
  }
  currentTime() {
    return this.now();
  }

  // --- required members the tests do not exercise ---
  createSubscription(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  getSubscription(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  cancelSubscription(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  verifyCheckout(): Promise<never> {
    return Promise.reject(new Error('not used'));
  }
  parseWebhook(): never {
    throw new Error('not used');
  }
}

function build(routes: MockRoute[], options: ProviderOptions = {}) {
  const mock = mockFetch(routes);
  return { provider: new TestProvider({ fetch: mock.fetch, ...options }), ...mock };
}

async function rejection(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the promise to reject');
}

describe('BaseProvider: unsupported optional operations', () => {
  const { provider } = build([]);
  const operations: Array<[string, () => Promise<unknown>, RegExp]> = [
    ['createPlan', () => provider.createPlan({ name: 'Pro', amount: 100, interval: { unit: 'month', count: 1 } }), /creating plans/],
    ['getPlan', () => provider.getPlan('plan_1'), /fetching plans/],
    ['pauseSubscription', () => provider.pauseSubscription('sub_1'), /pausing/],
    ['resumeSubscription', () => provider.resumeSubscription('sub_1'), /resuming/],
    ['updateSubscription', () => provider.updateSubscription('sub_1', { quantity: 2 }), /updating/],
    ['listCharges', () => provider.listCharges('sub_1'), /listing charges/],
    ['getCharge', () => provider.getCharge('sub_1', 'pay_1'), /fetching a charge/],
    [
      'notifyCharge',
      () => provider.notifyCharge({ subscriptionId: 'sub_1', notificationId: 'n1', amount: 100, debitAt: '2026-12-01T00:00:00Z' }),
      /pre-debit notifications/,
    ],
    ['createCharge', () => provider.createCharge({ subscriptionId: 'sub_1', chargeId: 'c1', amount: 100 }), /merchant-raised charges/],
    ['refundCharge', () => provider.refundCharge({ chargeId: 'pay_1', refundId: 'r1' }), /refunds/],
    [
      'createPayment',
      () => provider.createPayment({ amount: 49900, customer: { email: 'asha@example.com' } }),
      /one-time payments/,
    ],
    ['getPayment', () => provider.getPayment('pay_1'), /fetching a payment/],
    ['verifyPayment', () => provider.verifyPayment({ razorpay_payment_id: 'pay_1' }), /verifying a payment/],
    ['refundPayment', () => provider.refundPayment({ paymentId: 'pay_1', refundId: 'r1' }), /refunding a payment/],
  ];

  it.each(operations)('%s rejects with UNSUPPORTED naming the provider', async (_name, call, message) => {
    const error = await rejection(call());
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.message).toMatch(message);
    expect(error.retryable).toBe(false);
  });

  it.each(operations)('%s returns a rejected promise rather than throwing synchronously', (_name, call) => {
    let promise: Promise<unknown> | undefined;
    expect(() => {
      promise = call();
    }).not.toThrow();
    return expect(promise).rejects.toBeInstanceOf(SubscriptionError);
  });

  it('makes no HTTP request for an unsupported operation', async () => {
    const { provider: p, calls } = build([]);
    await rejection(p.refundCharge({ chargeId: 'pay_1', refundId: 'r1' }));
    expect(calls).toHaveLength(0);
  });
});

describe('BaseProvider.send: success path', () => {
  it('returns the body validated and parsed by the schema (unknown keys stripped)', async () => {
    const { provider, calls } = build([{ url: `${BASE}/things/1`, json: { id: 'thing_1', amount: 49900, extra: 'x' } }]);
    const result = await provider.fetchThing({ headers: { authorization: SECRET_HEADER } });
    expect(result).toEqual({ id: 'thing_1', amount: 49900 });
    expect(calls[0]).toMatchObject({ method: 'GET', url: `${BASE}/things/1`, headers: { authorization: SECRET_HEADER } });
  });

  it('accepts any 2xx status', async () => {
    for (const status of [200, 201, 202]) {
      const { provider } = build([{ url: `${BASE}/things/1`, status, json: { id: 'a', amount: 1 } }]);
      expect(await provider.fetchThing()).toEqual({ id: 'a', amount: 1 });
    }
  });

  it('sendRaw returns the raw response without schema validation', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, text: 'plain text', headers: { 'content-type': 'text/plain' } }]);
    const response = await provider.rawCall();
    expect(response.status).toBe(200);
    expect(response.text).toBe('plain text');
    expect(response.json).toBeUndefined();
  });

  it('retries idempotent reads via the shared client, then succeeds', async () => {
    const { provider, calls } = build([
      { url: `${BASE}/things/1`, status: 503, json: { error: { description: 'busy' } } },
      { url: `${BASE}/things/1`, status: 200, json: { id: 'a', amount: 1 } },
    ]);
    expect(await provider.fetchThing()).toEqual({ id: 'a', amount: 1 });
    expect(calls).toHaveLength(2);
  });

  it('does not retry a non-idempotent write', async () => {
    const { provider, calls } = build([
      { url: `${BASE}/things`, status: 503, json: {} },
      { url: `${BASE}/things`, status: 200, json: { id: 'a', amount: 1 } },
    ]);
    const error = await rejection(provider.fetchThing({ method: HttpMethod.Post, url: `${BASE}/things`, idempotent: false, body: '{}' }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });
});

describe('BaseProvider.send: HTTP errors map to ErrorCode', () => {
  const errorBody = { error: { code: 'BAD_REQUEST_ERROR', description: 'The amount is invalid' } };

  it.each([
    [400, ErrorCode.Validation],
    [401, ErrorCode.Auth],
    [403, ErrorCode.Auth],
    [404, ErrorCode.NotFound],
    [409, ErrorCode.Conflict],
    [422, ErrorCode.Validation],
    [429, ErrorCode.RateLimited],
    [402, ErrorCode.ProviderError],
    [302, ErrorCode.ProviderError],
  ])('%s -> %s, carrying httpStatus, providerCode and raw', async (status, code) => {
    // maxRetries 0: 429 is retried on idempotent reads, and this test is about the final mapping
    const { provider } = build([{ url: `${BASE}/things/1`, status, json: errorBody }], { maxRetries: 0 });
    const error = await rejection(provider.fetchThing());
    expect(error.code).toBe(code);
    expect(error.httpStatus).toBe(status);
    expect(error.providerCode).toBe('BAD_REQUEST_ERROR');
    expect(error.raw).toEqual(errorBody);
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.message).toContain(`${status}`);
    expect(error.message).toContain('The amount is invalid');
    expect(error.message).toContain(Provider.Razorpay);
  });

  it.each([500, 502, 503, 504])('%s on an idempotent request -> PROVIDER_UNAVAILABLE (retryable) after exhausting retries', async (status) => {
    const { provider, calls } = build(Array.from({ length: 3 }, () => ({ url: `${BASE}/things/1`, status, json: errorBody })));
    const error = await rejection(provider.fetchThing());
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
    expect(error.retryable).toBe(true);
    expect(error.httpStatus).toBe(status);
    expect(error.providerCode).toBe('BAD_REQUEST_ERROR');
    expect(calls).toHaveLength(3);
  });

  it.each([500, 502, 503, 504])('%s on a non-idempotent request -> OUTCOME_UNKNOWN (not retryable), with the status preserved', async (status) => {
    const { provider, calls } = build([{ url: `${BASE}/things`, status, json: errorBody }]);
    const error = await rejection(provider.fetchThing({ method: HttpMethod.Post, url: `${BASE}/things`, idempotent: false, body: '{}' }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it('429 on a non-idempotent write is still RATE_LIMITED', async () => {
    const { provider } = build([{ url: `${BASE}/things`, status: 429, json: errorBody }]);
    const error = await rejection(provider.fetchThing({ method: HttpMethod.Post, url: `${BASE}/things`, idempotent: false, body: '{}' }));
    expect(error.code).toBe(ErrorCode.RateLimited);
    expect(error.retryable).toBe(true);
  });

  it('keeps the text body as raw when the error body is not JSON', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, status: 404, text: '<html>Not Found</html>' }]);
    const error = await rejection(provider.fetchThing());
    expect(error.code).toBe(ErrorCode.NotFound);
    expect(error.raw).toBe('<html>Not Found</html>');
    expect(error.providerCode).toBeUndefined();
  });

  it('sendRaw maps errors the same way', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, status: 401, json: errorBody }]);
    const error = await rejection(provider.rawCall());
    expect(error.code).toBe(ErrorCode.Auth);
    expect(error.httpStatus).toBe(401);
  });

  it('never leaks request credentials into the error', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, status: 401, json: errorBody }]);
    const error = await rejection(provider.fetchThing({ headers: { authorization: SECRET_HEADER } }));
    const everything = JSON.stringify([error.message, error.toJSON(), error.raw]);
    expect(everything).not.toContain(SECRET_HEADER);
    expect(everything).not.toContain('c2VjcmV0');
  });

  it('transport failures carry the provider name', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, networkError: true }], { maxRetries: 0 });
    const error = await rejection(provider.fetchThing());
    expect(error.code).toBe(ErrorCode.Network);
    expect(error.provider).toBe(Provider.Razorpay);
  });

  it('a dropped connection on a non-idempotent write is OUTCOME_UNKNOWN', async () => {
    const { provider } = build([{ url: `${BASE}/things`, networkError: true }]);
    const error = await rejection(provider.fetchThing({ method: HttpMethod.Post, url: `${BASE}/things`, idempotent: false, body: '{}' }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(error.provider).toBe(Provider.Razorpay);
  });
});

describe('BaseProvider.send: response validation', () => {
  it('throws UNEXPECTED_RESPONSE, with the body as raw, when a required field is missing', async () => {
    const body = { id: 'thing_1' };
    const { provider } = build([{ url: `${BASE}/things/1`, json: body }]);
    const error = await rejection(provider.fetchThing());
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.raw).toEqual(body);
    expect(error.message).toContain('amount');
    expect(error.message).toContain('thing');
  });

  it('throws UNEXPECTED_RESPONSE when a field has the wrong type or unit (rupee decimal instead of paise)', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, json: { id: 'thing_1', amount: 499.5 } }]);
    expect((await rejection(provider.fetchThing())).code).toBe(ErrorCode.UnexpectedResponse);
    const { provider: p2 } = build([{ url: `${BASE}/things/1`, json: { id: 'thing_1', amount: '49900' } }]);
    expect((await rejection(p2.fetchThing())).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('throws UNEXPECTED_RESPONSE for a 2xx with a non-JSON body (e.g. an HTML maintenance page)', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, text: '<html>maintenance</html>', headers: { 'content-type': 'text/html' } }]);
    const error = await rejection(provider.fetchThing());
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('throws UNEXPECTED_RESPONSE for a 2xx with an empty body or a JSON null', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, text: '' }]);
    expect((await rejection(provider.fetchThing())).code).toBe(ErrorCode.UnexpectedResponse);
    const { provider: p2 } = build([{ url: `${BASE}/things/1`, text: 'null' }]);
    expect((await rejection(p2.fetchThing())).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('checks the HTTP status before the body: a 404 with a valid-looking body is still NOT_FOUND', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, status: 404, json: { id: 'thing_1', amount: 1 } }]);
    expect((await rejection(provider.fetchThing())).code).toBe(ErrorCode.NotFound);
  });

  // DEFECT (src/provider.ts, BaseProvider.send): for a 2xx whose body is not JSON, parseResponse is
  // handed `response.json` (undefined), so the UNEXPECTED_RESPONSE error carries raw === undefined and
  // the actual body text the gateway returned is lost. The non-2xx path keeps it
  // (`raw: response.json ?? response.text`); the 2xx path should too, for debugging.
  it('keeps the response text as raw when a 2xx body is not JSON', async () => {
    const { provider } = build([{ url: `${BASE}/things/1`, text: '<html>maintenance</html>' }]);
    const error = await rejection(provider.fetchThing());
    expect(error.raw).toBe('<html>maintenance</html>');
  });
});

describe('BaseProvider: clock', () => {
  it('honours the now option', () => {
    const fixed = new Date('2026-11-17T05:00:00Z');
    const provider = new TestProvider({ fetch: mockFetch([]).fetch, now: () => fixed });
    expect(provider.currentTime()).toBe(fixed);
  });

  it('calls the clock on every use rather than caching a value', () => {
    let tick = 0;
    const provider = new TestProvider({ fetch: mockFetch([]).fetch, now: () => new Date(Date.UTC(2026, 10, 17, 5, 0, tick++)) });
    expect(provider.currentTime().toISOString()).toBe('2026-11-17T05:00:00.000Z');
    expect(provider.currentTime().toISOString()).toBe('2026-11-17T05:00:01.000Z');
  });

  it('defaults to the real clock', () => {
    const provider = new TestProvider({ fetch: mockFetch([]).fetch });
    const before = Date.now();
    const value = provider.currentTime().getTime();
    expect(value).toBeGreaterThanOrEqual(before);
    expect(value).toBeLessThanOrEqual(Date.now());
  });
});

describe('BaseProvider: construction', () => {
  it('exposes name and capabilities from the subclass', () => {
    const provider = new TestProvider({ fetch: mockFetch([]).fetch });
    expect(provider.name).toBe(Provider.Razorpay);
    expect(provider.capabilities).toBe(capabilities);
  });

  it('passes HTTP options (maxRetries) through to the client', async () => {
    const { provider, calls } = build(
      [
        { url: `${BASE}/things/1`, status: 503, json: {} },
        { url: `${BASE}/things/1`, status: 200, json: { id: 'a', amount: 1 } },
      ],
      { maxRetries: 0 },
    );
    expect((await rejection(provider.fetchThing())).code).toBe(ErrorCode.ProviderUnavailable);
    expect(calls).toHaveLength(1);
  });
});
