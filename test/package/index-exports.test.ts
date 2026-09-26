import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as main from '../../src/index.js';
import * as server from '../../src/server-entry.js';
import * as cashfreeConstants from '../../src/providers/cashfree/constants.js';
import * as payuConstants from '../../src/providers/payu/constants.js';
import * as razorpayConstants from '../../src/providers/razorpay/constants.js';
import { ProviderSchema } from '../../src/schemas.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)['"]([^'"]+)['"]/g;

/** Every source file reachable from `entry` through relative imports, with the specifiers each uses. */
function closure(entry: string): Map<string, string[]> {
  const files = new Map<string, string[]>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    const specifiers = [...readFileSync(file, 'utf8').matchAll(SPECIFIER)].map((m) => m[1] as string);
    files.set(file, specifiers);
    for (const specifier of specifiers) {
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier.replace(/\.js$/, '.ts'));
      if (!existsSync(target)) throw new Error(`${file} imports ${specifier}, which does not exist`);
      queue.push(target);
    }
  }
  return files;
}

describe('the main entry', () => {
  it('exports the client, errors, provider contract, factories, scheduler, schema registry and helpers by name', () => {
    const expected = [
      // client
      'createSubscriptions', 'Subscriptions',
      // shared constants and schemas
      'Provider', 'ErrorCode', 'SubscriptionStatus', 'EventType', 'Environment', 'ProviderSchema', 'SubscriptionSchema',
      'CreateSubscriptionInputSchema', 'SubscriptionEventSchema', 'CapabilitiesSchema',
      // errors
      'SubscriptionError', 'isSubscriptionError', 'parseInput', 'parseResponse', 'unsupported', 'invalid',
      // custom gateway adapters
      'BaseProvider', 'HttpClient', 'assertSignature', 'sha256Hmac', 'safeEqual',
      // gateways
      'razorpay', 'RazorpayProvider', 'RazorpayConfigSchema',
      'cashfree', 'CashfreeProvider', 'CashfreeConfigSchema',
      'payu', 'PayUProvider', 'PayUConfigSchema', 'encodePayUSubscriptionId', 'decodePayUSubscriptionId',
      'RazorpayApi', 'CashfreeApi', 'PayUApi',
      // scheduler
      'BillingScheduler', 'MemorySchedulerStore', 'ScheduleStatus', 'CycleStatus', 'SchedulerEventType',
      'ScheduleRecordSchema', 'CycleRecordSchema', 'TickResultSchema', 'scheduleIdFor', 'awaitsActivation',
      // events webhook
      'createEventsForwarder', 'createSchedulerEventsRelay', 'verifyEventsSignature', 'signEventsBody', 'EventsHeader',
      'EventsDeliveryKind', 'EventsDeliverySchema', 'GatewayEventsDeliverySchema', 'SchedulerEventsDeliverySchema', 'schedulerEventId',
      // schema registry
      'SchemaName', 'schemaRegistry', 'namedSchema', 'exportJsonSchemas',
      // money and time
      'paiseToRupeeString', 'paiseToRupeeNumber', 'rupeesToPaise', 'toPaiseOrUndefined', 'assertPaise',
      'toIstIso', 'addDays', 'cycleStart', 'toIso', 'parseIso',
      'PACKAGE_VERSION',
    ];
    const missing = expected.filter((name) => !(name in main));
    expect(missing).toEqual([]);
  });

  it('keeps each gateway\'s constants behind its namespace, so same-named constants cannot collide', () => {
    for (const [namespace, module] of [
      [main.RazorpayApi, razorpayConstants],
      [main.CashfreeApi, cashfreeConstants],
      [main.PayUApi, payuConstants],
    ] as const) {
      expect(Object.keys(namespace).sort()).toEqual(Object.keys(module).sort());
      const leaked = Object.keys(module).filter((name) => name in main);
      expect(leaked).toEqual([]);
    }
    // Should the gateways ever reuse a constant name (they did, e.g. SUBSCRIPTION_STATUS_MAP), each stays its own object.
    const shared = Object.keys(razorpayConstants).filter((name) => name in cashfreeConstants && name in payuConstants);
    for (const name of shared) {
      const values = [main.RazorpayApi, main.CashfreeApi, main.PayUApi].map((ns) => (ns as Record<string, unknown>)[name]);
      expect(new Set(values).size).toBe(3);
    }
  });

  it('is one object per gateway: the factory builds the provider class', () => {
    const rzp = main.razorpay({ keyId: 'k', keySecret: 's' });
    expect(rzp).toBeInstanceOf(main.RazorpayProvider);
    expect(rzp).toBeInstanceOf(main.BaseProvider);
    expect(main.cashfree({ clientId: 'c', clientSecret: 's', environment: 'test' })).toBeInstanceOf(main.CashfreeProvider);
    expect(main.payu({ key: 'k', salt: 's', environment: 'test' })).toBeInstanceOf(main.PayUProvider);
    expect(main.createSubscriptions({ providers: [rzp] }).providers).toEqual(['razorpay']);
  });

  it('registers the published schemas when it is imported', () => {
    expect(main.schemaRegistry.get(ProviderSchema)?.id).toBe(main.SchemaName.Provider);
  });

  it('never reaches node:http, the server, the CLI, the file store or the browser code', () => {
    const graph = closure(join(ROOT, 'src/index.ts'));
    const names = [...graph.keys()].map((file) => file.slice(ROOT.length + 1));
    expect(names).not.toContain('src/server/node.ts');
    expect(names.filter((name) => /^src\/(server|checkout)\//.test(name))).toEqual([]);
    for (const own of ['server-entry', 'cli', 'bin', 'service', 'service-config', 'scheduler-file-store']) {
      expect(names).not.toContain(`src/${own}.ts`);
    }
    const httpUsers = [...graph].filter(([, specifiers]) => specifiers.some((s) => /^(node:)?https?$/.test(s)));
    expect(httpUsers.map(([file]) => file)).toEqual([]);
  });
});

describe('the server entry', () => {
  it('exports the HTTP service, the file store and the pieces serve is made of', () => {
    for (const name of [
      'createHandler', 'createNodeServer', 'listen', 'buildOpenApiDocument', 'routes',
      'FileSchedulerStore', 'EnvVar', 'parseServiceEnv', 'buildService', 'runServe', 'createTickLoop',
    ]) {
      expect(server, name).toHaveProperty(name);
    }
  });
});
