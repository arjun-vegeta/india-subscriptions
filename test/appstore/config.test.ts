import { describe, expect, it } from 'vitest';
import { Environment, ErrorCode, Provider, ProviderKind, SchedulingMode, PaymentMethod } from '../../src/constants.js';
import { AppStoreConfigSchema, AppStoreProvider, appStore } from '../../src/providers/appstore/index.js';
import { CapabilitiesSchema } from '../../src/schemas.js';
import { API_P8, APP_APPLE_ID, config, everythingIn, thrown } from './helpers.js';

function configError(overrides: Record<string, unknown>) {
  return thrown(() => appStore({ ...config(), ...overrides } as never));
}

describe('App Store config', () => {
  it('accepts the minimal config, and a numeric string for appAppleId', () => {
    expect(appStore(config())).toBeInstanceOf(AppStoreProvider);
    expect(AppStoreConfigSchema.parse({ ...config(), appAppleId: '1234567890' }).appAppleId).toBe(1234567890);
  });

  it('is the shared environment: test is the sandbox, live is production and needs the app Apple id', () => {
    expect(appStore(config({ environment: Environment.Live, appAppleId: APP_APPLE_ID }))).toBeInstanceOf(AppStoreProvider);
    const error = configError({ environment: Environment.Live });
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain('appAppleId');
  });

  it.each([
    ['no bundleId', { bundleId: '' }, 'bundleId'],
    ['no issuerId', { issuerId: '' }, 'issuerId'],
    ['no keyId', { keyId: '' }, 'keyId'],
    ['no privateKey', { privateKey: '' }, 'privateKey'],
    ['a wrong environment', { environment: 'production' }, 'environment'],
    ['a non-numeric appAppleId', { appAppleId: 'abc' }, 'appAppleId'],
    ['a promotional key without an id', { promotionalOfferKey: { keyId: '', privateKey: API_P8 } }, 'keyId'],
    ['empty rootCertificates', { rootCertificates: [] }, 'rootCertificates'],
  ])('refuses %s with CONFIG, naming the field', (_name, overrides, field) => {
    const error = configError(overrides);
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain(field);
  });

  it('refuses a private key that is not a P-256 .p8, without quoting it', () => {
    for (const privateKey of ['-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----', 'secret-key-text-never-real']) {
      const error = configError({ privateKey });
      expect(error.code).toBe(ErrorCode.Config);
      expect(error.message).toContain('privateKey');
      expect(everythingIn(error)).not.toContain('bm90IGEga2V5');
      expect(everythingIn(error)).not.toContain('secret-key-text-never-real');
    }
  });

  it('refuses a key on another curve', async () => {
    const { generateKeyPairSync } = await import('node:crypto');
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    expect(configError({ privateKey }).message).toContain('P-256');
  });

  it('accepts a key whose line breaks arrive as the two characters backslash n, as an environment variable often has them', () => {
    expect(appStore(config({ privateKey: API_P8.trim().replace(/\n/g, '\\n') }))).toBeInstanceOf(AppStoreProvider);
  });

  it('checks the promotional offer key too', () => {
    const error = configError({ promotionalOfferKey: { keyId: 'K1', privateKey: 'nope' } });
    expect(error.code).toBe(ErrorCode.Config);
    expect(error.message).toContain('promotionalOfferKey.privateKey');
  });

  it('never puts the private key into a config error, even when another field is what is wrong', () => {
    const error = configError({ environment: API_P8 });
    expect(error.code).toBe(ErrorCode.Config);
    expect(everythingIn(error)).not.toContain('PRIVATE KEY');
    expect(thrown(() => appStore(null as never)).code).toBe(ErrorCode.Config);
  });

  it('keeps the keys out of JSON, console output and spreads', () => {
    const provider = appStore(config({ promotionalOfferKey: { keyId: 'K1', privateKey: API_P8 } }));
    const text = JSON.stringify(provider) + JSON.stringify({ ...provider }) + Object.keys(provider).join(',');
    expect(text).not.toContain('PRIVATE KEY');
    expect(text).not.toContain(API_P8.split('\n')[1] as string);
  });

  it('declares exactly the capabilities of a store', () => {
    const capabilities = appStore(config()).capabilities;
    expect(CapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(capabilities).toEqual({
      provider: Provider.AppStore,
      kind: ProviderKind.Store,
      scheduling: [SchedulingMode.Gateway],
      gatewayPlans: false,
      trial: false,
      upfrontAmount: false,
      quantity: false,
      pause: false,
      resume: false,
      cancel: false,
      cancelAtPeriodEnd: false,
      changePlan: false,
      merchantCharges: false,
      merchantPreDebitNotification: false,
      listCharges: true,
      refunds: false,
      signedWebhooks: true,
      idempotencyKeys: false,
      paymentMethods: [],
      oneTimePayments: true,
      oneTimePaymentMethods: [],
    });
    expect(capabilities.paymentMethods).not.toContain(PaymentMethod.Upi);
    expect(appStore(config()).name).toBe(Provider.AppStore);
  });
});
