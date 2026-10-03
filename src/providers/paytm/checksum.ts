import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ErrorCode, Provider } from '../../constants.js';
import { safeEqual } from '../../crypto.js';
import { SubscriptionError } from '../../errors.js';
import { PAYTM_CHECKSUM_FIELD, PAYTM_MERCHANT_KEY_BYTES } from './constants.js';

/**
 * Paytm's checksum ("signature"), re-implemented with Node's `crypto` from the source of the official
 * `paytmchecksum@1.5.1` (`PaytmChecksum.js`, read, never executed) and the checksum pages of the docs.
 *
 * Generate:
 *   1. salt = 4 characters: `randomBytes(3)` in base64 (3 bytes are exactly 4 base64 characters);
 *   2. hash = `sha256(payload + "|" + salt)` as 64 lowercase hex characters, then the salt appended: 68 characters;
 *   3. checksum = AES-128-CBC (PKCS#7) of those 68 characters with the merchant key as the raw 16-byte key and the
 *      fixed IV `@@@@&&&&####$$$$`, base64: always 108 characters.
 *
 * `payload` is, for JSON APIs, the exact text of the request `body`; for key-value posts (callbacks, webhooks) the
 * values of every field except `CHECKSUMHASH`, in the order of their sorted names, joined with `|`.
 *
 * Verify: decrypt, take the last 4 characters as the salt, recompute, compare.
 *
 * Confirmed against: the source of `paytmchecksum@1.5.1` read line by line; known-answer vectors computed independently
 * with `sha256sum` and `openssl enc -aes-128-cbc` (see `test/paytm/checksum.test.ts`). NOT confirmed against Paytm's
 * servers: the docs publish no test vector and no merchant key.
 */

/** The fixed IV of the algorithm. [chk-src] */
const IV = Buffer.from('@@@@&&&&####$$$$', 'latin1');
const CIPHER = 'aes-128-cbc';
const SALT_RANDOM_BYTES = 3;
const SALT_LENGTH = 4;
/** Printable ASCII only: the salt is both hashed (UTF-8) and encrypted (latin1), which agree only for ASCII. */
const SALT_PATTERN = /^[\x20-\x7e]{4}$/;
const HASH_ENCODING = 'hex';
const TEXT_ENCODING = 'latin1';
const BODY_ENCODING = 'base64';
const JOIN = '|';

/** A random 4-character salt, as the official library draws it. */
export function generateSalt(): string {
  return randomBytes(SALT_RANDOM_BYTES).toString(BODY_ENCODING);
}

function keyBytes(merchantKey: string): Buffer {
  const key = Buffer.from(merchantKey, 'utf8');
  // Never put the key, or any part of it, in the message.
  if (key.length !== PAYTM_MERCHANT_KEY_BYTES) {
    throw new SubscriptionError(
      ErrorCode.Config,
      `Paytm merchant key must be exactly ${PAYTM_MERCHANT_KEY_BYTES} bytes long (it is the AES-128 key), got ${key.length}`,
      { provider: Provider.Paytm },
    );
  }
  return key;
}

function hashWithSalt(payload: string, salt: string): string {
  return createHash('sha256').update(`${payload}${JOIN}${salt}`, 'utf8').digest(HASH_ENCODING) + salt;
}

/**
 * The checksum of `payload`. `salt` is injectable so tests are deterministic; it must be 4 characters, as the algorithm
 * takes the last 4 characters of the decrypted text as the salt when verifying.
 */
export function generateChecksum(payload: string, merchantKey: string, salt: string = generateSalt()): string {
  if (!SALT_PATTERN.test(salt)) {
    throw new SubscriptionError(ErrorCode.Internal, `Paytm checksum salt must be ${SALT_LENGTH} printable ASCII characters`, {
      provider: Provider.Paytm,
    });
  }
  const cipher = createCipheriv(CIPHER, keyBytes(merchantKey), IV);
  return Buffer.concat([cipher.update(Buffer.from(hashWithSalt(payload, salt), TEXT_ENCODING)), cipher.final()]).toString(
    BODY_ENCODING,
  );
}

/**
 * True when `checksum` is a genuine checksum of `payload` under `merchantKey`. A checksum that cannot be decrypted at
 * all (wrong key, damaged or truncated text) is simply false. The comparison is constant-time.
 */
export function verifyChecksum(payload: string, merchantKey: string, checksum: string): boolean {
  const key = keyBytes(merchantKey);
  let plain: string;
  try {
    const decipher = createDecipheriv(CIPHER, key, IV);
    plain = Buffer.concat([decipher.update(Buffer.from(checksum, BODY_ENCODING)), decipher.final()]).toString(TEXT_ENCODING);
  } catch {
    return false;
  }
  if (plain.length <= SALT_LENGTH) return false;
  const salt = plain.slice(-SALT_LENGTH);
  return safeEqual(hashWithSalt(payload, salt), plain);
}

/** A key-value post as received: every value is text (or null, which the algorithm reads as empty). */
export type ChecksumParams = Readonly<Record<string, string | null>>;

/**
 * The string a key-value post is signed over: all fields except `CHECKSUMHASH`, sorted by name with JavaScript's default
 * (UTF-16 code unit) order, so `B` < `CURRENCY` < `MID` < `_x` < `b` and mixed-case names such as `subStatus` and `vpa`
 * sort after every upper-case name; only the values, joined with `|`; null as empty. [chk-src getStringByParams]
 */
export function paramsPayload(params: ChecksumParams): string {
  return Object.keys(params)
    .filter((name) => name !== PAYTM_CHECKSUM_FIELD)
    .sort()
    .map((name) => params[name] ?? '')
    .join(JOIN);
}

/** The checksum of a key-value post (`CHECKSUMHASH` is ignored if present). */
export function generateParamsChecksum(params: ChecksumParams, merchantKey: string, salt?: string): string {
  return generateChecksum(paramsPayload(params), merchantKey, salt);
}

/** True when `checksum` is genuine for the key-value post `params`. */
export function verifyParamsChecksum(params: ChecksumParams, merchantKey: string, checksum: string): boolean {
  return verifyChecksum(paramsPayload(params), merchantKey, checksum);
}

/** Throws `SIGNATURE_INVALID` unless `checksum` is present and genuine for `payload`. Nothing is parsed from a payload that fails. */
export function assertChecksum(payload: string, merchantKey: string, checksum: string | null | undefined, what: string): void {
  if (!checksum || !verifyChecksum(payload, merchantKey, checksum)) {
    throw new SubscriptionError(ErrorCode.SignatureInvalid, `${Provider.Paytm} ${what} signature does not match`, {
      provider: Provider.Paytm,
    });
  }
}
