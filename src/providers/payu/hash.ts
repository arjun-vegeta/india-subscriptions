import { sha512 } from '../../crypto.js';
import {
  CONSENT_HASH_PIPES_AFTER_UDF5,
  DEFAULT_CONSENT_HASH_LAYOUT,
  HASH_SEPARATOR,
  PAYMENT_HASH_PIPES_AFTER_UDF5,
  type ConsentHashLayout,
} from './constants.js';

/**
 * PayU hashes. All are lower-case hex SHA-512 over a `|`-joined string with the
 * merchant salt. Pure functions: no I/O, no clock, no randomness.
 *
 * ## VERIFIED 2026-11-17: the consent-request layout
 *
 * PayU's docs print the consent-request hash three different ways: the number
 * of `|` between `udf5` and `si_details` is 6 on most pages (and on the generic
 * hashing page and PayU's own SDK for the standard hash), 4 on the cards / UPI /
 * net-banking guide pages and 5 on the net-banking-plan page. Checked live on
 * PayU's test environment with its public test merchant: the six-pipe form lands
 * on the payment page and completes a consent; four and five pipes are refused
 * with "failed due to incorrectly calculated hash parameter" (the error page
 * prints the six-pipe formula). The default stays six pipes; `ConsentHashLayout`
 * and the config's `consentHashLayout` remain for a gateway that disagrees.
 *
 * ## VERIFIED 2026-11-17: the response hash of an SI transaction
 *
 * No doc page prints a reverse hash that contains `si_details`. This module
 * implements the layout PayU's SDK uses for every payment (`reverseHasher`).
 * PayU's real consent responses (success and failure, card) verify with it:
 * `si_details` is not part of the hash, and neither is the extra `splitInfo`
 * field the shared test merchant's responses carry.
 */

function join(parts: readonly string[]): string {
  return parts.join(HASH_SEPARATOR);
}

export interface ConsentHashInput {
  key: string;
  salt: string;
  txnid: string;
  /** Exactly as posted, e.g. "2.00". */
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  /** The exact JSON string posted as the `si_details` form field. */
  siDetails: string;
}

/**
 * `sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5|<n pipes>si_details|salt)`
 * with `n` = 6 by default. `siDetails` must be byte-identical to the posted field.
 */
export function consentRequestHash(
  input: ConsentHashInput,
  layout: ConsentHashLayout = DEFAULT_CONSENT_HASH_LAYOUT,
): string {
  const head = join([
    input.key,
    input.txnid,
    input.amount,
    input.productinfo,
    input.firstname,
    input.email,
    input.udf1 ?? '',
    input.udf2 ?? '',
    input.udf3 ?? '',
    input.udf4 ?? '',
    input.udf5 ?? '',
  ]);
  const gap = HASH_SEPARATOR.repeat(CONSENT_HASH_PIPES_AFTER_UDF5[layout]);
  return sha512(`${head}${gap}${input.siDetails}${HASH_SEPARATOR}${input.salt}`);
}

export interface PaymentRequestHashInput {
  key: string;
  salt: string;
  txnid: string;
  /** Exactly as posted, e.g. "10.00". */
  amount: string;
  productinfo: string;
  firstname: string;
  email: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}

/**
 * The request hash of a hosted checkout payment:
 * `sha512(key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT)`: five udf positions, then six pipes.
 * [docs__hashing-request-and-response]
 */
export function paymentRequestHash(input: PaymentRequestHashInput): string {
  const head = join([
    input.key,
    input.txnid,
    input.amount,
    input.productinfo,
    input.firstname,
    input.email,
    input.udf1 ?? '',
    input.udf2 ?? '',
    input.udf3 ?? '',
    input.udf4 ?? '',
    input.udf5 ?? '',
  ]);
  return sha512(`${head}${HASH_SEPARATOR.repeat(PAYMENT_HASH_PIPES_AFTER_UDF5)}${input.salt}`);
}

