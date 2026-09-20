import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CheckoutKind, ErrorCode } from '../../src/constants.js';
import { SchemaName, addDiscriminators, exportJsonSchemas, stripSafeIntegerBounds } from '../../src/schema-registry.js';
import {
  HealthStatus,
  SERVER_ERROR_HTTP_STATUS,
  ServerErrorCode,
  ServerSchemaName,
  buildOpenApiDocument,
  routes,
} from '../../src/server/index.js';

/**
 * Guards over the exported OpenAPI document and JSON Schema bundle: the shape
 * code generators depend on. They exist so a new schema cannot silently bring
 * back inline enums, undocumented fields, ambiguous unions, safe-integer
 * bounds or a required `raw`.
 */

type Json = Record<string, unknown>;

const PREFIX = '#/components/schemas/';
const doc = buildOpenApiDocument();
const components = doc.components.schemas;

/**
 * Components that originate in `src/scheduler/schemas.ts`, which does not carry `.describe(...)` text yet.
 * This is the ONE place the property-description guard is relaxed. It must shrink to empty: when the scheduler
 * schemas are described, delete the names here and the guard applies to them too.
 */
const SCHEDULER_COMPONENTS_WITHOUT_DESCRIPTIONS: readonly string[] = [ServerSchemaName.TickResult, ServerSchemaName.TickError];

/** Every schema object under `node`; the keys of a `properties` map are names, not keywords. */
function* schemaNodes(node: unknown): Generator<Json> {
  if (Array.isArray(node)) {
    for (const item of node) yield* schemaNodes(item);
  } else if (node !== null && typeof node === 'object') {
    yield node as Json;
    for (const [key, value] of Object.entries(node)) {
      if (key === 'properties' && value !== null && typeof value === 'object') {
        for (const property of Object.values(value)) yield* schemaNodes(property);
      } else {
        yield* schemaNodes(value);
      }
    }
  }
}

