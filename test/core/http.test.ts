import { afterEach, describe, expect, it, vi } from 'vitest';
import { ErrorCode, HttpMethod, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { HttpClient, basicAuth, codeForStatus, formEncode, withQuery, type FetchLike, type HttpOptions, type HttpRequest } from '../../src/http.js';
import { mockFetch, type MockRoute } from '../helpers/mock-fetch.js';

const URL_ = 'https://api.example.test/v1/things';

function setup(routes: MockRoute[], options: HttpOptions = {}) {
  const mock = mockFetch(routes);
  const client = new HttpClient({ fetch: mock.fetch, ...options });
  const sleeps: number[] = [];
  client.sleep = async (ms) => {
    sleeps.push(ms);
  };
  return { client, sleeps, ...mock };
}

const get = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  provider: Provider.Razorpay,
  method: HttpMethod.Get,
  url: URL_,
  idempotent: true,
  ...overrides,
});

const post = (overrides: Partial<HttpRequest> = {}): HttpRequest => ({
  provider: Provider.Razorpay,
  method: HttpMethod.Post,
  url: URL_,
  body: '{"a":1}',
  idempotent: false,
  ...overrides,
});

async function rejection(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the promise to reject');
}

/** A fetch that never answers but honours the abort signal, like the real one. */
function hangingFetch(calls: { count: number }): FetchLike {
  return (_url, init) => {
    calls.count++;
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HttpClient: success and bodies', () => {
  it('returns status, headers, text and parsed JSON', async () => {
    const { client, calls } = setup([{ url: URL_, json: { id: 'x', amount: 49900 }, headers: { 'x-request-id': 'abc' } }]);
    const response = await client.send(get());
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ id: 'x', amount: 49900 });
    expect(response.text).toBe('{"id":"x","amount":49900}');
    expect(response.headers.get('x-request-id')).toBe('abc');
    expect(calls).toHaveLength(1);
  });

  it('forwards method, url, headers and body untouched', async () => {
    const { client, calls } = setup([{ url: URL_, json: {} }]);
    await client.send(post({ headers: { Authorization: 'Basic abc', 'Content-Type': 'application/json' } }));
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: URL_,
      headers: { authorization: 'Basic abc', 'content-type': 'application/json' },
      body: '{"a":1}',
      json: { a: 1 },
    });
  });

  it('gives json undefined (and keeps the text) for a non-JSON body', async () => {
    const { client } = setup([{ url: URL_, text: '<html>Bad gateway</html>', headers: { 'content-type': 'text/html' } }]);
    const response = await client.send(get());
    expect(response.json).toBeUndefined();
    expect(response.text).toBe('<html>Bad gateway</html>');
  });

  it('gives json undefined for an empty body', async () => {
    const { client } = setup([{ url: URL_, text: '' }]);
    const response = await client.send(get());
    expect(response.json).toBeUndefined();
    expect(response.text).toBe('');
  });

  it.each([
    ['null', null],
    ['0', 0],
    ['false', false],
    ['[1,2]', [1, 2]],
    ['"s"', 's'],
  ])('parses the JSON literal %s', async (text, expected) => {
    const { client } = setup([{ url: URL_, text }]);
    expect((await client.send(get())).json).toEqual(expected);
  });

  it('returns non-2xx responses to the caller instead of throwing (4xx)', async () => {
    const { client, calls } = setup([{ url: URL_, status: 400, json: { error: 'bad' } }]);
    const response = await client.send(get());
    expect(response.status).toBe(400);
    expect(response.json).toEqual({ error: 'bad' });
    expect(calls).toHaveLength(1);
  });

  it('uses the global fetch when none is supplied', async () => {
    const globalFetch = vi.fn(async () => new Response('{"ok":true}'));
    vi.stubGlobal('fetch', globalFetch);
    const client = new HttpClient();
    expect((await client.send(get())).json).toEqual({ ok: true });
    expect(globalFetch).toHaveBeenCalledTimes(1);
  });

  it('throws CONFIG when there is no fetch at all', () => {
    vi.stubGlobal('fetch', undefined);
    try {
      new HttpClient();
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      expect((error as SubscriptionError).code).toBe(ErrorCode.Config);
    }
  });
});

