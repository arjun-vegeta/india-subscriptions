import { createHash, createHmac } from 'node:crypto';
import { z } from 'zod';
import { buildOpenApiDocument } from '../../src/server/openapi.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Subscriptions, createSubscriptions } from '../../src/client.js';
import { ContentType, Environment, ErrorCode, HttpMethod } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { FetchLike } from '../../src/http.js';
import type { SubscriptionProvider } from '../../src/provider.js';
import { cashfree, type CashfreeProvider } from '../../src/providers/cashfree/index.js';
import { payu, type PayUProvider } from '../../src/providers/payu/index.js';
import { razorpay, type RazorpayProvider } from '../../src/providers/razorpay/index.js';
import { MemorySchedulerStore, type CycleRecord, type ScheduleRecord, type SchedulerEvent } from '../../src/scheduler/index.js';
import type { SchedulerStore } from '../../src/scheduler/store.js';
import type { RecordedCall } from '../helpers/mock-fetch.js';

// ---------------------------------------------------------------------------
// A controllable clock
// ---------------------------------------------------------------------------

export const HOUR_MS = 3_600_000;
export const DAY_MS = 24 * HOUR_MS;

export class Clock {
  private ms: number;
  constructor(iso: string) {
    this.ms = Date.parse(iso);
  }
  readonly now = (): Date => new Date(this.ms);
  readonly nowMs = (): number => this.ms;
  set(iso: string): void {
    this.ms = Date.parse(iso);
  }
  advanceHours(hours: number): void {
    this.ms += hours * HOUR_MS;
  }
  iso(): string {
    return new Date(this.ms).toISOString();
  }
}

export function plusHours(iso: string, hours: number): string {
  return new Date(Date.parse(iso) + hours * HOUR_MS).toISOString();
}

export function plusDays(iso: string, days: number): string {
  return plusHours(iso, days * 24);
}

// ---------------------------------------------------------------------------
// Fixtures: the documentation's sample payloads live in the adapters' own tests as template literals.
// They are read from those files (verbatim) instead of being copied, so a fixture cannot drift from its source.
// ---------------------------------------------------------------------------

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The text of `const NAME = String.raw\`...\`;` (or a plain template literal) in a test file, exactly as written. */
export function fixtureText(testFile: string, name: string): string {
  const source = readFileSync(`${REPO_ROOT}${testFile}`, 'utf8');
  const start = new RegExp(`const ${name} = (?:String\\.raw)?\``).exec(source);
  if (!start) throw new Error(`fixture ${name} not found in ${testFile}`);
  const from = start.index + start[0].length;
  const end = source.indexOf('`;', from);
  if (end < 0) throw new Error(`fixture ${name} in ${testFile} is not terminated`);
  return source.slice(from, end);
}

export function fixtureJson<T = Record<string, any>>(testFile: string, name: string): T {
  return JSON.parse(fixtureText(testFile, name)) as T;
}

export const RAZORPAY_ADAPTER_TEST = 'test/razorpay/adapter.test.ts';
export const RAZORPAY_WEBHOOK_TEST = 'test/razorpay/webhook.test.ts';
export const CASHFREE_ADAPTER_TEST = 'test/cashfree/adapter.test.ts';
export const CASHFREE_WEBHOOK_TEST = 'test/cashfree/webhooks.test.ts';

/**
 * A const object literal (`const NAME = { ... };`) of a test file, evaluated. Used for Cashfree's JS-object fixtures.
 */
export function fixtureObject<T = Record<string, any>>(testFile: string, name: string): T {
  const source = readFileSync(`${REPO_ROOT}${testFile}`, 'utf8');
  const start = new RegExp(`const ${name} = `).exec(source);
  if (!start) throw new Error(`fixture ${name} not found in ${testFile}`);
  const from = start.index + start[0].length;
  const end = source.indexOf('\n};', from);
  const literal = source.slice(from, end + 3).replace(/;$/, '');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`return (${literal})`)() as T;
}

// ---------------------------------------------------------------------------
// Scripted fetch: a stateful fake gateway answers by what was requested
// ---------------------------------------------------------------------------

export interface Reply {
  status?: number;
  json?: unknown;
  text?: string;
  /** Drop the connection instead of answering. */
  networkError?: boolean;
}

export type Responder = (call: RecordedCall) => Reply | Promise<Reply>;

