/**
 * The hosted checkout: public pages for a client that cannot run the browser helper (the Android alternative payment
 * opens `GET /checkout/{sessionId}` in a browser tab).
 *
 * `GET /checkout/{sessionId}` performs the checkout step of the session's gateway option. `GET` and `POST
 * /checkout/{sessionId}/return` is where the gateway (or the page's own script) sends the customer back: it gathers the
 * query and form fields, asks `purchases.complete` to verify them with the gateway, and sends the customer to the
 * `returnUrl` the session was started with.
 *
 * This is a hostile-input surface and is built as one:
 * - The session id in the path is the only credential. An unknown id and an expired session both answer 404 with the
 *   same empty page, so neither can be told from the other, or from a mistyped path.
 * - Nothing the session or the request carries is written into HTML unescaped. The page's data goes into a JSON block
 *   that is never executed (`<`, `>`, `&` and the line separators escaped), the scripts are fixed text per instruction
 *   kind and allowed by their SHA-256 in the Content-Security-Policy, and a form's fields are escaped as attribute values.
 * - The Content-Security-Policy starts from `default-src 'none'` and adds only what the gateway of this page needs: its
 *   script host, its frames and connections, and its form target. No page holds a secret: the instruction is what the
 *   customer's browser is allowed to know (the Razorpay key id, a payment session id, the hashed form fields).
 * - The return endpoint never trusts what it is given. It verifies through `purchases.complete`, which asks the gateway,
 *   takes the provider from the session (never from the request) and only ever redirects to the `returnUrl` stored on
 *   the session, with `session` and `status` appended. Whatever happens in verification, the customer leaves with the
 *   session's own status, never a status taken from the request.
 */
import { createHash } from 'node:crypto';
import { CASHFREE_MODE } from '../checkout/cashfree.js';
import { PayUPaymentField } from '../providers/payu/constants.js';
import { ScriptUrl } from '../checkout/constants.js';
import { CheckoutKind, ContentType, ErrorCode, HashAlgorithm, HeaderName, ProductKind, Provider, SalesChannel } from '../constants.js';
import { ProviderSchema } from '../schemas.js';
import { SessionStatus } from '../purchase/constants.js';
import type { Purchases } from '../purchase/purchases.js';
import type { PurchaseOption, PurchaseSession } from '../purchase/schemas.js';
import { isSubscriptionError } from '../errors.js';
import { HeaderValue, HttpStatus, ServerHeader } from './constants.js';

/** The `id` attributes the page scripts look up. */
const Element = {
  Data: 'd',
  Message: 'm',
  Form: 'f',
  Retry: 'r',
} as const;

/** Schemes a return URL may never have: they run code or show content instead of returning to an app or a page. */
const BLOCKED_REDIRECT_PROTOCOLS: readonly string[] = ['javascript:', 'data:', 'vbscript:', 'blob:', 'file:', 'about:'];
const WEB_PROTOCOLS: readonly string[] = ['https:', 'http:'];

/** The query parameters appended to the return URL. */
export const ReturnParam = {
  Session: 'session',
  Status: 'status',
} as const;

/** What the page says. Fixed text: nothing from the session or the request is ever part of it. */
const Text = {
  Title: 'Complete your payment',
  Working: 'Taking you to the payment page',
  Noscript: 'This page needs JavaScript to continue.',
  Continue: 'Continue to the payment page',
  Failed: 'The payment page could not be opened. Close this window and try again from the app.',
  Retry: 'Try again',
  NotFound: 'Not found',
  Done: 'You can close this window and go back to the app.',
} as const;

const RETURN_MESSAGE: Record<SessionStatus, string> = {
  [SessionStatus.Completed]: 'Your payment is complete.',
  [SessionStatus.AwaitingPayment]: 'Your payment is being confirmed.',
  [SessionStatus.Open]: 'Your payment was not completed.',
  [SessionStatus.Failed]: 'Your payment did not go through.',
  [SessionStatus.Expired]: 'This payment session has expired.',
};

const STYLE =
  'body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:2rem 1rem;color:#1a1a1a;background:#fff}' +
  'main{max-width:28rem;margin:0 auto;text-align:center}h1{font-size:1.25rem}' +
  'button,a.b{font:inherit;padding:.6rem 1.2rem;border:0;border-radius:.4rem;background:#1a1a1a;color:#fff;text-decoration:none;cursor:pointer}' +
  '[hidden]{display:none}';

