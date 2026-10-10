import {
  ChargeStatus,
  Environment,
  ErrorCode,
  EventType,
  IntervalUnit,
  PaymentMethod,
  SubscriptionStatus,
} from '../../constants.js';

/**
 * Paytm Payments (Paytm PG) subscriptions: every string that is sent to or received from Paytm is named here; JSON and
 * form field names live in `schemas.ts`. Source tags are the fact sheet's `[tag]` for the doc pages (`[init-sub]`,
 * `[renew]`, `[prenotify]`, `[fetch-status]`, `[cancel]`, `[pause]`, `[txn-status]`, `[refund]`, `[wh-*]`, ...),
 * `[chk-src]` is the official `paytmchecksum@1.5.1` source (read, never executed) and `[§n]` points into the fact sheet.
 *
 * Paytm collects in two ways. With `autoRenewal: true` it debits by itself on each due date (fixed amounts only); with
 * `autoRenewal: false` the merchant calls the Renew API for every cycle, after a Pre-Notify for the modes that need one.
 * This adapter defaults to the second (see `PaytmProvider`).
 */

// ---------------------------------------------------------------------------
// Hosts [§1.1, §12.8]
// ---------------------------------------------------------------------------

/**
 * The three host families Paytm's own reference pages use. Each API is sent to the host ITS reference page prints, not
 * to one host for everything, because the docs disagree (the JS Checkout page prints the `.com` host for the
 * Transaction Status API while its own reference page prints the `.in` host). Each family has a config override.
 */
export const PaytmHostFamily = {
  /** Subscription-service APIs and the show-payment-page redirect. */
  Subscription: 'subscription',
  /** Transaction Status API v3. [txn-status] */
  TransactionStatus: 'transaction_status',
  /** Refund API. [refund] */
  Refund: 'refund',
} as const;
export type PaytmHostFamily = (typeof PaytmHostFamily)[keyof typeof PaytmHostFamily];

export const PAYTM_BASE_URLS: Record<PaytmHostFamily, Record<Environment, string>> = {
  [PaytmHostFamily.Subscription]: {
    [Environment.Test]: 'https://securestage.paytmpayments.com',
    [Environment.Live]: 'https://secure.paytmpayments.com',
  },
  [PaytmHostFamily.TransactionStatus]: {
    [Environment.Test]: 'https://securegw-stage.paytmpayments.in',
    [Environment.Live]: 'https://securegw.paytmpayments.in',
  },
  [PaytmHostFamily.Refund]: {
    [Environment.Test]: 'https://securegw-stage.paytmpayments.in',
    [Environment.Live]: 'https://securegw.paytmpayments.in',
  },
};

/** Endpoint paths. [init-sub] [renew] [prenotify] [fetch-status] [cancel] [pause] [txn-status] [refund] [spp] */
export const PaytmPath = {
  CreateSubscription: '/subscription/create',
  RenewSubscription: '/subscription/renew',
  PreNotify: '/subscription/preNotify',
  FetchStatus: '/subscription/checkStatus',
  CancelSubscription: '/subscription/cancel',
  /** The path really does contain `subscription` twice. [pause] */
  ModifyStatus: '/subscription/subscription/status/modify',
  TransactionStatus: '/v3/order/status',
  Refund: '/refund/apply',
  ShowPaymentPage: '/theia/api/v1/showPaymentPage',
} as const;
export type PaytmPath = (typeof PaytmPath)[keyof typeof PaytmPath];

/** Query parameter names of the Theia-style APIs (`mid` and `orderId` are also in the body). [init-sub] [renew] */
export const PaytmQuery = {
  Mid: 'mid',
  OrderId: 'orderId',
} as const;

// ---------------------------------------------------------------------------
// Request framing [§1.2]
// ---------------------------------------------------------------------------

/**
 * The two `head` dialects. A: Theia style (`signature`, optional `clientId`/`channelId`; answers with
 * `resultStatus`/`resultCode`/`resultMsg`). B: subscription-service style (`tokenType: AES` and `signature`; answers
 * with `status`/`code`/`message`). [init-sub] [prenotify] [fetch-status]
 */
export const PaytmHeadDialect = {
  Theia: 'theia',
  SubscriptionService: 'subscription_service',
} as const;
export type PaytmHeadDialect = (typeof PaytmHeadDialect)[keyof typeof PaytmHeadDialect];

/** `head.tokenType` of the subscription-service APIs. [prenotify] [fetch-status] [cancel] [pause] */
export const PAYTM_TOKEN_TYPE_AES = 'AES';

