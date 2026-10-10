import { describe, expect, it } from 'vitest';
import { CheckoutKind, ErrorCode, PaymentMethod, PaymentStatus, RefundStatus } from '../../src/constants.js';
import { SubscriptionError } from '../../src/errors.js';
import { PaymentSchema, PaymentVerificationSchema, RefundSchema } from '../../src/schemas.js';
import {
  PAYMENT_STATUS_BY_STATE,
  PAYU_ONE_TIME_MARKER,
  PayUTransactionState,
  REFUND_ACTION_COUNTS,
} from '../../src/providers/payu/constants.js';
import {
  KEY,
  NOW,
  SALT,
  TEST_API_URL,
  TEST_PAYMENT_URL,
  apiRoute,
  expectedCommandHash,
  expectedReverseHash,
  makeProvider,
  sha512Hex,
  signPayment,
  type PaymentFields,
} from './helpers.js';

async function failure(run: () => Promise<unknown>): Promise<SubscriptionError> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(SubscriptionError);
    return error as SubscriptionError;
  }
  throw new Error('expected an error');
}

/** Query string of a PayU sample, as the fields PayU posts. */
function fieldsOf(query: string): PaymentFields {
  return Object.fromEntries(new URLSearchParams(query));
}

const MARKER = PAYU_ONE_TIME_MARKER;

/**
 * The documented reverse hash `sha512(SALT|status||||||udf5|udf4|udf3|udf2|udf1|email|firstname|productinfo|amount|txnid|key)`
 * written as the list of its parts (https://docs.payu.in/docs/hashing-request-and-response), with `additional_charges` in front when given.
 */
function reverseHashOf(parts: {
  status: string;
  udf: [string, string, string, string, string];
  email: string;
  firstname: string;
  productinfo: string;
  amount: string;
  txnid: string;
  additionalCharges?: string;
}): string {
  const [u1, u2, u3, u4, u5] = parts.udf;
  return sha512Hex(
    [
      ...(parts.additionalCharges !== undefined ? [parts.additionalCharges] : []),
      SALT,
      parts.status,
      '',
      '',
      '',
      '',
      '',
      u5,
      u4,
      u3,
      u2,
      u1,
      parts.email,
      parts.firstname,
      parts.productinfo,
      parts.amount,
      parts.txnid,
      KEY,
    ].join('|'),
  );
}

// ---------------------------------------------------------------------------
// Fixtures: PayU documentation samples, copied verbatim. The docs print hashes made with a salt they do not publish, so
// responses are re-signed with the test salt (`signPayment`).
// ---------------------------------------------------------------------------

/**
 * Source: https://docs.payu.in/docs/prebuilt-checkout-page-integration, "Response Handling", Success Scenarios, NetBanking
 * ("Sample response unformatted").
 */
const NETBANKING_RESPONSE =
  'mihpayid=403993715537565049&mode=NB&status=success&unmappedstatus=captured&key=PRiQvJ&txnid=756609e32e92add4b5f2&amount=10.00&discount=0.00&net_amount_debit=10&addedon=2026-05-29+18%3A49%3A30&productinfo=Product+Info&firstname=Payu-Admin&lastname=&address1=&address2=&city=&state=&country=&zipcode=&email=test%40example.com&phone=1234567890&udf1=&udf2=&udf3=&udf4=&udf5=&udf6=&udf7=&udf8=&udf9=&udf10=&hash=79d14afc4a3998a627d8fb431b2ee648b16fd6e31252397109ad5f44d77f7630daaaeedf0bbd5b3e7a81342c96bc087beb43125c0619cac1e5408243fdc29a04&field1=&field2=&field3=&field4=&field5=&field6=&field7=&field8=&field9=Transaction+Completed+Successfully&payment_source=payu&PG_TYPE=NB-PG&bank_ref_num=ddb199f9-5f43-4441-8648-ce2bcb244568&bankcode=TESTPGNB&error=E000&error_Message=No+Error';

/** Same page, Success Scenarios, Credit Card. */
const CARD_RESPONSE =
  'mihpayid=403993715537573401&mode=CC&status=success&unmappedstatus=captured&key=a4vGC2&txnid=TXN_NS_1780294871_5566&amount=1500.00&discount=0.00&net_amount_debit=1500&addedon=2026-06-01%2011%3A51%3A47&productinfo=Subscription&firstname=Sunit&lastname=Kumar&address1=FIRST%20FLOOR&address2=NEW%20ASHOK%20NAGAR&city=Delhi&state=Delhi&country=INDIA&zipcode=201303&email=sunit.kumar%40mail.com&phone=9876543210&udf1=Testing%20UDF%201&udf2=Testing%20UDF2&udf3=&udf4=&udf5=Sample_Invoice_11&udf6=&udf7=&udf8=&udf9=&udf10=&hash=6ee1e1f743089ce38c79473f19af24371fe80e6249968f1bcbc6d31935afa79c0325d649fa7610a642e694475b33d65011b51b5d7d2a6a46e2b38895e4c27a28&field1=888758893639&field2=599738&field3=1500.00&field4=&field5=00&field6=02&field7=AUTHPOSITIVE&field8=AUTHORIZED&field9=Transaction%20is%20Successful&payment_source=payu&PG_TYPE=CC-PG&bank_ref_num=920539478106419300&bankcode=CC&error=E000&error_Message=No%20Error&cardCategory=domestic&cardnum=XXXXXXXXXXXX2346&cardhash=This%20field%20is%20no%20longer%20supported%20in%20postback%20params.&splitInfo=%7B%22splitStatus%22%3A%22splitNotReceived%22%2C%22splitSegments%22%3A%5B%5D%7D';

