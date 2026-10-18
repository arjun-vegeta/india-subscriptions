/**
 * Main entry (`india-subscriptions`): one gateway-neutral API over
 * subscriptions on Indian payment gateways.
 *
 * Deliberately absent: `node:http` (the HTTP service and `FileSchedulerStore`
 * live in `india-subscriptions/server`) and browser code
 * (`india-subscriptions/checkout`).
 *
 * Gateway modules are exported by name, never with `export *`: their constant
 * names (`SUBSCRIPTION_STATUS_MAP`, ...) collide. Each gateway's constants are
 * reached through a namespace: `RazorpayApi`, `CashfreeApi`, `PayUApi`, and the same
 * for the app stores (`AppStoreApi`, `GooglePlayApi`).
 *
 * The gateway router (`Router`) and purchase sessions (`Purchases`, platform
 * policy, entitlements, the Google report queue) are exported whole: their
 * constants and schemas are part of the public model. The durable file store
 * for purchases (`FilePurchaseStore`) lives in `india-subscriptions/server`.
 */

// The client.
export {
  Subscriptions,
  createSubscriptions,
  overlaySchedule,
  type PurchasesSettings,
  type RoutingSettings,
  type SubscriptionsOptions,
} from './client.js';

// Shared constants, schemas and types (the gateway-neutral model).
export * from './constants.js';
export * from './schemas.js';

// Errors.
export {
  SubscriptionError,
  invalid,
  isSubscriptionError,
  parseInput,
  parseResponse,
  unsupported,
  type SubscriptionErrorOptions,
} from './errors.js';

// Write your own gateway adapter.
export {
  BaseProvider,
  type ExternalTransactionReporter,
  type GatewayErrorInfo,
  type ProviderOptions,
  type SubscriptionProvider,
} from './provider.js';
export { HttpClient, basicAuth, codeForStatus, formEncode, withQuery } from './http.js';
export type { FetchLike, HttpOptions, HttpRequest, HttpResponse } from './http.js';
export { assertSignature, getHeader, hash, hmac, safeEqual, sha256Hmac, sha512 } from './crypto.js';

// Gateways: factory, provider class, config schema and type.
export { razorpay, RazorpayProvider } from './providers/razorpay/index.js';
export {
  RazorpayConfigSchema,
  type ParsedRazorpayConfig,
  type RazorpayConfig,
} from './providers/razorpay/schemas.js';
export { cashfree, CashfreeProvider } from './providers/cashfree/index.js';
export {
  CashfreeConfigSchema,
  type CashfreeConfig,
  type ParsedCashfreeConfig,
} from './providers/cashfree/schemas.js';
export {
  payu,
  PayUProvider,
  PayUConfigSchema,
  cardMandateWebhookHash,
  commandHash,
  consentRequestHash,
  decodeSubscriptionId as decodePayUSubscriptionId,
  encodeSubscriptionId as encodePayUSubscriptionId,
  reverseResponseHash,
  upiMandateWebhookHash,
  type MandateRef as PayUMandateRef,
  type ParsedPayUConfig,
  type PayUConfig,
  type PayUProviderOptions,
} from './providers/payu/index.js';

export { phonepe, PhonePeProvider, type PhonePeProviderOptions } from './providers/phonepe/index.js';
export {
  PhonePeConfigSchema,
  type ParsedPhonePeConfig,
  type PhonePeConfig,
} from './providers/phonepe/schemas.js';
export { paytm, PaytmProvider, type PaytmProviderOptions } from './providers/paytm/index.js';
export {
  PaytmConfigSchema,
  type ParsedPaytmConfig,
  type PaytmConfig,
} from './providers/paytm/schemas.js';

// App stores: factory, provider class, config schema.
export { appStore, AppStoreProvider, type AppStoreProviderOptions } from './providers/appstore/index.js';
export {
  AppStoreConfigSchema,
  type AppStoreConfig,
  type ParsedAppStoreConfig,
} from './providers/appstore/schemas.js';
export { googlePlay, GooglePlayProvider, type GooglePlayProviderOptions } from './providers/googleplay/index.js';
export {
  GooglePlayConfigSchema,
  type GooglePlayConfig,
  type ParsedGooglePlayConfig,
} from './providers/googleplay/schemas.js';

// Each gateway's own constants (endpoints, statuses, event names), namespaced because the names collide.
export * as RazorpayApi from './providers/razorpay/constants.js';
export * as CashfreeApi from './providers/cashfree/constants.js';
export * as PayUApi from './providers/payu/constants.js';
export * as PhonePeApi from './providers/phonepe/constants.js';
export * as PaytmApi from './providers/paytm/constants.js';
export * as AppStoreApi from './providers/appstore/constants.js';
export * as GooglePlayApi from './providers/googleplay/constants.js';

