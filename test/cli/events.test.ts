import { createHmac } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { ChargeStatus, ErrorCode, EventType, Provider } from '../../src/constants.js';
import {
  EventsDeliveryKind,
  EventsDeliverySchema,
  schedulerEventId,
  toSchedulerWebhookEvent,
} from '../../src/events-envelope.js';
import {
  DEFAULT_TOLERANCE_SECONDS,
  EventsHeader,
  createEventsForwarder,
  createSchedulerEventsRelay,
  signEventsBody,
  verifyEventsSignature,
  type EventsLog,
} from '../../src/events-webhook.js';
import { SubscriptionError } from '../../src/errors.js';
import type { SubscriptionEvent } from '../../src/schemas.js';
import { ScheduleStatus, SchedulerEventType, type SchedulerEvent } from '../../src/scheduler/index.js';
import { ServerSchemaName, buildOpenApiDocument } from '../../src/server/index.js';
import { mockFetch } from '../helpers/mock-fetch.js';

const URL_WITH_TOKEN = 'https://hooks.example.com/in/path-token-123?key=query-secret-456';
const SECRET = 'events-shared-secret';
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);
const NOW_SECONDS = Math.floor(NOW / 1000);

const event = (id: string): SubscriptionEvent => ({
  id,
  type: EventType.SubscriptionActivated,
  provider: Provider.Razorpay,
  occurredAt: '2026-01-02T03:04:05.000Z',
  providerEventType: 'subscription.activated',
  raw: {},
}) as SubscriptionEvent;

const schedulerEvent = (overrides: Partial<SchedulerEvent> = {}): SchedulerEvent => ({
  type: SchedulerEventType.ChargeSucceeded,
  at: '2026-01-15T04:30:00.000Z',
  scheduleId: 'payu:order-1',
  provider: Provider.PayU,
  subscriptionId: 'sub_1',
  scheduleStatus: ScheduleStatus.Active,
  cycleIndex: 0,
  attempt: 1,
  chargeId: 'c_abc',
  amount: 49900,
  ...overrides,
});

/** The signature, computed independently of the library: HMAC-SHA256 over `<timestamp>.<body>`, hex. */
const independentSignature = (timestamp: string, body: string): string =>
  createHmac('sha256', SECRET).update(`${timestamp}.${body}`, 'utf8').digest('hex');

async function failureOf(run: Promise<unknown>): Promise<SubscriptionError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SubscriptionError);
  return error as SubscriptionError;
}