// One small fixed script per instruction kind. Each is allowed by its hash, so the policy needs no `unsafe-inline` for script.
const REDIRECT_SCRIPT = `var d=JSON.parse(document.getElementById('${Element.Data}').textContent);location.replace(d.url);`;

const FORM_SCRIPT = `HTMLFormElement.prototype.submit.call(document.getElementById('${Element.Form}'));`;

const RAZORPAY_SCRIPT =
  `(function(){var d=JSON.parse(document.getElementById('${Element.Data}').textContent);` +
  `var m=document.getElementById('${Element.Message}');var b=document.getElementById('${Element.Retry}');` +
  `var back=location.pathname.replace(/\\/$/,'')+'/return';` +
  // The handler's result goes back to the return endpoint as query fields: a navigation, which the form-action rule does not govern.
  `function go(f){var q=new URLSearchParams();for(var k in f){if(Object.prototype.hasOwnProperty.call(f,k)&&typeof f[k]==='string')q.append(k,f[k]);}location.assign(back+'?'+q.toString());}` +
  `function shown(){m.hidden=false;b.hidden=false;}` +
  `if(typeof Razorpay!=='function'){m.hidden=false;return;}` +
  `var o={key:d.keyId,modal:{ondismiss:shown}};` +
  `if(d.orderId){o.order_id=d.orderId;o.amount=d.amount;o.currency='INR';}else{o.subscription_id=d.subscriptionId;}` +
  `if(d.callbackUrl){o.callback_url=d.callbackUrl;}else{o.handler=go;}` +
  `if(d.prefill){o.prefill=d.prefill;}` +
  `function open(){var r=new Razorpay(o);r.on('payment.failed',function(){shown();r.close();});r.open();}` +
  `b.onclick=function(){m.hidden=true;b.hidden=true;open();};open();})();`;

const CASHFREE_SCRIPT =
  `(function(){var d=JSON.parse(document.getElementById('${Element.Data}').textContent);` +
  `var m=document.getElementById('${Element.Message}');` +
  `if(typeof Cashfree!=='function'){m.hidden=false;return;}` +
  `var c=Cashfree({mode:d.mode});` +
  `var o=d.oneTime?{paymentSessionId:d.sessionId,redirectTarget:'_self'}:{subsSessionId:d.sessionId,redirectTarget:'_self'};` +
  `Promise.resolve(d.oneTime?c.checkout(o):c.subscriptionsCheckout(o)).then(function(r){if(r&&r.error)m.hidden=false;},function(){m.hidden=false;});})();`;

/** What a gateway's page loads and talks to; everything else stays denied. */
const RAZORPAY_ORIGIN = 'https://*.razorpay.com';
const CASHFREE_ORIGIN = 'https://*.cashfree.com';

function sha256Source(text: string): string {
  return `'sha256-${createHash(HashAlgorithm.Sha256).update(text, 'utf8').digest('base64')}'`;
}

interface PageKind {
  /** The script that runs the step. */
  script: string;
  /** Extra `<script src>` the page loads first. */
  external?: string;
  /** Content-Security-Policy directives beyond the common ones. */
  policy: string[];
  /** The page body, between the heading and the data. */
  body: string;
}

/** A page ready to render: its kind and the data its script reads. */
interface Page extends PageKind {
  data: unknown;
}

function policy(directives: string[]): string {
  return directives.join('; ');
}

/** The common part of every policy: nothing is allowed unless a directive below says so. */
function basePolicy(scriptSources: string[], styleSources: string[]): string[] {
  return [
    `default-src 'none'`,
    `base-uri 'none'`,
    `frame-ancestors 'none'`,
    `script-src ${scriptSources.join(' ')}`,
    `style-src ${styleSources.join(' ')}`,
  ];
}

