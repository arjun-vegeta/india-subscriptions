import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ChooseAlternativeInputSchema,
  CompletePurchaseInputSchema,
  EntitlementItemSchema,
  EntitlementRecordSchema,
  EntitlementStatusSchema,
  EntitlementsSchema,
  FlushOptionsSchema,
  FlushResultSchema,
  PlatformPolicySchema,
  ProductSchema,
  PurchaseOptionSchema,
  PurchaseSessionRecordSchema,
  PurchaseSessionSchema,
  ReportRecordSchema,
  SessionStatusSchema,
  StartPurchaseInputSchema,
} from '../../src/purchase/index.js';
import { CUSTOMER, MONTHLY } from './helpers.js';

interface JsonNode {
  description?: string;
  properties?: Record<string, JsonNode>;
  items?: JsonNode;
  additionalProperties?: JsonNode | boolean;
  anyOf?: JsonNode[];
  allOf?: JsonNode[];
}

/** Every property, at any depth, must have a description: the schemas are published in the OpenAPI document. */
function undocumented(node: JsonNode, path: string): string[] {
  const missing: string[] = [];
  for (const [name, child] of Object.entries(node.properties ?? {})) {
    const here = `${path}.${name}`;
    if (!child.description) missing.push(here);
    missing.push(...undocumented(child, here));
  }
  if (node.items) missing.push(...undocumented(node.items, `${path}[]`));
  if (typeof node.additionalProperties === 'object') missing.push(...undocumented(node.additionalProperties, `${path}{}`));
  for (const branch of [...(node.anyOf ?? []), ...(node.allOf ?? [])]) missing.push(...undocumented(branch, path));
  return missing;
}

describe('purchase schemas', () => {
  const published = {
    ProductSchema,
    PlatformPolicySchema,
    PurchaseOptionSchema,
    PurchaseSessionSchema,
    PurchaseSessionRecordSchema,
    EntitlementItemSchema,
    EntitlementsSchema,
    EntitlementRecordSchema,
    ReportRecordSchema,
    FlushOptionsSchema,
    FlushResultSchema,
    StartPurchaseInputSchema,
    ChooseAlternativeInputSchema,
    CompletePurchaseInputSchema,
    SessionStatusSchema,
    EntitlementStatusSchema,
  };

  it.each(Object.entries(published))('%s describes the schema and every field', (_name, schema) => {
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonNode;
    expect(json.description, 'the schema itself').toBeTruthy();
    expect(undocumented(json, '$')).toEqual([]);
  });

  it('a product needs a key, kind, name and positive amount', () => {
    expect(ProductSchema.safeParse(MONTHLY).success).toBe(true);
    expect(ProductSchema.safeParse({ ...MONTHLY, amount: 0 }).success).toBe(false);
    expect(ProductSchema.safeParse({ ...MONTHLY, key: '' }).success).toBe(false);
    expect(ProductSchema.safeParse({ ...MONTHLY, taxRateBps: -1 }).success).toBe(false);
    expect(ProductSchema.safeParse({ ...MONTHLY, trialDays: 0 }).success).toBe(false);
  });

  it('a start input checks the reference against what every gateway takes', () => {
    const base = { platform: 'web', product: 'p', customer: CUSTOMER, customerRef: 'c' };
    expect(StartPurchaseInputSchema.safeParse({ ...base, reference: 'ok_ref-1' }).success).toBe(true);
    expect(StartPurchaseInputSchema.safeParse({ ...base, reference: 'a'.repeat(26) }).success).toBe(false);
    expect(StartPurchaseInputSchema.safeParse({ ...base, reference: 'bad ref' }).success).toBe(false);
    expect(StartPurchaseInputSchema.safeParse({ ...base, platform: 'tv' }).success).toBe(false);
  });

  it('the public session has no customer details', () => {
    expect(Object.keys(PurchaseSessionSchema.shape)).not.toContain('customer');
    expect(Object.keys(PurchaseSessionRecordSchema.shape)).toContain('customer');
  });
});
