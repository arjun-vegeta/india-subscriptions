/**
 * Fixtures. Each cites the documentation page it comes from. Where a page prints a sample that is not valid JSON, the
 * fixture repeats it with the punctuation fixed and nothing else changed; resources without a printed sample are built
 * from their documented field lists.
 */

/**
 * Subscription purchase, sample response of
 * https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.subscriptionsv2/get
 * (the page prints it without commas between some members and with trailing commas). It is priced in USD there.
 */
export const SUBSCRIPTION_GET_SAMPLE = {
  kind: 'androidpublisher#subscriptionPurchaseV2',
  regionCode: 'US',
  startTime: '2024-01-15T10:00:00Z',
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.3345-1234-5678-90123',
  linkedPurchaseToken: null,
  pausedStateContext: null,
  canceledStateContext: null,
  testPurchase: null,
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
  externalAccountIdentifiers: {
    externalAccountId: 'user-ext-acc-88765',
    obfuscatedExternalAccountId: ' obfuscated-acc-id-aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789',
    obfuscatedExternalProfileId: 'obfuscated-prof-id-9876543210zYxWvUtSrQpOnMlKjIhGfEdCbA',
  },
  subscribeWithGoogleInfo: {
    profileId: '109876543210987654321',
    profileName: 'Alex Smith',
    emailAddress: 'alex.smith.swg@example.com',
    givenName: 'Alex',
    familyName: 'Smith',
  },
  lineItems: [
    {
      productId: 'premium_monthly_v2',
      expiryTime: '2025-01-15T10:00:00Z',
      latestSuccessfulOrderId: 'GPA.3345-1234-5678-90123',
      autoRenewingPlan: {
        autoRenewEnabled: true,
        recurringPrice: { units: '12', nanos: 990000000, currencyCode: 'USD' },
        priceChangeDetails: null,
        priceStepUpConsentDetails: null,
        installmentDetails: null,
      },
      prepaidPlan: null,
      offerDetails: {
        basePlanId: 'premium-monthly',
        offerId: 'intro-offer-7day',
        offerTags: ['initial_discount', 'seasonal_promo'],
      },
      offerPhase: { basePrice: {} },
      deferredItemReplacement: null,
      signupPromotion: null,
      itemReplacement: null,
    },
  ],
  etag: '74798db94d8dc4c76ad1df9f77fd9693',
  outofAppPurchaseContext: null,
};

/** The same purchase priced in rupees (the sample's `recurringPrice` with `currencyCode` INR and 499.50). */
export const SUBSCRIPTION_INR = {
  ...SUBSCRIPTION_GET_SAMPLE,
  regionCode: 'IN',
  lineItems: [
    {
      ...SUBSCRIPTION_GET_SAMPLE.lineItems[0],
      autoRenewingPlan: {
        ...SUBSCRIPTION_GET_SAMPLE.lineItems[0]?.autoRenewingPlan,
        recurringPrice: { units: '499', nanos: 500000000, currencyCode: 'INR' },
      },
    },
  ],
};

/**
 * A new purchase, from the "New auto-renewing subscription purchases" example of
 * https://developer.android.com/google/play/billing/lifecycle/subscriptions (`acknowledgementState` is pending, the offer
 * phase is a free trial). The page elides some members with `...`; the id of the buyer is added.
 */
export const SUBSCRIPTION_NEW = {
  kind: 'androidpublisher#subscriptionPurchaseV2',
  startTime: '2022-04-22T18:39:58.270Z',
  regionCode: 'IN',
  subscriptionState: 'SUBSCRIPTION_STATE_ACTIVE',
  latestOrderId: 'GPA.3333-4137-0319-36762',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
  externalAccountIdentifiers: { obfuscatedExternalAccountId: '6f1c2d0e-3a41-4d7c-9e3b-0a5c1e2f7b11' },
  lineItems: [
    {
      productId: 'sub_variant_plan01',
      expiryTime: '2022-04-29T18:39:58.270Z',
      autoRenewingPlan: { autoRenewEnabled: true },
      offerPhase: { freeTrial: {} },
    },
  ],
  etag: 'etag-new',
};