const STYLE_HASH = sha256Source(STYLE);

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/`/g, '&#96;');
}

/** JSON for a `<script type="application/json">` block: it can neither close the block nor start a comment. */
export function jsonForScript(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function isWebUrl(value: string): boolean {
  try {
    return WEB_PROTOCOLS.includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function originOf(value: string): string {
  return new URL(value).origin;
}

/** The headers every page of the hosted checkout carries, whatever it shows. */
function pageHeaders(contentPolicy: string): Headers {
  const headers = new Headers();
  headers.set(HeaderName.ContentType, HeaderValue.HtmlUtf8);
  headers.set(ServerHeader.CacheControl, HeaderValue.NoStore);
  headers.set(ServerHeader.ContentTypeOptions, HeaderValue.NoSniff);
  headers.set(ServerHeader.ContentSecurityPolicy, contentPolicy);
  headers.set(ServerHeader.ReferrerPolicy, HeaderValue.StrictOriginWhenCrossOrigin);
  headers.set(ServerHeader.FrameOptions, HeaderValue.FrameDeny);
  return headers;
}

function document(title: string, body: string, scripts: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">' +
    `<title>${escapeHtml(title)}</title><style>${STYLE}</style></head><body><main>${body}</main>${scripts}</body></html>`
  );
}

/** The plain page: no script, only the page's own style. */
function plainResponse(status: number, title: string, message: string): Response {
  const contentPolicy = policy(basePolicy([`'none'`], [STYLE_HASH]));
  return new Response(document(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`, ''), {
    status,
    headers: pageHeaders(contentPolicy),
  });
}

/** 404 for an unknown session, an expired one and a session with nothing to do here: the same page for all of them. */
export function checkoutNotFound(): Response {
  return plainResponse(HttpStatus.NotFound, Text.NotFound, '');
}

// ---------------------------------------------------------------------------
// GET /checkout/{sessionId}
// ---------------------------------------------------------------------------

/** Builds the page for the instruction of `option`, or undefined when this page cannot perform it. */
function pageFor(option: PurchaseOption): Page | undefined {
  const instruction = option.checkout;
  switch (instruction.kind) {
    case CheckoutKind.Redirect:
      if (!isWebUrl(instruction.url)) return undefined;
      return {
        script: REDIRECT_SCRIPT,
        data: { url: instruction.url },
        policy: [],
        body: `<noscript><p>${Text.Noscript}</p><p><a class="b" href="${escapeHtml(instruction.url)}">${Text.Continue}</a></p></noscript>`,
      };
    case CheckoutKind.FormPost: {
      if (!isWebUrl(instruction.url)) return undefined;
      const inputs = Object.entries(instruction.fields)
        .map(([name, value]) => `<input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(value)}">`)
        .join('');
      return {
        script: FORM_SCRIPT,
        data: {},
        // The form may go to its own gateway and back to this service, nowhere else.
        policy: [`form-action 'self' ${originOf(instruction.url)}`],
        body:
          `<form id="${Element.Form}" method="post" action="${escapeHtml(instruction.url)}">${inputs}` +
          `<noscript><p>${Text.Noscript}</p><button type="submit">${Text.Continue}</button></noscript></form>`,
      };
    }
    case CheckoutKind.RazorpayCheckout: {
      const prefill = instruction.prefill;
      const fields = prefill
        ? {
            ...(prefill.name !== undefined ? { name: prefill.name } : {}),
            ...(prefill.email !== undefined ? { email: prefill.email } : {}),
            ...(prefill.phone !== undefined ? { contact: prefill.phone } : {}),
          }
        : undefined;
      return {
        script: RAZORPAY_SCRIPT,
        external: ScriptUrl.RazorpayCheckout,
        data: {
          keyId: instruction.keyId,
          ...(instruction.subscriptionId !== undefined ? { subscriptionId: instruction.subscriptionId } : {}),
          ...(instruction.orderId !== undefined ? { orderId: instruction.orderId } : {}),
          ...(instruction.amount !== undefined ? { amount: instruction.amount } : {}),
          ...(instruction.callbackUrl !== undefined ? { callbackUrl: instruction.callbackUrl } : {}),
          ...(fields && Object.keys(fields).length > 0 ? { prefill: fields } : {}),
        },
        // Standard Checkout loads from checkout.razorpay.com, opens frames and talks to Razorpay's hosts, and styles its own modal.
        policy: [
          `frame-src ${RAZORPAY_ORIGIN}`,
          `connect-src ${RAZORPAY_ORIGIN}`,
          `img-src ${RAZORPAY_ORIGIN} data:`,
          `font-src ${RAZORPAY_ORIGIN} data:`,
          `form-action 'self' ${RAZORPAY_ORIGIN}`,
        ],
        body: `<p id="${Element.Message}" hidden>${Text.Failed}</p><button id="${Element.Retry}" type="button" hidden>${Text.Retry}</button><noscript><p>${Text.Noscript}</p></noscript>`,
      };
    }
    case CheckoutKind.CashfreeCheckout:
      return {
        script: CASHFREE_SCRIPT,
        external: ScriptUrl.Cashfree,
        data: {
          sessionId: instruction.sessionId,
          mode: CASHFREE_MODE[instruction.environment],
          oneTime: instruction.productKind === ProductKind.OneTime,
        },
        policy: [
          `frame-src ${CASHFREE_ORIGIN}`,
          `connect-src ${CASHFREE_ORIGIN}`,
          `img-src ${CASHFREE_ORIGIN} data:`,
          `font-src ${CASHFREE_ORIGIN} data:`,
          `form-action 'self' ${CASHFREE_ORIGIN}`,
        ],
        body: `<p id="${Element.Message}" hidden>${Text.Failed}</p><noscript><p>${Text.Noscript}</p></noscript>`,
      };
    default:
      // A store instruction starts on the device: there is nothing for a browser page to do.
      return undefined;
  }
}

