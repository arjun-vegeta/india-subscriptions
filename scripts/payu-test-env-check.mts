// Live check of the PayU adapter against PayU's TEST environment. Prints a pass/fail table.
//
//   PAYU_TEST_KEY=... PAYU_TEST_SALT=... npx tsx scripts/payu-test-env-check.mts
//
// - The key and salt come only from PAYU_TEST_KEY / PAYU_TEST_SALT. There are no defaults in this file. PayU prints a
//   public test merchant in its documentation pages; use that one, never a production merchant.
// - Refuses to run unless the environment is test: PAYU_ENVIRONMENT, if set, must be "test"; the adapter is built with
//   Environment.Test; and every request is checked against an allow-list of PayU's test hosts before it is sent.
// - The salt is never printed (every line of output is scrubbed of it).
// - Non-interactive checks (hash acceptance per layout, command hashes, not-found shapes) always run. The browser flow
//   (card consent with PayU's 3-D Secure simulator, then verifyCheckout / pre-debit / debit) runs when Playwright can be
//   loaded; set PAYU_CHECK_SKIP_BROWSER=1 to skip it. It creates one INR 2.00 consent and one INR 1.00 test debit on the
//   test merchant: keep the volume modest, this is usually a shared public test merchant.
// - Behind an HTTPS-only proxy, set HTTPS_PROXY (and NODE_USE_ENV_PROXY=1 for Node's fetch). PayU's test flow redirects
//   to plain http://*.payubiz.in; those redirects are served over https by this script.
import http from 'node:http';
import { createRequire } from 'node:module';
import { CheckoutKind, Environment, ErrorCode, IntervalUnit, PaymentMethod } from '../src/constants.js';
import { SubscriptionError } from '../src/errors.js';
import { ConsentHashLayout, PAYU_API_URLS, PAYU_PAYMENT_URLS } from '../src/providers/payu/constants.js';
import { payu } from '../src/providers/payu/index.js';

const KEY = process.env.PAYU_TEST_KEY;
const SALT = process.env.PAYU_TEST_SALT;
const ALLOWED_HOSTS: readonly string[] = ['test.payu.in', 'apitest.payu.in'];
/** Hosts PayU's test checkout itself sends the browser to (3-D Secure simulator, response handler). Browser only. */
const BROWSER_HOST_PATTERN = /(^|\.)(payu\.in|payubiz\.in)$/;
const TEST_ENVIRONMENT = 'test';

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function refuse(reason: string): never {
  console.error(`payu-test-env-check: refusing to run: ${reason}`);
  process.exit(2);
}

if (!KEY || !SALT) refuse('PAYU_TEST_KEY and PAYU_TEST_SALT must both be set (PayU test merchant only)');
const requestedEnvironment = process.env.PAYU_ENVIRONMENT;
if (requestedEnvironment !== undefined && requestedEnvironment !== TEST_ENVIRONMENT) {
  refuse(`PAYU_ENVIRONMENT is "${requestedEnvironment}"; this script only runs against the test environment`);
}
for (const url of [PAYU_PAYMENT_URLS[Environment.Test], PAYU_API_URLS[Environment.Test]]) {
  if (!ALLOWED_HOSTS.includes(new URL(url).hostname)) refuse(`the adapter's test endpoint ${new URL(url).hostname} is not a PayU test host`);
}

const secretSalt: string = SALT;
const redact = (text: string): string => text.split(secretSalt).join('***');
const say = (line: string): void => console.log(redact(line));

/** The only way this script talks to PayU outside the browser: test hosts only, anything else throws before connecting. */
const guardedFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
  if (url.protocol !== 'https:' || !ALLOWED_HOSTS.includes(url.hostname)) {
    throw new Error(`blocked request to ${url.hostname}: only ${ALLOWED_HOSTS.join(', ')} are allowed`);
  }
  return fetch(input, init);
};

// ---------------------------------------------------------------------------
// Result table
// ---------------------------------------------------------------------------

