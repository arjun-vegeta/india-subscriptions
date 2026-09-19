import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  ChargeKind,
  ChargeStatus,
  ErrorCode,
  HttpMethod,
  PaymentMethod,
  RefundStatus,
  SchedulingMode,
  SubscriptionStatus,
} from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import type { ProviderOptions } from '../../src/provider.js';
import { ChargeSchema, PlanSchema, RefundSchema, SubscriptionSchema } from '../../src/schemas.js';
import { RazorpayNoteKey } from '../../src/providers/razorpay/constants.js';
import {
  RazorpayConfigSchema,
  RazorpayProvider,
  razorpay,
  type RazorpayConfig,
} from '../../src/providers/razorpay/index.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';

/*
 * Adapter tests: exact outgoing request (method, URL, auth header, JSON body,
 * paise untouched) and the normalised result, for every public method.
 * Response fixtures are the verbatim sample payloads from the Razorpay
 * documentation (page named above each one). Where a test needs a response
 * that differs from a sample, it overrides named fields of the verbatim sample
 * and says so. Request bodies that equal a documented curl sample say so too.
 * The refund API has no sample in the subscription docs: its response shape
 * follows the official Node SDK type (dist/types/refunds.d.ts).
 */

const BASE = 'https://api.razorpay.com';
const KEY_ID = 'test_key_id';
const KEY_SECRET = 'test_key_secret_value';
const WEBHOOK_SECRET = 'test_webhook_secret_value';
/** Computed here, not with the library's helper. */
const AUTH = `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`, 'utf8').toString('base64')}`;

/** `created_at` of the create-subscription sample: the pinned "now". */
const NOW_UNIX = 1773394958;
const NOW = new Date(NOW_UNIX * 1000);
const DAY = 86_400;

const iso = (unix: number) => new Date(unix * 1000).toISOString();
const json = (text: string) => JSON.parse(text) as Record<string, any>;

function setup(routes: MockRoute[], config: Partial<RazorpayConfig> = {}, options: ProviderOptions = {}) {
  const mock = mockFetch(routes);
  const provider = razorpay(
    { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: WEBHOOK_SECRET, ...config },
    { fetch: mock.fetch, now: () => NOW, maxRetries: 0, ...options },
  );
  (provider as unknown as { http: { sleep: () => Promise<void> } }).http.sleep = async () => {};
  return { provider, calls: mock.calls, remaining: mock.remaining };
}

function expectRequest(call: RecordedCall | undefined, method: HttpMethod, url: string, body?: unknown) {
  expect(call).toBeDefined();
  expect(call?.method).toBe(method);
  expect(call?.url).toBe(url);
  expect(call?.headers.authorization).toBe(AUTH);
  expect(call?.headers.accept).toBe('application/json');
  if (body === undefined) {
    expect(call?.body).toBeUndefined();
    expect(call?.headers['content-type']).toBeUndefined();
  } else {
    expect(call?.headers['content-type']).toBe('application/json');
    expect(call?.json).toEqual(body);
    // The exact bytes: no undefined placeholders, no extra keys.
    expect(call?.body).toBe(JSON.stringify(call?.json));
  }
}

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to reject');
}

const planResponse = (over: Record<string, unknown> = {}) => ({ ...json(CREATE_PLAN_RESPONSE), ...over });
const monthlyPlanResponse = (notes: Record<string, string> = {}) =>
  planResponse({ period: 'monthly', interval: 1, notes });
const subscriptionResponse = (over: Record<string, unknown> = {}) => ({ ...json(CREATE_SUBSCRIPTION_RESPONSE), ...over });

const route = (method: HttpMethod, path: string, body: unknown, status = 200): MockRoute => ({
  method,
  url: `${BASE}${path}`,
  status,
  json: body,
});

const DOC_NOTES = { notes_key_1: 'Tea, Earl Grey, Hot', notes_key_2: 'Tea, Earl Grey… decaf.' };
/** Verbatim sample, Razorpay docs: api__payments__subscriptions__create-plan.md (success sample). */
const CREATE_PLAN_RESPONSE = String.raw`{
  "id":"plan_00000000000001",
  "entity":"plan",
  "interval":1,
  "period":"weekly",
  "item":{
    "id":"item_00000000000001",
    "active":true,
    "name":"Test plan - Weekly",
    "description":"Description for the test plan - Weekly",
    "amount":69900,
    "unit_amount":69900,
    "currency":"INR",
    "type":"plan",
    "unit":null,
    "tax_inclusive":false,
    "hsn_code":null,
    "sac_code":null,
    "tax_rate":null,
    "tax_id":null,
    "tax_group_id":null,
    "created_at":1580219935,
    "updated_at":1580219935
  },
  "notes":{
    "notes_key_1":"Tea, Earl Grey, Hot",
    "notes_key_2":"Tea, Earl Grey… decaf."
  },
  "created_at":1580219935
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__create-subscription.md (success sample). */
const CREATE_SUBSCRIPTION_RESPONSE = String.raw`{
  "id": "sub_00000000000001",
  "entity": "subscription",
  "plan_id": "plan_00000000000001",
  "customer_email": null,
  "status": "created",
  "current_start": null,
  "current_end": null,
  "ended_at": null,
  "quantity": 1,
  "notes": {
      "notes_key_1": "Tea, Earl Grey, Hot",
      "notes_key_2": "Tea, Earl Grey… decaf."
  },
  "charge_at": 1773461489,
  "start_at": 1773461489,
  "end_at": 1776450600,
  "auth_attempts": 0,
  "total_count": 6,
  "paid_count": 0,
  "customer_notify": true,
  "created_at": 1773394958,
  "expire_by": 1773547889,
  "short_url": "https://rzp.io/rzp/Dqdqx3h",
  "has_scheduled_changes": false,
  "change_scheduled_at": null,
  "source": "api",
  "remaining_count": 6
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__fetch-subscription-id.md (success sample). */
const FETCH_SUBSCRIPTION_RESPONSE = String.raw`{
  "id": "sub_00000000000001",
  "entity": "subscription",
  "plan_id": "plan_00000000000001",
  "customer_id": "cust_D00000000000001",
  "status": "active",
  "current_start": 1577355871,
  "current_end": 1582655400,
  "ended_at": null,
  "quantity": 1,
  "notes":{
    "notes_key_1": "Tea, Earl Grey, Hot",
    "notes_key_2": "Tea, Earl Grey… decaf."
  },
  "charge_at": 1577385991,
  "start_at": 1577385991,
  "end_at": 1603737000,
  "auth_attempts": 0,
  "total_count": 6,
  "paid_count": 1,
  "customer_notify": true,
  "created_at": 1577356081,
  "expire_by": 1577485991,
  "short_url": "https://rzp.io/i/z3b1R61A9",
  "has_scheduled_changes": false,
  "change_scheduled_at": null,
  "source": "api",
  "offer_id":"offer_JHD834hjbxzhd38d",
  "remaining_count": 5
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__cancel-subscription.md (success sample). */
const CANCEL_RESPONSE = String.raw`{
  "id": "sub_00000000000001",
  "entity": "subscription",
  "plan_id": "plan_00000000000001",
  "customer_id": "cust_D00000000000001",
  "status": "cancelled",
  "current_start": 1580453311,
  "current_end": 1581013800,
  "ended_at": 1580288092,
  "quantity": 1,
  "notes":{
    "notes_key_1": "Tea, Earl Grey, Hot",
    "notes_key_2": "Tea, Earl Grey… decaf."
  },
  "charge_at": 1580453311,
  "start_at": 1577385991,
  "end_at": 1603737000,
  "auth_attempts": 0,
  "total_count": 6,
  "paid_count": 1,
  "customer_notify": true,
  "created_at": 1580283117,
  "expire_by": 1581013800,
  "short_url": "https://rzp.io/i/z3b1R61A9",
  "has_scheduled_changes": false,
  "change_scheduled_at": null,
  "source": "api",
  "offer_id":"offer_JHD834hjbxzhd38d",
  "remaining_count": 5
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__update-subscription.md (success sample). */
const UPDATE_RESPONSE = String.raw`{
  "id":"sub_00000000000002",
  "entity":"subscription",
  "plan_id":"plan_00000000000002",
  "customer_id":"cust_00000000000002",
  "status":"authenticated",
  "current_start":null,
  "current_end":null,
  "ended_at":null,
  "quantity":3,
  "notes":{
    "notes_key_1":"Tea, Earl Grey, Hot",
    "notes_key_2":"Tea, Earl Grey… decaf."
  },
  "charge_at":1580453311,
  "start_at":1580453311,
  "end_at":1606588200,
  "auth_attempts":0,
  "total_count":6,
  "paid_count":0,
  "customer_notify":true,
  "created_at":1580283807,
  "expire_by":1580626111,
  "short_url":"https://rzp.io/i/yeDkUKy",
  "has_scheduled_changes":false,
  "change_scheduled_at":null,
  "source": "api",
  "offer_id":"offer_JHD834hjbxzhd38d",
  "remaining_count":6
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__pause-subscription.md (success sample). */
const PAUSE_RESPONSE = String.raw`{
  "id": "sub_00000000000001",
  "entity": "subscription",
  "plan_id": "plan_00000000000001",
  "status": "paused",
  "current_start": null,
  "current_end": null,
  "ended_at": null,
  "quantity": 1,
  "notes":{
    "notes_key_1":"Tea, Earl Grey, Hot",
    "notes_key_2":"Tea, Earl Grey… decaf."
  },
  "charge_at": null,
  "start_at": 1580626111,
  "end_at": 1583433000,
  "auth_attempts": 0,
  "total_count": 6,
  "paid_count": 0,
  "customer_notify": true,
  "created_at": 1580280581,
  "paused_at": 1590280581,
  "expire_by": 1580626111,
  "pause_initiated_by": "self",
  "short_url": "https://rzp.io/i/z3b1R61A9",
  "has_scheduled_changes": false,
  "change_scheduled_at": null,
  "source": "api",
  "offer_id":"offer_JHD834hjbxzhd38d",
  "remaining_count": 6
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__resume-subscription.md (success sample). */
const RESUME_RESPONSE = String.raw`{
  "id": "sub_00000000000001",
  "entity": "subscription",
  "plan_id": "plan_00000000000001",
  "status": "active",
  "current_start": null,
  "current_end": null,
  "ended_at": null,
  "quantity": 1,
  "notes":{
    "notes_key_1":"Tea, Earl Grey, Hot",
    "notes_key_2":"Tea, Earl Grey… decaf."
  },
  "charge_at": 1580453311,
  "start_at": 1580626111,
  "end_at": 1583433000,
  "auth_attempts": 0,
  "total_count": 6,
  "paid_count": 0,
  "customer_notify": true,
  "created_at": 1580280581,
  "paused_at": 1590280581,
  "expire_by": 1580626111,
  "pause_initiated_by": null,
  "short_url": "https://rzp.io/i/z3b1R61A9",
  "has_scheduled_changes": false,
  "change_scheduled_at": null,
  "source": "api",
  "offer_id":"offer_JHD834hjbxzhd38d",
  "remaining_count": 6
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__fetch-invoices.md (India sample). */
const INVOICES_RESPONSE = String.raw`{
  "entity": "collection",
  "count": 2,
  "items": [
    {
      "id": "inv_00000000000003",
      "entity": "invoice",
      "receipt": null,
      "invoice_number": null,
      "customer_id": "cust_00000000000001",
      "customer_details": {
        "id": "cust_00000000000001",
        "name": null,
        "email": "<email>",
        "contact": "<phone>",
        "gstin": null,
        "billing_address": null,
        "shipping_address": null,
        "customer_name": null,
        "customer_email": "<email>",
        "customer_contact": "<phone>"
      },
      "order_id": "order_00000000000002",
      "subscription_id": "sub_00000000000001",
      "line_items": [
        {
          "id": "li_00000000000003",
          "item_id": null,
          "ref_id": null,
          "ref_type": null,
          "name": "Monthly Plan",
          "description": null,
          "amount": 99900,
          "unit_amount": 99900,
          "gross_amount": 99900,
          "tax_amount": 0,
          "taxable_amount": 99900,
          "net_amount": 99900,
          "currency": "INR",
          "type": "plan",
          "tax_inclusive": false,
          "hsn_code": null,
          "sac_code": null,
          "tax_rate": null,
          "unit": null,
          "quantity": 1,
          "taxes": []
        }
      ],
      "payment_id": "pay_00000000000002",
      "status": "paid",
      "expire_by": null,
      "issued_at": 1593344888,
      "paid_at": 1593344889,
      "cancelled_at": null,
      "expired_at": null,
      "sms_status": null,
      "email_status": null,
      "date": 1593344888,
      "terms": null,
      "partial_payment": false,
      "gross_amount": 99900,
      "tax_amount": 0,
      "taxable_amount": 99900,
      "amount": 99900,
      "amount_paid": 99900,
      "amount_due": 0,
      "currency": "INR",
      "currency_symbol": "₹",
      "description": null,
      "notes": [],
      "comment": null,
      "short_url": "https://rzp.io/i/Ys4feGqEp",
      "view_less": true,
      "billing_start": 1594405800,
      "billing_end": 1597084200,
      "type": "invoice",
      "group_taxes_discounts": false,
      "created_at": 1593344888,
      "idempotency_key": null
    },
    {
      "id": "inv_00000000000001",
      "entity": "invoice",
      "receipt": null,
      "invoice_number": null,
      "customer_id": "cust_00000000000001",
      "customer_details": {
        "id": "cust_00000000000001",
        "name": null,
        "email": "<email>",
        "contact": "<phone>",
        "gstin": null,
        "billing_address": null,
        "shipping_address": null,
        "customer_name": null,
        "customer_email": "<email>",
        "customer_contact": "<phone>"
      },
      "order_id": "order_00000000000001",
      "subscription_id": "sub_00000000000001",
      "line_items": [
        {
          "id": "li_00000000000001",
          "item_id": null,
          "ref_id": null,
          "ref_type": null,
          "name": "Monthly Plan",
          "description": null,
          "amount": 99900,
          "unit_amount": 99900,
          "gross_amount": 99900,
          "tax_amount": 0,
          "taxable_amount": 99900,
          "net_amount": 99900,
          "currency": "INR",
          "type": "plan",
          "tax_inclusive": false,
          "hsn_code": null,
          "sac_code": null,
          "tax_rate": null,
          "unit": null,
          "quantity": 1,
          "taxes": []
        },
        {
          "id": "li_00000000000002",
          "item_id": null,
          "ref_id": null,
          "ref_type": null,
          "name": "Delivery charges",
          "description": null,
          "amount": 30000,
          "unit_amount": 30000,
          "gross_amount": 30000,
          "tax_amount": 0,
          "taxable_amount": 30000,
          "net_amount": 30000,
          "currency": "INR",
          "type": "addon",
          "tax_inclusive": false,
          "hsn_code": null,
          "sac_code": null,
          "tax_rate": null,
          "unit": null,
          "quantity": 1,
          "taxes": []
        }
      ],
      "payment_id": "pay_00000000000001",
      "status": "paid",
      "expire_by": null,
      "issued_at": 1591878130,
      "paid_at": 1591878210,
      "cancelled_at": null,
      "expired_at": null,
      "sms_status": null,
      "email_status": null,
      "date": 1591878130,
      "terms": null,
      "partial_payment": false,
      "gross_amount": 129900,
      "tax_amount": 0,
      "taxable_amount": 129900,
      "amount": 129900,
      "amount_paid": 129900,
      "amount_due": 0,
      "currency": "INR",
      "currency_symbol": "₹",
      "description": null,
      "notes": [],
      "comment": null,
      "short_url": "https://rzp.io/i/nt5k3df",
      "view_less": true,
      "billing_start": 1591878205,
      "billing_end": 1594405800,
      "type": "invoice",
      "group_taxes_discounts": false,
      "created_at": 1591878130,
      "idempotency_key": null
    }
  ]
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__fetch-all-plans.md (failure sample). */
const API_KEY_ERROR = String.raw`{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "The api key provided is invalid",
    "source": "NA",
    "step": "NA",
    "reason": "NA",
    "metadata": {}
  }
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__cancel-subscription.md (failure sample). */
const CANCEL_EXPIRED_ERROR = String.raw`{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "Subscription is not cancellable in expired status.",
    "field": "status"
  }
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__create-subscription.md (failure sample). */
const FEATURE_NOT_ENABLED_ERROR = String.raw`{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "The requested URL was not found on the server.",
    "source": "NA",
    "step": "NA",
    "reason": "NA",
    "metadata": {}
  }
}`;

/** Verbatim sample, Razorpay docs: api__payments__subscriptions__update-subscription.md (failure sample). */
const UPDATE_UPI_ERROR = String.raw`{
  "error": {
    "code": "BAD_REQUEST_ERROR",
    "description": "subscriptions cannot be updated when payment mode is UPI"
  }
}`;

/** Verbatim sample, Razorpay docs: payments__subscriptions__integration-guide.md (failure response object). */
const CHECKOUT_FAILURE_ERROR = String.raw`{
"code": "BAD_REQUEST_ERROR",
"description": "Payment failed. Please contact the site admin",
"source": "business",
"step": "payment_initiation",
"reason": "amount_less_than_minimum_amount",
"metadata":{
},
"field": "amount"
}`;

/** Verbatim sample, Razorpay docs: webhooks__subscriptions.md subscription.charged. */
const WEBHOOK_CHARGED = String.raw`{
  "entity": "event",
  "account_id": "acc_BFQ7uQEaa7j2z7",
  "event": "subscription.charged",
  "contains": [
    "subscription",
    "payment"
  ],
  "payload": {
    "subscription": {
      "entity": {
        "id": "sub_DEX6xcJ1HSW4CR",
        "entity": "subscription",
        "plan_id": "plan_BvrFKjSxauOH7N",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "status": "active",
        "type": 2,
        "current_start": 1570213800,
        "current_end": 1572892200,
        "ended_at": null,
        "quantity": 1,
        "notes": {
          "Important": "Notes for Internal Reference"
        },
        "charge_at": 1572892200,
        "start_at": 1570213800,
        "end_at": 1599244200,
        "auth_attempts": 0,
        "total_count": 12,
        "paid_count": 1,
        "customer_notify": true,
        "created_at": 1567689895,
        "expire_by": 1567881000,
        "short_url": null,
        "has_scheduled_changes": false,
        "change_scheduled_at": null,
        "source": "api",
        "offer_id":"offer_JHD834hjbxzhd38d",
        "remaining_count": 11
      }
    },
    "payment": {
      "entity": {
        "id": "pay_DEXFWroJ6LikKT",
        "entity": "payment",
        "amount": 100000,
        "currency": "INR",
        "status": "captured",
        "order_id": "order_DEXFWXwO24pDxH",
        "invoice_id": "inv_DEXFWVuM6rPqlK",
        "international": false,
        "method": "card",
        "amount_refunded": 0,
        "amount_transferred": 0,
        "refund_status": null,
        "captured": "1",
        "description": "Recurring Payment via Subscription",
        "card_id": "card_DEXFX0KGtXexrH",
        "card": {
          "id": "card_DEXFX0KGtXexrH",
          "entity": "card",
          "name": "Gaurav Kumar",
          "last4": "5558",
          "network": "MasterCard",
          "type": "credit",
          "issuer": "KARB",
          "international": false,
          "emi": false,
          "expiry_month": 2,
          "expiry_year": 2022
        },
        "bank": null,
        "wallet": null,
        "vpa": null,
        "email": "gaurav.kumar@example.com",
        "contact": "+919876543210",
        "customer_id": "cust_C0WlbKhp3aLA7W",
        "token_id": null,
        "notes": [],
        "fee": 2900,
        "tax": 0,
        "error_code": null,
        "error_description": null,
        "created_at": 1567690382
      }
    }
  },
  "created_at": 1567690383
}`;


// ---------------------------------------------------------------------------
// Config, factory, capabilities
// ---------------------------------------------------------------------------

describe('configuration', () => {
  it('the factory validates the config and returns a RazorpayProvider', () => {
    const provider = razorpay({ keyId: KEY_ID, keySecret: KEY_SECRET }, { fetch: mockFetch([]).fetch });
    expect(provider).toBeInstanceOf(RazorpayProvider);
    expect(provider.name).toBe('razorpay');
  });

  it('defaults defaultDurationYears to 10 and keeps optional fields optional', () => {
    const parsed = RazorpayConfigSchema.parse({ keyId: KEY_ID, keySecret: KEY_SECRET });
    expect(parsed).toEqual({ keyId: KEY_ID, keySecret: KEY_SECRET, defaultDurationYears: 10 });
  });

  it.each([
    ['missing keyId', { keySecret: KEY_SECRET }, 'keyId'],
    ['empty keyId', { keyId: '', keySecret: KEY_SECRET }, 'keyId'],
    ['missing keySecret', { keyId: KEY_ID }, 'keySecret'],
    ['empty keySecret', { keyId: KEY_ID, keySecret: '' }, 'keySecret'],
    ['non-string keySecret', { keyId: KEY_ID, keySecret: 12345 }, 'keySecret'],
    ['empty webhookSecret', { keyId: KEY_ID, keySecret: KEY_SECRET, webhookSecret: '' }, 'webhookSecret'],
    ['bad baseUrl', { keyId: KEY_ID, keySecret: KEY_SECRET, baseUrl: 'not a url' }, 'baseUrl'],
    ['zero years', { keyId: KEY_ID, keySecret: KEY_SECRET, defaultDurationYears: 0 }, 'defaultDurationYears'],
    ['101 years', { keyId: KEY_ID, keySecret: KEY_SECRET, defaultDurationYears: 101 }, 'defaultDurationYears'],
    ['fractional years', { keyId: KEY_ID, keySecret: KEY_SECRET, defaultDurationYears: 2.5 }, 'defaultDurationYears'],
    ['not an object', 'rzp', '(root)'],
  ])('is CONFIG for %s and names the field without echoing values', (_name, config, field) => {
    let thrown: unknown;
    try {
      razorpay(config as unknown as RazorpayConfig, { fetch: mockFetch([]).fetch });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(SubscriptionError);
    expect((thrown as SubscriptionError).code).toBe(ErrorCode.Config);
    expect((thrown as SubscriptionError).message).toContain(field);
    expect((thrown as SubscriptionError).message).not.toContain(KEY_SECRET);
  });

  it('sends requests to a baseUrl override, with its trailing slash trimmed', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Get, url: 'https://proxy.example.com/rzp/v1/plans/plan_00000000000001', json: json(CREATE_PLAN_RESPONSE) }], {
      baseUrl: 'https://proxy.example.com/rzp/',
    });
    await provider.getPlan('plan_00000000000001');
    expect(calls[0]?.url).toBe('https://proxy.example.com/rzp/v1/plans/plan_00000000000001');
  });

  it('keeps secrets out of the provider object: not in JSON, not in console output', () => {
    const { provider } = setup([]);
    const dumps = [JSON.stringify(provider), inspect(provider, { depth: 6, showHidden: true }), String(Object.keys(provider))];
    for (const dump of dumps) {
      expect(dump).not.toContain(KEY_SECRET);
      expect(dump).not.toContain(WEBHOOK_SECRET);
      expect(dump).not.toContain(AUTH);
      expect(dump).not.toContain(Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'));
    }
  });
});

describe('capabilities', () => {
  it('describes Razorpay truthfully', () => {
    const { provider } = setup([]);
    expect(provider.capabilities).toEqual({
      provider: 'razorpay',
      scheduling: ['gateway'],
      gatewayPlans: true,
      trial: true,
      upfrontAmount: true,
      quantity: true,
      pause: true,
      resume: true,
      cancelAtPeriodEnd: true,
      changePlan: true,
      merchantCharges: false,
      merchantPreDebitNotification: false,
      listCharges: true,
      refunds: true,
      signedWebhooks: true,
      idempotencyKeys: false,
      paymentMethods: [PaymentMethod.Card, PaymentMethod.Upi, PaymentMethod.ENach],
    });
  });
});

describe('operations Razorpay does not offer', () => {
  it('createCharge and notifyCharge are UNSUPPORTED and send nothing', async () => {
    const { provider, calls } = setup([]);
    const charge = await failure(() =>
      provider.createCharge({ subscriptionId: 'sub_1', chargeId: 'c1', amount: 1000 }),
    );
    const notify = await failure(() =>
      provider.notifyCharge({ subscriptionId: 'sub_1', notificationId: 'n1', amount: 1000, debitAt: iso(NOW_UNIX + DAY) }),
    );
    expect(charge.code).toBe(ErrorCode.Unsupported);
    expect(notify.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

describe('createPlan', () => {
  it('POSTs /v1/plans with the documented curl sample body and maps the sample response', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/plans', json(CREATE_PLAN_RESPONSE))]);
    const plan = await provider.createPlan({
      name: 'Test plan - Weekly',
      description: 'Description for the test plan',
      amount: 69900,
      interval: { unit: 'week', count: 1 },
      metadata: DOC_NOTES,
    });
    // api__payments__subscriptions__create-plan.md, sample request.
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/plans`, {
      period: 'weekly',
      interval: 1,
      item: { name: 'Test plan - Weekly', amount: 69900, currency: 'INR', description: 'Description for the test plan' },
      notes: DOC_NOTES,
    });
    expect(plan).toMatchObject({
      provider: 'razorpay',
      id: 'plan_00000000000001',
      name: 'Test plan - Weekly',
      description: 'Description for the test plan - Weekly',
      amount: 69900,
      currency: 'INR',
      interval: { unit: 'week', count: 1 },
      scheduling: SchedulingMode.Gateway,
      createdAt: iso(1580219935),
      metadata: DOC_NOTES,
    });
    expect(plan.maxAmount).toBeUndefined();
    expect(plan.raw).toMatchObject({ id: 'plan_00000000000001', entity: 'plan' });
    expect(PlanSchema.safeParse(plan).success).toBe(true);
  });

  it.each([
    [{ unit: 'day', count: 7 }, 'daily', 7],
    [{ unit: 'day', count: 30 }, 'daily', 30],
    [{ unit: 'week', count: 2 }, 'weekly', 2],
    [{ unit: 'month', count: 1 }, 'monthly', 1],
    [{ unit: 'month', count: 3 }, 'monthly', 3],
    [{ unit: 'year', count: 1 }, 'yearly', 1],
  ] as const)('sends interval %j as period %s x %i', async (interval, period, count) => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/plans', json(CREATE_PLAN_RESPONSE))]);
    await provider.createPlan({ name: 'P', amount: 49900, interval });
    expect(calls[0]?.json).toMatchObject({ period, interval: count });
  });

  it('keeps the requested id and maxCycles in notes, and sends neither id, maxAmount nor scheduling as fields', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/plans', json(CREATE_PLAN_RESPONSE))]);
    await provider.createPlan({
      id: 'gold-monthly',
      name: 'Gold',
      amount: 49900,
      interval: { unit: 'month', count: 1 },
      maxAmount: 99900,
      maxCycles: 12,
      scheduling: SchedulingMode.Gateway,
      metadata: { tier: 'gold' },
    });
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/plans`, {
      period: 'monthly',
      interval: 1,
      item: { name: 'Gold', amount: 49900, currency: 'INR' },
      notes: { tier: 'gold', [RazorpayNoteKey.RequestedPlanId]: 'gold-monthly', [RazorpayNoteKey.PlanMaxCycles]: '12' },
    });
  });

  it('reads maxCycles back from the response notes', async () => {
    const response = planResponse({ notes: { [RazorpayNoteKey.PlanMaxCycles]: '12', tier: 'gold' } });
    const { provider } = setup([route(HttpMethod.Post, '/v1/plans', response)]);
    const plan = await provider.createPlan({ name: 'Gold', amount: 69900, interval: { unit: 'week', count: 1 }, maxCycles: 12 });
    expect(plan.maxCycles).toBe(12);
    expect(plan.metadata).toEqual({ tier: 'gold' });
  });

  it('rejects a daily plan under 7 days with a VALIDATION error that states the limit, before any request', async () => {
    const { provider, calls } = setup([]);
    const error = await failure(() => provider.createPlan({ name: 'Daily', amount: 10000, interval: { unit: 'day', count: 6 } }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('at least 7 days');
    expect(calls).toHaveLength(0);
  });

  it('lets exactly 7 days through (the docs say "minimum 7" and "greater than 7"; Razorpay decides)', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/plans', json(CREATE_PLAN_RESPONSE))]);
    await provider.createPlan({ name: 'Daily', amount: 10000, interval: { unit: 'day', count: 7 } });
    expect(calls).toHaveLength(1);
  });

  it('rejects an amount under 100 paise (INR 1.00) before any request, and passes 100 untouched', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/plans', json(CREATE_PLAN_RESPONSE))]);
    const error = await failure(() => provider.createPlan({ name: 'Tiny', amount: 99, interval: { unit: 'month', count: 1 } }));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('100 paise');
    expect(calls).toHaveLength(0);
    await provider.createPlan({ name: 'Min', amount: 100, interval: { unit: 'month', count: 1 } });
    expect((calls[0]?.json as { item: { amount: number } }).item.amount).toBe(100);
  });

  it('rejects shared-schema violations (fractional paise, maxAmount below amount) as VALIDATION', async () => {
    const { provider, calls } = setup([]);
    const fractional = await failure(() => provider.createPlan({ name: 'P', amount: 499.5, interval: { unit: 'month', count: 1 } }));
    const ceiling = await failure(() => provider.createPlan({ name: 'P', amount: 49900, maxAmount: 100, interval: { unit: 'month', count: 1 } }));
    expect(fractional.code).toBe(ErrorCode.Validation);
    expect(ceiling.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('refuses merchant scheduling as UNSUPPORTED', async () => {
    const { provider, calls } = setup([]);
    const error = await failure(() =>
      provider.createPlan({ name: 'P', amount: 49900, interval: { unit: 'month', count: 1 }, scheduling: SchedulingMode.Merchant }),
    );
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it('rejects metadata with a reserved key, and more than 15 notes, as VALIDATION', async () => {
    const { provider, calls } = setup([]);
    const reserved = await failure(() =>
      provider.createPlan({ name: 'P', amount: 49900, interval: { unit: 'month', count: 1 }, metadata: { [RazorpayNoteKey.Reference]: 'x' } }),
    );
    const tooMany = await failure(() =>
      provider.createPlan({
        name: 'P',
        amount: 49900,
        interval: { unit: 'month', count: 1 },
        metadata: Object.fromEntries(Array.from({ length: 16 }, (_, index) => [`k${index}`, 'v'])),
      }),
    );
    expect(reserved.code).toBe(ErrorCode.Validation);
    expect(tooMany.code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });
});

describe('getPlan', () => {
  it('GETs /v1/plans/{id}', async () => {
    const { provider, calls } = setup([route(HttpMethod.Get, '/v1/plans/plan_00000000000001', json(CREATE_PLAN_RESPONSE))]);
    const plan = await provider.getPlan('plan_00000000000001');
    expectRequest(calls[0], HttpMethod.Get, `${BASE}/v1/plans/plan_00000000000001`);
    expect(plan.id).toBe('plan_00000000000001');
  });

  it('reads a quarterly plan as three months and accepts an empty notes array', async () => {
    const { provider } = setup([route(HttpMethod.Get, '/v1/plans/plan_q', planResponse({ id: 'plan_q', period: 'quarterly', interval: 1, notes: [] }))]);
    const plan = await provider.getPlan('plan_q');
    expect(plan.interval).toEqual({ unit: 'month', count: 3 });
    expect(plan.metadata).toBeUndefined();
  });

  it('percent-encodes the id in the path', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Get, url: `${BASE}/v1/plans/a%2Fb%20c`, status: 400, json: json(API_KEY_ERROR) }]);
    await failure(() => provider.getPlan('a/b c'));
    expect(calls[0]?.url).toBe(`${BASE}/v1/plans/a%2Fb%20c`);
  });

  it('is VALIDATION for an empty id, with no request', async () => {
    const { provider, calls } = setup([]);
    expect((await failure(() => provider.getPlan(''))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it('is UNSUPPORTED for a plan in a currency this library does not model', async () => {
    const response = planResponse({ item: { ...json(CREATE_PLAN_RESPONSE).item, currency: 'USD' } });
    const { provider } = setup([route(HttpMethod.Get, '/v1/plans/plan_usd', response)]);
    expect((await failure(() => provider.getPlan('plan_usd'))).code).toBe(ErrorCode.Unsupported);
  });
});

// ---------------------------------------------------------------------------
// createSubscription
// ---------------------------------------------------------------------------

describe('createSubscription', () => {
  it('POSTs /v1/subscriptions with the documented curl sample body (free trial start_at and an upfront add-on) and returns checkout', async () => {
    const { provider, calls, remaining } = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
    const subscription = await provider.createSubscription({
      plan: 'plan_00000000000001',
      customer: { name: 'Gaurav Kumar', email: 'gaurav.kumar@example.com', phone: '9876543210' },
      totalCycles: 6,
      quantity: 1,
      notifyCustomer: true,
      startAt: iso(1773461489),
      upfrontAmount: 3000,
      upfrontLabel: 'Delivery charges',
      metadata: DOC_NOTES,
    });

    // api__payments__subscriptions__create-subscription.md, curl sample (minus expire_by, see the next test).
    expect(calls).toHaveLength(1);
    expect(remaining()).toBe(0);
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/subscriptions`, {
      plan_id: 'plan_00000000000001',
      total_count: 6,
      quantity: 1,
      customer_notify: true,
      start_at: 1773461489,
      addons: [{ item: { name: 'Delivery charges', amount: 3000, currency: 'INR' } }],
      notes: DOC_NOTES,
    });

    expect(subscription).toMatchObject({
      provider: 'razorpay',
      id: 'sub_00000000000001',
      planId: 'plan_00000000000001',
      status: SubscriptionStatus.Created,
      providerStatus: 'created',
      scheduling: SchedulingMode.Gateway,
      quantity: 1,
      totalCycles: 6,
      paidCycles: 0,
      remainingCycles: 6,
      createdAt: iso(1773394958),
      startAt: iso(1773461489),
      nextChargeAt: iso(1773461489),
      mandateEndsAt: iso(1776450600),
      metadata: DOC_NOTES,
      checkout: {
        kind: 'razorpay_checkout',
        keyId: KEY_ID,
        subscriptionId: 'sub_00000000000001',
        hostedUrl: 'https://rzp.io/rzp/Dqdqx3h',
      },
    });
    expect(subscription.customer).toBeUndefined();
    expect(subscription.trialEndsAt).toBeUndefined();
    expect(SubscriptionSchema.safeParse(subscription).success).toBe(true);
  });

  it('turns trial.days into a start_at of now + N days in unix seconds', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
    await provider.createSubscription({ plan: 'plan_00000000000001', customer: {}, totalCycles: 6, trial: { days: 7 } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.json).toEqual({ plan_id: 'plan_00000000000001', total_count: 6, start_at: NOW_UNIX + 7 * DAY });
  });

  it('turns trial.endsAt and startAt into start_at', async () => {
    const endsAt = iso(NOW_UNIX + 30 * DAY);
    const { provider, calls } = setup([
      route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
    ]);
    await provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, trial: { endsAt } });
    await provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, startAt: endsAt });
    expect(calls.map((call) => (call.json as { start_at: number }).start_at)).toEqual([NOW_UNIX + 30 * DAY, NOW_UNIX + 30 * DAY]);
  });

  it('omits start_at when there is no trial and no startAt: the subscription starts at authorisation', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
    await provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3 });
    expect(calls[0]?.json).toEqual({ plan_id: 'plan_1', total_count: 3 });
  });

  it('sends authorizeBy as expire_by, notifyCustomer false as customer_notify false, and the default upfront label', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
    await provider.createSubscription({
      plan: 'plan_1',
      customer: {},
      totalCycles: 3,
      authorizeBy: iso(NOW_UNIX + DAY),
      notifyCustomer: false,
      upfrontAmount: 5000,
    });
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/subscriptions`, {
      plan_id: 'plan_1',
      total_count: 3,
      expire_by: NOW_UNIX + DAY,
      customer_notify: false,
      addons: [{ item: { name: 'Upfront amount', amount: 5000, currency: 'INR' } }],
    });
  });

  it('stores the reference in notes and reads it back; it does not leak into metadata', async () => {
    const notes = { plan_tier: 'gold', [RazorpayNoteKey.Reference]: 'order-1001' };
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions', subscriptionResponse({ notes }))]);
    const subscription = await provider.createSubscription({
      plan: 'plan_1',
      customer: {},
      totalCycles: 3,
      reference: 'order-1001',
      metadata: { plan_tier: 'gold' },
    });
    expect(calls[0]?.json).toEqual({ plan_id: 'plan_1', total_count: 3, notes });
    expect(subscription.reference).toBe('order-1001');
    expect(subscription.metadata).toEqual({ plan_tier: 'gold' });
  });

  it('does not send customer details, paymentMethods or an idempotency key; customer comes back as checkout.prefill and returnUrl as callbackUrl', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
    const subscription = await provider.createSubscription({
      plan: 'plan_1',
      customer: { id: 'cust_1', name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
      totalCycles: 3,
      paymentMethods: [PaymentMethod.Upi],
      idempotencyKey: 'idem-key-1',
      returnUrl: 'https://shop.example.com/return',
    });
    const call = calls[0];
    expectRequest(call, HttpMethod.Post, `${BASE}/v1/subscriptions`, { plan_id: 'plan_1', total_count: 3 });
    expect(call?.body).not.toMatch(/asha|9876543210|cust_1|idem|upi/i);
    expect(Object.keys(call?.headers ?? {}).sort()).toEqual(['accept', 'authorization', 'content-type']);
    expect(subscription.checkout).toEqual({
      kind: 'razorpay_checkout',
      keyId: KEY_ID,
      subscriptionId: 'sub_00000000000001',
      hostedUrl: 'https://rzp.io/rzp/Dqdqx3h',
      callbackUrl: 'https://shop.example.com/return',
      prefill: { name: 'Asha Rao', email: 'asha@example.com', phone: '9876543210' },
    });
  });

  it('keeps paise untouched: a large amount and a 1-paise add-on are sent as given', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
    await provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, upfrontAmount: 1 });
    expect((calls[0]?.json as { addons: { item: { amount: number } }[] }).addons[0]?.item.amount).toBe(1);
  });

  describe('inline plan', () => {
    const inlineResponse = (over: Record<string, unknown> = {}) =>
      // Verbatim create-plan sample with the fields of the plan this test creates overridden.
      planResponse({
        period: 'monthly',
        interval: 1,
        item: { ...json(CREATE_PLAN_RESPONSE).item, name: 'Gold monthly', amount: 49900 },
        notes: { [RazorpayNoteKey.PlanMaxCycles]: '12', [RazorpayNoteKey.RequestedPlanId]: 'gold-monthly' },
        ...over,
      });

    it('creates the plan first, then the subscription from the new plan id, in that order', async () => {
      const { provider, calls, remaining } = setup([
        route(HttpMethod.Post, '/v1/plans', inlineResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      const subscription = await provider.createSubscription({
        plan: { id: 'gold-monthly', name: 'Gold monthly', amount: 49900, interval: { unit: 'month', count: 1 }, maxCycles: 12 },
        customer: { email: 'asha@example.com' },
      });
      expect(remaining()).toBe(0);
      expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([`POST ${BASE}/v1/plans`, `POST ${BASE}/v1/subscriptions`]);
      expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/plans`, {
        period: 'monthly',
        interval: 1,
        item: { name: 'Gold monthly', amount: 49900, currency: 'INR' },
        notes: { [RazorpayNoteKey.RequestedPlanId]: 'gold-monthly', [RazorpayNoteKey.PlanMaxCycles]: '12' },
      });
      // total_count comes from the plan's maxCycles; plan_id from the response of the first call.
      expectRequest(calls[1], HttpMethod.Post, `${BASE}/v1/subscriptions`, { plan_id: 'plan_00000000000001', total_count: 12 });
      // The plan is known, so amount and interval are filled.
      expect(subscription).toMatchObject({ amount: 49900, currency: 'INR', interval: { unit: 'month', count: 1 } });
    });

    it('lets an explicit totalCycles win over the plan maxCycles', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Post, '/v1/plans', inlineResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({
        plan: { name: 'Gold monthly', amount: 49900, interval: { unit: 'month', count: 1 }, maxCycles: 12 },
        customer: {},
        totalCycles: 24,
      });
      expect((calls[1]?.json as { total_count: number }).total_count).toBe(24);
    });

    it('multiplies by quantity for the per-cycle amount', async () => {
      const { provider } = setup([
        route(HttpMethod.Post, '/v1/plans', inlineResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', subscriptionResponse({ quantity: 3 })),
      ]);
      const subscription = await provider.createSubscription({
        plan: { name: 'Gold monthly', amount: 49900, interval: { unit: 'month', count: 1 } },
        customer: {},
        quantity: 3,
        totalCycles: 6,
      });
      expect(subscription.amount).toBe(149700);
    });

    it('validates everything before creating the plan: a disagreement leaves no orphan plan', async () => {
      const { provider, calls } = setup([]);
      const error = await failure(() =>
        provider.createSubscription({
          plan: { name: 'Gold monthly', amount: 49900, interval: { unit: 'month', count: 1 } },
          customer: {},
          totalCycles: 6,
          startAt: iso(NOW_UNIX + DAY),
          mandateEndsAt: iso(NOW_UNIX + 400 * DAY),
        }),
      );
      expect(error.code).toBe(ErrorCode.Validation);
      expect(calls).toHaveLength(0);
    });

    it('surfaces a failure of the second call after the plan was created', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Post, '/v1/plans', inlineResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', json(FEATURE_NOT_ENABLED_ERROR), 400),
      ]);
      const error = await failure(() =>
        provider.createSubscription({
          plan: { name: 'Gold monthly', amount: 49900, interval: { unit: 'month', count: 1 } },
          customer: {},
          totalCycles: 6,
        }),
      );
      expect(calls).toHaveLength(2);
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toContain('The requested URL was not found on the server.');
    });

    it('refuses merchant scheduling on the inline plan, before any request', async () => {
      const { provider, calls } = setup([]);
      const error = await failure(() =>
        provider.createSubscription({
          plan: { name: 'P', amount: 49900, interval: { unit: 'month', count: 1 }, scheduling: SchedulingMode.Merchant },
          customer: {},
        }),
      );
      expect(error.code).toBe(ErrorCode.Unsupported);
      expect(calls).toHaveLength(0);
    });
  });

  describe('total_count derivation', () => {
    const totalCountSent = (call: RecordedCall | undefined) => (call?.json as { total_count: number }).total_count;

    it('1. explicit totalCycles is used as is, without fetching the plan', async () => {
      const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
      await provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 6 });
      expect(calls).toHaveLength(1);
      expect(totalCountSent(calls[0])).toBe(6);
    });

    it('2. the inline plan maxCycles (covered with the inline plan tests): 12', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Post, '/v1/plans', planResponse({ period: 'monthly', interval: 1, notes: { [RazorpayNoteKey.PlanMaxCycles]: '12' } })),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({
        plan: { name: 'P', amount: 49900, interval: { unit: 'month', count: 1 }, maxCycles: 12 },
        customer: {},
      });
      expect(totalCountSent(calls[1])).toBe(12);
    });

    it('2b. the maxCycles recorded on an existing plan is used when only a plan id is given', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse({ [RazorpayNoteKey.PlanMaxCycles]: '24' })),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({ plan: 'plan_1', customer: {} });
      expect(calls.map((call) => call.method)).toEqual([HttpMethod.Get, HttpMethod.Post]);
      expect(totalCountSent(calls[1])).toBe(24);
    });

    it('3. mandateEndsAt gives the whole cycles between the first charge and the end (fetching the plan for its period)', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({
        plan: 'plan_1',
        customer: {},
        startAt: '2026-04-01T00:00:00+05:30',
        mandateEndsAt: '2027-04-01T00:00:00+05:30',
      });
      expectRequest(calls[0], HttpMethod.Get, `${BASE}/v1/plans/plan_1`);
      expect(calls[1]?.json).toEqual({ plan_id: 'plan_1', total_count: 12, start_at: Date.parse('2026-04-01T00:00:00+05:30') / 1000 });
    });

    it('3b. counts only whole cycles: a mandate ending a day before the 12th cycle starts allows 11', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({
        plan: 'plan_1',
        customer: {},
        startAt: '2026-04-01T00:00:00+05:30',
        mandateEndsAt: '2027-03-31T23:59:59+05:30',
      });
      expect(totalCountSent(calls[1])).toBe(11);
    });

    it('3c. an explicit totalCycles that agrees with mandateEndsAt is accepted', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({
        plan: 'plan_1',
        customer: {},
        totalCycles: 12,
        startAt: '2026-04-01T00:00:00+05:30',
        mandateEndsAt: '2027-04-01T00:00:00+05:30',
      });
      expect(totalCountSent(calls[1])).toBe(12);
    });

    it('3d. an explicit totalCycles that disagrees with mandateEndsAt is VALIDATION, and nothing is created', async () => {
      const { provider, calls } = setup([route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse())]);
      const error = await failure(() =>
        provider.createSubscription({
          plan: 'plan_1',
          customer: {},
          totalCycles: 6,
          startAt: '2026-04-01T00:00:00+05:30',
          mandateEndsAt: '2027-04-01T00:00:00+05:30',
        }),
      );
      expect(error.code).toBe(ErrorCode.Validation);
      expect(error.message).toContain('totalCycles (6)');
      expect(error.message).toContain('12');
      expect(calls).toHaveLength(1); // only the plan fetch
    });

    it('3e. a mandate that ends before one whole cycle has passed is VALIDATION', async () => {
      const { provider } = setup([route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse())]);
      const error = await failure(() =>
        provider.createSubscription({
          plan: 'plan_1',
          customer: {},
          startAt: '2026-04-01T00:00:00+05:30',
          mandateEndsAt: '2026-04-15T00:00:00+05:30',
        }),
      );
      expect(error.code).toBe(ErrorCode.Validation);
    });

    it('3f. cycles are counted from now when there is no start date (the first charge date is not known before authorisation)', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({ plan: 'plan_1', customer: {}, mandateEndsAt: iso(NOW_UNIX + 400 * DAY) });
      // 400 days after 2026-03-13 is 2027-04-17: thirteen whole months (to 13 Apr 2027) fit.
      expect(totalCountSent(calls[1])).toBe(13);
    });

    it('4. bill-until-cancelled uses the cycles in the default duration: 10 years of monthly billing is 120', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse()),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({ plan: 'plan_1', customer: {} });
      expect(totalCountSent(calls[1])).toBe(120);
    });

    it('4b. the default duration respects the plan interval and the calendar (weekly over 10 years incl. leap days)', async () => {
      const { provider, calls } = setup([
        route(HttpMethod.Get, '/v1/plans/plan_w', planResponse({ period: 'weekly', interval: 1, notes: [] })),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await provider.createSubscription({ plan: 'plan_w', customer: {} });
      // 2026-03-13 to 2036-03-13 is 3653 days (leap days in 2028, 2032 and 2036), counted independently here.
      const days = (Date.UTC(2036, 2, 13) - Date.UTC(2026, 2, 13)) / 86_400_000;
      expect(days).toBe(3653);
      expect(totalCountSent(calls[1])).toBe(Math.floor(days / 7));
    });

    it('4c. defaultDurationYears from the config is honoured', async () => {
      const { provider, calls } = setup(
        [
          route(HttpMethod.Get, '/v1/plans/plan_1', monthlyPlanResponse()),
          route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
        ],
        { defaultDurationYears: 3 },
      );
      await provider.createSubscription({ plan: 'plan_1', customer: {} });
      expect(totalCountSent(calls[1])).toBe(36);
    });

    it('4d. yearly billing over the default duration is 10 cycles; an interval longer than the duration is VALIDATION', async () => {
      const yearly = setup([
        route(HttpMethod.Get, '/v1/plans/plan_y', planResponse({ period: 'yearly', interval: 1, notes: [] })),
        route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE)),
      ]);
      await yearly.provider.createSubscription({ plan: 'plan_y', customer: {} });
      expect(totalCountSent(yearly.calls[1])).toBe(10);

      const long = setup([route(HttpMethod.Get, '/v1/plans/plan_y11', planResponse({ period: 'yearly', interval: 11, notes: [] }))]);
      expect((await failure(() => long.provider.createSubscription({ plan: 'plan_y11', customer: {} }))).code).toBe(ErrorCode.Validation);
    });

    it('4e. a plan period this adapter does not know needs an explicit totalCycles', async () => {
      const odd = planResponse({ period: 'fortnightly', interval: 1, notes: [] });
      const missing = setup([route(HttpMethod.Get, '/v1/plans/plan_odd', odd)]);
      expect((await failure(() => missing.provider.createSubscription({ plan: 'plan_odd', customer: {} }))).code).toBe(ErrorCode.Validation);
      const given = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
      await given.provider.createSubscription({ plan: 'plan_odd', customer: {}, totalCycles: 4 });
      expect(given.calls).toHaveLength(1);
    });
  });

  describe('input and failure handling', () => {
    it('rejects trial together with startAt, a past startAt and an invalid quantity before any request', async () => {
      const { provider, calls } = setup([]);
      const both = await failure(() =>
        provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, trial: { days: 3 }, startAt: iso(NOW_UNIX + DAY) }),
      );
      const past = await failure(() => provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, startAt: iso(NOW_UNIX - DAY) }));
      const quantity = await failure(() => provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, quantity: 0 }));
      expect([both.code, past.code, quantity.code]).toEqual([ErrorCode.Validation, ErrorCode.Validation, ErrorCode.Validation]);
      expect(calls).toHaveLength(0);
    });

    it('rejects reserved metadata keys and a 15-pair metadata that has no room for the reference', async () => {
      const { provider, calls } = setup([]);
      const reserved = await failure(() =>
        provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, metadata: { [RazorpayNoteKey.Reference]: 'x' } }),
      );
      const full = Object.fromEntries(Array.from({ length: 15 }, (_, index) => [`k${index}`, 'v']));
      const ok = setup([route(HttpMethod.Post, '/v1/subscriptions', json(CREATE_SUBSCRIPTION_RESPONSE))]);
      await ok.provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, metadata: full });
      const overflow = await failure(() =>
        provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3, metadata: full, reference: 'order-1' }),
      );
      expect([reserved.code, overflow.code]).toEqual([ErrorCode.Validation, ErrorCode.Validation]);
      expect(calls).toHaveLength(0);
    });

    it('is OUTCOME_UNKNOWN when the connection drops, and does not retry the write', async () => {
      const { provider, calls } = setup(
        [{ method: HttpMethod.Post, url: `${BASE}/v1/subscriptions`, networkError: true }],
        {},
        { maxRetries: 3 },
      );
      const error = await failure(() => provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3 }));
      expect(error.code).toBe(ErrorCode.OutcomeUnknown);
      expect(error.message).toContain('fetch the current state');
      expect(calls).toHaveLength(1);
    });

    it('is OUTCOME_UNKNOWN on a 5xx to a write, and not retried', async () => {
      const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions', { error: { code: 'SERVER_ERROR', description: 'boom' } }, 502)], {}, { maxRetries: 3 });
      const error = await failure(() => provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3 }));
      expect(error.code).toBe(ErrorCode.OutcomeUnknown);
      expect(error.httpStatus).toBe(502);
      expect(calls).toHaveLength(1);
    });

    it('is UNEXPECTED_RESPONSE when the 200 body is not a subscription', async () => {
      const { provider } = setup([route(HttpMethod.Post, '/v1/subscriptions', { hello: 'world' })]);
      const error = await failure(() => provider.createSubscription({ plan: 'plan_1', customer: {}, totalCycles: 3 }));
      expect(error.code).toBe(ErrorCode.UnexpectedResponse);
    });
  });
});