/** `head.channelId`. [init-sub] */
export const PaytmChannelId = {
  Web: 'WEB',
  Wap: 'WAP',
} as const;
export type PaytmChannelId = (typeof PaytmChannelId)[keyof typeof PaytmChannelId];

/** `body.requestType` of Initiate Subscription. [init-sub] */
export const PAYTM_REQUEST_TYPE_SUBSCRIPTION = 'NATIVE_SUBSCRIPTION';

/** `body.txnType` of the Refund API. [refund] */
export const PAYTM_TXN_TYPE_REFUND = 'REFUND';

/** The only currency. [init-sub] */
export const PAYTM_CURRENCY = 'INR';

/** `subscriptionAmountType`. [init-sub] */
export const PaytmAmountType = {
  /** Every cycle charges `renewalAmount`. */
  Fix: 'FIX',
  /** Every cycle is capped by `subscriptionMaxAmount`. */
  Variable: 'VARIABLE',
} as const;
export type PaytmAmountType = (typeof PaytmAmountType)[keyof typeof PaytmAmountType];

/** `subscriptionEnableRetry` ("1" enable, "0" otherwise). [init-sub] */
export const PaytmEnableRetry = {
  Enabled: '1',
  Disabled: '0',
} as const;
export type PaytmEnableRetry = (typeof PaytmEnableRetry)[keyof typeof PaytmEnableRetry];

/** `mandateType`: required when the Bank Mandate mode is used. Paper mandates need a separate integration. [init-sub] */
export const PaytmMandateType = {
  EMandate: 'E_MANDATE',
  PaperMandate: 'PAPER_MANDATE',
} as const;
export type PaytmMandateType = (typeof PaytmMandateType)[keyof typeof PaytmMandateType];

/** `enablePaymentMode[].mode`. [init-sub] */
export const PaytmPaymentModeName = {
  Balance: 'BALANCE',
  Ppbl: 'PPBL',
  Upi: 'UPI',
  CreditCard: 'CREDIT_CARD',
  DebitCard: 'DEBIT_CARD',
  BankMandate: 'BANK_MANDATE',
  PaytmDigitalCredit: 'PAYTM_DIGITAL_CREDIT',
} as const;
export type PaytmPaymentModeName = (typeof PaytmPaymentModeName)[keyof typeof PaytmPaymentModeName];

/** The Paytm payment modes each unified payment method is offered as. [init-sub enablePaymentMode] */
export const PAYTM_MODES_FOR_METHOD: Record<PaymentMethod, readonly PaytmPaymentModeName[]> = {
  [PaymentMethod.Upi]: [PaytmPaymentModeName.Upi],
  [PaymentMethod.Card]: [PaytmPaymentModeName.CreditCard, PaytmPaymentModeName.DebitCard],
  [PaymentMethod.ENach]: [PaytmPaymentModeName.BankMandate],
  /** Paper mandates are a separate form-download/upload integration this adapter does not implement. */
  [PaymentMethod.PhysicalNach]: [],
  /** Net banking and wallets are one-time payment methods; a subscription request for them is refused before this table is read. */
  [PaymentMethod.NetBanking]: [],
  [PaymentMethod.Wallet]: [],
};

/** The payment methods this adapter can authorise a mandate with. Paytm Wallet (`PPI`) has no unified value. [§11] */
export const PAYTM_PAYMENT_METHODS: readonly PaymentMethod[] = [PaymentMethod.Upi, PaymentMethod.Card, PaymentMethod.ENach];

// ---------------------------------------------------------------------------
// Frequency [§3.2, §7.1]
// ---------------------------------------------------------------------------

/**
 * `subscriptionFrequencyUnit`. Paytm's Initiate Subscription takes a unit and no multiplier (a `subscriptionFrequency`
 * field exists only in the separate AI Router product), so a bi-monthly cycle is its own unit. `Fortnight` and
 * `OnDemand` appear in responses only. [init-sub] [fetch-status] [list] [sub-faq]
 */
export const PaytmFrequencyUnit = {
  Day: 'DAY',
  Week: 'WEEK',
  Fortnight: 'FORTNIGHT',
  Month: 'MONTH',
  BiMonthly: 'BI_MONTHLY',
  Quarter: 'QUARTER',
  SemiAnnually: 'SEMI_ANNUALLY',
  Year: 'YEAR',
  OnDemand: 'ONDEMAND',
  OneTime: 'ONETIME',
  SingleBlockMultiDebitOnDemand: 'SBMD_ONDEMAND',
} as const;
export type PaytmFrequencyUnit = (typeof PaytmFrequencyUnit)[keyof typeof PaytmFrequencyUnit];

/** A cycle length as (unit, count); the units this adapter sends. */
export interface PaytmCycle {
  unit: IntervalUnit;
  count: number;
}

