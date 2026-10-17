import { ChannelPolicy, ErrorCode, Platform, Provider, ProductKind, ProviderKind } from '../constants.js';
import { SubscriptionError } from '../errors.js';
import type { Capabilities, StoreProduct } from '../schemas.js';
import { ConfigIssue } from './constants.js';
import type { PlatformPolicy, Product } from './schemas.js';

/**
 * Platform policy resolution and catalog validation. Pure: nothing here calls a provider or reads a store.
 *
 * The rules, for a `(platform, product)` pair:
 *
 * - `physicalGoods: true` goes to the gateways on every platform.
 * - `ios` goes to the App Store: it needs the `app_store` provider and `product.appStore`.
 * - `android` follows `policy.android`. `store` and `user_choice` need the `google_play` provider and
 *   `product.googlePlay`. `user_choice` also needs at least one gateway, `product.taxRateBps` (every report to Google
 *   splits the charge into pre-tax amount and tax), a reporter, and at `start` `customer.state`. `gateways` needs a gateway.
 * - `web` goes to the gateways.
 *
 * Every problem is a `ConfigIssue`, reported as a `CONFIG` error whose `raw` is `{ issue, product?, platform? }`. The one
 * exception is a platform the product is not sold on and a missing customer state: those are faults of the request, so
 * they are `VALIDATION` errors with the same `raw`.
 */

/** What a purchase on a platform resolves to. */
export interface ResolvedPolicy {
  /** The channel policy that applies: `store`, `user_choice` or `gateways`. */
  policy: ChannelPolicy;
  /** The store the purchase is made in, with the product as the store knows it. Absent for `gateways`. */
  store?: { provider: Provider; product: StoreProduct };
  /** Whether the purchase can be taken at a gateway: always for `gateways`, after the customer picks the alternative for `user_choice`. */
  gateways: boolean;
}

export interface ResolvePolicyInput {
  platform: Platform;
  product: Product;
  policy: PlatformPolicy;
  /** The capabilities of every configured provider. */
  capabilities: readonly Capabilities[];
  /** Whether a reporter for Google external transactions is configured. */
  hasReporter: boolean;
  /** The customer, to check that `state` is present for `user_choice`. Omit when only the configuration is being checked. */
  customer?: { state?: string };
}

/** One problem found in the catalog or the policy. */
export interface ConfigProblem {
  issue: ConfigIssue;
  /** The key of the product the problem is about, where it is about one. */
  product?: string;
  message: string;
}

export function hasProvider(capabilities: readonly Capabilities[], provider: Provider, kind: ProviderKind): boolean {
  return capabilities.some((entry) => entry.provider === provider && entry.kind === kind);
}

export function hasGateway(capabilities: readonly Capabilities[]): boolean {
  return capabilities.some((entry) => entry.kind === ProviderKind.Gateway);
}

function configError(problem: ConfigProblem, platform?: Platform): SubscriptionError {
  return new SubscriptionError(ErrorCode.Config, problem.message, {
    raw: { issue: problem.issue, product: problem.product, platform },
  });
}

function requestError(problem: ConfigProblem, platform: Platform): SubscriptionError {
  return new SubscriptionError(ErrorCode.Validation, problem.message, {
    raw: { issue: problem.issue, product: problem.product, platform },
  });
}

/** Resolves where a purchase of `product` on `platform` may be taken, or throws the named configuration error. */
export function resolvePolicy(input: ResolvePolicyInput): ResolvedPolicy {
  const { platform, product, policy, capabilities } = input;
  const key = product.key;

  if (product.platforms && !product.platforms.includes(platform)) {
    throw requestError(
      { issue: ConfigIssue.PlatformNotOffered, product: key, message: `Product ${key} is not sold on ${platform}` },
      platform,
    );
  }

  const gateways = (): ResolvedPolicy => {
    if (!hasGateway(capabilities)) {
      throw configError(
        {
          issue: ConfigIssue.MissingGateway,
          product: key,
          message: `Product ${key} on ${platform} is sold through gateways, but no gateway provider is configured`,
        },
        platform,
      );
    }
    return { policy: ChannelPolicy.Gateways, gateways: true };
  };

  if (product.physicalGoods === true) return gateways();

  switch (platform) {
    case Platform.Web:
      return gateways();
    case Platform.Ios:
      return storePolicy(input, Provider.AppStore, product.appStore, ChannelPolicy.Store);
    case Platform.Android: {
      const channel = policy.android;
      if (channel === ChannelPolicy.Gateways) return gateways();
      return storePolicy(input, Provider.GooglePlay, product.googlePlay, channel);
    }
  }
}

