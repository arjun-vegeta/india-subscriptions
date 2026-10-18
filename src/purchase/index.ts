/**
 * # Purchase sessions, platform policy and entitlements
 *
 * One call decides where a purchase may go on each platform, creates it there, and remembers what the customer owns.
 *
 * - **Platform policy.** iOS buys through the App Store. Android buys through Google Play, or through Google Play with
 *   user choice billing (Google's choice screen offers a payment gateway, and the purchase is reported to Google), or
 *   through the gateways only. Web buys through the gateways. Physical goods go to the gateways everywhere.
 * - **Purchase sessions.** `Purchases.start` creates the purchase in the right place, picking the best gateway with the
 *   router and falling back to the next one when a gateway is down. `complete` verifies what the checkout returned and
 *   turns it into an entitlement.
 * - **Entitlements.** One answer to "what does this customer own", across stores and gateways, kept current by webhook
 *   events (`handleEvents`).
 * - **Reports to Google.** Purchases made through the alternative must be reported to Google within 24 hours: the first
 *   transaction (amount 0 for a free trial), every renewal and every refund. They are queued in the store before
 *   `complete` returns and sent by `flush`.
 */
export * from './constants.js';
export * from './schemas.js';
export type { PurchaseHost } from './host.js';
export { Purchases, type IssueReport, type PurchasesOptions } from './purchases.js';
export type { EntitlementLookup, PurchaseStore } from './store.js';
export { MemoryPurchaseStore, type MemoryPurchaseStoreOptions } from './memory-store.js';
export {
  assertCatalog,
  resolvePolicy,
  validateCatalog,
  type ConfigProblem,
  type ResolvedPolicy,
  type ResolvePolicyInput,
  type ValidateCatalogInput,
} from './policy.js';
export { splitRefund, splitTax, type TaxSplit } from './tax.js';
export { blocksPurchase, grantsAccess, statusFromSubscription } from './entitlement.js';
export { entitlementId, firstTransactionId, refundReportId, renewalTransactionId } from './ids.js';
