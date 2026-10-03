import { describe, expect, it } from 'vitest';
import { Environment, ErrorCode, PaymentMethod, Provider, SchedulingMode } from '../../src/constants.js';
import { PhonePeConfigSchema, PhonePeProvider, phonepe } from '../../src/providers/phonepe/index.js';
import { CLIENT_ID, CLIENT_SECRET, CLIENT_VERSION, WEBHOOK_PASSWORD, WEBHOOK_USERNAME, everythingIn } from './helpers.js';

const VALID = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, clientVersion: CLIENT_VERSION, environment: Environment.Test };

function configError(config: unknown): Error & { code?: string } {
  try {
    phonepe(config as never);
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('expected the config to be refused');
}

describe('PhonePe config', () => {
  it('accepts the minimal config; webhook credentials and URLs are optional', () => {
    expect(phonepe(VALID)).toBeInstanceOf(PhonePeProvider);
    expect(PhonePeConfigSchema.parse({ ...VALID, clientVersion: 2 }).clientVersion).toBe('2');
    expect(
      phonepe({ ...VALID, webhookUsername: WEBHOOK_USERNAME, webhookPassword: WEBHOOK_PASSWORD, redirectUrl: 'https://merchant.example/return' }),
    ).toBeInstanceOf(PhonePeProvider);
  });

  it.each([
    ['no clientId', { ...VALID, clientId: '' }, 'clientId'],
    ['no clientSecret', { ...VALID, clientSecret: '' }, 'clientSecret'],
    ['no clientVersion', { ...VALID, clientVersion: undefined }, 'clientVersion'],
    ['a wrong environment', { ...VALID, environment: 'production' }, 'environment'],
    ['a webhook username without a password', { ...VALID, webhookUsername: WEBHOOK_USERNAME }, 'webhookPassword'],
    ['a webhook password without a username', { ...VALID, webhookPassword: WEBHOOK_PASSWORD }, 'webhookPassword'],
    ['an invalid redirectUrl', { ...VALID, redirectUrl: 'not a url' }, 'redirectUrl'],
    ['an invalid apiUrl', { ...VALID, apiUrl: 'nope' }, 'apiUrl'],
    ['an invalid tokenUrl', { ...VALID, tokenUrl: 'nope' }, 'tokenUrl'],
  ])('refuses %s with CONFIG, naming the field', (_name, config, field) => {
    const error = configError(config);
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain(field);
  });

  it('a config error never contains the secret, even when the secret itself is what is wrong', () => {
    const error = configError({ ...VALID, environment: CLIENT_SECRET, webhookUsername: WEBHOOK_USERNAME });
    expect(error.code).toBe(ErrorCode.Config);
    expect(everythingIn(error)).not.toContain(CLIENT_SECRET);
    expect(everythingIn(error)).not.toContain(WEBHOOK_USERNAME);
    expect(configError(null).code).toBe(ErrorCode.Config);
  });

  it('declares exactly the capabilities PhonePe Autopay has', () => {
    expect(phonepe(VALID).capabilities).toEqual({
      provider: Provider.PhonePe,
      scheduling: [SchedulingMode.Merchant],
      gatewayPlans: false,
      trial: true,
      upfrontAmount: true,
      quantity: false,
      pause: false,
      resume: false,
      cancelAtPeriodEnd: false,
      changePlan: false,
      merchantCharges: true,
      merchantPreDebitNotification: true,
      listCharges: false,
      refunds: true,
      signedWebhooks: true,
      idempotencyKeys: false,
      paymentMethods: [PaymentMethod.Upi],
    });
    expect(phonepe(VALID).name).toBe(Provider.PhonePe);
  });
});
