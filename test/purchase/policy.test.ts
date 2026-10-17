import { describe, expect, it } from 'vitest';
import { ChannelPolicy } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  ConfigIssue,
  PlatformPolicySchema,
  Purchases,
  assertCatalog,
  resolvePolicy,
  validateCatalog,
  type PlatformPolicy,
  type Product,
} from '../../src/purchase/index.js';
import {
  BOOK,
  COINS,
  CUSTOMER,
  ErrorCode,
  FAKE_CAPABILITIES,
  LIFETIME,
  MONTHLY,
  Platform,
  Provider,
  harness,
} from './helpers.js';

const ALL = Object.values(FAKE_CAPABILITIES);
const policy = (android: PlatformPolicy['android'] = ChannelPolicy.Store): PlatformPolicy => PlatformPolicySchema.parse({ android });

function resolve(platform: Platform, product: Product, options: { android?: PlatformPolicy['android']; capabilities?: typeof ALL; reporter?: boolean; customer?: { state?: string } } = {}) {
  return resolvePolicy({
    platform,
    product,
    policy: policy(options.android),
    capabilities: options.capabilities ?? ALL,
    hasReporter: options.reporter ?? true,
    ...(options.customer !== undefined ? { customer: options.customer } : {}),
  });
}

function issueOf(call: () => unknown): { code: ErrorCode; issue: ConfigIssue } {
  try {
    call();
  } catch (error) {
    if (error instanceof SubscriptionError) return { code: error.code, issue: (error.raw as { issue: ConfigIssue }).issue };
    throw error;
  }
  throw new Error('expected an error');
}

describe('PlatformPolicySchema', () => {
  it('defaults to the App Store on iOS, Google Play on Android and gateways on the web', () => {
    expect(PlatformPolicySchema.parse({})).toEqual({ ios: 'store', android: 'store', web: 'gateways' });
  });
  it('accepts the three Android policies and nothing else for any platform', () => {
    for (const android of ['store', 'user_choice', 'gateways']) expect(PlatformPolicySchema.parse({ android }).android).toBe(android);
    expect(PlatformPolicySchema.safeParse({ ios: 'gateways' }).success).toBe(false);
    expect(PlatformPolicySchema.safeParse({ web: 'store' }).success).toBe(false);
    expect(PlatformPolicySchema.safeParse({ android: 'link_out' }).success).toBe(false);
  });
});

