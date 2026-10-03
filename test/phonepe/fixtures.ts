/**
 * PhonePe's sample payloads, copied from the documentation as distilled in the fact sheet
 * (`scratchpad/ref/facts/phonepe.md`). Every fixture names its source code:
 *
 *   A-AUTH   /payment-gateway/autopay/api-integration/api-reference/authorization (token)
 *   SC-SETUP /payment-gateway/autopay/standard-checkout/setup-subscription/api-integration
 *   SC-ORDER /payment-gateway/autopay/standard-checkout/order-status
 *   SC-SUBSTATUS /payment-gateway/autopay/standard-checkout/subscription-status-2
 *   A-SUBSTATUS  /payment-gateway/autopay/api-integration/api-reference/subscription-status
 *   SC-NOTIFY / A-NOTIFY, SC-NOTIFSTATUS, SC-EXEC, A-REDORDER  (redemption pages)
 *   SC-REFUND, A-REFUND  /payment-gateway/autopay/{standard-checkout,api-integration/api-reference}/refund
 *   SC-WEBHOOK / A-WEBHOOK  the webhook pages
 *   A-ERR    /payment-gateway/autopay/error-codes
 *   G-ORDER / G-CREATE  the generic order-status and create-payment pages (error bodies)
 *
 * Where the fact sheet elides part of a sample (`...`, `{...same...}`), the elided fields are simply left out here: nothing
 * is invented. Where a fixture is NOT verbatim it says so.
 */

// ---------------------------------------------------------------------------
// Token [A-AUTH]
// ---------------------------------------------------------------------------

/** [A-AUTH] verbatim sample response. `issued_at` 1706073005 is 2024-01-24T05:30:05Z; `expires_at - issued_at` = 624600 s. */
export const TOKEN_RESPONSE_A_AUTH = {
  access_token:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHBpcmVzT24iOjE3MjA2MzUzMjE5OTYsIm1lcmNoYW50SWQiOiJWUlVBVCJ9.4YjYHI6Gy6gzOisD_628wfbaI46dMSc5T_0gZ2-SAJo',
  encrypted_access_token:
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHBpcmVzT24iOjE3MjA2MzUzMjE5OTYsIm1lcmNoYW50SWQiOiJWUlVBVCJ9.4YjYHI6Gy6gzOisD_628wfbaI46dMSc5T_0gZ2-SAJo',
  expires_in: null,
  issued_at: 1706073005,
  expires_at: 1706697605,
  session_expires_at: 1706697605,
  token_type: 'O-Bearer',
};
export const A_AUTH_ISSUED_AT_MS = 1706073005 * 1000;
export const A_AUTH_EXPIRES_AT_MS = 1706697605 * 1000;

// ---------------------------------------------------------------------------
// Setup [SC-SETUP]
// ---------------------------------------------------------------------------

/** [SC-SETUP] verbatim sample request (TRANSACTION). Our request differs in `productType`, ids and times; see setup tests. */
export const SETUP_REQUEST_SC_SETUP = {
  merchantOrderId: 'Tx123',
  amount: 47900,
  paymentFlow: {
    type: 'SUBSCRIPTION_CHECKOUT_SETUP',
    merchantUrls: { redirectUrl: 'www.google.com' },
    subscriptionDetails: {
      subscriptionType: 'RECURRING',
      merchantSubscriptionId: 'Sub123',
      authWorkflowType: 'TRANSACTION',
      amountType: 'FIXED',
      maxAmount: 47900,
      frequency: 'ON_DEMAND',
      expireAt: 1779689282000,
    },
  },
  expireAfter: 3000,
  metaInfo: { udf1: 'some meta info of max length 256', udf2: 'some meta info of max length 256' },
};

/** [SC-SETUP] verbatim sample response. */
export const SETUP_RESPONSE_SC_SETUP = {
  orderId: 'OMO2604141019329833275508V',
  state: 'PENDING',
  redirectUrl: 'https://mercury-t2.phonepe.com/transact/pgv3?token=hq4wOGdz...&routingKey=V',
  expireAt: 1776145172971,
};

