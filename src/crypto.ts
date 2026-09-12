import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { DigestEncoding, ErrorCode, HashAlgorithm, type Provider } from './constants.js';
import { SubscriptionError } from './errors.js';

export function hmac(
  algorithm: HashAlgorithm,
  secret: string,
  payload: string,
  encoding: DigestEncoding = DigestEncoding.Hex,
): string {
  return createHmac(algorithm, secret).update(payload, 'utf8').digest(encoding);
}

export function hash(
  algorithm: HashAlgorithm,
  payload: string,
  encoding: DigestEncoding = DigestEncoding.Hex,
): string {
  return createHash(algorithm).update(payload, 'utf8').digest(encoding);
}

export function sha256Hmac(secret: string, payload: string, encoding: DigestEncoding = DigestEncoding.Hex): string {
  return hmac(HashAlgorithm.Sha256, secret, payload, encoding);
}

export function sha512(payload: string): string {
  return hash(HashAlgorithm.Sha512, payload, DigestEncoding.Hex);
}

/** Constant-time string comparison; false for different lengths. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/** Throws `SIGNATURE_INVALID` unless `received` matches `expected`. */
export function assertSignature(expected: string, received: string | undefined, provider: Provider, what: string): void {
  if (!received || !safeEqual(expected, received)) {
    throw new SubscriptionError(ErrorCode.SignatureInvalid, `${provider} ${what} signature does not match`, { provider });
  }
}

/** Reads a header case-insensitively from a plain header map. */
export function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}
