import { createHash, X509Certificate } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorCode, Environment } from '../../src/constants.js';
import { verifyChain, hasExtension, VerificationFailure } from '../../src/providers/appstore/certificates.js';
import {
  APPLE_ROOT_CA_G3_PEM,
  APPLE_ROOT_CA_G3_SHA256,
  RECEIPT_SIGNING_LEAF_OID,
  WWDR_INTERMEDIATE_OID,
} from '../../src/providers/appstore/constants.js';
import { verifySignedData } from '../../src/providers/appstore/jws.js';
import { AppStoreVerifier } from '../../src/providers/appstore/verifier.js';
import {
  APP_APPLE_ID,
  BUNDLE_ID,
  NOW,
  appleBytes,
  appleFixture,
  appleText,
  decodeJws,
  notificationPayload,
  pki,
  signJws,
  signedRenewal,
  signedTransaction,
  thrown,
  transactionPayload,
  withPayload,
  x5cEntry,
} from './helpers.js';

function verifier(overrides: { environment?: Environment; bundleId?: string; appAppleId?: number | undefined; roots?: string[]; now?: Date } = {}) {
  return new AppStoreVerifier({
    bundleId: overrides.bundleId ?? BUNDLE_ID,
    environment: overrides.environment ?? Environment.Test,
    appAppleId: overrides.appAppleId,
    rootCertificates: overrides.roots ?? [pki('root.pem')],
    now: () => overrides.now ?? NOW,
  });
}

function signatureInvalid(fn: () => unknown, reason?: string): void {
  const error = thrown(fn);
  expect(error.code).toBe(ErrorCode.SignatureInvalid);
  if (reason) expect(error.message).toContain(reason);
}

describe('the pinned Apple root', () => {
  it('is Apple Root CA - G3 with the pinned SHA-256 fingerprint', () => {
    const root = new X509Certificate(APPLE_ROOT_CA_G3_PEM);
    expect(createHash('sha256').update(root.raw).digest('hex')).toBe(APPLE_ROOT_CA_G3_SHA256);
    expect(root.subject).toContain('CN=Apple Root CA - G3');
    expect(root.issuer).toBe(root.subject);
    expect(root.ca).toBe(true);
    expect(root.validTo).toContain('2039');
  });

  it("is the root Apple's own test suite verifies against (apple-library fixtures)", () => {
    const real = appleFixture<{ root: string }>('certs/real-apple-chain.json');
    expect(new X509Certificate(Buffer.from(real.root, 'base64')).raw.equals(new X509Certificate(APPLE_ROOT_CA_G3_PEM).raw)).toBe(true);
  });

  it('is what the verifier trusts when no root is given', () => {
    // A JWS from the generated chain does not verify against Apple's root.
    const defaultRoot = new AppStoreVerifier({ bundleId: BUNDLE_ID, environment: Environment.Test, now: () => NOW });
    signatureInvalid(() => defaultRoot.transaction(signedTransaction()), 'does not lead to the trusted root');
  });
});

describe("Apple's published chain (apple-library fixtures, jws_verification.test.ts)", () => {
  const real = appleFixture<{ root: string; intermediate: string; leaf: string; effectiveDateMs: number }>('certs/real-apple-chain.json');
  const cert = (base64: string) => new X509Certificate(Buffer.from(base64, 'base64'));

  it('verifies against the pinned Apple Root CA - G3 at the date Apple uses', () => {
    const key = verifyChain(cert(real.leaf), cert(real.intermediate), [new X509Certificate(APPLE_ROOT_CA_G3_PEM)], new Date(real.effectiveDateMs));
    expect(key.asymmetricKeyType).toBe('ec');
  });

  it('carries the two extensions the adapter looks for', () => {
    expect(hasExtension(cert(real.leaf), RECEIPT_SIGNING_LEAF_OID)).toBe(true);
    expect(hasExtension(cert(real.intermediate), WWDR_INTERMEDIATE_OID)).toBe(true);
    expect(hasExtension(cert(real.leaf), WWDR_INTERMEDIATE_OID)).toBe(false);
  });

  it('is refused after the leaf expired (2027-10-13)', () => {
    expect(() => verifyChain(cert(real.leaf), cert(real.intermediate), [new X509Certificate(APPLE_ROOT_CA_G3_PEM)], new Date('2027-10-14T00:00:00Z'))).toThrow(
      /expired/,
    );
  });

  it('is refused against a different root', () => {
    expect(() => verifyChain(cert(real.leaf), cert(real.intermediate), [new X509Certificate(pki('root.pem'))], new Date(real.effectiveDateMs))).toThrow(
      /trusted root/,
    );
  });
});