/** [SC-ORDER] verbatim COMPLETED setup order (its `splitInstruments` and `metaInfo` are elided in the fact sheet and omitted here). */
export const SETUP_ORDER_COMPLETED_SC_ORDER = {
  orderId: 'OMO2604141037458946131769V',
  state: 'COMPLETED',
  currency: 'INR',
  amount: 100,
  payableCurrency: 'INR',
  payableAmount: 100,
  feeCurrency: 'INR',
  feeAmount: 0,
  expireAt: 1776146265882,
  paymentFlow: {
    type: 'SUBSCRIPTION_CHECKOUT_SETUP',
    merchantSubscriptionId: 'Sub123',
    authWorkflowType: 'TRANSACTION',
    amountType: 'FIXED',
    maxAmount: 100,
    frequency: 'ON_DEMAND',
    expireAt: 1779689282000,
    subscriptionId: 'OMS2604141037458806131949V',
  },
  paymentDetails: [
    {
      transactionId: 'OM2604141037482338791885V',
      paymentMode: 'UPI_QR',
      timestamp: 1776143268272,
      currency: 'INR',
      amount: 100,
      payableCurrency: 'INR',
      payableAmount: 100,
      feeCurrency: 'INR',
      feeAmount: 0,
      state: 'COMPLETED',
      instrument: { type: 'ACCOUNT', maskedAccountNumber: 'XXXXXX6392', ifsc: 'SBIN0011290', accountType: 'SAVINGS', bankId: 'SBIN' },
      rail: { type: 'UPI', utr: '610408034245', umn: 'd908ccf63c21406f9f38b94f70994921@axl' },
    },
  ],
};

/**
 * [A-ORDER] FAILED setup order: the fact sheet prints only the key parts (`"state": "FAILED", "errorCode": "INVALID_MPIN",
 * "detailedErrorCode": "ZM"` and `paymentDetails[0]`); the rest is taken from the [SC-ORDER] COMPLETED sample's envelope.
 * NOT fully verbatim.
 */
export const SETUP_ORDER_FAILED_A_ORDER = {
  orderId: 'OMO2604141037458946131769V',
  state: 'FAILED',
  errorCode: 'INVALID_MPIN',
  detailedErrorCode: 'ZM',
  currency: 'INR',
  amount: 100,
  paymentFlow: SETUP_ORDER_COMPLETED_SC_ORDER.paymentFlow,
  paymentDetails: [
    {
      transactionId: 'OM2604141037482338791885V',
      paymentMode: 'UPI_INTENT',
      timestamp: 1776143268272,
      amount: 100,
      state: 'FAILED',
      errorCode: 'INVALID_MPIN',
      detailedErrorCode: 'ZM',
    },
  ],
};

/** A setup order the customer has not finished: [SC-SETUP] response envelope with the order-status shape of [SC-ORDER]. NOT verbatim (no PENDING order-status sample is published). */
export const SETUP_ORDER_PENDING = {
  orderId: 'OMO2604141019329833275508V',
  state: 'PENDING',
  currency: 'INR',
  amount: 200,
  expireAt: 1776145172971,
  paymentFlow: {
    type: 'SUBSCRIPTION_CHECKOUT_SETUP',
    merchantSubscriptionId: 'Sub123',
    authWorkflowType: 'PENNY_DROP',
    amountType: 'FIXED',
    maxAmount: 100,
    frequency: 'ON_DEMAND',
    expireAt: 1779689282000,
  },
  paymentDetails: [],
};

// ---------------------------------------------------------------------------
// Subscription status [SC-SUBSTATUS, A-SUBSTATUS]
// ---------------------------------------------------------------------------

/** [SC-SUBSTATUS] verbatim sample response. */
export const SUBSCRIPTION_STATUS_SC_SUBSTATUS = {
  merchantSubscriptionId: 'Sub123',
  subscriptionId: 'OMS2604141037458806131949V',
  state: 'ACTIVE',
  productType: null,
  authInstrumentType: null,
  authWorkflowType: 'TRANSACTION',
  amountType: 'FIXED',
  currency: 'INR',
  maxAmount: 100,
  frequency: 'ON_DEMAND',
  expireAt: 1779689282000,
  pauseStartDate: null,
  pauseEndDate: null,
};

