import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorCode, Provider } from '../../src/constants.js';
import { SubscriptionError, invalid, isSubscriptionError, parseInput, parseResponse, unsupported } from '../../src/errors.js';
import { CreateSubscriptionInputSchema } from '../../src/schemas.js';

function thrown(fn: () => unknown): SubscriptionError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected a throw');
}

describe('SubscriptionError', () => {
  it('carries code, message and all options', () => {
    const cause = new Error('socket hang up');
    const raw = { error: { code: 'BAD_REQUEST_ERROR' } };
    const error = new SubscriptionError(ErrorCode.Validation, 'bad amount', {
      provider: Provider.Razorpay,
      httpStatus: 400,
      providerCode: 'BAD_REQUEST_ERROR',
      raw,
      cause,
    });
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(SubscriptionError);
    expect(error.name).toBe('SubscriptionError');
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toBe('bad amount');
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.httpStatus).toBe(400);
    expect(error.providerCode).toBe('BAD_REQUEST_ERROR');
    expect(error.raw).toBe(raw);
    expect(error.cause).toBe(cause);
  });

  it('leaves optional fields undefined and has no cause when none is given', () => {
    const error = new SubscriptionError(ErrorCode.Config, 'no fetch');
    expect(error.provider).toBeUndefined();
    expect(error.httpStatus).toBeUndefined();
    expect(error.providerCode).toBeUndefined();
    expect(error.raw).toBeUndefined();
    expect('cause' in error).toBe(false);
  });

  it('keeps a falsy cause', () => {
    expect(new SubscriptionError(ErrorCode.Network, 'x', { cause: 0 }).cause).toBe(0);
  });

  const retryable: ErrorCode[] = [ErrorCode.RateLimited, ErrorCode.ProviderUnavailable, ErrorCode.Network, ErrorCode.Timeout];

  it.each(Object.values(ErrorCode))('retryable for %s', (code) => {
    expect(new SubscriptionError(code, 'm').retryable).toBe(retryable.includes(code));
  });

  it('OUTCOME_UNKNOWN is explicitly not retryable (a blind retry could double-charge)', () => {
    expect(new SubscriptionError(ErrorCode.OutcomeUnknown, 'm').retryable).toBe(false);
  });

  it('toJSON exposes the public fields and never raw or cause', () => {
    const error = new SubscriptionError(ErrorCode.RateLimited, 'slow down', {
      provider: Provider.Cashfree,
      httpStatus: 429,
      providerCode: 'rate_limit',
      raw: { secret: 'client-secret-123', headers: { authorization: 'Basic abc' } },
      cause: new Error('inner-secret'),
    });
    const json = error.toJSON();
    expect(json).toEqual({
      name: 'SubscriptionError',
      code: ErrorCode.RateLimited,
      message: 'slow down',
      provider: Provider.Cashfree,
      httpStatus: 429,
      providerCode: 'rate_limit',
      retryable: true,
    });
    expect('raw' in json).toBe(false);
    const serialised = JSON.stringify(error);
    expect(serialised).not.toContain('client-secret-123');
    expect(serialised).not.toContain('inner-secret');
    expect(JSON.parse(serialised)).toMatchObject({ code: ErrorCode.RateLimited, retryable: true });
  });

  it('isSubscriptionError narrows only real instances', () => {
    expect(isSubscriptionError(new SubscriptionError(ErrorCode.Config, 'm'))).toBe(true);
    expect(isSubscriptionError(new Error('m'))).toBe(false);
    expect(isSubscriptionError({ code: ErrorCode.Config })).toBe(false);
    expect(isSubscriptionError(null)).toBe(false);
  });
});

