import type { HttpMethod } from '../../src/constants.js';
import type { FetchLike } from '../../src/http.js';

export interface RecordedCall {
  method: string;
  url: string;
  headers: Record<string, string>;
  /** Raw request body, if any. */
  body?: string;
  /** Body parsed as JSON, when it is JSON. */
  json?: unknown;
  /** Body parsed as application/x-www-form-urlencoded, when it is not JSON. */
  form?: Record<string, string>;
}

export interface MockRoute {
  method?: HttpMethod;
  /** Exact URL, or a pattern tested against the full URL. */
  url: string | RegExp;
  status?: number;
  /** Response body as JSON. */
  json?: unknown;
  /** Response body as text (used when `json` is not given). */
  text?: string;
  headers?: Record<string, string>;
  /** Throw instead of responding, to simulate a dropped connection. */
  networkError?: boolean;
}

/**
 * A scripted fetch. Each incoming request consumes the first unused route that
 * matches its method and URL; a request with no matching route throws, so a
 * test fails if the adapter calls something unexpected.
 */
export function mockFetch(routes: MockRoute[]): { fetch: FetchLike; calls: RecordedCall[]; remaining: () => number } {
  const queue = routes.map((route) => ({ route, used: false }));
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

    const entry = queue.find(
      ({ route, used }) =>
        !used &&
        (route.method === undefined || route.method === method) &&
        (typeof route.url === 'string' ? route.url === url : route.url.test(url)),
    );
    if (!entry) throw new Error(`mockFetch: unexpected request ${method} ${url}`);
    entry.used = true;
    if (entry.route.networkError) throw new TypeError('fetch failed');

    const text = entry.route.json !== undefined ? JSON.stringify(entry.route.json) : (entry.route.text ?? '');
    return new Response(text, {
      status: entry.route.status ?? 200,
      headers: { 'content-type': 'application/json', ...entry.route.headers },
    });
  };

  return { fetch, calls, remaining: () => queue.filter((entry) => !entry.used).length };
}
