import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ErrorCode, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import {
  AmountBoundsSchema,
  CircuitStateSchema,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_FAILURE_THRESHOLD,
  DEFAULT_MIN_SAMPLES,
  DEFAULT_PRIOR_SUCCESS_RATE,
  DEFAULT_SUCCESS_WINDOW_HOURS,
  DEFAULT_WEIGHT_COST,
  DEFAULT_WEIGHT_PREFER,
  DEFAULT_WEIGHT_PRIORITY,
  DEFAULT_WEIGHT_SUCCESS_RATE,
  GatewayCostSchema,
  RouteCandidateSchema,
  RouteOutcomeSchema,
  RouteRequestSchema,
  Router,
  RoutingDecisionSchema,
  RoutingStatsKeySchema,
  RoutingStatsTotalsSchema,
  RoutingStrategySchema,
} from '../../src/routing/index.js';
import { ALL_GATEWAYS, SUBSCRIPTION, makeRouter } from './helpers.js';

interface JsonNode {
  description?: string;
  properties?: Record<string, JsonNode>;
  items?: JsonNode;
  additionalProperties?: JsonNode | boolean;
  anyOf?: JsonNode[];
  allOf?: JsonNode[];
  $ref?: string;
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

describe('schemas', () => {
  const published = {
    RouteRequestSchema,
    RouteCandidateSchema,
    RoutingDecisionSchema,
    RouteOutcomeSchema,
    RoutingStatsKeySchema,
    RoutingStatsTotalsSchema,
    RoutingStrategySchema,
    GatewayCostSchema,
    AmountBoundsSchema,
    CircuitStateSchema,
  };

  it.each(Object.entries(published))('%s describes the schema and every field', (_name, schema) => {
    const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JsonNode;
    expect(json.description, 'the schema itself').toBeTruthy();
    expect(undocumented(json, '$')).toEqual([]);
  });

  it('gives the documented defaults for an empty strategy', () => {
    expect(RoutingStrategySchema.parse({})).toEqual({
      weights: {
        successRate: DEFAULT_WEIGHT_SUCCESS_RATE,
        cost: DEFAULT_WEIGHT_COST,
        priority: DEFAULT_WEIGHT_PRIORITY,
        prefer: DEFAULT_WEIGHT_PREFER,
      },
      successRate: {
        windowHours: DEFAULT_SUCCESS_WINDOW_HOURS,
        minSamples: DEFAULT_MIN_SAMPLES,
        priorRate: DEFAULT_PRIOR_SUCCESS_RATE,
        kinds: { subscription: ['authorization', 'charge'], one_time: ['payment'] },
      },
      costs: {},
      defaultCost: { percentBps: 0, fixedPaise: 0 },
      priority: [],
      limits: {},
      circuitBreaker: { failureThreshold: DEFAULT_FAILURE_THRESHOLD, cooldownMs: DEFAULT_COOLDOWN_MS },
    });
    expect([DEFAULT_WEIGHT_SUCCESS_RATE, DEFAULT_WEIGHT_COST, DEFAULT_WEIGHT_PRIORITY, DEFAULT_WEIGHT_PREFER]).toEqual([1, 1, 0.02, 0.05]);
    expect([DEFAULT_SUCCESS_WINDOW_HOURS, DEFAULT_MIN_SAMPLES, DEFAULT_PRIOR_SUCCESS_RATE]).toEqual([24, 20, 0.9]);
  });

  it('fills the unset fields of a partial strategy', () => {
    const strategy = RoutingStrategySchema.parse({ weights: { cost: 3 }, successRate: { minSamples: 5 }, circuitBreaker: { cooldownMs: 1000 } });
    expect(strategy.weights).toMatchObject({ cost: 3, successRate: DEFAULT_WEIGHT_SUCCESS_RATE });
    expect(strategy.successRate).toMatchObject({ minSamples: 5, windowHours: DEFAULT_SUCCESS_WINDOW_HOURS });
    expect(strategy.circuitBreaker).toEqual({ failureThreshold: DEFAULT_FAILURE_THRESHOLD, cooldownMs: 1000 });
  });

  it.each([
    ['a minimum above the maximum', { limits: { [Provider.Razorpay]: { minAmount: 500, maxAmount: 100 } } }],
    ['a negative weight', { weights: { cost: -1 } }],
    ['a prior above 1', { successRate: { priorRate: 1.5 } }],
    ['a zero threshold', { circuitBreaker: { failureThreshold: 0 } }],
    ['a fractional fee', { costs: { [Provider.Razorpay]: { percentBps: 1.5, fixedPaise: 0 } } }],
    ['an unknown provider in the priority list', { priority: ['stripe'] }],
  ])('rejects a strategy with %s', (_label, strategy) => {
    expect(() => new Router({ capabilities: () => ALL_GATEWAYS, strategy: strategy as never })).toThrow(SubscriptionError);
    try {
      new Router({ capabilities: () => ALL_GATEWAYS, strategy: strategy as never });
    } catch (error) {
      expect((error as SubscriptionError).code).toBe(ErrorCode.Validation);
    }
  });

  it('validates a request', () => {
    expect(RouteRequestSchema.safeParse(SUBSCRIPTION).success).toBe(true);
    expect(RouteRequestSchema.safeParse({ ...SUBSCRIPTION, amount: 10.5 }).success).toBe(false);
    expect(RouteRequestSchema.safeParse({ ...SUBSCRIPTION, kind: 'lease' }).success).toBe(false);
    expect(RouteRequestSchema.safeParse({ ...SUBSCRIPTION, prefer: 'stripe' }).success).toBe(false);
    expect(RouteRequestSchema.safeParse({ ...SUBSCRIPTION, needs: { pause: 'yes' } }).success).toBe(false);
    expect(RouteRequestSchema.safeParse({ ...SUBSCRIPTION, interval: { unit: 'month', count: 1 } }).success).toBe(true);
  });

  it('produces decisions that validate against their own schema', async () => {
    const { router } = makeRouter();
    const decision = await router.route({ ...SUBSCRIPTION, prefer: Provider.Razorpay, interval: { unit: 'month', count: 1 } });
    expect(RoutingDecisionSchema.safeParse(decision).success).toBe(true);
    expect(JSON.parse(JSON.stringify(decision))).toEqual(decision);
  });
});
