import { describe, expect, it } from 'vitest';
import { HttpMethod } from '../../src/constants.js';
import { SchemaName } from '../../src/schema-registry.js';
import {
  ApiPath,
  AuthMode,
  OperationId,
  SECURITY_SCHEME_NAME,
  ServerSchemaName,
  buildOpenApiDocument,
  routes,
  type OpenApiDocument,
} from '../../src/server/index.js';

const doc = buildOpenApiDocument();
const SCHEMA_PREFIX = '#/components/schemas/';

type Json = Record<string, unknown>;

function operationOf(path: string, method: string): Json {
  const operation = doc.paths[path]?.[method.toLowerCase()];
  if (!operation) throw new Error(`No operation for ${method} ${path}`);
  return operation;
}

function walk(node: unknown, visit: (key: string, value: unknown) => void): void {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value);
      walk(value, visit);
    }
  }
}

/** Resolves a JSON pointer such as `#/components/schemas/Plan` within the document. */
function resolvePointer(document: OpenApiDocument, pointer: string): unknown {
  if (!pointer.startsWith('#')) return undefined;
  let current: unknown = document;
  for (const raw of pointer.slice(1).split('/').filter(Boolean)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object' || !(key in current)) return undefined;
    current = (current as Json)[key];
  }
  return current;
}