/**
 * The Paytm unit for each billing interval the library can express AND Paytm's request can name. An interval not
 * listed here (every 2 days, every 5 months, every 2 years) has no documented Paytm unit and is refused.
 */
export const PAYTM_FREQUENCY_FOR_INTERVAL: readonly { unit: IntervalUnit; count: number; frequency: PaytmFrequencyUnit }[] = [
  { unit: IntervalUnit.Day, count: 1, frequency: PaytmFrequencyUnit.Day },
  { unit: IntervalUnit.Week, count: 1, frequency: PaytmFrequencyUnit.Week },
  { unit: IntervalUnit.Month, count: 1, frequency: PaytmFrequencyUnit.Month },
  { unit: IntervalUnit.Month, count: 2, frequency: PaytmFrequencyUnit.BiMonthly },
  { unit: IntervalUnit.Month, count: 3, frequency: PaytmFrequencyUnit.Quarter },
  { unit: IntervalUnit.Month, count: 6, frequency: PaytmFrequencyUnit.SemiAnnually },
  { unit: IntervalUnit.Month, count: 12, frequency: PaytmFrequencyUnit.Year },
  { unit: IntervalUnit.Year, count: 1, frequency: PaytmFrequencyUnit.Year },
];

/** How a unit read back from Paytm is expressed as a billing interval before it is multiplied by `frequency`. */
export const PAYTM_INTERVAL_FOR_FREQUENCY: Partial<Record<PaytmFrequencyUnit, PaytmCycle>> = {
  [PaytmFrequencyUnit.Day]: { unit: IntervalUnit.Day, count: 1 },
  [PaytmFrequencyUnit.Week]: { unit: IntervalUnit.Week, count: 1 },
  [PaytmFrequencyUnit.Fortnight]: { unit: IntervalUnit.Week, count: 2 },
  [PaytmFrequencyUnit.Month]: { unit: IntervalUnit.Month, count: 1 },
  [PaytmFrequencyUnit.BiMonthly]: { unit: IntervalUnit.Month, count: 2 },
  [PaytmFrequencyUnit.Quarter]: { unit: IntervalUnit.Month, count: 3 },
  [PaytmFrequencyUnit.SemiAnnually]: { unit: IntervalUnit.Month, count: 6 },
  [PaytmFrequencyUnit.Year]: { unit: IntervalUnit.Year, count: 1 },
};

/**
 * The shortest calendar length, in days, of one cycle of each unit. "Grace days cannot be greater than the frequency set
 * against the subscription" (code 4001), so the grace days sent are capped by this. [init-sub]
 */
export const PAYTM_MIN_CYCLE_DAYS: Partial<Record<PaytmFrequencyUnit, number>> = {
  [PaytmFrequencyUnit.Day]: 1,
  [PaytmFrequencyUnit.Week]: 7,
  [PaytmFrequencyUnit.Fortnight]: 14,
  [PaytmFrequencyUnit.Month]: 28,
  [PaytmFrequencyUnit.BiMonthly]: 59,
  [PaytmFrequencyUnit.Quarter]: 89,
  [PaytmFrequencyUnit.SemiAnnually]: 181,
  [PaytmFrequencyUnit.Year]: 365,
};

/** UPI Autopay accepts these units only. [init-sub] */
export const PAYTM_UPI_FREQUENCIES: readonly PaytmFrequencyUnit[] = [
  PaytmFrequencyUnit.Week,
  PaytmFrequencyUnit.Month,
  PaytmFrequencyUnit.BiMonthly,
  PaytmFrequencyUnit.Quarter,
  PaytmFrequencyUnit.SemiAnnually,
  PaytmFrequencyUnit.Year,
  PaytmFrequencyUnit.OnDemand,
];

// ---------------------------------------------------------------------------
// Create-subscription defaults and limits
// ---------------------------------------------------------------------------

/** `orderId` and the Renew `orderId`: "alphanumeric and special characters allowed are @ - _ ." at most 50. [init-sub] [renew] */
export const PAYTM_ORDER_ID_MAX_LENGTH = 50;
export const PAYTM_ORDER_ID_PATTERN = /^[A-Za-z0-9@._-]+$/;

/** `userInfo.custId`: "Special characters allowed in CustId are @, !, =, _, $, .". [init-sub] */
export const PAYTM_CUST_ID_PATTERN = /^[A-Za-z0-9@!=_$.]+$/;
/** A `custId` derived from the order id keeps this prefix; the rest is a digest, so it never holds a character Paytm may refuse. */
export const PAYTM_DERIVED_CUST_ID_PREFIX = 'cust_';
export const PAYTM_DERIVED_CUST_ID_DIGEST_CHARS = 24;

