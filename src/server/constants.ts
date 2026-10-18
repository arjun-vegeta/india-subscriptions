/**
 * Named constants for the HTTP service: paths, operation ids, tags, header
 * names, auth modes and the error-code to status mapping. The route table in
 * `routes.ts` is built from these, and so is the OpenAPI document.
 */
import { ErrorCode } from '../constants.js';

export const API_PREFIX = '/v1';
/** Where the hosted checkout lives: outside `/v1`, public, authenticated by the unguessable session id. */
export const CHECKOUT_PREFIX = '/checkout';

/** Names of `{placeholders}` in path templates. */
export const PathParam = {
  Provider: 'provider',
  PlanId: 'planId',
  SubscriptionId: 'subscriptionId',
  ChargeId: 'chargeId',
  PaymentId: 'paymentId',
  SessionId: 'sessionId',
  CustomerRef: 'customerRef',
  /** The gateway of a provider-level return: not `provider`, which the dispatcher would answer itself with a JSON error. */
  Gateway: 'gateway',
} as const;
export type PathParam = (typeof PathParam)[keyof typeof PathParam];

export const QueryParam = {
  Limit: 'limit',
} as const;
export type QueryParam = (typeof QueryParam)[keyof typeof QueryParam];

function param(name: PathParam): string {
  return `{${name}}`;
}

const PROVIDER_ROOT = `${API_PREFIX}/${param(PathParam.Provider)}`;
const SUBSCRIPTION = `${PROVIDER_ROOT}/subscriptions/${param(PathParam.SubscriptionId)}`;

export const ApiPath = {
  Health: `${API_PREFIX}/health`,
  OpenApi: `${API_PREFIX}/openapi.json`,
  Providers: `${API_PREFIX}/providers`,
  Capabilities: `${PROVIDER_ROOT}/capabilities`,
  Plans: `${PROVIDER_ROOT}/plans`,
  Plan: `${PROVIDER_ROOT}/plans/${param(PathParam.PlanId)}`,
  Subscriptions: `${PROVIDER_ROOT}/subscriptions`,
  Subscription: SUBSCRIPTION,
  SubscriptionCancel: `${SUBSCRIPTION}/cancel`,
  SubscriptionPause: `${SUBSCRIPTION}/pause`,
  SubscriptionResume: `${SUBSCRIPTION}/resume`,
  SubscriptionCharges: `${SUBSCRIPTION}/charges`,
  SubscriptionCharge: `${SUBSCRIPTION}/charges/${param(PathParam.ChargeId)}`,
  Charges: `${PROVIDER_ROOT}/charges`,
  ChargeNotifications: `${PROVIDER_ROOT}/charge-notifications`,
  Refunds: `${PROVIDER_ROOT}/refunds`,
  CheckoutVerify: `${PROVIDER_ROOT}/checkout/verify`,
  WebhooksParse: `${PROVIDER_ROOT}/webhooks/parse`,
  Webhooks: `${PROVIDER_ROOT}/webhooks`,
  Payments: `${PROVIDER_ROOT}/payments`,
  Payment: `${PROVIDER_ROOT}/payments/${param(PathParam.PaymentId)}`,
  PaymentVerify: `${PROVIDER_ROOT}/payments/verify`,
  PaymentRefunds: `${PROVIDER_ROOT}/payment-refunds`,
  RoutingDecide: `${API_PREFIX}/routing/decide`,
  RoutingOutcomes: `${API_PREFIX}/routing/outcomes`,
  Purchases: `${API_PREFIX}/purchases`,
  PurchasesFlush: `${API_PREFIX}/purchases/flush`,
  Purchase: `${API_PREFIX}/purchases/${param(PathParam.SessionId)}`,
  PurchaseAlternative: `${API_PREFIX}/purchases/${param(PathParam.SessionId)}/alternative`,
  PurchaseComplete: `${API_PREFIX}/purchases/${param(PathParam.SessionId)}/complete`,
  Entitlements: `${API_PREFIX}/entitlements/${param(PathParam.CustomerRef)}`,
  Checkout: `${CHECKOUT_PREFIX}/${param(PathParam.SessionId)}`,
  CheckoutReturn: `${CHECKOUT_PREFIX}/${param(PathParam.SessionId)}/return`,
  CheckoutReturnByGateway: `${CHECKOUT_PREFIX}/return/${param(PathParam.Gateway)}`,
  SchedulerTick: `${API_PREFIX}/scheduler/tick`,
} as const;
export type ApiPath = (typeof ApiPath)[keyof typeof ApiPath];

