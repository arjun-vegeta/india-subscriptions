import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CheckoutKind, ContentType, Environment, ErrorCode, HeaderName, HttpMethod, ProductKind, Provider } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { PurchaseSessionSchema, SessionStatus } from '../../src/purchase/index.js';
import { ReturnParam, escapeHtml, gatherReturnFields, jsonForScript, returnLocation, ApiPath, AuthMode, routes } from '../../src/server/index.js';
import {
  BASE,
  COINS,
  MONTHLY,
  PAID,
  RESULT_ORDER,
  RESULT_OUTCOME,
  ScriptedGateway,
  jsonOf,
  send,
  startBody,
  wire,
} from './support.js';

const HOSTILE = `"><script>alert(1)</script>'&\`</script><!--\u2028`;

async function startWith(t: ReturnType<typeof wire>, fields: Record<string, unknown> = {}) {
  const response = await send(t.handler, HttpMethod.Post, '/v1/purchases', { body: startBody(fields) });
  expect(response.status).toBe(201);
  return PurchaseSessionSchema.parse(await jsonOf(response));
}

/** Header-less and cookie-less: what a customer's browser sends to the public pages. */
const browser = (t: ReturnType<typeof wire>, method: string, path: string, init: { rawBody?: string; contentType?: string } = {}) =>
  send(t.handler, method, path, { auth: null, ...init });

function directive(policy: string, name: string): string[] | undefined {
  const found = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(`${name} `) || part === name);
  return found?.split(/\s+/).slice(1);
}

function inlineScript(html: string): string {
  const matches = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  expect(matches).toHaveLength(1);
  return matches[0]![1]!;
}

