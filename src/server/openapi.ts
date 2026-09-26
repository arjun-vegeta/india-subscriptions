/**
 * Generates the OpenAPI 3.1 document from the route table and the published
 * Zod schemas, so the document is the contract typed clients are built from.
 */
import { z } from 'zod';
import { ContentType } from '../constants.js';
import { SchemaName, addDiscriminators, exportJsonSchemas, stripSafeIntegerBounds } from '../schema-registry.js';
import {
  EventsDeliverySchema,
  GatewayEventsDeliverySchema,
  SchedulerEventsDeliverySchema,
  SchedulerWebhookEventSchema,
} from '../events-envelope.js';
import {
  ErrorCodeSchema as LibraryErrorCodeSchema,
  ScheduleStatusReasonSchema,
  ScheduleStatusSchema,
  SchedulerEventTypeSchema,
  TickErrorSchema,
  TickResultSchema,
} from '../scheduler/schemas.js';
import {
  AuthMode,
  BEARER_SCHEME,
  DEFAULT_API_DESCRIPTION,
  DEFAULT_API_TITLE,
  DEFAULT_API_VERSION,
  HTTP_STATUS_DESCRIPTIONS,
  HttpStatus,
  OPENAPI_VERSION,
  PathParam,
  SCHEMA_REF_PREFIX,
  SECURITY_SCHEME_NAME,
  ServerSchemaName,
  TAG_DESCRIPTIONS,
  Tag,
} from './constants.js';
import { SERVER_SCHEMAS, routes, type RouteDefinition } from './routes.js';

type JsonObject = Record<string, unknown>;

export interface OpenApiOptions {
  title?: string;
  version?: string;
  /** Where the API is mounted, e.g. `https://billing.example.com` or `/billing` (a relative URL is allowed). */
  serverUrl?: string;
}

export interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description: string };
  servers?: { url: string }[];
  tags: { name: string; description: string }[];
  paths: Record<string, Record<string, JsonObject>>;
  components: {
    schemas: Record<string, JsonObject>;
    securitySchemes: Record<string, JsonObject>;
  };
}

const IO = { Input: 'input', Output: 'output' } as const;
type Io = (typeof IO)[keyof typeof IO];

const PATH_PARAM_DESCRIPTIONS: Record<PathParam, string> = {
  [PathParam.Provider]: 'The payment gateway to call. It must be configured on the service.',
  [PathParam.PlanId]: 'The plan id, as returned when the plan was created.',
  [PathParam.SubscriptionId]: 'The subscription id returned when it was created or its checkout was verified.',
  [PathParam.ChargeId]: 'The charge id, as returned by the gateway or when the charge was raised.',
};

const PATH_PLACEHOLDER = /\{([^}]+)\}/g;

function ref(name: string): JsonObject {
  return { $ref: `${SCHEMA_REF_PREFIX}${name}` };
}

function stripMeta(schema: JsonObject): JsonObject {
  const { $schema: _schema, $id: _id, ...rest } = schema;
  return rest;
}

/** The schemas this service adds to the unified model. */
function serverSchemas(): Record<string, z.ZodType> {
  return {
    ...SERVER_SCHEMAS,
    [ServerSchemaName.TickError]: TickErrorSchema,
    [ServerSchemaName.TickResult]: TickResultSchema,
    [ServerSchemaName.LibraryErrorCode]: LibraryErrorCodeSchema,
    // The bodies of the events webhook (outgoing), published so receivers can be generated or validated from them.
    [ServerSchemaName.EventsDelivery]: EventsDeliverySchema,
    [ServerSchemaName.GatewayEventsDelivery]: GatewayEventsDeliverySchema,
    [ServerSchemaName.SchedulerEventsDelivery]: SchedulerEventsDeliverySchema,
    [ServerSchemaName.SchedulerWebhookEvent]: SchedulerWebhookEventSchema,
    [ServerSchemaName.SchedulerEventType]: SchedulerEventTypeSchema,
    [ServerSchemaName.ScheduleStatus]: ScheduleStatusSchema,
    [ServerSchemaName.ScheduleStatusReason]: ScheduleStatusReasonSchema,
  };
}

/**
 * Every published schema (unified model and service) in one `toJSONSchema` run, so that a schema used by both,
 * such as `Provider`, is one named component referenced everywhere. The OpenAPI-only `discriminator` is added here.
 */
function exportAll(io: Io): Record<string, JsonObject> {
  const { schemas } = exportJsonSchemas({ refPrefix: SCHEMA_REF_PREFIX, io, extra: serverSchemas() });
  addDiscriminators(schemas, SCHEMA_REF_PREFIX);
  return schemas;
}

function collectRefs(node: unknown, found: Set<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) collectRefs(item, found);
    return;
  }
  if (node === null || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (key === '$ref' && typeof value === 'string' && value.startsWith(SCHEMA_REF_PREFIX)) {
      found.add(value.slice(SCHEMA_REF_PREFIX.length));
    } else {
      collectRefs(value, found);
    }
  }
}

let cachedComponents: Record<string, JsonObject> | undefined;

/**
 * Every schema as `io: 'output'` (what callers receive, defaults present), except the schemas a
 * request body is made of, which are `io: 'input'` (what callers send, defaults optional).
 */
