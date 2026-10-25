import { Platform } from 'react-native';
import NativeModule from './NativeIndiaSubscriptionsReactNative';
import {
  decodeEntitlements,
  decodeEvent,
  decodeEvents,
  decodeOutcome,
  decodeRefundOutcome,
  decodeReturnLinkResult,
} from './decode';
import { ErrorCode, IndiaSubscriptionsError, toError } from './errors';
import type {
  ConfigureOptions,
  Entitlements,
  PurchaseEvent,
  PurchaseOptions,
  PurchaseOutcome,
  RefundRequestOutcome,
  ReturnLinkResult,
  Subscription,
} from './types';

export * from './types';
export { ErrorCode, IndiaSubscriptionsError } from './errors';
export type { ErrorDetails } from './errors';

/**
 * A bridge over the native `india-subscriptions` SDKs. Every flow, retry and persistence rule runs natively; this module
 * translates arguments, results and events and nothing else.
 *
 * Order at start-up: `configure`, then `addPurchaseListener`, then `start`.
 */

/** A copy of an object without its `undefined` and `null` members, so that the native side sees only what was set. */
function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, member] of Object.entries(value)) {
    if (member === undefined || member === null) {
      continue;
    }
    out[key] =
      typeof member === 'object' &&
      !Array.isArray(member) &&
      Object.getPrototypeOf(member) === Object.prototype
        ? compact(member)
        : member;
  }
  return out as T;
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw toError(error);
  }
}

function onlyOn(platform: 'ios' | 'android', name: string): void {
  if (Platform.OS !== platform) {
    throw new IndiaSubscriptionsError(
      ErrorCode.NotApplicable,
      `${name} applies to ${platform === 'ios' ? 'iOS' : 'Android'} only`,
      { platform: Platform.OS, appliesTo: platform }
    );
  }
}

/**
 * Builds the native purchase client for your backend. Call it once at start-up, before anything else; calling it again
 * replaces the client (for example after the backend's address changed).
 */
export function configure(options: ConfigureOptions): Promise<void> {
  return call(() => NativeModule.configure(compact(options)));
}

/**
 * Sets the value of the Authorization header the native HTTP backend sends from now on, for example
 * `Bearer <the user's token>`; `null` sends none. Call it whenever the app's token changes. The value is held in memory,
 * never stored.
 */
export function setAuthorization(value: string | null): Promise<void> {
  return call(() => NativeModule.setAuthorization(value));
}

/**
 * Starts the native listeners and the pass over purchases that are waiting (an approval that came in later, a purchase
 * interrupted by the app being killed, one the backend could not be told about). Add your listener first.
 */
export function start(): Promise<void> {
  return call(() => NativeModule.start());
}

/** Stops the native listeners. `start` works again afterwards. */
export function stop(): Promise<void> {
  return call(() => NativeModule.stop());
}

/**
 * Buys a product. Resolves with a typed outcome; rejects with an `IndiaSubscriptionsError` when something went wrong
 * before the payment screen (nothing was charged then).
 *
 * @param product your product key (the key your backend's catalogue knows it by).
 */
export async function purchase(
  product: string,
  options: PurchaseOptions
): Promise<PurchaseOutcome> {
  return decodeOutcome(
    await call(() => NativeModule.purchase(product, compact(options)))
  );
}

/**
 * Sends the purchases that are waiting to the backend: call it when the app returns to the foreground or the user signs
 * in. Resolves with the events that pass produced (they are also delivered to listeners).
 */
export async function processPendingPurchases(): Promise<PurchaseEvent[]> {
  return decodeEvents(await call(() => NativeModule.processPending()));
}

/** Clears the "refused" mark of rejected purchases and sends them again. For when you fixed what a refusal pointed at. */
export async function retryRejectedPurchases(): Promise<PurchaseEvent[]> {
  return decodeEvents(await call(() => NativeModule.retryRejected()));
}

/**
 * Restores purchases and returns the backend's entitlements. On iOS this prompts the customer to sign in to the App
 * Store, so call it only from an explicit user action such as a button.
 */
export function restorePurchases(customerRef: string): Promise<Entitlements> {
  return call(async () =>
    decodeEntitlements(await NativeModule.restorePurchases(customerRef))
  );
}

/** What the customer owns, read from your backend: the source of truth for access. */
export function entitlements(customerRef: string): Promise<Entitlements> {
  return call(async () =>
    decodeEntitlements(await NativeModule.entitlements(customerRef))
  );
}

/**
 * Listens to what happens to purchases outside a `purchase` call: an approval that arrives later, a retry, a purchase
 * found at start-up. The listener runs on the JavaScript thread. Remove the subscription when you are done.
 */
export function addPurchaseListener(
  listener: (event: PurchaseEvent) => void
): Subscription {
  const subscription = NativeModule.onPurchaseEvent((raw) => {
    listener(decodeEvent(raw));
  });
  return { remove: () => subscription.remove() };
}

/**
 * iOS only. Presents the App Store's manage-subscriptions sheet, where the customer views, changes or cancels. On
 * Android it rejects with the code `NOT_APPLICABLE`; use `getSubscriptionManagementUrl` there.
 */
export function showManageSubscriptions(): Promise<void> {
  return call(async () => {
    onlyOn('ios', 'showManageSubscriptions');
    await NativeModule.showManageSubscriptions();
  });
}

/**
 * iOS only. Presents the refund-request sheet for a StoreKit transaction (the id an entitlement's `paymentId` or a
 * `transactionId` carries). The App Store decides the refund later. On Android it rejects with `NOT_APPLICABLE`.
 */
export function requestRefund(
  transactionId: string
): Promise<RefundRequestOutcome> {
  return call(async () => {
    onlyOn('ios', 'requestRefund');
    return decodeRefundOutcome(await NativeModule.requestRefund(transactionId));
  });
}

/**
 * Android only. The Google Play page where the customer manages a subscription (one product, or all when
 * `productId` is omitted). Open it with `Linking.openURL`. On iOS it rejects with `NOT_APPLICABLE`; use
 * `showManageSubscriptions` there.
 */
export function getSubscriptionManagementUrl(
  productId?: string
): Promise<string> {
  return call(async () => {
    onlyOn('android', 'getSubscriptionManagementUrl');
    return NativeModule.subscriptionManagementUrl(productId ?? null);
  });
}

/**
 * Android only. Hands over the link the app was opened with after a hosted checkout (from `Linking.getInitialURL()` and
 * the `url` event). Resolves with what the backend says about the checkout; a link that is not for a pending checkout
 * gives `{ type: 'ignored' }`. On iOS it rejects with `NOT_APPLICABLE`.
 */
export function handleReturnLink(url: string): Promise<ReturnLinkResult> {
  return call(async () => {
    onlyOn('android', 'handleReturnLink');
    return decodeReturnLinkResult(await NativeModule.handleReturnLink(url));
  });
}
