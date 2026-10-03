import { describe, expect, it } from 'vitest';
import { ChargeKind, ChargeStatus, ErrorCode, PaymentMethod, SubscriptionStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { KEY, MID, STAGING, STAGING_GW, formText, independentSign, makeProvider, reply, sent, signForm, statusAnswer } from './helpers.js';

const STATUS_URL = `${STAGING}/subscription/checkStatus`;
const TXN_URL = `${STAGING_GW}/v3/order/status`;

async function errorOf(promise: Promise<unknown>): Promise<SubscriptionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected the call to fail');
}

/**
 * What Paytm posts to `callbackUrl` for a UPI / wallet / card authorisation: the field list of [sub-js] and [auth-sub]
 * (`SUBS_ID` is added by the authenticate-subscription page). The docs print no complete sample with a key we hold, so the
 * values are the docs' own samples and the CHECKSUMHASH is computed with the test key.
 */
const CALLBACK: Record<string, string> = {
  MID,
  TXNID: '202005081112128XXXXXX68470101509706',
  ORDERID: 'ORDER_1',
  BANKTXNID: '6877266',
  TXNAMOUNT: '1.00',
  CURRENCY: 'INR',
  STATUS: 'TXN_SUCCESS',
  RESPCODE: '01',
  RESPMSG: 'Txn Success',
  TXNDATE: '2026-11-17 10:32:00.0',
  GATEWAYNAME: 'PPBLC',
  BANKNAME: 'HDFC Bank',
  PAYMENTMODE: 'UPI',
  SUBS_ID: '130010',
};

/** The e-mandate callback of [auth-sub]: no amount, the mandate is registered with the bank afterwards. */
const EMANDATE_CALLBACK: Record<string, string> = {
  ACCEPTED_REF_NO: 'REF123',
  REJECTED_BY: '',
  ORDERID: 'ORDER_1',
  PAYMENTMODE: 'BANKMANDATE',
  MANDATE_TYPE: 'E_MANDATE',
  MERCHANT_CUST_ID: 'CUST_001',
  IS_ACCEPTED: 'true',
  MID,
  RESPMSG: 'Txn Success',
  STATUS: 'TXN_SUCCESS',
  RESPCODE: '01',
  SUBS_ID: '130010',
  TXNDATE: '2026-11-17 10:32:00.0',
};