describe('resolvePolicy', () => {
  it('physical goods go to the gateways on every platform, whatever the policy', () => {
    for (const platform of Object.values(Platform)) {
      for (const android of Object.values(ChannelPolicy)) {
        expect(resolve(platform, BOOK, { android })).toEqual({ policy: ChannelPolicy.Gateways, gateways: true });
      }
    }
  });

  it('iOS resolves to the App Store with the product as the store knows it', () => {
    expect(resolve(Platform.Ios, MONTHLY)).toEqual({
      policy: ChannelPolicy.Store,
      store: { provider: Provider.AppStore, product: MONTHLY.appStore },
      gateways: false,
    });
  });

  it('Android follows the policy', () => {
    expect(resolve(Platform.Android, MONTHLY, { android: ChannelPolicy.Store })).toEqual({
      policy: ChannelPolicy.Store,
      store: { provider: Provider.GooglePlay, product: MONTHLY.googlePlay },
      gateways: false,
    });
    expect(resolve(Platform.Android, MONTHLY, { android: ChannelPolicy.UserChoice, customer: CUSTOMER })).toEqual({
      policy: ChannelPolicy.UserChoice,
      store: { provider: Provider.GooglePlay, product: MONTHLY.googlePlay },
      gateways: true,
    });
    expect(resolve(Platform.Android, MONTHLY, { android: ChannelPolicy.Gateways })).toEqual({ policy: ChannelPolicy.Gateways, gateways: true });
  });

  it('web resolves to the gateways', () => {
    expect(resolve(Platform.Web, MONTHLY)).toEqual({ policy: ChannelPolicy.Gateways, gateways: true });
  });

  describe('names every configuration error', () => {
    it('iOS without the app_store provider', () => {
      const without = ALL.filter((c) => c.provider !== Provider.AppStore);
      expect(issueOf(() => resolve(Platform.Ios, MONTHLY, { capabilities: without }))).toEqual({ code: ErrorCode.Config, issue: ConfigIssue.MissingAppStoreProvider });
    });
    it('iOS without product.appStore', () => {
      expect(issueOf(() => resolve(Platform.Ios, { ...MONTHLY, appStore: undefined }))).toEqual({ code: ErrorCode.Config, issue: ConfigIssue.MissingAppStoreProduct });
    });
    it('Android store without the google_play provider', () => {
      const without = ALL.filter((c) => c.provider !== Provider.GooglePlay);
      expect(issueOf(() => resolve(Platform.Android, MONTHLY, { capabilities: without }))).toEqual({ code: ErrorCode.Config, issue: ConfigIssue.MissingGooglePlayProvider });
    });
    it('Android store without product.googlePlay', () => {
      expect(issueOf(() => resolve(Platform.Android, { ...MONTHLY, googlePlay: undefined }))).toEqual({ code: ErrorCode.Config, issue: ConfigIssue.MissingGooglePlayProduct });
    });
    it('user choice without a gateway', () => {
      const stores = ALL.filter((c) => c.kind === 'store');
      expect(issueOf(() => resolve(Platform.Android, MONTHLY, { android: ChannelPolicy.UserChoice, capabilities: stores, customer: CUSTOMER }))).toEqual({
        code: ErrorCode.Config,
        issue: ConfigIssue.MissingGateway,
      });
    });
    it('user choice without taxRateBps', () => {
      expect(issueOf(() => resolve(Platform.Android, { ...MONTHLY, taxRateBps: undefined }, { android: ChannelPolicy.UserChoice, customer: CUSTOMER }))).toEqual({
        code: ErrorCode.Config,
        issue: ConfigIssue.MissingTaxRate,
      });
    });
    it('user choice without a reporter', () => {
      expect(issueOf(() => resolve(Platform.Android, MONTHLY, { android: ChannelPolicy.UserChoice, reporter: false, customer: CUSTOMER }))).toEqual({
        code: ErrorCode.Config,
        issue: ConfigIssue.MissingReporter,
      });
    });
    it('user choice at start without customer.state is the request\'s fault', () => {
      expect(issueOf(() => resolve(Platform.Android, MONTHLY, { android: ChannelPolicy.UserChoice, customer: { state: undefined } }))).toEqual({
        code: ErrorCode.Validation,
        issue: ConfigIssue.MissingCustomerState,
      });
    });
    it('a gateway-only purchase without any gateway', () => {
      const stores = ALL.filter((c) => c.kind === 'store');
      expect(issueOf(() => resolve(Platform.Web, MONTHLY, { capabilities: stores }))).toEqual({ code: ErrorCode.Config, issue: ConfigIssue.MissingGateway });
      expect(issueOf(() => resolve(Platform.Ios, BOOK, { capabilities: stores }))).toEqual({ code: ErrorCode.Config, issue: ConfigIssue.MissingGateway });
    });
    it('a store registered under a gateway\'s kind', () => {
      const wrong = ALL.map((c) => (c.provider === Provider.AppStore ? { ...c, kind: 'gateway' as const } : c));
      expect(issueOf(() => resolve(Platform.Ios, MONTHLY, { capabilities: wrong }))).toEqual({ code: ErrorCode.Config, issue: ConfigIssue.ProviderKindMismatch });
    });
    it('a platform the product is not sold on', () => {
      expect(issueOf(() => resolve(Platform.Ios, { ...MONTHLY, platforms: [Platform.Web] }))).toEqual({ code: ErrorCode.Validation, issue: ConfigIssue.PlatformNotOffered });
    });
  });
});

