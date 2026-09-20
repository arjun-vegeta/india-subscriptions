import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, Provider } from '../../src/constants.js';
import {
  EventsHeader,
  createEventsForwarder,
  signEventsBody,
  verifyEventsSignature,
} from '../../src/events-webhook.js';
import { SubscriptionError } from '../../src/errors.js';
import type { SubscriptionEvent } from '../../src/schemas.js';
import { mockFetch } from '../helpers/mock-fetch.js';

const URL_WITH_TOKEN = 'https://hooks.example.com/in/path-token-123?key=query-secret-456';
const SECRET = 'events-shared-secret';
const NOW = Date.UTC(2026, 0, 2, 3, 4, 5);

const event = (id: string): SubscriptionEvent => ({
  id,
  type: EventType.SubscriptionActivated,
  provider: Provider.Razorpay,
  occurredAt: '2026-01-02T03:04:05.000Z',
  providerEventType: 'subscription.activated',
  raw: {},
}) as SubscriptionEvent;

const independentSignature = (body: string): string => createHmac('sha256', SECRET).update(body, 'utf8').digest('hex');

async function failureOf(run: Promise<unknown>): Promise<SubscriptionError> {
  const error = await run.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SubscriptionError);
  return error as SubscriptionError;
}

describe('events webhook forwarder', () => {
  it('POSTs the batch as JSON, signed over the exact body, with a timestamp', async () => {
    const mock = mockFetch([{ url: URL_WITH_TOKEN, status: 202 }]);
    const forward = createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: mock.fetch, now: () => NOW });
    await forward(Provider.Razorpay, [event('evt_1'), event('evt_2')]);

    expect(mock.calls).toHaveLength(1);
    const call = mock.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(URL_WITH_TOKEN);
    expect(call.headers['content-type']).toBe('application/json');
    expect(call.headers[EventsHeader.Timestamp]).toBe(String(Math.floor(NOW / 1000)));
    expect(call.headers[EventsHeader.Signature]).toBe(independentSignature(call.body as string));
    expect(call.json).toEqual({ provider: Provider.Razorpay, events: [event('evt_1'), event('evt_2')] });
  });

  it('uses the documented header names', () => {
    expect(EventsHeader.Signature).toBe('x-india-subscriptions-signature');
    expect(EventsHeader.Timestamp).toBe('x-india-subscriptions-timestamp');
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
    const error = await failureOf(forward(Provider.Razorpay, [event('evt_1')]));
    expect(error.code).toBe(ErrorCode.Network);
  });

  it('fails when the endpoint does not answer in time', async () => {
    const hang = (_url: string, init?: RequestInit): Promise<Response> =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const forward = createEventsForwarder({ url: URL_WITH_TOKEN, secret: SECRET, fetch: hang, timeoutMs: 20 });
    const error = await failureOf(forward(Provider.Razorpay, [event('evt_1')]));
    expect(error.code).toBe(ErrorCode.Timeout);
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

describe('signature helpers', () => {
  const body = '{"provider":"payu","events":[]}';

  it('signEventsBody is the hex HMAC-SHA256 of the body', () => {
    expect(signEventsBody(SECRET, body)).toBe(independentSignature(body));
  });

  it('verifies the exact body only, in constant time, tolerant of case and whitespace', () => {
    const signature = signEventsBody(SECRET, body);
    expect(verifyEventsSignature(SECRET, body, signature)).toBe(true);
    expect(verifyEventsSignature(SECRET, body, ` ${signature.toUpperCase()} `)).toBe(true);
    expect(verifyEventsSignature(SECRET, `${body} `, signature)).toBe(false);
    expect(verifyEventsSignature('other-secret', body, signature)).toBe(false);
    expect(verifyEventsSignature(SECRET, body, signature.slice(0, -1))).toBe(false);
    expect(verifyEventsSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyEventsSignature(SECRET, body, null)).toBe(false);
    expect(verifyEventsSignature(SECRET, body, '')).toBe(false);
  });
});