/** Same page, Success Scenarios, Wallet. */
const WALLET_RESPONSE =
  'mihpayid=403993715537573912&mode=CASH&status=success&unmappedstatus=captured&key=a4vGC2&txnid=TXN_NS_1780296990_7590&amount=15000.00&discount=0.00&net_amount_debit=15000&addedon=2026-06-01%2012%3A26%3A38&productinfo=DESKTOP&firstname=Sunit&lastname=Kumar&address1=FIRST%20FLOOR&address2=NEW%20ASHOK%20NAGAR&city=Delhi&state=Delhi&country=INDIA&zipcode=201303&email=sunit.kumar%40mail.com&phone=9876543210&udf1=Testing%20UDF%201&udf2=Testing%20UDF2&udf3=&udf4=&udf5=Sample_Invoice_11&udf6=&udf7=&udf8=&udf9=&udf10=&hash=db7052bf227001b9f02aa675b1a161e633eac2b5712f85c0d466d9b1023e739b0a57e8e61926f047c2efcb19279caf834951e3ff3c9cab99353043af1db2a71f&field1=&field2=&field3=&field4=&field5=&field6=&field7=&field8=&field9=Transaction%20Completed%20Successfully&payment_source=payu&PG_TYPE=CASH-PG&bank_ref_num=a92fe2c9-4fc8-4f73-8740-9b292fe4a634&bankcode=FREC&error=E000&error_Message=No%20Error&splitInfo=%7B%22splitStatus%22%3A%22splitNotReceived%22%2C%22splitSegments%22%3A%5B%5D%7D';

/** Same page, "Unmapped Status is Pending" (NEFT/RTGS). */
const PENDING_RESPONSE =
  'mihpayid=403993715537574750&mode=NEFTRTGS&status=pending&unmappedstatus=pending&key=a4vGC2&txnid=TXN_NS_1780300270_2797&amount=10.00&discount=0.00&net_amount_debit=0.00&addedon=2026-06-01%2013%3A21%3A24&productinfo=DESKTOP&firstname=Sunit&lastname=Kumar&address1=FIRST%20FLOOR&address2=NEW%20ASHOK%20NAGAR&city=Delhi&state=Delhi&country=INDIA&zipcode=201303&email=sunit.kumar%40mail.com&phone=9876543210&udf1=Testing%20UDF%201&udf2=Testing%20UDF2&udf3=&udf4=&udf5=Sample_Invoice_11&udf6=&udf7=&udf8=&udf9=&udf10=&hash=ed4dbb911f9bfee507362e2e053c16c07063a55302ea58cf3f026f5daeefbd52da8f316d51911c891a13a1bb648a26b24b8005a84af30904d78c13a54b4d35bf&field1=&field2=&field3=&field4=&field5=&field6=&field7=&field8=02&field9=Transaction%20is%20pending&payment_source=payu&PG_TYPE=NEFTRTGS-PG&bank_ref_num=&bankcode=EFTAXIS&error=E227&error_Message=Transaction%20is%20Pending&splitInfo=%7B%22splitStatus%22%3A%22%22%2C%22splitSegments%22%3A%5B%5D%7D';

/** Same page, "Failure Scenarios", card. */
const CARD_FAILURE_RESPONSE =
  'mihpayid=403993715537573353&mode=CC&status=failure&unmappedstatus=failed&key=a4vGC2&txnid=TXN_NS_1780294680_1316&amount=15000.00&discount=0.00&net_amount_debit=0.00&addedon=2026-06-01%2011%3A48%3A38&productinfo=DESKTOP&firstname=Sunit&lastname=Kumar&address1=FIRST%20FLOOR&address2=NEW%20ASHOK%20NAGAR&city=Delhi&state=Delhi&country=INDIA&zipcode=201303&email=sunit.kumar%40mail.com&phone=9876543210&udf1=Testing%20UDF%201&udf2=Testing%20UDF2&udf3=&udf4=&udf5=Sample_Invoice_11&udf6=&udf7=&udf8=&udf9=&udf10=&hash=9ae9baa17a0ca25fd1f860f49022606d1d9d3d9650a639a8656f843a02acc3282157e7997e03734547027789599832e9ac8366dc7c21815e0e226ce6ebe216d4&field1=677160001457370800&field2=&field3=&field4=&field5=&field6=00&field7=3DS_CHALLENGE_NEGATIVE&field8=Transaction%20failed%20in%20Authorization&field9=Transaction%20Failed%20at%20bank%20end.&payment_source=payu&PG_TYPE=CC-PG&bank_ref_num=&bankcode=CC&error=E308&error_Message=Transaction%20Failed%20at%20bank%20end.&cardCategory=domestic&cardnum=XXXXXXXXXXXX2346&cardhash=This%20field%20is%20no%20longer%20supported%20in%20postback%20params.&splitInfo=%7B%22splitStatus%22%3A%22%22%2C%22splitSegments%22%3A%5B%5D%7D';

/** Same page, "Failure Scenarios", UPI cancelled by the customer. */
const UPI_CANCELLED_RESPONSE =
  'mihpayid=403993715537573890&mode=UPI&status=failure&unmappedstatus=userCancelled&key=a4vGC2&txnid=TXN_NS_1780296905_7692&amount=15000.00&discount=0.00&net_amount_debit=0.00&addedon=2026-06-01%2012%3A25%3A18&productinfo=DESKTOP&firstname=Sunit&lastname=Kumar&address1=FIRST%20FLOOR&address2=NEW%20ASHOK%20NAGAR&city=Delhi&state=Delhi&country=INDIA&zipcode=201303&email=sunit.kumar%40mail.com&phone=9876543210&udf1=Testing%20UDF%201&udf2=Testing%20UDF2&udf3=&udf4=&udf5=Sample_Invoice_11&udf6=&udf7=&udf8=&udf9=&udf10=&hash=fd3149767139dfda1146aef578cdfef38da79bffe81db64ab8a046de3d349014eb95e9848a003616b79aa6ee61b9c46e5f47403463ae4434ede19e7b6caa71f3&field1=anything%40payu&field2=&field3=&field4=&field5=&field6=&field7=&field8=generic&field9=User%20interrupted%20by%20pressing%20back%20button&payment_source=payu&PG_TYPE=UPI-PG&bank_ref_num=&bankcode=UPI-Intent&error=E1206&error_Message=Transaction%20interrupted%20by%20pressing%20back%20button&splitInfo=%7B%22splitStatus%22%3A%22%22%2C%22splitSegments%22%3A%5B%5D%7D';

