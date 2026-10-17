import { createPrivateKey, createPublicKey, sign, verify, X509Certificate, type KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Environment, HttpMethod } from '../../src/constants.js';
import { appStore, type AppStoreConfig, type AppStoreProviderOptions } from '../../src/providers/appstore/index.js';
import type { WebhookRequest } from '../../src/schemas.js';
import { mockFetch, type MockRoute, type RecordedCall } from '../helpers/mock-fetch.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const FIXTURES = join(HERE, 'fixtures');
const PKI = join(FIXTURES, 'pki');
const APPLE = join(FIXTURES, 'apple');

/** The clock of every test, inside the validity window of the generated leaf (2026-01-01 to 2027-01-01). */
export const NOW = new Date('2026-11-22T10:00:00.000Z');
export const NOW_MS = NOW.getTime();
export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

export const BUNDLE_ID = 'com.example';
export const ISSUER_ID = '57246542-96fe-1a63-e053-0824d011072a';
export const KEY_ID = '2X9R4HXF34';
export const OFFER_KEY_ID = 'OFFERKEY99';
export const APP_APPLE_ID = 1234567890;

/** The hosts, from the App Store Server API page. */
export const SANDBOX_API = 'https://api.storekit-sandbox.apple.com';
export const PRODUCTION_API = 'https://api.storekit.apple.com';

export function pki(name: string): string {
  return readFileSync(join(PKI, name), 'utf8');
}

export function appleFixture<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(join(APPLE, path), 'utf8')) as T;
}

export function appleText(path: string): string {
  return readFileSync(join(APPLE, path), 'utf8').trim();
}

export function appleBytes(path: string): Buffer {
  return readFileSync(join(APPLE, path));
}

/** The base64 DER of a PEM certificate, as it goes into an `x5c` header. */
export function x5cEntry(pem: string): string {
  return new X509Certificate(pem).raw.toString('base64');
}

export const GOOD_CHAIN = ['leaf', 'intermediate', 'root'] as const;

export interface SignOptions {
  /** Names of the certificates for the `x5c` header, leaf first. The leaf's key signs. */
  chain?: readonly string[];
  /** The name of the key that signs, when it is not the leaf's. */
  signWith?: string;
  /** A header that replaces the default. */
  header?: Record<string, unknown>;
}

function base64url(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url');
}

/** Signs a payload as the App Store does: ES256, the chain in `x5c`, the raw r||s signature. */
export function signJws(payload: unknown, options: SignOptions = {}): string {
  const chain = options.chain ?? GOOD_CHAIN;
  const header = options.header ?? { alg: 'ES256', typ: 'JWT', x5c: chain.map((name) => x5cEntry(pki(`${name}.pem`))) };
  const key = createPrivateKey(pki(`${options.signWith ?? chain[0]}.key`));
  const input = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = sign('sha256', Buffer.from(input, 'ascii'), { key, dsaEncoding: 'ieee-p1363' });
  return `${input}.${base64url(signature)}`;
}

/** Replaces the payload of a JWS, leaving header and signature as they were: a tampered JWS. */
export function withPayload(jws: string, payload: unknown): string {
  const [header, , signature] = jws.split('.') as [string, string, string];
  return `${header}.${base64url(JSON.stringify(payload))}.${signature}`;
}

export function decodeJws(jws: string): { header: Record<string, unknown>; payload: Record<string, unknown> } {
  const [header, payload] = jws.split('.') as [string, string];
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Record<string, unknown>,
    payload: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>,
  };
}

/** True when `signature` (DER, base64) verifies over `text` with the public half of the `.p8` key. */
export function verifyDerSignature(p8: string, text: string, signatureBase64: string): boolean {
  const publicKey: KeyObject = createPublicKey(createPrivateKey(p8));
  return verify('sha256', Buffer.from(text, 'utf8'), publicKey, Buffer.from(signatureBase64, 'base64'));
}

// ---------------------------------------------------------------------------
// Sample payloads
// ---------------------------------------------------------------------------

export type Payload = Record<string, unknown>;

/** Apple's sample JWSTransactionDecodedPayload (library test resources) turned into an INR sandbox purchase. */
export function transactionPayload(overrides: Payload = {}): Payload {
  const sample = appleFixture<Payload>('models/signedTransaction.json');
  const {
    advancedCommerceInfo: _advanced,
    revocationDate: _revocationDate,
    revocationReason: _revocationReason,
    isUpgraded: _isUpgraded,
    offerType: _offerType,
    offerIdentifier: _offerIdentifier,
    offerDiscountType: _offerDiscountType,
    offerPeriod: _offerPeriod,
    commitmentInfo: _commitment,
    billingPlanType: _billing,
    previousOriginalTransactionId: _previous,
    ...base
  } = sample;
  return {
    ...base,
    environment: 'Sandbox',
    storefront: 'IND',
    storefrontId: '143467',
    currency: 'INR',
    // INR 499, in milliunits.
    price: 499_000,
    purchaseDate: NOW_MS - 10 * DAY,
    originalPurchaseDate: NOW_MS - 100 * DAY,
    expiresDate: NOW_MS + 20 * DAY,
    signedDate: NOW_MS,
    ...overrides,
  };
}