/** The gateway option of a session: the one a browser can pay with. */
export function gatewayOption(session: PurchaseSession): PurchaseOption | undefined {
  return session.options.find((option) => option.channel === SalesChannel.Gateway);
}

/**
 * The hosted checkout page of a session. Answers 404 (the same empty page) for a session that has no gateway option, one
 * that is expired or completed, and one whose instruction a browser cannot perform.
 */
export function renderCheckout(session: PurchaseSession): Response {
  if (session.status === SessionStatus.Expired || session.status === SessionStatus.Completed) return checkoutNotFound();
  const option = gatewayOption(session);
  const page = option ? pageFor(option) : undefined;
  if (!page) return checkoutNotFound();

  const scriptSources = [sha256Source(page.script)];
  // Gateway pages style their own modal: allow inline style there, never inline script.
  const styleSources = page.external ? [`'self'`, `'unsafe-inline'`] : [STYLE_HASH];
  if (page.external) scriptSources.push(new URL(page.external).origin);
  const contentPolicy = policy([...basePolicy(scriptSources, styleSources), ...page.policy]);

  const heading = `<h1>${Text.Working}</h1>`;
  const data = `<script type="application/json" id="${Element.Data}">${jsonForScript(page.data)}</script>`;
  const external = page.external ? `<script src="${escapeHtml(page.external)}"></script>` : '';
  const scripts = `${data}${external}<script>${page.script}</script>`;
  return new Response(document(Text.Title, `${heading}${page.body}`, scripts), { status: HttpStatus.Ok, headers: pageHeaders(contentPolicy) });
}

// ---------------------------------------------------------------------------
// GET and POST /checkout/{sessionId}/return
// ---------------------------------------------------------------------------

/**
 * The field in which a gateway posts back the merchant's own transaction id, for the gateways that can be sent to a return
 * address without the session id in it (PayU limits its return URLs to 50 characters; its `txnid` is the `reference` the
 * purchase was created with). Only these providers have a provider-level return route.
 */
export const GATEWAY_RETURN_ID_FIELD: Readonly<Partial<Record<Provider, string>>> = {
  [Provider.PayU]: PayUPaymentField.Txnid,
};

/** The most fields and the longest value taken from a return: a customer's browser can send anything. */
const MAX_RETURN_FIELDS = 100;
const MAX_RETURN_VALUE_LENGTH = 8192;

/**
 * The checkout result the customer's browser brought back: the query fields, then the form fields (a gateway posts a
 * form, Razorpay's callback and a PayU return both do). Text values only; a JSON body of strings is read too.
 */
export function gatherReturnFields(query: URLSearchParams, body: string, contentType: string | null): Record<string, string> {
  const fields: Record<string, string> = {};
  const add = (name: string, value: unknown): void => {
    if (typeof value !== 'string' || value.length > MAX_RETURN_VALUE_LENGTH) return;
    if (!(name in fields) && Object.keys(fields).length >= MAX_RETURN_FIELDS) return;
    // Own properties only: a field called `__proto__` is just a field.
    Object.defineProperty(fields, name, { value, enumerable: true, writable: true, configurable: true });
  };
  query.forEach((value, name) => add(name, value));
  const type = (contentType ?? '').split(';')[0]?.trim().toLowerCase();
  if (body !== '' && type === ContentType.Form) {
    new URLSearchParams(body).forEach((value, name) => add(name, value));
  } else if (body !== '' && type === ContentType.Json) {
    try {
      const parsed: unknown = JSON.parse(body);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [name, value] of Object.entries(parsed)) add(name, value);
      }
    } catch {
      // Not JSON: there is nothing to read.
    }
  }
  return fields;
}

