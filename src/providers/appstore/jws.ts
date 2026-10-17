import { X509Certificate, verify } from 'node:crypto';
import { z } from 'zod';
import { HashAlgorithm } from '../../constants.js';
import { VerificationFailure, verifyChain } from './certificates.js';
import { ES256_SIGNATURE_BYTES, JWS_PART_COUNT, JWS_SIGNATURE_ENCODING, X5C_CHAIN_LENGTH } from './constants.js';
import { JwsHeaderSchema } from './schemas.js';

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;
const JWS_SEPARATOR = '.';

function decodeJson(part: string, what: string): unknown {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch (cause) {
    throw new VerificationFailure(`the signed data ${what} is not JSON`, { cause });
  }
}

function parseCertificate(entry: string): X509Certificate {
  if (!BASE64_PATTERN.test(entry)) throw new VerificationFailure('a certificate in the x5c header is not base64');
  try {
    return new X509Certificate(Buffer.from(entry, 'base64'));
  } catch (cause) {
    throw new VerificationFailure('a certificate in the x5c header cannot be parsed', { cause });
  }
}

/**
 * Verifies a JWS the App Store signed (compact serialisation) and returns its payload, untyped. It checks, in this order: the
 * three parts, the header (`alg` is ES256, `x5c` holds exactly three certificates), the certificate chain up to one of `roots`
 * (see `verifyChain`) and the ES256 signature over the header and payload exactly as received. Nothing is read from the
 * payload before the signature has verified. Throws `VerificationFailure`.
 */
export function verifySignedData(jws: string, roots: readonly X509Certificate[], now: Date): unknown {
  const parts = jws.split(JWS_SEPARATOR);
  if (parts.length !== JWS_PART_COUNT || parts.some((part) => !BASE64URL_PATTERN.test(part))) {
    throw new VerificationFailure('the signed data is not a JWS in compact serialisation');
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts as [string, string, string];

  const header = JwsHeaderSchema.safeParse(decodeJson(encodedHeader, 'header'));
  if (!header.success) throw new VerificationFailure('the JWS header is not ES256 with an x5c chain');
  const chain = header.data.x5c;
  if (chain.length !== X5C_CHAIN_LENGTH) throw new VerificationFailure('the x5c header does not hold exactly three certificates');
  const [leaf, intermediate] = chain.slice(0, 2).map(parseCertificate) as [X509Certificate, X509Certificate];
  // The third certificate is the root the chain claims; trust comes from `roots`, never from the header. It must still be a certificate.
  parseCertificate(chain[2] as string);

  const key = verifyChain(leaf, intermediate, roots, now);

  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== ES256_SIGNATURE_BYTES) throw new VerificationFailure('the JWS signature has the wrong length');
  const signedBytes = Buffer.from(`${encodedHeader}${JWS_SEPARATOR}${encodedPayload}`, 'ascii');
  // A JWS carries ES256 as the raw r and s values (IEEE P1363), not DER.
  const valid = verify(HashAlgorithm.Sha256, signedBytes, { key, dsaEncoding: JWS_SIGNATURE_ENCODING }, signature);
  if (!valid) throw new VerificationFailure('the JWS signature does not match');

  const payload = decodeJson(encodedPayload, 'payload');
  if (!z.record(z.string(), z.unknown()).safeParse(payload).success) throw new VerificationFailure('the signed payload is not a JSON object');
  return payload;
}
