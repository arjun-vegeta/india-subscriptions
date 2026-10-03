import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { expect } from 'vitest';
import { Environment } from '../../src/constants.js';
import { paytm, type PaytmConfig, type PaytmProviderOptions } from '../../src/providers/paytm/index.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';

/** The MID of Paytm's own samples. The key is invented: Paytm publishes none, so documented signatures cannot be reused. */
export const MID = 'INTEGR7769XXXXXX9383';
export const KEY = 'a1B2c3D4e5F6g7H8';
export const SALT = 'AbC+';
export const NOW = new Date('2026-11-17T05:00:00.000Z');
export const CALLBACK_URL = 'https://merchant.example/paytm/callback';
export const RETURN_URL = 'https://merchant.example/return';

export const STAGING = 'https://securestage.paytmpayments.com';
export const PRODUCTION = 'https://secure.paytmpayments.com';
export const STAGING_GW = 'https://securegw-stage.paytmpayments.in';
export const PRODUCTION_GW = 'https://securegw.paytmpayments.in';

// ---------------------------------------------------------------------------
// An independent implementation of Paytm's checksum, written from the algorithm text with node:crypto only (it shares no
// code with src/providers/paytm/checksum.ts), so a signature the adapter produces is checked by something else.
// ---------------------------------------------------------------------------

const IV = Buffer.from('@@@@&&&&####$$$$', 'latin1');

export function independentSign(text: string, key: string, salt: string = SALT): string {
  const digest = createHash('sha256').update(`${text}|${salt}`, 'utf8').digest('hex');
  const cipher = createCipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), IV);
  return Buffer.concat([cipher.update(Buffer.from(digest + salt, 'latin1')), cipher.final()]).toString('base64');
}

/** Decrypts a checksum and recomputes it: true only for a genuine one. */
export function independentVerify(text: string, key: string, signature: string): boolean {
  try {
    const decipher = createDecipheriv('aes-128-cbc', Buffer.from(key, 'utf8'), IV);
    const plain = Buffer.concat([decipher.update(Buffer.from(signature, 'base64')), decipher.final()]).toString('latin1');
    const salt = plain.slice(-4);
    return plain === createHash('sha256').update(`${text}|${salt}`, 'utf8').digest('hex') + salt;
  } catch {
    return false;
  }
}

/** The text a key-value post is signed over: every field but CHECKSUMHASH, names sorted, values joined with "|". */
export function formText(fields: Record<string, string | null>): string {
  return Object.keys(fields)
    .filter((name) => name !== 'CHECKSUMHASH')
    .sort()
    .map((name) => fields[name] ?? '')
    .join('|');
}

/** A key-value post with the checksum Paytm would add (computed with the test key). */
export function signForm(fields: Record<string, string>, key: string = KEY, salt: string = SALT): Record<string, string> {
  return { ...fields, CHECKSUMHASH: independentSign(formText(fields), key, salt) };
}

/** The form as the raw body of a webhook request. */
export function formBody(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

export function webhookRequest(rawBody: string) {
  return { rawBody, headers: {} };
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export function makeProvider(
  routes: MockRoute[] = [],
  config: Partial<PaytmConfig> = {},
  options: Partial<PaytmProviderOptions> = {},
) {
  const mock = mockFetch(routes);
  let counter = 0;
  const provider = paytm(
    { mid: MID, merchantKey: KEY, website: 'WEBSTAGING', environment: Environment.Test, ...config },
    {
      fetch: mock.fetch,
      now: () => NOW,
      maxRetries: 0,
      generateId: (prefix) => `${prefix}_gen${(counter += 1)}`,
      generateSalt: () => SALT,
      ...options,
    },
  );
  return { provider, calls: mock.calls, remaining: mock.remaining };
}

/** `{ head, body }` as Paytm answers. */
export function reply(body: unknown, head: unknown = { responseTimestamp: '1567159599647', version: 'v1' }) {
  return { head, body };
}

export interface SentRequest {
  /** The request as parsed. */
  head: Record<string, unknown>;
  body: Record<string, unknown>;
  /** The exact text of the `body` member as sent. */
  sentBodyText: string;
  url: URL;
}

/**
 * Parses a recorded request and proves the signature: the text that is signed (the body re-serialised compactly) is
 * contained, byte for byte, in what was sent, and `head.signature` verifies against it with an independent implementation.
 */
export function sent(call: RecordedCall, key: string = KEY): SentRequest {
  expect(call.method).toBe('POST');
  expect(call.headers['content-type']).toBe('application/json');
  const parsed = JSON.parse(call.body ?? '') as { head: Record<string, unknown>; body: Record<string, unknown> };
  const signedText = JSON.stringify(parsed.body);
  expect(call.body, 'the signed text is a substring of the request, byte for byte').toContain(`"body":${signedText}`);
  expect(typeof parsed.head.signature).toBe('string');
  expect((parsed.head.signature as string).length).toBe(108);
  expect(independentVerify(signedText, key, parsed.head.signature as string)).toBe(true);
  return { head: parsed.head, body: parsed.body, sentBodyText: signedText, url: new URL(call.url) };
}

export const CUSTOMER = { id: 'CUST_001', name: 'Ashish Kumar', email: 'ashish@example.com', phone: '+919876543210' };

export const MONTHLY_PLAN = {
  name: 'Pro monthly',
  amount: 49900,
  interval: { unit: 'month', count: 1 },
} as const;

/** A Fetch Subscription Status success, based on the docs' sample, for a merchant-collected (VARIABLE) subscription. */
export function statusAnswer(overrides: Record<string, unknown> = {}, resultInfo: Record<string, unknown> | undefined = undefined) {
  return reply({
    resultInfo: resultInfo ?? { code: '3006', message: 'SUCCESS', status: 'SUCCESS' },
    subsId: '130010',
    status: 'ACTIVE',
    orderId: 'ORDER_1',
    subsPaymentInstDetails: { bankName: 'WALLET', paymentMode: 'UPI', ppiType: 'N' },
    amountType: 'VARIABLE',
    maxAmount: '499.0',
    mid: MID,
    frequencyUnit: 'MONTH',
    frequency: '1',
    merchantName: 'bharat chudhary',
    expiryDate: '2031-11-17 00:00:00',
    createdDate: '2026-11-17 10:30:00',
    updatedDate: '2026-11-17 10:35:00',
    custId: 'CUST_001',
    custEmailId: 'ashish@example.com',
    custMobileNo: '9876543210',
    upfrontTxnAmount: '0.00',
    ...overrides,
  });
}