describe('unsupported / invalid', () => {
  it('unsupported -> UNSUPPORTED naming provider and capability', () => {
    const error = unsupported(Provider.PayU, 'pausing subscriptions');
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(error.provider).toBe(Provider.PayU);
    expect(error.message).toBe('payu does not support pausing subscriptions');
    expect(error.retryable).toBe(false);
  });

  it('unsupported includes the reason when given', () => {
    expect(unsupported(Provider.Cashfree, 'refunds', 'use the dashboard').message).toBe('cashfree does not support refunds: use the dashboard');
  });

  it('invalid -> VALIDATION with optional provider and raw', () => {
    const plain = invalid('nope');
    expect(plain.code).toBe(ErrorCode.Validation);
    expect(plain.provider).toBeUndefined();
    const withExtras = invalid('nope', Provider.Razorpay, { a: 1 });
    expect(withExtras.provider).toBe(Provider.Razorpay);
    expect(withExtras.raw).toEqual({ a: 1 });
  });
});

describe('parseInput', () => {
  const schema = z.object({ amount: z.number().int(), customer: z.object({ email: z.email() }), tags: z.array(z.string()) });

  it('returns the parsed (output) value on success, applying defaults', () => {
    const withDefault = z.object({ currency: z.string().default('INR') });
    expect(parseInput(withDefault, {}, 'plan')).toEqual({ currency: 'INR' });
  });

  it('throws VALIDATION naming the offending path and what was being validated', () => {
    const error = thrown(() => parseInput(schema, { amount: 1, customer: { email: 'nope' }, tags: [] }, 'subscription', Provider.Razorpay));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.message).toMatch(/^Invalid subscription: /);
    expect(error.message).toContain('customer.email');
  });

  it('names nested array indices', () => {
    const error = thrown(() => parseInput(schema, { amount: 1, customer: { email: 'a@b.co' }, tags: ['ok', 5] }, 'x'));
    expect(error.message).toContain('tags.1');
  });

  it('names every missing field (up to five) and reports the root for a non-object', () => {
    const error = thrown(() => parseInput(schema, {}, 'x'));
    expect(error.message).toContain('amount');
    expect(error.message).toContain('customer');
    expect(error.message).toContain('tags');
    const root = thrown(() => parseInput(schema, 'a string', 'x'));
    expect(root.message).toContain('(root)');
  });

  it('truncates the message to five issues but keeps every issue in raw', () => {
    const wide = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string(), f: z.string(), g: z.string() });
    const error = thrown(() => parseInput(wide, {}, 'x'));
    expect(error.message.split('; ')).toHaveLength(5);
    expect(Array.isArray(error.raw)).toBe(true);
    expect((error.raw as unknown[]).length).toBe(7);
  });

  it('works with the real CreateSubscriptionInputSchema', () => {
    const error = thrown(() => parseInput(CreateSubscriptionInputSchema, { plan: 'plan_1', customer: { email: 'bad' } }, 'subscription input'));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('customer.email');
  });

  it('does not echo the offending value in the message', () => {
    const error = thrown(() => parseInput(schema, { amount: 1, customer: { email: 'topsecret-not-an-email' }, tags: [] }, 'x'));
    expect(error.message).not.toContain('topsecret-not-an-email');
  });
});

describe('parseResponse', () => {
  const schema = z.object({ id: z.string(), amount: z.number() });

  it('returns the parsed value on success', () => {
    expect(parseResponse(schema, { id: 'x', amount: 1, extra: true }, 'plan', Provider.Cashfree)).toEqual({ id: 'x', amount: 1 });
  });

  it('throws UNEXPECTED_RESPONSE with provider, path and the verbatim raw value', () => {
    const body = { id: 7, amount: 'x' };
    const error = thrown(() => parseResponse(schema, body, 'plan', Provider.Cashfree));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
    expect(error.provider).toBe(Provider.Cashfree);
    expect(error.raw).toBe(body);
    expect(error.message).toContain('cashfree');
    expect(error.message).toContain('plan');
    expect(error.message).toContain('id');
    expect(error.retryable).toBe(false);
  });

  it('fails on undefined (a non-JSON body)', () => {
    expect(thrown(() => parseResponse(schema, undefined, 'plan', Provider.PayU)).code).toBe(ErrorCode.UnexpectedResponse);
  });
});