describe('HttpClient: retries on idempotent requests', () => {
  it.each([429, 500, 502, 503, 504])('retries a GET after %s and returns the eventual success', async (status) => {
    const { client, calls, sleeps, remaining } = setup([
      { url: URL_, status, json: { error: 'busy' } },
      { url: URL_, status: 200, json: { ok: true } },
    ]);
    const response = await client.send(get());
    expect(response.status).toBe(200);
    expect(response.json).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([250]);
    expect(remaining()).toBe(0);
  });

  it('backs off exponentially between retries', async () => {
    const { client, sleeps } = setup(
      [
        { url: URL_, status: 503 },
        { url: URL_, status: 503 },
        { url: URL_, status: 503 },
        { url: URL_, status: 503 },
        { url: URL_, status: 503 },
        { url: URL_, status: 503 },
        { url: URL_, status: 503 },
        { url: URL_, status: 503 },
      ],
      { maxRetries: 7 },
    );
    await client.send(get());
    expect(sleeps).toEqual([250, 500, 1000, 2000, 2000, 2000, 2000]);
  });

  it('gives up after maxRetries and hands back the last failing response', async () => {
    const { client, calls, sleeps } = setup(
      [
        { url: URL_, status: 503, json: { n: 1 } },
        { url: URL_, status: 503, json: { n: 2 } },
        { url: URL_, status: 503, json: { n: 3 } },
        { url: URL_, status: 200, json: { n: 4 } },
      ],
      { maxRetries: 2 },
    );
    const response = await client.send(get());
    expect(response.status).toBe(503);
    expect(response.json).toEqual({ n: 3 });
    expect(calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it('maxRetries 0 means one attempt only', async () => {
    const { client, calls } = setup([{ url: URL_, status: 503 }, { url: URL_, status: 200 }], { maxRetries: 0 });
    expect((await client.send(get())).status).toBe(503);
    expect(calls).toHaveLength(1);
  });

  it('defaults to 2 retries (3 attempts)', async () => {
    const { client, calls } = setup(Array.from({ length: 5 }, () => ({ url: URL_, status: 500 })));
    expect((await client.send(get())).status).toBe(500);
    expect(calls).toHaveLength(3);
  });

  it.each([400, 401, 403, 404, 409, 422])('does not retry %s', async (status) => {
    const { client, calls } = setup([{ url: URL_, status }, { url: URL_, status: 200 }]);
    expect((await client.send(get())).status).toBe(status);
    expect(calls).toHaveLength(1);
  });

  it('retries an idempotent POST (a write carrying a gateway idempotency key)', async () => {
    const { client, calls } = setup([
      { url: URL_, status: 502 },
      { url: URL_, status: 200, json: { ok: 1 } },
    ]);
    const response = await client.send(post({ idempotent: true }));
    expect(response.json).toEqual({ ok: 1 });
    expect(calls.map((call) => call.method)).toEqual(['POST', 'POST']);
    expect(calls[1]?.body).toBe('{"a":1}');
  });

  it('recovers from a network error followed by a success', async () => {
    const { client, calls } = setup([
      { url: URL_, networkError: true },
      { url: URL_, status: 200, json: { ok: true } },
    ]);
    expect((await client.send(get())).json).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('a network error on the final attempt does not mask... but a later response wins over an earlier network error', async () => {
    const { client } = setup([
      { url: URL_, networkError: true },
      { url: URL_, status: 503 },
      { url: URL_, status: 503 },
    ]);
    expect((await client.send(get())).status).toBe(503);
  });
});

describe('HttpClient: non-idempotent requests are never retried', () => {
  it.each([429, 500, 502, 503, 504])('POST answered with %s is returned after exactly one attempt', async (status) => {
    const { client, calls, sleeps } = setup([
      { url: URL_, status, json: { e: 1 } },
      { url: URL_, status: 200, json: { ok: true } },
    ]);
    const response = await client.send(post());
    expect(response.status).toBe(status);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it('a non-idempotent GET-shaped request is not retried either', async () => {
    const { client, calls } = setup([{ url: URL_, status: 503 }, { url: URL_, status: 200 }]);
    await client.send(get({ idempotent: false }));
    expect(calls).toHaveLength(1);
  });
});

describe('HttpClient: transport failures', () => {
  it('idempotent network error -> NETWORK after maxRetries + 1 attempts', async () => {
    const { client, calls } = setup(
      [
        { url: URL_, networkError: true },
        { url: URL_, networkError: true },
        { url: URL_, networkError: true },
        { url: URL_, networkError: true },
      ],
      { maxRetries: 2 },
    );
    const error = await rejection(client.send(get()));
    expect(error.code).toBe(ErrorCode.Network);
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/fetch failed/);
    expect(error.cause).toBeInstanceOf(TypeError);
    expect(calls).toHaveLength(3);
  });

  it('idempotent timeout -> TIMEOUT, after retrying', async () => {
    const calls = { count: 0 };
    const client = new HttpClient({ fetch: hangingFetch(calls), timeoutMs: 10, maxRetries: 1 });
    client.sleep = async () => {};
    const error = await rejection(client.send(get()));
    expect(error.code).toBe(ErrorCode.Timeout);
    expect(error.retryable).toBe(true);
    expect(error.message).toMatch(/10ms/);
    expect(calls.count).toBe(2);
  });

  it('non-idempotent network error -> OUTCOME_UNKNOWN, no retry', async () => {
    const { client, calls } = setup([{ url: URL_, networkError: true }, { url: URL_, status: 200 }]);
    const error = await rejection(client.send(post()));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(error.retryable).toBe(false);
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.message).toMatch(/fetch the current state/);
    expect(calls).toHaveLength(1);
  });

  it('non-idempotent timeout -> OUTCOME_UNKNOWN (not TIMEOUT), no retry', async () => {
    const calls = { count: 0 };
    const client = new HttpClient({ fetch: hangingFetch(calls), timeoutMs: 10 });
    const error = await rejection(client.send(post()));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(error.message).toMatch(/within 10ms/);
    expect(error.cause).toBeInstanceOf(DOMException);
    expect(calls.count).toBe(1);
  });

  it('error messages never include the query string (it may carry secrets)', async () => {
    const secretUrl = `${URL_}?token=s3cr3t&x=1`;
    const { client } = setup([{ url: secretUrl, networkError: true }]);
    const idempotent = await rejection(client.send(get({ url: secretUrl, ...{ idempotent: true } })).catch((e) => Promise.reject(e)) as Promise<unknown>).catch(() => undefined);
    void idempotent;

    for (const request of [get({ url: secretUrl }), post({ url: secretUrl })]) {
      const routes = Array.from({ length: 3 }, () => ({ url: secretUrl, networkError: true }));
      const { client: c } = setup(routes);
      const error = await rejection(c.send(request));
      expect(error.message).not.toContain('s3cr3t');
      expect(error.message).toContain(URL_);
    }
    void client;
  });

  it('the abort timer is cleared after a fast response (no stray abort later)', async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      if (init?.signal) signals.push(init.signal);
      return new Response('{}');
    };
    const client = new HttpClient({ fetch: fetchImpl, timeoutMs: 20 });
    await client.send(get());
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
  });

  it('passes an AbortSignal to fetch', async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const client = new HttpClient({
      fetch: async (_url, init) => {
        seen.push(init?.signal);
        return new Response('{}');
      },
    });
    await client.send(get());
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });
});

describe('codeForStatus', () => {
  it.each([
    [400, ErrorCode.Validation],
    [422, ErrorCode.Validation],
    [401, ErrorCode.Auth],
    [403, ErrorCode.Auth],
    [404, ErrorCode.NotFound],
    [409, ErrorCode.Conflict],
    [429, ErrorCode.RateLimited],
  ])('%s -> %s regardless of idempotency', (status, code) => {
    expect(codeForStatus(status, true)).toBe(code);
    expect(codeForStatus(status, false)).toBe(code);
  });

  it.each([500, 501, 502, 503, 504, 599])('%s -> PROVIDER_UNAVAILABLE when idempotent', (status) => {
    expect(codeForStatus(status, true)).toBe(ErrorCode.ProviderUnavailable);
  });

  it.each([500, 501, 502, 503, 504, 599])('%s -> OUTCOME_UNKNOWN when not idempotent', (status) => {
    expect(codeForStatus(status, false)).toBe(ErrorCode.OutcomeUnknown);
  });

  it.each([100, 200, 204, 301, 302, 402, 405, 408, 410, 418, 451])('%s -> PROVIDER_ERROR', (status) => {
    expect(codeForStatus(status, true)).toBe(ErrorCode.ProviderError);
    expect(codeForStatus(status, false)).toBe(ErrorCode.ProviderError);
  });
});

describe('basicAuth', () => {
  it('encodes username:password as Basic base64', () => {
    expect(basicAuth('rzp_test_key', 'secret')).toBe(`Basic ${Buffer.from('rzp_test_key:secret').toString('base64')}`);
    expect(basicAuth('user', 'pass')).toBe('Basic dXNlcjpwYXNz');
  });

  it('is UTF-8 safe and keeps colons inside the password', () => {
    expect(basicAuth('u', 'p:a:ss')).toBe(`Basic ${Buffer.from('u:p:a:ss').toString('base64')}`);
    expect(basicAuth('ü', '₹')).toBe(`Basic ${Buffer.from('ü:₹', 'utf8').toString('base64')}`);
  });

  it('handles empty credentials', () => {
    expect(basicAuth('', '')).toBe('Basic Og==');
  });
});

describe('formEncode', () => {
  it('encodes pairs in order, stringifying numbers', () => {
    expect(formEncode({ a: '1', b: 2, c: 'x y' })).toBe('a=1&b=2&c=x+y');
  });

  it('percent-encodes reserved characters', () => {
    expect(formEncode({ k: 'a&b=c/d?e', 'we ird': '₹' })).toBe('k=a%26b%3Dc%2Fd%3Fe&we+ird=%E2%82%B9');
  });

  it('skips undefined but keeps empty strings and zero', () => {
    expect(formEncode({ a: undefined, b: '', c: 0 })).toBe('b=&c=0');
  });

  it('returns an empty string for nothing', () => {
    expect(formEncode({})).toBe('');
    expect(formEncode({ a: undefined })).toBe('');
  });

  it('round-trips through URLSearchParams', () => {
    const fields = { a: 'x&y=z', b: '100%', c: 'α β', d: '' };
    expect(Object.fromEntries(new URLSearchParams(formEncode(fields)))).toEqual(fields);
  });
});

describe('withQuery', () => {
  it('appends with ? to a bare URL', () => {
    expect(withQuery('https://x.test/a', { count: 10, skip: 0 })).toBe('https://x.test/a?count=10&skip=0');
  });

  it('appends with & when a query already exists', () => {
    expect(withQuery('https://x.test/a?v=1', { count: 10 })).toBe('https://x.test/a?v=1&count=10');
  });

  it('leaves the URL alone when there is nothing to add', () => {
    expect(withQuery('https://x.test/a', {})).toBe('https://x.test/a');
    expect(withQuery('https://x.test/a', { a: undefined })).toBe('https://x.test/a');
    expect(withQuery('https://x.test/a?v=1', { a: undefined })).toBe('https://x.test/a?v=1');
  });

  it('encodes values', () => {
    expect(withQuery('https://x.test/a', { q: 'a b&c' })).toBe('https://x.test/a?q=a+b%26c');
  });

  // DEFECT (src/http.ts, withQuery): a URL that already ends in "?" gets "&" appended,
  // producing "https://x.test/a?&count=10" (an empty first parameter), and a URL with a
  // #fragment gets the query appended after the fragment, where it is not sent to the server.
  it.fails('does not produce "?&" when the URL already ends with "?"', () => {
    expect(withQuery('https://x.test/a?', { count: 10 })).toBe('https://x.test/a?count=10');
  });

  it.fails('inserts the query before a #fragment', () => {
    expect(withQuery('https://x.test/a#frag', { count: 10 })).toBe('https://x.test/a?count=10#frag');
  });
});