describe('gateway events forwarder', () => {
  it('POSTs a `gateway` envelope, signed over "<timestamp>.<exact body>"', async () => {
    const mock = mockFetch([{ url: URL_WITH_TOKEN, status: 202 }]);
    const forward = createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: mock.fetch, now: () => NOW });
    await forward(Provider.Razorpay, [event('evt_1'), event('evt_2')]);

    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(URL_WITH_TOKEN);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers[EventsHeader.Timestamp]).toBe(String(NOW_SECONDS));
    expect(call.headers[EventsHeader.Signature]).toBe(independentSignature(String(NOW_SECONDS), call.body as string));
    expect(call.json).toEqual({
      kind: 'gateway',
      provider: Provider.Razorpay,
      events: [event('evt_1'), event('evt_2')],
    });
    expect(EventsDeliverySchema.safeParse(call.json).success).toBe(true);
  });

  it('uses the documented header names and kind values', () => {
    expect(EventsHeader.Signature).toBe('x-india-subscriptions-signature');
    expect(EventsHeader.Timestamp).toBe('x-india-subscriptions-timestamp');
    expect(EventsDeliveryKind).toEqual({ Gateway: 'gateway', Scheduler: 'scheduler' });
  });

  it('sends nothing for an empty batch', async () => {
    const mock = mockFetch([]);
    await createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: mock.fetch })(Provider.PayU, []);
    expect(mock.calls).toHaveLength(0);
  });

  it.each([400, 404, 500, 503, 302])('fails on HTTP %i, so the gateway retries', async (status) => {
    const mock = mockFetch([{ url: URL_WITH_TOKEN, status }]);
    const forward = createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: mock.fetch });
    const error = await failureOf(forward(Provider.Razorpay, [event('evt_1')]));
    expect(error.httpStatus).toBe(status);
    expect(error.message).toContain(`HTTP ${status}`);
  });

  it('fails when the endpoint cannot be reached', async () => {
    const mock = mockFetch([{ url: URL_WITH_TOKEN, networkError: true }]);
    const forward = createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: mock.fetch });
    expect((await failureOf(forward(Provider.Razorpay, [event('evt_1')]))).code).toBe(ErrorCode.Network);
  });

  it('fails when the endpoint does not answer in time', async () => {
    const hang = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const forward = createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: hang, timeoutMs: 20 });
    expect((await failureOf(forward(Provider.Razorpay, [event('evt_1')]))).code).toBe(ErrorCode.Timeout);
  });

  it('never puts the secret, or the URL path and query, in an error', async () => {
    for (const route of [{ status: 500 }, { networkError: true }]) {
      const mock = mockFetch([{ url: URL_WITH_TOKEN, ...route }]);
      const forward = createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: mock.fetch });
      const error = await failureOf(forward(Provider.Razorpay, [event('evt_1')]));
      for (const leaked of [SECRET, 'path-token-123', 'query-secret-456']) {
        expect(error.message).not.toContain(leaked);
        expect(JSON.stringify(error.toJSON())).not.toContain(leaked);
      }
      expect(error.message).toContain('https://hooks.example.com');
    }
  });

  it('does not follow redirects', async () => {
    let init: RequestInit | undefined;
    const fetchSpy = async (_url: string, options?: RequestInit): Promise<Response> => {
      init = options;
      return new Response('', { status: 200 });
    };
    await createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: fetchSpy })(Provider.PayU, [event('e')]);
    expect(init?.redirect).toBe('manual');
  });
});

