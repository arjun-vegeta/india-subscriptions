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
 * reached through a namespace: `RazorpayApi`, `CashfreeApi`, `PayUApi`.
 */

// The client.
export { Subscriptions, createSubscriptions, overlaySchedule, type SubscriptionsOptions } from './client.js';

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
export { BaseProvider, type GatewayErrorInfo, type ProviderOptions, type SubscriptionProvider } from './provider.js';
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

// Each gateway's own constants (endpoints, statuses, event names), namespaced because the names collide.
export * as RazorpayApi from './providers/razorpay/constants.js';
export * as CashfreeApi from './providers/cashfree/constants.js';
export * as PayUApi from './providers/payu/constants.js';

// Billing scheduler for merchant-scheduled mandates (the in-memory store; the file store is in `/server`).
export * from './scheduler/constants.js';
export * from './scheduler/schemas.js';
export type { SchedulerStore } from './scheduler/store.js';
export { MemorySchedulerStore, type MemorySchedulerStoreOptions } from './scheduler/memory-store.js';
export { BillingScheduler, awaitsActivation, scheduleIdFor, type SchedulerOptions } from './scheduler/scheduler.js';

// Signed events webhook (what `india-subscriptions serve` posts); receivers can verify with these.
export {
  DEFAULT_EVENTS_TIMEOUT_MS,
  EventsHeader,
  createEventsForwarder,
  signEventsBody,
  verifyEventsSignature,
  type EventsDelivery,
  type EventsForwarderOptions,
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