/** [A-SUBSTATUS] verbatim sample response. */
export const SUBSCRIPTION_STATUS_A_SUBSTATUS = {
  merchantSubscriptionId: 'MS27',
  subscriptionId: 'OMS2604141111125173306721V',
  state: 'ACTIVE',
  productType: 'UPI_MANDATE',
  authInstrumentType: 'UPI',
  authWorkflowType: 'TRANSACTION',
  amountType: 'FIXED',
  currency: 'INR',
  maxAmount: 100,
  frequency: 'ON_DEMAND',
  expireAt: 1807681114000,
  pauseStartDate: null,
  pauseEndDate: null,
};

/** [A-SUBSTATUS] paused sample: only `state`, `pauseStartDate` and `pauseEndDate` are printed in the fact sheet; the rest is the ACTIVE sample above. NOT fully verbatim. */
export const SUBSCRIPTION_STATUS_PAUSED = {
  ...SUBSCRIPTION_STATUS_A_SUBSTATUS,
  state: 'PAUSED',
  pauseStartDate: 1708798426196,
  pauseEndDate: 1708885799000,
};

// ---------------------------------------------------------------------------
// Notify / redeem [SC-NOTIFY, SC-NOTIFSTATUS, SC-EXEC, A-REDORDER]
// ---------------------------------------------------------------------------

/** [SC-NOTIFY] verbatim sample request. */
export const NOTIFY_REQUEST_SC_NOTIFY = {
  merchantOrderId: 'Tx1234',
  amount: 100,
  expireAt: 1807681114000,
  paymentFlow: {
    type: 'SUBSCRIPTION_CHECKOUT_REDEMPTION',
    merchantSubscriptionId: 'Sub123',
    redemptionRetryStrategy: 'STANDARD',
    autoDebit: false,
  },
};

/** [A-NOTIFY, SC-NOTIFY] verbatim sample response. */
export const NOTIFY_RESPONSE_SC_NOTIFY = {
  orderId: 'OMO2604141127165135825782V',
  state: 'NOTIFICATION_IN_PROGRESS',
  expireAt: 1776491836478,
  nativeOtpEnabled: false,
};

/** [SC-NOTIFSTATUS] verbatim sample response: a notified redemption order. `validAfter - notifiedAt` is 24 h less 0.5 s; `validUpto - validAfter` is 72 h. */
export const NOTIFICATION_STATUS_SC_NOTIFSTATUS = {
  orderId: 'OMO2604141043461445825945V',
  state: 'NOTIFIED',
  currency: 'INR',
  amount: 100,
  expireAt: 1776489226123,
  paymentFlow: {
    type: 'SUBSCRIPTION_CHECKOUT_REDEMPTION',
    merchantSubscriptionId: 'Sub123',
    redemptionRetryStrategy: 'STANDARD',
    autoDebit: false,
    validAfter: 1776230026000,
    validUpto: 1776489226000,
    notifiedAt: 1776143626555,
  },
  paymentDetails: [],
};

/** [SC-EXEC] verbatim sample response. */
export const REDEEM_RESPONSE_SC_EXEC = {
  transactionId: 'OM2603021020514773080857W',
  state: 'PENDING',
};

/** [A-REDORDER] verbatim COMPLETED redemption order (`splitInstruments` is elided in the fact sheet and omitted here). */
export const REDEMPTION_ORDER_COMPLETED_A_REDORDER = {
  merchantId: 'MER273',
  merchantOrderId: 'M2771',
  orderId: 'OMO2605310946557315335104V',
  state: 'COMPLETED',
  currency: 'INR',
  amount: 100,
  expireAt: 1780546615690,
  paymentFlow: {
    type: 'SUBSCRIPTION_REDEMPTION',
    merchantSubscriptionId: 'MS0352112',
    redemptionRetryStrategy: 'CUSTOM',
    autoDebit: false,
    validAfter: 1780287416000,
    validUpto: 1780546615000,
    notifiedAt: 1780201016168,
  },
  paymentDetails: [
    {
      transactionId: 'OM2606011016390665335021V',
      paymentMode: 'UPI_AUTO_PAY',
      timestamp: 1780289199068,
      currency: 'INR',
      amount: 100,
      payableCurrency: 'INR',
      payableAmount: 100,
      feeCurrency: 'INR',
      feeAmount: 0,
      state: 'COMPLETED',
      instrument: { type: 'ACCOUNT', accountType: 'SAVINGS', bankId: 'SBIN' },
      rail: { type: 'UPI', utr: '615217042734', umn: 'a8763683afef4719a8de4390f8cd3a51@axl' },
    },
  ],
};