export function withState(base: Record<string, unknown>, subscriptionState: string, extra: Record<string, unknown> = {}) {
  return { ...base, subscriptionState, ...extra };
}

/** Real-time developer notifications: https://developer.android.com/google/play/billing/rtdn-reference (examples). */
export const RTDN_SUBSCRIPTION = {
  version: '1.0',
  packageName: 'com.some.thing',
  eventTimeMillis: '1503349566168',
  subscriptionNotification: { version: '1.0', notificationType: 4, purchaseToken: 'PURCHASE_TOKEN' },
};
export const RTDN_ONE_TIME = {
  version: '1.0',
  packageName: 'com.some.thing',
  eventTimeMillis: '1503349566168',
  oneTimeProductNotification: { version: '1.0', notificationType: 1, purchaseToken: 'PURCHASE_TOKEN', sku: 'my.sku' },
};
/** The page's example prints `"productType":1 "refundType":1` without a comma. */
export const RTDN_VOIDED = {
  version: '1.0',
  packageName: 'com.some.app',
  eventTimeMillis: '1503349566168',
  voidedPurchaseNotification: { purchaseToken: 'PURCHASE_TOKEN', orderId: 'GS.0000-0000-0000', productType: 1, refundType: 1 },
};
export const RTDN_PENDING_REFUND = {
  version: '1.0',
  packageName: 'com.some.thing',
  eventTimeMillis: '1503350156918',
  pendingRefundReviewNotification: {
    version: '1.0',
    pendingRefundToken: 'example-token',
    orderId: 'GPA.1234-5678-9012-34567',
    refundReason: 7,
    obfuscatedAccountId: 'user-account-id',
    obfuscatedProfileId: 'user-profile-id',
  },
};
export const RTDN_TEST = {
  version: '1.0',
  packageName: 'com.some.thing',
  eventTimeMillis: '1503350156918',
  testNotification: { version: '1.0' },
};

/**
 * The wrapped Pub/Sub push body with the minimum values, https://cloud.google.com/pubsub/docs/push ("Example of a request
 * with the minimum values"); `data` is replaced by the notification under test.
 */
export const PUSH_MINIMUM = {
  message: {
    data: 'SGVsbG8gQ2xvdWQgUHViL1N1YiEgSGVyZSBpcyBteSBtZXNzYWdlIQ==',
    messageId: '2070443601311540',
    message_id: '2070443601311540',
    publishTime: '2021-02-26T19:13:55.749Z',
    publish_time: '2021-02-26T19:13:55.749Z',
  },
  subscription: 'projects/myproject/subscriptions/mysubscription',
};

/**
 * Claims of a push token, https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions ("JWT format"), with
 * the instants moved to the test clock.
 */
export const PUSH_CLAIMS_SAMPLE = {
  aud: 'https://example.com',
  azp: '113774264463038321964',
  email: 'gae-gcp@appspot.gserviceaccount.com',
  sub: '113774264463038321964',
  email_verified: true,
  exp: 1550185935,
  iat: 1550182335,
  iss: 'https://accounts.google.com',
};

/**
 * `externaltransactions.createexternaltransaction` response sample,
 * https://developers.google.com/android-publisher/api-ref/rest/v3/externaltransactions/createexternaltransaction
 */
export const EXTERNAL_CREATE_RESPONSE_SAMPLE = {
  createTime: '2023-04-20T14:23:18.121Z',
  currentPreTaxAmount: { currency: 'USD', priceMicros: '12000000' },
  currentTaxAmount: { currency: 'USD', priceMicros: '1200000' },
  externalTransactionId: 'ext-trans-id-1234',
  oneTimeTransaction: { externalTransactionToken: 'one-time-token-abc' },
  originalPreTaxAmount: { currency: 'USD', priceMicros: '15000000' },
  originalTaxAmount: { currency: 'USD', priceMicros: '1500000' },
  packageName: 'com.example.app',
  recurringTransaction: {
    externalSubscription: { subscriptionType: 'RECURRING' },
    externalTransactionToken: 'recurring-token-xyz',
    initialExternalTransactionId: 'ext-trans-id-5678',
    otherRecurringProduct: {},
  },
  testPurchase: {},
  transactionProgramCode: 11,
  transactionState: 'TRANSACTION_REPORTED',
  transactionTime: '2023-04-20T14:20:00.000Z',
  userTaxAddress: { regionCode: 'US' },
};