// ---------------------------------------------------------------------------
// getSubscription, cancel, pause, resume, update
// ---------------------------------------------------------------------------

describe('getSubscription', () => {
  it('GETs /v1/subscriptions/{id} and maps the sample', async () => {
    const { provider, calls } = setup([route(HttpMethod.Get, '/v1/subscriptions/sub_00000000000001', json(FETCH_SUBSCRIPTION_RESPONSE))]);
    const subscription = await provider.getSubscription('sub_00000000000001');
    expectRequest(calls[0], HttpMethod.Get, `${BASE}/v1/subscriptions/sub_00000000000001`);
    expect(subscription).toMatchObject({
      id: 'sub_00000000000001',
      status: SubscriptionStatus.Active,
      providerStatus: 'active',
      customer: { id: 'cust_D00000000000001' },
      currentPeriodStart: iso(1577355871),
      currentPeriodEnd: iso(1582655400),
      nextChargeAt: iso(1577385991),
      paidCycles: 1,
      remainingCycles: 5,
    });
    expect(SubscriptionSchema.safeParse(subscription).success).toBe(true);
  });

  it('maps an authenticated subscription to trialing with trialEndsAt', async () => {
    const response = { ...json(FETCH_SUBSCRIPTION_RESPONSE), status: 'authenticated', charge_at: 1593109800, start_at: 1593109800 };
    const { provider } = setup([route(HttpMethod.Get, '/v1/subscriptions/sub_1', response)]);
    const subscription = await provider.getSubscription('sub_1');
    expect(subscription.status).toBe(SubscriptionStatus.Trialing);
    expect(subscription.trialEndsAt).toBe(iso(1593109800));
  });

  it('retries a GET after a 503, because reads are idempotent', async () => {
    const { provider, calls } = setup(
      [
        route(HttpMethod.Get, '/v1/subscriptions/sub_1', { error: { code: 'SERVER_ERROR', description: 'try later' } }, 503),
        route(HttpMethod.Get, '/v1/subscriptions/sub_1', json(FETCH_SUBSCRIPTION_RESPONSE)),
      ],
      {},
      { maxRetries: 2 },
    );
    expect((await provider.getSubscription('sub_1')).id).toBe('sub_00000000000001');
    expect(calls).toHaveLength(2);
  });

  it('is PROVIDER_UNAVAILABLE when a GET keeps failing with 5xx', async () => {
    const { provider } = setup([route(HttpMethod.Get, '/v1/subscriptions/sub_1', { error: { description: 'down' } }, 503)]);
    const error = await failure(() => provider.getSubscription('sub_1'));
    expect(error.code).toBe(ErrorCode.ProviderUnavailable);
  });
});