describe('the signature scheme', () => {
  const body = '{"kind":"scheduler","events":[]}';
  const timestamp = String(NOW_SECONDS);
  const headers = (overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
    [EventsHeader.Timestamp]: timestamp,
    [EventsHeader.Signature]: independentSignature(timestamp, body),
    ...overrides,
  });
  const options = { now: () => NOW };
  const verify = (h: Record<string, string | undefined>, b = body, o = options): void =>
    verifyEventsSignature(SECRET, b, h, o);
  const rejection = (run: () => void): SubscriptionError => {
    try {
      run();
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe(ErrorCode.SignatureInvalid);
      return error as SubscriptionError;
    }
    throw new Error('expected SIGNATURE_INVALID');
  };

  it('signs the documented string: the timestamp, a full stop, then the exact body', () => {
    expect(signEventsBody(SECRET, timestamp, body)).toBe(independentSignature(timestamp, body));
    expect(signEventsBody(SECRET, 1767225600, '{"a":1}')).toBe(
      createHmac('sha256', SECRET).update('1767225600.{"a":1}', 'utf8').digest('hex'),
    );
    // The timestamp is part of what is signed.
    expect(signEventsBody(SECRET, '1', body)).not.toBe(signEventsBody(SECRET, '2', body));
    expect(signEventsBody(SECRET, timestamp, body)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts a valid delivery, with plain-object or Headers input, any header case, and the default tolerance', () => {
    expect(() => verify(headers())).not.toThrow();
    expect(() =>
      verifyEventsSignature(SECRET, body, new Headers({ [EventsHeader.Timestamp]: timestamp, [EventsHeader.Signature]: independentSignature(timestamp, body) }), options),
    ).not.toThrow();
    expect(() =>
      verifyEventsSignature(SECRET, body, { 'X-India-Subscriptions-Timestamp': timestamp, 'X-India-Subscriptions-Signature': independentSignature(timestamp, body).toUpperCase() }, options),
    ).not.toThrow();
    expect(DEFAULT_TOLERANCE_SECONDS).toBe(300);
  });

  it('rejects a tampered body, even by one byte of whitespace', () => {
    expect(rejection(() => verify(headers(), `${body} `)).message).toContain('signature does not match');
    expect(() => verify(headers(), body.replace('scheduler', 'gateway'))).toThrow(SubscriptionError);
  });

  it('rejects a tampered timestamp: it is covered by the signature', () => {
    const replayed = headers({ [EventsHeader.Timestamp]: String(NOW_SECONDS + 1) });
    expect(rejection(() => verify(replayed)).message).toContain('signature does not match');
  });

  it('rejects the wrong secret and a truncated or foreign signature', () => {
    expect(() => verifyEventsSignature('other', body, headers(), options)).toThrow(SubscriptionError);
    const good = independentSignature(timestamp, body);
    expect(() => verify(headers({ [EventsHeader.Signature]: good.slice(0, -1) }))).toThrow(SubscriptionError);
    expect(() => verify(headers({ [EventsHeader.Signature]: 'sha256=' + good }))).toThrow(SubscriptionError);
  });

  it('rejects a body-only signature (the old scheme without the timestamp)', () => {
    const bodyOnly = createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');
    expect(() => verify(headers({ [EventsHeader.Signature]: bodyOnly }))).toThrow(SubscriptionError);
  });

  it('rejects a stale timestamp, and accepts one exactly at the tolerance', () => {
    const at = (seconds: number): Record<string, string | undefined> => {
      const ts = String(NOW_SECONDS + seconds);
      return headers({ [EventsHeader.Timestamp]: ts, [EventsHeader.Signature]: independentSignature(ts, body) });
    };
    expect(() => verify(at(-300))).not.toThrow();
    expect(rejection(() => verify(at(-301))).message).toContain('too old');
    expect(() => verify(at(-301), body, { now: () => NOW })).toThrow();
    expect(() => verifyEventsSignature(SECRET, body, at(-301), { now: () => NOW, toleranceSeconds: 600 })).not.toThrow();
  });

  it('rejects a timestamp from the future', () => {
    const ts = String(NOW_SECONDS + 301);
    const future = headers({ [EventsHeader.Timestamp]: ts, [EventsHeader.Signature]: independentSignature(ts, body) });
    expect(rejection(() => verify(future)).message).toContain('in the future');
    const near = String(NOW_SECONDS + 300);
    expect(() => verify(headers({ [EventsHeader.Timestamp]: near, [EventsHeader.Signature]: independentSignature(near, body) }))).not.toThrow();
  });

  it('honours a tighter tolerance', () => {
    const ts = String(NOW_SECONDS - 11);
    const h = headers({ [EventsHeader.Timestamp]: ts, [EventsHeader.Signature]: independentSignature(ts, body) });
    expect(() => verifyEventsSignature(SECRET, body, h, { now: () => NOW, toleranceSeconds: 10 })).toThrow(SubscriptionError);
    expect(() => verifyEventsSignature(SECRET, body, h, { now: () => NOW, toleranceSeconds: 11 })).not.toThrow();
  });

  it('uses the real clock by default', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    expect(() => verifyEventsSignature(SECRET, body, { [EventsHeader.Timestamp]: ts, [EventsHeader.Signature]: independentSignature(ts, body) })).not.toThrow();
    expect(() => verifyEventsSignature(SECRET, body, headers())).toThrow(SubscriptionError); // 2026-01-02 is not now
  });

  it.each([
    ['a missing timestamp', { [EventsHeader.Timestamp]: undefined }, 'timestamp header is missing'],
    ['an empty timestamp', { [EventsHeader.Timestamp]: '  ' }, 'timestamp header is missing'],
    ['a missing signature', { [EventsHeader.Signature]: undefined }, 'signature header is missing'],
    ['an empty signature', { [EventsHeader.Signature]: '' }, 'signature header is missing'],
    ['a non-numeric timestamp', { [EventsHeader.Timestamp]: 'yesterday' }, 'not a Unix time'],
    ['an ISO timestamp', { [EventsHeader.Timestamp]: '2026-01-02T03:04:05Z' }, 'not a Unix time'],
    ['a fractional timestamp', { [EventsHeader.Timestamp]: `${NOW_SECONDS}.5` }, 'not a Unix time'],
    ['a negative timestamp', { [EventsHeader.Timestamp]: '-5' }, 'not a Unix time'],
  ])('rejects %s', (_name, override, message) => {
    expect(rejection(() => verify(headers(override))).message).toContain(message);
  });

  it('rejects when there are no headers at all', () => {
    expect(() => verify({})).toThrow(SubscriptionError);
    expect(() => verifyEventsSignature(SECRET, body, new Headers(), options)).toThrow(SubscriptionError);
  });

  it('never puts the secret in the error', () => {
    const error = rejection(() => verifyEventsSignature(SECRET, body, headers({ [EventsHeader.Signature]: 'x' }), options));
    expect(error.message).not.toContain(SECRET);
  });
});