function resolve(document: Json, pointer: string): Json | undefined {
  let current: unknown = document;
  for (const raw of pointer.replace(/^#\//, '').split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (current === null || typeof current !== 'object') return undefined;
    current = (current as Json)[key];
  }
  return current as Json | undefined;
}

describe('named enums', () => {
  it('has no inline enum outside the named enum components (a single-value const is fine)', () => {
    const offenders: string[] = [];
    for (const [name, schema] of Object.entries(components)) {
      const isNamedEnum = Array.isArray(schema.enum);
      for (const node of schemaNodes(schema)) {
        if (!Array.isArray(node.enum)) continue;
        if (node === schema && isNamedEnum) continue;
        if (node.enum.length === 1) continue;
        offenders.push(`${name}: ${JSON.stringify(node.enum)}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('also holds in operation parameters and responses', () => {
    for (const item of Object.values(doc.paths)) {
      for (const operation of Object.values(item)) {
        const { parameters, requestBody, responses } = operation as Json;
        for (const node of schemaNodes([parameters, requestBody, responses])) {
          expect(Array.isArray(node.enum) && node.enum.length > 1, JSON.stringify(node)).toBe(false);
        }
      }
    }
  });

  it('publishes the enums under their own names, and properties reference them', () => {
    const named = ['IntervalUnit', 'CancelMode', 'ChangeTiming', 'CheckoutKind', 'ErrorCode', 'HealthStatus', 'Provider'];
    for (const name of named) expect(Array.isArray(components[name]?.enum), name).toBe(true);
    const ref = (schema: unknown) => (schema as Json).$ref;
    const property = (component: string, ...path: string[]) => {
      let node: unknown = components[component];
      for (const key of path) node = ((node as Json).properties as Json)[key];
      return node;
    };
    expect(ref(property(SchemaName.BillingInterval, 'unit'))).toBe(`${PREFIX}IntervalUnit`);
    expect(ref(property(SchemaName.CancelSubscriptionOptions, 'mode'))).toBe(`${PREFIX}CancelMode`);
    expect(ref(property(SchemaName.UpdateSubscriptionInput, 'timing'))).toBe(`${PREFIX}ChangeTiming`);
    expect(ref(property(ServerSchemaName.ErrorDetail, 'code'))).toBe(`${PREFIX}ErrorCode`);
    expect(ref(property(ServerSchemaName.ErrorDetail, 'provider'))).toBe(`${PREFIX}Provider`);
    expect(ref(property(ServerSchemaName.Health, 'status'))).toBe(`${PREFIX}HealthStatus`);
    expect(ref(property(ServerSchemaName.TickError, 'code'))).toBe(`${PREFIX}LibraryErrorCode`);
  });

  it('ErrorCode lists every library code and every service code, once', () => {
    const expected = [...new Set([...Object.values(ErrorCode), ...Object.values(ServerErrorCode)])].sort();
    expect([...(components[ServerSchemaName.ErrorCode]?.enum as string[])].sort()).toEqual(expected);
    // every code the service maps to a status is one the document can carry
    for (const code of Object.keys(SERVER_ERROR_HTTP_STATUS)) expect(expected).toContain(code);
  });

  it('LibraryErrorCode is exactly the library codes, for TickResult', () => {
    expect([...(components[ServerSchemaName.LibraryErrorCode]?.enum as string[])].sort()).toEqual(
      Object.values(ErrorCode).sort(),
    );
  });

  it('HealthStatus lists the health statuses', () => {
    expect(components[ServerSchemaName.HealthStatus]?.enum).toEqual(Object.values(HealthStatus));
  });
});

describe('CheckoutInstruction', () => {
  const union = components[SchemaName.CheckoutInstruction] as Json;
  const variants = [
    SchemaName.RedirectCheckout,
    SchemaName.FormPostCheckout,
    SchemaName.RazorpayCheckout,
    SchemaName.CashfreeCheckout,
  ];

  it('is a oneOf of the four named variants', () => {
    expect(union.oneOf).toEqual(variants.map((name) => ({ $ref: `${PREFIX}${name}` })));
  });

  it('has a discriminator on kind that maps every CheckoutKind to its component', () => {
    const mapping = (union.discriminator as { mapping: Record<string, string> }).mapping;
    expect(union.discriminator).toMatchObject({ propertyName: 'kind' });
    expect(Object.keys(mapping).sort()).toEqual(Object.values(CheckoutKind).sort());
    expect(mapping[CheckoutKind.Redirect]).toBe(`${PREFIX}RedirectCheckout`);
    expect(mapping[CheckoutKind.FormPost]).toBe(`${PREFIX}FormPostCheckout`);
    expect(mapping[CheckoutKind.RazorpayCheckout]).toBe(`${PREFIX}RazorpayCheckout`);
    expect(mapping[CheckoutKind.CashfreeCheckout]).toBe(`${PREFIX}CashfreeCheckout`);
    for (const [kind, pointer] of Object.entries(mapping)) {
      const variant = resolve(doc as unknown as Json, pointer) as Json;
      expect(((variant.properties as Json).kind as Json).const, pointer).toBe(kind);
    }
  });

  it('gives every oneOf of object variants a discriminator', () => {
    let seen = 0;
    for (const [name, schema] of Object.entries(components)) {
      for (const node of schemaNodes(schema)) {
        if (!Array.isArray(node.oneOf)) continue;
        seen += 1;
        const objectVariants = node.oneOf.every((variant: Json) => {
          const target = typeof variant.$ref === 'string' ? resolve(doc as unknown as Json, variant.$ref) : variant;
          return target?.type === 'object';
        });
        if (objectVariants) expect(node.discriminator, name).toBeDefined();
      }
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('descriptions', () => {
  it('gives every property of every component a non-empty description', () => {
    const missing: string[] = [];
    for (const [name, schema] of Object.entries(components)) {
      if (SCHEDULER_COMPONENTS_WITHOUT_DESCRIPTIONS.includes(name)) continue;
      for (const node of schemaNodes(schema)) {
        for (const [property, definition] of Object.entries((node.properties as Json | undefined) ?? {})) {
          const description = (definition as Json).description;
          if (typeof description !== 'string' || description.trim() === '') missing.push(`${name}.${property}`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it('keeps the exemption list to components that exist (and shrinks it as they get described)', () => {
    for (const name of SCHEDULER_COMPONENTS_WITHOUT_DESCRIPTIONS) expect(components[name], name).toBeDefined();
  });

  it('describes every model component', () => {
    const missing = Object.entries(components)
      .filter(([name]) => !SCHEDULER_COMPONENTS_WITHOUT_DESCRIPTIONS.includes(name) && name !== ServerSchemaName.LibraryErrorCode)
      .filter(([, schema]) => typeof schema.description !== 'string' || schema.description.trim() === '')
      .map(([name]) => name);
    expect(missing).toEqual([]);
  });

  it('describes every operation parameter', () => {
    const missing: string[] = [];
    const names = new Set<string>();
    for (const [path, item] of Object.entries(doc.paths)) {
      for (const [method, operation] of Object.entries(item)) {
        for (const parameter of ((operation.parameters as Json[]) ?? [])) {
          names.add(String(parameter.name));
          const description = parameter.description;
          if (typeof description !== 'string' || description.trim() === '') missing.push(`${method} ${path} ${String(parameter.name)}`);
        }
      }
    }
    expect(missing).toEqual([]);
    expect([...names].sort()).toEqual(['chargeId', 'limit', 'planId', 'provider', 'subscriptionId']);
  });
});

describe('integer bounds', () => {
  it('carries no minimum or maximum that is a safe-integer limit', () => {
    const offenders: string[] = [];
    for (const node of schemaNodes(doc)) {
      for (const keyword of ['minimum', 'maximum']) {
        const bound = node[keyword];
        if (bound === Number.MAX_SAFE_INTEGER || bound === Number.MIN_SAFE_INTEGER) offenders.push(`${keyword}=${bound}`);
      }
    }
    expect(offenders).toEqual([]);
    expect(JSON.stringify(doc)).not.toContain('9007199254740991');
  });

  it('keeps real bounds', () => {
    const count = (components[SchemaName.BillingInterval]?.properties as Json).count as Json;
    expect(count).toMatchObject({ type: 'integer', minimum: 1 });
    expect(count.maximum).toBeUndefined();
    expect(((components[SchemaName.Capabilities]?.properties as Json).merchantChargeLeadHours as Json).minimum).toBe(0);
  });

  it('stripSafeIntegerBounds removes only the safe-integer limits, at any depth', () => {
    const schema = {
      type: 'integer',
      minimum: Number.MIN_SAFE_INTEGER,
      maximum: Number.MAX_SAFE_INTEGER,
      properties: { a: { minimum: 1, maximum: 100 }, b: { items: [{ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }] } },
    };
    expect(stripSafeIntegerBounds(schema)).toEqual({
      type: 'integer',
      properties: { a: { minimum: 1, maximum: 100 }, b: { items: [{ minimum: 0 }] } },
    });
  });
});

describe('raw', () => {
  it('is never required, on any model of any io form', () => {
    for (const io of ['input', 'output'] as const) {
      const { schemas } = exportJsonSchemas({ refPrefix: PREFIX, io });
      for (const node of schemaNodes([schemas, components])) {
        if (Array.isArray(node.required)) expect(node.required).not.toContain('raw');
      }
    }
    // ...but it is still a documented property of the output models
    for (const name of [SchemaName.Plan, SchemaName.Subscription, SchemaName.Charge, SchemaName.Refund, SchemaName.ChargeNotification]) {
      expect((components[name]?.properties as Json).raw, name).toBeDefined();
    }
  });
});

describe('references and ids', () => {
  it('resolves every $ref and has unique operation ids', () => {
    const ids: string[] = [];
    for (const item of Object.values(doc.paths)) for (const operation of Object.values(item)) ids.push(String(operation.operationId));
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(routes.length);
    let refs = 0;
    for (const node of schemaNodes(doc)) {
      if (typeof node.$ref !== 'string') continue;
      refs += 1;
      expect(resolve(doc as unknown as Json, node.$ref), node.$ref).toBeDefined();
    }
    expect(refs).toBeGreaterThan(50);
  });

  it('puts the checkout verification input in the request body and keeps CheckoutResult published', () => {
    const verify = doc.paths['/v1/{provider}/checkout/verify']?.post as Json;
    expect(verify.requestBody).toMatchObject({
      content: { 'application/json': { schema: { $ref: `${PREFIX}${SchemaName.VerifyCheckoutInput}` } } },
    });
    const input = components[SchemaName.VerifyCheckoutInput] as Json;
    expect(input.required).toEqual(['result']);
    expect(Object.keys(input.properties as Json).sort()).toEqual(['expectedSubscriptionId', 'result']);
    expect(((input.properties as Json).result as Json).$ref).toBe(`${PREFIX}${SchemaName.CheckoutResult}`);
    expect(components[SchemaName.CheckoutResult]).toBeDefined();
  });
});

describe('addDiscriminators', () => {
  it('leaves a oneOf that does not discriminate on a constant untouched', () => {
    const schemas: Record<string, Json> = {
      A: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
      B: { type: 'object', properties: { kind: { type: 'string' } }, required: ['kind'] },
      U: { oneOf: [{ $ref: '#/x/A' }, { $ref: '#/x/B' }] },
    };
    addDiscriminators(schemas, '#/x/');
    expect(schemas.U?.discriminator).toBeUndefined();
  });

  it('does not map two variants to the same value', () => {
    const variant = { type: 'object', properties: { kind: { const: 'same' } }, required: ['kind'] };
    const schemas: Record<string, Json> = { A: variant, B: variant, U: { oneOf: [{ $ref: '#/x/A' }, { $ref: '#/x/B' }] } };
    addDiscriminators(schemas, '#/x/');
    expect(schemas.U?.discriminator).toBeUndefined();
  });

  it('maps each constant to its variant', () => {
    const schemas: Record<string, Json> = {
      A: { type: 'object', properties: { type: { const: 'a' } }, required: ['type'] },
      B: { type: 'object', properties: { type: { const: 'b' } }, required: ['type'] },
      U: { oneOf: [{ $ref: '#/x/A' }, { $ref: '#/x/B' }] },
    };
    addDiscriminators(schemas, '#/x/');
    expect(schemas.U?.discriminator).toEqual({ propertyName: 'type', mapping: { a: '#/x/A', b: '#/x/B' } });
  });
});

describe('the JSON Schema bundle (openapi/schemas.json)', () => {
  const bundle = exportJsonSchemas({ refPrefix: '#/$defs/', io: 'output' }).schemas;

  it('is plain JSON Schema: refs resolve within $defs, no OpenAPI discriminator', () => {
    const root = { $defs: bundle } as Json;
    for (const node of schemaNodes(bundle)) {
      expect(node.discriminator).toBeUndefined();
      if (typeof node.$ref === 'string') expect(resolve(root, node.$ref), node.$ref).toBeDefined();
    }
    expect(JSON.stringify(bundle)).not.toContain('9007199254740991');
  });

  it('carries the named enums and checkout variants', () => {
    for (const name of ['IntervalUnit', 'CancelMode', 'ChangeTiming', 'CheckoutKind', 'RedirectCheckout', 'CashfreeCheckout']) {
      expect(bundle[name], name).toBeDefined();
    }
  });
});

describe('the committed openapi/ files', () => {
  const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string };
  const read = (file: string) => JSON.parse(readFileSync(new URL(`../../openapi/${file}`, import.meta.url), 'utf8')) as unknown;

  it('openapi.json is what `npm run openapi` generates now', () => {
    expect(read('openapi.json')).toEqual(JSON.parse(JSON.stringify(buildOpenApiDocument({ version: pkg.version }))));
  });

  it('schemas.json is what `npm run openapi` generates now', () => {
    expect((read('schemas.json') as { $defs: unknown }).$defs).toEqual(
      JSON.parse(JSON.stringify(exportJsonSchemas({ refPrefix: '#/$defs/', io: 'output' }).schemas)),
    );
  });
});