describe('verifyCheckout: the callback Paytm posts', () => {
  it('verifies CHECKSUMHASH over all other fields, then confirms with Fetch Subscription Status: authorized only when ACTIVE', async () => {
    const { provider, calls } = makeProvider([{ url: STATUS_URL, json: statusAnswer() }]);
    const verification = await provider.verifyCheckout(signForm(CALLBACK));
    expect(calls).toHaveLength(1);
    expect(sent(calls[0] as never).body).toEqual({ mid: MID, subsId: '130010' });
    expect(verification).toMatchObject({
      provider: 'paytm',
      subscriptionId: '130010',
      reference: 'ORDER_1',
      authorized: true,
      status: SubscriptionStatus.Active,
    });
    // A trial's token debit: Paytm records no upfront amount for it ("0.00"), so it is an authorisation charge.
    expect(verification.charge).toMatchObject({
      id: 'ORDER_1',
      reference: 'ORDER_1',
      subscriptionId: '130010',
      kind: ChargeKind.Authorization,
      status: ChargeStatus.Succeeded,
      providerStatus: 'TXN_SUCCESS',
      amount: 100,
      currency: 'INR',
      paidAt: '2026-11-17T05:02:00.000Z',
      paymentMethod: PaymentMethod.Upi,
    });
    expect(verification.raw).toMatchObject({ callback: { ORDERID: 'ORDER_1' }, subscription: { subsId: '130010', status: 'ACTIVE' } });
  });

  it('a real upfront amount (recorded by Paytm as upfrontTxnAmount) makes the charge an upfront charge', async () => {
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ upfrontTxnAmount: '99.00' }) }]);
    const verification = await provider.verifyCheckout(signForm({ ...CALLBACK, TXNAMOUNT: '99.00' }));
    expect(verification.charge).toMatchObject({ kind: ChargeKind.Upfront, amount: 9900 });
  });

  it('a bank mandate that Paytm reports AUTHORISED is not yet authorised: pending_authorization, and the callback carries no charge', async () => {
    for (const status of ['AUTHORISED', 'AUTHORIZED', 'IN_AUTHORIZATION', 'CONFIRMED']) {
      const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer({ status, subsPaymentInstDetails: { paymentMode: 'BANK_MANDATE' } }) }]);
      const verification = await provider.verifyCheckout(signForm(EMANDATE_CALLBACK));
      expect(verification).toMatchObject({ subscriptionId: '130010', reference: 'ORDER_1', authorized: false, status: SubscriptionStatus.PendingAuthorization });
      expect(verification.charge).toBeUndefined();
    }
  });

  it('a callback that failed leaves the subscription at INIT: failed; one that succeeded or is pending but not yet ACTIVE waits', async () => {
    const failed = makeProvider([{ url: STATUS_URL, json: statusAnswer({ status: 'INIT' }) }]);
    const verification = await failed.provider.verifyCheckout(
      signForm({ ...CALLBACK, STATUS: 'TXN_FAILURE', RESPCODE: '227', RESPMSG: 'Your payment has been declined by your bank.' }),
    );
    expect(verification).toMatchObject({ authorized: false, status: SubscriptionStatus.Failed });
    expect(verification.charge).toMatchObject({ status: ChargeStatus.Failed, failureCode: '227', failureReason: 'Your payment has been declined by your bank.' });
    expect(verification.charge?.paidAt).toBeUndefined();
    for (const callbackStatus of ['TXN_SUCCESS', 'PENDING']) {
      const waiting = makeProvider([{ url: STATUS_URL, json: statusAnswer({ status: 'INIT' }) }]);
      expect(await waiting.provider.verifyCheckout(signForm({ ...CALLBACK, STATUS: callbackStatus }))).toMatchObject({
        authorized: false,
        status: SubscriptionStatus.PendingAuthorization,
      });
    }
  });

  it('the fetched state decides: an ACTIVE subscription is authorised whatever the browser said, and a dead one is not', async () => {
    const active = makeProvider([{ url: STATUS_URL, json: statusAnswer() }]);
    expect((await active.provider.verifyCheckout(signForm({ ...CALLBACK, STATUS: 'TXN_FAILURE' }))).authorized).toBe(true);
    const closed = makeProvider([{ url: STATUS_URL, json: statusAnswer({ status: 'CLOSED' }) }]);
    expect(await closed.provider.verifyCheckout(signForm(CALLBACK))).toMatchObject({ authorized: false, status: SubscriptionStatus.Expired });
  });

  it('without SUBS_ID, asks Transaction Status for the order and takes its subsId', async () => {
    const { SUBS_ID: _omitted, ...withoutId } = CALLBACK;
    const { provider, calls } = makeProvider([
      { url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '01', resultMsg: 'Txn Success' }, orderId: 'ORDER_1', txnAmount: '1.00', subsId: '130010' }) },
      { url: STATUS_URL, json: statusAnswer() },
    ]);
    const verification = await provider.verifyCheckout(signForm(withoutId));
    expect(sent(calls[0] as never).body).toEqual({ mid: MID, orderId: 'ORDER_1' });
    expect(verification).toMatchObject({ subscriptionId: '130010', authorized: true });
  });

  it('is UNEXPECTED_RESPONSE when neither the callback nor Transaction Status names a subscription', async () => {
    const { SUBS_ID: _omitted, ...withoutId } = CALLBACK;
    const { provider } = makeProvider([{ url: TXN_URL, json: reply({ resultInfo: { resultStatus: 'TXN_SUCCESS', resultCode: '01', resultMsg: 'ok' }, orderId: 'ORDER_1' }) }]);
    expect((await errorOf(provider.verifyCheckout(signForm(withoutId)))).code).toBe(ErrorCode.UnexpectedResponse);
  });

  it('a failing confirmation is an error: a result is never accepted on the browser\'s word alone', async () => {
    const { provider } = makeProvider([{ url: STATUS_URL, json: reply({ resultInfo: { code: '3004', message: 'Subscription Not Found', status: 'FAILURE' } }) }]);
    expect((await errorOf(provider.verifyCheckout(signForm(CALLBACK)))).code).toBe(ErrorCode.NotFound);
    const down = makeProvider([{ url: STATUS_URL, networkError: true }]);
    expect((await errorOf(down.provider.verifyCheckout(signForm(CALLBACK)))).code).toBe(ErrorCode.Network);
  });
});