/** `GENERATED_ORDER_ID_PREFIX` + 12 random bytes in hex: 28 characters. */
export const PAYTM_GENERATED_ORDER_ID_PREFIX = 'sub';
export const PAYTM_GENERATED_ORDER_ID_RANDOM_BYTES = 12;
export const PAYTM_ID_PART_SEPARATOR = '_';

/** A mandate without an end gets this many years: Paytm requires `subscriptionExpiryDate`. The docs' own sample uses a date five years out. [init-sub] */
export const PAYTM_DEFAULT_MANDATE_YEARS = 5;

/**
 * Days kept after the last due date of a merchant-collected plan with a cycle count, so that a failed last debit can still
 * be retried: "Payment collection request will not be allowed after the expiry date". [init-sub]
 */
export const PAYTM_MERCHANT_EXPIRY_BUFFER_DAYS = 3;
/** The same for a gateway-collected plan: Paytm debits on the date itself. */
export const PAYTM_GATEWAY_EXPIRY_BUFFER_DAYS = 1;

/**
 * Days after the first due date a renewal may still be sent, on top of the days between the start date and the first
 * debit: room for the scheduler's retries (24 hours apart, three attempts by default). [sub-bp] recommends 2.
 */
export const PAYTM_RETRY_GRACE_DAYS = 2;
/** Paytm's documented retry guidance for gateway-collected plans: `subscriptionGraceDays` 2 and `subscriptionRetryCount` 3. [sub-bp] [sub-faq] */
export const PAYTM_AUTO_RETRY_GRACE_DAYS = 2;
export const PAYTM_DEFAULT_RETRY_COUNT = 3;
/** "For Cards, maximum 3 grace days are supported". [init-sub] */
export const PAYTM_CARD_MAX_GRACE_DAYS = 3;

/** The reason Paytm shows the customer in the pre-debit notification ("1 to 50 characters"). [prenotify] */
export const PAYTM_DEFAULT_DEBIT_REASON = 'Subscription renewal';
export const PAYTM_DEBIT_REASON_MAX_LENGTH = 50;
/** `invoiceDisplayNo`: "alphanumeric, <= 15 chars". [prenotify] */
export const PAYTM_INVOICE_NUMBER_PATTERN = /^[A-Za-z0-9]{1,15}$/;
export const PAYTM_REFERENCE_ID_MAX_LENGTH = 50;

/** "Pipe character is not allowed" (1008): no request value may hold it. [init-sub] [codes-pdf] */
export const PAYTM_PIPE = '|';

/** The merchant key is the AES-128 key itself: exactly 16 bytes. [chk-src] */
export const PAYTM_MERCHANT_KEY_BYTES = 16;

/** The `mobile` Paytm takes: 10 digits. [init-sub] */
export const PAYTM_MOBILE_DIGITS = 10;
export const PAYTM_INDIA_COUNTRY_CODE = '91';

// ---------------------------------------------------------------------------
// Subscription states [§7.2]
// ---------------------------------------------------------------------------

/** `status` of a subscription (Fetch Status, the status webhook and the callbacks). The docs spell `AUTHORISED` two ways. */
export const PaytmSubscriptionStatus = {
  Init: 'INIT',
  InAuthorization: 'IN_AUTHORIZATION',
  Authorised: 'AUTHORISED',
  Authorized: 'AUTHORIZED',
  Confirmed: 'CONFIRMED',
  Active: 'ACTIVE',
  Suspended: 'SUSPENDED',
  Expired: 'EXPIRED',
  Reject: 'REJECT',
  Closed: 'CLOSED',
  AuthorizationFailed: 'AUTHORIZATION_FAILED',
} as const;
export type PaytmSubscriptionStatus = (typeof PaytmSubscriptionStatus)[keyof typeof PaytmSubscriptionStatus];

/**
 * Paytm status -> unified status. A status not listed degrades to `FALLBACK_SUBSCRIPTION_STATUS` and stays visible
 * verbatim in `providerStatus`.
 *
 * `REJECT` is "cancelled/rejected" and `CLOSED` is "closed due to incomplete authorization" [sub]; the brief maps CLOSED to
 * expired. `CONFIRMED` has no definition in the docs; like `IN_AUTHORIZATION` it is not yet `ACTIVE`, so it waits.
 */
