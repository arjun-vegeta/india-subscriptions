import { describe, expect, it } from 'vitest';
import { Environment, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { EnvVar, PROVIDER_ORDER, STORE_ORDER, parseServiceEnv, type EnvironmentVariables } from '../../src/service-config.js';

const API_KEY = 'a-long-random-service-api-key';
const SECRET = 'super-secret-store-value-do-not-print';
const PEM = '-----BEGIN PRIVATE KEY-----\\nMIIB-line-one\\nMIIB-line-two\\n-----END PRIVATE KEY-----';
const RAZORPAY: EnvironmentVariables = { [EnvVar.RazorpayKeyId]: 'rzp_test_id', [EnvVar.RazorpayKeySecret]: SECRET };

const appStoreEnv: EnvironmentVariables = {
  [EnvVar.AppStoreBundleId]: 'com.example.app',
  [EnvVar.AppStoreIssuerId]: '57246542-96fe-1a63-e053-0824d011072a',
  [EnvVar.AppStoreKeyId]: 'ABC123DEFG',
  [EnvVar.AppStorePrivateKey]: PEM,
  [EnvVar.AppStoreEnvironment]: Environment.Test,
};
const googlePlayEnv: EnvironmentVariables = {
  [EnvVar.GooglePlayPackageName]: 'com.example.app',
  [EnvVar.GooglePlayClientEmail]: 'billing@example-project.iam.gserviceaccount.com',
  [EnvVar.GooglePlayPrivateKey]: PEM,
  [EnvVar.GooglePlayEnvironment]: Environment.Test,
  [EnvVar.GooglePlayPushAudience]: 'https://billing.example.com/v1/google_play/webhooks',
  [EnvVar.GooglePlayPushServiceAccountEmail]: 'pubsub-push@example-project.iam.gserviceaccount.com',
};

function failure(env: EnvironmentVariables): SubscriptionError {
  try {
    parseServiceEnv({ [EnvVar.ApiKey]: API_KEY, ...env });
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected parseServiceEnv to throw');
}

const parse = (env: EnvironmentVariables) => parseServiceEnv({ [EnvVar.ApiKey]: API_KEY, ...env });

describe('app store variables', () => {
  it('lists the stores after the gateways', () => {
    expect(STORE_ORDER).toEqual([Provider.AppStore, Provider.GooglePlay]);
    expect(PROVIDER_ORDER.slice(-2)).toEqual([Provider.AppStore, Provider.GooglePlay]);
  });

  it('maps every APP_STORE_ variable to the adapter config, restoring the line breaks of a one-line key', () => {
    const config = parse({
      ...appStoreEnv,
      [EnvVar.AppStoreEnvironment]: Environment.Live,
      [EnvVar.AppStoreAppAppleId]: '1234567890',
      [EnvVar.AppStoreOfferKeyId]: 'HIJ456KLMN',
      [EnvVar.AppStoreOfferPrivateKey]: PEM,
    });
    expect(config.stores[Provider.AppStore]).toEqual({
      bundleId: 'com.example.app',
      issuerId: '57246542-96fe-1a63-e053-0824d011072a',
      keyId: 'ABC123DEFG',
      privateKey: '-----BEGIN PRIVATE KEY-----\nMIIB-line-one\nMIIB-line-two\n-----END PRIVATE KEY-----',
      environment: Environment.Live,
      appAppleId: 1234567890,
      promotionalOfferKey: { keyId: 'HIJ456KLMN', privateKey: '-----BEGIN PRIVATE KEY-----\nMIIB-line-one\nMIIB-line-two\n-----END PRIVATE KEY-----' },
    });
    expect(config.gateways).toEqual({});
  });

  it('the store alone is a valid deployment, and the optional fields stay unset', () => {
    const config = parse(appStoreEnv);
    expect(Object.keys(config.stores)).toEqual([Provider.AppStore]);
    expect(config.stores[Provider.AppStore]).toMatchObject({ appAppleId: undefined, promotionalOfferKey: undefined });
  });

  it.each([
    [EnvVar.AppStoreBundleId],
    [EnvVar.AppStoreIssuerId],
    [EnvVar.AppStoreKeyId],
    [EnvVar.AppStorePrivateKey],
    [EnvVar.AppStoreEnvironment],
  ])('refuses a store with %s missing, naming it', (name) => {
    const env = { ...appStoreEnv, [name]: undefined };
    expect(failure(env).message).toContain(`${name}: is required`);
  });

  it('a lone optional variable means the store is meant to be on, so the required ones are reported', () => {
    const message = failure({ [EnvVar.AppStoreAppAppleId]: '1' }).message;
    for (const name of [EnvVar.AppStoreBundleId, EnvVar.AppStoreIssuerId, EnvVar.AppStoreKeyId, EnvVar.AppStorePrivateKey, EnvVar.AppStoreEnvironment]) {
      expect(message).toContain(`${name}: is required`);
    }
  });

  it('needs the app\'s Apple id when live (the adapter\'s rule, named by variable)', () => {
    expect(failure({ ...appStoreEnv, [EnvVar.AppStoreEnvironment]: Environment.Live }).message).toContain(EnvVar.AppStoreAppAppleId);
  });

  it('validates the environment, the Apple id and the offer key pair', () => {
    expect(failure({ ...appStoreEnv, [EnvVar.AppStoreEnvironment]: 'prod' }).message).toContain(`${EnvVar.AppStoreEnvironment}: must be "test" or "live"`);
    expect(failure({ ...appStoreEnv, [EnvVar.AppStoreAppAppleId]: 'abc' }).message).toContain(`${EnvVar.AppStoreAppAppleId}: must be a whole number`);
    expect(failure({ ...appStoreEnv, [EnvVar.AppStoreOfferKeyId]: 'K' }).message).toContain(
      `${EnvVar.AppStoreOfferPrivateKey}: is required when ${EnvVar.AppStoreOfferKeyId} is set`,
    );
    expect(failure({ ...appStoreEnv, [EnvVar.AppStoreOfferPrivateKey]: PEM }).message).toContain(
      `${EnvVar.AppStoreOfferKeyId}: is required when ${EnvVar.AppStoreOfferPrivateKey} is set`,
    );
  });
});

describe('Google Play variables', () => {
  it('maps every GOOGLE_PLAY_ variable to the adapter config', () => {
    const config = parse({
      ...googlePlayEnv,
      [EnvVar.GooglePlayPrivateKeyId]: 'kid-1',
      [EnvVar.GooglePlayAcceptUnauthenticatedWebhooks]: 'false',
      [EnvVar.GooglePlayRevokeOnRefund]: 'false',
      [EnvVar.GooglePlayConsumableProductIds]: ' coins_100 , coins_500,,',
    });
    expect(config.stores[Provider.GooglePlay]).toEqual({
      packageName: 'com.example.app',
      clientEmail: 'billing@example-project.iam.gserviceaccount.com',
      privateKey: '-----BEGIN PRIVATE KEY-----\nMIIB-line-one\nMIIB-line-two\n-----END PRIVATE KEY-----',
      privateKeyId: 'kid-1',
      environment: Environment.Test,
      pushAudience: 'https://billing.example.com/v1/google_play/webhooks',
      pushServiceAccountEmail: 'pubsub-push@example-project.iam.gserviceaccount.com',
      acceptUnauthenticatedWebhooks: false,
      revokeOnRefund: false,
      consumableProductIds: ['coins_100', 'coins_500'],
    });
  });

  it.each([
    [EnvVar.GooglePlayPackageName],
    [EnvVar.GooglePlayClientEmail],
    [EnvVar.GooglePlayPrivateKey],
    [EnvVar.GooglePlayEnvironment],
  ])('refuses a store with %s missing, naming it', (name) => {
    expect(failure({ ...googlePlayEnv, [name]: undefined }).message).toContain(`${name}: is required`);
  });

  it('needs the push audience and the push service account together', () => {
    const { [EnvVar.GooglePlayPushServiceAccountEmail]: _email, ...audienceOnly } = googlePlayEnv;
    expect(failure(audienceOnly).message).toContain(
      `${EnvVar.GooglePlayPushServiceAccountEmail}: is required when ${EnvVar.GooglePlayPushAudience} is set`,
    );
    const { [EnvVar.GooglePlayPushAudience]: _audience, ...emailOnly } = googlePlayEnv;
    expect(failure(emailOnly).message).toContain(
      `${EnvVar.GooglePlayPushAudience}: is required when ${EnvVar.GooglePlayPushServiceAccountEmail} is set`,
    );
  });

  it('lets the adapter\'s own schema have the last word, naming the variable', () => {
    expect(failure({ ...googlePlayEnv, [EnvVar.GooglePlayPackageName]: 'nodots' }).message).toContain(EnvVar.GooglePlayPackageName);
    expect(failure({ ...googlePlayEnv, [EnvVar.GooglePlayClientEmail]: 'not-an-email' }).message).toContain(EnvVar.GooglePlayClientEmail);
    expect(failure({ ...googlePlayEnv, [EnvVar.GooglePlayAcceptUnauthenticatedWebhooks]: 'maybe' }).message).toContain(
      `${EnvVar.GooglePlayAcceptUnauthenticatedWebhooks}: must be "true" or "false"`,
    );
  });

  it('warns when pushes cannot be authenticated, and is quiet once they can or the merchant chose not to', () => {
    const { [EnvVar.GooglePlayPushAudience]: _a, [EnvVar.GooglePlayPushServiceAccountEmail]: _e, ...bare } = googlePlayEnv;
    expect(parse(bare).warnings.join('\n')).toContain('webhooks from google_play will be rejected');
    expect(parse({ ...bare, [EnvVar.GooglePlayAcceptUnauthenticatedWebhooks]: 'true' }).warnings.join('\n')).not.toContain('google_play');
    expect(parse(googlePlayEnv).warnings.join('\n')).not.toContain('google_play');
  });
});

describe('stores and gateways together', () => {
  it('enables all of them, in order', () => {
    const config = parse({ ...RAZORPAY, ...appStoreEnv, ...googlePlayEnv });
    expect(Object.keys(config.gateways)).toEqual([Provider.Razorpay]);
    expect(Object.keys(config.stores)).toEqual([Provider.AppStore, Provider.GooglePlay]);
  });

  it('reports every problem of every provider in one pass', () => {
    const message = failure({
      [EnvVar.RazorpayKeyId]: 'x',
      [EnvVar.AppStoreBundleId]: 'com.example.app',
      [EnvVar.GooglePlayPackageName]: 'com.example.app',
    }).message;
    for (const name of [EnvVar.RazorpayKeySecret, EnvVar.AppStoreIssuerId, EnvVar.AppStoreKeyId, EnvVar.GooglePlayClientEmail, EnvVar.GooglePlayPrivateKey]) {
      expect(message).toContain(`${name}: is required`);
    }
  });

  it('refuses a deployment with no provider at all, naming the stores too', () => {
    const message = failure({}).message;
    expect(message).toContain('No payment gateway or app store is configured');
    for (const name of [EnvVar.RazorpayKeyId, EnvVar.AppStoreBundleId, EnvVar.GooglePlayPackageName]) expect(message).toContain(name);
  });

  it('never puts a store secret in an error or a warning', () => {
    const outputs: string[] = [];
    for (const env of [
      { ...appStoreEnv, [EnvVar.AppStoreIssuerId]: undefined },
      { ...googlePlayEnv, [EnvVar.GooglePlayClientEmail]: 'not-an-email', [EnvVar.GooglePlayPrivateKey]: SECRET },
      { ...appStoreEnv, [EnvVar.AppStorePrivateKey]: SECRET, [EnvVar.AppStoreEnvironment]: Environment.Live },
    ]) {
      try {
        outputs.push(...parse(env).warnings);
      } catch (error) {
        outputs.push((error as Error).message);
      }
    }
    outputs.push(...parse({ ...googlePlayEnv, [EnvVar.GooglePlayPrivateKey]: SECRET }).warnings);
    expect(outputs.length).toBeGreaterThan(0);
    for (const text of outputs) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain('MIIB');
    }
  });
});

describe('purchases variables', () => {
  const base: EnvironmentVariables = { ...RAZORPAY };

  it('are off by default', () => {
    const config = parse(base);
    expect(config).toMatchObject({ purchasesFile: undefined, purchaseStoreFile: undefined, publicBaseUrl: undefined });
  });

  it('maps PURCHASES_FILE, PURCHASE_STORE_FILE and PUBLIC_BASE_URL, trimming a trailing slash', () => {
    const config = parse({
      ...base,
      [EnvVar.PurchasesFile]: '/etc/purchases.json',
      [EnvVar.PurchaseStoreFile]: '/var/lib/purchases-state.json',
      [EnvVar.PublicBaseUrl]: 'https://billing.example.com/api//',
    });
    expect(config).toMatchObject({
      purchasesFile: '/etc/purchases.json',
      purchaseStoreFile: '/var/lib/purchases-state.json',
      publicBaseUrl: 'https://billing.example.com/api',
    });
    expect(config.warnings.join('\n')).not.toContain('PUBLIC_BASE_URL');
  });

  it('needs the configuration file and its store together', () => {
    expect(failure({ ...base, [EnvVar.PurchasesFile]: '/etc/p.json' }).message).toContain(
      `${EnvVar.PurchaseStoreFile}: is required when ${EnvVar.PurchasesFile} is set`,
    );
    expect(failure({ ...base, [EnvVar.PurchaseStoreFile]: '/var/s.json' }).message).toContain(
      `${EnvVar.PurchasesFile}: is required when ${EnvVar.PurchaseStoreFile} is set`,
    );
  });

  it.each(['not a url', 'ftp://billing.example.com', '/just/a/path'])('rejects PUBLIC_BASE_URL %s', (value) => {
    const message = failure({ ...base, [EnvVar.PublicBaseUrl]: value }).message;
    expect(message).toContain(EnvVar.PublicBaseUrl);
    expect(message).not.toContain(value);
  });

  it('warns that the hosted checkout is off when purchases are on without a public URL, and about plain http', () => {
    const on = { ...base, [EnvVar.PurchasesFile]: '/etc/p.json', [EnvVar.PurchaseStoreFile]: '/var/s.json' };
    expect(parse(on).warnings.join('\n')).toContain(`${EnvVar.PublicBaseUrl} is not set`);
    expect(parse({ ...on, [EnvVar.PublicBaseUrl]: 'http://billing.example.com' }).warnings.join('\n')).toContain('plain http');
    expect(parse({ ...on, [EnvVar.PublicBaseUrl]: 'http://localhost:8787' }).warnings.join('\n')).not.toContain('plain http');
  });

  it('is reported with every other problem in one pass', () => {
    const message = failure({ [EnvVar.PurchasesFile]: '/etc/p.json', [EnvVar.PublicBaseUrl]: 'nope' }).message;
    expect(message).toContain(EnvVar.PurchaseStoreFile);
    expect(message).toContain(EnvVar.PublicBaseUrl);
    expect(message).toContain('No payment gateway or app store is configured');
  });
});
