import { X509Certificate, type KeyObject } from 'node:crypto';
import {
  CERTIFICATE_CLOCK_SKEW_MS,
  EC_KEY_TYPE,
  ES256_CURVE,
  RECEIPT_SIGNING_LEAF_OID,
  WWDR_INTERMEDIATE_OID,
} from './constants.js';

/**
 * Why a piece of signed data was refused. The text is one of this module's own fixed phrases (never data from the payload), so
 * it is safe to put in an error message.
 */
export class VerificationFailure extends Error {
  constructor(reason: string, options?: { cause?: unknown }) {
    super(reason, options);
    this.name = 'VerificationFailure';
  }
}

// ---------------------------------------------------------------------------
// A small DER reader: just enough to ask a certificate which extensions it carries. `node:crypto` exposes the
// extensions it knows (basic constraints, key usage, ...) but not an arbitrary one by its OID.
// ---------------------------------------------------------------------------

const TAG_SEQUENCE = 0x30;
const TAG_OID = 0x06;
/** `[3] EXPLICIT`, the extensions of a TBSCertificate. */
const TAG_EXTENSIONS = 0xa3;
/** The high bit of a length byte says the length itself follows in the next bytes. */
const LONG_FORM_FLAG = 0x80;
const LONG_FORM_MASK = 0x7f;
const MAX_LENGTH_BYTES = 4;

interface Tlv {
  tag: number;
  valueStart: number;
  end: number;
}

function readTlv(der: Buffer, offset: number, limit: number): Tlv {
  if (offset + 2 > limit) throw new VerificationFailure('certificate is not valid DER');
  const tag = der[offset] as number;
  const first = der[offset + 1] as number;
  let length = first;
  let valueStart = offset + 2;
  if (first & LONG_FORM_FLAG) {
    const count = first & LONG_FORM_MASK;
    if (count === 0 || count > MAX_LENGTH_BYTES || valueStart + count > limit) throw new VerificationFailure('certificate is not valid DER');
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + (der[valueStart + i] as number);
    valueStart += count;
  }
  const end = valueStart + length;
  if (end > limit) throw new VerificationFailure('certificate is not valid DER');
  return { tag, valueStart, end };
}

/** The DER content bytes of an OBJECT IDENTIFIER given as dotted text. */
function oidContent(oid: string): Buffer {
  const arcs = oid.split('.').map(Number);
  const bytes: number[] = [40 * (arcs[0] as number) + (arcs[1] as number)];
  for (const arc of arcs.slice(2)) {
    const group: number[] = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) group.unshift((rest & 0x7f) | 0x80);
    bytes.push(...group);
  }
  return Buffer.from(bytes);
}

/** True when the certificate carries an extension with this OID. */
export function hasExtension(certificate: X509Certificate, oid: string): boolean {
  const der = certificate.raw;
  const wanted = oidContent(oid);
  const certificateSeq = readTlv(der, 0, der.length);
  if (certificateSeq.tag !== TAG_SEQUENCE) throw new VerificationFailure('certificate is not valid DER');
  const tbs = readTlv(der, certificateSeq.valueStart, certificateSeq.end);
  if (tbs.tag !== TAG_SEQUENCE) throw new VerificationFailure('certificate is not valid DER');
  let offset = tbs.valueStart;
  while (offset < tbs.end) {
    const field = readTlv(der, offset, tbs.end);
    if (field.tag === TAG_EXTENSIONS) {
      const list = readTlv(der, field.valueStart, field.end);
      let at = list.valueStart;
      while (at < list.end) {
        const extension = readTlv(der, at, list.end);
        const id = readTlv(der, extension.valueStart, extension.end);
        if (id.tag === TAG_OID && der.subarray(id.valueStart, id.end).equals(wanted)) return true;
        at = extension.end;
      }
      return false;
    }
    offset = field.end;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

function notYetValid(certificate: X509Certificate, now: Date): boolean {
  return Date.parse(certificate.validFrom) > now.getTime() + CERTIFICATE_CLOCK_SKEW_MS;
}

function expired(certificate: X509Certificate, now: Date): boolean {
  return Date.parse(certificate.validTo) < now.getTime() - CERTIFICATE_CLOCK_SKEW_MS;
}

/**
 * Checks the `x5c` chain of a JWS the way Apple's reference library does: the intermediate is issued by a trusted root, the
 * leaf by the intermediate, the intermediate is a certificate authority, the leaf carries Apple's receipt-signing extension and
 * the intermediate the Worldwide Developer Relations one, and every certificate (the root too) is inside its validity period
 * at `now`, give or take a minute. It returns the leaf's public key. The revocation (OCSP) lookup Apple's library offers is not
 * done: it needs a network call to Apple's responders.
 */
export function verifyChain(leaf: X509Certificate, intermediate: X509Certificate, roots: readonly X509Certificate[], now: Date): KeyObject {
  const root = roots.find((candidate) => intermediate.issuer === candidate.subject && intermediate.verify(candidate.publicKey));
  if (!root) throw new VerificationFailure('the certificate chain does not lead to the trusted root');
  if (leaf.issuer !== intermediate.subject || !leaf.verify(intermediate.publicKey)) {
    throw new VerificationFailure('the leaf certificate was not issued by the intermediate');
  }
  if (!intermediate.ca) throw new VerificationFailure('the intermediate certificate is not a certificate authority');
  if (!hasExtension(leaf, RECEIPT_SIGNING_LEAF_OID)) throw new VerificationFailure('the leaf certificate lacks the receipt-signing extension');
  if (!hasExtension(intermediate, WWDR_INTERMEDIATE_OID)) {
    throw new VerificationFailure('the intermediate certificate lacks the Worldwide Developer Relations extension');
  }
  for (const certificate of [leaf, intermediate, root]) {
    if (notYetValid(certificate, now)) throw new VerificationFailure('a certificate in the chain is not valid yet');
    if (expired(certificate, now)) throw new VerificationFailure('a certificate in the chain has expired');
  }
  const key = leaf.publicKey;
  const details = key.asymmetricKeyDetails;
  if (key.asymmetricKeyType !== EC_KEY_TYPE || details?.namedCurve !== ES256_CURVE) {
    throw new VerificationFailure('the leaf certificate key is not a P-256 key');
  }
  return key;
}