/** A one-time purchase transaction. */
export function oneTimePayload(overrides: Payload = {}): Payload {
  return transactionPayload({
    transactionId: '2000000900000001',
    originalTransactionId: '2000000900000001',
    productId: 'com.example.coins',
    type: 'Consumable',
    expiresDate: undefined,
    subscriptionGroupIdentifier: undefined,
    price: 99_000,
    ...overrides,
  });
}

export function renewalPayload(overrides: Payload = {}): Payload {
  const sample = appleFixture<Payload>('models/signedRenewalInfo.json');
  const {
    advancedCommerceInfo: _advanced,
    commitmentInfo: _commitment,
    renewalBillingPlanType: _billing,
    eligibleWinBackOfferIds: _eligible,
    offerType: _offerType,
    offerIdentifier: _offerIdentifier,
    offerDiscountType: _offerDiscountType,
    offerPeriod: _offerPeriod,
    expirationIntent: _intent,
    ...base
  } = sample;
  return {
    ...base,
    environment: 'Sandbox',
    currency: 'INR',
    renewalPrice: 499_000,
    isInBillingRetryPeriod: false,
    autoRenewStatus: 1,
    signedDate: NOW_MS,
    ...overrides,
  };
}

export const ORIGINAL_ID = '12345';
export const TRANSACTION_ID = '23456';
export const ONE_TIME_ID = '2000000900000001';
export const APP_ACCOUNT_TOKEN = '7e3fb20b-4cdb-47cc-936d-99d65f608138';

export function signedTransaction(overrides: Payload = {}, options?: SignOptions): string {
  return signJws(transactionPayload(overrides), options);
}

export function signedRenewal(overrides: Payload = {}, options?: SignOptions): string {
  return signJws(renewalPayload(overrides), options);
}

export function statusItem(status: number, transaction: Payload = {}, renewal: Payload | null = {}): Record<string, unknown> {
  return {
    originalTransactionId: (transaction.originalTransactionId as string | undefined) ?? ORIGINAL_ID,
    status,
    signedTransactionInfo: signedTransaction(transaction),
    ...(renewal ? { signedRenewalInfo: signedRenewal(renewal) } : {}),
  };
}

/** The shape of Get All Subscription Statuses (library sample `getAllSubscriptionStatusesResponse.json`). */
export function statusResponse(items: Record<string, unknown>[], group = 'sub_group_one'): Record<string, unknown> {
  return {
    environment: 'Sandbox',
    bundleId: BUNDLE_ID,
    appAppleId: APP_APPLE_ID,
    data: [{ subscriptionGroupIdentifier: group, lastTransactions: items }],
  };
}

export function notificationPayload(overrides: Payload = {}, data: Payload | null = {}): Payload {
  const { subtype: _subtype, ...sample } = appleFixture<Payload>('models/signedNotification.json');
  return {
    ...sample,
    ...(data === null
      ? {}
      : {
          data: {
            environment: 'Sandbox',
            appAppleId: APP_APPLE_ID,
            bundleId: BUNDLE_ID,
            bundleVersion: '1.2.3',
            status: 1,
            signedTransactionInfo: signedTransaction(),
            signedRenewalInfo: signedRenewal(),
            ...data,
          },
        }),
    ...overrides,
  };
}

export function webhook(signedPayload: string): WebhookRequest {
  return { rawBody: JSON.stringify({ signedPayload }), headers: {} };
}

// ---------------------------------------------------------------------------
// The provider under test
// ---------------------------------------------------------------------------

export const API_P8 = pki('api-key.p8');
export const OFFER_P8 = pki('offer-key.p8');

export function config(overrides: Partial<AppStoreConfig> = {}): AppStoreConfig {
  return {
    bundleId: BUNDLE_ID,
    issuerId: ISSUER_ID,
    keyId: KEY_ID,
    privateKey: API_P8,
    environment: Environment.Test,
    rootCertificates: [pki('root.pem')],
    ...overrides,
  };
}

export const FIXED_TOKEN = '0b0d9f6e-5a5e-4a8e-9c53-5f5a3f0b7c11';
export const FIXED_NONCE = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';

export interface Harness {
  provider: ReturnType<typeof appStore>;
  calls: RecordedCall[];
  remaining: () => number;
}

export function harness(
  routes: MockRoute[] = [],
  overrides: Partial<AppStoreConfig> = {},
  options: AppStoreProviderOptions = {},
): Harness {
  const { fetch, calls, remaining } = mockFetch(routes);
  const provider = appStore(config(overrides), {
    fetch,
    now: () => NOW,
    maxRetries: 0,
    generateToken: () => FIXED_TOKEN,
    generateNonce: () => FIXED_NONCE,
    ...options,
  });
  return { provider, calls, remaining };
}

export function route(method: HttpMethod, path: string, json: unknown, status = 200, host = SANDBOX_API): MockRoute {
  return { method, url: `${host}${path}`, json, status };
}

export function get(path: string, json: unknown, status = 200): MockRoute {
  return route(HttpMethod.Get, path, json, status);
}

/** Everything in an error that could leak: message, raw and code, as one string. */
export function everythingIn(error: unknown): string {
  const value = error as { message?: string; raw?: unknown; toJSON?: () => unknown };
  return JSON.stringify([value.message, value.raw, value.toJSON?.()]);
}

export async function rejection(promise: Promise<unknown>): Promise<Error & { code?: string; httpStatus?: number; providerCode?: string; raw?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('expected the call to be rejected');
}

export function thrown(fn: () => unknown): Error & { code?: string } {
  try {
    fn();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('expected the call to throw');
}
