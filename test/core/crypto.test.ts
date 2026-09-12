import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DigestEncoding, ErrorCode, HashAlgorithm, Provider } from '../../src/constants.js';
import { assertSignature, getHeader, hash, hmac, safeEqual, sha256Hmac, sha512 } from '../../src/crypto.js';
import { SubscriptionError } from '../../src/errors.js';

const BODY = '{"entity":"event","event":"subscription.charged","payload":{"amount":49900}}';
const SECRET = 'whsec_test_secret';
const UNICODE = '{"note":"₹499 — café 🙂"}';

describe('hmac / sha256Hmac', () => {
  it('matches the published HMAC-SHA256 test vector', () => {
    // https://en.wikipedia.org/wiki/HMAC#Examples
    expect(sha256Hmac('key', 'The quick brown fox jumps over the lazy dog')).toBe(
      'f7bc83f430538424b13298e6aa6fb143ef4d59a14946175997479dbc2d1a3cd8',
    );
  });

  it('matches node:crypto in hex (the default) and base64', () => {
    const expectedHex = createHmac('sha256', SECRET).update(BODY).digest('hex');
    const expectedB64 = createHmac('sha256', SECRET).update(BODY).digest('base64');
    expect(sha256Hmac(SECRET, BODY)).toBe(expectedHex);
    expect(sha256Hmac(SECRET, BODY, DigestEncoding.Hex)).toBe(expectedHex);
    expect(sha256Hmac(SECRET, BODY, DigestEncoding.Base64)).toBe(expectedB64);
    expect(hmac(HashAlgorithm.Sha256, SECRET, BODY)).toBe(expectedHex);
    expect(hmac(HashAlgorithm.Sha256, SECRET, BODY, DigestEncoding.Base64)).toBe(expectedB64);
    expect(expectedHex).toMatch(/^[0-9a-f]{64}$/);
    expect(expectedB64).toMatch(/^[A-Za-z0-9+/]{43}=$/);
  });

  it('supports sha512 HMACs', () => {
    expect(hmac(HashAlgorithm.Sha512, SECRET, BODY)).toBe(createHmac('sha512', SECRET).update(BODY).digest('hex'));
    expect(hmac(HashAlgorithm.Sha512, SECRET, BODY, DigestEncoding.Base64)).toBe(
      createHmac('sha512', SECRET).update(BODY).digest('base64'),
    );
  });

  it('hashes the payload as UTF-8 bytes', () => {
    expect(sha256Hmac(SECRET, UNICODE)).toBe(createHmac('sha256', SECRET).update(Buffer.from(UNICODE, 'utf8')).digest('hex'));
  });

  it('is sensitive to the secret and to a single changed byte', () => {
    const base = sha256Hmac(SECRET, BODY);
    expect(sha256Hmac(`${SECRET}x`, BODY)).not.toBe(base);
    expect(sha256Hmac(SECRET, `${BODY} `)).not.toBe(base);
    expect(sha256Hmac(SECRET, BODY.replace('49900', '49901'))).not.toBe(base);
  });

  it('handles empty payloads', () => {
    expect(sha256Hmac(SECRET, '')).toBe(createHmac('sha256', SECRET).update('').digest('hex'));
  });
});