/** `refundexternaltransaction` response sample, https://developers.google.com/android-publisher/api-ref/rest/v3/externaltransactions/refundexternaltransaction */
export const EXTERNAL_REFUND_RESPONSE_SAMPLE = {
  externalTransactionId: '1234567890123456789012345678901234567890123456789012345678901234',
  originalPreTaxAmount: { currency: 'USD', priceMicros: '1990000' },
  originalTaxAmount: { currency: 'USD', priceMicros: '11400000' },
  packageName: 'com.example.app',
  transactionState: 'TRANSACTION_CANCELED',
  transactionTime: '2023-04-01T12:00:00Z',
  userTaxAddress: { regionCode: 'US' },
  createTime: '2023-04-01T11:55:00Z',
  currentPreTaxAmount: { currency: 'USD', priceMicros: '0' },
  currentTaxAmount: { currency: 'USD', priceMicros: '0' },
  testPurchase: {},
  recurringTransaction: {
    initialExternalTransactionId: '9876543210987654321098765432109876543210987654321098765432109876',
    externalSubscription: { subscriptionType: 'RECURRING' },
  },
};

/** A one-time purchase built from the `ProductPurchaseV2` field list of https://developers.google.com/android-publisher/api-ref/rest/v3/purchases.productsv2 */
export const PRODUCT_PURCHASED = {
  kind: 'androidpublisher#productPurchaseV2',
  productLineItem: [
    {
      productId: 'coins_100',
      productOfferDetails: { quantity: 1, refundableQuantity: 1, consumptionState: 'CONSUMPTION_STATE_YET_TO_BE_CONSUMED' },
    },
  ],
  purchaseStateContext: { purchaseState: 'PURCHASED' },
  orderId: 'GPA.3375-1111-2222-33333',
  obfuscatedExternalAccountId: '0b9d9a4e-6f27-4c52-8a0b-4a3c2f6f4c10',
  regionCode: 'IN',
  purchaseCompletionTime: '2026-11-22T06:00:00.000Z',
  acknowledgementState: 'ACKNOWLEDGEMENT_STATE_PENDING',
};

/** An order built from the `Order` field list of https://developers.google.com/android-publisher/api-ref/rest/v3/orders */
export const ORDER_PROCESSED = {
  orderId: 'GPA.3375-1111-2222-33333',
  purchaseToken: 'one-time-token',
  state: 'PROCESSED',
  createTime: '2026-11-22T05:59:30.000Z',
  total: { currencyCode: 'INR', units: '99', nanos: 0 },
  tax: { currencyCode: 'INR', units: '15', nanos: 100000000 },
  lineItems: [{ productId: 'coins_100', oneTimePurchaseDetails: { quantity: 1 } }],
  orderHistory: { processedEvent: { eventTime: '2026-11-22T06:00:00.000Z' } },
};

export const SUBSCRIPTION_ORDER = {
  orderId: 'GPA.3345-1234-5678-90123..0',
  purchaseToken: 'sub-token-1',
  state: 'PROCESSED',
  createTime: '2026-11-22T05:59:30.000Z',
  total: { currencyCode: 'INR', units: '499', nanos: 500000000 },
  lineItems: [{ productId: 'premium_monthly_v2', subscriptionDetails: { basePlanId: 'premium-monthly', offerPhaseDetails: { baseDetails: {} } } }],
  orderHistory: { processedEvent: { eventTime: '2026-11-22T06:00:00.000Z' } },
};
