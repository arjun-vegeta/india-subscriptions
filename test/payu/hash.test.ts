import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CONSENT_HASH_PIPES_AFTER_UDF5,
  ConsentHashLayout,
  DEFAULT_CONSENT_HASH_LAYOUT,
  cardMandateWebhookHash,
  commandHash,
  consentRequestHash,
  reverseResponseHash,
  upiMandateWebhookHash,
} from '../../src/providers/payu/index.js';
import { KEY, SALT, expectedCommandHash, expectedConsentHash, expectedReverseHash, sha512Hex } from './helpers.js';

/**
 * Source for the request fixture: the `si_details` and field values are the
 * verbatim curl sample of reference__payment-consent-transaction-payu-hosted.
 * The hash printed there (67de5db4...) cannot be recomputed: PayU publishes no
 * salt (fact sheet 1.5), and the same hash is pasted on ten unrelated samples.
 * Every expected value below is computed independently with node:crypto over a
 * literally written string.
 */
const SI_DETAILS =
  '{"billingAmount": "1.00","billingCurrency": "INR","billingCycle": "MONTHLY","billingInterval": 1,"paymentStartDate": "2025-10-14","paymentEndDate": "2027-12-01"}';

const CONSENT = {
  key: KEY,
  salt: SALT,
  txnid: 'my_order_49428',
  amount: '1',
  productinfo: 'my_order_49428',
  firstname: 'PayU User',
  email: 'test@gmail.com',
  siDetails: SI_DETAILS,
};

describe('consentRequestHash', () => {
  it('defaults to the six-pipe layout: the standard PayU layout extended with si_details', () => {
    expect(DEFAULT_CONSENT_HASH_LAYOUT).toBe(ConsentHashLayout.SixPipes);
    const literal = `BmTY3G|my_order_49428|1|my_order_49428|PayU User|test@gmail.com|||||` + `||||||` + `${SI_DETAILS}|${SALT}`;
    expect(consentRequestHash(CONSENT)).toBe(createHash('sha512').update(literal).digest('hex'));
    expect(consentRequestHash(CONSENT)).toBe(
      expectedConsentHash(
        { txnid: 'my_order_49428', amount: '1', productinfo: 'my_order_49428', firstname: 'PayU User', email: 'test@gmail.com', si_details: SI_DETAILS },
        6,
      ),
    );
  });

  it.each([
    [ConsentHashLayout.SixPipes, 6],
    [ConsentHashLayout.FivePipes, 5],
    [ConsentHashLayout.FourPipes, 4],
  ] as const)('layout %s puts %i pipes between udf5 and si_details', (layout, pipes) => {
    expect(CONSENT_HASH_PIPES_AFTER_UDF5[layout]).toBe(pipes);
    const expected = expectedConsentHash(
      { txnid: CONSENT.txnid, amount: CONSENT.amount, productinfo: CONSENT.productinfo, firstname: CONSENT.firstname, email: CONSENT.email, si_details: SI_DETAILS },
      pipes,
    );
    expect(consentRequestHash(CONSENT, layout)).toBe(expected);
  });

  it('gives a different hash for each layout, so a wrong layout is a hash error at PayU, never a silent pass', () => {
    const hashes = new Set(Object.values(ConsentHashLayout).map((layout) => consentRequestHash(CONSENT, layout)));
    expect(hashes.size).toBe(3);
  });

  it('includes udf1-udf5 in order', () => {
    const udf = { udf1: 'a', udf2: 'b', udf3: 'c', udf4: 'd', udf5: 'e' };
    const literal = `BmTY3G|t1|2.00|P|N|e@x.in|a|b|c|d|e||||||{"x":1}|${SALT}`;
    expect(
      consentRequestHash({ ...CONSENT, txnid: 't1', amount: '2.00', productinfo: 'P', firstname: 'N', email: 'e@x.in', siDetails: '{"x":1}', ...udf }),
    ).toBe(sha512Hex(literal));
  });

  it('hashes si_details byte for byte: whitespace changes the hash', () => {
    const compact = JSON.stringify(JSON.parse(SI_DETAILS));
    expect(compact).not.toBe(SI_DETAILS);
    expect(consentRequestHash({ ...CONSENT, siDetails: compact })).not.toBe(consentRequestHash(CONSENT));
  });

  it('is lower-case hex of 128 digits', () => {
    expect(consentRequestHash(CONSENT)).toMatch(/^[0-9a-f]{128}$/);
  });
});

/**
 * Source: reference__upi-recurring-payment-consent-transaction ("Final response (redirect / webhook), collect
 * sample"): status success, udf4 "Executed Callback", the other udfs empty.
 * The doc hash (175508d5...) cannot be recomputed without PayU's salt.
 */
const UPI_RESPONSE = {
  status: 'success',
  udf4: 'Executed Callback',
  email: 'test@example.com',
  firstname: 'Payu-Admin',
  productinfo: 'Product Info',
  amount: '1.00',
  txnid: '1',
};

