/**
 * Seam 21: the hosted checkout with PayU, through the real service (`runServe`), the purchase module and the real PayU and
 * Cashfree adapters. PayU limits its return URLs to 50 characters, so it is given one fixed return address for every session
 * (`/checkout/return/payu`); PayU posts the merchant's transaction id back and the session is found by it. When the public URL
 * is too long even for that, PayU refuses the purchase and the next gateway takes it.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Environment, ErrorCode, Provider } from '../../src/constants.js';
import type { FetchLike } from '../../src/http.js';
import { EnvVar } from '../../src/service-config.js';
import { runServe, silentLogger, type RunningService } from '../../src/service.js';
import { CREATE_ORDER_RESPONSE } from '../cashfree/payment-fixtures.js';
import { PAYU_ACCOUNT, signedPayuForm } from './helpers.js';

const API_KEY = 'integration-api-key-0123456789';
const COINS = { key: 'coins-100', kind: 'one_time', name: '100 coins', amount: 9900 };
const APP_RETURN = 'myapp://purchase/done';
const CUSTOMER = { name: 'Asha', email: 'asha@example.com', phone: '9876543210' };
const authed = { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' };

/**
 * Cashfree creates orders on request. PayU is asked once per purchase whether it already holds the transaction id (the
 * payment API's `verify_payment`) and answers "Not Found" for a new one.
 */
const cashfreeOrders: FetchLike = async (url, init) => {
  if (new URL(url).host === 'test.payu.in') {
    const txnid = new URLSearchParams(String(init?.body)).get('var1') as string;
    const body = { status: 0, msg: '0 out of 1 Transactions Fetched Successfully', transaction_details: { [txnid]: { mihpayid: 'Not Found', status: 'Not Found' } } };
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  const request = JSON.parse(String(init?.body)) as { order_id: string; order_amount: number; order_meta: Record<string, string> };
  const order = { ...CREATE_ORDER_RESPONSE, order_id: request.order_id, order_amount: request.order_amount, order_meta: request.order_meta };
  return new Response(JSON.stringify(order), { status: 200, headers: { 'content-type': 'application/json' } });
};

let dir: string;
let running: RunningService | undefined;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'india-subscriptions-payu-hosted-'));
});
afterEach(async () => {
  await running?.stop();
  running = undefined;
  await rm(dir, { recursive: true, force: true });
});