type Verdict = 'PASS' | 'FAIL' | 'SKIP' | 'INFO';
interface Row {
  area: string;
  check: string;
  verdict: Verdict;
  detail: string;
}
const rows: Row[] = [];

function record(area: string, check: string, verdict: Verdict, detail: string): void {
  rows.push({ area, check, verdict, detail: redact(detail).replace(/\s+/g, ' ').slice(0, 150) });
}

async function attempt<T>(area: string, check: string, run: () => Promise<T>, judge: (value: T) => { ok: boolean; detail: string }): Promise<T | undefined> {
  try {
    const value = await run();
    const { ok, detail } = judge(value);
    record(area, check, ok ? 'PASS' : 'FAIL', detail);
    return value;
  } catch (error) {
    record(area, check, 'FAIL', `threw ${describe(error)}`);
    return undefined;
  }
}

/** The outcome of a call expected to be refused: judged on the error code, with PayU's message as detail. */
async function expectError(area: string, check: string, run: () => Promise<unknown>, accept: readonly ErrorCode[]): Promise<void> {
  try {
    const value = await run();
    record(area, check, 'FAIL', `no error; got ${JSON.stringify(value).slice(0, 100)}`);
  } catch (error) {
    if (error instanceof SubscriptionError) {
      const ok = accept.includes(error.code);
      record(area, check, ok ? 'PASS' : 'FAIL', `${error.code}${error.providerCode ? ` (${error.providerCode})` : ''}: ${error.message}`);
    } else {
      record(area, check, 'FAIL', `threw ${describe(error)}`);
    }
  }
}

function describe(error: unknown): string {
  if (error instanceof SubscriptionError) return `${error.code}: ${error.message}`;
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const providerFor = (extra: Record<string, unknown> = {}, now?: () => Date) =>
  payu(
    {
      key: KEY as string,
      salt: secretSalt,
      environment: Environment.Test,
      successUrl: 'https://example.com/payu/success',
      failureUrl: 'https://example.com/payu/failure',
      ...extra,
    },
    { fetch: guardedFetch, maxRetries: 0, ...(now ? { now } : {}) },
  );

const CUSTOMER = { name: 'Test User', email: 'test@example.com', phone: '9999999999' };
const PLAN = { name: 'Check run', amount: 10000, interval: { unit: IntervalUnit.Month, count: 1 } } as const;
const stamp = Date.now().toString(36);

// ---------------------------------------------------------------------------
// 1. Consent hash acceptance per layout (non-interactive)
// ---------------------------------------------------------------------------

/** Posts the consent form without a browser and reports whether PayU's payment page took it or printed a hash error. */
async function consentVerdict(fields: Record<string, string>, url: string): Promise<{ accepted: boolean; detail: string }> {
  let current = url;
  let response = await guardedFetch(current, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
    redirect: 'manual',
  });
  for (let hop = 0; hop < 5 && response.status >= 300 && response.status < 400; hop++) {
    current = new URL(response.headers.get('location') ?? '', current).toString();
    response = await guardedFetch(current, { redirect: 'manual' });
  }
  const html = await response.text();
  const text = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const hashError = /hash|checksum/i.exec(text);
  const landed = new URL(current);
  const accepted = landed.hostname === 'apitest.payu.in' && landed.pathname.startsWith('/public');
  const detail = accepted ? 'landed on the payment page' : hashError ? text.slice(Math.max(0, hashError.index - 40), hashError.index + 110) : text.slice(0, 110);
  return { accepted, detail };
}