describe("Apple's signed test data (apple-library fixtures, a test certificate authority)", () => {
  // `mock_signed_data` is signed with a test chain whose root is certs/testCA.der, valid 2023-01-05 to 2033-01-02.
  const appleRoot = [new X509Certificate(appleBytes('certs/testCA.der')).toString()];
  const sandbox = (bundleId = 'com.example') => verifier({ roots: appleRoot, bundleId, appAppleId: 1234 });

  const roots = appleRoot.map((pem) => new X509Certificate(pem));

  it('verifies a transaction, renewal information and a notification', () => {
    // Apple's mock transaction and renewal information carry only bundleId, environment and signedDate, not the fields the
    // adapter needs to read a purchase, so their chain and signature are checked below the payload schemas.
    expect(verifySignedData(appleText('mock_signed_data/transactionInfo'), roots, NOW)).toMatchObject({ bundleId: 'com.example', environment: 'Sandbox' });
    expect(verifySignedData(appleText('mock_signed_data/renewalInfo'), roots, NOW)).toMatchObject({ environment: 'Sandbox' });
    expect(sandbox().notification(appleText('mock_signed_data/testNotification')).notificationType).toBe('TEST');
  });

  it('refuses the mock transaction once its bytes change', () => {
    const jws = appleText('mock_signed_data/transactionInfo');
    expect(() => verifySignedData(withPayload(jws, { bundleId: 'com.example', environment: 'Sandbox' }), roots, NOW)).toThrow(/signature does not match/);
  });

  it("refuses the library's notification for another bundle id", () => {
    signatureInvalid(() => sandbox().notification(appleText('mock_signed_data/wrongBundleId')), 'not for this app');
    signatureInvalid(() => sandbox('com.other').notification(appleText('mock_signed_data/testNotification')), 'bundle id');
  });

  it('refuses the same data in the production environment', () => {
    const production = verifier({ roots: appleRoot, environment: Environment.Live, appAppleId: 1234 });
    signatureInvalid(() => production.notification(appleText('mock_signed_data/testNotification')), 'environment');
  });

  it('refuses it against the generated root', () => {
    signatureInvalid(() => verifier().transaction(appleText('mock_signed_data/transactionInfo')), 'trusted root');
  });
});