describe('verifyCheckout: tampering', () => {
  const tampered: [string, Record<string, string>][] = [
    ['a changed amount', { ...signForm(CALLBACK), TXNAMOUNT: '0.01' }],
    ['a changed status', { ...signForm(CALLBACK), STATUS: 'TXN_FAILURE' }],
    ['another subscription', { ...signForm(CALLBACK), SUBS_ID: '999999' }],
    ['an added field', { ...signForm(CALLBACK), EXTRA: 'x' }],
    ['a removed field', (({ BANKNAME: _removed, ...rest }) => rest)(signForm(CALLBACK))],
    ['a missing checksum', (({ CHECKSUMHASH: _removed, ...rest }) => rest)(signForm(CALLBACK))],
    ['an empty checksum', { ...signForm(CALLBACK), CHECKSUMHASH: '' }],
    ['a checksum of other fields', { ...CALLBACK, CHECKSUMHASH: independentSign(formText({ ...CALLBACK, STATUS: 'x' }), KEY) }],
    ['a checksum under another key', signForm(CALLBACK, 'zzzzzzzzzzzzzzzz')],
    ['garbage in the checksum', { ...CALLBACK, CHECKSUMHASH: 'not-a-checksum' }],
  ];
  for (const [name, fields] of tampered) {
    it(`${name} is SIGNATURE_INVALID, with no request to Paytm`, async () => {
      const { provider, calls } = makeProvider([]);
      const error = await errorOf(provider.verifyCheckout(fields));
      expect(error.code).toBe(ErrorCode.SignatureInvalid);
      expect(error.message).not.toContain(KEY);
      expect(calls).toHaveLength(0);
    });
  }

  it('nothing is parsed from a result that fails: a bad signature wins over a missing ORDERID', async () => {
    const { provider } = makeProvider([]);
    expect((await errorOf(provider.verifyCheckout({ STATUS: 'TXN_SUCCESS', CHECKSUMHASH: 'x' }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('a genuine result without ORDERID is VALIDATION, and a field that is not text cannot have been signed', async () => {
    const { provider } = makeProvider([]);
    const { ORDERID: _omitted, ...withoutOrder } = CALLBACK;
    expect((await errorOf(provider.verifyCheckout(signForm(withoutOrder)))).code).toBe(ErrorCode.Validation);
    expect((await errorOf(provider.verifyCheckout({ ...signForm(CALLBACK), TXNAMOUNT: 1 } as never))).code).toBe(ErrorCode.Validation);
  });

  it('accepts a checksum whose "+" a form decoder turned into a space (base64 has no spaces)', async () => {
    let fields: Record<string, string> | undefined;
    for (let i = 0; i < 400 && !fields; i += 1) {
      const salt = `S${String(i).padStart(3, '0')}`;
      const candidate = signForm(CALLBACK, KEY, salt);
      if (candidate.CHECKSUMHASH?.includes('+')) fields = candidate;
    }
    expect(fields, 'a checksum containing "+" was found').toBeDefined();
    const mangled = { ...(fields as Record<string, string>), CHECKSUMHASH: (fields as Record<string, string>).CHECKSUMHASH?.replace(/\+/g, ' ') as string };
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer() }]);
    expect((await provider.verifyCheckout(mangled)).authorized).toBe(true);
  });

  it('accepts a null value as an empty field (a JSON key-value body)', async () => {
    const fields = { ...CALLBACK, BANKTXNID: null as unknown as string };
    const checksum = independentSign(formText(fields), KEY);
    const { provider } = makeProvider([{ url: STATUS_URL, json: statusAnswer() }]);
    expect((await provider.verifyCheckout({ ...fields, CHECKSUMHASH: checksum })).authorized).toBe(true);
  });
});