describe('scheduler event envelope', () => {
  it('gives every event a stable id: equal content, equal id, whatever the key order', () => {
    const a = schedulerEvent();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as SchedulerEvent;
    expect(schedulerEventId(a)).toBe(schedulerEventId(reordered));
    expect(schedulerEventId(a)).toMatch(/^sevt_[0-9a-f]{32}$/);
    expect(schedulerEventId(a)).not.toBe(schedulerEventId(schedulerEvent({ attempt: 2 })));
    expect(schedulerEventId(a)).not.toBe(schedulerEventId(schedulerEvent({ type: SchedulerEventType.ChargeFailed })));
    expect(schedulerEventId(a)).toBe(schedulerEventId({ ...a, reason: undefined }));
  });

  it('delivers the event unchanged beside its id', () => {
    const e = schedulerEvent();
    expect(toSchedulerWebhookEvent(e)).toEqual({ id: schedulerEventId(e), ...e });
  });

  it('is told apart from a gateway delivery by `kind`, and validates', () => {
    const delivery = { kind: 'scheduler', events: [toSchedulerWebhookEvent(schedulerEvent())] };
    expect(EventsDeliverySchema.safeParse(delivery).success).toBe(true);
    expect(EventsDeliverySchema.safeParse({ ...delivery, kind: 'gateway' }).success).toBe(false);
    expect(EventsDeliverySchema.safeParse({ kind: 'scheduler', events: [] }).success).toBe(false);
    expect(EventsDeliverySchema.safeParse({ kind: 'other', events: delivery.events }).success).toBe(false);
    expect(EventsDeliverySchema.safeParse({ kind: 'gateway', provider: Provider.PayU, events: [event('e1')] }).success).toBe(true);
    expect(ChargeStatus.Failed).toBeDefined();
  });
});

