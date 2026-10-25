import type { CodegenTypes, TurboModule } from 'react-native';
import { TurboModuleRegistry } from 'react-native';

/**
 * The native side of the bridge. It is deliberately loose (`Object` in, `Object` out): the typed API lives in
 * `index.ts`, and every value here is what the native SDKs produced, translated and nothing else.
 *
 * Every method exists on both platforms. A method that belongs to one platform rejects with the code
 * `NOT_APPLICABLE` on the other.
 */
export interface Spec extends TurboModule {
  /** Builds the native purchase client for a backend. Replaces a client from an earlier call. */
  configure(options: Object): Promise<void>;
  /** Replaces the value of the Authorization header the native HTTP backend sends. `null` sends none. */
  setAuthorization(value: string | null): Promise<void>;
  /** Starts the native listeners and the pass over purchases that arrived while the app was not running. */
  start(): Promise<void>;
  /** Stops the native listeners. */
  stop(): Promise<void>;
  purchase(product: string, options: Object): Promise<Object>;
  processPending(): Promise<Object>;
  retryRejected(): Promise<Object>;
  restorePurchases(customerRef: string): Promise<Object>;
  entitlements(customerRef: string): Promise<Object>;
  /** iOS: presents the App Store's manage-subscriptions sheet. */
  showManageSubscriptions(): Promise<void>;
  /** iOS: presents the refund-request sheet for a transaction id (a decimal string). */
  requestRefund(transactionId: string): Promise<Object>;
  /** Android: the Google Play subscription management URL, for one product or all. */
  subscriptionManagementUrl(productId: string | null): Promise<string>;
  /** Android: reads the outcome of a hosted checkout from the link that opened the app. */
  handleReturnLink(url: string): Promise<Object>;
  /** What happens to purchases outside a `purchase` call. */
  readonly onPurchaseEvent: CodegenTypes.EventEmitter<Object>;
}

export default TurboModuleRegistry.getEnforcing<Spec>(
  'IndiaSubscriptionsReactNative'
);