const sha = (text: string) => `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;

describe('GET /checkout/{sessionId}', () => {
  it('serves a page without any API key, with the headers of a locked-down page', async () => {
    const t = wire();
    const session = await startWith(t);
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('referrer-policy')).toBe('strict-origin-when-cross-origin');
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(directive(policy, 'default-src')).toEqual([`'none'`]);
    expect(directive(policy, 'base-uri')).toEqual([`'none'`]);
    expect(directive(policy, 'frame-ancestors')).toEqual([`'none'`]);
    expect(policy).not.toContain('unsafe-eval');
    // A redirect page runs one fixed script, allowed by its hash, and nothing else.
    const html = await response.text();
    expect(directive(policy, 'script-src')).toEqual([sha(inlineScript(html))]);
    expect(directive(policy, 'style-src')).toHaveLength(1);
  });

  it('a redirect instruction sends the browser to the gateway URL, with a link for when scripts are off', async () => {
    const t = wire();
    const session = await startWith(t);
    const html = await (await browser(t, HttpMethod.Get, `/checkout/${session.id}`)).text();
    const url = (session.options[0]!.checkout as { url: string }).url;
    expect(html).toContain(`<script type="application/json" id="d">{"url":${JSON.stringify(url)}}</script>`);
    expect(html).toContain(`<noscript>`);
    expect(html).toContain(`href="${url}"`);
    expect(inlineScript(html)).toContain('location.replace');
  });

  it('a form post instruction renders the form with every field escaped, and lets the form go to its gateway only', async () => {
    const gateway = new ScriptedGateway(Provider.Razorpay);
    gateway.checkout = () => ({
      kind: CheckoutKind.FormPost,
      url: 'https://secure.payu.example/_payment',
      fields: { key: 'k', hash: 'abc', [`na"me`]: HOSTILE, surl: 'https://x.example/ok?a=1&b=2' },
    });
    const t = wire({ gateways: [gateway] });
    const session = await startWith(t);
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}`);
    const html = await response.text();
    // Nothing hostile is live: no raw quote, tag or comment from a field value.
    expect(html).not.toContain('<script>alert');
    expect(html).not.toContain('"><script');
    expect(html).not.toContain('<!--');
    expect(html).toContain(`name="na&quot;me" value="${escapeHtml(HOSTILE)}"`);
    expect(html).toContain('action="https://secure.payu.example/_payment"');
    expect(html).toContain('value="https://x.example/ok?a=1&amp;b=2"');
    expect(inlineScript(html)).toContain('HTMLFormElement.prototype.submit.call');
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(directive(policy, 'form-action')).toEqual([`'self'`, 'https://secure.payu.example']);
    expect(directive(policy, 'script-src')).toEqual([sha(inlineScript(html))]);
  });

  it('a Razorpay instruction loads Razorpay\'s script, opens its checkout and lets it frame and connect, nothing more', async () => {
    const gateway = new ScriptedGateway(Provider.Razorpay);
    gateway.checkout = (id) => ({
      kind: CheckoutKind.RazorpayCheckout,
      keyId: 'rzp_test_abc',
      subscriptionId: id,
      prefill: { name: HOSTILE, email: 'asha@example.com', phone: '9876543210' },
    });
    const t = wire({ gateways: [gateway] });
    const session = await startWith(t);
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}`);
    const html = await response.text();
    expect(html).toContain('<script src="https://checkout.razorpay.com/v1/checkout.js"></script>');
    expect(html).not.toContain('<script>alert');
    // The data block cannot be closed or commented out by a value.
    const data = /<script type="application\/json" id="d">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '';
    expect(data).not.toMatch(/[<>&\u2028]/);
    expect(JSON.parse(data)).toMatchObject({ keyId: 'rzp_test_abc', subscriptionId: expect.stringMatching(/^sub_/), prefill: { name: HOSTILE, contact: '9876543210' } });
    // No secret: the page holds what the instruction holds, which is the public key id.
    expect(html).not.toContain('keySecret');
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(directive(policy, 'script-src')).toEqual([sha(inlineScript(html)), 'https://checkout.razorpay.com']);
    expect(directive(policy, 'frame-src')).toEqual(['https://*.razorpay.com']);
    expect(directive(policy, 'connect-src')).toEqual(['https://*.razorpay.com']);
    expect(directive(policy, 'default-src')).toEqual([`'none'`]);
    expect(directive(policy, 'frame-ancestors')).toEqual([`'none'`]);
    // The handler's result comes back to the return endpoint as a navigation: no form-action involved.
    expect(inlineScript(html)).toContain("'/return'");
    expect(inlineScript(html)).toContain('location.assign');
  });

  it('a Razorpay one-time instruction opens the order', async () => {
    const gateway = new ScriptedGateway(Provider.Razorpay);
    gateway.checkout = (id) => ({ kind: CheckoutKind.RazorpayCheckout, keyId: 'rzp_test_abc', orderId: id, amount: 9900 });
    const t = wire({ gateways: [gateway] });
    const session = await startWith(t, { product: COINS.key });
    const html = await (await browser(t, HttpMethod.Get, `/checkout/${session.id}`)).text();
    const data = JSON.parse(/<script type="application\/json" id="d">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}') as Record<string, unknown>;
    expect(data).toMatchObject({ orderId: expect.stringMatching(/^order_/), amount: 9900 });
    expect(data).not.toHaveProperty('subscriptionId');
  });

  it.each([
    [ProductKind.Subscription, false],
    [ProductKind.OneTime, true],
  ])('a Cashfree %s instruction calls the right Cashfree.js method', async (kind, oneTime) => {
    const gateway = new ScriptedGateway(Provider.Cashfree);
    gateway.checkout = () => ({ kind: CheckoutKind.CashfreeCheckout, sessionId: 'sess_abc', environment: Environment.Test, ...(oneTime ? { productKind: ProductKind.OneTime } : {}) });
    const t = wire({ gateways: [gateway] });
    const session = await startWith(t, { product: kind === ProductKind.OneTime ? COINS.key : MONTHLY.key });
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}`);
    const html = await response.text();
    expect(html).toContain('<script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>');
    expect(JSON.parse(/<script type="application\/json" id="d">([\s\S]*?)<\/script>/.exec(html)?.[1] ?? '{}')).toEqual({ sessionId: 'sess_abc', mode: 'sandbox', oneTime });
    const policy = response.headers.get('content-security-policy') ?? '';
    expect(directive(policy, 'script-src')).toEqual([sha(inlineScript(html)), 'https://sdk.cashfree.com']);
    expect(directive(policy, 'frame-src')).toEqual(['https://*.cashfree.com']);
  });

  it('answers 404 with the same empty page for an unknown id, a malformed id, an expired session, a completed one and one with no gateway option', async () => {
    let now = new Date('2026-11-23T10:00:00.000Z');
    const t = wire({ purchases: { now: () => now, sessionTtlMs: 60_000 } });
    const live = await startWith(t);
    const expired = await startWith(t, { product: COINS.key, reference: 'second' });
    now = new Date(now.getTime() + 61_000);
    const paid = await startWith(t, { product: COINS.key, customerRef: 'cust_2', reference: 'third' });
    await send(t.handler, HttpMethod.Post, `/v1/purchases/${paid.id}/complete`, {
      body: { provider: paid.options[0]!.provider, result: { [RESULT_ORDER]: paid.options[0]!.handle, [RESULT_OUTCOME]: PAID } },
    });
    const bodies = new Set<string>();
    for (const id of [expired.id, live.id, paid.id, 'ps_unknown', 'nonsense', `ps_${'a'.repeat(500)}`, 'ps_%00', 'ps_..']) {
      const response = await browser(t, HttpMethod.Get, `/checkout/${id}`);
      expect(response.status, id).toBe(404);
      expect(response.headers.get('content-security-policy')).toContain(`default-src 'none'`);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    const [body] = [...bodies];
    for (const word of ['expired', 'session', 'unknown', 'ps_', 'completed']) expect(body!.toLowerCase()).not.toContain(word);
  });

  it('answers the same 404 when the service has no purchases at all', async () => {
    const t = wire({ purchases: false });
    const response = await browser(t, HttpMethod.Get, '/checkout/ps_whatever');
    expect(response.status).toBe(404);
  });

  it('a store-only session has no page: the browser has nothing to do', async () => {
    const t = wire();
    const record = await startWith(t);
    // A session whose option is a store instruction cannot be shown: build one through the module's own store option shape.
    const stored = await (t.client.purchases as unknown as { store: { getSession(id: string): Promise<Record<string, unknown>>; saveSession(r: unknown): Promise<void> } }).store.getSession(record.id);
    await (t.client.purchases as unknown as { store: { saveSession(r: unknown): Promise<void> } }).store.saveSession({
      ...stored,
      options: [{ channel: 'store', provider: Provider.AppStore, handle: 'x', checkout: { kind: CheckoutKind.AppleStoreKit, productId: 'p', appAccountToken: '7e3fb20b-4cdb-47cc-936d-99d65f608138' } }],
    });
    expect((await browser(t, HttpMethod.Get, `/checkout/${record.id}`)).status).toBe(404);
  });

  it('is served for GET only, and a page is never cached or framed', async () => {
    const t = wire();
    const session = await startWith(t);
    const post = await browser(t, HttpMethod.Post, `/checkout/${session.id}`);
    expect(post.status).toBe(405);
    expect(post.headers.get('allow')).toBe('GET');
  });
});

describe('GET and POST /checkout/{sessionId}/return', () => {
  async function paidFields(session: { options: Array<{ handle: string }> }, extra: Record<string, string> = {}): Promise<URLSearchParams> {
    return new URLSearchParams({ [RESULT_ORDER]: session.options[0]!.handle, [RESULT_OUTCOME]: PAID, ...extra });
  }

  it('completes the purchase from the query and redirects to the session\'s returnUrl with session and status', async () => {
    const t = wire();
    const session = await startWith(t);
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?${await paidFields(session)}`);
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get('location') ?? '');
    expect(`${location.origin}${location.pathname}`).toBe('https://shop.example.com/done');
    expect(location.searchParams.get(ReturnParam.Session)).toBe(session.id);
    expect(location.searchParams.get(ReturnParam.Status)).toBe(SessionStatus.Completed);
    expect(await response.text()).toBe('');
    const after = PurchaseSessionSchema.parse(await jsonOf(await send(t.handler, HttpMethod.Get, `/v1/purchases/${session.id}`)));
    expect(after.status).toBe(SessionStatus.Completed);
  });

  it('accepts the form fields of a POST, and both together, the form winning', async () => {
    const t = wire();
    const session = await startWith(t);
    const fields = await paidFields(session);
    const response = await browser(t, HttpMethod.Post, `/checkout/${session.id}/return?${RESULT_OUTCOME}=failed`, {
      rawBody: fields.toString(),
      contentType: ContentType.Form,
    });
    expect(response.status).toBe(303);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get(ReturnParam.Status)).toBe(SessionStatus.Completed);
  });

  it('keeps a returnUrl that is an app deep link, its own query and its fragment', async () => {
    const t = wire();
    const session = await startWith(t, { returnUrl: 'myapp://purchase/done?source=checkout#top' });
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?${await paidFields(session)}`);
    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location.startsWith('myapp://purchase/done?source=checkout&session=')).toBe(true);
    expect(location).toContain('status=completed');
    expect(location.endsWith('#top')).toBe(true);
  });

  it('never trusts the request: a result for another order, a forged status, a returnUrl or provider in the query change nothing', async () => {
    const t = wire();
    const session = await startWith(t);
    const evil = new URLSearchParams({
      [RESULT_ORDER]: 'sub_razorpay_999',
      [RESULT_OUTCOME]: PAID,
      status: 'completed',
      session: 'ps_someone_else',
      returnUrl: 'https://evil.example/steal',
      provider: Provider.Cashfree,
      redirect: 'https://evil.example',
    });
    for (const response of [
      await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?${evil}`),
      await browser(t, HttpMethod.Post, `/checkout/${session.id}/return`, { rawBody: evil.toString(), contentType: ContentType.Form }),
    ]) {
      expect(response.status).toBe(303);
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.origin + location.pathname).toBe('https://shop.example.com/done');
      expect(location.searchParams.get(ReturnParam.Session)).toBe(session.id);
      // The result was for another order: the session is as it was, and the customer is told that.
      expect(location.searchParams.get(ReturnParam.Status)).toBe(SessionStatus.Open);
      expect([...location.searchParams.keys()].sort()).toEqual(['session', 'status']);
    }
    const after = PurchaseSessionSchema.parse(await jsonOf(await send(t.handler, HttpMethod.Get, `/v1/purchases/${session.id}`)));
    expect(after.status).toBe(SessionStatus.Open);
    expect(t.gateways[1]?.created).toHaveLength(0);
  });

  it('verifies with the gateway of the session\'s option, whatever the request names', async () => {
    const t = wire();
    const session = await startWith(t);
    const seen: Array<Record<string, unknown>> = [];
    const gateway = t.gateways[0]!;
    const original = gateway.verifyCheckout.bind(gateway);
    gateway.verifyCheckout = async (result) => {
      seen.push(result);
      return original(result);
    };
    await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?${await paidFields(session, { provider: 'cashfree' })}`);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ [RESULT_ORDER]: session.options[0]!.handle, provider: 'cashfree' });
  });

  it('when the gateway cannot be asked, the customer still leaves with the session\'s own status and no detail', async () => {
    const t = wire();
    const session = await startWith(t);
    t.gateways[0]!.failVerifications = new SubscriptionError(ErrorCode.ProviderUnavailable, 'razorpay is down: secret internal detail', { provider: Provider.Razorpay });
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?${await paidFields(session)}`);
    expect(response.status).toBe(303);
    const location = response.headers.get('location') ?? '';
    expect(location).toContain('status=open');
    expect(location).not.toContain('secret');
  });

  it('a declined payment sends the customer back as failed', async () => {
    const t = wire();
    const session = await startWith(t);
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?${new URLSearchParams({ [RESULT_ORDER]: session.options[0]!.handle, [RESULT_OUTCOME]: 'declined' })}`);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get(ReturnParam.Status)).toBe(SessionStatus.Failed);
  });

  it('completes a session that expired while the customer paid: money that moved is never lost', async () => {
    let now = new Date('2026-11-23T10:00:00.000Z');
    const t = wire({ purchases: { now: () => now, sessionTtlMs: 60_000 } });
    const session = await startWith(t);
    now = new Date(now.getTime() + 3_600_000);
    const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?${await paidFields(session)}`);
    expect(new URL(response.headers.get('location') ?? '').searchParams.get(ReturnParam.Status)).toBe(SessionStatus.Completed);
  });

  it('a session with no returnUrl, or one that must not be redirected to, gets a plain page instead', async () => {
    const t = wire();
    for (const returnUrl of [undefined, 'javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'vbscript:x']) {
      const session = await startWith(t, { returnUrl, customerRef: `c_${String(returnUrl).length}`, reference: `r${String(returnUrl).length}x` });
      const response = await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?${await paidFields(session)}`);
      expect(response.status, String(returnUrl)).toBe(200);
      expect(response.headers.get('location')).toBeNull();
      const html = await response.text();
      expect(html).toContain('Your payment is complete.');
      expect(html).not.toContain('alert');
      expect(response.headers.get('content-security-policy')).toContain(`script-src 'none'`);
    }
  });

  it('answers 404 without detail for an unknown session, on both methods', async () => {
    const t = wire();
    for (const method of [HttpMethod.Get, HttpMethod.Post]) {
      const response = await browser(t, method, '/checkout/ps_unknown/return?a=b');
      expect(response.status).toBe(404);
      const page = await response.text();
      expect(page).not.toContain('ps_unknown');
    }
  });

  it('survives hostile and oversized fields', async () => {
    const t = wire();
    const session = await startWith(t);
    const huge = new URLSearchParams({ [RESULT_ORDER]: session.options[0]!.handle, [RESULT_OUTCOME]: PAID, big: 'x'.repeat(100_000), __proto__: 'polluted', constructor: 'c' });
    const response = await browser(t, HttpMethod.Post, `/checkout/${session.id}/return`, { rawBody: huge.toString(), contentType: ContentType.Form });
    expect(response.status).toBe(303);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('refuses a body over the limit', async () => {
    const t = wire();
    const session = await startWith(t);
    const response = await browser(t, HttpMethod.Post, `/checkout/${session.id}/return`, { rawBody: 'a=b'.repeat(500_000), contentType: ContentType.Form });
    expect(response.status).toBe(413);
  });

  it('the redirect is the only place the customer is sent: every response of the endpoint carries a Location from the session or none', async () => {
    const t = wire();
    const session = await startWith(t);
    const responses = [
      await browser(t, HttpMethod.Get, `/checkout/${session.id}/return`),
      await browser(t, HttpMethod.Get, `/checkout/${session.id}/return?next=https://evil.example`),
      await browser(t, HttpMethod.Post, `/checkout/${session.id}/return`, { rawBody: JSON.stringify({ url: 'https://evil.example' }), contentType: ContentType.Json }),
    ];
    for (const response of responses) {
      expect(new URL(response.headers.get('location') ?? '').origin).toBe('https://shop.example.com');
    }
  });
});

