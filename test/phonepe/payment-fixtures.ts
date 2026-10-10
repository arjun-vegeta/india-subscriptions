/**
 * PhonePe's sample payloads for one-time payments (Standard Checkout, v2), copied from the documentation. Every fixture names
 * its source page:
 *
 *   CREATE   https://developer.phonepe.com/payment-gateway/website-integration/standard-checkout/api-integration/api-reference/create-payment
 *   STATUS   .../api-reference/order-status
 *   REFUND   .../api-reference/refund   (initiate and status are on the one page)
 *   WEBHOOK  .../api-reference/webhook
 *   CHECKLIST https://developer.phonepe.com/payment-gateway/uat-testing-go-live/uat-checklist
 *
 * Where the page elides part of a sample or prints it with a syntax error, the fixture says what was changed. Nothing is invented.
 */

// ---------------------------------------------------------------------------
// Create Payment [CREATE]
// ---------------------------------------------------------------------------

/** [CREATE] "Sample Request in curl": the `--data` body, verbatim. */
export const PAY_REQUEST_CREATE_CURL = {
  merchantOrderId: 'TX123rrty34432456',
  amount: 1000,
  paymentFlow: {
    type: 'PG_CHECKOUT',
    message: 'Payment message used for collect requests',
    merchantUrls: {
      redirectUrl: 'https://www.xyz.com/PGIntegration/',
    },
  },
};

/** [CREATE] "Sample Request with Selected Instrument for enabledPaymentModes": the `paymentModeConfig` block, verbatim. */
export const PAY_MODE_CONFIG_ENABLED_CREATE = {
  enabledPaymentModes: [
    { type: 'UPI_INTENT' },
    { type: 'UPI_QR' },
    { type: 'NET_BANKING' },
    { type: 'CARD', cardTypes: ['DEBIT_CARD', 'CREDIT_CARD'] },
  ],
};

/** [CREATE] "Response, Case 1: Order created successfully", verbatim. */
export const PAY_RESPONSE_CASE_1_CREATE = {
  orderId: 'OMO123456789',
  state: 'PENDING',
  expireAt: 1703756259307,
  redirectUrl:
    'https://mercury-uat.phonepe.com/transact/uat_v2?token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHBpcmVzT24iOjE3MjgyNTk1MzE0NzgsIm1lcmNoYW50SWQiOiJWUlVBVCIsIm1lcmNoYW50T3JkZXJJZCI6Ik1PLTlkMC1hNmMyYmY1ZWM4MmUifQ.Trj5fub__kJpQhzOlJttXl2UPruHE7fsbH5QWj-iy6E',
};

/** [CREATE] "Case 2: Order with same merchant order id is already present and not in CREATED state", verbatim. */
export const PAY_ERROR_CASE_2_CREATE = { code: 'BAD_REQUEST', message: 'Please check the inputs you have provided.' };

/** [CREATE] "Case 3: Internal Server Error", verbatim. */
export const PAY_ERROR_CASE_3_CREATE = {
  code: 'INTERNAL_SERVER_ERROR',
  message: 'There is an error trying to process your transaction at the moment. Please try again in a while.',
};

// ---------------------------------------------------------------------------
// Order Status [STATUS]
// ---------------------------------------------------------------------------

/** [STATUS] "Sample Response for the CURL Request", verbatim (the angle-bracket values are the page's placeholders). */
export const ORDER_SAMPLE_CURL_STATUS = {
  orderId: 'OMO2403282020198641071317',
  state: 'COMPLETED',
  amount: 1000,
  expireAt: 1711867462542,
  paymentDetails: [
    {
      paymentMode: 'UPI_QR',
      transactionId: 'OM2403282020198651071949',
      timestamp: 1711694662542,
      amount: 1000,
      state: 'COMPLETED',
      rail: { type: 'UPI', utr: '<utr>', upiTransactionId: '<upiTransactionId>', vpa: '<vpa>' },
      instrument: { type: 'ACCOUNT', maskedAccountNumber: '<maskedAccountNumber>', accountType: 'SAVINGS', accountHolderName: '<accountHolderName>' },
    },
  ],
};

const UDF_KEYS = Array.from({ length: 15 }, (_, index) => `udf${index + 1}`);
const udf = (value: (key: string, index: number) => string): Record<string, string> =>
  Object.fromEntries(UDF_KEYS.map((key, index) => [key, value(key, index)]));