/** The redemption order [A-REDORDER] after a failed debit: only the `FAILED` / `errorCode` / `detailedErrorCode` placement is documented ([SC-WEBHOOK]: present only when FAILED; [G-ERR] INVALID_MPIN / ZM). NOT verbatim. */
export const REDEMPTION_ORDER_FAILED = {
  ...REDEMPTION_ORDER_COMPLETED_A_REDORDER,
  state: 'FAILED',
  errorCode: 'INSUFFICIENT_BALANCE',
  detailedErrorCode: 'Z9',
  paymentDetails: [
    {
      transactionId: 'OM2606011016390665335021V',
      paymentMode: 'UPI_AUTO_PAY',
      timestamp: 1780289199068,
      amount: 100,
      state: 'FAILED',
      errorCode: 'INSUFFICIENT_BALANCE',
      detailedErrorCode: 'Z9',
    },
  ],
};

// ---------------------------------------------------------------------------
// Refund [SC-REFUND, A-REFUND]
// ---------------------------------------------------------------------------

/** [A-REFUND] verbatim sample request. */
export const REFUND_REQUEST_A_REFUND = {
  merchantRefundId: 'Refund-id-12345',
  originalMerchantOrderId: 'Order-12345',
  amount: 1234,
};

/** [SC-REFUND] verbatim sample response. */
export const REFUND_RESPONSE_SC_REFUND = {
  refundId: 'OMR2604141058374994494413V',
  currency: 'INR',
  amount: 100,
  state: 'PENDING',
};

// ---------------------------------------------------------------------------
// Errors [A-ERR, G-ORDER, G-CREATE]
// ---------------------------------------------------------------------------

/** [G-ORDER case 6] verbatim: the answer for an order PhonePe has never seen. */
export const ERROR_INVALID_MERCHANT_ORDER_ID = {
  code: 'INVALID_MERCHANT_ORDER_ID',
  message: 'No entry found for given merchant order id',
};

/** [G-CREATE case 2] verbatim. */
export const ERROR_BAD_REQUEST = { code: 'BAD_REQUEST', message: 'Please check the inputs you have provided.' };

/** [G-ORDER] verbatim. */
export const ERROR_INTERNAL_SERVER_ERROR = {
  code: 'INTERNAL_SERVER_ERROR',
  message: 'There is an error trying to process your transaction at the moment. Please try again in a while.',
};

/** Error codes and descriptions of [A-ERR] (Redemption / Setup tables) in the generic `{code, message}` body of [G-CREATE]. The HTTP status PhonePe uses for them is not published; 400 is assumed. NOT verbatim bodies. */
export const ERROR_INTERVAL_NOT_STARTED = {
  code: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_NOT_STARTED',
  message: 'Execution interval hasn’t yet started (24 hours after notification)',
};
export const ERROR_INTERVAL_EXPIRED = {
  code: 'SUBSCRIPTION_DEBIT_EXECUTE_INTERVAL_EXPIRED',
  message: 'Subscription debit execute interval has expired',
};
export const ERROR_INVALID_SUBSCRIPTION_STATE = {
  code: 'INVALID_SUBSCRIPTION_STATE',
  message:
    'The state subscription is in currently doesn’t approve of the operation tried. (For example, subscription is in REVOKE_IN_PROGRESS and merchant hits notification)',
};
export const ERROR_MANDATE_REDEMPTION_SKIPPED = {
  code: 'MANDATE_REDEMPTION_SKIPPED',
  message: 'Merchant has not called the Debit Execute API / Mandate is cancelled, paused or revoked after notification.',
};
export const ERROR_DUPLICATE_TXN_REQUEST = {
  code: 'DUPLICATE_TXN_REQUEST',
  message: 'Debit transaction id is duplicate. Use another unique one.',
};
export const ERROR_RECURRENCE_LIMIT_BREACHED = {
  code: 'SUBSCRIPTION_RECURRENCE_LIMIT_BREACHED',
  message: 'Notification is attempted by breaking frequency constraints',
};
export const ERROR_SUBSCRIPTION_NOT_FOUND = { code: 'SUBSCRIPTION_NOT_FOUND', message: 'Subscription entry not found' };

