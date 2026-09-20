import { describe, expect, it } from 'vitest';
import { ChargeStatus, ErrorCode, EventType, PaymentMethod, RefundStatus, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { cardMandateWebhookHash, upiMandateWebhookHash } from '../../src/providers/payu/index.js';
import { SALT, makeProvider, signPayment, sha512Hex, type PaymentFields } from './helpers.js';

function expectFailure(run: () => unknown): SubscriptionError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

const form = (fields: PaymentFields) => ({ rawBody: new URLSearchParams(fields).toString(), headers: {} });
const json = (body: unknown) => ({ rawBody: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------------------
// Payment webhooks (form-encoded, response hash)
// Source of the field set: docs__webhook-events-and-sample-payloads and reference__upi-recurring-payment-consent-transaction.
// Hashes are recomputed with the test salt (PayU publishes none).
// ---------------------------------------------------------------------------

const UPI_CONSENT: PaymentFields = {
  mihpayid: '25600438037',
  mode: 'UPI',
  status: 'success',
  unmappedstatus: 'captured',
  key: 'smsplus',
  txnid: '1',
  amount: '1.00',
  addedon: '2025-10-14 11:14:34',
  productinfo: 'Product Info',
  firstname: 'Payu-Admin',
  email: 'test@example.com',
  udf1: '',
  udf2: '',
  udf3: '',
  udf4: 'Executed Callback',
  udf5: '',
  payment_source: 'sist',
  PG_TYPE: 'UPI-PG',
  error: 'E000',
  error_Message: 'No Error',
};

/** A recurring debit as `verify_si_payment` describes one (payment_source sirecurring, mode SI, PG_TYPE SI-PG); the webhook payload of a debit is not shown anywhere in the docs. */
const RECURRING: PaymentFields = {
  mihpayid: '30141596997',
  mode: 'SI',
  status: 'success',
  unmappedstatus: 'captured',
  key: 'BmTY3G',
  txnid: 'chg_1',
  amount: '499.00',
  addedon: '2026-08-15 22:00:04',
  productinfo: 'SI',
  firstname: '',
  email: '',
  udf1: '',
  udf2: '',
  udf3: '',
  udf4: '',
  udf5: '',
  payment_source: 'sirecurring',
  PG_TYPE: 'SI-PG',
  error: 'E000',
  error_Message: 'NO ERROR',
};

describe('parseWebhook: payment webhooks', () => {
  it('a registered UPI consent is subscription.authorized with the composite id and the consent charge', () => {
    const { provider } = makeProvider();
    const [event, ...rest] = provider.parseWebhook(form(signPayment(UPI_CONSENT)));
    expect(rest).toHaveLength(0);
    expect(event).toMatchObject({
      id: '25600438037:success',
      provider: 'payu',
      type: EventType.SubscriptionAuthorized,
      providerEventType: 'Successful',
      subscriptionId: 'upi:25600438037',
      occurredAt: '2025-10-14T05:44:34.000Z',
    });
    expect(event?.subscription).toMatchObject({ id: 'upi:25600438037', reference: '1', status: SubscriptionStatus.Active, paymentMethod: PaymentMethod.Upi });
    expect(event?.charge).toMatchObject({ reference: '1', status: ChargeStatus.Succeeded, amount: 100 });
  });

  it('an eNACH consent is not an authorisation yet: unknown, with a pending subscription', () => {
    const { provider } = makeProvider();
    const enach = { ...UPI_CONSENT, mode: 'ENACH', PG_TYPE: 'ENACH-PG', mihpayid: '403993715525331373', amount: '0.00', udf4: '' };
    const [event] = provider.parseWebhook(form(signPayment(enach)));
    expect(event).toMatchObject({ type: EventType.Unknown, subscriptionId: 'enach:403993715525331373' });
    expect(event?.subscription?.status).toBe(SubscriptionStatus.PendingAuthorization);
  });

  it('a recurring debit: success is subscription.charged, failure is subscription.charge_failed, pending changes nothing', () => {
    const { provider } = makeProvider();
    const [charged] = provider.parseWebhook(form(signPayment(RECURRING)));
    expect(charged).toMatchObject({ type: EventType.SubscriptionCharged, providerEventType: 'Successful' });
    expect(charged?.charge).toMatchObject({ reference: 'chg_1', id: '30141596997', status: ChargeStatus.Succeeded, amount: 49900, kind: 'recurring' });

    const failed = { ...RECURRING, status: 'failure', unmappedstatus: 'failed', error: 'E1903', error_Message: 'Authorization failed at Bank' };
    const [chargeFailed] = provider.parseWebhook(form(signPayment(failed)));
    expect(chargeFailed).toMatchObject({ type: EventType.SubscriptionChargeFailed, providerEventType: 'Failed' });
    expect(chargeFailed?.charge).toMatchObject({ status: ChargeStatus.Failed, failureCode: 'E1903', failureReason: 'Authorization failed at Bank' });

    const pending = { ...RECURRING, status: 'pending', unmappedstatus: 'pending' };
    expect(provider.parseWebhook(form(signPayment(pending)))[0]?.type).toBe(EventType.Unknown);
  });

  it('an ordinary payment, or a consent that failed (PayU marks it like any failed payment), is unknown', () => {
    const { provider } = makeProvider();
    const ordinary = { ...UPI_CONSENT, payment_source: 'payu' };
    expect(provider.parseWebhook(form(signPayment(ordinary)))[0]?.type).toBe(EventType.Unknown);
    const failedConsent = { ...UPI_CONSENT, status: 'failure', unmappedstatus: 'failed', payment_source: 'payu' };
    expect(provider.parseWebhook(form(signPayment(failedConsent)))[0]).toMatchObject({ type: EventType.Unknown, providerEventType: 'Failed' });
  });

  it('a tampered body or a missing hash is SIGNATURE_INVALID', () => {
    const { provider } = makeProvider();
    const signed = signPayment(UPI_CONSENT);
    expect(expectFailure(() => provider.parseWebhook(form({ ...signed, amount: '999.00' }))).code).toBe(ErrorCode.SignatureInvalid);
    const { hash: _hash, ...unsigned } = signed;
    expect(expectFailure(() => provider.parseWebhook(form(unsigned))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('a malformed form is UNEXPECTED_RESPONSE', () => {
    const { provider } = makeProvider();
    expect(expectFailure(() => provider.parseWebhook({ rawBody: 'hello=world', headers: {} })).code).toBe(ErrorCode.UnexpectedResponse);
    expect(expectFailure(() => provider.parseWebhook({ rawBody: '', headers: {} })).code).toBe(ErrorCode.UnexpectedResponse);
  });
});

// ---------------------------------------------------------------------------
// Card mandate webhook (JSON, signed)
// Source: reference__set-up-webhook-to-receive-cancellation-or-modification-update-from-the-issuer-bank
// (the docs print curly quotes around "active" and a masked hash; both are normalised, the hash recomputed).
// ---------------------------------------------------------------------------

function cardBody(overrides: Record<string, unknown> = {}, hashAmount = '101'): Record<string, unknown> {
  const base = {
    status: 'active',
    authPayuId: '16538344237',
    si_details: { billingAmount: 101, paymentStartDate: '2023-01-06', paymentEndDate: '2030-01-03' },
    message: 'Mandate modified',
    eventDate: '2023-01-24',
    notificationType: 'MANDATE_MODIFICATION',
    key: 'Merchant_KEY',
    udf1: '',
    udf2: '',
    udf3: '',
    udf4: '',
    udf5: '',
    ...overrides,
  };
  const hash = cardMandateWebhookHash({
    salt: SALT,
    status: String(base.status),
    authpayuid: String(base.authPayuId),
    notificationType: String(base.notificationType),
    billingAmount: hashAmount,
    paymentStartDate: '2023-01-06',
    paymentEndDate: '2030-01-03',
    message: String(base.message),
    eventDate: String(base.eventDate),
    key: 'Merchant_KEY',
  });
  return { ...base, hash };
}

describe('parseWebhook: card mandate webhooks', () => {
  it('MANDATE_MODIFICATION is subscription.updated with the new ceiling and end date', () => {
    const { provider } = makeProvider();
    const [event] = provider.parseWebhook(json(cardBody()));
    expect(event).toMatchObject({
      id: '16538344237:MANDATE_MODIFICATION:2023-01-24',
      type: EventType.SubscriptionUpdated,
      providerEventType: 'MANDATE_MODIFICATION',
      subscriptionId: 'card:16538344237',
      occurredAt: '2023-01-23T18:30:00.000Z',
    });
    expect(event?.subscription).toMatchObject({
      id: 'card:16538344237',
      status: SubscriptionStatus.Active,
      maxAmount: 10100,
      startAt: '2023-01-05T18:30:00.000Z',
      mandateEndsAt: '2030-01-02T18:30:00.000Z',
      paymentMethod: PaymentMethod.Card,
    });
  });

  it('the billing amount may have been hashed as 101 or 101.00: both verify', () => {
    const { provider } = makeProvider();
    expect(provider.parseWebhook(json(cardBody({}, '101.00')))[0]?.type).toBe(EventType.SubscriptionUpdated);
  });

  it.each([
    ['MANDATE_DELETION', 'deleted'],
    ['MANDATE_CANCELLATION', 'deleted'],
    ['MANDATE_CANCELLATION_TOKEN_DELETION', 'deleted'],
  ])('%s is subscription.cancelled', (notificationType, status) => {
    const { provider } = makeProvider();
    const [event] = provider.parseWebhook(json(cardBody({ notificationType, status, message: 'Mandate Deleted' })));
    expect(event?.type).toBe(EventType.SubscriptionCancelled);
    expect(event?.subscription?.status).toBe(SubscriptionStatus.Cancelled);
  });

  it('an unrecognised notificationType (signed) is unknown, verbatim', () => {
    const { provider } = makeProvider();
    const [event] = provider.parseWebhook(json(cardBody({ notificationType: 'MANDATE_SOMETHING_NEW' })));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'MANDATE_SOMETHING_NEW' });
  });

  it('a changed field or a missing hash is SIGNATURE_INVALID', () => {
    const { provider } = makeProvider();
    expect(expectFailure(() => provider.parseWebhook(json({ ...cardBody(), message: 'Mandate Deleted' }))).code).toBe(ErrorCode.SignatureInvalid);
    expect(expectFailure(() => provider.parseWebhook(json({ ...cardBody(), authPayuId: '1' }))).code).toBe(ErrorCode.SignatureInvalid);
    const { hash: _hash, ...unsigned } = cardBody();
    expect(expectFailure(() => provider.parseWebhook(json(unsigned))).code).toBe(ErrorCode.SignatureInvalid);
  });
});

// ---------------------------------------------------------------------------
// UPI mandate webhook (JSON, signed). Source: same page, "UPI" samples (pause / unpause / revoke).
// ---------------------------------------------------------------------------

function upiBody(action: string, status: string, overrides: Record<string, unknown> = {}): string {
  const fields = {
    status,
    authpayuid: 19188766234,
    action,
    dateTime: '2024-02-15 16:41:16',
    amount: '10.00',
    endDate: '2025-12-01 00:00:00',
    mandateNumber: 'PTM3b0f23b1a4f1e98b25b7bdf34ad04@paytm',
    key: 'YQeVdc',
    udf1: '',
    udf2: '',
    udf3: '',
    udf5: '',
    ...overrides,
  };
  const hash = upiMandateWebhookHash({
    salt: SALT,
    status: String(fields.status),
    action: String(fields.action),
    authpayuid: String(fields.authpayuid),
    dateTime: String(fields.dateTime),
    amount: String(fields.amount),
    endDate: String(fields.endDate),
  });
  // Written by hand so that an unquoted 18-digit id stays an exact integer token.
  return JSON.stringify({ ...fields, hash }).replace(/"authpayuid":"?(\d+)"?/, '"authpayuid":$1');
}

describe('parseWebhook: UPI mandate webhooks', () => {
  it.each([
    ['MANDATE_PAUSE', 'pause', EventType.SubscriptionPaused, SubscriptionStatus.Paused],
    ['MANDATE_UNPAUSE', 'active', EventType.SubscriptionResumed, SubscriptionStatus.Active],
    ['MANDATE_REVOKE', 'revoked', EventType.SubscriptionCancelled, SubscriptionStatus.Cancelled],
  ])('%s is %s', (action, status, type, subscriptionStatus) => {
    const { provider } = makeProvider();
    const [event] = provider.parseWebhook({ rawBody: upiBody(action, status), headers: {} });
    expect(event).toMatchObject({
      id: `19188766234:${action}:2024-02-15 16:41:16`,
      type,
      providerEventType: action,
      subscriptionId: 'upi:19188766234',
      occurredAt: '2024-02-15T11:11:16.000Z',
    });
    expect(event?.subscription).toMatchObject({ status: subscriptionStatus, maxAmount: 1000, paymentMethod: PaymentMethod.Upi });
  });

  it('an 18-digit authpayuid sent as a JSON number keeps every digit', () => {
    const { provider } = makeProvider();
    const rawBody = upiBody('MANDATE_REVOKE', 'revoked').replace('"authpayuid":19188766234', '"authpayuid":403993715525331373');
    // The hash covers the id as text; recompute for the new id.
    const hash = sha512Hex(`revoked|MANDATE_REVOKE|403993715525331373|2024-02-15 16:41:16|10.00|2025-12-01 00:00:00|${SALT}`);
    const body = rawBody.replace(/"hash":"[0-9a-f]+"/, `"hash":"${hash}"`);
    const [event] = provider.parseWebhook({ rawBody: body, headers: {} });
    expect(event?.subscriptionId).toBe('upi:403993715525331373');
  });

  it('a changed amount or a missing hash is SIGNATURE_INVALID', () => {
    const { provider } = makeProvider();
    const tampered = upiBody('MANDATE_REVOKE', 'revoked').replace('"amount":"10.00"', '"amount":"1000.00"');
    expect(expectFailure(() => provider.parseWebhook({ rawBody: tampered, headers: {} })).code).toBe(ErrorCode.SignatureInvalid);
    const noHash = upiBody('MANDATE_REVOKE', 'revoked').replace(/,"hash":"[0-9a-f]+"/, '');
    expect(expectFailure(() => provider.parseWebhook({ rawBody: noHash, headers: {} })).code).toBe(ErrorCode.SignatureInvalid);
  });
});

// ---------------------------------------------------------------------------
// Unsigned webhooks
// ---------------------------------------------------------------------------

/** Source: reference__set-up-webhook-to-receive-cancellation-or-modification-update-from-the-issuer-bank, "eNACH cancellation". */
const ENACH_CANCELLATION = { statusCode: 1, notificationType: 'MANDATE_CANCELLATION', status: 'CANCEL_SUCCESS', authPayuid: '26108200310' };

/** Source: docs__webhook-events-and-sample-payloads, "Refund webhook payload" (verbatim, including the padded mihpayid). */
const REFUND_WEBHOOK = {
  additionalValue1: null,
  bank_arn: null,
  refund_mode: 'Instant Credit through UPI',
  bank_ref_num: '100142082006',
  key: 'IahMJL',
  amt: '72.00',
  remark: null,
  status: 'success',
  token: 'PZT2506150013OR4AN33',
  mihpayid: ' 23907365951 ',
  request_id: '17265314530',
  merchantTxnId: 'PZT2506150013OR4AN02',
  additionalValue2: null,
  action: 'refund',
};

describe('parseWebhook: webhooks PayU documents no signature for', () => {
  it('eNACH cancellation: unknown by default (a forged one cannot cancel a schedule), cancelled when opted in', () => {
    const request = json(ENACH_CANCELLATION);
    const byDefault = makeProvider().provider.parseWebhook(request)[0];
    expect(byDefault).toMatchObject({ type: EventType.Unknown, providerEventType: 'MANDATE_CANCELLATION', subscriptionId: 'enach:26108200310' });

    const trusted = makeProvider([], { acceptUnsignedWebhooks: true }).provider.parseWebhook(request)[0];
    expect(trusted).toMatchObject({ type: EventType.SubscriptionCancelled, subscriptionId: 'enach:26108200310' });
    expect(trusted?.subscription?.status).toBe(SubscriptionStatus.Cancelled);
  });

  it('only CANCEL_SUCCESS cancels, even when opted in', () => {
    const { provider } = makeProvider([], { acceptUnsignedWebhooks: true });
    expect(provider.parseWebhook(json({ ...ENACH_CANCELLATION, status: 'CANCEL_FAILED' }))[0]?.type).toBe(EventType.Unknown);
  });

  it('refund callback: unknown by default, refund.succeeded / refund.failed when opted in', () => {
    const request = json(REFUND_WEBHOOK);
    // The sample's merchant key is IahMJL.
    expect(makeProvider([], { key: 'IahMJL' }).provider.parseWebhook(request)[0]?.type).toBe(EventType.Unknown);

    const { provider } = makeProvider([], { key: 'IahMJL', acceptUnsignedWebhooks: true });
    const [succeeded] = provider.parseWebhook(request);
    expect(succeeded).toMatchObject({ id: '17265314530:success', type: EventType.RefundSucceeded, providerEventType: 'refund' });
    expect(succeeded?.refund).toMatchObject({
      id: '17265314530',
      reference: 'PZT2506150013OR4AN33',
      chargeId: '23907365951',
      status: RefundStatus.Succeeded,
      amount: 7200,
    });
    const [failed] = provider.parseWebhook(json({ ...REFUND_WEBHOOK, status: 'failure' }));
    expect(failed).toMatchObject({ type: EventType.RefundFailed });
    expect(failed?.refund?.status).toBe(RefundStatus.Failed);
  });

  it('a webhook addressed to another merchant key is refused even though it is unsigned', () => {
    const { provider } = makeProvider([], { acceptUnsignedWebhooks: true });
    expect(expectFailure(() => provider.parseWebhook(json({ ...REFUND_WEBHOOK, key: 'someone-else' }))).code).toBe(ErrorCode.SignatureInvalid);
    expect(expectFailure(() => provider.parseWebhook(json({ ...ENACH_CANCELLATION, key: 'someone-else' }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('reports signedWebhooks: false because these two types carry no signature', () => {
    expect(makeProvider().provider.capabilities.signedWebhooks).toBe(false);
  });
});

describe('parseWebhook: unrecognised bodies', () => {
  it.each([
    ['invalid JSON', '{not json'],
    ['a JSON object of no known kind', '{"hello":"world"}'],
    ['a JSON array', '[1,2,3]'],
  ])('%s is UNEXPECTED_RESPONSE', (_label, rawBody) => {
    const { provider } = makeProvider();
    expect(expectFailure(() => provider.parseWebhook({ rawBody, headers: {} })).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('a card-style body without a hash is not treated as the unsigned eNACH webhook', () => {
    const { provider } = makeProvider();
    const forged = { notificationType: 'MANDATE_CANCELLATION', status: 'deleted', authPayuId: '16538344237', si_details: {} };
    expect(expectFailure(() => provider.parseWebhook(json(forged))).code).toBe(ErrorCode.SignatureInvalid);
  });
});