export const SUBSCRIPTION_STATUS_MAP: Record<PaytmSubscriptionStatus, SubscriptionStatus> = {
  [PaytmSubscriptionStatus.Init]: SubscriptionStatus.Created,
  [PaytmSubscriptionStatus.InAuthorization]: SubscriptionStatus.PendingAuthorization,
  [PaytmSubscriptionStatus.Authorised]: SubscriptionStatus.PendingAuthorization,
  [PaytmSubscriptionStatus.Authorized]: SubscriptionStatus.PendingAuthorization,
  [PaytmSubscriptionStatus.Confirmed]: SubscriptionStatus.PendingAuthorization,
  [PaytmSubscriptionStatus.Active]: SubscriptionStatus.Active,
  [PaytmSubscriptionStatus.Suspended]: SubscriptionStatus.Paused,
  [PaytmSubscriptionStatus.Expired]: SubscriptionStatus.Expired,
  [PaytmSubscriptionStatus.Reject]: SubscriptionStatus.Cancelled,
  [PaytmSubscriptionStatus.Closed]: SubscriptionStatus.Expired,
  [PaytmSubscriptionStatus.AuthorizationFailed]: SubscriptionStatus.Failed,
};

/**
 * A status Paytm adds tomorrow is treated as "not yet live": the billing scheduler only starts on an active mandate and only
 * stops on a dead one, so an unknown state neither bills nor cancels anything.
 */
export const FALLBACK_SUBSCRIPTION_STATUS: SubscriptionStatus = SubscriptionStatus.PendingAuthorization;

/** `subStatus`: the one value that turns an `ACTIVE` status webhook into a resume. [fetch-status] */
export const PAYTM_SUBSTATUS_RESUMED = 'RESUMED';

/** `status` of Pause/Resume's request body. [pause] */
export const PaytmModifyStatus = {
  Active: 'ACTIVE',
  Suspended: 'SUSPENDED',
} as const;
export type PaytmModifyStatus = (typeof PaytmModifyStatus)[keyof typeof PaytmModifyStatus];

/** Subscription states that mean the mandate is over. */
export const PAYTM_ENDED_STATUSES: readonly SubscriptionStatus[] = [
  SubscriptionStatus.Cancelled,
  SubscriptionStatus.Expired,
  SubscriptionStatus.Failed,
];

// ---------------------------------------------------------------------------
// Payment modes [§7.1, §10]
// ---------------------------------------------------------------------------

/** Every spelling of a payment mode Paytm uses across Fetch Status, the callbacks and the status APIs. */
export const PaytmPaymentMode = {
  Upi: 'UPI',
  UpiIntent: 'UPI_INTENT',
  CreditCard: 'CC',
  CreditCardLong: 'CREDIT_CARD',
  DebitCard: 'DC',
  DebitCardLong: 'DEBIT_CARD',
  BankMandate: 'BANK_MANDATE',
  BankMandateCompact: 'BANKMANDATE',
  Wallet: 'PPI',
  Balance: 'BALANCE',
  Ppbl: 'PPBL',
  NetBanking: 'NB',
  PostpaidLong: 'PAYTM_DIGITAL_CREDIT',
} as const;
export type PaytmPaymentMode = (typeof PaytmPaymentMode)[keyof typeof PaytmPaymentMode];

/**
 * Paytm payment mode -> unified method. Paytm Wallet / balance / postpaid have no unified value and map to nothing.
 * Net banking (`NB`) is a one-off method in Paytm, not a mandate, and is left out too.
 */
export const PAYMENT_MODE_MAP: Record<string, PaymentMethod> = {
  [PaytmPaymentMode.Upi]: PaymentMethod.Upi,
  [PaytmPaymentMode.UpiIntent]: PaymentMethod.Upi,
  [PaytmPaymentMode.CreditCard]: PaymentMethod.Card,
  [PaytmPaymentMode.CreditCardLong]: PaymentMethod.Card,
  [PaytmPaymentMode.DebitCard]: PaymentMethod.Card,
  [PaytmPaymentMode.DebitCardLong]: PaymentMethod.Card,
  [PaytmPaymentMode.BankMandate]: PaymentMethod.ENach,
  [PaytmPaymentMode.BankMandateCompact]: PaymentMethod.ENach,
};

/** The modes that are a bank mandate: no pre-debit notification is sent for them and Paytm refunds none of their debits. [sub] [refund-mgmt] */
export const PAYTM_BANK_MANDATE_MODES: readonly string[] = [PaytmPaymentMode.BankMandate, PaytmPaymentMode.BankMandateCompact];

// ---------------------------------------------------------------------------
// Result codes [§1.6, §3.3, §6, §8, §9]
// ---------------------------------------------------------------------------

/** `resultStatus` of the Theia-style APIs, and `status` of the subscription-service ones. [init-sub] [renew] [fetch-status] */
export const PaytmResultStatus = {
  Success: 'S',
  Failure: 'F',
  Unknown: 'U',
} as const;

