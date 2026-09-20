import { describe, expect, it } from 'vitest';
import { ChargeKind, ChargeStatus, ErrorCode, PaymentMethod, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { SALT, expectedReverseHash, makeProvider, signPayment, type PaymentFields } from './helpers.js';

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

/**
 * Source: reference__credit-card-recurring-payment-consent-transaction, "Sample response" (merchant-hosted card consent).
 * Subset of the printed fields; `hash` is recomputed with the test salt because the docs publish none.
 */
const CARD_CONSENT: PaymentFields = {
  mihpayid: '25600342065',
  mode: 'CC',
  status: 'success',
  unmappedstatus: 'captured',
  key: 'BmTY3G',
  txnid: '1d1a28fe1281c04b1968',
  amount: '1.00',
  addedon: '2025-10-14 11:06:59',
  productinfo: 'Product Info',
  firstname: 'Payu-Admin',
  lastname: '',
  email: 'test@example.com',
  phone: '1234567890',
  udf1: '',
  udf2: '',
  udf3: '',
  udf4: '',
  udf5: '',
  field9: 'Transaction is Successful',
  payment_source: 'sist',
  PG_TYPE: 'CC-PG',
  bankcode: 'CC',
  error: 'E000',
  error_Message: 'No Error',
  cardToken: '6a3b14bce0ae8634d70be',
  card_token: '6a3b14bce0ae8634d70be',
  cardnum: 'XXXXXXXXXXXX4879',
};

/** Source: reference__upi-recurring-payment-consent-transaction, "Final response (redirect / webhook), collect sample". Note udf4. */
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
  phone: '1234567890',
  udf1: '',
  udf2: '',
  udf3: '',
  udf4: 'Executed Callback',
  udf5: '',
  payment_source: 'sist',
  PG_TYPE: 'UPI-PG',
  bankcode: 'UPI',
  error: 'E000',
  error_Message: 'No Error',
  rrn: '528788687631',
};

/** Source: reference__netbanking-recurring-payment-consent-transaction, "Sample response" (eNACH). */
const ENACH_CONSENT: PaymentFields = {
  mihpayid: '403993715525331373',
  mode: 'ENACH',
  status: 'success',
  unmappedstatus: 'captured',
  key: 'JPM7Fg',
  txnid: 'oRWSUMU4XSQBZn',
  amount: '0.00',
  addedon: '2022-02-03 19:06:55',
  productinfo: 'iPhone',
  firstname: 'Ashish',
  email: 'test@gmail.com',
  phone: '9876543210',
  udf1: '',
  udf2: '',
  udf3: '',
  udf4: '',
  udf5: '',
  field9: 'Mandate successfully scheduled at bank end: Your payment is scheduled successfully',
  payment_source: 'sist',
  PG_TYPE: 'ENACH-PG',
  bankcode: 'ICICENCC',
  error: 'E000',
  error_Message: 'No Error',
};

/**
 * Source: reference__pay-and-subscribe-consent-transaction, "Sample response": a captured payment with
 * `payment_source => payu`, i.e. the customer paid but no mandate was registered (outcome table, fact sheet 2.3).
 */
const PAID_WITHOUT_MANDATE: PaymentFields = {
  ...CARD_CONSENT,
  mihpayid: '25630643428',
  txnid: '6af8cb1dd0d57b2b4761',
  addedon: '2025-10-16 13:06:55',
  payment_source: 'payu',
  cardToken: '2be916cfaeddc64a196988',
  card_token: '2be916cfaeddc64a196988',
};

/** Constructed from the outcome table of reference__payment-consent-transaction-payu-hosted: failed / failed / failure / payu. */
const FAILED_CONSENT: PaymentFields = {
  mihpayid: '25600999999',
  mode: 'CC',
  status: 'failure',
  unmappedstatus: 'failed',
  key: 'BmTY3G',
  txnid: 'failedtxn0001',
  amount: '2.00',
  addedon: '2025-10-14 11:20:00',
  productinfo: 'Pro monthly',
  firstname: 'Ashish',
  email: 'ashish@example.com',
  udf1: '',
  udf2: '',
  udf3: '',
  udf4: '',
  udf5: '',
  payment_source: 'payu',
  PG_TYPE: 'CC-PG',
  error: 'E1901',
  error_Message: 'Authentication failed at bank',
};