describe('scheduler events relay', () => {
  function relayWith(routes: Parameters<typeof mockFetch>[0], extra: Record<string, unknown> = {}) {
    const mock = mockFetch(routes);
    const errors: string[] = [];
    const logger: EventsLog = { error: (m) => void errors.push(m) };
    const sleeps: number[] = [];
    const relay = createSchedulerEventsRelay({
      url: URL_WITH_TOKEN,
      secret: SECRET,
      fetch: mock.fetch,
      now: () => NOW,
      logger,
      random: () => 0.5, // no jitter
      sleep: async (ms) => void sleeps.push(ms),
      ...extra,
    });
    return { relay, mock, errors, sleeps };
  }
  const ok = { url: URL_WITH_TOKEN, status: 200 };
  const down = { url: URL_WITH_TOKEN, status: 503 };

  it('delivers a signed `scheduler` envelope in the background, with ids', async () => {
    const { relay, mock } = relayWith([ok]);
    const e = schedulerEvent();
    relay.enqueue(e);
    await relay.idle();
    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.headers[EventsHeader.Signature]).toBe(independentSignature(String(NOW_SECONDS), call.body as string));
    expect(call.headers[EventsHeader.Timestamp]).toBe(String(NOW_SECONDS));
    expect(call.json).toEqual({ kind: 'scheduler', events: [{ id: schedulerEventId(e), ...e }] });
    expect(relay.pending()).toBe(0);
  });

  it('enqueue returns at once and never throws, even when the receiver is down', () => {
    const { relay } = relayWith([down, down, down, down, down], { maxAttempts: 5 });
    expect(() => relay.enqueue(schedulerEvent())).not.toThrow();
    expect(relay.pending()).toBe(1);
  });

  it('batches what has queued up, in order, one POST at a time', async () => {
    const { relay, mock } = relayWith([ok, ok, ok], { batchSize: 2 });
    for (let i = 0; i < 5; i += 1) relay.enqueue(schedulerEvent({ attempt: i + 1 }));
    await relay.idle();
    const attempts = mock.calls.map((call) => (call.json as { events: { attempt: number }[] }).events.map((e) => e.attempt));
    expect(attempts.flat()).toEqual([1, 2, 3, 4, 5]);
    expect(Math.max(...attempts.map((a) => a.length))).toBeLessThanOrEqual(2);
  });

  it('retries with exponential backoff and delivers once the receiver recovers', async () => {
    const { relay, mock, errors, sleeps } = relayWith([down, down, ok]);
    relay.enqueue(schedulerEvent());
    await relay.idle();
    expect(mock.calls).toHaveLength(3);
    expect(sleeps).toEqual([1000, 2000]);
    expect(errors).toEqual([]);
    // Every attempt carries the same event id: the receiver can de-duplicate.
    const ids = mock.calls.map((c) => (c.json as { events: { id: string }[] }).events[0]!.id);
    expect(new Set(ids).size).toBe(1);
  });

  it('caps the backoff, and randomises it by at most 20 percent', async () => {
    const capped = relayWith([down, down, down, down, down, down], { maxAttempts: 6, maxDelayMs: 3000 });
    capped.relay.enqueue(schedulerEvent());
    await capped.relay.idle();
    expect(capped.sleeps).toEqual([1000, 2000, 3000, 3000, 3000]);

    const low = relayWith([down, ok], { random: () => 0 });
    low.relay.enqueue(schedulerEvent());
    await low.relay.idle();
    const high = relayWith([down, ok], { random: () => 0.999999 });
    high.relay.enqueue(schedulerEvent());
    await high.relay.idle();
    expect(low.sleeps).toEqual([800]);
    expect(high.sleeps[0]).toBeGreaterThanOrEqual(1199);
    expect(high.sleeps[0]).toBeLessThanOrEqual(1200);
  });

  it('gives up after a bounded number of attempts and logs each event id and type, without secrets', async () => {
    const { relay, mock, errors } = relayWith([down, down, down], { maxAttempts: 3 });
    const e = schedulerEvent({ type: SchedulerEventType.ChargeFailed });
    relay.enqueue(e);
    await relay.idle();
    expect(mock.calls).toHaveLength(3);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(schedulerEventId(e));
    expect(errors[0]).toContain('charge.failed');
    expect(errors[0]).toContain('HTTP 503');
    for (const leaked of [SECRET, 'path-token-123', 'query-secret-456']) expect(errors.join('\n')).not.toContain(leaked);
    expect(relay.pending()).toBe(0);
  });

  it('keeps going with later events after giving up on one batch', async () => {
    const { relay, mock, errors } = relayWith([down, down, ok], { maxAttempts: 2, batchSize: 1 });
    relay.enqueue(schedulerEvent({ attempt: 1 }));
    relay.enqueue(schedulerEvent({ attempt: 2 }));
    await relay.idle();
    expect(errors).toHaveLength(1);
    expect(mock.calls).toHaveLength(3);
    expect((mock.calls[2]!.json as { events: { attempt: number }[] }).events[0]!.attempt).toBe(2);
  });

  it('treats a network failure like any other failed attempt', async () => {
    const { relay, mock, errors } = relayWith([{ url: URL_WITH_TOKEN, networkError: true }, ok]);
    relay.enqueue(schedulerEvent());
    await relay.idle();
    expect(mock.calls).toHaveLength(2);
    expect(errors).toEqual([]);
  });

  it('drops the oldest events, loudly, when the queue is full', async () => {
    const gate = vi.fn();
    const { relay, errors } = relayWith([ok, ok, ok], {
      maxQueue: 2,
      batchSize: 1,
      fetch: async () => {
        gate();
        await new Promise((resolve) => setTimeout(resolve, 5));
        return new Response('', { status: 200 });
      },
    });
    const events = [1, 2, 3, 4, 5].map((attempt) => schedulerEvent({ attempt }));
    for (const e of events) relay.enqueue(e);
    await relay.idle();
    expect(errors.length).toBeGreaterThan(0);
    // Event 1 is already being delivered; of those still waiting, the oldest (event 2) goes first.
    expect(errors[0]).toContain(schedulerEventId(events[1]!));
    expect(errors[0]).toContain('charge.succeeded');
    expect(errors.join('\n')).not.toContain(schedulerEventId(events[0]!));
  });

  it('on close: stops retrying, and reports what was never delivered', async () => {
    const mock = mockFetch([down, down, down, down]);
    const errors: string[] = [];
    let release: () => void = () => undefined;
    const relay = createSchedulerEventsRelay({
      url: URL_WITH_TOKEN,
      secret: SECRET,
      fetch: mock.fetch,
      logger: { error: (m) => void errors.push(m) },
      batchSize: 1,
      sleep: (_ms, signal) =>
        new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener('abort', () => resolve());
        }),
    });
    const first = schedulerEvent({ attempt: 1 });
    const second = schedulerEvent({ attempt: 2 });
    relay.enqueue(first);
    relay.enqueue(second);
    await vi.waitFor(() => expect(mock.calls).toHaveLength(1));
    await relay.close();
    release();
    expect(mock.calls).toHaveLength(1);
    const output = errors.join('\n');
    expect(output).toContain(schedulerEventId(first)); // gave up while shutting down
    expect(output).toContain(schedulerEventId(second)); // never attempted
    relay.enqueue(schedulerEvent({ attempt: 3 }));
    expect(errors.join('\n')).toContain('shutting down');
    expect(mock.calls).toHaveLength(1);
  });
});

