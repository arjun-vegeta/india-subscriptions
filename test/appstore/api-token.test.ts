import { createPrivateKey, createPublicKey, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { Environment, HttpMethod } from '../../src/constants.js';
import { appStore, createApiToken } from '../../src/providers/appstore/index.js';
import { mockFetch } from '../helpers/mock-fetch.js';
import {
  API_P8,
  BUNDLE_ID,
  ISSUER_ID,
  KEY_ID,
  NOW,
  ORIGINAL_ID,
  PRODUCTION_API,
  SANDBOX_API,
  decodeJws,
  APP_APPLE_ID,
  config,
  get,
  harness,
  route,
  statusItem,
  statusResponse,
} from './helpers.js';

function bearer(headers: Record<string, string>): string {
  const value = headers.authorization as string;
  expect(value.startsWith('Bearer ')).toBe(true);
  return value.slice('Bearer '.length);
}

describe('the JWT the adapter sends (App Store Server API: Generating JSON Web Tokens for API requests)', () => {
  it('has the documented header and claims', async () => {
    const h = harness([get(`/inApps/v1/subscriptions/${ORIGINAL_ID}`, statusResponse([statusItem(1)]))]);
    await h.provider.getSubscription(ORIGINAL_ID);
    const token = bearer(h.calls[0]?.headers as Record<string, string>);
    const { header, payload } = decodeJws(token);
    expect(header).toEqual({ alg: 'ES256', kid: KEY_ID, typ: 'JWT' });
    const iat = Math.floor(NOW.getTime() / 1000);
    expect(payload).toEqual({ iss: ISSUER_ID, iat, exp: iat + 300, aud: 'appstoreconnect-v1', bid: BUNDLE_ID });
    // Apple: "Tokens that expire more than 60 minutes after the time in iat are not valid".
    expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(3600);
  });

  it('is signed with the configured key: ES256, raw r||s, verified with the public half computed independently', async () => {
    const h = harness([get(`/inApps/v1/subscriptions/${ORIGINAL_ID}`, statusResponse([statusItem(1)]))]);
    await h.provider.getSubscription(ORIGINAL_ID);
    const token = bearer(h.calls[0]?.headers as Record<string, string>);
    const [header, payload, signature] = token.split('.') as [string, string, string];
    const raw = Buffer.from(signature, 'base64url');
    expect(raw.length).toBe(64);
    const publicKey = createPublicKey(API_P8);
    expect(verify('sha256', Buffer.from(`${header}.${payload}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
    expect(verify('sha256', Buffer.from(`${header}.${payload}x`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(false);
  });

  it('is made again for every request, from the clock of that request', () => {
    const key = createPrivateKey(API_P8);
    const input = { key, keyId: KEY_ID, issuerId: ISSUER_ID, bundleId: BUNDLE_ID };
    const first = createApiToken({ ...input, now: NOW });
    const later = createApiToken({ ...input, now: new Date(NOW.getTime() + 61_000) });
    expect(decodeJws(later).payload.iat).toBe((decodeJws(first).payload.iat as number) + 61);
  });

  it('sends the sandbox host for test and the production host for live', async () => {
    const sandbox = harness([get(`/inApps/v1/subscriptions/${ORIGINAL_ID}`, statusResponse([statusItem(1)]))]);
    await sandbox.provider.getSubscription(ORIGINAL_ID);
    expect(sandbox.calls[0]?.url.startsWith(`${SANDBOX_API}/inApps/`)).toBe(true);

    const { fetch, calls } = mockFetch([
      route(HttpMethod.Get, `/inApps/v1/transactions/23456`, { signedTransactionInfo: 'x' }, 200, PRODUCTION_API),
    ]);
    const live = appStore(config({ environment: Environment.Live, appAppleId: APP_APPLE_ID }), { fetch, now: () => NOW, maxRetries: 0 });
    // The payload does not verify (it is not a JWS); the request is what is under test.
    await expect(live.getCharge(ORIGINAL_ID, '23456')).rejects.toThrow();
    expect(calls[0]?.url).toBe(`${PRODUCTION_API}/inApps/v1/transactions/23456`);
  });
});