// ---------------------------------------------------------------------------
// Webhooks [A-WEBHOOK, SC-WEBHOOK]
// ---------------------------------------------------------------------------

/** [A-WEBHOOK] verbatim: setup completed, API-integration variant. */
export const WEBHOOK_SETUP_COMPLETED_A_WEBHOOK = {
  event: 'subscription.setup.order.completed',
  payload: {
    merchantId: 'Mer2707',
    merchantOrderId: 'MO1708797962855',
    orderId: 'OMO2402242336055135042802',
    state: 'COMPLETED',
    amount: 200,
    expireAt: 1708798385505,
    paymentFlow: {
      type: 'SUBSCRIPTION_SETUP',
      merchantSubscriptionId: 'MS1708797962855',
      authWorkflowType: 'TRANSACTION',
      amountType: 'FIXED',
      maxAmount: 200,
      frequency: 'ON_DEMAND',
      expireAt: 1741345725943,
      subscriptionId: 'OMS2502051638460659623138',
    },
    paymentDetails: [
      {
        transactionId: 'OM2402242336055865042862',
        paymentMode: 'UPI_INTENT',
        timestamp: 1708797965588,
        amount: 200,
        payableAmount: 200,
        feeAmount: 0,
        state: 'COMPLETED',
        instrument: { type: 'ACCOUNT', maskedAccountNumber: '******1234' },
        rail: { type: 'UPI', utr: '405554491450', vpa: '12****78@ybl', umn: 'd519347eb2374125bcad6e69a42cc13b@ybl' },
      },
    ],
  },
};

/** [A-WEBHOOK] setup failed: "same envelope" with `"errorCode": "INVALID_MPIN", "detailedErrorCode": "ZM"` and `paymentDetails[0]` as printed. The envelope is the completed sample's. NOT fully verbatim. */
export const WEBHOOK_SETUP_FAILED_A_WEBHOOK = {
  event: 'subscription.setup.order.failed',
  payload: {
    ...WEBHOOK_SETUP_COMPLETED_A_WEBHOOK.payload,
    state: 'FAILED',
    errorCode: 'INVALID_MPIN',
    detailedErrorCode: 'ZM',
    paymentDetails: [
      { transactionId: 'OM2402242336055865042862', paymentMode: 'UPI_INTENT', state: 'FAILED', errorCode: 'INVALID_MPIN', detailedErrorCode: 'ZM' },
    ],
  },
};

/** [SC-WEBHOOK] Standard Checkout setup completed (the page elides some fields with `...`; they are omitted here). */
export const WEBHOOK_CHECKOUT_ORDER_COMPLETED_SC_WEBHOOK = {
  type: 'CHECKOUT_ORDER_COMPLETED',
  event: 'checkout.order.completed',
  payload: {
    merchantId: 'PRODTEST',
    merchantOrderId: 'TEST_ORD76218257999841196127',
    orderId: 'OMO2512091216567658772255V',
    state: 'COMPLETED',
    currency: 'INR',
    amount: 200,
    paymentFlow: {
      type: 'SUBSCRIPTION_CHECKOUT_SETUP',
      merchantSubscriptionId: 'MSUB_5580745967290798888',
      authWorkflowType: 'PENNY_DROP',
      amountType: 'VARIABLE',
      maxAmount: 200,
      frequency: 'DAILY',
      expireAt: 2711947616753,
      subscriptionId: 'OMS2512091216567538772793V',
    },
    paymentDetails: [
      {
        transactionId: 'OM2512091217085453615241V',
        paymentMode: 'UPI_QR',
        state: 'COMPLETED',
        rail: { type: 'UPI', utr: '534312158356', vpa: '12****78@ybl', umn: '75103a529f684f1cb9fac5ae7de4edb8@ybl' },
      },
    ],
  },
};