async function checkConsentLayouts(): Promise<void> {
  const expected: Record<string, boolean> = {
    [ConsentHashLayout.SixPipes]: true,
    [ConsentHashLayout.FourPipes]: false,
    [ConsentHashLayout.FivePipes]: false,
  };
  for (const layout of Object.values(ConsentHashLayout)) {
    const provider = providerFor({ consentHashLayout: layout });
    try {
      const subscription = await provider.createSubscription({ plan: PLAN, customer: CUSTOMER, totalCycles: 3, upfrontAmount: 10000 });
      if (subscription.checkout?.kind !== CheckoutKind.FormPost) throw new Error('no form_post checkout');
      const verdict = await consentVerdict(subscription.checkout.fields, subscription.checkout.url);
      const shouldAccept = expected[layout] === true;
      const ok = verdict.accepted === shouldAccept;
      record(
        'consent hash',
        `${layout}: PayU ${shouldAccept ? 'accepts' : 'refuses'} it`,
        ok ? 'PASS' : 'FAIL',
        `${verdict.accepted ? 'accepted' : 'refused'}: ${verdict.detail}`,
      );
    } catch (error) {
      record('consent hash', layout, 'FAIL', `threw ${describe(error)}`);
    }
    await pause(1000);
  }
}

// ---------------------------------------------------------------------------
// 2. Command hashes and not-found shapes (non-interactive)
// ---------------------------------------------------------------------------

const NEVER_USED_MANDATE = '999000111222333';
const NEVER_USED_TXN = `probe_never_existed_${stamp}`;
/** What a refused-but-authenticated answer maps to. AUTH (a hash error) is never acceptable. */
const REFUSED_BUT_AUTHENTICATED = [ErrorCode.NotFound, ErrorCode.ProviderError, ErrorCode.Conflict, ErrorCode.Validation, ErrorCode.OutcomeUnknown];

async function checkCommands(): Promise<void> {
  const provider = providerFor();
  const debitAt = new Date(Date.now() + 3 * 86400e3).toISOString();

  await expectError('not found', 'verify_payment: unknown txnid is NOT_FOUND', () => provider.getCharge(`card:${NEVER_USED_MANDATE}`, NEVER_USED_TXN), [ErrorCode.NotFound]);
  for (const method of [PaymentMethod.Card, PaymentMethod.Upi, PaymentMethod.ENach]) {
    await expectError(
      'command hash',
      `mandate status (${method}): hash accepted, unknown mandate refused`,
      () => provider.getSubscription(`${method}:${NEVER_USED_MANDATE}`),
      REFUSED_BUT_AUTHENTICATED,
    );
    await pause(500);
  }
  await expectError(
    'command hash',
    'pre_debit_SI: hash accepted, unknown mandate refused',
    () => provider.notifyCharge({ subscriptionId: `upi:${NEVER_USED_MANDATE}`, notificationId: `n_probe_${stamp}`, amount: 10000, debitAt }),
    REFUSED_BUT_AUTHENTICATED,
  );
  await attempt(
    'command hash',
    'si_transaction: hash accepted, unknown mandate is a failed charge or a refusal',
    () =>
      provider
        .createCharge({ subscriptionId: `upi:${NEVER_USED_MANDATE}`, chargeId: `c_probe_${stamp}`, amount: 10000, invoiceNumber: `INVPROBE${stamp}`, customer: { email: 'test@example.com', phone: '9999999999' } })
        .then((charge) => ({ charge }), (error: unknown) => ({ error })),
    (value) => {
      if ('charge' in value) return { ok: value.charge.status === 'failed', detail: `charge ${value.charge.status} (${value.charge.failureReason ?? value.charge.providerStatus ?? ''})` };
      const error = value.error;
      const code = error instanceof SubscriptionError ? error.code : undefined;
      return { ok: code !== undefined && code !== ErrorCode.Auth, detail: describe(error) };
    },
  );
  await expectError('command hash', 'upi_mandate_revoke: hash accepted, unknown mandate refused', () => provider.cancelSubscription(`upi:${NEVER_USED_MANDATE}`), REFUSED_BUT_AUTHENTICATED);
  await expectError(
    'not found',
    'refund of an unknown charge is NOT_FOUND',
    () => provider.refundCharge({ subscriptionId: `upi:${NEVER_USED_MANDATE}`, chargeId: NEVER_USED_TXN, refundId: `r_probe_${stamp}`, amount: 100 }),
    [ErrorCode.NotFound],
  );
}