/**
 * Source: https://docs.payu.in/reference/verify_payment_api, "Offer availed on cart level" (subset of the fields; the cart details
 * are left out), a UPI payment of INR 2.00.
 */
const VERIFY_SUCCESS = {
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    '1036-f0cf85f2': {
      mihpayid: '21564143078',
      request_id: '',
      bank_ref_num: '431998369241',
      amt: '2.00',
      transaction_amount: '2.00',
      txnid: '1036-f0cf85f2',
      additional_charges: '0.00',
      productinfo: 'EXPRESS',
      firstname: 'guest',
      bankcode: 'TEZOMNI',
      udf1: 'Magento2',
      udf2: '',
      udf3: '',
      udf4: '',
      udf5: 'qs8rbc1ng2hmqtakk381en6j2p',
      field2: '114390824407',
      field9: 'SUCCESS|Completed Using Callback',
      error_code: 'E000',
      addedon: '2024-11-14 16:06:40',
      payment_source: 'express',
      card_type: null,
      error_Message: 'NO ERROR',
      net_amount_debit: 2.0,
      disc: '0.00',
      mode: 'UPI',
      PG_TYPE: 'UPI-PG',
      card_no: '',
      status: 'success',
      unmappedstatus: 'captured',
      Merchant_UTR: null,
      Settled_At: '0000-00-00 00:00:00',
      App_Name: 'GooglePay',
      card_token: null,
      field4: null,
      offerAvailed: null,
    },
  },
};

/** Source: same page, "Offer availed at Transaction level" (debit card payment that failed; subset of the fields). */
const VERIFY_FAILURE = {
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    '1725950872187': {
      mihpayid: '20911942990',
      request_id: null,
      bank_ref_num: null,
      amt: '9900.00',
      transaction_amount: '10000.00',
      txnid: '1725950872187',
      additional_charges: '0.00',
      productinfo: 'Macbook Pro',
      firstname: 'Abc',
      bankcode: 'MAST',
      udf1: 'udf1',
      udf2: 'udf2',
      udf3: 'udf3',
      udf4: 'udf4',
      udf5: 'udf5',
      field2: null,
      field9: 'You have reached credit card load limit. Please use other payment options to continue.',
      error_code: 'E4936',
      addedon: '2024-09-10 12:18:20',
      payment_source: 'payu',
      card_type: 'MAST',
      error_Message: 'Bank was unable to authenticate.',
      net_amount_debit: '0.00',
      disc: '100.00',
      mode: 'DC',
      PG_TYPE: 'DC-PG',
      status: 'failure',
      unmappedstatus: 'failed',
    },
  },
};

/** Source: same page, "Failure Responses": the transaction id is not found. */
const verifyNotFound = (txnid: string) => ({
  status: 0,
  msg: '0 out of 1 Transactions Fetched Successfully',
  transaction_details: { [txnid]: { mihpayid: 'Not Found', status: 'Not Found' } },
});

/**
 * Source: https://docs.payu.in/reference/check_action_status_api_with_payu_id, success response: the capture and the first two
 * refund entries (verbatim).
 */
const ACTION_STATUS = {
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    '403993715521937565': {
      '131278418': {
        mihpayid: '403993715521937565',
        bank_ref_num: '399900',
        request_id: '131278418',
        amt: '100.00',
        mode: 'CC',
        action: 'capture',
        token: '',
        status: 'SUCCESS',
        bank_arn: null,
        settlement_id: null,
        amount_settled: null,
        UTR_no: null,
        value_date: null,
        refund_mode: '-',
      },
      '131278422': {
        mihpayid: '403993715521937565',
        bank_ref_num: '527013524405',
        request_id: '131278422',
        amt: '10.00',
        mode: 'CC',
        action: 'refund',
        token: 'RefundToken1',
        status: 'success',
        bank_arn: null,
        settlement_id: null,
        amount_settled: null,
        UTR_no: null,
        value_date: null,
        refund_mode: 'Back to Source',
      },
      '131278430': {
        mihpayid: '403993715521937565',
        bank_ref_num: '527013524405',
        request_id: '131278430',
        amt: '10.00',
        mode: 'CC',
        action: 'refund',
        token: 'RefundToken2',
        status: 'success',
        bank_arn: null,
        settlement_id: null,
        amount_settled: null,
        UTR_no: null,
        value_date: null,
        refund_mode: 'Back to Source',
      },
    },
  },
};

/** Source: same page, "If mihpayid is not found". */
const ACTION_STATUS_NONE = {
  status: 0,
  msg: '0 out of 1 Transactions Fetched Successfully',
  transaction_details: { '21564143078': 'No action status found' },
};

/** The payment behind ACTION_STATUS: shaped like the verify_payment samples, with that page's payment id and the capture's amount. */
const VERIFY_REFUNDED_ONCE = {
  status: 1,
  msg: '1 out of 1 Transactions Fetched Successfully',
  transaction_details: {
    ORDER_1: {
      mihpayid: '403993715521937565',
      txnid: 'ORDER_1',
      amt: '100.00',
      transaction_amount: '100.00',
      net_amount_debit: '100.00',
      mode: 'CC',
      PG_TYPE: 'CC-PG',
      status: 'success',
      unmappedstatus: 'captured',
      addedon: '2026-06-01 11:51:47',
      error_code: 'E000',
      error_Message: 'No Error',
    },
  },
};