/** [STATUS] "Case 1: Response for Order is completed and details = true", verbatim. */
export const ORDER_CASE_1_STATUS = {
  orderId: 'OMO2407021511185686967711',
  state: 'COMPLETED',
  amount: 1000,
  payableAmount: 1000,
  feeAmount: 0,
  expireAt: 1719913878566,
  paymentDetails: [
    {
      transactionId: 'OM2407021515097451914211',
      paymentMode: 'UPI_INTENT',
      timestamp: 1719913509762,
      amount: 1000,
      payableAmount: 1000,
      feeAmount: 0,
      state: 'COMPLETED',
      rail: { type: 'UPI', upiTransactionId: 'upi12313', vpa: '12****78@ybl' },
      instrument: { type: 'ACCOUNT', maskedAccountNumber: '******1234', accountType: 'SAVINGS' },
      splitInstruments: [
        {
          instrument: { type: 'ACCOUNT', maskedAccountNumber: '******1234', accountType: 'SAVINGS' },
          rail: { type: 'UPI', utr: '455069731511', upiTransactionId: 'YBL369f6d962de74c2680789bff8c11aec9', vpa: '12****78@ybl' },
          amount: 1000,
        },
      ],
    },
  ],
  metaInfo: udf(() => ''),
};

/** [STATUS] "Case 3: Response for Payment Mode: CARD", verbatim. */
export const ORDER_CASE_3_STATUS = {
  orderId: 'OMO2507241148405311106438',
  state: 'COMPLETED',
  amount: 100,
  payableAmount: 100,
  feeAmount: 0,
  expireAt: 1753338820531,
  paymentDetails: [
    {
      transactionId: 'OM2507241150264011152620',
      paymentMode: 'CARD',
      timestamp: 1753338026421,
      amount: 100,
      payableAmount: 100,
      feeAmount: 0,
      state: 'COMPLETED',
      instrument: {
        type: 'CREDIT_CARD',
        bankId: 'HDFC',
        brn: '520506406845',
        geoScope: 'DOMESTIC',
        cardNetwork: 'VISA',
        maskedCardNumber: '******1234',
      },
      rail: { type: 'PG', authorizationCode: '088005' },
      splitInstruments: [
        {
          instrument: {
            type: 'CREDIT_CARD',
            bankId: 'HDFC',
            brn: '520506406845',
            geoScope: 'DOMESTIC',
            cardNetwork: 'VISA',
            maskedCardNumber: '******1234',
          },
          rail: { type: 'PG', authorizationCode: '088005' },
          amount: 100,
        },
      ],
    },
  ],
  metaInfo: {
    udf1: 'Harshad',
    udf2: '30',
    udf3: 'UDF3',
    udf4: 'UDF4',
    udf5: 'UDF5',
    udf6: 'UDF6',
    udf7: 'UDF7',
    udf8: 'UDF8',
    udf9: 'UDF9',
    udf10: 'UDF10',
    udf11: 'UDF11',
    udf12: 'UDF12',
    udf13: 'UDF13',
    udf14: 'UDF14',
    udf15: 'UDF15',
  },
};

/** [STATUS] "Case 4: Response for No payment attempt is made for the order", verbatim. */
export const ORDER_CASE_4_STATUS = {
  orderId: 'OMO2407111821482103732111',
  state: 'PENDING',
  amount: 100,
  expireAt: 1720702908208,
  paymentDetails: [],
  metaInfo: udf((_key, index) => `additional-information-${index + 1}`),
};

/** [STATUS] "Case 5: Response for Order is Failed", verbatim. */
export const ORDER_CASE_5_STATUS = {
  orderId: 'OMO2407121214395503786511',
  state: 'FAILED',
  amount: 200,
  expireAt: 1720767279548,
  errorCode: 'INVALID_MPIN',
  detailedErrorCode: 'ZM',
  paymentDetails: [
    {
      transactionId: 'OM2407121214579231302711',
      paymentMode: 'UPI_COLLECT',
      timestamp: 1720766697944,
      amount: 200,
      payableAmount: 200,
      feeAmount: 0,
      state: 'FAILED',
      errorCode: 'INVALID_MPIN',
      detailedErrorCode: 'ZM',
    },
  ],
  errorContext: {
    errorCode: 'INVALID_MPIN',
    detailedErrorCode: 'ZM',
    source: 'CUSTOMER',
    stage: 'AUTHENTICATION',
    description: 'Wrong MPIN was entered',
  },
  metaInfo: udf((_key, index) => `<additional-information-${index + 1}>`),
};

/** [STATUS] "Case 6: Response for Invalid order ID", verbatim. */
export const ORDER_CASE_6_STATUS = { code: 'INVALID_MERCHANT_ORDER_ID', message: 'No entry found for given merchant order id' };