/** The session's `returnUrl` with `session` and `status` appended, or undefined when it is absent or must not be redirected to. */
export function returnLocation(
  session: Pick<PurchaseSession, 'id' | 'returnUrl'>,
  status: SessionStatus,
  /** False leaves the session id out: a return that could not be verified must not hand the id to whoever asked. */
  includeSession = true,
): string | undefined {
  if (session.returnUrl === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(session.returnUrl);
  } catch {
    return undefined;
  }
  if (BLOCKED_REDIRECT_PROTOCOLS.includes(url.protocol)) return undefined;
  if (includeSession) url.searchParams.set(ReturnParam.Session, session.id);
  else url.searchParams.delete(ReturnParam.Session);
  url.searchParams.set(ReturnParam.Status, status);
  return url.toString();
}

/**
 * Completes the session with what the browser brought back, then sends the customer on. Verification is the library's
 * (`purchases.complete` asks the gateway about the order this session created, and refuses a result for another order),
 * so a forged or replayed field cannot change the outcome; at worst the customer leaves with the status the session
 * already had.
 */
export async function handleCheckoutReturn(
  purchases: Pick<Purchases, 'get' | 'complete'>,
  sessionId: string,
  fields: Record<string, string>,
  /** Set by the provider-level route: the session must have its gateway option at this provider. */
  expectedProvider?: Provider,
): Promise<Response> {
  let session: PurchaseSession;
  try {
    session = await purchases.get(sessionId);
  } catch (error) {
    if (isSubscriptionError(error) && error.code === ErrorCode.NotFound) return checkoutNotFound();
    throw error;
  }
  const option = gatewayOption(session);
  if (!option || (expectedProvider !== undefined && option.provider !== expectedProvider)) return checkoutNotFound();

  let settled = session;
  let verified = true;
  try {
    settled = await purchases.complete(sessionId, { provider: option.provider, result: fields });
  } catch (error) {
    // The verification failed (a result for another order, a gateway that did not answer): the session keeps its own state,
    // and a webhook may still settle it. The customer is told that state, never anything from the request.
    if (!isSubscriptionError(error)) throw error;
    verified = false;
    settled = await purchases.get(sessionId).catch(() => session);
  }

  // The provider-level return finds the session by an id a customer's browser supplies, so a return that did not verify
  // does not hand the session id back: the app that started the session has it already.
  const location = returnLocation(settled, settled.status, verified || expectedProvider === undefined);
  if (location === undefined) return plainResponse(HttpStatus.Ok, Text.Title, `${RETURN_MESSAGE[settled.status]} ${Text.Done}`);
  const headers = new Headers();
  headers.set(ServerHeader.Location, location);
  headers.set(ServerHeader.CacheControl, HeaderValue.NoStore);
  headers.set(ServerHeader.ReferrerPolicy, HeaderValue.StrictOriginWhenCrossOrigin);
  return new Response(null, { status: HttpStatus.SeeOther, headers });
}

/** The longest transaction id looked up: gateways' ids are short, and the id comes from a customer's browser. */
const MAX_GATEWAY_ID_LENGTH = 128;

/**
 * The provider-level return: a gateway that posts back the merchant's transaction id (see `GATEWAY_RETURN_ID_FIELD`) is sent
 * to one fixed address for all sessions. The session is found by that id, and from there the return is exactly the session
 * return: `purchases.complete` verifies with the gateway and the customer is redirected only to the stored `returnUrl`. A
 * provider without a return id field, a missing field and an id that belongs to no session all answer the same empty 404.
 */
export async function handleGatewayCheckoutReturn(
  purchases: Pick<Purchases, 'get' | 'complete' | 'findByGatewayId'>,
  rawProvider: string,
  fields: Record<string, string>,
): Promise<Response> {
  const provider = ProviderSchema.safeParse(rawProvider);
  const field = provider.success ? GATEWAY_RETURN_ID_FIELD[provider.data] : undefined;
  if (!provider.success || field === undefined) return checkoutNotFound();
  const id = fields[field];
  if (id === undefined || id === '' || id.length > MAX_GATEWAY_ID_LENGTH) return checkoutNotFound();
  const session = await purchases.findByGatewayId(provider.data, id);
  if (!session) return checkoutNotFound();
  return handleCheckoutReturn(purchases, session.id, fields, provider.data);
}