describe('OpenAPI document', () => {
  it('is OpenAPI 3.1.0 with info, tags and a bearer security scheme', () => {
    expect(doc.openapi).toBe('3.1.0');
    expect(doc.info.title).toBeTruthy();
    expect(doc.info.version).toBeTruthy();
    expect(doc.components.securitySchemes[SECURITY_SCHEME_NAME]).toMatchObject({ type: 'http', scheme: 'bearer' });
    expect(doc.tags.length).toBeGreaterThan(0);
  });

  it('honours title, version and serverUrl', () => {
    const custom = buildOpenApiDocument({ title: 'Billing', version: '9.9.9', serverUrl: 'https://billing.example.com' });
    expect(custom.info).toMatchObject({ title: 'Billing', version: '9.9.9' });
    expect(custom.servers).toEqual([{ url: 'https://billing.example.com' }]);
    expect(doc.servers).toBeUndefined();
  });

  it('documents every route of the table, and only those', () => {
    const documented = Object.entries(doc.paths).flatMap(([path, item]) =>
      Object.keys(item).map((method) => `${method.toUpperCase()} ${path}`),
    );
    expect(documented.sort()).toEqual(routes.map((route) => `${route.method} ${route.path}`).sort());
  });

  it('lists the routes the service promises', () => {
    const expected: [string, string][] = [
      [HttpMethod.Get, '/v1/health'],
      [HttpMethod.Get, '/v1/openapi.json'],
      [HttpMethod.Get, '/v1/providers'],
      [HttpMethod.Get, '/v1/{provider}/capabilities'],
      [HttpMethod.Post, '/v1/{provider}/plans'],
      [HttpMethod.Get, '/v1/{provider}/plans/{planId}'],
      [HttpMethod.Post, '/v1/{provider}/subscriptions'],
      [HttpMethod.Get, '/v1/{provider}/subscriptions/{subscriptionId}'],
      [HttpMethod.Patch, '/v1/{provider}/subscriptions/{subscriptionId}'],
      [HttpMethod.Post, '/v1/{provider}/subscriptions/{subscriptionId}/cancel'],
      [HttpMethod.Post, '/v1/{provider}/subscriptions/{subscriptionId}/pause'],
      [HttpMethod.Post, '/v1/{provider}/subscriptions/{subscriptionId}/resume'],
      [HttpMethod.Get, '/v1/{provider}/subscriptions/{subscriptionId}/charges'],
      [HttpMethod.Get, '/v1/{provider}/subscriptions/{subscriptionId}/charges/{chargeId}'],
      [HttpMethod.Post, '/v1/{provider}/charges'],
      [HttpMethod.Post, '/v1/{provider}/charge-notifications'],
      [HttpMethod.Post, '/v1/{provider}/refunds'],
      [HttpMethod.Post, '/v1/{provider}/checkout/verify'],
      [HttpMethod.Post, '/v1/{provider}/webhooks/parse'],
      [HttpMethod.Post, '/v1/{provider}/webhooks'],
      [HttpMethod.Post, '/v1/scheduler/tick'],
    ];
    for (const [method, path] of expected) expect(() => operationOf(path, method), `${method} ${path}`).not.toThrow();
    expect(routes).toHaveLength(expected.length);
  });

  it('has a unique operationId per operation, all taken from the constants', () => {
    const ids: string[] = [];
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item)) ids.push(operation.operationId as string);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(Object.values(OperationId).sort());
  });

  it('resolves every $ref', () => {
    const refs: string[] = [];
    walk(doc, (key, value) => {
      if (key === '$ref') refs.push(String(value));
    });
    expect(refs.length).toBeGreaterThan(50);
    for (const ref of refs) {
      expect(ref.startsWith(SCHEMA_PREFIX), ref).toBe(true);
      expect(resolvePointer(doc, ref), ref).toBeDefined();
    }
  });

  it('defines every schema the routes reference, plus the service schemas', () => {
    for (const route of routes) {
      expect(doc.components.schemas[route.response.schema], route.operationId).toBeDefined();
      if (route.requestBody) expect(doc.components.schemas[route.requestBody.schema], route.operationId).toBeDefined();
    }
    for (const name of Object.values(ServerSchemaName)) expect(doc.components.schemas[name], name).toBeDefined();
    for (const name of Object.values(SchemaName)) expect(doc.components.schemas[name], name).toBeDefined();
  });

  it('requires bearer auth on protected operations and none on public ones', () => {
    for (const route of routes) {
      const operation = operationOf(route.path, route.method);
      if (route.auth === AuthMode.Bearer) {
        expect(operation.security, route.operationId).toEqual([{ [SECURITY_SCHEME_NAME]: [] }]);
      } else {
        expect(operation.security, route.operationId).toEqual([]);
      }
    }
    expect(routes.filter((r) => r.auth === AuthMode.None).map((r) => r.path).sort()).toEqual(
      [ApiPath.Health, ApiPath.OpenApi].sort(),
    );
    expect(routes.find((r) => r.path === ApiPath.Webhooks)?.auth).toBe(AuthMode.Signature);
  });

  it('declares path parameters for every placeholder, and the limit query', () => {
    for (const route of routes) {
      const placeholders = [...route.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
      const declared = ((operationOf(route.path, route.method).parameters as Json[]) ?? [])
        .filter((p) => p.in === 'path')
        .map((p) => p.name);
      expect(declared, route.operationId).toEqual(placeholders);
    }
    const params = operationOf('/v1/{provider}/subscriptions/{subscriptionId}/charges', 'get').parameters as Json[];
    const limit = params.find((p) => p.name === 'limit');
    expect(limit).toMatchObject({ in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 100 } });
  });

  it('lists the success status and error responses on every operation', () => {
    for (const route of routes) {
      const responses = operationOf(route.path, route.method).responses as Record<string, Json>;
      expect(responses[String(route.response.status)], route.operationId).toBeDefined();
      if (route.auth === AuthMode.None) continue;
      for (const status of ['401', '500']) expect(responses[status], `${route.operationId} ${status}`).toBeDefined();
      for (const [status, response] of Object.entries(responses)) {
        if (Number(status) < 400) continue;
        expect(JSON.stringify(response)).toContain(`${SCHEMA_PREFIX}${ServerSchemaName.ErrorResponse}`);
      }
    }
    const create = operationOf('/v1/{provider}/subscriptions', 'post').responses as Record<string, Json>;
    for (const status of ['201', '400', '404', '409', '413', '422', '429', '502', '503', '504']) {
      expect(create[status], status).toBeDefined();
    }
  });

  it('types array responses as arrays of the schema', () => {
    const responses = operationOf('/v1/providers', 'get').responses as Record<string, { content: Json }>;
    expect(responses['200']?.content['application/json']).toEqual({
      schema: { type: 'array', items: { $ref: `${SCHEMA_PREFIX}${SchemaName.Capabilities}` } },
    });
  });

  it('marks optional bodies as not required', () => {
    const cancel = operationOf('/v1/{provider}/subscriptions/{subscriptionId}/cancel', 'post');
    expect((cancel.requestBody as Json).required).toBe(false);
    const create = operationOf('/v1/{provider}/plans', 'post');
    expect((create.requestBody as Json).required).toBe(true);
  });

  it('describes request bodies in their input form (defaults optional) and responses in their output form', () => {
    const schemas = doc.components.schemas;
    const input = schemas[SchemaName.CreatePlanInput] as { required?: string[] };
    const output = schemas[SchemaName.Plan] as { required?: string[] };
    expect(input.required).not.toContain('currency');
    expect(output.required).toContain('currency');

    const cancel = schemas[SchemaName.CancelSubscriptionOptions] as { required?: string[] };
    expect(cancel.required ?? []).not.toContain('mode');

    const update = schemas[SchemaName.UpdateSubscriptionInput] as { required?: string[] };
    expect(update.required ?? []).not.toContain('timing');
  });

  it('uses the input form for schemas that request bodies point at', () => {
    // CreateSubscriptionInput embeds CreatePlanInput; its currency default must stay optional there too.
    const subscription = JSON.stringify(doc.components.schemas[SchemaName.CreateSubscriptionInput]);
    expect(subscription).toContain(SchemaName.CreatePlanInput);
    expect((doc.components.schemas[SchemaName.CreatePlanInput] as { required?: string[] }).required).not.toContain('currency');
  });

  it('documents the raw webhook as an unauthenticated route with a body', () => {
    const operation = operationOf(ApiPath.Webhooks, HttpMethod.Post);
    expect(operation.security).toEqual([]);
    expect(operation.requestBody).toBeDefined();
    const responses = operation.responses as Record<string, Json>;
    expect(responses['200']).toBeDefined();
    expect(responses['401']).toBeDefined();
  });

  it('is plain JSON and stable between builds', () => {
    const first = JSON.stringify(buildOpenApiDocument());
    expect(JSON.parse(first)).toBeTruthy();
    expect(JSON.stringify(buildOpenApiDocument())).toBe(first);
  });

  it('does not let a caller mutate the cached schemas', () => {
    const copy = buildOpenApiDocument();
    delete copy.components.schemas[SchemaName.Plan];
    expect(buildOpenApiDocument().components.schemas[SchemaName.Plan]).toBeDefined();
  });
});