describe('the certificate chain', () => {
  it('accepts the good chain', () => {
    expect(verifier().transaction(signedTransaction()).transactionId).toBe('23456');
  });

  it('refuses a chain from another root, even though its own signature is fine', () => {
    const jws = signedTransaction({}, { chain: ['other-leaf', 'other-intermediate', 'other-root'] });
    signatureInvalid(() => verifier().transaction(jws), 'does not lead to the trusted root');
  });

  it('refuses a chain whose header lists the right root but whose intermediate was issued by another', () => {
    const jws = signedTransaction({}, { chain: ['other-leaf', 'other-intermediate', 'root'] });
    signatureInvalid(() => verifier().transaction(jws), 'trusted root');
  });

  it('refuses a leaf that was not issued by the intermediate', () => {
    const jws = signedTransaction({}, { chain: ['other-leaf', 'intermediate', 'root'] });
    signatureInvalid(() => verifier().transaction(jws), 'not issued by the intermediate');
  });

  it('refuses an expired leaf', () => {
    signatureInvalid(() => verifier().transaction(signedTransaction({}, { chain: ['expired-leaf', 'intermediate', 'root'] })), 'expired');
  });

  it('refuses a leaf that is not valid yet', () => {
    signatureInvalid(() => verifier().transaction(signedTransaction({}, { chain: ['future-leaf', 'intermediate', 'root'] })), 'not valid yet');
  });

  it('judges validity by the adapter clock, with a minute of slack on each side', () => {
    const jws = signedTransaction();
    const leaf = new X509Certificate(pki('leaf.pem'));
    const notAfter = Date.parse(leaf.validTo);
    expect(verifier({ now: new Date(notAfter + 59_000) }).transaction(jws).transactionId).toBe('23456');
    signatureInvalid(() => verifier({ now: new Date(notAfter + 61_000) }).transaction(jws), 'expired');
    const notBefore = Date.parse(leaf.validFrom);
    expect(verifier({ now: new Date(notBefore - 59_000) }).transaction(jws).transactionId).toBe('23456');
    signatureInvalid(() => verifier({ now: new Date(notBefore - 61_000) }).transaction(jws), 'not valid yet');
  });

  it('refuses a leaf without the receipt-signing extension', () => {
    signatureInvalid(() => verifier().transaction(signedTransaction({}, { chain: ['no-oid-leaf', 'intermediate', 'root'] })), 'receipt-signing extension');
  });

  it('refuses an intermediate without the Worldwide Developer Relations extension', () => {
    signatureInvalid(
      () => verifier().transaction(signedTransaction({}, { chain: ['no-oid-intermediate-leaf', 'no-oid-intermediate', 'root'] })),
      'Worldwide Developer Relations extension',
    );
  });

  it('refuses an intermediate that is not a certificate authority', () => {
    signatureInvalid(() => verifier().transaction(signedTransaction({}, { chain: ['not-ca-leaf', 'not-ca-intermediate', 'root'] })), 'not a certificate authority');
  });

  it('needs exactly three certificates in x5c', () => {
    signatureInvalid(() => verifier().transaction(signedTransaction({}, { chain: ['leaf', 'intermediate'] })), 'exactly three');
    signatureInvalid(() => verifier().transaction(signedTransaction({}, { chain: ['leaf', 'intermediate', 'root', 'root'] })), 'exactly three');
    signatureInvalid(() => verifier().transaction(signJws(transactionPayload(), { header: { alg: 'ES256', x5c: [] } })), 'exactly three');
  });

  it('refuses certificates that are not certificates', () => {
    const good = x5cEntry(pki('leaf.pem'));
    signatureInvalid(() => verifier().transaction(signJws(transactionPayload(), { header: { alg: 'ES256', x5c: ['abc', 'def', 'ghi'] } })), 'x5c');
    signatureInvalid(() => verifier().transaction(signJws(transactionPayload(), { header: { alg: 'ES256', x5c: [good, 'AAAA', good] } })), 'cannot be parsed');
    signatureInvalid(() => verifier().transaction(signJws(transactionPayload(), { header: { alg: 'ES256', x5c: [good, 'not base64!', good] } })), 'not base64');
  });

  it('needs the trusted root to be a root: an intermediate presented as the only root does not make the chain trusted', () => {
    const asRoot = verifier({ roots: [pki('intermediate.pem')] });
    signatureInvalid(() => asRoot.transaction(signedTransaction()), 'trusted root');
  });

  it('accepts any of several trusted roots', () => {
    const two = verifier({ roots: [pki('other-root.pem'), pki('root.pem')] });
    expect(two.transaction(signedTransaction()).transactionId).toBe('23456');
    expect(two.transaction(signedTransaction({}, { chain: ['other-leaf', 'other-intermediate', 'other-root'] })).transactionId).toBe('23456');
  });
});