/** Operation ids become method names in generated clients. */
export const OperationId = {
  GetHealth: 'getHealth',
  GetOpenApi: 'getOpenApi',
  ListProviders: 'listProviders',
  GetCapabilities: 'getCapabilities',
  CreatePlan: 'createPlan',
  GetPlan: 'getPlan',
  CreateSubscription: 'createSubscription',
  GetSubscription: 'getSubscription',
  UpdateSubscription: 'updateSubscription',
  CancelSubscription: 'cancelSubscription',
  PauseSubscription: 'pauseSubscription',
  ResumeSubscription: 'resumeSubscription',
  ListCharges: 'listCharges',
  GetCharge: 'getCharge',
  CreateCharge: 'createCharge',
  NotifyCharge: 'notifyCharge',
  CreateRefund: 'createRefund',
  VerifyCheckout: 'verifyCheckout',
  ParseWebhook: 'parseWebhook',
  ReceiveWebhook: 'receiveWebhook',
  RunSchedulerTick: 'runSchedulerTick',
  CreatePayment: 'createPayment',
  GetPayment: 'getPayment',
  VerifyPayment: 'verifyPayment',
  CreatePaymentRefund: 'createPaymentRefund',
  DecideRoute: 'decideRoute',
  RecordRouteOutcome: 'recordRouteOutcome',
  StartPurchase: 'startPurchase',
  GetPurchase: 'getPurchase',
  ChooseAlternative: 'chooseAlternative',
  CompletePurchase: 'completePurchase',
  GetEntitlements: 'getEntitlements',
  FlushPurchaseReports: 'flushPurchaseReports',
  ShowHostedCheckout: 'showHostedCheckout',
  ReturnFromHostedCheckout: 'returnFromHostedCheckout',
  PostReturnFromHostedCheckout: 'postReturnFromHostedCheckout',
  ReturnFromGatewayCheckout: 'returnFromGatewayCheckout',
  PostReturnFromGatewayCheckout: 'postReturnFromGatewayCheckout',
} as const;
export type OperationId = (typeof OperationId)[keyof typeof OperationId];

export const Tag = {
  Meta: 'Meta',
  Providers: 'Providers',
  Plans: 'Plans',
  Subscriptions: 'Subscriptions',
  Charges: 'Charges',
  Refunds: 'Refunds',
  Checkout: 'Checkout',
  Webhooks: 'Webhooks',
  Scheduler: 'Scheduler',
  Payments: 'Payments',
  Routing: 'Routing',
  Purchases: 'Purchases',
  HostedCheckout: 'Hosted checkout',
} as const;
export type Tag = (typeof Tag)[keyof typeof Tag];

export const TAG_DESCRIPTIONS: Record<Tag, string> = {
  [Tag.Meta]: 'Service health and the API description.',
  [Tag.Providers]: 'The configured payment gateways and what each can do.',
  [Tag.Plans]: 'Recurring billing plans.',
  [Tag.Subscriptions]: 'Create and manage subscriptions (mandates).',
  [Tag.Charges]: 'Recurring debits and their pre-debit notifications.',
  [Tag.Refunds]: 'Refund a charge.',
  [Tag.Checkout]: 'Verify what the gateway returned after the customer authorised.',
  [Tag.Webhooks]: 'Verify and normalise gateway webhooks.',
  [Tag.Scheduler]: 'The billing engine for merchant-scheduled mandates.',
  [Tag.Payments]: 'One-time payments: create, read, verify what the customer returned with, refund.',
  [Tag.Routing]: 'Choose the best gateway for a subscription or payment, and tell the router how a gateway did.',
  [Tag.Purchases]:
    'Purchase sessions, platform policy and entitlements: one call decides where a purchase may go, and one answer says what a customer owns. Answer with a configuration error unless the service was given a purchases file.',
  [Tag.HostedCheckout]:
    'Public pages for clients that cannot run the browser helper (the Android alternative payment opens one in a browser tab). The unguessable session id is the credential; no API key.',
};

