/**
 * Seam 10: everything the README uses is exported from the entry point the README names. The README's own import
 * statements are parsed (not copied), so a README edit that names something missing fails here.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as checkout from '../../src/checkout/index.js';
import * as main from '../../src/index.js';
import * as postgres from '../../src/postgres-entry.js';
import * as server from '../../src/server-entry.js';

const README = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');

const ENTRY_POINTS: Record<string, Record<string, unknown>> = {
  'india-subscriptions': main,
  'india-subscriptions/server': server,
  'india-subscriptions/postgres': postgres,
  'india-subscriptions/checkout': checkout,
};

interface ReadmeImport {
  names: string[];
  from: string;
}

function readmeImports(): ReadmeImport[] {
  const found: ReadmeImport[] = [];
  for (const match of README.matchAll(/import\s*\{([^}]*)\}\s*from\s*'([^']+)'/g)) {
    const names = (match[1] ?? '')
      .split(',')
      .map((name) => name.trim().split(/\s+as\s+/)[0] ?? '')
      .filter(Boolean);
    found.push({ names, from: match[2] as string });
  }
  return found;
}

describe('the README\'s import statements', () => {
  it('there are some, and each names a published entry point', () => {
    const imports = readmeImports();
    expect(imports.length).toBeGreaterThanOrEqual(3);
    for (const entry of imports.filter((item) => item.from.startsWith('india-subscriptions'))) expect(Object.keys(ENTRY_POINTS)).toContain(entry.from);
  });

  it('every name imported from `india-subscriptions`, `/server` and `/checkout` is exported there (types excepted: they have no runtime value)', () => {
    for (const { names, from } of readmeImports()) {
      const entry = ENTRY_POINTS[from];
      if (!entry) continue;
      for (const name of names) expect(Object.keys(entry), `${name} from ${from}`).toContain(name);
    }
  });
});

describe('the names the README mentions in prose and code', () => {
  const inCode = (text: string) => expect(README).toContain(text);

  it('the constants it uses have the members it uses', () => {
    inCode('Provider.Razorpay');
    expect(main.Provider.Razorpay).toBe('razorpay');
    expect(main.IntervalUnit.Month).toBe('month');
    expect(main.EventType.SubscriptionCharged).toBe('subscription.charged');
    expect(main.EventType.SubscriptionHalted).toBe('subscription.halted');
    expect(main.ChangeTiming.AtPeriodEnd).toBe('at_period_end');
    expect(main.CancelMode.AtPeriodEnd).toBe('at_period_end');
    expect(main.Environment.Test).toBe('test');
  });

  it('the facade has every method the README calls', () => {
    const subs = main.createSubscriptions({ providers: [main.razorpay({ keyId: 'k', keySecret: 's' })] });
    for (const method of ['create', 'get', 'pause', 'resume', 'update', 'cancel', 'verifyCheckout', 'tick', 'capabilities'] as const) expect(typeof subs[method], method).toBe('function');
    for (const method of ['list', 'refund', 'get', 'create', 'notify'] as const) expect(typeof subs.charges[method], `charges.${method}`).toBe('function');
    for (const method of ['handle', 'parse'] as const) expect(typeof subs.webhooks[method], `webhooks.${method}`).toBe('function');
  });

  it('"every input and output is a Zod schema you can import", "every status, event and error code is an exported constant"', () => {
    for (const name of ['CreateSubscriptionInputSchema', 'SubscriptionSchema', 'ChargeSchema', 'SubscriptionEventSchema', 'CapabilitiesSchema', 'RefundInputSchema', 'CheckoutVerificationSchema', 'CreateChargeInputSchema']) {
      expect(Object.keys(main), name).toContain(name);
    }
    for (const name of ['SubscriptionStatus', 'EventType', 'ErrorCode', 'ChargeStatus', 'CancelMode']) expect(Object.keys(main), name).toContain(name);
  });

  it('the scheduler pieces the README names: MemorySchedulerStore (main), FileSchedulerStore (server), the SchedulerStore interface (type), SubscriptionError', () => {
    expect(typeof main.MemorySchedulerStore).toBe('function');
    expect(typeof server.FileSchedulerStore).toBe('function');
    expect(typeof main.SubscriptionError).toBe('function');
    inCode('`SchedulerStore`');
    inCode('FileSchedulerStore');
  });

  it('the service is what the README says: createHandler / buildService / runServe in the server entry, none of them in the main entry', () => {
    for (const name of ['createHandler', 'buildService', 'runServe', 'createNodeServer', 'parseServiceEnv']) {
      expect(Object.keys(server), name).toContain(name);
      expect(Object.keys(main), name).not.toContain(name);
    }
  });
});

describe('types the scheduler options need', () => {
  it('SchedulerSettings, the type of createSubscriptions({ scheduler }), is exported from the main entry (checked by the compiler)', () => {
    const settings: import('../../src/index.js').SchedulerSettings = { store: new main.MemorySchedulerStore() };
    expect(settings.store).toBeDefined();
  });
});

describe('app stores, routing and purchases', () => {
  it('the app stores are exported like the gateways: factory, provider class, config schema, constants namespace', () => {
    for (const name of ['appStore', 'AppStoreProvider', 'AppStoreConfigSchema', 'AppStoreApi', 'googlePlay', 'GooglePlayProvider', 'GooglePlayConfigSchema', 'GooglePlayApi']) {
      expect(Object.keys(main), name).toContain(name);
    }
    expect(typeof main.appStore).toBe('function');
    expect(typeof main.googlePlay).toBe('function');
    expect(main.AppStoreApi.AppStoreResultKey.SignedTransaction).toBe('signedTransaction');
    expect(main.GooglePlayApi.GooglePlayResultKey.PurchaseToken).toBe('purchaseToken');
    expect(main.Provider.AppStore).toBe('app_store');
    expect(main.Provider.GooglePlay).toBe('google_play');
  });

  it('the routing module is exported whole: the router, the statistics store, its constants and schemas', () => {
    for (const name of ['Router', 'MemoryRoutingStatsStore', 'RouteExclusion', 'RouteOutcomeKind', 'RouteOutcomeResult', 'CircuitState', 'RouteRequestSchema', 'RoutingDecisionSchema', 'RoutingStrategySchema', 'statsBucketStart']) {
      expect(Object.keys(main), name).toContain(name);
    }
    expect(main.RouteExclusion.Unhealthy).toBe('unhealthy');
  });

  it('the purchase module is exported: sessions, policy, entitlements, the report queue, with its constants', () => {
    for (const name of ['Purchases', 'MemoryPurchaseStore', 'SessionStatus', 'EntitlementStatus', 'ReportKind', 'ReportStatus', 'FlushOutcome', 'ConfigIssue', 'PurchaseIssue', 'ProductSchema', 'PlatformPolicySchema', 'PurchaseSessionSchema', 'EntitlementsSchema', 'StartPurchaseInputSchema', 'FlushResultSchema', 'assertCatalog', 'resolvePolicy', 'splitTax', 'PurchaseApi']) {
      expect(Object.keys(main), name).toContain(name);
    }
    expect(main.SessionStatus.Completed).toBe('completed');
    // Two constants the scheduler already names stay the scheduler's, and the purchase module's are in the namespace.
    expect(main.PurchaseApi.DEFAULT_LOCK_TTL_MS).toBeGreaterThan(0);
    expect(main.PurchaseApi.DEFAULT_SESSION_TTL_MS).toBe(24 * 3_600_000);
  });

  it('the durable purchase store is in the server entry, not the main one', () => {
    expect(typeof server.FilePurchaseStore).toBe('function');
    expect(Object.keys(main)).not.toContain('FilePurchaseStore');
  });

  it('the facade has the router and the purchases, and every route schema is published under a stable name', () => {
    const subs = main.createSubscriptions({ providers: [main.razorpay({ keyId: 'k', keySecret: 's' })], purchases: { catalog: [{ key: 'coins', kind: 'one_time', name: 'Coins', amount: 100 }], store: new main.MemoryPurchaseStore() } });
    expect(subs.router).toBeInstanceOf(main.Router);
    expect(subs.purchases).toBeInstanceOf(main.Purchases);
    for (const name of ['Product', 'PlatformPolicy', 'PurchaseSession', 'Entitlements', 'StartPurchaseInput', 'CompletePurchaseInput', 'FlushResult', 'RouteRequest', 'RoutingDecision', 'RouteOutcome', 'RoutingStrategy']) {
      expect(Object.values(main.SchemaName), name).toContain(name);
    }
  });
});

describe('the PostgreSQL entry point', () => {
  it('exports the three stores and the migration, and none of them is in the main or server entry', () => {
    for (const name of ['PostgresSchedulerStore', 'PostgresPurchaseStore', 'PostgresRoutingStatsStore', 'migratePostgres']) {
      expect(typeof (postgres as Record<string, unknown>)[name], name).toBe('function');
      expect(Object.keys(main), name).not.toContain(name);
      expect(Object.keys(server), name).not.toContain(name);
    }
  });
});