describe('cancelSubscription', () => {
  it('cancels immediately by default: POST .../cancel with cancel_at_cycle_end false (the documented sample body)', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions/sub_00000000000001/cancel', json(CANCEL_RESPONSE))]);
    const subscription = await provider.cancelSubscription('sub_00000000000001');
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/subscriptions/sub_00000000000001/cancel`, { cancel_at_cycle_end: false });
    expect(subscription).toMatchObject({ status: SubscriptionStatus.Cancelled, providerStatus: 'cancelled', endedAt: iso(1580288092) });
    expect(subscription.cancelAtPeriodEnd).toBeUndefined();
  });

  it('cancels immediately when asked for explicitly', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions/sub_1/cancel', json(CANCEL_RESPONSE))]);
    await provider.cancelSubscription('sub_1', { mode: 'immediately' });
    expect(calls[0]?.json).toEqual({ cancel_at_cycle_end: false });
  });

  it('cancels at the end of the cycle with cancel_at_cycle_end true and reports cancelAtPeriodEnd while the subscription is still active', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions/sub_1/cancel', json(FETCH_SUBSCRIPTION_RESPONSE))]);
    const subscription = await provider.cancelSubscription('sub_1', { mode: 'at_period_end' });
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/subscriptions/sub_1/cancel`, { cancel_at_cycle_end: true });
    expect(subscription.status).toBe(SubscriptionStatus.Active);
    expect(subscription.cancelAtPeriodEnd).toBe(true);
  });

  it('does not claim a pending cancellation when the response is already cancelled', async () => {
    const { provider } = setup([route(HttpMethod.Post, '/v1/subscriptions/sub_1/cancel', json(CANCEL_RESPONSE))]);
    const subscription = await provider.cancelSubscription('sub_1', { mode: 'at_period_end' });
    expect(subscription.status).toBe(SubscriptionStatus.Cancelled);
    expect(subscription.cancelAtPeriodEnd).toBeUndefined();
  });

  it("surfaces Razorpay's rejection with its description, field and code", async () => {
    const { provider } = setup([route(HttpMethod.Post, '/v1/subscriptions/sub_1/cancel', json(CANCEL_EXPIRED_ERROR), 400)]);
    const error = await failure(() => provider.cancelSubscription('sub_1'));
    expect(error).toMatchObject({
      code: ErrorCode.Validation,
      httpStatus: 400,
      providerCode: 'BAD_REQUEST_ERROR',
      provider: 'razorpay',
    });
    expect(error.message).toBe('razorpay responded 400: Subscription is not cancellable in expired status. (field: status)');
    expect(error.raw).toEqual(json(CANCEL_EXPIRED_ERROR));
  });

  it('rejects an unknown mode and an empty id before any request', async () => {
    const { provider, calls } = setup([]);
    const mode = await failure(() => provider.cancelSubscription('sub_1', { mode: 'later' as never }));
    const id = await failure(() => provider.cancelSubscription(' '));
    expect([mode.code, id.code]).toEqual([ErrorCode.Validation, ErrorCode.Validation]);
    expect(calls).toHaveLength(0);
  });
});