describe('the hosted checkout routes', () => {
  it('are public (the session id is the credential) and the only public routes besides health, the OpenAPI document and webhooks', () => {
    const publicRoutes = routes.filter((route) => route.auth !== AuthMode.Bearer).map((route) => `${route.method} ${route.path}`).sort();
    expect(publicRoutes).toEqual(
      [
        `GET ${ApiPath.Health}`,
        `GET ${ApiPath.OpenApi}`,
        `POST ${ApiPath.Webhooks}`,
        `GET ${ApiPath.Checkout}`,
        `GET ${ApiPath.CheckoutReturn}`,
        `POST ${ApiPath.CheckoutReturn}`,
      ].sort(),
    );
  });

  it('are mounted under the base path with the rest', async () => {
    const { createHandler } = await import('../../src/server/index.js');
    const t = wire();
    const handler = createHandler({ client: t.client, apiKey: 'k'.repeat(20), basePath: '/billing' });
    const session = await startWith(t);
    const response = await handler(new Request(`${BASE}/billing/checkout/${session.id}`));
    expect(response.status).toBe(200);
    expect((await handler(new Request(`${BASE}/checkout/${session.id}`))).status).toBe(404);
    expect(HeaderName.ContentType).toBe('content-type');
  });
});

describe('helpers', () => {
  it('escapeHtml escapes every character that can leave an attribute or a text node', () => {
    expect(escapeHtml(`&<>"'\``)).toBe('&amp;&lt;&gt;&quot;&#39;&#96;');
    expect(escapeHtml('plain text 123')).toBe('plain text 123');
  });

  it('jsonForScript cannot close a script block, open a comment or break a line', () => {
    const out = jsonForScript({ a: '</script><!-- & \u2028\u2029 >' });
    expect(out).not.toMatch(/[<>&\u2028\u2029]/);
    expect(JSON.parse(out)).toEqual({ a: '</script><!-- & \u2028\u2029 >' });
  });

  it('gatherReturnFields reads query, form and JSON text values, own properties only, bounded', () => {
    const query = new URLSearchParams('a=1&b=2');
    expect(gatherReturnFields(query, 'b=3&c=4', ContentType.Form)).toEqual({ a: '1', b: '3', c: '4' });
    expect(gatherReturnFields(query, 'b=3', null)).toEqual({ a: '1', b: '2' });
    expect(gatherReturnFields(new URLSearchParams(), JSON.stringify({ a: 'x', n: 1, o: {}, l: [] }), `${ContentType.Json}; charset=utf-8`)).toEqual({ a: 'x' });
    expect(gatherReturnFields(new URLSearchParams(), '{bad', ContentType.Json)).toEqual({});
    const many = new URLSearchParams(Array.from({ length: 500 }, (_, i) => [`k${i}`, 'v']));
    expect(Object.keys(gatherReturnFields(many, '', null))).toHaveLength(100);
    const proto = gatherReturnFields(new URLSearchParams('__proto__=x'), '', null);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(Object.keys(proto)).toEqual(['__proto__']);
  });

  it('returnLocation appends the session and the status, and refuses schemes that run code', () => {
    expect(returnLocation({ id: 'ps_1', returnUrl: 'https://a.example/p?x=1' }, SessionStatus.Completed)).toBe('https://a.example/p?x=1&session=ps_1&status=completed');
    expect(returnLocation({ id: 'ps_1', returnUrl: 'https://a.example/p?status=old&session=old' }, SessionStatus.Open)).toBe('https://a.example/p?status=open&session=ps_1');
    for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'vbscript:x', 'blob:https://a/x', 'file:///etc/passwd', 'about:blank', 'not a url']) {
      expect(returnLocation({ id: 'ps_1', returnUrl: url }, SessionStatus.Open), url).toBeUndefined();
    }
    expect(returnLocation({ id: 'ps_1' }, SessionStatus.Open)).toBeUndefined();
  });
});