describe('hash / sha512', () => {
  it('matches the published SHA-256 and SHA-512 vectors', () => {
    expect(hash(HashAlgorithm.Sha256, 'abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    expect(sha512('')).toBe(
      'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e',
    );
  });

  it('matches node:crypto in hex and base64', () => {
    expect(hash(HashAlgorithm.Sha256, BODY)).toBe(createHash('sha256').update(BODY).digest('hex'));
    expect(hash(HashAlgorithm.Sha256, BODY, DigestEncoding.Base64)).toBe(createHash('sha256').update(BODY).digest('base64'));
    expect(hash(HashAlgorithm.Sha512, BODY, DigestEncoding.Base64)).toBe(createHash('sha512').update(BODY).digest('base64'));
    expect(sha512(BODY)).toBe(createHash('sha512').update(BODY).digest('hex'));
    expect(sha512(BODY)).toMatch(/^[0-9a-f]{128}$/);
  });

  it('PayU-style pipe-joined hash string over UTF-8 content', () => {
    const payload = ['key', 'txn1', '499.00', 'Plan ₹499', 'a@b.co', 'salt'].join('|');
    expect(sha512(payload)).toBe(createHash('sha512').update(Buffer.from(payload, 'utf8')).digest('hex'));
  });
});

describe('safeEqual', () => {
  it('is true for equal strings, including empty and unicode', () => {
    expect(safeEqual('abc123', 'abc123')).toBe(true);
    expect(safeEqual('', '')).toBe(true);
    expect(safeEqual(UNICODE, UNICODE)).toBe(true);
  });

  it('is false for same-length strings that differ', () => {
    expect(safeEqual('abc123', 'abc124')).toBe(false);
    expect(safeEqual('abc123', 'Abc123')).toBe(false);
    expect(safeEqual('a'.repeat(64), `${'a'.repeat(63)}b`)).toBe(false);
  });

  it('is false (and does not throw) for different lengths', () => {
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(safeEqual('abcd', 'abc')).toBe(false);
    expect(safeEqual('', 'a')).toBe(false);
  });

  it('compares bytes, not characters: equal byte length but different content is false', () => {
    expect(safeEqual('é', 'ab')).toBe(false); // both 2 bytes in UTF-8
    expect(safeEqual('é', 'e')).toBe(false);
  });

  it('is not a prefix or case-insensitive match for hex digests', () => {
    const digest = sha256Hmac(SECRET, BODY);
    expect(safeEqual(digest, digest.toUpperCase())).toBe(false);
    expect(safeEqual(digest, digest.slice(0, 63))).toBe(false);
  });
});

describe('assertSignature', () => {
  const expected = sha256Hmac(SECRET, BODY);

  function failure(received: string | undefined): SubscriptionError {
    try {
      assertSignature(expected, received, Provider.Razorpay, 'webhook');
    } catch (error) {
      expect(error).toBeInstanceOf(SubscriptionError);
      return error as SubscriptionError;
    }
    throw new Error('expected assertSignature to throw');
  }

  it('passes for the correct signature', () => {
    expect(() => assertSignature(expected, sha256Hmac(SECRET, BODY), Provider.Razorpay, 'webhook')).not.toThrow();
  });

  it.each([
    ['a wrong signature', 'deadbeef'.repeat(8)],
    ['a signature of the wrong length', 'deadbeef'],
    ['an empty signature', ''],
    ['an undefined signature', undefined],
    ['the uppercase form of the right one', expected.toUpperCase()],
    ['the right one with whitespace', ` ${expected}`],
    ['a signature computed with another secret', sha256Hmac('other', BODY)],
  ])('throws SIGNATURE_INVALID for %s', (_label, received) => {
    const error = failure(received);
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(error.provider).toBe(Provider.Razorpay);
    expect(error.retryable).toBe(false);
  });

  it('an empty expected value never matches an empty received value', () => {
    expect(() => assertSignature('', '', Provider.PayU, 'checkout')).toThrow(SubscriptionError);
  });

  it('names the provider and what was checked, but leaks neither signature', () => {
    const received = 'deadbeef'.repeat(8);
    const error = failure(received);
    expect(error.message).toContain(Provider.Razorpay);
    expect(error.message).toContain('webhook');
    expect(error.message).not.toContain(expected);
    expect(error.message).not.toContain(received);
    expect(JSON.stringify(error)).not.toContain(expected);
    expect(error.raw).toBeUndefined();
  });
});

describe('getHeader', () => {
  it('finds a header regardless of the case on either side', () => {
    const headers = { 'X-Razorpay-Signature': 'abc' };
    expect(getHeader(headers, 'x-razorpay-signature')).toBe('abc');
    expect(getHeader(headers, 'X-RAZORPAY-SIGNATURE')).toBe('abc');
    expect(getHeader({ 'x-razorpay-signature': 'abc' }, 'X-Razorpay-Signature')).toBe('abc');
  });

  it('returns the first value of an array header', () => {
    expect(getHeader({ 'x-sig': ['first', 'second'] }, 'X-Sig')).toBe('first');
  });

  it('returns undefined for a missing header, an undefined value or an empty array', () => {
    expect(getHeader({}, 'x-sig')).toBeUndefined();
    expect(getHeader({ other: 'v' }, 'x-sig')).toBeUndefined();
    expect(getHeader({ 'x-sig': undefined }, 'x-sig')).toBeUndefined();
    expect(getHeader({ 'x-sig': [] }, 'x-sig')).toBeUndefined();
  });

  it('does not match on a partial name', () => {
    expect(getHeader({ 'x-sig-extra': 'v' }, 'x-sig')).toBeUndefined();
    expect(getHeader({ 'x-sig': 'v' }, 'x-sig-extra')).toBeUndefined();
  });

  it('keeps an empty-string value (the caller decides what empty means)', () => {
    expect(getHeader({ 'x-sig': '' }, 'x-sig')).toBe('');
  });
});