describe('the signature', () => {
  it('refuses a payload that was changed after signing', () => {
    const jws = signedTransaction();
    const { payload } = decodeJws(jws);
    signatureInvalid(() => verifier().transaction(withPayload(jws, { ...payload, price: 1 })), 'signature does not match');
  });

  it('refuses a header that was changed after signing', () => {
    const jws = signedTransaction();
    const [, payload, signature] = jws.split('.') as [string, string, string];
    const header = decodeJws(jws).header;
    const changed = Buffer.from(JSON.stringify({ ...header, typ: 'other' })).toString('base64url');
    signatureInvalid(() => verifier().transaction(`${changed}.${payload}.${signature}`), 'signature does not match');
  });

  it('refuses a signature made by another key than the leaf', () => {
    const jws = signedTransaction({}, { signWith: 'other-leaf' });
    signatureInvalid(() => verifier().transaction(jws), 'signature does not match');
  });

  it('refuses a signature of the wrong length or an empty one', () => {
    const [header, payload] = signedTransaction().split('.') as [string, string];
    signatureInvalid(() => verifier().transaction(`${header}.${payload}.AAAA`), 'wrong length');
    signatureInvalid(() => verifier().transaction(`${header}.${payload}.`), 'compact serialisation');
  });

  it('refuses algorithms other than ES256, including none', () => {
    for (const alg of ['none', 'HS256', 'ES384', 'RS256']) {
      const jws = signJws(transactionPayload(), { header: { alg, x5c: ['a', 'b', 'c'] } });
      signatureInvalid(() => verifier().transaction(jws), 'ES256');
    }
  });

  it('refuses things that are not a JWS', () => {
    for (const bad of ['', 'abc', 'a.b', 'a.b.c.d', 'a..c', '....', 'signed_transaction_info_value']) {
      signatureInvalid(() => verifier().transaction(bad));
    }
    signatureInvalid(() => verifier().transaction('a b.c.d'), 'compact serialisation');
  });

  it('refuses signed data whose payload is not a JSON object', () => {
    signatureInvalid(() => verifier().transaction(signJws([1, 2, 3])), 'not a JSON object');
    signatureInvalid(() => verifier().transaction(signJws('text')), 'not a JSON object');
  });

  it('answers UNEXPECTED_RESPONSE, not SIGNATURE_INVALID, for authentic data without the fields the adapter needs', () => {
    expect(thrown(() => verifier().transaction(signJws({ environment: 'Sandbox', bundleId: BUNDLE_ID }))).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

describe('bundle id and environment', () => {
  it('refuses a transaction for another bundle id', () => {
    signatureInvalid(() => verifier().transaction(signedTransaction({ bundleId: 'com.other' })), 'bundle id');
    signatureInvalid(() => verifier().transaction(signedTransaction({ bundleId: undefined })), 'bundle id');
  });

  it('refuses a transaction from the other environment', () => {
    signatureInvalid(() => verifier().transaction(signedTransaction({ environment: 'Production' })), 'environment is not Sandbox');
    signatureInvalid(() => verifier({ environment: Environment.Live, appAppleId: APP_APPLE_ID }).transaction(signedTransaction()), 'environment is not Production');
  });

  it('refuses the environments Apple lists only for local testing: Xcode and LocalTesting are not signed by the App Store', () => {
    for (const environment of ['Xcode', 'LocalTesting', undefined]) {
      signatureInvalid(() => verifier().transaction(signedTransaction({ environment })), 'environment');
    }
  });

  it('does not mind the case of the environment', () => {
    expect(verifier().transaction(signedTransaction({ environment: 'sandbox' })).transactionId).toBe('23456');
  });

  it('checks the environment of renewal information, which names no bundle id', () => {
    expect(verifier().renewalInfo(signedRenewal()).originalTransactionId).toBe('12345');
    signatureInvalid(() => verifier().renewalInfo(signedRenewal({ environment: 'Production' })), 'environment');
    signatureInvalid(() => verifier().renewalInfo(signedRenewal({ environment: undefined })), 'environment');
  });

  it('checks a notification by the bundle id and environment of its data', () => {
    const ok = signJws(notificationPayload());
    expect(verifier().notification(ok).notificationUUID).toBe('002e14d5-51f5-4503-b5a8-c3a1af68eb20');
    signatureInvalid(() => verifier().notification(signJws(notificationPayload({}, { bundleId: 'com.other' }))), 'bundle id');
    signatureInvalid(() => verifier().notification(signJws(notificationPayload({}, { environment: 'Production' }))), 'environment');
    signatureInvalid(() => verifier().notification(signJws(notificationPayload({}, { environment: undefined }))), 'environment');
  });

  it("checks production notifications against the app's Apple id, and sandbox ones not at all", () => {
    const production = verifier({ environment: Environment.Live, appAppleId: APP_APPLE_ID });
    const data = { environment: 'Production' };
    expect(production.notification(signJws(notificationPayload({}, data))).notificationType).toBe('SUBSCRIBED');
    signatureInvalid(() => production.notification(signJws(notificationPayload({}, { ...data, appAppleId: 1 }))), 'Apple id');
    signatureInvalid(() => production.notification(signJws(notificationPayload({}, { ...data, appAppleId: undefined }))), 'Apple id');
    // Sandbox notifications omit it: whatever it holds is not compared.
    expect(verifier().notification(signJws(notificationPayload({}, { appAppleId: undefined }))).notificationType).toBe('SUBSCRIBED');
    expect(verifier().notification(signJws(notificationPayload({}, { appAppleId: 1 }))).notificationType).toBe('SUBSCRIBED');
  });

  it('reads the bundle id and environment from summary, appData, unclaimInfo and external purchase token notifications too', () => {
    const summary = appleFixture('models/signedSummaryNotification.json');
    const summaryPayload = { ...summary, summary: { ...(summary.summary as object), environment: 'Sandbox' } };
    expect(verifier().notification(signJws(summaryPayload)).subtype).toBe('SUMMARY');
    signatureInvalid(() => verifier().notification(signJws({ ...summaryPayload, summary: { ...(summaryPayload.summary as object), bundleId: 'com.other' } })), 'bundle id');

    const rescind = appleFixture('models/signedRescindConsentNotification.json');
    const rescindPayload = { ...rescind, appData: { ...(rescind.appData as object), environment: 'Sandbox' } };
    expect(verifier().notification(signJws(rescindPayload)).notificationType).toBe('RESCIND_CONSENT');

    const unclaim = { notificationType: 'UNCLAIM_SEATS', notificationUUID: '11111111-1111-4111-8111-111111111111', unclaimInfo: { bundleId: BUNDLE_ID, environment: 'Sandbox', originalTransactionId: '1', unclaimSeatIds: ['a'] } };
    expect(verifier().notification(signJws(unclaim)).notificationType).toBe('UNCLAIM_SEATS');
    signatureInvalid(() => verifier().notification(signJws({ ...unclaim, unclaimInfo: { ...unclaim.unclaimInfo, environment: 'Production' } })), 'environment');

    const token = appleFixture('models/signedExternalPurchaseTokenNotification.json');
    // The token's id has no SANDBOX prefix: it is a production token.
    expect(() => verifier().notification(signJws(token))).toThrow(/environment/);
    expect(verifier({ environment: Environment.Live, appAppleId: 55555 }).notification(signJws(token)).notificationType).toBe('EXTERNAL_PURCHASE_TOKEN');
    const sandboxToken = appleFixture('models/signedExternalPurchaseTokenSandboxNotification.json');
    expect(verifier().notification(signJws(sandboxToken)).notificationType).toBe('EXTERNAL_PURCHASE_TOKEN');
  });

  it('refuses a notification that names no app', () => {
    signatureInvalid(() => verifier().notification(signJws({ notificationType: 'TEST', notificationUUID: '11111111-1111-4111-8111-111111111111' })), 'names no app');
  });
});

describe('the verifier itself', () => {
  it('refuses root certificates that are not PEM', () => {
    expect(thrown(() => verifier({ roots: ['not a certificate'] })).code).toBe(ErrorCode.Config);
  });

  it('never carries the payload in its error', () => {
    const error = thrown(() => verifier().transaction(signedTransaction({ bundleId: 'com.secret.bundle' })));
    expect(error.message).not.toContain('com.secret.bundle');
  });

  it('is not a VerificationFailure to the caller: only SubscriptionError escapes', () => {
    const error = thrown(() => verifier().transaction('x.y.z'));
    expect(error).not.toBeInstanceOf(VerificationFailure);
    expect(error.name).toBe('SubscriptionError');
  });
});