function componentSchemas(): Record<string, JsonObject> {
  if (cachedComponents) return cachedComponents;
  const output = exportAll(IO.Output);
  const input = exportAll(IO.Input);

  // A request body and everything it points at must use the input form.
  const pending = routes.flatMap((route) => (route.requestBody ? [route.requestBody.schema as string] : []));
  const sendable = new Set<string>();
  while (pending.length > 0) {
    const name = pending.pop();
    if (name === undefined || sendable.has(name)) continue;
    sendable.add(name);
    const refs = new Set<string>();
    collectRefs(input[name], refs);
    pending.push(...refs);
  }

  const components: Record<string, JsonObject> = { ...output };
  for (const name of sendable) {
    const schema = input[name];
    if (schema) components[name] = schema;
  }
  cachedComponents = components;
  return components;
}

function pathParameters(route: RouteDefinition): JsonObject[] {
  return [...route.path.matchAll(PATH_PLACEHOLDER)].map((match) => {
    const name = match[1] as PathParam;
    return {
      name,
      in: 'path',
      required: true,
      description: PATH_PARAM_DESCRIPTIONS[name],
      schema: name === PathParam.Provider ? ref(SchemaName.Provider) : { type: 'string' },
    };
  });
}

function queryParameters(route: RouteDefinition): JsonObject[] {
  return route.query.map((query) => ({
    name: query.name,
    in: 'query',
    required: query.required,
    description: query.description,
    schema: stripSafeIntegerBounds(
      stripMeta(z.toJSONSchema(query.schema, { io: IO.Input, unrepresentable: 'any' }) as JsonObject),
    ),
  }));
}

function jsonContent(schema: JsonObject): JsonObject {
  return { [ContentType.Json]: { schema } };
}

function errorStatuses(route: RouteDefinition): HttpStatus[] {
  const hasProvider = route.path.includes(`{${PathParam.Provider}}`);
  const statuses = new Set<HttpStatus>();
  if (route.auth === AuthMode.None) return [];
  if (hasProvider || route.requestBody || route.query.length > 0) statuses.add(HttpStatus.BadRequest);
  statuses.add(HttpStatus.Unauthorized);
  if (hasProvider || route.gateway) statuses.add(HttpStatus.NotFound);
  if (route.requestBody) statuses.add(HttpStatus.PayloadTooLarge);
  statuses.add(HttpStatus.InternalServerError);
  if (route.gateway) {
    for (const status of [
      HttpStatus.Conflict,
      HttpStatus.Unprocessable,
      HttpStatus.TooManyRequests,
      HttpStatus.BadGateway,
      HttpStatus.ServiceUnavailable,
      HttpStatus.GatewayTimeout,
    ]) {
      statuses.add(status);
    }
  }
  return [...statuses].sort((a, b) => a - b);
}

function operation(route: RouteDefinition): JsonObject {
  const success: JsonObject = ref(route.response.schema);
  const responses: Record<string, JsonObject> = {
    [String(route.response.status)]: {
      description: HTTP_STATUS_DESCRIPTIONS[route.response.status],
      content: jsonContent(route.response.array ? { type: 'array', items: success } : success),
    },
  };
  for (const status of errorStatuses(route)) {
    responses[String(status)] = {
      description: HTTP_STATUS_DESCRIPTIONS[status],
      content: jsonContent(ref(ServerSchemaName.ErrorResponse)),
    };
  }

  const result: JsonObject = {
    operationId: route.operationId,
    tags: [route.tag],
    summary: route.summary,
    description: route.description,
    parameters: [...pathParameters(route), ...queryParameters(route)],
    responses,
    security: route.auth === AuthMode.Bearer ? [{ [SECURITY_SCHEME_NAME]: [] }] : [],
  };
  if (route.requestBody) {
    const schema = ref(route.requestBody.schema);
    result.requestBody = {
      required: route.requestBody.required,
      content: route.requestBody.raw
        ? { [ContentType.Json]: { schema }, [ContentType.Form]: { schema } }
        : jsonContent(schema),
    };
  }
  return result;
}

/** Builds the OpenAPI 3.1 document for the route table. */
export function buildOpenApiDocument(options: OpenApiOptions = {}): OpenApiDocument {
  const paths: Record<string, Record<string, JsonObject>> = {};
  for (const route of routes) {
    const item = (paths[route.path] ??= {});
    item[route.method.toLowerCase()] = operation(route);
  }

  const document: OpenApiDocument = {
    openapi: OPENAPI_VERSION,
    info: {
      title: options.title ?? DEFAULT_API_TITLE,
      version: options.version ?? DEFAULT_API_VERSION,
      description: DEFAULT_API_DESCRIPTION,
    },
    tags: Object.values(Tag).map((name) => ({ name, description: TAG_DESCRIPTIONS[name] })),
    paths,
    components: {
      schemas: structuredClone(componentSchemas()),
      securitySchemes: {
        [SECURITY_SCHEME_NAME]: {
          type: 'http',
          scheme: BEARER_SCHEME.toLowerCase(),
          description: 'The service API key: `Authorization: Bearer <apiKey>`.',
        },
      },
    },
  };
  if (options.serverUrl !== undefined) document.servers = [{ url: options.serverUrl }];
  return document;
}