// ---------------------------------------------------------------------------
// 3. Browser flow: card consent, 3-D Secure simulator, verifyCheckout, pre-debit, debit
// ---------------------------------------------------------------------------

interface PlaywrightLike {
  chromium: { launch: (options?: Record<string, unknown>) => Promise<BrowserLike> };
}
interface BrowserLike {
  newContext: (options?: Record<string, unknown>) => Promise<ContextLike>;
  close: () => Promise<void>;
}
interface ContextLike {
  route: (pattern: RegExp, handler: (route: RouteLike) => Promise<void>) => Promise<void>;
  newPage: () => Promise<PageLike>;
  request: { fetch: (url: string, options: Record<string, unknown>) => Promise<ResponseLike> };
}
interface RouteLike {
  request: () => { url: () => string; method: () => string; headers: () => Record<string, string>; postDataBuffer: () => Buffer | null };
  fulfill: (options: Record<string, unknown>) => Promise<void>;
  abort: () => Promise<void>;
}
interface ResponseLike {
  status: () => number;
  headers: () => Record<string, string>;
  body: () => Promise<Buffer>;
}
interface PageLike {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  getByText: (text: string) => { first: () => { click: (options?: Record<string, unknown>) => Promise<void> } };
  getByRole: (role: string, options: Record<string, unknown>) => { click: () => Promise<void> };
  fill: (selector: string, value: string, options?: Record<string, unknown>) => Promise<void>;
  waitForURL: (pattern: RegExp, options?: Record<string, unknown>) => Promise<void>;
  keyboard: { press: (key: string) => Promise<void> };
}