/** [SC-WEBHOOK] setup failed: `"event": "checkout.order.failed"`, `"errorCode": "OTHERS", "detailedErrorCode": "INTENT_EXPIRED"`; the envelope is the completed sample's. NOT fully verbatim. */
export const WEBHOOK_CHECKOUT_ORDER_FAILED_SC_WEBHOOK = {
  type: 'CHECKOUT_ORDER_FAILED',
  event: 'checkout.order.failed',
  payload: {
    ...WEBHOOK_CHECKOUT_ORDER_COMPLETED_SC_WEBHOOK.payload,
    state: 'FAILED',
    errorCode: 'OTHERS',
    detailedErrorCode: 'INTENT_EXPIRED',
    paymentDetails: [
      { transactionId: 'OM2512091217085453615241V', paymentMode: 'UPI_QR', state: 'FAILED', errorCode: 'OTHERS', detailedErrorCode: 'INTENT_EXPIRED' },
    ],
  },
};

/** A one-off Standard Checkout payment of the same merchant (not a subscription): [SC-WEBHOOK] event with a plain `PG_CHECKOUT` flow. NOT verbatim (the Autopay pages print no such sample). */
export const WEBHOOK_CHECKOUT_ORDER_COMPLETED_ONE_OFF = {
  type: 'CHECKOUT_ORDER_COMPLETED',
  event: 'checkout.order.completed',
  payload: {
    merchantId: 'PRODTEST',
    merchantOrderId: 'ONE_OFF_ORDER_1',
    orderId: 'OMO0000000000000000000000V',
    state: 'COMPLETED',
    currency: 'INR',
    amount: 5000,
    paymentFlow: { type: 'PG_CHECKOUT' },
    paymentDetails: [],
  },
};

/** [SC-WEBHOOK, A-PAUSE, A-REVOKE] verbatim: `subscription.paused`. */
export const WEBHOOK_PAUSED = {
  event: 'subscription.paused',
  payload: {
    merchantSubscriptionId: 'MS1708797962855',
    subscriptionId: 'OMS2402242336054995042603',
    state: 'PAUSED',
    authWorkflowType: 'TRANSACTION',
    amountType: 'FIXED',
    maxAmount: 200,
    frequency: 'ON_DEMAND',
    expireAt: 1737278524000,
    pauseStartDate: 1708798426196,
    pauseEndDate: 1708885799000,
  },
};

/** [SC-WEBHOOK]: `subscription.unpaused` -> `"state": "ACTIVE"`, `pauseStartDate: null`, `pauseEndDate: null`; same shape as the paused sample. */
export const WEBHOOK_UNPAUSED = {
  event: 'subscription.unpaused',
  payload: { ...WEBHOOK_PAUSED.payload, state: 'ACTIVE', pauseStartDate: null, pauseEndDate: null },
};

/** [SC-WEBHOOK]: `subscription.revoked` -> `"state": "REVOKED"`; same shape. */
export const WEBHOOK_REVOKED = {
  event: 'subscription.revoked',
  payload: { ...WEBHOOK_PAUSED.payload, state: 'REVOKED', pauseStartDate: null, pauseEndDate: null },
};

/** [SC-WEBHOOK]: `subscription.cancelled` -> `"state": "CANCELLED"`; same shape (the page's sample carries leftover pause fields, kept). */
export const WEBHOOK_CANCELLED = {
  event: 'subscription.cancelled',
  payload: { ...WEBHOOK_PAUSED.payload, state: 'CANCELLED' },
};

/** [SC-WEBHOOK, A-WEBHOOK] verbatim: notification completed. */
export const WEBHOOK_NOTIFICATION_COMPLETED = {
  event: 'subscription.notification.completed',
  payload: {
    merchantId: 'SWIGGY8',
    merchantOrderId: 'MO1708797962855',
    orderId: 'OMO12344',
    amount: 100,
    state: 'NOTIFIED',
    expireAt: 1620891733101,
    paymentFlow: {
      type: 'SUBSCRIPTION_REDEMPTION',
      merchantSubscriptionId: 'MS121312',
      redemptionRetryStrategy: 'CUSTOM',
      autoDebit: true,
      validAfter: 1628229131000,
      validUpto: 1628574731000,
      notifiedAt: 1622539751586,
    },
  },
};

/**
 * [SC-WEBHOOK, A-WEBHOOK] redemption order result. The pages' sample is not valid JSON (missing commas, empty `errorCode`);
 * the fact sheet gives its shape, filled here with the sample's own values (`OMO12344`, `MS121312`, `OM124`, amount 100).
 * NOT verbatim.
 */