function storePolicy(
  input: ResolvePolicyInput,
  provider: Provider,
  storeProduct: StoreProduct | undefined,
  channel: ChannelPolicy,
): ResolvedPolicy {
  const { platform, product, capabilities } = input;
  const key = product.key;
  const isApple = provider === Provider.AppStore;
  const store = isApple ? 'App Store' : 'Google Play';

  if (!hasProvider(capabilities, provider, ProviderKind.Store)) {
    const wrongKind = capabilities.some((entry) => entry.provider === provider);
    throw configError(
      {
        issue: wrongKind
          ? ConfigIssue.ProviderKindMismatch
          : isApple
            ? ConfigIssue.MissingAppStoreProvider
            : ConfigIssue.MissingGooglePlayProvider,
        product: key,
        message: wrongKind
          ? `The ${provider} provider is configured but is not a store provider`
          : `Product ${key} on ${platform} is sold through ${store}, but the ${provider} provider is not configured`,
      },
      platform,
    );
  }
  if (storeProduct === undefined) {
    throw configError(
      {
        issue: isApple ? ConfigIssue.MissingAppStoreProduct : ConfigIssue.MissingGooglePlayProduct,
        product: key,
        message: `Product ${key} on ${platform} is sold through ${store}, but it has no \`${isApple ? 'appStore' : 'googlePlay'}\` product`,
      },
      platform,
    );
  }

  if (channel === ChannelPolicy.UserChoice) {
    if (!hasGateway(capabilities)) {
      throw configError(
        {
          issue: ConfigIssue.MissingGateway,
          product: key,
          message: `Android user choice billing offers a gateway as the alternative, but no gateway provider is configured`,
        },
        platform,
      );
    }
    if (product.taxRateBps === undefined) {
      throw configError(
        {
          issue: ConfigIssue.MissingTaxRate,
          product: key,
          message: `Product ${key} is sold through user choice billing, so it needs \`taxRateBps\`: reports to Google split the charge into pre-tax amount and tax`,
        },
        platform,
      );
    }
    if (!input.hasReporter) {
      throw configError(
        {
          issue: ConfigIssue.MissingReporter,
          product: key,
          message: 'User choice billing needs a reporter: every purchase made through the alternative must be reported to Google',
        },
        platform,
      );
    }
    if (input.customer && (input.customer.state === undefined || input.customer.state === '')) {
      throw requestError(
        {
          issue: ConfigIssue.MissingCustomerState,
          product: key,
          message: 'User choice billing needs `customer.state`: the purchase is reported to Google with the customer\'s state',
        },
        platform,
      );
    }
  }
  return { policy: channel, store: { provider, product: storeProduct }, gateways: channel === ChannelPolicy.UserChoice };
}

export interface ValidateCatalogInput {
  catalog: readonly Product[];
  policy: PlatformPolicy;
  capabilities: readonly Capabilities[];
  hasReporter: boolean;
}

/**
 * Every problem in the catalog and the policy, so a deployment learns about all of them at once.
 *
 * Per product: a unique key, an interval on a subscription and none on a one-time product, no trial on a one-time
 * product, no store product on physical goods. A store mapping is required for every platform the product is sold on
 * when that platform's store provider is configured (a deployment without the App Store provider has no iOS to map
 * for). For the `user_choice` policy the Google Play provider, a gateway and a reporter are required, and each product
 * sold on Android needs `taxRateBps`.
 */