function loadPlaywright(): PlaywrightLike | undefined {
  try {
    return createRequire(import.meta.url)('playwright') as PlaywrightLike;
  } catch {
    return undefined;
  }
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A tiny local server that is both the form launcher and PayU's `surl` / `furl`: it keeps what PayU posts. */
async function startCapture(): Promise<{ base: string; posts: Record<string, string>[]; launcher: (url: string, fields: Record<string, string>) => string; close: () => void }> {
  const posts: Record<string, string>[] = [];
  const pages = new Map<string, string>();
  const server = http.createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname;
      response.setHeader('content-type', 'text/html');
      if (path.startsWith('/launch/')) {
        response.end(pages.get(path) ?? '');
        return;
      }
      posts.push(Object.fromEntries(new URLSearchParams(body)));
      response.end('<html><body>captured</body></html>');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  const escape = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  return {
    base: `http://127.0.0.1:${port}`,
    posts,
    launcher: (url, fields) => {
      const path = `/launch/${pages.size}`;
      const inputs = Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join('');
      pages.set(path, `<html><body><form id="f" method="post" action="${escape(url)}">${inputs}</form><script>document.getElementById('f').submit()</script></body></html>`);
      return `http://127.0.0.1:${port}${path}`;
    },
    close: () => server.close(),
  };
}

async function payWithTestCard(playwright: PlaywrightLike, launchUrl: string, captured: Record<string, string>[]): Promise<void> {
  const proxy = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  const browser = await playwright.chromium.launch(proxy ? { proxy: { server: proxy, bypass: '127.0.0.1,localhost' } } : {});
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    // PayU's test flow redirects to plain http://*.payubiz.in; serve those hops (and their redirects) over https.
    const bridge = async (route: RouteLike): Promise<void> => {
      const request = route.request();
      const target = request.url().replace(/^http:/, 'https:');
      if (!BROWSER_HOST_PATTERN.test(new URL(target).hostname)) return route.abort();
      try {
        const headers = { ...request.headers() };
        delete headers.host;
        delete headers['content-length'];
        const answer = await context.request.fetch(target, { method: request.method(), headers, data: request.postDataBuffer() ?? undefined, maxRedirects: 0, failOnStatusCode: false });
        const out = { ...answer.headers() };
        for (const name of ['content-encoding', 'content-length', 'transfer-encoding', 'strict-transport-security']) delete out[name];
        if (out.location) out.location = out.location.replace(/^http:\/\/([^/]*(payu\.in|payubiz\.in))/, 'https://$1');
        await route.fulfill({ status: answer.status(), headers: out, body: await answer.body() });
      } catch {
        await route.abort();
      }
    };
    await context.route(/^https?:\/\/(test\.payu\.in|[^/]*\.payubiz\.in)\//, bridge);
    await context.route(/^http:\/\/[^/]*payu\.in\//, bridge);

    const page = await context.newPage();
    await page.goto(launchUrl, { waitUntil: 'domcontentloaded' });
    // PayU's documented test card (Mastercard) and 3-D Secure simulator OTP.
    await page.getByText('Cards (Credit/Debit)').first().click({ timeout: 45000 });
    await page.fill('#cardNumber', '5123456789012346');
    await page.fill('#cardExpiry', '0530');
    await page.fill('#cardCvv', '123');
    await page.fill('#cardOwnerName', 'Test User');
    await page.getByRole('button', { name: 'PROCEED' }).click();
    await page.waitForURL(/acssimuat/, { timeout: 60000 });
    await pause(1500);
    await page.fill('input[name=password]', '123456');
    await page.keyboard.press('Enter');
    for (let i = 0; i < 25 && captured.length === 0; i++) await pause(2000);
  } finally {
    await browser.close();
  }
}

async function checkBrowserFlow(): Promise<void> {
  if (process.env.PAYU_CHECK_SKIP_BROWSER === '1') return void record('browser flow', 'card consent to debit', 'SKIP', 'PAYU_CHECK_SKIP_BROWSER=1');
  const playwright = loadPlaywright();
  if (!playwright) return void record('browser flow', 'card consent to debit', 'SKIP', 'playwright is not installed');

  const capture = await startCapture();
  try {
    const provider = providerFor({ successUrl: `${capture.base}/s`, failureUrl: `${capture.base}/f` });
    const subscription = await provider.createSubscription({ plan: PLAN, customer: CUSTOMER, totalCycles: 3 });
    if (subscription.checkout?.kind !== CheckoutKind.FormPost) return void record('browser flow', 'createSubscription', 'FAIL', 'no form_post checkout');
    record('browser flow', 'createSubscription: signed consent form (free trial, INR 2.00)', 'PASS', `txnid ${subscription.id}, amount ${subscription.checkout.fields.amount ?? ''}`);

    try {
      await payWithTestCard(playwright, capture.launcher(subscription.checkout.url, subscription.checkout.fields), capture.posts);
    } catch (error) {
      return void record('browser flow', 'pay with the PayU test card', 'FAIL', `threw ${describe(error)}`);
    }
    const posted = capture.posts[capture.posts.length - 1];
    if (!posted) return void record('browser flow', 'pay with the PayU test card', 'FAIL', 'PayU never posted to surl / furl');
    record('browser flow', 'PayU posts the result to surl', 'PASS', `status=${posted.status} mode=${posted.mode} payment_source=${posted.payment_source} mihpayid=${posted.mihpayid} cardToken=${posted.cardToken ? 'present' : 'absent'}`);

    const verification = await attempt(
      'browser flow',
      'verifyCheckout: PayU\'s response hash is accepted',
      () => provider.verifyCheckout(posted),
      (value) => ({ ok: value.authorized && value.subscriptionId.startsWith(`${PaymentMethod.Card}:`), detail: `${value.status}, ${value.subscriptionId}` }),
    );
    if (!verification) return;
    await expectError('browser flow', 'verifyCheckout: a tampered amount is SIGNATURE_INVALID', () => provider.verifyCheckout({ ...posted, amount: '1.00' }), [ErrorCode.SignatureInvalid]);

    const mandate = verification.subscriptionId;
    // Observed 2026-11-17: the shared test merchant answers "Consent is Not Mandated" for a card mandate that
    // pre_debit_SI and si_transaction nevertheless accept. That is reported, not failed; any other refusal is a failure.
    try {
      const value = await provider.getSubscription(mandate);
      record('browser flow', 'getSubscription: mandate status of the new mandate', 'PASS', `status ${value.status} (${value.providerStatus ?? ''})`);
    } catch (error) {
      const notMandated = error instanceof SubscriptionError && error.code === ErrorCode.NotFound;
      record('browser flow', 'getSubscription: mandate status of the new mandate', notMandated ? 'INFO' : 'FAIL', describe(error));
    }

    const notificationId = `n_chk_${stamp}`;
    const debitAt = new Date(Date.now() + 2 * 86400e3).toISOString();
    const notification = await attempt(
      'browser flow',
      'notifyCharge (pre_debit_SI) on the real mandate',
      () => provider.notifyCharge({ subscriptionId: mandate, notificationId, amount: 100, debitAt }),
      (value) => ({ ok: value.accepted, detail: `accepted=${value.accepted} providerStatus=${value.providerStatus ?? ''} invoice=${value.invoiceNumber ?? ''}` }),
    );
    if (!notification) return;

    const chargeId = `c_chk_${stamp}`;
    const first = await attempt(
      'browser flow',
      'createCharge (si_transaction) on the real mandate',
      () => provider.createCharge({ subscriptionId: mandate, chargeId, amount: 100, invoiceNumber: notification.invoiceNumber, customer: { email: CUSTOMER.email, phone: CUSTOMER.phone } }),
      (value) => ({ ok: value.status !== 'failed', detail: `${value.status} (${value.providerStatus ?? ''}) payment id ${value.id}` }),
    );
    if (!first) return;
    await attempt(
      'browser flow',
      'createCharge again with the same chargeId does not debit twice',
      () => provider.createCharge({ subscriptionId: mandate, chargeId, amount: 100, invoiceNumber: notification.invoiceNumber }),
      (value) => ({ ok: value.id === first.id, detail: `payment id ${value.id} (first was ${first.id})` }),
    );
    await attempt(
      'browser flow',
      'getCharge: the debit by its merchant txnid',
      () => provider.getCharge(mandate, chargeId),
      (value) => ({ ok: value.id === first.id, detail: `${value.status} (${value.providerStatus ?? ''}) payment id ${value.id}` }),
    );
    record(
      'browser flow',
      'final debit state',
      'INFO',
      'PayU\'s test environment leaves a card debit "in progress" and marks it "dropped" after about 30 minutes; it never captures one',
    );
  } finally {
    capture.close();
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  say(`PayU test environment check (${PAYU_PAYMENT_URLS[Environment.Test]}, ${PAYU_API_URLS[Environment.Test]})`);
  await checkConsentLayouts();
  await checkCommands();
  await checkBrowserFlow();

  const widths = {
    area: Math.max(4, ...rows.map((row) => row.area.length)),
    check: Math.max(5, ...rows.map((row) => row.check.length)),
  };
  say('');
  say(`${'AREA'.padEnd(widths.area)}  ${'CHECK'.padEnd(widths.check)}  RESULT  DETAIL`);
  for (const row of rows) say(`${row.area.padEnd(widths.area)}  ${row.check.padEnd(widths.check)}  ${row.verdict.padEnd(6)}  ${row.detail}`);
  const failed = rows.filter((row) => row.verdict === 'FAIL').length;
  const passed = rows.filter((row) => row.verdict === 'PASS').length;
  say('');
  say(`${passed} passed, ${failed} failed, ${rows.filter((row) => row.verdict === 'SKIP').length} skipped`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(redact(`payu-test-env-check: ${describe(error)}`));
  process.exit(2);
});