describe('pauseSubscription', () => {
  it('checks the state, then POSTs .../pause with pause_at "now" (the documented sample body)', async () => {
    const { provider, calls } = setup([
      route(HttpMethod.Get, '/v1/subscriptions/sub_00000000000001', json(FETCH_SUBSCRIPTION_RESPONSE)),
      route(HttpMethod.Post, '/v1/subscriptions/sub_00000000000001/pause', json(PAUSE_RESPONSE)),
    ]);
    const subscription = await provider.pauseSubscription('sub_00000000000001');
    expectRequest(calls[0], HttpMethod.Get, `${BASE}/v1/subscriptions/sub_00000000000001`);
    expectRequest(calls[1], HttpMethod.Post, `${BASE}/v1/subscriptions/sub_00000000000001/pause`, { pause_at: 'now' });
    expect(subscription).toMatchObject({ status: SubscriptionStatus.Paused, providerStatus: 'paused' });
    expect(subscription.nextChargeAt).toBeUndefined();
  });

  it('refuses to pause an authenticated (trial) subscription, because Razorpay would cancel it', async () => {
    const { provider, calls } = setup([
      route(HttpMethod.Get, '/v1/subscriptions/sub_1', { ...json(FETCH_SUBSCRIPTION_RESPONSE), status: 'authenticated' }),
    ]);
    const error = await failure(() => provider.pauseSubscription('sub_1'));
    expect(error.code).toBe(ErrorCode.Conflict);
    expect(error.message).toContain('cancel');
    expect(calls).toHaveLength(1);
  });

  it('is UNSUPPORTED to pause until a date, with no request at all', async () => {
    const { provider, calls } = setup([]);
    const error = await failure(() => provider.pauseSubscription('sub_1', { resumeAt: iso(NOW_UNIX + 10 * DAY) }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it("surfaces Razorpay's own rejection (feature not enabled / created state)", async () => {
    const rejection = { error: { code: 'BAD_REQUEST_ERROR', description: 'pause is not allowed, feature is not enabled.' } };
    const { provider } = setup([
      route(HttpMethod.Get, '/v1/subscriptions/sub_1', json(FETCH_SUBSCRIPTION_RESPONSE)),
      route(HttpMethod.Post, '/v1/subscriptions/sub_1/pause', rejection, 400),
    ]);
    const error = await failure(() => provider.pauseSubscription('sub_1'));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message).toContain('feature is not enabled');
  });
});

describe('resumeSubscription', () => {
  it('POSTs .../resume with resume_at "now" (the documented sample body)', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions/sub_00000000000001/resume', json(RESUME_RESPONSE))]);
    const subscription = await provider.resumeSubscription('sub_00000000000001');
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/subscriptions/sub_00000000000001/resume`, { resume_at: 'now' });
    expect(subscription).toMatchObject({ status: SubscriptionStatus.Active, nextChargeAt: iso(1580453311) });
  });

  it('is UNSUPPORTED to choose the next charge date, with no request', async () => {
    const { provider, calls } = setup([]);
    const error = await failure(() => provider.resumeSubscription('sub_1', { nextChargeAt: iso(NOW_UNIX + DAY) }));
    expect(error.code).toBe(ErrorCode.Unsupported);
    expect(calls).toHaveLength(0);
  });

  it("surfaces Razorpay's rejection of a resume it cannot do", async () => {
    const rejection = { error: { code: 'BAD_REQUEST_ERROR', description: 'This subscription cannot be resumed at this time.' } };
    const { provider } = setup([route(HttpMethod.Post, '/v1/subscriptions/sub_1/resume', rejection, 400)]);
    expect((await failure(() => provider.resumeSubscription('sub_1'))).message).toContain('cannot be resumed');
  });
});

describe('updateSubscription', () => {
  it('PATCHes with every updatable field; the body equals the documented sample (without offer_id)', async () => {
    const { provider, calls } = setup([route(HttpMethod.Patch, '/v1/subscriptions/sub_00000000000001', json(UPDATE_RESPONSE))]);
    const subscription = await provider.updateSubscription('sub_00000000000001', {
      planId: 'plan_00000000000002',
      quantity: 5,
      remainingCycles: 5,
      nextChargeAt: iso(1496000432),
      notifyCustomer: true,
    });
    // api__payments__subscriptions__update-subscription.md, curl sample minus offer_id (offers are not part of the neutral model).
    expectRequest(calls[0], HttpMethod.Patch, `${BASE}/v1/subscriptions/sub_00000000000001`, {
      plan_id: 'plan_00000000000002',
      quantity: 5,
      remaining_count: 5,
      start_at: 1496000432,
      schedule_change_at: 'now',
      customer_notify: true,
    });
    // The docs' sample response shows quantity 3 for a request of 5; the adapter reports what Razorpay returned.
    expect(subscription).toMatchObject({ id: 'sub_00000000000002', planId: 'plan_00000000000002', quantity: 3, status: SubscriptionStatus.Trialing });
  });

  it('maps timing at_period_end to schedule_change_at cycle_end', async () => {
    const { provider, calls } = setup([route(HttpMethod.Patch, '/v1/subscriptions/sub_1', json(UPDATE_RESPONSE))]);
    await provider.updateSubscription('sub_1', { planId: 'plan_2', timing: 'at_period_end' });
    expect(calls[0]?.json).toEqual({ plan_id: 'plan_2', schedule_change_at: 'cycle_end' });
  });

  it('sends only what was asked, defaulting to an immediate change', async () => {
    const { provider, calls } = setup([route(HttpMethod.Patch, '/v1/subscriptions/sub_1', json(UPDATE_RESPONSE))]);
    await provider.updateSubscription('sub_1', { quantity: 2 });
    expectRequest(calls[0], HttpMethod.Patch, `${BASE}/v1/subscriptions/sub_1`, { quantity: 2, schedule_change_at: 'now' });
  });

  it('is UNSUPPORTED to change the amount or the mandate end date, with no request, even alongside valid fields', async () => {
    const { provider, calls } = setup([]);
    const amount = await failure(() => provider.updateSubscription('sub_1', { amount: 99900 }));
    const mandate = await failure(() => provider.updateSubscription('sub_1', { mandateEndsAt: iso(NOW_UNIX + 400 * DAY) }));
    const mixed = await failure(() => provider.updateSubscription('sub_1', { quantity: 2, amount: 99900 }));
    expect([amount.code, mandate.code, mixed.code]).toEqual([ErrorCode.Unsupported, ErrorCode.Unsupported, ErrorCode.Unsupported]);
    expect(calls).toHaveLength(0);
  });

  it('is VALIDATION when there is nothing to update', async () => {
    const { provider, calls } = setup([]);
    expect((await failure(() => provider.updateSubscription('sub_1', {}))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });

  it("surfaces Razorpay's rejection of an update on a UPI subscription as the mapped error", async () => {
    const { provider } = setup([route(HttpMethod.Patch, '/v1/subscriptions/sub_1', json(UPDATE_UPI_ERROR), 400)]);
    const error = await failure(() => provider.updateSubscription('sub_1', { quantity: 2 }));
    expect(error).toMatchObject({ code: ErrorCode.Validation, httpStatus: 400, providerCode: 'BAD_REQUEST_ERROR' });
    expect(error.message).toContain('subscriptions cannot be updated when payment mode is UPI');
  });
});

// ---------------------------------------------------------------------------
// Charges
// ---------------------------------------------------------------------------

const INVOICE_QUERY = (skip: number, count = 100) =>
  `${BASE}/v1/invoices?subscription_id=sub_00000000000001&count=${count}&skip=${skip}`;

/** A paid invoice cloned from the first sample invoice, for paging tests. */
function cloneInvoice(index: number) {
  const sample = json(INVOICES_RESPONSE).items[1];
  return {
    ...sample,
    id: `inv_clone${String(index).padStart(6, '0')}`,
    payment_id: `pay_clone${String(index).padStart(6, '0')}`,
    billing_start: 1_600_000_000 + index * 100,
    date: 1_600_000_000 + index * 100,
    line_items: [sample.line_items[0]],
    amount: 99900,
  };
}

describe('listCharges', () => {
  it('GETs the subscription invoices with count and skip and maps each invoice to a charge', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Get, url: INVOICE_QUERY(0), json: json(INVOICES_RESPONSE) }]);
    const charges = await provider.listCharges('sub_00000000000001');
    expectRequest(calls[0], HttpMethod.Get, INVOICE_QUERY(0));
    expect(calls).toHaveLength(1);
    expect(charges).toHaveLength(2);

    // Razorpay lists the newest first: the second sample invoice is cycle 1 and includes the 30000 add-on.
    expect(charges[0]).toMatchObject({
      provider: 'razorpay',
      id: 'pay_00000000000002',
      reference: 'inv_00000000000003',
      subscriptionId: 'sub_00000000000001',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      providerStatus: 'paid',
      amount: 99900,
      currency: 'INR',
      cycle: 2,
      paidAt: iso(1593344889),
    });
    expect(charges[1]).toMatchObject({
      id: 'pay_00000000000001',
      reference: 'inv_00000000000001',
      amount: 129900,
      cycle: 1,
      paidAt: iso(1591878210),
    });
    for (const charge of charges) expect(ChargeSchema.safeParse(charge).success).toBe(true);
  });

  it('uses the invoice id as the charge id when the invoice has no payment yet, and reports it as pending', async () => {
    const issued = { ...json(INVOICES_RESPONSE).items[0], status: 'issued', payment_id: null, paid_at: null, amount_paid: 0, amount_due: 99900 };
    const { provider } = setup([{ method: HttpMethod.Get, url: INVOICE_QUERY(0), json: { entity: 'collection', count: 1, items: [issued] } }]);
    const [charge] = await provider.listCharges('sub_00000000000001');
    expect(charge).toMatchObject({ id: 'inv_00000000000003', reference: 'inv_00000000000003', status: ChargeStatus.Pending, providerStatus: 'issued' });
    expect(charge?.paidAt).toBeUndefined();
  });

  it('pages through every invoice instead of stopping at Razorpay\'s default of 10, and numbers cycles over the full list', async () => {
    const first = Array.from({ length: 100 }, (_, index) => cloneInvoice(index));
    const second = Array.from({ length: 5 }, (_, index) => cloneInvoice(100 + index));
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: INVOICE_QUERY(0), json: { entity: 'collection', count: 100, items: first } },
      { method: HttpMethod.Get, url: INVOICE_QUERY(100), json: { entity: 'collection', count: 5, items: second } },
    ]);
    const charges = await provider.listCharges('sub_00000000000001');
    expect(calls.map((call) => call.url)).toEqual([INVOICE_QUERY(0), INVOICE_QUERY(100)]);
    expect(charges).toHaveLength(105);
    expect(charges[0]?.cycle).toBe(1);
    expect(charges[104]?.cycle).toBe(105);
    expect(new Set(charges.map((charge) => charge.id)).size).toBe(105);
  });

  it('stops after an empty page when the previous page was exactly full', async () => {
    const full = Array.from({ length: 100 }, (_, index) => cloneInvoice(index));
    const { provider, calls } = setup([
      { method: HttpMethod.Get, url: INVOICE_QUERY(0), json: { entity: 'collection', count: 100, items: full } },
      { method: HttpMethod.Get, url: INVOICE_QUERY(100), json: { entity: 'collection', count: 0, items: [] } },
    ]);
    expect(await provider.listCharges('sub_00000000000001')).toHaveLength(100);
    expect(calls).toHaveLength(2);
  });

  it('honours limit with a single request, and derives cycles only when the page is known to be the whole list', async () => {
    const one = setup([{ method: HttpMethod.Get, url: INVOICE_QUERY(0, 1), json: { entity: 'collection', count: 1, items: [json(INVOICES_RESPONSE).items[0]] } }]);
    const [limited] = await one.provider.listCharges('sub_00000000000001', { limit: 1 });
    expect(one.calls).toHaveLength(1);
    expect(limited?.cycle).toBeUndefined();

    const five = setup([{ method: HttpMethod.Get, url: INVOICE_QUERY(0, 5), json: json(INVOICES_RESPONSE) }]);
    const complete = await five.provider.listCharges('sub_00000000000001', { limit: 5 });
    expect(complete.map((charge) => charge.cycle)).toEqual([2, 1]);
  });

  it('is VALIDATION for a limit outside 1..100 and an empty id, with no request', async () => {
    const { provider, calls } = setup([]);
    const zero = await failure(() => provider.listCharges('sub_1', { limit: 0 }));
    const big = await failure(() => provider.listCharges('sub_1', { limit: 101 }));
    const id = await failure(() => provider.listCharges(''));
    expect([zero.code, big.code, id.code]).toEqual([ErrorCode.Validation, ErrorCode.Validation, ErrorCode.Validation]);
    expect(calls).toHaveLength(0);
  });

  it('is UNEXPECTED_RESPONSE when the body has no items', async () => {
    const { provider } = setup([{ method: HttpMethod.Get, url: INVOICE_QUERY(0), json: { entity: 'collection', count: 0 } }]);
    expect((await failure(() => provider.listCharges('sub_00000000000001'))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('getCharge', () => {
  // The payment entity inside the verbatim subscription.charged webhook sample
  // (webhooks__subscriptions.md); the docs have no standalone payment sample.
  const paymentSample = () => json(WEBHOOK_CHARGED).payload.payment.entity as Record<string, unknown>;

  it('GETs /v1/payments/{id} and maps the payment to a charge', async () => {
    const { provider, calls } = setup([route(HttpMethod.Get, '/v1/payments/pay_DEXFWroJ6LikKT', paymentSample())]);
    const charge = await provider.getCharge('sub_DEX6xcJ1HSW4CR', 'pay_DEXFWroJ6LikKT');
    expectRequest(calls[0], HttpMethod.Get, `${BASE}/v1/payments/pay_DEXFWroJ6LikKT`);
    expect(charge).toMatchObject({
      provider: 'razorpay',
      id: 'pay_DEXFWroJ6LikKT',
      reference: 'inv_DEXFWVuM6rPqlK',
      kind: ChargeKind.Recurring,
      status: ChargeStatus.Succeeded,
      providerStatus: 'captured',
      amount: 100000,
      currency: 'INR',
      paymentMethod: PaymentMethod.Card,
      refundedAmount: 0,
      paidAt: iso(1567690382),
    });
    // The payment does not say which subscription it belongs to, so none is claimed.
    expect(charge.subscriptionId).toBeUndefined();
    expect(ChargeSchema.safeParse(charge).success).toBe(true);
  });

  it('reads a partly refunded payment and a failed payment', async () => {
    const partly = setup([route(HttpMethod.Get, '/v1/payments/pay_1', { ...paymentSample(), amount_refunded: 25000, refund_status: 'partial' })]);
    expect(await partly.provider.getCharge('sub_1', 'pay_1')).toMatchObject({ status: ChargeStatus.PartiallyRefunded, refundedAmount: 25000, amount: 100000 });
    const failed = setup([
      route(HttpMethod.Get, '/v1/payments/pay_2', { ...paymentSample(), status: 'failed', error_code: 'BAD_REQUEST_ERROR', error_description: 'Payment processing failed because of incorrect OTP.' }),
    ]);
    expect(await failed.provider.getCharge('sub_1', 'pay_2')).toMatchObject({
      status: ChargeStatus.Failed,
      failureCode: 'BAD_REQUEST_ERROR',
      failureReason: 'Payment processing failed because of incorrect OTP.',
    });
  });

  it('fetches an invoice when given the invoice id that listCharges returns for an unpaid invoice', async () => {
    const invoice = json(INVOICES_RESPONSE).items[1];
    const { provider, calls } = setup([route(HttpMethod.Get, '/v1/invoices/inv_00000000000001', invoice)]);
    const charge = await provider.getCharge('sub_00000000000001', 'inv_00000000000001');
    expectRequest(calls[0], HttpMethod.Get, `${BASE}/v1/invoices/inv_00000000000001`);
    expect(charge).toMatchObject({ id: 'pay_00000000000001', reference: 'inv_00000000000001', subscriptionId: 'sub_00000000000001', amount: 129900 });
  });

  it('is NOT_FOUND when Razorpay reports the id as not found, and VALIDATION for an empty id', async () => {
    const missing = { error: { code: 'BAD_REQUEST_ERROR', description: 'The ID provided is invalid or could not be found.' } };
    const { provider, calls } = setup([route(HttpMethod.Get, '/v1/payments/pay_nope', missing, 400)]);
    expect((await failure(() => provider.getCharge('sub_1', 'pay_nope'))).code).toBe(ErrorCode.NotFound);
    expect((await failure(() => provider.getCharge('sub_1', ''))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(1);
  });
});

describe('refundCharge', () => {
  // No refund sample exists in the subscription docs; this is the SDK's RazorpayRefund type (dist/types/refunds.d.ts).
  const refundResponse = (over: Record<string, unknown> = {}) => ({
    id: 'rfnd_FP8QHiV938haTz',
    entity: 'refund',
    amount: 5000,
    currency: 'INR',
    payment_id: 'pay_29QQoUBi66xm2f',
    receipt: 'refund-1',
    notes: [],
    status: 'processed',
    speed_processed: 'normal',
    speed_requested: 'normal',
    created_at: 1600000000,
    ...over,
  });

  it('POSTs /v1/payments/{id}/refund with amount, receipt and notes, and maps the refund', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/payments/pay_29QQoUBi66xm2f/refund', refundResponse())]);
    const refund = await provider.refundCharge({
      subscriptionId: 'sub_1',
      chargeId: 'pay_29QQoUBi66xm2f',
      refundId: 'refund-1',
      amount: 5000,
      reason: 'customer asked',
    });
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/payments/pay_29QQoUBi66xm2f/refund`, {
      amount: 5000,
      receipt: 'refund-1',
      notes: { [RazorpayNoteKey.RefundReference]: 'refund-1', [RazorpayNoteKey.RefundReason]: 'customer asked' },
    });
    expect(refund).toMatchObject({
      provider: 'razorpay',
      id: 'rfnd_FP8QHiV938haTz',
      reference: 'refund-1',
      chargeId: 'pay_29QQoUBi66xm2f',
      status: RefundStatus.Succeeded,
      providerStatus: 'processed',
      amount: 5000,
      currency: 'INR',
      createdAt: iso(1600000000),
    });
    expect(RefundSchema.safeParse(refund).success).toBe(true);
  });

  it('omits amount for a full refund and omits the reason note when there is no reason', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/payments/pay_1/refund', refundResponse({ amount: 49900, status: 'pending' }))]);
    const refund = await provider.refundCharge({ chargeId: 'pay_1', refundId: 'refund-2' });
    expectRequest(calls[0], HttpMethod.Post, `${BASE}/v1/payments/pay_1/refund`, {
      receipt: 'refund-2',
      notes: { [RazorpayNoteKey.RefundReference]: 'refund-2' },
    });
    expect(refund).toMatchObject({ amount: 49900, status: RefundStatus.Pending });
  });

  it('maps a failed refund, and an unknown refund status to pending with the status kept', async () => {
    const failed = setup([route(HttpMethod.Post, '/v1/payments/pay_1/refund', refundResponse({ status: 'failed' }))]);
    expect((await failed.provider.refundCharge({ chargeId: 'pay_1', refundId: 'r1' })).status).toBe(RefundStatus.Failed);
    const odd = setup([route(HttpMethod.Post, '/v1/payments/pay_1/refund', refundResponse({ status: 'reversed' }))]);
    expect(await odd.provider.refundCharge({ chargeId: 'pay_1', refundId: 'r1' })).toMatchObject({ status: RefundStatus.Pending, providerStatus: 'reversed' });
  });

  it('falls back to the requested amount when the response has none, and fails when neither is known', async () => {
    const { amount: _omitted, ...withoutAmount } = refundResponse();
    const fallback = setup([route(HttpMethod.Post, '/v1/payments/pay_1/refund', withoutAmount)]);
    expect((await fallback.provider.refundCharge({ chargeId: 'pay_1', refundId: 'r1', amount: 700 })).amount).toBe(700);
    const neither = setup([route(HttpMethod.Post, '/v1/payments/pay_1/refund', withoutAmount)]);
    expect((await failure(() => neither.provider.refundCharge({ chargeId: 'pay_1', refundId: 'r1' }))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('rejects fractional paise, a zero amount and a missing refund id before any request', async () => {
    const { provider, calls } = setup([]);
    const fractional = await failure(() => provider.refundCharge({ chargeId: 'pay_1', refundId: 'r1', amount: 10.5 }));
    const zero = await failure(() => provider.refundCharge({ chargeId: 'pay_1', refundId: 'r1', amount: 0 }));
    const noId = await failure(() => provider.refundCharge({ chargeId: 'pay_1' } as never));
    expect([fractional.code, zero.code, noId.code]).toEqual([ErrorCode.Validation, ErrorCode.Validation, ErrorCode.Validation]);
    expect(calls).toHaveLength(0);
  });

  it('is OUTCOME_UNKNOWN when the refund request gets no answer, and is not retried', async () => {
    const { provider, calls } = setup([{ method: HttpMethod.Post, url: `${BASE}/v1/payments/pay_1/refund`, networkError: true }], {}, { maxRetries: 3 });
    const error = await failure(() => provider.refundCharge({ chargeId: 'pay_1', refundId: 'r1' }));
    expect(error.code).toBe(ErrorCode.OutcomeUnknown);
    expect(calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Error mapping
// ---------------------------------------------------------------------------

describe('error mapping', () => {
  const get = (status: number, body: unknown) => setup([route(HttpMethod.Get, '/v1/subscriptions/sub_1', body, status)]).provider.getSubscription('sub_1');

  it('maps a 400 BAD_REQUEST_ERROR body to VALIDATION with the description, code and status', async () => {
    const error = await failure(() => get(400, { error: { code: 'BAD_REQUEST_ERROR', description: 'The total count must be at least 1.' } }));
    expect(error).toMatchObject({ code: ErrorCode.Validation, httpStatus: 400, providerCode: 'BAD_REQUEST_ERROR', provider: 'razorpay' });
    expect(error.message).toBe('razorpay responded 400: The total count must be at least 1.');
  });

  it('includes field and reason in the message when Razorpay fills them, and ignores "NA"', async () => {
    const withBoth = await failure(() => get(400, { error: json(CHECKOUT_FAILURE_ERROR) }));
    expect(withBoth.message).toBe('razorpay responded 400: Payment failed. Please contact the site admin (field: amount, reason: amount_less_than_minimum_amount)');
    expect(withBoth.providerCode).toBe('BAD_REQUEST_ERROR');
    const withNa = await failure(() => get(400, json(API_KEY_ERROR)));
    expect(withNa.message).not.toContain('NA');
  });

  it.each([
    ['The api key provided is invalid', ErrorCode.Auth],
    ['The API key/secret provided is invalid.', ErrorCode.Auth],
    ['Authentication failed', ErrorCode.Auth],
    ['The ID provided is invalid or could not be found.', ErrorCode.NotFound],
    ['The id provided does not exist', ErrorCode.NotFound],
    ['ub_id%7D is not a valid id', ErrorCode.NotFound],
    ['Request failed because another subscription operation is in progress.', ErrorCode.Conflict],
    // "Subscriptions feature not enabled": looks like a 404 text but is a configuration problem, not a missing object.
    ['The requested URL was not found on the server.', ErrorCode.Validation],
    ['The quantity must be at least 1.', ErrorCode.Validation],
  ])('refines the 400 "%s" to %s', async (description, code) => {
    const error = await failure(() => get(400, { error: { code: 'BAD_REQUEST_ERROR', description } }));
    expect(error.code).toBe(code);
    expect(error.message).toContain(description);
    expect(error.httpStatus).toBe(400);
    expect(error.providerCode).toBe('BAD_REQUEST_ERROR');
  });

  it('maps the documented sample bodies: invalid API key is AUTH', async () => {
    expect((await failure(() => get(400, json(API_KEY_ERROR)))).code).toBe(ErrorCode.Auth);
  });

  it.each([
    [401, ErrorCode.Auth],
    [403, ErrorCode.Auth],
    [404, ErrorCode.NotFound],
    [409, ErrorCode.Conflict],
    [422, ErrorCode.Validation],
  ])('maps HTTP %i to %s by status', async (status, code) => {
    expect((await failure(() => get(status, { error: { code: 'BAD_REQUEST_ERROR', description: 'nope' } }))).code).toBe(code);
  });

  it('maps a 429 on a write to RATE_LIMITED, never retrying it', async () => {
    const { provider, calls } = setup([route(HttpMethod.Post, '/v1/subscriptions/sub_1/cancel', { error: { description: 'slow down' } }, 429)], {}, { maxRetries: 3 });
    const error = await failure(() => provider.cancelSubscription('sub_1'));
    expect(error.code).toBe(ErrorCode.RateLimited);
    expect(error.retryable).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it('describes a failure whose body is not Razorpay JSON from the text, truncated', async () => {
    const { provider } = setup([{ method: HttpMethod.Get, url: `${BASE}/v1/subscriptions/sub_1`, status: 400, text: `<html>${'x'.repeat(500)}</html>` }]);
    const error = await failure(() => provider.getSubscription('sub_1'));
    expect(error.code).toBe(ErrorCode.Validation);
    expect(error.message.length).toBeLessThan(260);
    expect(error.providerCode).toBeUndefined();
  });

  it('copes with an empty error body', async () => {
    const { provider } = setup([{ method: HttpMethod.Get, url: `${BASE}/v1/subscriptions/sub_1`, status: 400 }]);
    expect((await failure(() => provider.getSubscription('sub_1'))).message).toContain('empty response body');
  });

  it('is UNEXPECTED_RESPONSE when a 200 body is not JSON', async () => {
    const { provider } = setup([{ method: HttpMethod.Get, url: `${BASE}/v1/subscriptions/sub_1`, text: 'OK' }]);
    expect((await failure(() => provider.getSubscription('sub_1'))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('is NETWORK for a failed read and OUTCOME_UNKNOWN for a failed write', async () => {
    const read = setup([{ method: HttpMethod.Get, url: `${BASE}/v1/subscriptions/sub_1`, networkError: true }]);
    expect((await failure(() => read.provider.getSubscription('sub_1'))).code).toBe(ErrorCode.Network);
    const write = setup([{ method: HttpMethod.Post, url: `${BASE}/v1/subscriptions/sub_1/cancel`, networkError: true }]);
    expect((await failure(() => write.provider.cancelSubscription('sub_1'))).code).toBe(ErrorCode.OutcomeUnknown);
  });

  it('never puts the key secret, the webhook secret or the Authorization header in an error', async () => {
    const attempts: Array<() => Promise<unknown>> = [
      () => get(400, json(API_KEY_ERROR)),
      () => get(401, { error: { description: 'Authentication failed' } }),
      () => get(502, 'bad gateway'),
      () => setup([{ method: HttpMethod.Post, url: `${BASE}/v1/subscriptions/sub_1/cancel`, networkError: true }]).provider.cancelSubscription('sub_1'),
      () => setup([{ method: HttpMethod.Get, url: `${BASE}/v1/subscriptions/sub_1`, text: 'not json' }]).provider.getSubscription('sub_1'),
      () => setup([]).provider.createPlan({ name: 'P', amount: 1, interval: { unit: 'month', count: 1 } }),
      () => setup([]).provider.verifyCheckout({}),
      async () => {
        razorpay({ keyId: KEY_ID, keySecret: KEY_SECRET, baseUrl: 'nope' });
      },
    ];
    for (const attempt of attempts) {
      let thrown: unknown;
      try {
        await attempt();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(SubscriptionError);
      const error = thrown as SubscriptionError;
      const cause = error.cause instanceof Error ? error.cause.message : String(error.cause ?? '');
      const everything = JSON.stringify({ message: error.message, json: error.toJSON(), raw: error.raw, stack: error.stack, cause });
      for (const secret of [KEY_SECRET, WEBHOOK_SECRET, AUTH, Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')]) {
        expect(everything).not.toContain(secret);
      }
    }
  });
});
