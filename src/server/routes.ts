/**
 * The route table. The request dispatcher (`handler.ts`) and the OpenAPI
 * generator (`openapi.ts`) both read `routes`, so the documentation cannot
 * drift from the behaviour. Every route maps to one `Subscriptions` method.
 */
import { z } from 'zod';
import { ErrorCode, HeaderName, HttpMethod, type Provider as ProviderName } from '../constants.js';
import type { Purchases } from '../purchase/purchases.js';
import { SubscriptionError } from '../errors.js';
import { SESSION_ID_PREFIX } from '../purchase/constants.js';
import type { ChooseAlternativeInput, CompletePurchaseInput, FlushOptions, StartPurchaseInput } from '../purchase/schemas.js';
import type { RouteOutcome, RouteRequest } from '../routing/schemas.js';
import type { Subscriptions } from '../client.js';
import { parseInput } from '../errors.js';
import { SchemaName, namedSchema } from '../schema-registry.js';
import {
  ListChargesOptionsSchema,
  ProviderSchema,
  type CancelSubscriptionOptions,
  type CreateChargeInput,
  type CreatePaymentInput,
  type CreatePlanInput,
  type CreateSubscriptionInput,
  type NotifyChargeInput,
  type PauseSubscriptionOptions,
  type RefundInput,
  type RefundPaymentInput,
  type ResumeSubscriptionOptions,
  type SubscriptionEvent,
  type UpdateSubscriptionInput,
  type VerifyCheckoutInput,
  type VerifyPaymentInput,
  type WebhookRequest,
} from '../schemas.js';
import { checkoutNotFound, gatherReturnFields, handleCheckoutReturn, handleGatewayCheckoutReturn, renderCheckout } from './checkout.js';
import {
  ApiPath,
  AuthMode,
  HealthStatus,
  HttpStatus,
  OperationId,
  PathParam,
  QueryParam,
  ResponseContent,
  ServerErrorCode,
  ServerSchemaName,
  Tag,
} from './constants.js';

// ---------------------------------------------------------------------------
// Schemas that belong to the HTTP service (the unified model lives in schemas.ts)
// ---------------------------------------------------------------------------

/** Every `code` a response can carry. A code both layers define (`INTERNAL_ERROR`) appears once. */
export const ErrorCodeSchema = z
  .enum({ ...ErrorCode, ...ServerErrorCode })
  .describe(
    'A stable error code: one of the library\'s `ErrorCode`s or one of the service\'s own (`UNAUTHORIZED`, ' +
      '`METHOD_NOT_ALLOWED`, `PAYLOAD_TOO_LARGE`). Branch on this, never on the message.',
  );

export const ErrorDetailSchema = z
  .object({
    code: ErrorCodeSchema.describe('What went wrong. Branch on this, never on `message`.'),
    message: z.string().describe('Human-readable explanation. Do not branch on it.'),
    provider: ProviderSchema.optional().describe('The gateway involved, where one was.'),
    httpStatus: z
      .number()
      .int()
      .optional()
      .describe('The gateway\'s HTTP status, when it answered. This is not the status of this response.'),
    providerCode: z.string().optional().describe('The gateway\'s own error code, verbatim.'),
    retryable: z
      .boolean()
      .describe('True when repeating the same call later is safe and may succeed.'),
  })
  .describe('The error: a stable code, a message and, for gateway failures, what the gateway said.');

export const ErrorResponseSchema = z
  .object({
    error: ErrorDetailSchema.describe('The error.'),
  })
  .describe('The body of every error response.');
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const HealthStatusSchema = z.enum(HealthStatus).describe('`ok` when the service is up.');

export const HealthSchema = z
  .object({
    status: HealthStatusSchema.describe('Service status.'),
    providers: z.array(ProviderSchema).describe('The gateways this service is configured with.'),
  })
  .describe('The service health.');
export type Health = z.infer<typeof HealthSchema>;

export const WebhookReceiptSchema = z
  .object({
    received: z.number().int().nonnegative().describe('Number of events the gateway\'s webhook carried.'),
  })
  .describe('Acknowledgement of a webhook the service verified.');
export type WebhookReceipt = z.infer<typeof WebhookReceiptSchema>;

export const RoutingReceiptSchema = z
  .object({
    recorded: z.boolean().describe('True when the router counted the outcome.'),
  })
  .describe('Acknowledgement of an outcome the router recorded.');
export type RoutingReceipt = z.infer<typeof RoutingReceiptSchema>;

export const WebhookPayloadSchema = z
  .record(z.string(), z.unknown())
  .describe('The gateway\'s webhook body, exactly as the gateway sent it.');

export const TickRequestSchema = z
  .object({
    limit: z.number().int().min(1).optional().describe('Most schedules to process in this run.'),
  })
  .describe('Options for one run of the billing scheduler.');
export type TickRequest = z.infer<typeof TickRequestSchema>;

export const OpenApiDocumentSchema = z
  .looseObject({
    openapi: z.string().describe('The OpenAPI version of the document.'),
  })
  .describe('This API as an OpenAPI 3.1 document.');