describe('the envelopes in the OpenAPI document', () => {
  const components = buildOpenApiDocument().components.schemas as Record<string, Record<string, unknown>>;

  it('publishes both shapes and the union under stable names', () => {
    expect(ServerSchemaName.EventsDelivery).toBe('EventsDelivery');
    expect(ServerSchemaName.GatewayEventsDelivery).toBe('GatewayEventsDelivery');
    expect(ServerSchemaName.SchedulerEventsDelivery).toBe('SchedulerEventsDelivery');
    expect(ServerSchemaName.SchedulerWebhookEvent).toBe('SchedulerWebhookEvent');
    for (const name of ['EventsDelivery', 'GatewayEventsDelivery', 'SchedulerEventsDelivery', 'SchedulerWebhookEvent']) {
      expect(components[name], name).toBeDefined();
    }
  });

  it('discriminates the union on `kind`', () => {
    expect(components.EventsDelivery?.discriminator).toEqual({
      propertyName: 'kind',
      mapping: {
        gateway: '#/components/schemas/GatewayEventsDelivery',
        scheduler: '#/components/schemas/SchedulerEventsDelivery',
      },
    });
  });

  it('requires an id on every scheduler event', () => {
    expect(components.SchedulerWebhookEvent?.required).toEqual(expect.arrayContaining(['id', 'type', 'at', 'scheduleId']));
  });
});
