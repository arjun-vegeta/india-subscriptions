/**
 * The route table. The request dispatcher (`handler.ts`) and the OpenAPI
 * generator (`openapi.ts`) both read `routes`, so the documentation cannot
 * drift from the behaviour. Every route maps to one `Subscriptions` method.
 */
import { z } from 'zod';
import { ErrorCode, HttpMethod, type Provider as ProviderName } from '../constants.js';
import type { Subscriptions } from '../client.js';
import { parseInput } from '../errors.js';
import { SchemaName, namedSchema } from '../schema-registry.js';
import {
  ListChargesOptionsSchema,
  ProviderSchema,
  type CancelSubscriptionOptions,
  type CreateChargeInput,
  type CreatePlanInput,
  type CreateSubscriptionInput,
  type NotifyChargeInput,
  type PauseSubscriptionOptions,
  type RefundInput,
  type ResumeSubscriptionOptions,
  type SubscriptionEvent,
  type UpdateSubscriptionInput,
  type VerifyCheckoutInput,
  type WebhookRequest,
} from '../schemas.js';
import {
  ApiPath,
  AuthMode,
  HealthStatus,
  HttpStatus,
  OperationId,
  PathParam,
  QueryParam,
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
  query: QueryParamDefinition[];
  requestBody?: RequestBodyDefinition;
  response: {
    schema: ResponseSchemaName;
    /** The body is an array of `schema`. */
    array: boolean;
    status: HttpStatus;
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
  query?: QueryParamDefinition[];
  body?: { schema: N; required?: boolean; raw?: boolean };
  response: { schema: ResponseSchemaName; array?: boolean; status?: HttpStatus };
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
    query: init.query ?? [],
    requestBody: init.body
      ? { schema: init.body.schema as BodyName, required: init.body.required ?? true, raw: init.body.raw ?? false }
      : undefined,
    response: {
      schema: init.response.schema,
      array: init.response.array ?? false,
      status: init.response.status ?? HttpStatus.Ok,
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
    summary: 'Verify and normalise a forwarded webhook',
    description:
      'For apps that receive the gateway webhook themselves: forward the exact raw body and the headers here. ' +
      'The signature is verified and the events are returned normalised. A bad signature answers 401.',
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
