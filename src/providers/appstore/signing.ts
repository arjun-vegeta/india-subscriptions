import { createPrivateKey, randomUUID, sign, type KeyObject } from 'node:crypto';
import { ErrorCode, HashAlgorithm, Provider } from '../../constants.js';
import { SubscriptionError } from '../../errors.js';
import { toUnixSeconds } from '../../time.js';
import {
  API_TOKEN_ALGORITHM,
  API_TOKEN_AUDIENCE,
  API_TOKEN_LIFETIME_SECONDS,
  API_TOKEN_TYPE,
  EC_KEY_TYPE,
  ES256_CURVE,
  JWS_SIGNATURE_ENCODING,
  OFFER_SIGNATURE_ENCODING,
  OFFER_SIGNATURE_SEPARATOR,
} from './constants.js';

/** A literal "\n" two-character sequence, as a key pasted into an environment variable often has. */
const ESCAPED_NEWLINE = /\\n/g;

/**
 * Reads a `.p8` key (PKCS #8, PEM) and checks it is the P-256 key ES256 needs. The error names the setting and never carries the
 * key.
 */
export function readSigningKey(pem: string, setting: string): KeyObject {
  try {
    const key = createPrivateKey(pem.replace(ESCAPED_NEWLINE, '\n'));
    if (key.asymmetricKeyType === EC_KEY_TYPE && key.asymmetricKeyDetails?.namedCurve === ES256_CURVE) return key;
  } catch {
    // Reported below without the cause: the parser's message can quote parts of the key.
  }
  throw new SubscriptionError(
    ErrorCode.Config,
    `Invalid ${Provider.AppStore} config: ${setting} must be the text of an App Store Connect .p8 file (a PKCS #8 P-256 private key)`,
    { provider: Provider.AppStore },
  );
}

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString('base64url');
}

export interface ApiTokenInput {
  key: KeyObject;
  keyId: string;
  issuerId: string;
  bundleId: string;
  now: Date;
}

/**
 * The ES256 JWT that authorises one App Store Server API request: header `alg`, `kid`, `typ`; claims `iss`, `iat`, `exp`, `aud`,
 * `bid`. [appstoreserverapi/generating-json-web-tokens-for-api-requests]
 */
export function createApiToken(input: ApiTokenInput): string {
  const issuedAt = toUnixSeconds(input.now);
  const header = { alg: API_TOKEN_ALGORITHM, kid: input.keyId, typ: API_TOKEN_TYPE };
  const claims = {
    iss: input.issuerId,
    iat: issuedAt,
    exp: issuedAt + API_TOKEN_LIFETIME_SECONDS,
    aud: API_TOKEN_AUDIENCE,
    bid: input.bundleId,
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  // A JWT carries ES256 as the raw r and s values (IEEE P1363), not DER.
  const signature = sign(HashAlgorithm.Sha256, Buffer.from(signingInput, 'ascii'), { key: input.key, dsaEncoding: JWS_SIGNATURE_ENCODING });
  return `${signingInput}.${base64url(signature)}`;
}

export interface OfferSignatureInput {
  key: KeyObject;
  keyId: string;
  bundleId: string;
  productId: string;
  offerId: string;
  appAccountToken: string;
  now: Date;
  /** Generator of the one-time nonce (tests). */
  nonce?: () => string;
}

export interface OfferSignature {
  offerId: string;
  keyId: string;
  nonce: string;
  timestamp: number;
  signature: string;
}

/**
 * Signs a promotional offer for StoreKit. The signed text joins the bundle id, key id, product id, offer id, the app account token
 * (lower case), the nonce (lower case) and the timestamp in milliseconds with U+2063; the signature is ECDSA with SHA-256, DER,
 * Base64. [storekit/generating-a-signature-for-promotional-offers]
 */
export function signPromotionalOffer(input: OfferSignatureInput): OfferSignature {
  const nonce = (input.nonce ?? randomUUID)().toLowerCase();
  const timestamp = input.now.getTime();
  const text = [
    input.bundleId,
    input.keyId,
    input.productId,
    input.offerId,
    input.appAccountToken.toLowerCase(),
    nonce,
    String(timestamp),
  ].join(OFFER_SIGNATURE_SEPARATOR);
  // `sign` without a `dsaEncoding` answers DER, which is what Apple asks for here.
  const signature = sign(HashAlgorithm.Sha256, Buffer.from(text, 'utf8'), input.key).toString(OFFER_SIGNATURE_ENCODING);
  return { offerId: input.offerId, keyId: input.keyId, nonce, timestamp, signature };
}