/** The schemas defined here, by published name. `TickResult` and `LibraryErrorCode` are added in `openapi.ts`. */
export const SERVER_SCHEMAS = {
  [ServerSchemaName.ErrorResponse]: ErrorResponseSchema,
  [ServerSchemaName.ErrorDetail]: ErrorDetailSchema,
  [ServerSchemaName.ErrorCode]: ErrorCodeSchema,
  [ServerSchemaName.Health]: HealthSchema,
  [ServerSchemaName.HealthStatus]: HealthStatusSchema,
  [ServerSchemaName.WebhookReceipt]: WebhookReceiptSchema,
  [ServerSchemaName.WebhookPayload]: WebhookPayloadSchema,
  [ServerSchemaName.RoutingReceipt]: RoutingReceiptSchema,
  [ServerSchemaName.TickRequest]: TickRequestSchema,
  [ServerSchemaName.OpenApiDocument]: OpenApiDocumentSchema,
} as const;

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/** Called after a verified webhook, with the normalised events. If it throws, the gateway gets a 500 and retries. */
export type EventsHook = (provider: ProviderName, events: SubscriptionEvent[]) => void | Promise<void>;

/** What a route handler receives. */
export interface RouteContext<TBody = unknown, TProvider extends ProviderName | undefined = ProviderName | undefined> {
  client: Subscriptions;
  /** Set on routes whose path has a `{provider}` segment; already validated and known to be configured. */
  provider: TProvider;
  /** Decoded `{placeholders}` from the path. */
  params: Readonly<Record<string, string>>;
  /** The validated JSON body, `{}` when an optional body was omitted, or the raw string for raw routes. */
  body: TBody;
  query: URLSearchParams;
  request: Request;
  /** Registered with `createHandler`. */
  onEvents?: EventsHook;
  /** The OpenAPI document for this service. */
  openApiDocument: () => unknown;
}

export type ResponseSchemaName = SchemaName | ServerSchemaName;

export interface QueryParamDefinition {
  name: QueryParam;
  schema: z.ZodType;
  description: string;
  required: boolean;
}

export interface RequestBodyDefinition {
  schema: SchemaName | ServerSchemaName;
  required: boolean;
  /** Passed to the handler as the exact request string, not parsed. */
  raw: boolean;
}

export interface RouteDefinition {
  operationId: OperationId;
  method: HttpMethod;
  path: ApiPath;
  tag: Tag;
  summary: string;
  description: string;
  auth: AuthMode;
  /** True when serving the request calls a payment gateway (adds the gateway failure responses to the docs). */
  gateway: boolean;
  /** Statuses this route answers with beyond the ones its shape implies (for example 422 `NO_ROUTE`). */
  errors: HttpStatus[];
  query: QueryParamDefinition[];
  requestBody?: RequestBodyDefinition;
  response: {
    /** The JSON body. Absent for a page or a redirect. */
    schema?: ResponseSchemaName;
    /** The body is an array of `schema`. */
    array: boolean;
    status: HttpStatus;
    /** What the response is: JSON (the default), an HTML page or a redirect. A handler of the last two returns the `Response` itself. */
    content: ResponseContent;
  };
  handler: (context: RouteContext) => unknown;
}

/** The schema a JSON request body is validated against. */
export function requestBodySchema(name: RequestBodyDefinition['schema']): z.ZodType {
  return name in SERVER_SCHEMAS ? SERVER_SCHEMAS[name as keyof typeof SERVER_SCHEMAS] : namedSchema(name as SchemaName);
}

/** Schema names whose parsed value reaches a typed handler. */
interface BodyTypes {
  [SchemaName.CreatePlanInput]: CreatePlanInput;
  [SchemaName.CreateSubscriptionInput]: CreateSubscriptionInput;
  [SchemaName.UpdateSubscriptionInput]: UpdateSubscriptionInput;
  [SchemaName.CancelSubscriptionOptions]: CancelSubscriptionOptions;
  [SchemaName.PauseSubscriptionOptions]: PauseSubscriptionOptions;
  [SchemaName.ResumeSubscriptionOptions]: ResumeSubscriptionOptions;
  [SchemaName.CreateChargeInput]: CreateChargeInput;
  [SchemaName.NotifyChargeInput]: NotifyChargeInput;
  [SchemaName.RefundInput]: RefundInput;
  [SchemaName.VerifyCheckoutInput]: VerifyCheckoutInput;
  [SchemaName.WebhookRequest]: WebhookRequest;
  [SchemaName.CreatePaymentInput]: CreatePaymentInput;
  [SchemaName.VerifyPaymentInput]: VerifyPaymentInput;
  [SchemaName.RefundPaymentInput]: RefundPaymentInput;
  [SchemaName.RouteRequest]: RouteRequest;
  [SchemaName.RouteOutcome]: RouteOutcome;
  [SchemaName.StartPurchaseInput]: StartPurchaseInput;
  [SchemaName.ChooseAlternativeInput]: ChooseAlternativeInput;
  [SchemaName.CompletePurchaseInput]: CompletePurchaseInput;
  [SchemaName.FlushOptions]: FlushOptions;
  [ServerSchemaName.TickRequest]: TickRequest;
  [ServerSchemaName.WebhookPayload]: string;
}
type BodyName = keyof BodyTypes;
type BodyOf<N extends BodyName | undefined> = N extends BodyName ? BodyTypes[N] : undefined;