/** [STATUS] "Case 7: Response for CREDIT_LINE", verbatim. */
export const ORDER_CASE_7_STATUS = {
  merchantId: 'MERCHANT123',
  merchantOrderId: 'ORD123456',
  orderId: 'OID789',
  state: 'COMPLETED',
  amount: 50000,
  currency: 'INR',
  payableAmount: 50000,
  payableCurrency: 'INR',
  feeAmount: 0,
  feeCurrency: 'INR',
  discountAmount: 0,
  expireAt: 1746000000000,
  metaInfo: { udf1: '', udf2: '', udf3: '', udf4: '', udf5: '' },
  paymentDetails: [
    {
      transactionId: 'TXN789',
      paymentMode: 'CREDIT_LINE',
      timestamp: 1746000000000,
      amount: 50000,
      currency: 'INR',
      payableAmount: 50000,
      payableCurrency: 'INR',
      feeAmount: 0,
      feeCurrency: 'INR',
      state: 'COMPLETED',
      instrument: {
        type: 'CREDIT_LINE',
        ifsc: 'ICIC0001234',
        accountHolderName: 'John Doe',
        bankId: 'ICICI',
        maskedAccountNumber: 'XXXXXX1234',
        unmaskedAccountNumber: '1234567890',
        providerAccountType: 'CL01',
      },
      rail: { type: 'UPI', utr: 'UTR123456789', vpa: 'user@bankhandle', upiTransactionId: 'UPI123456' },
    },
  ],
  paymentFlow: { type: 'PG' },
};

// ---------------------------------------------------------------------------
// Refund [REFUND]
// ---------------------------------------------------------------------------

/** [REFUND] "Initiating Refund Request, Sample Request", verbatim. */
export const REFUND_REQUEST_REFUND = { merchantRefundId: 'Refund-id-12345', originalMerchantOrderId: 'Order-12345', amount: 1234 };

/** [REFUND] "Refund Initiation Response, Case 1" (the page prints it without the comma after `refundId`). */
export const REFUND_RESPONSE_CASE_1_REFUND = { refundId: 'OMRxxxxx', amount: 1234, state: 'PENDING' };

// ---------------------------------------------------------------------------
// Webhooks [WEBHOOK]
// ---------------------------------------------------------------------------

/** [WEBHOOK] "Response for Order Completed", verbatim. */
export const WEBHOOK_ORDER_COMPLETED_WEBHOOK = {
  event: 'checkout.order.completed',
  payload: {
    orderId: 'OMO2403282020198641071317',
    merchantId: 'merchantId',
    merchantOrderId: 'merchantOrderId',
    state: 'COMPLETED',
    amount: 10000,
    expireAt: 1724866793837,
    paymentDetails: [{ paymentMode: 'UPI_QR', transactionId: 'OM12334', timestamp: 1724866793837, amount: 10000, state: 'COMPLETED' }],
    metaInfo: udf(() => ''),
  },
};

/** [WEBHOOK] "Response for Order Failed", verbatim. */
export const WEBHOOK_ORDER_FAILED_WEBHOOK = {
  event: 'checkout.order.failed',
  payload: {
    orderId: 'OMO2403282020198641071311',
    merchantId: 'merchantId',
    merchantOrderId: 'merchantOrderId',
    state: 'FAILED',
    amount: 10000,
    expireAt: 1724866793837,
    paymentDetails: [
      {
        paymentMode: 'UPI_COLLECT',
        timestamp: 1724866793837,
        amount: 10000,
        transactionId: 'OM12333',
        state: 'FAILED',
        errorCode: 'AUTHORIZATION_ERROR',
        detailedErrorCode: 'ZM',
      },
    ],
    metaInfo: { udf1: '', udf2: '', udf3: '', udf4: '' },
  },
};

/** [WEBHOOK] "Response for Refund Completed, Case 2: Original source of transaction = CARD", verbatim (the only one with the envelope). */
export const WEBHOOK_REFUND_COMPLETED_CASE_2_WEBHOOK = {
  event: 'pg.refund.completed',
  payload: {
    merchantId: 'merchantId',
    merchantRefundId: 'merchantRefundId',
    originalMerchantOrderId: 'Refund-12345',
    amount: 50000,
    state: 'COMPLETED',
    timestamp: 1730869961754,
    refundId: 'OMR7878098045517540996',
    paymentDetails: [{ paymentMode: 'UPI_INTENT', timestamp: 1706629419799, amount: 50000, transactionId: 'OMR7896789', state: 'COMPLETED' }],
  },
};

/**
 * [WEBHOOK] "Response for Refund Failed, Case 3": verbatim, except that the page prints the key `refundId` twice (the second,
 * `OMR7878098045517540996`, is the one JSON keeps) and that is the only one kept here.
 */
export const WEBHOOK_REFUND_FAILED_CASE_3_WEBHOOK = {
  event: 'pg.refund.failed',
  payload: {
    originalMerchantOrderId: '',
    amount: 1234,
    state: 'FAILED',
    timestamp: 1730869961754,
    refundId: 'OMR7878098045517540996',
    errorCode: 'AUTHORIZATION_ERROR',
    detailedErrorCode: 'ZM',
  },
};