/** The statuses of an answer that did not succeed, in both of Paytm's spellings. */
export const PAYTM_FAILURE_STATUSES: readonly string[] = [PaytmResultStatus.Failure, 'FAILURE', PaytmResultStatus.Unknown];

/** `providerStatus` when Paytm's answer carries no status at all. */
export const PAYTM_PROVIDER_STATUS_UNKNOWN = 'UNKNOWN';

/** `resultStatus` of the Transaction Status and Refund APIs. [txn-status] [refund] */
export const PaytmTxnStatus = {
  Success: 'TXN_SUCCESS',
  Failure: 'TXN_FAILURE',
  Pending: 'PENDING',
  NoRecordFound: 'NO_RECORD_FOUND',
} as const;
export type PaytmTxnStatus = (typeof PaytmTxnStatus)[keyof typeof PaytmTxnStatus];

/** `status` of a debit webhook or callback. [wh-payment] */
export const PAYTM_CHARGE_STATUS_MAP: Record<string, ChargeStatus> = {
  [PaytmTxnStatus.Success]: ChargeStatus.Succeeded,
  [PaytmTxnStatus.Failure]: ChargeStatus.Failed,
  [PaytmTxnStatus.Pending]: ChargeStatus.Pending,
};

/**
 * A debit whose Paytm status is not listed is still in flight: treating an unknown answer as a failure would let the
 * scheduler start a second debit under a new id while the first may be live.
 */
export const FALLBACK_CHARGE_STATUS: ChargeStatus = ChargeStatus.Pending;

/** Success codes. */
export const PaytmSuccessCode = {
  Initiate: '0000',
  Renew: '900',
  /** Pre-Notify, Fetch Status, Pause/Resume. */
  SubscriptionService: '3006',
  Cancel: '200',
  /** Transaction Status success. */
  Transaction: '01',
} as const;

/** The result codes the adapter acts on by name. */
export const PaytmCode = {
  /** Pre-Notify: this reference id was already used, i.e. an earlier try of the same notification got through. [prenotify] */
  PreNotifyDuplicateReference: '3049',
  /** Pre-Notify: a notification for this debit was already sent (under another reference). [prenotify] */
  PreNotifyAlreadySent: '3046',
  /** Transaction Status: no such order. [txn-status] */
  TxnNoRecord: '331',
  TxnInvalidOrderId: '334',
  TxnInvalidMid: '335',
  TxnServerDown: '501',
} as const;

/** What a result code means in Paytm's reference pages, as an error code of this library. */
export type ErrorTable = Readonly<Record<string, ErrorCode>>;

/** Initiate Subscription. `resultStatus: U` ("System error") is `OUTCOME_UNKNOWN` whatever the code. [init-sub] */
export const INITIATE_ERRORS: ErrorTable = {
  '00000900': ErrorCode.Validation,
  '1007': ErrorCode.Validation,
  '1008': ErrorCode.Validation,
  '2004': ErrorCode.Validation,
  '2005': ErrorCode.Auth,
  '2007': ErrorCode.Validation,
  '2009': ErrorCode.Conflict,
  '2013': ErrorCode.Validation,
  '2014': ErrorCode.Validation,
  '2022': ErrorCode.Config,
  '2023': ErrorCode.Conflict,
  '4001': ErrorCode.Validation,
  '4004': ErrorCode.Validation,
  '4006': ErrorCode.Validation,
};

/**
 * Renew Subscription. A code that is not listed is `OUTCOME_UNKNOWN`: Paytm said "failed" without saying whether a
 * collection exists, and a debit may only be declared failed when Paytm says so by a code that proves it. [renew]
 */
export const RENEW_ERRORS: ErrorTable = {
  // A debit with this order id exists (or is being made): reconcile with getCharge, never retry.
  '325': ErrorCode.Conflict,
  '931': ErrorCode.Conflict,
  // The subscription collects by itself: the merchant may not renew it.
  '945': ErrorCode.Unsupported,
  '947': ErrorCode.Unsupported,
  // The request is wrong for this subscription.
  '905': ErrorCode.Validation,
  '913': ErrorCode.Validation,
  '929': ErrorCode.Validation,
  '1103': ErrorCode.Validation,
  '1105': ErrorCode.Validation,
  '1106': ErrorCode.Validation,
  // Pre-notify missing or not matched.
  '3054': ErrorCode.Validation,
  '901': ErrorCode.NotFound,
  '910': ErrorCode.Config,
  '919': ErrorCode.Config,
  '2005': ErrorCode.Auth,
  // Paytm refused the debit.
  '156': ErrorCode.ProviderError,
  '158': ErrorCode.ProviderError,
  '165': ErrorCode.ProviderError,
  '196': ErrorCode.ProviderError,
  '202': ErrorCode.ProviderError,
  '227': ErrorCode.ProviderError,
  '313': ErrorCode.ProviderError,
  '505': ErrorCode.ProviderError,
  '924': ErrorCode.ProviderError,
  '928': ErrorCode.ProviderError,
  '935': ErrorCode.ProviderError,
  // "System Error" / "Something wents down": it may have been processed.
  '501': ErrorCode.OutcomeUnknown,
  '1102': ErrorCode.OutcomeUnknown,
};
export const RENEW_UNLISTED_ERROR: ErrorCode = ErrorCode.OutcomeUnknown;

