import { describe, expect, it } from 'vitest';
import { ErrorCode, EventType, PaymentMethod, PaymentStatus, RefundStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { PAYU_ONE_TIME_MARKER } from '../../src/providers/payu/constants.js';
import { SubscriptionEventSchema } from '../../src/schemas.js';
import { makeProvider, signPayment, type PaymentFields } from './helpers.js';

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

const MARKER = PAYU_ONE_TIME_MARKER;

/**
 * Source: https://docs.payu.in/docs/webhook-events-and-sample-payloads, "Payment Successful" (fields copied verbatim; the page
 * prints them one per line). The hash is recomputed with the test salt because the docs publish none.
 */
const PAYMENT_SUCCESSFUL: PaymentFields = {
  mihpayid: '27553369917',
  mode: 'SBQR',
  status: 'success',
  key: 'rZ1fX4',
  txnid: 'T2603041446091822117753',
  amount: '40.00',
  addedon: '2026-03-04 14:46:14',
  productinfo: 'Static QR',
  firstname: '',
  lastname: '',
  address1: '',
  address2: '',
  city: 'Gurgaon',
  state: '',
  country: '',
  zipcode: '122001',
  email: '',
  phone: '##########',
  udf1: '',
  udf2: '',
  udf3: '',
  udf4: 'SoftQR',
  udf5: 'BFL0000006601446',
  udf6: '',
  udf7: '',
  udf8: '',
  udf9: '',
  udf10: '',
  card_token: '',
  card_no: '',
  field0: 'STQ9IUFeqlafg78815827',
  field1: 'PRIYA SHANKAR PUSNAKE',
  field2: '995486',
  field3: '_mobilenum_@axl',
  field4: 'bajajpay.6879729.d2m9cckd@indus',
  field5: 'AXLd36cfcd317f243b5b3a2d62bc71caf78',
  field6: '00000038683323284|_mobilenum_|SBIN0011418',
  field7: 'APPROVED OR COMPLETED SUCCESSFULLY|00',
  field8: 'Payment from PhonePe',
  field9: 'Transaction is Successful. Bank Sent:Transaction success',
  payment_source: 'payu',
  cardToken: '',
  authenticaticationMethod: '',
  PG_TYPE: 'SBQR-PG',
  error: 'E000',
  error_Message: 'No Error',
  net_amount_debit: '40',
  discount: '0.00',
  offer_key: '',
  offer_availed: '',
  unmappedstatus: 'captured',
  bank_ref_no: '793887773815',
  bank_ref_num: '793887773815',
  bankcode: 'UPISBQR',
  surl: '',
  curl: '',
  furl: '',
  psp_name: 'CARDHOLDERXXXXXXXXNAME',
};

/** Source: same page, "Payment Failed" (card declined; payment_source `payuS2S`). */
const PAYMENT_FAILED: PaymentFields = {
  mihpayid: '27553387529',
  mode: 'CC',
  status: 'failure',
  key: '1LtbLt',
  txnid: 'adanilounge-fef018ea-dd58-4af9-bce2-9d1920a93421-1',
  amount: '2.00',
  addedon: '2026-03-04 14:47:38',
  productinfo: 'Description not provided',
  firstname: 'CARDHOLDERXXXXXXXXNAME',
  lastname: 'CARDHOLDERXXXXXXXXNAME',
  address1: '',
  address2: '',
  city: '',
  state: '',
  country: '',
  zipcode: '',
  email: 'name@mail.com',
  phone: '##########',
  udf1: 'fef018eadd584af9bce29d1920a93421',
  udf2: 'loungeone',
  udf3: 'loungeone',
  udf4: 'fef018eadd584af9bce29d1920a93421',
  udf5: '0',
  udf6: '',
  udf7: '',
  udf8: '',
  udf9: '',
  udf10: '',
  card_token: '',
  card_no: 'XXXXXXXXXXXX6509',
  field0: '',
  field1: '7726158727156987305915',
  field2: '',
  field3: '',
  field4: '',
  field5: '93',
  field6: '05',
  field7: 'AUTHNEGATIVE',
  field8: '93 | Transaction cannot be completed; violation of law | Transaction cannot be completed; violation of law',
  field9: 'Transaction declined due to card not enabled for online transactions or user / Bank Defined Restrictions',
  payment_source: 'payuS2S',
  cardToken: '',
  authenticaticationMethod: '',
  PG_TYPE: 'CC-PG',
  error: 'E325',
  error_Message: 'Bank denied transaction on the card.',
  net_amount_debit: '0',
  discount: '0.00',
  offer_key: '',
  offer_availed: '',
  unmappedstatus: 'failed',
  bank_ref_no: '7726158727156987305915',
  bank_ref_num: '7726158727156987305915',
  bankcode: 'CC',
  threeDSVersion: '2.2.0',
};

/** The sample as a payment this adapter created: the marker the adapter puts in `udf5` is the only difference. */
const asOurs = (fields: PaymentFields): PaymentFields => ({ ...fields, udf5: MARKER });

/**
 * Source: same page, "Refund Successful" (verbatim, including the padded mihpayid). The token is the sample's; the tests that need a
 * payment refund put the prefix `refundPayment` adds in front of it.
 */
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

describe('parseWebhook: payment webhooks of one-time payments', () => {
  it('a successful payment this adapter created is payment.succeeded with paymentId and payment', () => {
    const { provider } = makeProvider();
    const events = provider.parseWebhook(form(signPayment(asOurs(PAYMENT_SUCCESSFUL))));
    expect(events).toHaveLength(1);
    const [event] = events;
    expect(event).toMatchObject({
      id: '27553369917:success',
      provider: 'payu',
      type: EventType.PaymentSucceeded,
      providerEventType: 'Successful',
      occurredAt: '2026-03-04T09:16:14.000Z',
      paymentId: 'T2603041446091822117753',
    });
    expect(event?.subscriptionId).toBeUndefined();
    expect(event?.charge).toBeUndefined();
    expect(event?.payment).toMatchObject({
      id: 'T2603041446091822117753',
      reference: 'T2603041446091822117753',
      status: PaymentStatus.Succeeded,
      providerStatus: 'captured',
      amount: 4000,
      currency: 'INR',
      paidAt: '2026-03-04T09:16:14.000Z',
    });
    // PayU masks the phone and sent no name or e-mail: nothing invalid is passed on as the customer.
    expect(event?.payment?.customer).toBeUndefined();
    expect(event?.payment?.paymentMethod).toBeUndefined();
    expect(SubscriptionEventSchema.safeParse(event).success).toBe(true);
  });

  it('a failed payment is payment.failed with the failure', () => {
    const { provider } = makeProvider();
    const [event] = provider.parseWebhook(form(signPayment(asOurs(PAYMENT_FAILED))));
    expect(event).toMatchObject({
      id: '27553387529:failure',
      type: EventType.PaymentFailed,
      providerEventType: 'Failed',
      paymentId: 'adanilounge-fef018ea-dd58-4af9-bce2-9d1920a93421-1',
    });
    expect(event?.payment).toMatchObject({
      status: PaymentStatus.Failed,
      providerStatus: 'failed',
      amount: 200,
      paymentMethod: PaymentMethod.Card,
      failureCode: 'E325',
      failureReason: 'Bank denied transaction on the card.',
      customer: { name: 'CARDHOLDERXXXXXXXXNAME', email: 'name@mail.com' },
    });
  });

  it('a customer cancellation is payment.failed with a cancelled payment', () => {
    const { provider } = makeProvider();
    const [event] = provider.parseWebhook(form(signPayment(asOurs({ ...PAYMENT_FAILED, unmappedstatus: 'userCancelled' }))));
    expect(event?.type).toBe(EventType.PaymentFailed);
    expect(event?.payment?.status).toBe(PaymentStatus.Cancelled);
  });

  it('a payment that is still pending is unknown, with the payment attached', () => {
    const { provider } = makeProvider();
    const [event] = provider.parseWebhook(form(signPayment(asOurs({ ...PAYMENT_FAILED, status: 'pending', unmappedstatus: 'pending' }))));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'Pending', paymentId: PAYMENT_FAILED.txnid });
    expect(event?.payment?.status).toBe(PaymentStatus.Pending);
  });

  it('the marker is inside the hash: moving it or removing it after signing is SIGNATURE_INVALID', () => {
    const { provider } = makeProvider();
    const signed = signPayment(asOurs(PAYMENT_SUCCESSFUL));
    expect(expectFailure(() => provider.parseWebhook(form({ ...signed, udf5: 'BFL0000006601446' }))).code).toBe(ErrorCode.SignatureInvalid);
    expect(expectFailure(() => provider.parseWebhook(form({ ...signed, amount: '1.00' }))).code).toBe(ErrorCode.SignatureInvalid);
    expect(expectFailure(() => provider.parseWebhook(form({ ...signed, hash: '' }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('a payment the library did not create (no marker) stays unknown, as before', () => {
    const { provider } = makeProvider();
    const [success] = provider.parseWebhook(form(signPayment(PAYMENT_SUCCESSFUL)));
    expect(success).toMatchObject({ type: EventType.Unknown, providerEventType: 'Successful' });
    expect(success?.paymentId).toBeUndefined();
    expect(success?.payment).toBeUndefined();
    const [failure] = provider.parseWebhook(form(signPayment(PAYMENT_FAILED)));
    expect(failure).toMatchObject({ type: EventType.Unknown, providerEventType: 'Failed' });
    expect(failure?.payment).toBeUndefined();
  });

  it('a recurring debit and a consent keep their mapping, marker or not', () => {
    const { provider } = makeProvider();
    const debit = { ...PAYMENT_SUCCESSFUL, mode: 'SI', payment_source: 'sirecurring', PG_TYPE: 'SI-PG', txnid: 'chg_1', amount: '499.00' };
    const [charged] = provider.parseWebhook(form(signPayment(debit)));
    expect(charged).toMatchObject({ type: EventType.SubscriptionCharged });
    expect(charged?.charge).toMatchObject({ reference: 'chg_1', amount: 49900 });
    expect(charged?.payment).toBeUndefined();

    const [chargedWithMarker] = provider.parseWebhook(form(signPayment(asOurs(debit))));
    expect(chargedWithMarker).toMatchObject({ type: EventType.SubscriptionCharged });
    expect(chargedWithMarker?.paymentId).toBeUndefined();

    const consent = { ...PAYMENT_SUCCESSFUL, mode: 'UPI', payment_source: 'sist', PG_TYPE: 'UPI-PG', txnid: 'sub_1', amount: '1.00' };
    const [authorized] = provider.parseWebhook(form(signPayment(consent)));
    expect(authorized).toMatchObject({ type: EventType.SubscriptionAuthorized, subscriptionId: 'upi:27553369917' });
    expect(authorized?.paymentId).toBeUndefined();
  });
});

describe('parseWebhook: refund callbacks of one-time payments', () => {
  const trusted = () => makeProvider([], { key: 'IahMJL', acceptUnsignedWebhooks: true }).provider;

  it('a refund whose token carries the payment prefix is refund.succeeded with the payment id', () => {
    const [event] = trusted().parseWebhook(json({ ...REFUND_WEBHOOK, token: 'pay_rf_1' }));
    expect(event).toMatchObject({
      id: '17265314530:success',
      type: EventType.RefundSucceeded,
      providerEventType: 'refund',
      paymentId: 'PZT2506150013OR4AN02',
    });
    expect(event?.refund).toMatchObject({
      provider: 'payu',
      id: '17265314530',
      reference: 'rf_1',
      chargeId: 'PZT2506150013OR4AN02',
      paymentId: 'PZT2506150013OR4AN02',
      status: RefundStatus.Succeeded,
      providerStatus: 'success',
      amount: 7200,
    });
    expect(SubscriptionEventSchema.safeParse(event).success).toBe(true);
  });

  it('a failed refund is refund.failed', () => {
    const [event] = trusted().parseWebhook(json({ ...REFUND_WEBHOOK, token: 'pay_rf_1', status: 'failure' }));
    expect(event).toMatchObject({ type: EventType.RefundFailed, paymentId: 'PZT2506150013OR4AN02' });
    expect(event?.refund?.status).toBe(RefundStatus.Failed);
  });

  it('the rule for unsigned webhooks stands: without acceptUnsignedWebhooks it is unknown and names no payment', () => {
    const [event] = makeProvider([], { key: 'IahMJL' }).provider.parseWebhook(json({ ...REFUND_WEBHOOK, token: 'pay_rf_1' }));
    expect(event).toMatchObject({ type: EventType.Unknown, providerEventType: 'refund' });
    expect(event?.paymentId).toBeUndefined();
    expect(event?.refund).toBeUndefined();
  });

  it('a refund without the prefix (a recurring debit, or one made in the PayU dashboard) is reported as before', () => {
    const [event] = trusted().parseWebhook(json(REFUND_WEBHOOK));
    expect(event).toMatchObject({ type: EventType.RefundSucceeded });
    expect(event?.paymentId).toBeUndefined();
    expect(event?.refund).toMatchObject({ reference: 'PZT2506150013OR4AN33', chargeId: '23907365951' });
    expect(event?.refund?.paymentId).toBeUndefined();
  });

  it('the prefix without a merchantTxnId names no payment', () => {
    const { merchantTxnId: _omitted, ...rest } = REFUND_WEBHOOK;
    const [event] = trusted().parseWebhook(json({ ...rest, token: 'pay_rf_1' }));
    expect(event?.paymentId).toBeUndefined();
    expect(event?.refund?.chargeId).toBe('23907365951');
  });

  it('a callback addressed to another merchant key is refused', () => {
    expect(expectFailure(() => trusted().parseWebhook(json({ ...REFUND_WEBHOOK, token: 'pay_rf_1', key: 'someone-else' }))).code).toBe(
      ErrorCode.SignatureInvalid,
    );
  });
});