/** How a route is protected. */
export const AuthMode = {
  /** Public. */
  None: 'none',
  /** `Authorization: Bearer <apiKey>`. */
  Bearer: 'bearer',
  /** No API key: the request is authenticated by the gateway's webhook signature. */
  Signature: 'signature',
  /** No API key: the unguessable session id in the path is the credential (the hosted checkout). */
  Capability: 'capability',
} as const;
export type AuthMode = (typeof AuthMode)[keyof typeof AuthMode];

/** What a route answers with. */
export const ResponseContent = {
  /** A JSON body of the route's response schema. */
  Json: 'json',
  /** An HTML page. */
  Html: 'html',
  /** A redirect (303) with no body. */
  Redirect: 'redirect',
} as const;
export type ResponseContent = (typeof ResponseContent)[keyof typeof ResponseContent];

/** Media type of the hosted checkout pages. */
export const HTML_MEDIA_TYPE = 'text/html';

export const BEARER_SCHEME = 'Bearer';
export const SECURITY_SCHEME_NAME = 'bearerAuth';

export const HealthStatus = {
  Ok: 'ok',
} as const;
export type HealthStatus = (typeof HealthStatus)[keyof typeof HealthStatus];

export const HttpStatus = {
  Ok: 200,
  Created: 201,
  SeeOther: 303,
  BadRequest: 400,
  Unauthorized: 401,
  NotFound: 404,
  MethodNotAllowed: 405,
  Conflict: 409,
  PayloadTooLarge: 413,
  Unprocessable: 422,
  TooManyRequests: 429,
  InternalServerError: 500,
  BadGateway: 502,
  ServiceUnavailable: 503,
  GatewayTimeout: 504,
} as const;
export type HttpStatus = (typeof HttpStatus)[keyof typeof HttpStatus];

export const HTTP_STATUS_DESCRIPTIONS: Record<HttpStatus, string> = {
  [HttpStatus.Ok]: 'Success',
  [HttpStatus.Created]: 'Created',
  [HttpStatus.SeeOther]: 'Redirects the customer to the return URL of the purchase',
  [HttpStatus.BadRequest]: 'The request is malformed or fails validation',
  [HttpStatus.Unauthorized]: 'Missing or wrong API key, or a webhook signature that does not verify',
  [HttpStatus.NotFound]: 'Unknown path, gateway not configured, or the object does not exist',
  [HttpStatus.MethodNotAllowed]: 'Method not allowed for this path',
  [HttpStatus.Conflict]: 'The request conflicts with the current state at the gateway',
  [HttpStatus.PayloadTooLarge]: 'The request body is over the size limit',
  [HttpStatus.Unprocessable]: 'The gateway does not support this operation',
  [HttpStatus.TooManyRequests]: 'The gateway rate-limited the request; retry later',
  [HttpStatus.InternalServerError]: 'Server misconfiguration or unexpected failure',
  [HttpStatus.BadGateway]: 'The gateway rejected our credentials, errored, or answered with something unexpected',
  [HttpStatus.ServiceUnavailable]: 'The gateway is unavailable; retry later',
  [HttpStatus.GatewayTimeout]:
    'The gateway did not answer in time. For writes the outcome is unknown: fetch current state before retrying',
};

/** Failures that belong to this service rather than to the library or a gateway. */
export const ServerErrorCode = {
  Unauthorized: 'UNAUTHORIZED',
  MethodNotAllowed: 'METHOD_NOT_ALLOWED',
  PayloadTooLarge: 'PAYLOAD_TOO_LARGE',
  Internal: 'INTERNAL_ERROR',
} as const;
export type ServerErrorCode = (typeof ServerErrorCode)[keyof typeof ServerErrorCode];

/** Exhaustive: adding an `ErrorCode` is a compile error until it is given a status here. */
export const ERROR_HTTP_STATUS: Record<ErrorCode, HttpStatus> = {
  [ErrorCode.Validation]: HttpStatus.BadRequest,
  [ErrorCode.SignatureInvalid]: HttpStatus.Unauthorized,
  [ErrorCode.NoRoute]: HttpStatus.Unprocessable,
  [ErrorCode.NotFound]: HttpStatus.NotFound,
  [ErrorCode.Conflict]: HttpStatus.Conflict,
  [ErrorCode.Unsupported]: HttpStatus.Unprocessable,
  [ErrorCode.RateLimited]: HttpStatus.TooManyRequests,
  [ErrorCode.Config]: HttpStatus.InternalServerError,
  [ErrorCode.Auth]: HttpStatus.BadGateway,
  [ErrorCode.ProviderError]: HttpStatus.BadGateway,
  [ErrorCode.UnexpectedResponse]: HttpStatus.BadGateway,
  [ErrorCode.Network]: HttpStatus.BadGateway,
  [ErrorCode.ProviderUnavailable]: HttpStatus.ServiceUnavailable,
  [ErrorCode.Timeout]: HttpStatus.GatewayTimeout,
  [ErrorCode.OutcomeUnknown]: HttpStatus.GatewayTimeout,
  [ErrorCode.Internal]: HttpStatus.InternalServerError,
};