/** Pre-Notify. [prenotify] */
export const PRENOTIFY_ERRORS: ErrorTable = {
  '400': ErrorCode.Validation,
  '401': ErrorCode.Auth,
  '500': ErrorCode.ProviderUnavailable,
  '3000': ErrorCode.Config,
  '3004': ErrorCode.NotFound,
  '3005': ErrorCode.ProviderError,
  '3008': ErrorCode.Validation,
  '3047': ErrorCode.Validation,
  '3065': ErrorCode.ProviderUnavailable,
  'INT-4056': ErrorCode.ProviderError,
  'INT-6018': ErrorCode.Validation,
  'INT-6023': ErrorCode.ProviderError,
  'INT-6024': ErrorCode.Validation,
  'INT-1058': ErrorCode.ProviderError,
};

/** Fetch Subscription Status. [fetch-status] */
export const STATUS_ERRORS: ErrorTable = {
  '400': ErrorCode.Validation,
  '401': ErrorCode.Auth,
  '500': ErrorCode.ProviderUnavailable,
  '3004': ErrorCode.NotFound,
  '3005': ErrorCode.ProviderError,
  '3018': ErrorCode.Validation,
  '3045': ErrorCode.Validation,
};

/** Pause / Resume. [pause] */
export const MODIFY_ERRORS: ErrorTable = {
  '400': ErrorCode.Validation,
  '401': ErrorCode.Auth,
  '500': ErrorCode.ProviderUnavailable,
  '3004': ErrorCode.NotFound,
  '3005': ErrorCode.ProviderError,
};

/** Cancel. [cancel] */
export const CANCEL_ERRORS: ErrorTable = {
  '400': ErrorCode.Validation,
  '401': ErrorCode.Auth,
  '4001': ErrorCode.Validation,
  '3004': ErrorCode.NotFound,
};

/**
 * Transaction Status: a `TXN_FAILURE` that is not a failed debit. 334 and 331 say Paytm has no such order; 335 is a wrong
 * MID; 501 is "Server Down" (the sample page lists it under TXN_FAILURE). None of them may become a failed charge: the
 * scheduler would debit again under a new id. [txn-status]
 */
export const TXN_STATUS_ERRORS: ErrorTable = {
  [PaytmCode.TxnNoRecord]: ErrorCode.NotFound,
  [PaytmCode.TxnInvalidOrderId]: ErrorCode.NotFound,
  [PaytmCode.TxnInvalidMid]: ErrorCode.Config,
  [PaytmCode.TxnServerDown]: ErrorCode.ProviderUnavailable,
  '1001': ErrorCode.Validation,
  '9999': ErrorCode.ProviderUnavailable,
};

/**
 * Code 501 is "Server Down" on the Transaction Status page and "Your Payment has declined by your bank" in Paytm's generic
 * response-code list. A 501 whose message says the bank declined is a failed debit; any other 501 is an outage. [txn-status] [codes-pdf]
 */
export const PAYTM_DECLINED_MESSAGE_PATTERN = /declin/i;

/** Refund. A refund id is unique at Paytm, so repeating a refund is safe and an unlisted failure is a plain provider error. [refund] */
export const REFUND_ERRORS: ErrorTable = {
  '330': ErrorCode.Auth,
  '335': ErrorCode.Config,
  '600': ErrorCode.ProviderError,
  '607': ErrorCode.Validation,
  '617': ErrorCode.Conflict,
  '619': ErrorCode.Validation,
  '626': ErrorCode.Conflict,
  '627': ErrorCode.Validation,
  '629': ErrorCode.Conflict,
  '631': ErrorCode.NotFound,
  '635': ErrorCode.Validation,
  '636': ErrorCode.Validation,
  '640': ErrorCode.ProviderError,
  '654': ErrorCode.ProviderError,
  '655': ErrorCode.Unsupported,
  '656': ErrorCode.Validation,
  '657': ErrorCode.Unsupported,
  '658': ErrorCode.Unsupported,
  '659': ErrorCode.Validation,
  '661': ErrorCode.Unsupported,
  '670': ErrorCode.Validation,
  '671': ErrorCode.Conflict,
  '672': ErrorCode.ProviderError,
  '673': ErrorCode.NotFound,
  '674': ErrorCode.Validation,
  '676': ErrorCode.Validation,
  '678': ErrorCode.Unsupported,
};