export function scriptedFetch(respond: Responder): { fetch: FetchLike; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers as HeadersInit | undefined).forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    const body = typeof init.body === 'string' ? init.body : undefined;
    const call: RecordedCall = { method, url, headers, body };
    if (body !== undefined) {
      try {
        call.json = JSON.parse(body);
      } catch {
        call.form = Object.fromEntries(new URLSearchParams(body));
      }
    }
    calls.push(call);
    const reply = await respond(call);
    if (reply.networkError) throw new TypeError('fetch failed');
    const text = reply.json !== undefined ? JSON.stringify(reply.json) : (reply.text ?? '');
    return new Response(text, { status: reply.status ?? 200, headers: { 'content-type': ContentType.Json } });
  };
  return { fetch, calls };
}

/** The path and query of a URL, minus a base path (Cashfree's `/pg`) so it can be compared with the adapter's endpoint constants. */
export function pathOf(url: string, basePath = ''): string {
  const parsed = new URL(url);
  const path = `${parsed.pathname}${parsed.search}`;
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) : path;
}

/** `METHOD /path` for each call: the exact sequence of gateway calls. */
export function sequence(calls: RecordedCall[], basePath = ''): string[] {
  return calls.map((call) => `${call.method} ${pathOf(call.url, basePath)}`);
}

export const CASHFREE_BASE_PATH = '/pg';

// ---------------------------------------------------------------------------
// Signatures, computed independently of the library
// ---------------------------------------------------------------------------