export const WEBHOOK_REDEMPTION_ORDER_COMPLETED = {
  event: 'subscription.redemption.order.completed',
  payload: {
    merchantId: 'SWIGGY8',
    merchantOrderId: 'MO1708797962855',
    orderId: 'OMO12344',
    state: 'COMPLETED',
    amount: 100,
    expireAt: 1620891733101,
    paymentFlow: {
      type: 'SUBSCRIPTION_REDEMPTION',
      merchantSubscriptionId: 'MS121312',
      redemptionRetryStrategy: 'CUSTOM',
      autoDebit: true,
      validAfter: 1628229131000,
      validUpto: 1628574731000,
      notifiedAt: 1622539751586,
    },
    paymentDetails: [
      {
        amount: 100,
        paymentMode: 'UPI_AUTO_PAY',
        timestamp: 1628300000000,
        transactionId: 'OM124',
        state: 'COMPLETED',
        rail: { type: 'UPI', utr: '2', vpa: '12****78@ybl', umn: 'a8763683afef4719a8de4390f8cd3a51@ybl' },
        instrument: { type: 'ACCOUNT', maskedAccountNumber: '******1234', accountType: 'SAVINGS' },
      },
    ],
  },
};

/** The failed counterpart (shape per [SC-WEBHOOK]: `errorCode` / `detailedErrorCode` present only when FAILED; [G-ERR] INSUFFICIENT_BALANCE / Z9). NOT verbatim. */
export const WEBHOOK_REDEMPTION_ORDER_FAILED = {
  event: 'subscription.redemption.order.failed',
  payload: {
    ...WEBHOOK_REDEMPTION_ORDER_COMPLETED.payload,
    state: 'FAILED',
    errorCode: 'INSUFFICIENT_BALANCE',
    detailedErrorCode: 'Z9',
    paymentDetails: [
      {
        amount: 100,
        paymentMode: 'UPI_AUTO_PAY',
        timestamp: 1628300000000,
        transactionId: 'OM124',
        state: 'FAILED',
        errorCode: 'INSUFFICIENT_BALANCE',
        detailedErrorCode: 'Z9',
      },
    ],
  },
};

/**
 * [SC-WEBHOOK] one callback per debit ATTEMPT: "same body; sample top-level `state` `PENDING`" with the attempt's own state
 * inside `paymentDetails`. Completed and failed variants. NOT verbatim.
 */
export const WEBHOOK_REDEMPTION_TRANSACTION_COMPLETED = {
  event: 'subscription.redemption.transaction.completed',
  payload: { ...WEBHOOK_REDEMPTION_ORDER_COMPLETED.payload, state: 'PENDING' },
};
export const WEBHOOK_REDEMPTION_TRANSACTION_FAILED = {
  event: 'subscription.redemption.transaction.failed',
  payload: { ...WEBHOOK_REDEMPTION_ORDER_FAILED.payload, state: 'PENDING' },
};

/** [A-WEBHOOK] refund completed (the page's `splitInstruments` / `paymentDetails` are elided with `...` and omitted here). */
export const WEBHOOK_REFUND_COMPLETED = {
  type: 'PG_REFUND_COMPLETED',
  event: 'pg.refund.completed',
  payload: {
    merchantId: 'TX12324',
    merchantRefundId: 'Refund-id-1231003121201223',
    originalMerchantOrderId: 'TX1103221212123',
    currency: 'INR',
    amount: 100,
    state: 'COMPLETED',
    refundId: 'OMR2605201458210091350254V',
    timestamp: 1779269301012,
    phonepeTPAPTxnDetailsLink: 'https://phon.pe/hvqslu39',
  },
};

/** [A-WEBHOOK] `pg.refund.failed`: "sample has `"state": "FAILED"`, `paymentDetails[0].errorCode` `PAYMENT_ERROR`, `detailedErrorCode` `500`"; the envelope is the completed sample's. NOT fully verbatim. */
export const WEBHOOK_REFUND_FAILED = {
  type: 'PG_REFUND_FAILED',
  event: 'pg.refund.failed',
  payload: {
    ...WEBHOOK_REFUND_COMPLETED.payload,
    state: 'FAILED',
    paymentDetails: [{ transactionId: 'OMR2605201458210091350254V', paymentMode: 'UPI_QR', state: 'FAILED', errorCode: 'PAYMENT_ERROR', detailedErrorCode: '500' }],
  },
};