// ---------------------------------------------------------------------------
// Responses we synthesise
// ---------------------------------------------------------------------------

/** `providerStatus` of a subscription that was just created: "it instantly moves to the INIT state". [sub] */
export const PAYTM_STATUS_CREATED = PaytmSubscriptionStatus.Init;

/** `providerStatus` of a pre-debit notification that was not needed (bank mandates) and so never sent. */
export const PAYTM_PRE_NOTIFY_NOT_REQUIRED = 'NOT_REQUIRED';
/** `providerStatus` of a pre-debit notification Paytm said it already holds. */
export const PAYTM_PRE_NOTIFY_ALREADY_SENT = 'ALREADY_SENT';

/** Pre-notify callback `NOTIFICATIONSTATUS`. [wh-prenotify] */
export const PaytmNotificationStatus = {
  Success: 'SUCCESS',
  Failure: 'FAILURE',
} as const;

// ---------------------------------------------------------------------------
// Webhooks and callbacks [§10]
// ---------------------------------------------------------------------------

/** The form-post field that carries the checksum; it is never part of what is signed. [chk-src] [chk-impl] */
export const PAYTM_CHECKSUM_FIELD = 'CHECKSUMHASH';
export const JSON_BODY_START = '{';

/** `status` of the JSON refund webhooks. [wh-accept-refund] [wh-success-refund] */
export const PaytmRefundWebhookStatus = {
  Success: 'SUCCESS',
  Failed: 'FAILED',
} as const;

/** `providerEventType` of the webhooks that carry no event name of their own. */
export const PaytmEventName = {
  SubscriptionStatus: 'SUBSCRIPTION_STATUS',
  Payment: 'PAYMENT_STATUS',
  PreNotify: 'PRE_NOTIFY_CALLBACK',
  RefundArn: 'REFUND_ARN',
  AcceptRefund: 'ACCEPT_REFUND',
  SuccessRefund: 'SUCCESS_REFUND',
} as const;

/** Event id prefixes and separator: the id is built from the content, never from the salted checksum. */
export const PAYTM_EVENT_ID_SEPARATOR = ':';

/** Subscription status webhook: unified event per Paytm status. `ACTIVE` with sub-status `RESUMED` is a resume. [wh-sub-status] */
export const SUBSCRIPTION_EVENT_MAP: Record<string, EventType> = {
  [PaytmSubscriptionStatus.Active]: EventType.SubscriptionActivated,
  [PaytmSubscriptionStatus.Suspended]: EventType.SubscriptionPaused,
  [PaytmSubscriptionStatus.Reject]: EventType.SubscriptionCancelled,
  [PaytmSubscriptionStatus.Expired]: EventType.SubscriptionExpired,
  [PaytmSubscriptionStatus.Closed]: EventType.SubscriptionExpired,
  [PaytmSubscriptionStatus.AuthorizationFailed]: EventType.SubscriptionAuthorizationFailed,
  [PaytmSubscriptionStatus.Authorized]: EventType.SubscriptionAuthorized,
  [PaytmSubscriptionStatus.Authorised]: EventType.SubscriptionAuthorized,
};

/** Debit webhook: unified event per Paytm status. */
export const PAYMENT_EVENT_MAP: Record<string, EventType> = {
  [PaytmTxnStatus.Success]: EventType.SubscriptionCharged,
  [PaytmTxnStatus.Failure]: EventType.SubscriptionChargeFailed,
};

// ---------------------------------------------------------------------------
// Date formats [§6.2, §7.1, §10]
// ---------------------------------------------------------------------------

/** `2026-11-17 10:30:00` and `2026-11-17 10:30:00.0`, Indian Standard Time. [fetch-status] [wh-payment] */
export const PAYTM_DATETIME_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.\d+)?$/;
/** `14/09/2020 11:37`. [wh-prenotify] */
export const PAYTM_SLASH_DATETIME_PATTERN = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/;
/** `06-11-2020`: the Pre-Notify debit date. [prenotify] */
export const PAYTM_DAY_MONTH_YEAR_SEPARATOR = '-';
export const IST_OFFSET_SUFFIX = '+05:30';