const CUSTOMER = { name: 'PayU User', email: 'test@gmail.com', phone: '9876543210' };

// ---------------------------------------------------------------------------
// createPayment
// ---------------------------------------------------------------------------

describe('createPayment', () => {
  /**
   * Source: https://docs.payu.in/docs/prebuilt-checkout-page-integration, Step 1, "Sample Request": txnid PQI6MqpYrjEefU,
   * amount 10.00, firstname "PayU User", email test@gmail.com, phone 9876543210, productinfo iPhone, surl and furl
   * https://apiplayground-response.herokuapp.com/. The hash is computed here with node:crypto over the documented formula
   * `key|txnid|amount|productinfo|firstname|email|udf1|udf2|udf3|udf4|udf5||||||SALT` (the docs mask the key and publish no salt).
   */
  it('returns the form PayU documents, hashed, with no mandate parameters and no network call for a generated id', async () => {
    const { provider, calls } = makeProvider();
    const payment = await provider.createPayment({
      reference: undefined,
      amount: 1000,
      description: 'iPhone',
      customer: CUSTOMER,
      returnUrl: 'https://apiplayground-response.herokuapp.com/',
    });
    expect(calls).toHaveLength(0);
    expect(payment.id).toBe('pay_00000000000000000001');
    expect(payment.id).toHaveLength(24);
    expect(payment.reference).toBe(payment.id);

    const hash = sha512Hex(
      `${KEY}|pay_00000000000000000001|10.00|iPhone|PayU User|test@gmail.com|||||${MARKER}||||||${SALT}`,
    );
    expect(payment.checkout).toEqual({
      kind: CheckoutKind.FormPost,
      url: TEST_PAYMENT_URL,
      fields: {
        key: KEY,
        txnid: 'pay_00000000000000000001',
        amount: '10.00',
        productinfo: 'iPhone',
        firstname: 'PayU User',
        email: 'test@gmail.com',
        phone: '9876543210',
        surl: 'https://apiplayground-response.herokuapp.com/',
        furl: 'https://apiplayground-response.herokuapp.com/',
        udf5: MARKER,
        hash,
      },
    });
    const fields = payment.checkout && 'fields' in payment.checkout ? payment.checkout.fields : {};
    for (const recurring of ['si', 'si_details', 'free_trial', 'api_version']) expect(fields).not.toHaveProperty(recurring);
    expect(JSON.stringify(payment)).not.toContain(SALT);
    expect(payment).toMatchObject({
      provider: 'payu',
      status: PaymentStatus.Created,
      providerStatus: 'payment_created',
      amount: 1000,
      currency: 'INR',
      createdAt: NOW.toISOString(),
    });
    expect(PaymentSchema.safeParse(payment).success).toBe(true);
  });

  it('the reference is the txnid: PayU is asked first, and when it holds nothing the form is returned', async () => {
    const { provider, calls, remaining } = makeProvider([apiRoute(verifyNotFound('PQI6MqpYrjEefU'))]);
    const payment = await provider.createPayment({
      reference: 'PQI6MqpYrjEefU',
      amount: 1000,
      description: 'iPhone',
      customer: CUSTOMER,
      returnUrl: 'https://apiplayground-response.herokuapp.com/',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.form).toEqual({
      key: KEY,
      command: 'verify_payment',
      var1: 'PQI6MqpYrjEefU',
      hash: expectedCommandHash('verify_payment', 'PQI6MqpYrjEefU'),
    });
    expect(remaining()).toBe(0);
    expect(payment).toMatchObject({ id: 'PQI6MqpYrjEefU', reference: 'PQI6MqpYrjEefU', status: PaymentStatus.Created });
    expect(payment.checkout).toMatchObject({
      fields: {
        txnid: 'PQI6MqpYrjEefU',
        hash: sha512Hex(`${KEY}|PQI6MqpYrjEefU|10.00|iPhone|PayU User|test@gmail.com|||||${MARKER}||||||${SALT}`),
      },
    });
  });

  it('a txnid PayU already holds is returned as it is, without a second form to post', async () => {
    const { provider, calls } = makeProvider([apiRoute(VERIFY_SUCCESS), apiRoute(ACTION_STATUS_NONE)]);
    const payment = await provider.createPayment({ reference: '1036-f0cf85f2', amount: 200, customer: CUSTOMER });
    expect(calls.map((call) => call.form?.command)).toEqual(['verify_payment', 'check_action_status']);
    expect(payment.checkout).toBeUndefined();
    expect(payment).toMatchObject({ id: '1036-f0cf85f2', status: PaymentStatus.Succeeded, amount: 200, paymentMethod: PaymentMethod.Upi });
  });

  it('a lookup that fails for another reason than "not found" stops before a form is returned', async () => {
    const { provider, calls } = makeProvider([{ method: 'POST', url: TEST_API_URL, status: 503, json: { status: 0, msg: 'down' } }]);
    const error = await failure(() => provider.createPayment({ reference: 'order_1', amount: 1000, customer: CUSTOMER, returnUrl: 'https://shop.example/r' }));
    expect(error.code).not.toBe(ErrorCode.NotFound);
    expect(calls).toHaveLength(1);
  });

  it('paymentMethods become enforce_paymethod, joined with a pipe; metadata goes into udf1 and is covered by the hash', async () => {
    const { provider } = makeProvider();
    const metadata = { order: 'A-1', plan: 'pro' };
    const payment = await provider.createPayment({
      amount: 49900,
      customer: CUSTOMER,
      paymentMethods: [PaymentMethod.Card, PaymentMethod.Upi, PaymentMethod.NetBanking, PaymentMethod.Wallet],
      metadata,
    });
    const udf1 = Buffer.from(JSON.stringify(metadata)).toString('base64url');
    expect(payment.checkout).toMatchObject({
      fields: {
        amount: '499.00',
        productinfo: 'Payment',
        udf1,
        enforce_paymethod: 'creditcard|debitcard|upi|upicc|netbanking|cashcard',
        hash: sha512Hex(
          `${KEY}|pay_00000000000000000001|499.00|Payment|PayU User|test@gmail.com|${udf1}||||${MARKER}||||||${SALT}`,
        ),
      },
    });
    expect(payment.metadata).toEqual(metadata);
  });

  it('surl and furl come from the config when there is no returnUrl', async () => {
    const { provider } = makeProvider();
    const payment = await provider.createPayment({ amount: 1000, customer: CUSTOMER });
    expect(payment.checkout).toMatchObject({
      fields: { surl: 'https://merchant.example/payu/success', furl: 'https://merchant.example/payu/failure' },
    });
  });

  it('text PayU removes is removed before it is hashed', async () => {
    const { provider } = makeProvider();
    const payment = await provider.createPayment({
      amount: 1000,
      description: 'Pro #1 (annual) & more',
      customer: { ...CUSTOMER, name: "Ashish O'Kumar" },
    });
    expect(payment.checkout).toMatchObject({ fields: { productinfo: 'Pro 1 annual more', firstname: 'Ashish OKumar' } });
  });

  describe('inputs PayU cannot honour are refused', () => {
    const base = { amount: 1000, customer: CUSTOMER };
    it.each([
      ['expiresAt', { ...base, expiresAt: '2026-12-01T00:00:00.000Z' }, ErrorCode.Unsupported],
      ['a mandate method in paymentMethods', { ...base, paymentMethods: [PaymentMethod.Card, PaymentMethod.ENach] }, ErrorCode.Validation],
      ['metadata that does not fit a udf', { ...base, metadata: { note: 'x'.repeat(250) } }, ErrorCode.Validation],
      ['a description longer than productinfo', { ...base, description: 'd'.repeat(101) }, ErrorCode.Validation],
      ['a returnUrl longer than surl allows', { ...base, returnUrl: `https://shop.example/${'p'.repeat(40)}` }, ErrorCode.Validation],
      ['a reference that cannot be a txnid', { ...base, reference: 'order/1' }, ErrorCode.Validation],
      ['a reference longer than a txnid', { ...base, reference: 'o'.repeat(26) }, ErrorCode.Validation],
      ['no customer name', { ...base, customer: { email: 'a@b.co', phone: '9876543210' } }, ErrorCode.Validation],
      ['no customer email', { ...base, customer: { name: 'A', phone: '9876543210' } }, ErrorCode.Validation],
      ['no customer phone', { ...base, customer: { name: 'A', email: 'a@b.co' } }, ErrorCode.Validation],
    ])('%s', async (_label, input, code) => {
      const { provider, calls } = makeProvider();
      const error = await failure(() => provider.createPayment({ returnUrl: 'https://shop.example/r', ...input }));
      expect(error.code).toBe(code);
      expect(calls).toHaveLength(0);
    });

    it('no returnUrl and no configured successUrl', async () => {
      const { provider } = makeProvider([], { successUrl: undefined, failureUrl: undefined });
      expect((await failure(() => provider.createPayment(base))).code).toBe(ErrorCode.Validation);
    });
  });
});

// ---------------------------------------------------------------------------
// verifyPayment
// ---------------------------------------------------------------------------

describe('verifyPayment', () => {
  it('NetBanking sample: the hash is verified and the payment is paid', async () => {
    const { provider, calls } = makeProvider();
    const verification = await provider.verifyPayment(signPayment(fieldsOf(NETBANKING_RESPONSE)));
    expect(calls).toHaveLength(0);
    expect(verification).toMatchObject({
      provider: 'payu',
      paymentId: '756609e32e92add4b5f2',
      reference: '756609e32e92add4b5f2',
      paid: true,
      status: PaymentStatus.Succeeded,
    });
    expect(verification.payment).toMatchObject({
      id: '756609e32e92add4b5f2',
      status: PaymentStatus.Succeeded,
      providerStatus: 'captured',
      amount: 1000,
      currency: 'INR',
      paymentMethod: PaymentMethod.NetBanking,
      paidAt: '2026-05-29T13:19:30.000Z',
      createdAt: '2026-05-29T13:19:30.000Z',
      customer: { name: 'Payu-Admin', email: 'test@example.com', phone: '1234567890' },
    });
    expect(PaymentVerificationSchema.safeParse(verification).success).toBe(true);
  });

  it('the hash covers the five udf fields: the card sample verifies, one changed udf does not', async () => {
    const { provider } = makeProvider();
    const signed = signPayment(fieldsOf(CARD_RESPONSE));
    // The reverse hash is written out literally in the helper and also here.
    expect(signed.hash).toBe(
      reverseHashOf({
        status: 'success',
        udf: ['Testing UDF 1', 'Testing UDF2', '', '', 'Sample_Invoice_11'],
        email: 'sunit.kumar@mail.com',
        firstname: 'Sunit',
        productinfo: 'Subscription',
        amount: '1500.00',
        txnid: 'TXN_NS_1780294871_5566',
      }),
    );
    const verification = await provider.verifyPayment(signed);
    expect(verification.payment).toMatchObject({ amount: 150000, paymentMethod: PaymentMethod.Card, id: 'TXN_NS_1780294871_5566' });
    expect((await failure(() => provider.verifyPayment({ ...signed, udf1: 'changed' }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it('a payment that carries convenience fees is hashed with additional_charges in front', async () => {
    const { provider } = makeProvider();
    const fields = { ...fieldsOf(NETBANKING_RESPONSE), additional_charges: '5.90' };
    const signed = {
      ...fields,
      hash: reverseHashOf({
        additionalCharges: '5.90',
        status: 'success',
        udf: ['', '', '', '', ''],
        email: 'test@example.com',
        firstname: 'Payu-Admin',
        productinfo: 'Product Info',
        amount: '10.00',
        txnid: '756609e32e92add4b5f2',
      }),
    };
    expect((await provider.verifyPayment(signed)).paid).toBe(true);
    expect((await failure(() => provider.verifyPayment({ ...signed, additional_charges: '0.10' }))).code).toBe(ErrorCode.SignatureInvalid);
  });

  it.each([
    ['a missing hash', (fields: PaymentFields) => ({ ...fields, hash: '' })],
    ['a hash of the wrong length', (fields: PaymentFields) => ({ ...fields, hash: fields.hash!.slice(0, 64) })],
    ['a changed amount', (fields: PaymentFields) => ({ ...fields, amount: '1.00' })],
    ['a changed txnid', (fields: PaymentFields) => ({ ...fields, txnid: 'other' })],
    ['a changed status', (fields: PaymentFields) => ({ ...fields, status: 'failure' })],
  ])('%s is SIGNATURE_INVALID', async (_label, tamper) => {
    const { provider } = makeProvider();
    const error = await failure(() => provider.verifyPayment(tamper(signPayment(fieldsOf(NETBANKING_RESPONSE)))));
    expect(error.code).toBe(ErrorCode.SignatureInvalid);
    expect(error.message).not.toContain(SALT);
  });

  it('an upper-case hash verifies: PayU compares hex, not case', async () => {
    const { provider } = makeProvider();
    const signed = signPayment(fieldsOf(WALLET_RESPONSE));
    const verification = await provider.verifyPayment({ ...signed, hash: signed.hash!.toUpperCase() });
    expect(verification.payment?.paymentMethod).toBe(PaymentMethod.Wallet);
  });

  it.each([
    ['card failure', CARD_FAILURE_RESPONSE, PaymentStatus.Failed, 'failed', 'E308', 'Transaction Failed at bank end.'],
    ['UPI cancelled by the customer', UPI_CANCELLED_RESPONSE, PaymentStatus.Cancelled, 'userCancelled', 'E1206', 'Transaction interrupted by pressing back button'],
  ])('%s is not paid and carries the failure', async (_label, query, status, providerStatus, code, reason) => {
    const { provider } = makeProvider();
    const verification = await provider.verifyPayment(signPayment(fieldsOf(query)));
    expect(verification).toMatchObject({ paid: false, status });
    expect(verification.payment).toMatchObject({ status, providerStatus, failureCode: code, failureReason: reason });
    expect(verification.payment?.paidAt).toBeUndefined();
  });

  it('the NEFT/RTGS sample is pending, not paid, and has no unified payment method', async () => {
    const { provider } = makeProvider();
    const verification = await provider.verifyPayment(signPayment(fieldsOf(PENDING_RESPONSE)));
    expect(verification).toMatchObject({ paid: false, status: PaymentStatus.Pending });
    expect(verification.payment?.paymentMethod).toBeUndefined();
  });

  it('only status success is paid: a captured state next to another status is pending', async () => {
    const { provider } = makeProvider();
    const verification = await provider.verifyPayment(signPayment({ ...fieldsOf(NETBANKING_RESPONSE), status: 'pending' }));
    expect(verification).toMatchObject({ paid: false, status: PaymentStatus.Pending });
  });

  it('metadata written by createPayment comes back from udf1', async () => {
    const { provider } = makeProvider();
    const metadata = { order: 'A-1' };
    const created = await provider.createPayment({ amount: 1000, customer: CUSTOMER, metadata });
    const udf1 = created.checkout && 'fields' in created.checkout ? created.checkout.fields.udf1 : '';
    const verification = await provider.verifyPayment(signPayment({ ...fieldsOf(NETBANKING_RESPONSE), udf1: udf1 ?? '', udf5: MARKER }));
    expect(verification.payment?.metadata).toEqual(metadata);
  });

  it('a result of a mandate belongs to verifyCheckout', async () => {
    const { provider } = makeProvider();
    const consent = signPayment({ ...fieldsOf(NETBANKING_RESPONSE), payment_source: 'sist' });
    expect((await failure(() => provider.verifyPayment(consent))).code).toBe(ErrorCode.Validation);
    const debit = signPayment({ ...fieldsOf(NETBANKING_RESPONSE), payment_source: 'sirecurring', PG_TYPE: 'SI-PG', mode: 'SI' });
    expect((await failure(() => provider.verifyPayment(debit))).code).toBe(ErrorCode.Validation);
  });

  it('the helper and the adapter agree on the reverse hash', () => {
    const fields = fieldsOf(NETBANKING_RESPONSE);
    expect(expectedReverseHash(fields)).toBe(
      reverseHashOf({
        status: 'success',
        udf: ['', '', '', '', ''],
        email: 'test@example.com',
        firstname: 'Payu-Admin',
        productinfo: 'Product Info',
        amount: '10.00',
        txnid: '756609e32e92add4b5f2',
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// getPayment
// ---------------------------------------------------------------------------

describe('getPayment', () => {
  it('reads verify_payment by txnid, then the refunds PayU holds for a succeeded payment', async () => {
    const { provider, calls } = makeProvider([apiRoute(VERIFY_SUCCESS), apiRoute(ACTION_STATUS_NONE)]);
    const payment = await provider.getPayment('1036-f0cf85f2');
    expect(calls[0]!.form).toEqual({
      key: KEY,
      command: 'verify_payment',
      var1: '1036-f0cf85f2',
      hash: expectedCommandHash('verify_payment', '1036-f0cf85f2'),
    });
    expect(calls[1]!.form).toEqual({
      key: KEY,
      command: 'check_action_status',
      var1: '21564143078',
      var2: 'payuid',
      hash: expectedCommandHash('check_action_status', '21564143078'),
    });
    expect(payment).toMatchObject({
      provider: 'payu',
      id: '1036-f0cf85f2',
      reference: '1036-f0cf85f2',
      status: PaymentStatus.Succeeded,
      providerStatus: 'captured',
      amount: 200,
      currency: 'INR',
      paymentMethod: PaymentMethod.Upi,
      createdAt: '2024-11-14T10:36:40.000Z',
      paidAt: '2024-11-14T10:36:40.000Z',
      customer: { name: 'guest' },
    });
    expect(payment.refundedAmount).toBeUndefined();
    expect(PaymentSchema.safeParse(payment).success).toBe(true);
  });

  it('refunds that PayU holds give refundedAmount and partially_refunded', async () => {
    const { provider } = makeProvider([apiRoute(VERIFY_REFUNDED_ONCE), apiRoute(ACTION_STATUS)]);
    const payment = await provider.getPayment('ORDER_1');
    expect(payment).toMatchObject({ status: PaymentStatus.PartiallyRefunded, refundedAmount: 2000, amount: 10000, providerStatus: 'captured' });
  });

  it('refunds that add up to the amount make it refunded', async () => {
    const details = ACTION_STATUS.transaction_details['403993715521937565'];
    const body = {
      ...ACTION_STATUS,
      transaction_details: { '403993715521937565': { ...details, '131278422': { ...details['131278422'], amt: '90.00' } } },
    };
    const { provider } = makeProvider([apiRoute(VERIFY_REFUNDED_ONCE), apiRoute(body)]);
    expect(await provider.getPayment('ORDER_1')).toMatchObject({ status: PaymentStatus.Refunded, refundedAmount: 10000 });
  });

  it('a failed refund is not counted', async () => {
    const details = ACTION_STATUS.transaction_details['403993715521937565'];
    const body = {
      ...ACTION_STATUS,
      transaction_details: {
        '403993715521937565': {
          '131278418': details['131278418'],
          '131278422': { ...details['131278422'], status: 'FAILURE' },
        },
      },
    };
    const { provider } = makeProvider([apiRoute(VERIFY_REFUNDED_ONCE), apiRoute(body)]);
    const payment = await provider.getPayment('ORDER_1');
    expect(payment.status).toBe(PaymentStatus.Succeeded);
    expect(payment.refundedAmount).toBeUndefined();
  });

  it('a payment that is not succeeded costs one call and carries the failure', async () => {
    const { provider, calls } = makeProvider([apiRoute(VERIFY_FAILURE)]);
    const payment = await provider.getPayment('1725950872187');
    expect(calls).toHaveLength(1);
    expect(payment).toMatchObject({
      status: PaymentStatus.Failed,
      providerStatus: 'failed',
      // transaction_amount is read first, as for debits.
      amount: 1000000,
      paymentMethod: PaymentMethod.Card,
      failureCode: 'E4936',
      failureReason: 'Bank was unable to authenticate.',
    });
    expect(payment.paidAt).toBeUndefined();
  });

  it('a txnid PayU does not know is NOT_FOUND', async () => {
    const { provider } = makeProvider([apiRoute(verifyNotFound('IhfgcZnXR4o4nB'))]);
    expect((await failure(() => provider.getPayment('IhfgcZnXR4o4nB'))).code).toBe(ErrorCode.NotFound);
  });

  it('a "|" in the id is refused: PayU reads it as a list', async () => {
    const { provider, calls } = makeProvider();
    expect((await failure(() => provider.getPayment('a|b'))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Status tables
// ---------------------------------------------------------------------------

describe('payment status table', () => {
  /** Source: https://docs.payu.in/reference/payment-state-explanations, columns "Unmapped Status" and "Status". */
  const CASES: [string, string, PaymentStatus][] = [
    ['captured', 'success', PaymentStatus.Succeeded],
    ['auth', 'success', PaymentStatus.Pending],
    ['userCancelled', 'failure', PaymentStatus.Cancelled],
    ['bounced', 'failure', PaymentStatus.Failed],
    ['dropped', 'failure', PaymentStatus.Failed],
    ['failed', 'failure', PaymentStatus.Failed],
    ['autoRefund', 'failure', PaymentStatus.Failed],
    ['initiated', 'pending', PaymentStatus.Created],
    ['in progress', 'pending', PaymentStatus.Pending],
    ['pending', 'pending', PaymentStatus.Pending],
  ];

  it.each(CASES)('unmappedstatus %s is %s at PayU and %s here', async (unmappedstatus, status, expected) => {
    const { provider } = makeProvider();
    const fields = signPayment({ ...fieldsOf(NETBANKING_RESPONSE), unmappedstatus, status });
    const verification = await provider.verifyPayment(fields);
    expect(verification.status).toBe(expected);
    expect(verification.paid).toBe(expected === PaymentStatus.Succeeded);
    expect(verification.payment?.providerStatus).toBe(unmappedstatus);
  });

  it('every state PayU documents is in the table, and nothing else', () => {
    expect(Object.keys(PAYMENT_STATUS_BY_STATE).sort()).toEqual(Object.values(PayUTransactionState).sort());
  });

  it('a state that is not in the table is pending, verbatim in providerStatus; success on its own is succeeded', async () => {
    const { provider } = makeProvider();
    const unknown = await provider.verifyPayment(signPayment({ ...fieldsOf(NETBANKING_RESPONSE), unmappedstatus: 'settled_later', status: 'unrecognised' }));
    expect(unknown).toMatchObject({ paid: false, status: PaymentStatus.Pending });
    expect(unknown.payment?.providerStatus).toBe('settled_later');

    const bare = { ...fieldsOf(NETBANKING_RESPONSE) };
    delete bare.unmappedstatus;
    expect((await provider.verifyPayment(signPayment(bare))).status).toBe(PaymentStatus.Succeeded);
  });

  it.each([
    ['CC', undefined, PaymentMethod.Card],
    ['DC', undefined, PaymentMethod.Card],
    ['UPI', undefined, PaymentMethod.Upi],
    ['NB', undefined, PaymentMethod.NetBanking],
    ['CASH', undefined, PaymentMethod.Wallet],
    [undefined, 'CC-PG', PaymentMethod.Card],
    [undefined, 'DC-PG', PaymentMethod.Card],
    [undefined, 'UPI-PG', PaymentMethod.Upi],
    [undefined, 'NB-PG', PaymentMethod.NetBanking],
    [undefined, 'CASH-PG', PaymentMethod.Wallet],
    ['EMI', undefined, undefined],
    ['BNPL', undefined, undefined],
    ['NEFTRTGS', undefined, undefined],
    [undefined, undefined, undefined],
  ])('mode %s / PG_TYPE %s is payment method %s', async (mode, pgType, expected) => {
    const { provider } = makeProvider();
    const fields = { ...fieldsOf(NETBANKING_RESPONSE) };
    delete fields.mode;
    delete fields.PG_TYPE;
    const verification = await provider.verifyPayment(
      signPayment({ ...fields, ...(mode !== undefined ? { mode } : {}), ...(pgType !== undefined ? { PG_TYPE: pgType } : {}) }),
    );
    expect(verification.payment?.paymentMethod).toBe(expected);
  });

  it('every refund state PayU lists is in the table', () => {
    expect(Object.keys(REFUND_ACTION_COUNTS).sort()).toEqual(['failure', 'in progress', 'od hit', 'queued', 'requested', 'success']);
  });
});

// ---------------------------------------------------------------------------
// refundPayment
// ---------------------------------------------------------------------------

/** Shape of https://docs.payu.in/reference/refund_transaction_api "Sample response (captured transaction)", as the refund tests use it. */
const QUEUED = { status: 1, msg: 'Refund Request Queued', request_id: '17265314530', bank_ref_num: '100142082006', mihpayid: '21564143078' };

describe('refundPayment', () => {
  it('looks the payment up by txnid, then cancel_refund_transaction with a prefixed token; the refund names the payment', async () => {
    const { provider, calls } = makeProvider([apiRoute(VERIFY_SUCCESS), apiRoute(QUEUED)]);
    const refund = await provider.refundPayment({ paymentId: '1036-f0cf85f2', refundId: 'rf_1' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.form).toMatchObject({ command: 'verify_payment', var1: '1036-f0cf85f2' });
    expect(calls[1]!.form).toEqual({
      key: KEY,
      command: 'cancel_refund_transaction',
      var1: '21564143078',
      var2: 'pay_rf_1',
      var3: '2.00',
      hash: expectedCommandHash('cancel_refund_transaction', '21564143078'),
    });
    expect(calls[1]!.body).not.toContain(SALT);
    expect(refund).toMatchObject({
      provider: 'payu',
      id: '17265314530',
      reference: 'rf_1',
      chargeId: '1036-f0cf85f2',
      paymentId: '1036-f0cf85f2',
      status: RefundStatus.Pending,
      providerStatus: 'Refund Request Queued',
      amount: 200,
      currency: 'INR',
    });
    expect(RefundSchema.safeParse(refund).success).toBe(true);
  });

  it('a partial amount is sent as var3; a reason becomes var9', async () => {
    const { provider, calls } = makeProvider([apiRoute(VERIFY_SUCCESS), apiRoute(QUEUED)]);
    const refund = await provider.refundPayment({ paymentId: '1036-f0cf85f2', refundId: 'rf_2', amount: 50, reason: 'Duplicate order #7' });
    expect(calls[1]!.form).toMatchObject({ var3: '0.50', var9: '{"refundDetails":{"remarks":"Duplicate order 7"}}' });
    expect(refund.amount).toBe(50);
  });

  it('error code 100 is a refund that succeeded', async () => {
    const { provider } = makeProvider([apiRoute(VERIFY_SUCCESS), apiRoute({ ...QUEUED, error_code: '100' })]);
    expect((await provider.refundPayment({ paymentId: '1036-f0cf85f2', refundId: 'rf_3' })).status).toBe(RefundStatus.Succeeded);
  });

  it('a payment id PayU does not know is NOT_FOUND, even when it is made of digits; nothing is refunded', async () => {
    const { provider, calls } = makeProvider([apiRoute(verifyNotFound('30141596997'))]);
    const error = await failure(() => provider.refundPayment({ paymentId: '30141596997', refundId: 'rf_4', amount: 100 }));
    expect(error.code).toBe(ErrorCode.NotFound);
    expect(calls).toHaveLength(1);
  });

  it('a refundId that does not fit PayU token limit with the prefix is refused before anything is sent', async () => {
    const { provider, calls } = makeProvider();
    expect((await failure(() => provider.refundPayment({ paymentId: 'p', refundId: 'r'.repeat(20) }))).code).toBe(ErrorCode.Validation);
    expect(calls).toHaveLength(0);
    const { provider: second } = makeProvider([apiRoute(VERIFY_SUCCESS), apiRoute(QUEUED)]);
    await expect(second.refundPayment({ paymentId: '1036-f0cf85f2', refundId: 'r'.repeat(19) })).resolves.toMatchObject({ reference: 'r'.repeat(19) });
  });

  it('PayU refusing the refund surfaces its error code', async () => {
    const { provider } = makeProvider([apiRoute(VERIFY_SUCCESS), apiRoute({ status: 0, msg: 'Refund not possible', error_code: '236' })]);
    const error = await failure(() => provider.refundPayment({ paymentId: '1036-f0cf85f2', refundId: 'rf_5' }));
    expect(error.code).toBe(ErrorCode.Unsupported);
  });
});