export function hmacHex(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

export function hmacBase64(secret: string, payload: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('base64');
}

export function sha512Hex(payload: string): string {
  return createHash('sha512').update(payload, 'utf8').digest('hex');
}

export const RazorpayWire = {
  SignatureHeader: 'x-razorpay-signature',
  EventIdHeader: 'x-razorpay-event-id',
} as const;

export const CashfreeWire = {
  SignatureHeader: 'x-webhook-signature',
  TimestampHeader: 'x-webhook-timestamp',
  /** The format of this header is undocumented; any string signs the same way. */
  Timestamp: '1754550000000',
} as const;

export function razorpayWebhookRequest(rawBody: string, secret: string, eventId?: string) {
  return {
    rawBody,
    headers: {
      [RazorpayWire.SignatureHeader]: hmacHex(secret, rawBody),
      ...(eventId ? { [RazorpayWire.EventIdHeader]: eventId } : {}),
    },
  };
}

export function cashfreeWebhookRequest(rawBody: string, secret: string) {
  return {
    rawBody,
    headers: {
      [CashfreeWire.SignatureHeader]: hmacBase64(secret, CashfreeWire.Timestamp + rawBody),
      [CashfreeWire.TimestampHeader]: CashfreeWire.Timestamp,
    },
  };
}

/** `salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key`, as PayU documents it. */
export function payuReverseHash(fields: Record<string, string>, key: string, salt: string): string {
  const f = (name: string): string => fields[name] ?? '';
  const prefix = f('additional_charges') ? `${f('additional_charges')}|` : '';
  return sha512Hex(
    `${prefix}${salt}|${f('status')}||||||${f('udf5')}|${f('udf4')}|${f('udf3')}|${f('udf2')}|${f('udf1')}|${f('email')}|${f('firstname')}|${f('productinfo')}|${f('amount')}|${f('txnid')}|${key}`,
  );
}

export function signedPayuForm(fields: Record<string, string>, key: string, salt: string): Record<string, string> {
  return { ...fields, hash: payuReverseHash(fields, key, salt) };
}

// ---------------------------------------------------------------------------
// Gateway accounts used throughout the integration tests
// ---------------------------------------------------------------------------

export const RAZORPAY_ACCOUNT = { keyId: 'rzp_test_key', keySecret: 'rzp_test_secret_value', webhookSecret: 'rzp_whsec_value' };
export const CASHFREE_ACCOUNT = {
  clientId: 'cf_client_id',
  clientSecret: 'cf_client_secret_value',
  webhookSecret: 'cf_whsec_value',
  environment: Environment.Test,
};
export const PAYU_ACCOUNT = {
  key: 'BmTY3G',
  salt: 'integration-salt-never-a-real-salt',
  environment: Environment.Test,
  successUrl: 'https://merchant.example/payu/return',
  failureUrl: 'https://merchant.example/payu/return',
};

export const CUSTOMER = { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' };

export interface Wired {
  subs: Subscriptions;
  clock: Clock;
  store: CountingStore;
  provider: SubscriptionProvider;
  calls: RecordedCall[];
}

export function razorpayProvider(fetch: FetchLike, clock: Clock): RazorpayProvider {
  return razorpay(RAZORPAY_ACCOUNT, { fetch, now: clock.now, maxRetries: 0 });
}

export function cashfreeProvider(fetch: FetchLike, clock: Clock): CashfreeProvider {
  return cashfree(CASHFREE_ACCOUNT, { fetch, now: clock.now, maxRetries: 0 });
}

export function payuProvider(fetch: FetchLike, clock: Clock): PayUProvider {
  return payu(PAYU_ACCOUNT, { fetch, now: clock.now, maxRetries: 0 });
}

/** A store that counts every call, so "no scheduler was involved" is a measurement. */
export class CountingStore implements SchedulerStore {
  readonly inner: MemorySchedulerStore;
  readonly calls: string[] = [];
  constructor(now: () => number) {
    this.inner = new MemorySchedulerStore({ now });
  }
  private note<T>(name: string, value: T): T {
    this.calls.push(name);
    return value;
  }
  getSchedule(id: string) { return this.note('getSchedule', this.inner.getSchedule(id)); }
  saveSchedule(schedule: ScheduleRecord) { return this.note('saveSchedule', this.inner.saveSchedule(schedule)); }
  findBySubscriptionId(provider: Parameters<SchedulerStore['findBySubscriptionId']>[0], id: string) {
    return this.note('findBySubscriptionId', this.inner.findBySubscriptionId(provider, id));
  }
  listDueSchedules(at: string, limit: number) { return this.note('listDueSchedules', this.inner.listDueSchedules(at, limit)); }
  getCycle(scheduleId: string, index: number) { return this.note('getCycle', this.inner.getCycle(scheduleId, index)); }
  saveCycle(cycle: CycleRecord) { return this.note('saveCycle', this.inner.saveCycle(cycle)); }
  listCycles(scheduleId: string) { return this.note('listCycles', this.inner.listCycles(scheduleId)); }
  acquireLock(id: string, ttlMs: number) { return this.note('acquireLock', this.inner.acquireLock(id, ttlMs)); }
  releaseLock(id: string, token: string) { return this.note('releaseLock', this.inner.releaseLock(id, token)); }
}

export function wire(
  provider: SubscriptionProvider,
  clock: Clock,
  calls: RecordedCall[],
  onEvent?: (event: SchedulerEvent) => void,
): Wired {
  const store = new CountingStore(clock.nowMs);
  const subs = createSubscriptions({ providers: [provider], scheduler: { store, now: clock.now, ...(onEvent ? { onEvent } : {}) } });
  return { subs, clock, store, provider, calls };
}

export async function rejection(run: () => unknown): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof SubscriptionError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with a SubscriptionError');
}

export function expectCode(error: SubscriptionError, code: ErrorCode): void {
  if (error.code !== code) throw new Error(`expected ${code}, got ${error.code}: ${error.message}`);
}

export { HttpMethod };


// ---------------------------------------------------------------------------
// The published OpenAPI schemas, turned into validators (what a generated client would be built from)
// ---------------------------------------------------------------------------

interface OpenApiOperation {
  operationId: string;
  requestBody?: { content: Record<string, { schema: unknown }> };
  responses: Record<string, { content?: Record<string, { schema: unknown }> }>;
}

let publishedDocument: { paths: Record<string, Record<string, OpenApiOperation>>; components: { schemas: Record<string, unknown> } } | undefined;

function document() {
  publishedDocument ??= buildOpenApiDocument({ serverUrl: '/' }) as unknown as NonNullable<typeof publishedDocument>;
  return publishedDocument;
}

/** A Zod validator for a JSON schema (or `$ref`) taken from the OpenAPI document. */
function validatorFor(schema: unknown): z.ZodType {
  const defs = JSON.parse(JSON.stringify(document().components.schemas).replaceAll('#/components/schemas/', '#/$defs/')) as Record<string, unknown>;
  const inline = JSON.parse(JSON.stringify(schema).replaceAll('#/components/schemas/', '#/$defs/')) as Record<string, unknown>;
  return z.fromJSONSchema({ ...inline, $defs: defs } as never);
}

export interface PublishedOperation {
  request?: z.ZodType;
  /** Validators by response status. */
  response: Record<string, z.ZodType>;
}

export function published(operationId: string): PublishedOperation {
  for (const methods of Object.values(document().paths)) {
    for (const operation of Object.values(methods)) {
      if (operation.operationId !== operationId) continue;
      const request = operation.requestBody?.content['application/json']?.schema;
      const response: Record<string, z.ZodType> = {};
      for (const [status, entry] of Object.entries(operation.responses)) {
        const schema = entry.content?.['application/json']?.schema;
        if (schema !== undefined) response[status] = validatorFor(schema);
      }
      return { ...(request !== undefined ? { request: validatorFor(request) } : {}), response };
    }
  }
  throw new Error(`operation ${operationId} is not in the OpenAPI document`);
}