describe('verifyCheckout', () => {
  it('card: success + sist + cardToken is an authorised, active mandate', async () => {
    const { provider } = makeProvider();
    const verification = await provider.verifyCheckout(signPayment(CARD_CONSENT));
    expect(verification).toMatchObject({
      provider: 'payu',
      subscriptionId: 'card:25600342065',
      reference: '1d1a28fe1281c04b1968',
      authorized: true,
      status: SubscriptionStatus.Active,
    });
    expect(verification.charge).toMatchObject({
      provider: 'payu',
      id: '25600342065',
      reference: '1d1a28fe1281c04b1968',
      subscriptionId: 'card:25600342065',
      kind: ChargeKind.Authorization,
      status: ChargeStatus.Succeeded,
      providerStatus: 'captured',
      amount: 100,
      currency: 'INR',
      // addedon is IST: 11:06:59 IST = 05:36:59Z.
      paidAt: '2025-10-14T05:36:59.000Z',
      paymentMethod: PaymentMethod.Card,
    });
  });

  it('UPI: the udf4 value takes part in the hash, and the id is upi:<mihpayid>', async () => {
    const { provider } = makeProvider();
    const signed = signPayment(UPI_CONSENT);
    expect(signed.hash).toBe(expectedReverseHash(UPI_CONSENT));
    const verification = await provider.verifyCheckout(signed);
    expect(verification).toMatchObject({ subscriptionId: 'upi:25600438037', authorized: true, status: SubscriptionStatus.Active });
    expect(verification.charge?.paymentMethod).toBe(PaymentMethod.Upi);
    // Dropping udf4 invalidates it.
    const error = await failure(() => provider.verifyCheckout({ ...signed, udf4: '' }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('eNACH: a registered mandate is pending_authorization, not authorised, until the bank confirms', async () => {
    const { provider } = makeProvider();
    const verification = await provider.verifyCheckout(signPayment(ENACH_CONSENT));
    expect(verification).toMatchObject({
      subscriptionId: 'enach:403993715525331373',
      authorized: false,
      status: SubscriptionStatus.PendingAuthorization,
    });
    expect(verification.charge).toMatchObject({ status: ChargeStatus.Succeeded, amount: 0, paymentMethod: PaymentMethod.ENach });
  });

  it('a failed consent is not authorised; its id is the consent txnid', async () => {
    const { provider } = makeProvider();
    const verification = await provider.verifyCheckout(signPayment(FAILED_CONSENT));
    expect(verification).toMatchObject({
      subscriptionId: 'failedtxn0001',
      reference: 'failedtxn0001',
      authorized: false,
      status: SubscriptionStatus.Failed,
    });
    expect(verification.charge).toMatchObject({
      status: ChargeStatus.Failed,
      providerStatus: 'failed',
      failureCode: 'E1901',
      failureReason: 'Authentication failed at bank',
    });
    expect(verification.charge?.subscriptionId).toBeUndefined();
  });

  it('a captured payment with payment_source=payu paid but registered no mandate: not authorised', async () => {
    const { provider } = makeProvider();
    const verification = await provider.verifyCheckout(signPayment(PAID_WITHOUT_MANDATE));
    expect(verification).toMatchObject({ authorized: false, status: SubscriptionStatus.Failed, subscriptionId: PAID_WITHOUT_MANDATE.txnid });
    expect(verification.charge?.status).toBe(ChargeStatus.Succeeded);
  });

  it('a card consent without a cardToken is not authorised ("must not consider this transaction eligible")', async () => {
    const { provider } = makeProvider();
    const { cardToken: _a, card_token: _b, ...withoutToken } = CARD_CONSENT;
    const verification = await provider.verifyCheckout(signPayment(withoutToken));
    expect(verification).toMatchObject({ authorized: false, status: SubscriptionStatus.Failed });
  });

  it('a UPI consent still awaiting the customer is pending_authorization', async () => {
    const { provider } = makeProvider();
    const pending = { ...UPI_CONSENT, status: 'pending', unmappedstatus: 'pending', payment_source: 'payu' };
    const verification = await provider.verifyCheckout(signPayment(pending));
    expect(verification).toMatchObject({ authorized: false, status: SubscriptionStatus.PendingAuthorization });
    expect(verification.charge?.status).toBe(ChargeStatus.Pending);
  });

  it('success + sist from a mode this adapter does not know cannot get a subscription id: UNEXPECTED_RESPONSE', async () => {
    const { provider } = makeProvider();
    const error = await failure(() => provider.verifyCheckout(signPayment({ ...UPI_CONSENT, mode: 'WALLET', PG_TYPE: 'WALLET-PG' })));
    expect(error.code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('falls back to PG_TYPE when mode is missing', async () => {
    const { provider } = makeProvider();
    const { mode: _mode, ...withoutMode } = UPI_CONSENT;
    const verification = await provider.verifyCheckout(signPayment(withoutMode));
    expect(verification.subscriptionId).toBe('upi:25600438037');
  });

  it('accepts an upper-case hash and numeric field values', async () => {
    const { provider } = makeProvider();
    const signed = signPayment(CARD_CONSENT);
    const verification = await provider.verifyCheckout({ ...signed, hash: signed.hash!.toUpperCase(), mihpayid: 25600342065 });
    expect(verification.authorized).toBe(true);
  });

  it('with additional_charges the hash is prefixed', async () => {
    const { provider } = makeProvider();
    const withFees = { ...CARD_CONSENT, additional_charges: '12.50' };
    const signed = signPayment(withFees);
    expect((await provider.verifyCheckout(signed)).authorized).toBe(true);
    // The same hash without the prefix (what a response without fees carries) is rejected.
    const error = await failure(() => provider.verifyCheckout({ ...withFees, hash: expectedReverseHash(CARD_CONSENT) }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });
});

describe('verifyCheckout: tampering', () => {
  it.each([
    ['amount', { amount: '0.01' }],
    ['status', { status: 'failure' }],
    ['txnid', { txnid: 'another-txn' }],
    ['email', { email: 'attacker@example.com' }],
    ['productinfo', { productinfo: 'Other' }],
    ['firstname', { firstname: 'Mallory' }],
    ['udf1', { udf1: 'x' }],
  ])('a changed %s is SIGNATURE_INVALID', async (_field, change) => {
    const { provider } = makeProvider();
    const error = await failure(() => provider.verifyCheckout({ ...signPayment(CARD_CONSENT), ...change }));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });

  it('fields outside the hash (mihpayid) are not covered, which is why the hash must be checked before anything is trusted', async () => {
    // Documents PayU's design: the reverse hash does not include mihpayid or payment_source.
    const { provider } = makeProvider();
    const verification = await provider.verifyCheckout({ ...signPayment(CARD_CONSENT), mihpayid: '1' });
    expect(verification.subscriptionId).toBe('card:1');
  });

  it('a missing or empty hash is SIGNATURE_INVALID', async () => {
    const { provider } = makeProvider();
    const { hash: _hash, ...unsigned } = signPayment(CARD_CONSENT);
    expect((await failure(() => provider.verifyCheckout(unsigned))).code).toBe(ErrorCode.SignatureInvalid);
    expect((await failure(() => provider.verifyCheckout({ ...unsigned, hash: '' }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('a hash made with another salt is SIGNATURE_INVALID, and the salt is not in the error', async () => {
    const { provider } = makeProvider([], { salt: 'a-different-salt' });
    const error = await failure(() => provider.verifyCheckout(signPayment(CARD_CONSENT)));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(JSON.stringify(error.toJSON())).not.toContain(SALT);
    expect(error.message).not.toContain('a-different-salt');
  });

  it('a result without status, txnid or amount is VALIDATION', async () => {
    const { provider } = makeProvider();
    for (const missing of ['status', 'txnid', 'amount']) {
      const { [missing]: _removed, ...rest } = signPayment(CARD_CONSENT);
      expect((await failure(() => provider.verifyCheckout(rest))).code).toBe(ErrorCode.Validation);
    }
  });

  it('a hash made with another merchant key is SIGNATURE_INVALID: the configured key is part of the hash', async () => {
    const { provider } = makeProvider([], { key: 'OTHERK' });
    const error = await failure(() => provider.verifyCheckout(signPayment(CARD_CONSENT)));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
  });
});