interface RouteInit<N extends BodyName | undefined, TProvider extends ProviderName | undefined> {
  operationId: OperationId;
  method: HttpMethod;
  path: ApiPath;
  tag: Tag;
  summary: string;
  description: string;
  auth?: AuthMode;
  gateway?: boolean;
  errors?: HttpStatus[];
  query?: QueryParamDefinition[];
  body?: { schema: N; required?: boolean; raw?: boolean };
  response: { schema?: ResponseSchemaName; array?: boolean; status?: HttpStatus; content?: ResponseContent };
  handler: (context: RouteContext<BodyOf<N>, TProvider>) => unknown;
}

/**
 * The dispatcher validates the body with the schema named in the route before
 * the handler runs, so the handler can rely on `BodyOf<N>`. This is the one
 * place that trust is expressed.
 */
function build<N extends BodyName | undefined, TProvider extends ProviderName | undefined>(
  init: RouteInit<N, TProvider>,
  requireProvider: boolean,
): RouteDefinition {
  return {
    operationId: init.operationId,
    method: init.method,
    path: init.path,
    tag: init.tag,
    summary: init.summary,
    description: init.description,
    auth: init.auth ?? AuthMode.Bearer,
    gateway: init.gateway ?? false,
    errors: init.errors ?? [],
    query: init.query ?? [],
    requestBody: init.body
      ? { schema: init.body.schema as BodyName, required: init.body.required ?? true, raw: init.body.raw ?? false }
      : undefined,
    response: {
      schema: init.response.schema,
      array: init.response.array ?? false,
      status: init.response.status ?? HttpStatus.Ok,
      content: init.response.content ?? ResponseContent.Json,
    },
    handler: (context) => {
      if (requireProvider && context.provider === undefined) {
        throw new Error(`Route ${init.operationId} needs a {provider} path segment`);
      }
      return init.handler(context as RouteContext<BodyOf<N>, TProvider>);
    },
  };
}

/** A route under `/v1/{provider}/...`: `context.provider` is always set. */
function providerRoute<N extends BodyName | undefined = undefined>(
  init: RouteInit<N, ProviderName>,
): RouteDefinition {
  return build(init, true);
}

/** A route with no `{provider}` segment. */
function globalRoute<N extends BodyName | undefined = undefined>(
  init: RouteInit<N, undefined>,
): RouteDefinition {
  return build(init, false);
}

function pathParam(context: { params: Readonly<Record<string, string>> }, name: PathParam): string {
  const value = context.params[name];
  if (value === undefined) throw new Error(`Missing path parameter ${name}`);
  return value;
}

const LIMIT_QUERY: QueryParamDefinition = {
  name: QueryParam.Limit,
  schema: ListChargesOptionsSchema.shape.limit.unwrap(),
  description: 'Most charges to return, from 1 to 100.',
  required: false,
};

/** Header map for `WebhookRequest`: lower-cased names, as the `Headers` object normalises them. */
export function headersToRecord(headers: Headers): Record<string, string> {
  const record: Record<string, string> = {};
  headers.forEach((value, name) => {
    record[name] = value;
  });
  return record;
}

const GATEWAY_NOTE = ' Calls the gateway.';

/** The purchase module, or the configuration error that says how to switch it on. */
function purchasesOf(client: Subscriptions): Purchases {
  if (!client.purchases) {
    throw new SubscriptionError(
      ErrorCode.Config,
      'Purchases are not configured on this service: set PURCHASES_FILE (the catalog) and PURCHASE_STORE_FILE',
    );
  }
  return client.purchases;
}

const PURCHASES_NOTE = ' Needs purchases configured on the service (PURCHASES_FILE), else answers with a configuration error.';

/** The longest session id looked up: ids are `ps_` and 32 characters. */
const MAX_SESSION_ID_LENGTH = 64;
const SESSION_ID_CHARACTERS = /^[A-Za-z0-9_-]+$/;

/** A session id that could be one of ours; anything else is not worth a lookup. */
function sessionIdOf(context: { params: Readonly<Record<string, string>> }): string | undefined {
  const id = context.params[PathParam.SessionId];
  return id !== undefined && id.startsWith(SESSION_ID_PREFIX) && id.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_CHARACTERS.test(id)
    ? id
    : undefined;
}

async function showCheckout(context: RouteContext): Promise<Response> {
  const id = sessionIdOf(context);
  const purchases = context.client.purchases;
  if (id === undefined || purchases === undefined) return checkoutNotFound();
  try {
    return renderCheckout(await purchases.get(id));
  } catch (error) {
    if (error instanceof SubscriptionError && error.code === ErrorCode.NotFound) return checkoutNotFound();
    throw error;
  }
}

