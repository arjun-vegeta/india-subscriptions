import { createHash } from 'node:crypto';
import { Environment } from '../../src/constants.js';
import { payu, type PayUConfig, type PayUProviderOptions } from '../../src/providers/payu/index.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';

/** A key that appears in the docs' samples. The salt is invented: PayU publishes no salt. */
export const KEY = 'BmTY3G';
export const SALT = 'test-salt-9f3b-never-a-real-salt';
export const NOW = new Date('2026-11-17T05:00:00.000Z');
export const SUCCESS_URL = 'https://merchant.example/payu/success';
export const FAILURE_URL = 'https://merchant.example/payu/failure';
export const TEST_API_URL = 'https://test.payu.in/merchant/postservice.php?form=2';
export const TEST_PAYMENT_URL = 'https://test.payu.in/_payment';

/** Independent SHA-512 (hex) straight from node:crypto. */
export function sha512Hex(text: string): string {
  return createHash('sha512').update(text, 'utf8').digest('hex');
}

/** `sha512(key|command|var1|salt)`, written out literally. */
export function expectedCommandHash(command: string, var1: string): string {
  return sha512Hex(`${KEY}|${command}|${var1}|${SALT}`);
}

export interface ConsentHashFields {
  txnid: string;
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  si_details: string;
}

/** The consent hash with `pipes` between udf5 and si_details, written out literally for the three layouts. */
export function expectedConsentHash(fields: ConsentHashFields, pipes: 4 | 5 | 6): string {
  const head = `${KEY}|${fields.txnid}|${fields.amount}|${fields.productinfo}|${fields.firstname}|${fields.email}|||||`;
  const gap = pipes === 4 ? '||||' : pipes === 5 ? '|||||' : '||||||';
  return sha512Hex(`${head}${gap}${fields.si_details}|${SALT}`);
}

export type PaymentFields = Record<string, string>;

/**
 * The reverse hash of a payment response, written out literally:
 * `salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key`.
 */
export function expectedReverseHash(fields: PaymentFields): string {
  const f = (name: string): string => fields[name] ?? '';
  const prefix = f('additional_charges') ? `${f('additional_charges')}|` : '';
  return sha512Hex(
    `${prefix}${SALT}|${f('status')}||||||${f('udf5')}|${f('udf4')}|${f('udf3')}|${f('udf2')}|${f('udf1')}|${f('email')}|${f('firstname')}|${f('productinfo')}|${f('amount')}|${f('txnid')}|${KEY}`,
  );
}

/** Adds the hash PayU would have computed with the test salt. The docs publish no salt, so doc hashes cannot be reused. */
export function signPayment(fields: PaymentFields): PaymentFields {
  return { ...fields, hash: expectedReverseHash(fields) };
}

export interface Harness {
  provider: ReturnType<typeof payu>;
  calls: RecordedCall[];
  remaining: () => number;
}

export function makeProvider(
  routes: MockRoute[] = [],
  config: Partial<PayUConfig> = {},
  options: Partial<PayUProviderOptions> = {},
): Harness {
  const mock = mockFetch(routes);
  let counter = 0;
  const provider = payu(
    {
      key: KEY,
      salt: SALT,
      environment: Environment.Test,
      successUrl: SUCCESS_URL,
      failureUrl: FAILURE_URL,
      ...config,
    },
    {
      fetch: mock.fetch,
      now: () => NOW,
      maxRetries: 0,
      // "sub_00000000000000000001" (24 characters, within PayU's 25) and "req_000000000000000000000001".
      generateId: (prefix, bytes) => `${prefix}_${String(++counter).padStart(bytes * 2, '0')}`,
      ...options,
    },
  );
  return { provider, calls: mock.calls, remaining: mock.remaining };
}

/** Route for a postservice command. */
export function apiRoute(json: unknown, status = 200): MockRoute {
  return { method: 'POST', url: TEST_API_URL, json, status };
}

/** The `var1` of a recorded postservice call, parsed. */
export function var1Of(call: RecordedCall): Record<string, unknown> {
  return JSON.parse(call.form?.var1 ?? 'null') as Record<string, unknown>;
}

export const CUSTOMER = { name: 'Ashish Kumar', email: 'ashish@example.com', phone: '9876543210' };

export const MONTHLY_PLAN = {
  name: 'Pro monthly',
  amount: 49900,
  interval: { unit: 'month', count: 1 },
} as const;