describe('reverseResponseHash', () => {
  it('is the SDK reverseHasher layout: salt|status||||||udf5..udf1|email|firstname|productinfo|amount|txnid|key', () => {
    const literal = `${SALT}|success||||||` + `|Executed Callback||||test@example.com|Payu-Admin|Product Info|1.00|1|${KEY}`;
    expect(reverseResponseHash({ key: KEY, salt: SALT, ...UPI_RESPONSE })).toBe(sha512Hex(literal));
    expect(reverseResponseHash({ key: KEY, salt: SALT, ...UPI_RESPONSE })).toBe(
      expectedReverseHash({ ...UPI_RESPONSE, udf1: '', udf2: '', udf3: '', udf5: '' }),
    );
  });

  it('prefixes additional_charges when PayU charged convenience fees', () => {
    const literal = `12.50|${SALT}|success|||||||Executed Callback||||test@example.com|Payu-Admin|Product Info|1.00|1|${KEY}`;
    expect(reverseResponseHash({ key: KEY, salt: SALT, ...UPI_RESPONSE, additionalCharges: '12.50' })).toBe(
      sha512Hex(literal),
    );
  });

  it('treats a blank additional_charges as absent', () => {
    expect(reverseResponseHash({ key: KEY, salt: SALT, ...UPI_RESPONSE, additionalCharges: '' })).toBe(
      reverseResponseHash({ key: KEY, salt: SALT, ...UPI_RESPONSE }),
    );
  });

  it('changes when any covered field changes', () => {
    const base = reverseResponseHash({ key: KEY, salt: SALT, ...UPI_RESPONSE });
    for (const change of [
      { status: 'failure' },
      { amount: '2.00' },
      { txnid: '2' },
      { email: 'x@example.com' },
      { udf4: '' },
      { productinfo: 'Other' },
    ]) {
      expect(reverseResponseHash({ key: KEY, salt: SALT, ...UPI_RESPONSE, ...change })).not.toBe(base);
    }
  });
});

describe('commandHash', () => {
  /** Source: reference__recurring_payment_api, sample request var1 (verbatim). */
  const VAR1 =
    '{"authpayuid":"6611192557","invoiceDisplayNumber":"12345678910","amount":"3.00","txnid":"REC15113506209","phone":"9999999999","email":"chota.bheem@gmail.com","udf2":"","udf3":"","udf4":"","udf5":""}';

  it('is sha512(key|command|var1|salt)', () => {
    expect(commandHash({ key: KEY, salt: SALT, command: 'si_transaction', var1: VAR1 })).toBe(
      sha512Hex(`BmTY3G|si_transaction|${VAR1}|${SALT}`),
    );
    expect(commandHash({ key: KEY, salt: SALT, command: 'si_transaction', var1: VAR1 })).toBe(
      expectedCommandHash('si_transaction', VAR1),
    );
  });

  it('hashes var1 byte for byte', () => {
    const spaced = VAR1.replace(',', ', ');
    expect(commandHash({ key: KEY, salt: SALT, command: 'si_transaction', var1: spaced })).not.toBe(
      commandHash({ key: KEY, salt: SALT, command: 'si_transaction', var1: VAR1 }),
    );
  });
});

describe('webhook hashes', () => {
  /**
   * Source: reference__set-up-webhook-to-receive-cancellation-or-modification-update-from-the-issuer-bank
   * (card mandate modified sample). The sample hash is masked (XXXX) in the docs.
   */
  it('card mandate: status|authpayuId|notificationType|billingAmount|paymentStartDate|paymentEndDate|message|eventDate|key|udf1..udf5|salt', () => {
    const literal = `active|16538344237|MANDATE_MODIFICATION|101|2023-01-06|2030-01-03|Mandate modified|2023-01-24|Merchant_KEY||||||${SALT}`;
    expect(
      cardMandateWebhookHash({
        salt: SALT,
        status: 'active',
        authpayuid: '16538344237',
        notificationType: 'MANDATE_MODIFICATION',
        billingAmount: '101',
        paymentStartDate: '2023-01-06',
        paymentEndDate: '2030-01-03',
        message: 'Mandate modified',
        eventDate: '2023-01-24',
        key: 'Merchant_KEY',
      }),
    ).toBe(sha512Hex(literal));
  });

  /**
   * Source: same page, UPI pause sample. The sample hash is 128 hex digits (SHA-512 sized) but cannot be
   * recomputed without the salt.
   */
  it('UPI mandate: status|action|authpayuid|dateTime|amount|endDate|salt', () => {
    const literal = `pause|MANDATE_PAUSE|19188766234|2024-02-15 16:41:16|10.00|2025-12-01 00:00:00|${SALT}`;
    expect(
      upiMandateWebhookHash({
        salt: SALT,
        status: 'pause',
        action: 'MANDATE_PAUSE',
        authpayuid: '19188766234',
        dateTime: '2024-02-15 16:41:16',
        amount: '10.00',
        endDate: '2025-12-01 00:00:00',
      }),
    ).toBe(sha512Hex(literal));
    expect('04fda68800f4004f403c336b7b304c92c59edcc6c99af91d8879e58abf3472091476428c8f733918f6397864ce3c58354385643e2e3af3b3c32f890e8b174b04').toHaveLength(128);
  });
});