async function returnFromGateway(context: RouteContext, body: string): Promise<Response> {
  const purchases = context.client.purchases;
  const gateway = context.params[PathParam.Gateway];
  if (gateway === undefined || purchases === undefined) return checkoutNotFound();
  const fields = gatherReturnFields(context.query, body, context.request.headers.get(HeaderName.ContentType));
  return handleGatewayCheckoutReturn(purchases, gateway, fields);
}

async function returnFromCheckout(context: RouteContext, body: string): Promise<Response> {
  const id = sessionIdOf(context);
  const purchases = context.client.purchases;
  if (id === undefined || purchases === undefined) return checkoutNotFound();
  const fields = gatherReturnFields(context.query, body, context.request.headers.get(HeaderName.ContentType));
  return handleCheckoutReturn(purchases, id, fields);
}

export const routes: readonly RouteDefinition[] = [
  globalRoute({
    operationId: OperationId.GetHealth,
    method: HttpMethod.Get,
    path: ApiPath.Health,
    tag: Tag.Meta,
    summary: 'Health check',
    description: 'Returns `ok` and the gateways this service is configured with. Needs no API key.',
    auth: AuthMode.None,
    response: { schema: ServerSchemaName.Health },
    handler: ({ client }): Health => ({ status: HealthStatus.Ok, providers: client.providers }),
  }),
  globalRoute({
    operationId: OperationId.GetOpenApi,
    method: HttpMethod.Get,
    path: ApiPath.OpenApi,
    tag: Tag.Meta,
    summary: 'OpenAPI document',
    description: 'This API as an OpenAPI 3.1 document, for generating typed clients. Needs no API key.',
    auth: AuthMode.None,
    response: { schema: ServerSchemaName.OpenApiDocument },
    handler: ({ openApiDocument }) => openApiDocument(),
  }),
  globalRoute({
    operationId: OperationId.ListProviders,
    method: HttpMethod.Get,
    path: ApiPath.Providers,
    tag: Tag.Providers,
    summary: 'List configured gateways',
    description: 'What each configured gateway can do.',
    response: { schema: SchemaName.Capabilities, array: true },
    handler: ({ client }) => client.providers.map((name) => client.capabilities(name)),
  }),
  providerRoute({
    operationId: OperationId.GetCapabilities,
    method: HttpMethod.Get,
    path: ApiPath.Capabilities,
    tag: Tag.Providers,
    summary: 'Gateway capabilities',
    description: 'What this gateway can do, so callers never have to guess.',
    response: { schema: SchemaName.Capabilities },
    handler: ({ client, provider }) => client.capabilities(provider),
  }),

  providerRoute({
    operationId: OperationId.CreatePlan,
    method: HttpMethod.Post,
    path: ApiPath.Plans,
    tag: Tag.Plans,
    summary: 'Create a plan',
    description: `Creates a billing plan at the gateway, or registers it where the gateway has no plan object.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.CreatePlanInput },
    response: { schema: SchemaName.Plan, status: HttpStatus.Created },
    handler: ({ client, provider, body }) => client.plans.create(provider, body),
  }),
  providerRoute({
    operationId: OperationId.GetPlan,
    method: HttpMethod.Get,
    path: ApiPath.Plan,
    tag: Tag.Plans,
    summary: 'Get a plan',
    description: `Fetches a plan.${GATEWAY_NOTE}`,
    gateway: true,
    response: { schema: SchemaName.Plan },
    handler: (context) => context.client.plans.get(context.provider, pathParam(context, PathParam.PlanId)),
  }),

  providerRoute({
    operationId: OperationId.CreateSubscription,
    method: HttpMethod.Post,
    path: ApiPath.Subscriptions,
    tag: Tag.Subscriptions,
    summary: 'Create a subscription',
    description:
      'Creates the subscription and returns it with `checkout` instructions for the customer to authorise the ' +
      `mandate.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.CreateSubscriptionInput },
    response: { schema: SchemaName.Subscription, status: HttpStatus.Created },
    handler: ({ client, provider, body }) => client.create(provider, body),
  }),
  providerRoute({
    operationId: OperationId.GetSubscription,
    method: HttpMethod.Get,
    path: ApiPath.Subscription,
    tag: Tag.Subscriptions,
    summary: 'Get a subscription',
    description: `Fetches a subscription with its current status.${GATEWAY_NOTE}`,
    gateway: true,
    response: { schema: SchemaName.Subscription },
    handler: (context) => context.client.get(context.provider, pathParam(context, PathParam.SubscriptionId)),
  }),
  providerRoute({
    operationId: OperationId.UpdateSubscription,
    method: HttpMethod.Patch,
    path: ApiPath.Subscription,
    tag: Tag.Subscriptions,
    summary: 'Update a subscription',
    description: `Changes the plan, quantity, amount or dates of a subscription.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.UpdateSubscriptionInput },
    response: { schema: SchemaName.Subscription },
    handler: (context) =>
      context.client.update(context.provider, pathParam(context, PathParam.SubscriptionId), context.body),
  }),
  providerRoute({
    operationId: OperationId.CancelSubscription,
    method: HttpMethod.Post,
    path: ApiPath.SubscriptionCancel,
    tag: Tag.Subscriptions,
    summary: 'Cancel a subscription',
    description: `Cancels now or at the end of the paid period. The body is optional.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.CancelSubscriptionOptions, required: false },
    response: { schema: SchemaName.Subscription },
    handler: (context) =>
      context.client.cancel(context.provider, pathParam(context, PathParam.SubscriptionId), context.body),
  }),
  providerRoute({
    operationId: OperationId.PauseSubscription,
    method: HttpMethod.Post,
    path: ApiPath.SubscriptionPause,
    tag: Tag.Subscriptions,
    summary: 'Pause a subscription',
    description: `Stops charging until resumed. The body is optional.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.PauseSubscriptionOptions, required: false },
    response: { schema: SchemaName.Subscription },
    handler: (context) =>
      context.client.pause(context.provider, pathParam(context, PathParam.SubscriptionId), context.body),
  }),
  providerRoute({
    operationId: OperationId.ResumeSubscription,
    method: HttpMethod.Post,
    path: ApiPath.SubscriptionResume,
    tag: Tag.Subscriptions,
    summary: 'Resume a subscription',
    description: `Resumes a paused subscription. The body is optional.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.ResumeSubscriptionOptions, required: false },
    response: { schema: SchemaName.Subscription },
    handler: (context) =>
      context.client.resume(context.provider, pathParam(context, PathParam.SubscriptionId), context.body),
  }),

  providerRoute({
    operationId: OperationId.ListCharges,
    method: HttpMethod.Get,
    path: ApiPath.SubscriptionCharges,
    tag: Tag.Charges,
    summary: 'List charges of a subscription',
    description: `Lists the debits of a subscription, newest first where the gateway orders them.${GATEWAY_NOTE}`,
    gateway: true,
    query: [LIMIT_QUERY],
    response: { schema: SchemaName.Charge, array: true },
    handler: (context) => {
      const raw = context.query.get(QueryParam.Limit);
      const options = parseInput(
        namedSchema(SchemaName.ListChargesOptions),
        raw === null ? {} : { [QueryParam.Limit]: Number(raw) },
        'query parameters',
        context.provider,
      ) as z.input<typeof ListChargesOptionsSchema>;
      return context.client.charges.list(context.provider, pathParam(context, PathParam.SubscriptionId), options);
    },
  }),
  providerRoute({
    operationId: OperationId.GetCharge,
    method: HttpMethod.Get,
    path: ApiPath.SubscriptionCharge,
    tag: Tag.Charges,
    summary: 'Get a charge',
    description: `Fetches one debit of a subscription.${GATEWAY_NOTE}`,
    gateway: true,
    response: { schema: SchemaName.Charge },
    handler: (context) =>
      context.client.charges.get(
        context.provider,
        pathParam(context, PathParam.SubscriptionId),
        pathParam(context, PathParam.ChargeId),
      ),
  }),
  providerRoute({
    operationId: OperationId.CreateCharge,
    method: HttpMethod.Post,
    path: ApiPath.Charges,
    tag: Tag.Charges,
    summary: 'Raise a charge',
    description:
      'Raises a recurring debit against the mandate, for merchant-scheduled subscriptions. With a billing ' +
      `scheduler configured you normally never call this.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.CreateChargeInput },
    response: { schema: SchemaName.Charge, status: HttpStatus.Created },
    handler: ({ client, provider, body }) => client.charges.create(provider, body),
  }),
  providerRoute({
    operationId: OperationId.NotifyCharge,
    method: HttpMethod.Post,
    path: ApiPath.ChargeNotifications,
    tag: Tag.Charges,
    summary: 'Send a pre-debit notification',
    description: `Sends the advance notice required before debiting a mandate.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.NotifyChargeInput },
    response: { schema: SchemaName.ChargeNotification, status: HttpStatus.Created },
    handler: ({ client, provider, body }) => client.charges.notify(provider, body),
  }),
  providerRoute({
    operationId: OperationId.CreateRefund,
    method: HttpMethod.Post,
    path: ApiPath.Refunds,
    tag: Tag.Refunds,
    summary: 'Refund a charge',
    description: `Refunds a charge in full or in part.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.RefundInput },
    response: { schema: SchemaName.Refund, status: HttpStatus.Created },
    handler: ({ client, provider, body }) => client.charges.refund(provider, body),
  }),

  providerRoute({
    operationId: OperationId.VerifyCheckout,
    method: HttpMethod.Post,
    path: ApiPath.CheckoutVerify,
    tag: Tag.Checkout,
    summary: 'Verify a checkout result',
    description:
      'Verifies what the gateway returned to the customer\'s browser after authorisation, and starts the billing ' +
      'schedule for merchant-scheduled subscriptions. Pass the gateway\'s result untouched as `result`, and the ' +
      'subscription id your server stored as `expectedSubscriptionId`: a genuine result that belongs to a ' +
      'different subscription is then rejected like a forged one.' +
      GATEWAY_NOTE,
    gateway: true,
    body: { schema: SchemaName.VerifyCheckoutInput },
    response: { schema: SchemaName.CheckoutVerification },
    handler: ({ client, provider, body }) =>
      client.verifyCheckout(
        provider,
        body.result,
        body.expectedSubscriptionId === undefined ? {} : { expectedSubscriptionId: body.expectedSubscriptionId },
      ),
  }),

  providerRoute({
    operationId: OperationId.ParseWebhook,
    method: HttpMethod.Post,
    path: ApiPath.WebhooksParse,
    tag: Tag.Webhooks,
    summary: 'Verify, apply and normalise a forwarded webhook',
    description:
      'For apps that receive the gateway webhook themselves: forward the exact raw body and the headers here. ' +
      'The signature is verified, each event is applied to the billing scheduler (so a mandate that was authorised, ' +
      'paused or cancelled at the gateway is reflected in billing), and the events are returned normalised. ' +
      'Forwarding the same webhook twice is safe. A bad signature answers 401 and changes nothing.',
    body: { schema: SchemaName.WebhookRequest },
    response: { schema: SchemaName.SubscriptionEvent, array: true },
    handler: ({ client, provider, body }) => client.webhooks.handle(provider, body),
  }),
  providerRoute({
    operationId: OperationId.ReceiveWebhook,
    method: HttpMethod.Post,
    path: ApiPath.Webhooks,
    tag: Tag.Webhooks,
    summary: 'Receive a gateway webhook',
    description:
      'The URL to register at the gateway. It takes no API key because gateways cannot send one: the request is ' +
      'authenticated by the gateway\'s signature over the exact raw body. A bad signature answers 401. If the ' +
      'service\'s event hook fails the answer is 500, so the gateway retries.',
    auth: AuthMode.Signature,
    body: { schema: ServerSchemaName.WebhookPayload, raw: true },
    response: { schema: ServerSchemaName.WebhookReceipt },
    handler: async ({ client, provider, body, request, onEvents }): Promise<WebhookReceipt> => {
      const events = await client.webhooks.handle(provider, { rawBody: body, headers: headersToRecord(request.headers) });
      if (onEvents) {
        try {
          await onEvents(provider, events);
        } catch (cause) {
          // Deliberately not a SubscriptionError: whatever the hook threw, the gateway must see a 5xx and retry.
          throw new Error('The webhook event hook failed', { cause });
        }
      }
      return { received: events.length };
    },
  }),

  providerRoute({
    operationId: OperationId.CreatePayment,
    method: HttpMethod.Post,
    path: ApiPath.Payments,
    tag: Tag.Payments,
    summary: 'Create a one-time payment',
    description:
      'Creates the payment (an order) and returns it with `checkout` instructions for the customer to pay. At an app store ' +
      `this makes no purchase: it returns the account token the purchase on the device must carry.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.CreatePaymentInput },
    response: { schema: SchemaName.Payment, status: HttpStatus.Created },
    handler: ({ client, provider, body }) => client.payments.create(provider, body),
  }),
  providerRoute({
    operationId: OperationId.GetPayment,
    method: HttpMethod.Get,
    path: ApiPath.Payment,
    tag: Tag.Payments,
    summary: 'Get a payment',
    description: `Fetches a one-time payment with its current status: the source of truth, whatever the browser reported.${GATEWAY_NOTE}`,
    gateway: true,
    response: { schema: SchemaName.Payment },
    handler: (context) => context.client.payments.get(context.provider, pathParam(context, PathParam.PaymentId)),
  }),
  providerRoute({
    operationId: OperationId.VerifyPayment,
    method: HttpMethod.Post,
    path: ApiPath.PaymentVerify,
    tag: Tag.Payments,
    summary: 'Verify a payment result',
    description:
      'Verifies what the gateway (or the store, on a device) returned after the customer paid. Pass the result untouched as ' +
      '`result`, and the payment id your server stored as `expectedPaymentId`: a genuine result that belongs to a different ' +
      `payment is then rejected like a forged one.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.VerifyPaymentInput },
    response: { schema: SchemaName.PaymentVerification },
    handler: ({ client, provider, body }) =>
      client.payments.verify(provider, body.result, body.expectedPaymentId === undefined ? {} : { expectedPaymentId: body.expectedPaymentId }),
  }),
  providerRoute({
    operationId: OperationId.CreatePaymentRefund,
    method: HttpMethod.Post,
    path: ApiPath.PaymentRefunds,
    tag: Tag.Payments,
    summary: 'Refund a payment',
    description: `Refunds a one-time payment in full or in part.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.RefundPaymentInput },
    response: { schema: SchemaName.Refund, status: HttpStatus.Created },
    handler: ({ client, provider, body }) => client.payments.refund(provider, body),
  }),

  globalRoute({
    operationId: OperationId.DecideRoute,
    method: HttpMethod.Post,
    path: ApiPath.RoutingDecide,
    tag: Tag.Routing,
    summary: 'Decide a route',
    description:
      'Chooses the best configured gateway for a subscription or a one-time payment, and explains the choice: every gateway ' +
      'comes back with its exclusions or its score. Answers 422 `NO_ROUTE` when no gateway can take the request. Nothing is ' +
      'created at a gateway.',
    errors: [HttpStatus.Unprocessable],
    body: { schema: SchemaName.RouteRequest },
    response: { schema: SchemaName.RoutingDecision },
    handler: ({ client, body }) => client.router.route(body),
  }),
  globalRoute({
    operationId: OperationId.RecordRouteOutcome,
    method: HttpMethod.Post,
    path: ApiPath.RoutingOutcomes,
    tag: Tag.Routing,
    summary: 'Record a routing outcome',
    description:
      'Tells the router how a gateway did (success, failure, or unavailable), so its success rates and circuit breaker follow ' +
      'what you see. Purchase sessions record their own outcomes: use this for payments you create through the explicit ' +
      'gateway routes.',
    body: { schema: SchemaName.RouteOutcome },
    response: { schema: ServerSchemaName.RoutingReceipt },
    handler: async ({ client, body }): Promise<RoutingReceipt> => {
      if (!client.providers.includes(body.provider)) {
        throw new SubscriptionError(ErrorCode.NotFound, `Provider ${body.provider} is not configured on this service`);
      }
      await client.router.record(body);
      return { recorded: true };
    },
  }),

  globalRoute({
    operationId: OperationId.StartPurchase,
    method: HttpMethod.Post,
    path: ApiPath.Purchases,
    tag: Tag.Purchases,
    summary: 'Start a purchase',
    description:
      'Decides where the purchase may go on the customer\'s platform (the App Store on iOS; Google Play, Google Play with ' +
      'user choice billing, or the gateways on Android; the gateways on the web), creates it there and returns the session ' +
      'with the ways to pay. Repeating the call with the same `reference` returns the same session. Answers 409 when the ' +
      `customer already owns the product.${GATEWAY_NOTE}${PURCHASES_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.StartPurchaseInput },
    response: { schema: SchemaName.PurchaseSession, status: HttpStatus.Created },
    handler: ({ client, body }) => purchasesOf(client).start(body),
  }),
  globalRoute({
    operationId: OperationId.FlushPurchaseReports,
    method: HttpMethod.Post,
    path: ApiPath.PurchasesFlush,
    tag: Tag.Purchases,
    summary: 'Send the queued Google reports',
    description:
      'Sends the purchases, renewals and refunds made through Google Play user choice billing that Google has not been told ' +
      'about yet. The service does this on every tick by itself; call it to do it now. `overdue` lists the reports past ' +
      `their 24 hour deadline: page someone when it is not empty.${GATEWAY_NOTE}${PURCHASES_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.FlushOptions, required: false },
    response: { schema: SchemaName.FlushResult },
    handler: ({ client, body }) => purchasesOf(client).flush(body),
  }),
  globalRoute({
    operationId: OperationId.GetPurchase,
    method: HttpMethod.Get,
    path: ApiPath.Purchase,
    tag: Tag.Purchases,
    summary: 'Get a purchase session',
    description: `The session with its current status.${PURCHASES_NOTE}`,
    response: { schema: SchemaName.PurchaseSession },
    handler: (context) => purchasesOf(context.client).get(pathParam(context, PathParam.SessionId)),
  }),
  globalRoute({
    operationId: OperationId.ChooseAlternative,
    method: HttpMethod.Post,
    path: ApiPath.PurchaseAlternative,
    tag: Tag.Purchases,
    summary: 'Choose the alternative payment',
    description:
      'The customer picked the alternative payment on Google\'s choice screen (Android sessions with the `user_choice` ' +
      'policy). Creates the purchase at the best gateway and adds it to the session as a second option, with a `hostedUrl` ' +
      `to open in a browser tab. Repeating it with the same token returns the same option.${GATEWAY_NOTE}${PURCHASES_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.ChooseAlternativeInput },
    response: { schema: SchemaName.PurchaseSession },
    handler: (context) => purchasesOf(context.client).chooseAlternative(pathParam(context, PathParam.SessionId), context.body),
  }),
  globalRoute({
    operationId: OperationId.CompletePurchase,
    method: HttpMethod.Post,
    path: ApiPath.PurchaseComplete,
    tag: Tag.Purchases,
    summary: 'Complete a purchase',
    description:
      'Verifies what the checkout handed back (the store\'s transaction from the device, or a gateway\'s result) against the ' +
      'order the session created, and records the entitlement. A result for another order is rejected with `SIGNATURE_INVALID` ' +
      `and the session stays as it was.${GATEWAY_NOTE}${PURCHASES_NOTE}`,
    gateway: true,
    body: { schema: SchemaName.CompletePurchaseInput },
    response: { schema: SchemaName.PurchaseSession },
    handler: (context) => purchasesOf(context.client).complete(pathParam(context, PathParam.SessionId), context.body),
  }),
  globalRoute({
    operationId: OperationId.GetEntitlements,
    method: HttpMethod.Get,
    path: ApiPath.Entitlements,
    tag: Tag.Purchases,
    summary: 'Get what a customer owns',
    description: `Every purchase of the customer across app stores and gateways; \`active\` is true when one gives access now.${PURCHASES_NOTE}`,
    response: { schema: SchemaName.Entitlements },
    handler: (context) => purchasesOf(context.client).entitlements(pathParam(context, PathParam.CustomerRef)),
  }),

  globalRoute({
    operationId: OperationId.ShowHostedCheckout,
    method: HttpMethod.Get,
    path: ApiPath.Checkout,
    tag: Tag.HostedCheckout,
    summary: 'Hosted checkout page',
    description:
      'An HTML page that performs the checkout step of the session\'s gateway option (a redirect, a form post, Razorpay ' +
      'Standard Checkout or cashfree.js) for a client that cannot run the browser helper. Needs no API key: the session id is ' +
      'the credential. Answers 404, with no detail, for an unknown or expired session. Served with a strict ' +
      'Content-Security-Policy and holds no secret.',
    auth: AuthMode.Capability,
    response: { content: ResponseContent.Html },
    handler: showCheckout,
  }),
  globalRoute({
    operationId: OperationId.ReturnFromHostedCheckout,
    method: HttpMethod.Get,
    path: ApiPath.CheckoutReturn,
    tag: Tag.HostedCheckout,
    summary: 'Hosted checkout return (query)',
    description:
      'Where a gateway, or the hosted page\'s own script, sends the customer back with the result in the query. The fields are ' +
      'never trusted: the purchase is completed by asking the gateway, and the customer is redirected to the `returnUrl` of the ' +
      'session with `session` and `status` appended, whatever the outcome. Needs no API key.',
    auth: AuthMode.Capability,
    response: { status: HttpStatus.SeeOther, content: ResponseContent.Redirect },
    handler: (context) => returnFromCheckout(context, ''),
  }),
  globalRoute({
    operationId: OperationId.PostReturnFromHostedCheckout,
    method: HttpMethod.Post,
    path: ApiPath.CheckoutReturn,
    tag: Tag.HostedCheckout,
    summary: 'Hosted checkout return (form)',
    description:
      'The same as the query form, for a gateway that posts the result as form fields (PayU, Paytm, Razorpay\'s callback). ' +
      'The fields of the query and of the form are both read. Needs no API key.',
    auth: AuthMode.Capability,
    body: { schema: ServerSchemaName.WebhookPayload, raw: true, required: false },
    response: { status: HttpStatus.SeeOther, content: ResponseContent.Redirect },
    handler: (context) => returnFromCheckout(context, context.body),
  }),

  globalRoute({
    operationId: OperationId.ReturnFromGatewayCheckout,
    method: HttpMethod.Get,
    path: ApiPath.CheckoutReturnByGateway,
    tag: Tag.HostedCheckout,
    summary: 'Hosted checkout return of a gateway (query)',
    description:
      'The return address of a gateway that cannot carry the session id (PayU limits return URLs to 50 characters). The gateway ' +
      'posts back the merchant\'s transaction id; the session is found by it and the return then behaves exactly like the ' +
      'session return: the purchase is completed by asking the gateway, and the customer is redirected to the `returnUrl` of ' +
      'the session with `session` and `status` appended. An unknown id, or a gateway without this route, answers 404 with no detail. Needs no API key.',
    auth: AuthMode.Capability,
    response: { status: HttpStatus.SeeOther, content: ResponseContent.Redirect },
    handler: (context) => returnFromGateway(context, ''),
  }),
  globalRoute({
    operationId: OperationId.PostReturnFromGatewayCheckout,
    method: HttpMethod.Post,
    path: ApiPath.CheckoutReturnByGateway,
    tag: Tag.HostedCheckout,
    summary: 'Hosted checkout return of a gateway (form)',
    description: 'The same as the query form, for a gateway that posts the result as form fields (PayU). The fields of the query and of the form are both read. Needs no API key.',
    auth: AuthMode.Capability,
    body: { schema: ServerSchemaName.WebhookPayload, raw: true, required: false },
    response: { status: HttpStatus.SeeOther, content: ResponseContent.Redirect },
    handler: (context) => returnFromGateway(context, context.body),
  }),

  globalRoute({
    operationId: OperationId.RunSchedulerTick,
    method: HttpMethod.Post,
    path: ApiPath.SchedulerTick,
    tag: Tag.Scheduler,
    summary: 'Run the billing scheduler once',
    description:
      'Raises the debits that are due. Call it from a cron job, every 15 minutes or so. Needs a scheduler ' +
      `configured on the service.${GATEWAY_NOTE}`,
    gateway: true,
    body: { schema: ServerSchemaName.TickRequest, required: false },
    response: { schema: ServerSchemaName.TickResult },
    handler: ({ client, body }) => client.tick(body.limit === undefined ? undefined : { limit: body.limit }),
  }),
];