export interface ReverseHashInput {
  key: string;
  salt: string;
  status: string;
  email?: string;
  firstname?: string;
  productinfo?: string;
  /** Exactly as PayU sent it, e.g. "1.00". */
  amount: string;
  txnid: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
  /** Present only when PayU charged convenience fees: prefixed to the string. */
  additionalCharges?: string;
}

/**
 * The response (reverse) hash PayU puts on `surl` / `furl` and on payment
 * webhooks: `sha512(salt|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`,
 * or `sha512(additional_charges|salt|status|...)` when convenience fees apply.
 * [sdk:hasher.js reverseHasher] [docs__hashing-request-and-response]
 *
 * An empty `additionalCharges` is not a prefix: PayU omits the field when it
 * charged none (the SDK tests key presence, which a blank value also satisfies;
 * the difference only matters for a blank value PayU would not send).
 */
export function reverseResponseHash(input: ReverseHashInput): string {
  const base = join([
    input.salt,
    input.status,
    '',
    '',
    '',
    '',
    '',
    input.udf5 ?? '',
    input.udf4 ?? '',
    input.udf3 ?? '',
    input.udf2 ?? '',
    input.udf1 ?? '',
    input.email ?? '',
    input.firstname ?? '',
    input.productinfo ?? '',
    input.amount,
    input.txnid,
    input.key,
  ]);
  // `status` is followed by six pipes in total: join() supplies one, the five empty parts supply five.
  const prefixed = input.additionalCharges ? `${input.additionalCharges}${HASH_SEPARATOR}${base}` : base;
  return sha512(prefixed);
}

export interface CommandHashInput {
  key: string;
  salt: string;
  command: string;
  /** The exact string sent as `var1`. */
  var1: string;
}

/** `sha512(key|command|var1|salt)` for every postservice command. [sdk:hasher.js apiHasher] */
export function commandHash(input: CommandHashInput): string {
  return sha512(join([input.key, input.command, input.var1, input.salt]));
}

export interface CardMandateWebhookHashInput {
  salt: string;
  status: string;
  authpayuid: string;
  notificationType: string;
  billingAmount: string;
  paymentStartDate: string;
  paymentEndDate: string;
  message: string;
  eventDate: string;
  key: string;
  udf1?: string;
  udf2?: string;
  udf3?: string;
  udf4?: string;
  udf5?: string;
}

/**
 * Card mandate webhook:
 * `sha512(status|authpayuId|notificationType|billingAmount|paymentStartDate|paymentEndDate|message|eventDate|key|udf1|udf2|udf3|udf4|udf5|salt)`.
 * [reference__set-up-webhook-to-receive-cancellation-or-modification-update-from-the-issuer-bank]
 */
export function cardMandateWebhookHash(input: CardMandateWebhookHashInput): string {
  return sha512(
    join([
      input.status,
      input.authpayuid,
      input.notificationType,
      input.billingAmount,
      input.paymentStartDate,
      input.paymentEndDate,
      input.message,
      input.eventDate,
      input.key,
      input.udf1 ?? '',
      input.udf2 ?? '',
      input.udf3 ?? '',
      input.udf4 ?? '',
      input.udf5 ?? '',
      input.salt,
    ]),
  );
}

export interface UpiMandateWebhookHashInput {
  salt: string;
  status: string;
  action: string;
  authpayuid: string;
  dateTime: string;
  amount: string;
  endDate: string;
}

/**
 * UPI mandate webhook: `status|action|authpayuid|dateTime|amount|endDate|salt`.
 * The docs do not name the hash function; every sample hash is 128 hex digits,
 * which is SHA-512. UNVERIFIED.
 */
export function upiMandateWebhookHash(input: UpiMandateWebhookHashInput): string {
  return sha512(
    join([input.status, input.action, input.authpayuid, input.dateTime, input.amount, input.endDate, input.salt]),
  );
}