export const SERVER_ERROR_HTTP_STATUS: Record<ServerErrorCode, HttpStatus> = {
  [ServerErrorCode.Unauthorized]: HttpStatus.Unauthorized,
  [ServerErrorCode.MethodNotAllowed]: HttpStatus.MethodNotAllowed,
  [ServerErrorCode.PayloadTooLarge]: HttpStatus.PayloadTooLarge,
  [ServerErrorCode.Internal]: HttpStatus.InternalServerError,
};

/** Response header names this service sets (lower case, as `Headers` normalises them). */
export const ServerHeader = {
  Allow: 'allow',
  WwwAuthenticate: 'www-authenticate',
  CacheControl: 'cache-control',
  ContentTypeOptions: 'x-content-type-options',
  Connection: 'connection',
  ContentLength: 'content-length',
  ContentSecurityPolicy: 'content-security-policy',
  ReferrerPolicy: 'referrer-policy',
  FrameOptions: 'x-frame-options',
  Location: 'location',
} as const;
export type ServerHeader = (typeof ServerHeader)[keyof typeof ServerHeader];

export const HeaderValue = {
  NoStore: 'no-store',
  NoSniff: 'nosniff',
  Close: 'close',
  JsonUtf8: 'application/json; charset=utf-8',
  HtmlUtf8: 'text/html; charset=utf-8',
  /** Only the origin leaves the page when a gateway is visited: the session id in the path never does. */
  StrictOriginWhenCrossOrigin: 'strict-origin-when-cross-origin',
  FrameDeny: 'DENY',
} as const;

/** Names of the schemas this service adds to `components.schemas`, beside the published unified model. */
export const ServerSchemaName = {
  ErrorResponse: 'ErrorResponse',
  ErrorDetail: 'ErrorDetail',
  /** Every code a response can carry: the library's `ErrorCode`s and the service's own. */
  ErrorCode: 'ErrorCode',
  /** The codes of the library alone, as `TickResult.errors` carries them. */
  LibraryErrorCode: 'LibraryErrorCode',
  Health: 'Health',
  HealthStatus: 'HealthStatus',
  WebhookReceipt: 'WebhookReceipt',
  WebhookPayload: 'WebhookPayload',
  TickRequest: 'TickRequest',
  TickError: 'TickError',
  TickResult: 'TickResult',
  OpenApiDocument: 'OpenApiDocument',
  /** What the service POSTs to `EVENTS_WEBHOOK_URL`: not a response of this API, published for the receiver. */
  EventsDelivery: 'EventsDelivery',
  GatewayEventsDelivery: 'GatewayEventsDelivery',
  SchedulerEventsDelivery: 'SchedulerEventsDelivery',
  SchedulerWebhookEvent: 'SchedulerWebhookEvent',
  SchedulerEventType: 'SchedulerEventType',
  ScheduleStatus: 'ScheduleStatus',
  ScheduleStatusReason: 'ScheduleStatusReason',
  RoutingReceipt: 'RoutingReceipt',
} as const;
export type ServerSchemaName = (typeof ServerSchemaName)[keyof typeof ServerSchemaName];

export const OPENAPI_VERSION = '3.1.0';
export const DEFAULT_API_TITLE = 'india-subscriptions HTTP API';
export const DEFAULT_API_VERSION = '0.1.0';
export const DEFAULT_API_DESCRIPTION =
  'One API over subscriptions and payments on Indian payment gateways (Razorpay, Cashfree, PayU, PhonePe, Paytm) and ' +
  'app stores (Apple App Store, Google Play), with a gateway router and purchase sessions. ' +
  'Amounts are integer paise and instants are ISO-8601 strings.';
/** Default request body limit: 1 MiB. */
export const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
export const SCHEMA_REF_PREFIX = '#/components/schemas/';