export function validateCatalog(input: ValidateCatalogInput): ConfigProblem[] {
  const { catalog, policy, capabilities, hasReporter } = input;
  const problems: ConfigProblem[] = [];
  const seen = new Set<string>();

  if (policy.android === ChannelPolicy.UserChoice) {
    if (!hasProvider(capabilities, Provider.GooglePlay, ProviderKind.Store)) {
      problems.push({
        issue: ConfigIssue.MissingGooglePlayProvider,
        message: 'The android policy is user_choice, but the google_play provider is not configured',
      });
    }
    if (!hasGateway(capabilities)) {
      problems.push({
        issue: ConfigIssue.MissingGateway,
        message: 'The android policy is user_choice, but no gateway provider is configured to take the alternative payment',
      });
    }
    if (!hasReporter) {
      problems.push({
        issue: ConfigIssue.MissingReporter,
        message: 'The android policy is user_choice, but no reporter is configured: purchases through the alternative must be reported to Google',
      });
    }
  }

  const iosEnabled = hasProvider(capabilities, Provider.AppStore, ProviderKind.Store);
  const androidStoreEnabled =
    policy.android !== ChannelPolicy.Gateways && hasProvider(capabilities, Provider.GooglePlay, ProviderKind.Store);

  for (const product of catalog) {
    const key = product.key;
    if (seen.has(key)) {
      problems.push({ issue: ConfigIssue.DuplicateProductKey, product: key, message: `Product key ${key} appears more than once` });
    }
    seen.add(key);

    if (product.kind === ProductKind.Subscription && product.interval === undefined) {
      problems.push({
        issue: ConfigIssue.SubscriptionWithoutInterval,
        product: key,
        message: `Subscription ${key} needs an \`interval\``,
      });
    }
    if (product.kind === ProductKind.OneTime && product.interval !== undefined) {
      problems.push({
        issue: ConfigIssue.OneTimeWithInterval,
        product: key,
        message: `One-time product ${key} has an \`interval\`: only subscriptions bill again`,
      });
    }
    if (product.kind === ProductKind.OneTime && product.trialDays !== undefined) {
      problems.push({
        issue: ConfigIssue.OneTimeWithTrial,
        product: key,
        message: `One-time product ${key} has \`trialDays\`: only subscriptions have a trial`,
      });
    }
    if (product.physicalGoods === true) {
      if (product.appStore !== undefined || product.googlePlay !== undefined) {
        problems.push({
          issue: ConfigIssue.PhysicalGoodsWithStoreProduct,
          product: key,
          message: `Product ${key} is physical goods, which are never sold through app store billing, but it has a store product`,
        });
      }
      continue;
    }

    const sold = (platform: Platform): boolean => product.platforms === undefined || product.platforms.includes(platform);
    if (iosEnabled && sold(Platform.Ios) && product.appStore === undefined) {
      problems.push({
        issue: ConfigIssue.MissingAppStoreProduct,
        product: key,
        message: `Product ${key} is sold on iOS, but it has no \`appStore\` product (set \`platforms\` to leave iOS out)`,
      });
    }
    if (androidStoreEnabled && sold(Platform.Android)) {
      if (product.googlePlay === undefined) {
        problems.push({
          issue: ConfigIssue.MissingGooglePlayProduct,
          product: key,
          message: `Product ${key} is sold on Android through Google Play, but it has no \`googlePlay\` product (set \`platforms\` to leave Android out)`,
        });
      }
      if (policy.android === ChannelPolicy.UserChoice && product.taxRateBps === undefined) {
        problems.push({
          issue: ConfigIssue.MissingTaxRate,
          product: key,
          message: `Product ${key} is sold through user choice billing, so it needs \`taxRateBps\``,
        });
      }
    }
  }
  return problems;
}

/** Throws one `CONFIG` error that lists every problem `validateCatalog` found. */
export function assertCatalog(input: ValidateCatalogInput): void {
  const problems = validateCatalog(input);
  if (problems.length === 0) return;
  throw new SubscriptionError(
    ErrorCode.Config,
    `Invalid purchase configuration: ${problems.map((problem) => problem.message).join('; ')}`,
    { raw: problems },
  );
}