describe('validateCatalog', () => {
  const validate = (catalog: Product[], options: { android?: PlatformPolicy['android']; capabilities?: typeof ALL; reporter?: boolean } = {}) =>
    validateCatalog({ catalog, policy: policy(options.android), capabilities: options.capabilities ?? ALL, hasReporter: options.reporter ?? true });
  const issues = (catalog: Product[], options = {}) => validate(catalog, options).map((p) => p.issue);

  it('accepts a sound catalog', () => {
    expect(validate([MONTHLY, LIFETIME, COINS, BOOK], { android: ChannelPolicy.UserChoice })).toEqual([]);
  });

  it('flags a duplicate key', () => {
    expect(issues([MONTHLY, MONTHLY])).toEqual([ConfigIssue.DuplicateProductKey]);
  });

  it('flags a subscription without an interval, and an interval or trial on a one-time product', () => {
    expect(issues([{ ...MONTHLY, interval: undefined }])).toEqual([ConfigIssue.SubscriptionWithoutInterval]);
    expect(issues([{ ...LIFETIME, interval: { unit: 'month', count: 1 } }])).toEqual([ConfigIssue.OneTimeWithInterval]);
    expect(issues([{ ...LIFETIME, trialDays: 7 }])).toEqual([ConfigIssue.OneTimeWithTrial]);
  });

  it('flags a store product on physical goods', () => {
    expect(issues([{ ...BOOK, appStore: { productId: 'x' } }])).toEqual([ConfigIssue.PhysicalGoodsWithStoreProduct]);
  });

  it('flags a missing store mapping for a platform that needs it, unless the product leaves the platform out', () => {
    expect(issues([{ ...MONTHLY, appStore: undefined }])).toEqual([ConfigIssue.MissingAppStoreProduct]);
    expect(issues([{ ...MONTHLY, googlePlay: undefined }])).toEqual([ConfigIssue.MissingGooglePlayProduct]);
    expect(issues([{ ...MONTHLY, appStore: undefined, googlePlay: undefined, platforms: [Platform.Web] }])).toEqual([]);
    expect(issues([{ ...MONTHLY, googlePlay: undefined }], { android: ChannelPolicy.Gateways })).toEqual([]);
  });

  it('does not ask for store mappings of a store that is not configured', () => {
    const webOnly = ALL.filter((c) => c.kind === 'gateway');
    expect(issues([{ ...MONTHLY, appStore: undefined, googlePlay: undefined }], { capabilities: webOnly })).toEqual([]);
  });

  it('user choice needs the provider, a gateway, a reporter and a tax rate on each Android product', () => {
    expect(issues([MONTHLY], { android: ChannelPolicy.UserChoice, reporter: false })).toEqual([ConfigIssue.MissingReporter]);
    expect(issues([{ ...MONTHLY, taxRateBps: undefined }], { android: ChannelPolicy.UserChoice })).toEqual([ConfigIssue.MissingTaxRate]);
    const noPlay = ALL.filter((c) => c.provider !== Provider.GooglePlay);
    expect(issues([MONTHLY], { android: ChannelPolicy.UserChoice, capabilities: noPlay })).toEqual([ConfigIssue.MissingGooglePlayProvider]);
    const stores = ALL.filter((c) => c.kind === 'store');
    expect(issues([MONTHLY], { android: ChannelPolicy.UserChoice, capabilities: stores })).toEqual([ConfigIssue.MissingGateway]);
    // A tax rate is not needed where nothing is reported.
    expect(issues([{ ...MONTHLY, taxRateBps: undefined }], { android: ChannelPolicy.Store })).toEqual([]);
  });

  it('reports every problem at once', () => {
    expect(issues([{ ...MONTHLY, interval: undefined, appStore: undefined }, MONTHLY]).sort()).toEqual(
      [ConfigIssue.DuplicateProductKey, ConfigIssue.MissingAppStoreProduct, ConfigIssue.SubscriptionWithoutInterval].sort(),
    );
  });

  it('assertCatalog throws one CONFIG error listing them', () => {
    try {
      assertCatalog({ catalog: [MONTHLY, MONTHLY], policy: policy(), capabilities: ALL, hasReporter: true });
      throw new Error('expected an error');
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
      expect((error as SubscriptionError).message).toMatch(/more than once/);
    }
  });
});

describe('Purchases construction', () => {
  it('refuses a bad catalog before any purchase is made', () => {
    expect(() => harness({ catalog: [MONTHLY, MONTHLY] })).toThrowError(/more than once/);
    expect(() => harness({ catalog: [{ ...MONTHLY, interval: undefined }] })).toThrowError(/interval/);
  });
  it('refuses a malformed product with VALIDATION', () => {
    expect(() => harness({ catalog: [{ ...MONTHLY, amount: 0 }] })).toThrowError(/Invalid catalog product 0/);
  });
  it('refuses a malformed policy', () => {
    expect(() => harness({ policy: { android: 'link_out' as never } })).toThrowError(/platform policy/);
  });
  it('is a constructor of the exported class', () => {
    expect(typeof Purchases).toBe('function');
  });
});