// Gateway routing: choose the best gateway for a new subscription or payment.
export * from './routing/index.js';

// Purchase sessions: platform policy, entitlements, the Google report queue. The module's constants are exported whole
// except two that the scheduler already names (`DEFAULT_LOCK_TTL_MS`, `DEFAULT_LOCK_WAIT_MS`); every constant, those two
// included, is also reached through `PurchaseApi`.
export * from './purchase/schemas.js';
export {
  ACCESS_STATUSES,
  AttemptOutcome,
  BLOCKING_STATUSES,
  ConfigIssue,
  EntitlementStatus,
  FALLBACK_ERROR_CODES,
  FlushOutcome,
  LockScope,
  PurchaseIssue,
  REFUSAL_ERROR_CODES,
  ReportKind,
  ReportStatus,
  SessionStatus,
  UNAVAILABLE_ERROR_CODES,
  UNSETTLED_SESSION_STATUSES,
} from './purchase/constants.js';
export * as PurchaseApi from './purchase/constants.js';
export type { PurchaseHost } from './purchase/host.js';
export { Purchases, type IssueReport, type PurchasesOptions } from './purchase/purchases.js';
export type { EntitlementLookup, PurchaseStore } from './purchase/store.js';
export { MemoryPurchaseStore, type MemoryPurchaseStoreOptions } from './purchase/memory-store.js';
export {
  assertCatalog,
  resolvePolicy,
  validateCatalog,
  type ConfigProblem,
  type ResolvedPolicy,
  type ResolvePolicyInput,
  type ValidateCatalogInput,
} from './purchase/policy.js';
export { splitRefund, splitTax, type TaxSplit } from './purchase/tax.js';
export { blocksPurchase, grantsAccess, statusFromSubscription } from './purchase/entitlement.js';
export { entitlementId, firstTransactionId, refundReportId, renewalTransactionId } from './purchase/ids.js';

// Billing scheduler for merchant-scheduled mandates (the in-memory store; the file store is in `/server`).
export * from './scheduler/constants.js';
export * from './scheduler/schemas.js';
export type { SchedulerStore } from './scheduler/store.js';
export { MemorySchedulerStore, type MemorySchedulerStoreOptions } from './scheduler/memory-store.js';
export {
  BillingScheduler,
  awaitsActivation,
  scheduleIdFor,
  type SchedulerOptions,
  type SchedulerSettings,
} from './scheduler/scheduler.js';

// Events webhook (what `india-subscriptions serve` posts to EVENTS_WEBHOOK_URL): envelopes, signing, verification.
export {
  EventsDeliveryKind,
  EventsDeliverySchema,
  GatewayEventsDeliverySchema,
  SCHEDULER_EVENT_ID_PREFIX,
  SchedulerEventsDeliverySchema,
  SchedulerWebhookEventSchema,
  schedulerEventId,
  toSchedulerWebhookEvent,
  type EventsDelivery,
  type GatewayEventsDelivery,
  type SchedulerEventsDelivery,
  type SchedulerWebhookEvent,
} from './events-envelope.js';
export {
  DEFAULT_EVENTS_TIMEOUT_MS,
  DEFAULT_TOLERANCE_SECONDS,
  EventsHeader,
  SIGNED_STRING_SEPARATOR,
  createEventsForwarder,
  createEventsSender,
  createSchedulerEventsRelay,
  signEventsBody,
  verifyEventsSignature,
  type EventsHeaders,
  type EventsLog,
  type EventsSenderOptions,
  type SchedulerEventsRelay,
  type SchedulerEventsRelayOptions,
  type VerifyEventsOptions,
} from './events-webhook.js';

// Schema registry: the published JSON Schema / OpenAPI names of the unified model.
// (Importing it registers the schemas; `package.json` lists it under `sideEffects`.)
export {
  SchemaName,
  addDiscriminators,
  exportJsonSchemas,
  namedSchema,
  schemaRegistry,
  stripSafeIntegerBounds,
  type JsonSchemaExport,
} from './schema-registry.js';

// Money and time helpers.
export {
  assertPaise,
  paiseToRupeeNumber,
  paiseToRupeeString,
  rupeesToPaise,
  toPaiseOrUndefined,
} from './money.js';
export {
  addDays,
  anyToIso,
  assertInterval,
  cycleStart,
  fromIstDateString,
  fromUnixSeconds,
  isoOrUndefined,
  parseIso,
  resolveFirstChargeAt,
  toDate,
  toIso,
  toIstDateString,
  toIstIso,
  toUnixSeconds,
  unixToIso,
} from './time.js';

export { PACKAGE_NAME, PACKAGE_VERSION } from './version.js';