async function serve(publicBaseUrl: string) {
  const purchasesFile = join(dir, 'purchases.json');
  await writeFile(purchasesFile, JSON.stringify({ catalog: [COINS], routing: { priority: [Provider.PayU, Provider.Cashfree] } }));
  running = await runServe({
    env: {
      [EnvVar.ApiKey]: API_KEY,
      [EnvVar.Port]: '0',
      [EnvVar.PayuKey]: PAYU_ACCOUNT.key,
      [EnvVar.PayuSalt]: PAYU_ACCOUNT.salt,
      [EnvVar.PayuEnvironment]: Environment.Test,
      [EnvVar.CashfreeClientId]: 'cf_client_id',
      [EnvVar.CashfreeClientSecret]: 'cf_client_secret_value',
      [EnvVar.CashfreeEnvironment]: Environment.Test,
      [EnvVar.PurchasesFile]: purchasesFile,
      [EnvVar.PurchaseStoreFile]: join(dir, 'state.json'),
      [EnvVar.PublicBaseUrl]: publicBaseUrl,
    },
    fetch: cashfreeOrders,
    logger: silentLogger,
  });
  const api = (method: string, path: string, init: { json?: unknown; form?: Record<string, string>; auth?: boolean } = {}) =>
    fetch(`${running!.url}${path}`, {
      method,
      redirect: 'manual',
      headers: {
        ...(init.auth === false ? {} : { authorization: `Bearer ${API_KEY}` }),
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.form !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : init.form !== undefined ? new URLSearchParams(init.form).toString() : undefined,
    });
  const start = async (customerRef = 'cust_1') => {
    const response = await api('POST', '/v1/purchases', { json: { platform: 'web', product: COINS.key, customer: CUSTOMER, customerRef, returnUrl: APP_RETURN } });
    expect(response.status).toBe(201);
    return (await response.json()) as { id: string; attempts: Array<{ provider: string; outcome: string; errorCode?: string; message?: string }>; options: Array<{ provider: string; handle: string; hostedUrl: string; checkout: { kind: string; url: string; fields: Record<string, string> } }> };
  };
  return { api, start };
}

/** What PayU posts to `surl` after a successful payment of the form the customer was sent: the form's fields, signed. */
function payuSuccess(fields: Record<string, string>): Record<string, string> {
  const { hash: _hash, phone: _phone, surl: _surl, furl: _furl, ...kept } = fields;
  return signedPayuForm({ ...kept, status: 'success', mihpayid: '403993715', mode: 'UPI', unmappedstatus: 'captured', addedon: '2026-11-23 15:30:00' }, PAYU_ACCOUNT.key, PAYU_ACCOUNT.salt);
}

describe('PayU on the hosted checkout', () => {
  it('is routed first, shown on the hosted page, returns through the fixed provider address and completes the session', async () => {
    const t = await serve('https://billing.example.com');
    const session = await t.start();
    const option = session.options[0]!;
    expect(session.attempts.map((a) => [a.provider, a.outcome])).toEqual([[Provider.PayU, 'created']]);
    expect(option).toMatchObject({ provider: Provider.PayU, hostedUrl: `https://billing.example.com/checkout/${session.id}`, checkout: { kind: 'form_post' } });
    // PayU's return address is short and the same for every session; its transaction id is the handle of the option.
    expect(option.checkout.fields.surl).toBe('https://billing.example.com/checkout/return/payu');
    expect(option.checkout.fields.furl).toBe('https://billing.example.com/checkout/return/payu');
    expect(option.checkout.fields.surl?.length).toBeLessThanOrEqual(50);
    expect(option.checkout.fields.txnid).toBe(option.handle);

    // The customer's browser opens the hosted page: a form for PayU, allowed to go to PayU and nowhere else.
    const page = await t.api('GET', `/checkout/${session.id}`, { auth: false });
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toContain(`form-action 'self' ${new URL(option.checkout.url).origin}`);
    const html = await page.text();
    expect(html).toContain(`action="${option.checkout.url}"`);
    expect(html).toContain(`name="txnid" value="${option.handle}"`);

    // PayU posts the signed result to the fixed address. The session is found by the transaction id and completed against
    // PayU's hash; the customer goes to the stored returnUrl.
    const back = await t.api('POST', '/checkout/return/payu', { auth: false, form: payuSuccess(option.checkout.fields) });
    expect(back.status).toBe(303);
    const location = new URL(back.headers.get('location') ?? '');
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(APP_RETURN);
    expect(location.searchParams.get('session')).toBe(session.id);
    expect(location.searchParams.get('status')).toBe('completed');

    const done = (await (await t.api('GET', `/v1/purchases/${session.id}`)).json()) as { status: string; provider: string; paymentId: string };
    expect(done).toMatchObject({ status: 'completed', provider: Provider.PayU, paymentId: option.handle });
    const owned = (await (await t.api('GET', '/v1/entitlements/cust_1')).json()) as { active: boolean; items: Array<Record<string, unknown>> };
    expect(owned.active).toBe(true);
    expect(owned.items[0]).toMatchObject({ product: COINS.key, provider: Provider.PayU, channel: 'gateway', platform: 'web' });
  });

  it('the provider route never trusts what it is given: a forged hash, an unknown id, another gateway\'s route and a missing id', async () => {
    const t = await serve('https://billing.example.com');
    const session = await t.start();
    const fields = session.options[0]!.checkout.fields;
    const good = payuSuccess(fields);

    // A result whose hash does not verify leaves the session open, and hands the session id to nobody.
    const forged = await t.api('POST', '/checkout/return/payu', { auth: false, form: { ...good, amount: '1.00' } });
    expect(forged.status).toBe(303);
    const forgedTo = new URL(forged.headers.get('location') ?? '');
    expect(forgedTo.searchParams.get('status')).toBe('open');
    expect(forgedTo.searchParams.has('session')).toBe(false);
    expect(`${forgedTo.protocol}//${forgedTo.host}${forgedTo.pathname}`).toBe(APP_RETURN);
    const still = (await (await t.api('GET', `/v1/purchases/${session.id}`)).json()) as { status: string };
    expect(still.status).toBe('open');

    // Nothing to find, or nothing that can be found by: the same empty 404.
    const bodies = new Set<string>();
    for (const attempt of [
      t.api('POST', '/checkout/return/payu', { auth: false, form: { ...good, txnid: 'pay_unknown' } }),
      t.api('POST', '/checkout/return/payu', { auth: false, form: {} }),
      t.api('GET', '/checkout/return/payu', { auth: false }),
      t.api('POST', '/checkout/return/payu', { auth: false, form: { txnid: 'x'.repeat(500) } }),
      t.api('POST', '/checkout/return/razorpay', { auth: false, form: good }),
      t.api('POST', '/checkout/return/cashfree', { auth: false, form: good }),
      t.api('POST', '/checkout/return/nonsense', { auth: false, form: good }),
    ]) {
      const response = await attempt;
      expect(response.status).toBe(404);
      bodies.add(await response.text());
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toContain(session.id);
    expect((await (await t.api('GET', `/v1/purchases/${session.id}`)).json() as { status: string }).status).toBe('open');
  });

  it('the query form works too: a gateway that returns with GET', async () => {
    const t = await serve('https://billing.example.com');
    const session = await t.start();
    const back = await t.api('GET', `/checkout/return/payu?${new URLSearchParams(payuSuccess(session.options[0]!.checkout.fields))}`, { auth: false });
    expect(back.status).toBe(303);
    expect(new URL(back.headers.get('location') ?? '').searchParams.get('status')).toBe('completed');
  });
});

describe('a public URL too long for PayU\'s 50 characters', () => {
  it('has PayU refuse the purchase (VALIDATION) and the next gateway take it', async () => {
    const t = await serve('https://billing-service.example.com');
    const session = await t.start();
    expect(session.attempts.map((a) => [a.provider, a.outcome, a.errorCode])).toEqual([
      [Provider.PayU, 'failed', ErrorCode.Validation],
      [Provider.Cashfree, 'created', undefined],
    ]);
    expect(session.options[0]).toMatchObject({ provider: Provider.Cashfree, hostedUrl: `https://billing-service.example.com/checkout/${session.id}` });
    expect(session.options[0]?.checkout).toMatchObject({ kind: 'cashfree_checkout' });
  });
});
