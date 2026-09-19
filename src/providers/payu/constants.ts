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
 * PayU India (recurring payments / Standing Instructions) constants. Every
 * string that is sent to or received from PayU is named here; JSON field names
 * live in `schemas.ts`. Source tags are the fact sheet's: `[reference__x]` and
 * `[docs__x]` are the PayU doc pages, `[sdk:hasher.js]` is PayU's official Node
 * SDK, `[§n]` points into the fact sheet.
 *
 * PayU does not schedule recurring debits. The merchant registers a mandate
 * through a consent transaction (`_payment`, `si=1`), then per cycle calls the
 * pre-debit command and the recurring command on `postservice.php`.
 */

// ---------------------------------------------------------------------------
// Endpoints [§1.1]
// ---------------------------------------------------------------------------

/** Consent / registration form target. [reference__payment-consent-transaction-payu-hosted] */
export const PAYU_PAYMENT_URLS: Record<Environment, string> = {
  [Environment.Test]: 'https://test.payu.in/_payment',
  [Environment.Live]: 'https://secure.payu.in/_payment',
};

/**
 * Every command API (`pre_debit_SI`, `si_transaction`, `verify_payment`, mandate
 * status / revoke / modify, refunds). `form=2` asks for JSON answers.
 * [reference__subscriptions-pdn-rp] [reference__check-mandate-status-api] [sdk:payu.js]
 */
export const PAYU_API_URLS: Record<Environment, string> = {
  [Environment.Test]: 'https://test.payu.in/merchant/postservice.php?form=2',
  [Environment.Live]: 'https://info.payu.in/merchant/postservice.php?form=2',
};

// ---------------------------------------------------------------------------
// Consent transaction (`_payment`) [§2]
// ---------------------------------------------------------------------------

/** "This parameter must always needs to be passed as 7." [reference__payment-consent-transaction-payu-hosted] */
export const PAYU_API_VERSION = '7';

/** `si` = 1: payment consent transaction. "Without this parameter sent as 1, subscription cannot be set up." */
export const PAYU_SI_CONSENT = '1';

/** `free_trial` value. [reference__upi-consent-transaction-plan] [docs__cb-subscriptions-integration-non-seamless] */
export const PAYU_FREE_TRIAL_FLAG = '1';

/**
 * The amount PayU itself documents for a free-trial consent on cards and UPI:
 * "PayU adjusts the transaction amount as INR 2.00 for cards and UPI and
 * INR 0.00 for Net Banking irrespective of what amount is passed".
 * [reference__payment-consent-transaction-payu-hosted] [docs__internal-review-create-and-manage-plans]
 */
export const PAYU_FREE_TRIAL_CONSENT_PAISE = 200;

/** Names of the fields posted to `_payment`. */
export const PayUConsentField = {
  Key: 'key',
  Txnid: 'txnid',
  Amount: 'amount',
  Productinfo: 'productinfo',
  Firstname: 'firstname',
  Email: 'email',
  Phone: 'phone',
  Surl: 'surl',
  Furl: 'furl',
  ApiVersion: 'api_version',
  Si: 'si',
  SiDetails: 'si_details',
  FreeTrial: 'free_trial',
  Hash: 'hash',
} as const;
export type PayUConsentField = (typeof PayUConsentField)[keyof typeof PayUConsentField];

/**
 * How many `|` separate `udf5` from `si_details` in the consent request hash.
 *
 * PayU prints three different counts for the same formula [§2.1]:
 * 6 on the hosted, hosted-plan, merchant-hosted index, card-modify, cross-border
 * and S2S pages (and the generic hashing page, and PayU's own SDK for the
 * standard hash); 4 on the cards, cards-plan, UPI, UPI-plan and net-banking
 * guide pages; 5 on the net-banking-plan page.
 *
 * `SixPipes` is the default. If PayU's test environment rejects it with a hash
 * error, switch with `consentHashLayout` in the config: no code change needed.
 */
export const ConsentHashLayout = {
  /** `...udf5||||||si_details|salt` (default). */
  SixPipes: 'six_pipes',
  /** `...udf5||||si_details|salt` (cards, UPI and net-banking guide pages). */
  FourPipes: 'four_pipes',
  /** `...udf5|||||si_details|salt` (net-banking plan page). */
  FivePipes: 'five_pipes',
} as const;
export type ConsentHashLayout = (typeof ConsentHashLayout)[keyof typeof ConsentHashLayout];

export const DEFAULT_CONSENT_HASH_LAYOUT: ConsentHashLayout = ConsentHashLayout.SixPipes;

/** Pipes between `udf5` and `si_details` for each layout. */
export const CONSENT_HASH_PIPES_AFTER_UDF5: Record<ConsentHashLayout, number> = {
  [ConsentHashLayout.SixPipes]: 6,
  [ConsentHashLayout.FourPipes]: 4,
  [ConsentHashLayout.FivePipes]: 5,
};

/** Separator inside every PayU hash string. */
export const HASH_SEPARATOR = '|';

// ---------------------------------------------------------------------------
// Limits and allowed characters [§1.4]
// ---------------------------------------------------------------------------

/** "`Character limit`: 25" and must be unique. [reference__payment-consent-transaction-payu-hosted] */
export const TXNID_MAX_LENGTH = 25;
/**
 * The docs state no txnid charset; every sample uses letters, digits, `_` and
 * `-`. Restricted to these so a transaction id can never be altered by PayU
 * between the hash and the bank. ASSUMPTION.
 */
export const TXNID_PATTERN = /^[A-Za-z0-9_-]+$/;
export const PRODUCTINFO_MAX_LENGTH = 100;
export const FIRSTNAME_MAX_LENGTH = 60;
export const EMAIL_MAX_LENGTH = 50;
export const PHONE_MAX_LENGTH = 50;
/**
 * "If the merchant sends any other special characters, then they will be
 * automatically removed." Allowed: A-Z a-z 0-9 - _ @ / space .
 * The adapter removes the others itself so the hashed text equals what PayU
 * keeps. [reference__payment-consent-transaction-payu-hosted]
 */
export const PAYU_DISALLOWED_TEXT_CHARS = /[^A-Za-z0-9\-_@/ .]/g;

/** Prefix of a generated consent txnid: `sub_` + 20 hex characters = 24 characters. */
export const GENERATED_TXNID_PREFIX = 'sub';
export const GENERATED_TXNID_RANDOM_BYTES = 10;
export const GENERATED_REQUEST_ID_PREFIX = 'req';
export const GENERATED_REQUEST_ID_RANDOM_BYTES = 12;
export const ID_PART_SEPARATOR = '_';
/** Prefix of an invoice display number generated from a notification or charge id. */
export const INVOICE_NUMBER_PREFIX = 'INV';

/** Digits the adapter keeps from a phone number. India country code, 12-digit form. */
export const INDIA_COUNTRY_CODE = '91';
export const INDIAN_MOBILE_DIGITS = 10;

// ---------------------------------------------------------------------------
// si_details [§3]
// ---------------------------------------------------------------------------

export const PayUBillingCycle = {
  Once: 'ONCE',
  Adhoc: 'ADHOC',
  Daily: 'DAILY',
  Weekly: 'WEEKLY',
  Monthly: 'MONTHLY',
  Yearly: 'YEARLY',
} as const;
export type PayUBillingCycle = (typeof PayUBillingCycle)[keyof typeof PayUBillingCycle];

/** [reference__si-parameter-json-details] [docs__plans]: quarterly is MONTHLY with interval 3. */
export const BILLING_CYCLE_BY_UNIT: Record<IntervalUnit, PayUBillingCycle> = {
  [IntervalUnit.Day]: PayUBillingCycle.Daily,
  [IntervalUnit.Week]: PayUBillingCycle.Weekly,
  [IntervalUnit.Month]: PayUBillingCycle.Monthly,
  [IntervalUnit.Year]: PayUBillingCycle.Yearly,
};

/** "This field must be passed as "INR"." [reference__si-parameter-json-details] */
export const PAYU_BILLING_CURRENCY = 'INR';

/** `paymentStartDate` / `paymentEndDate` / `debitDate` format. */
export const PAYU_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A mandate with neither `mandateEndsAt` nor `totalCycles` ends this many years
 * after its first debit. The docs give no maximum except the card's expiry
 * (cards), 40 years (eNACH) and a 2099 sample. ASSUMPTION.
 */
export const DEFAULT_MANDATE_HORIZON_YEARS = 5;

/**
 * When the end date is derived from `totalCycles`, it lies this many days after
 * the last scheduled debit, so a retried last debit is not refused as "after
 * the mandate ended". ASSUMPTION.
 */
export const MANDATE_END_GRACE_DAYS = 7;

/** UPI mandates are capped at INR 15,000 per debit (paise). [reference__si-parameter-json-details] */
export const UPI_MAX_BILLING_PAISE = 1_500_000;

// ---------------------------------------------------------------------------
// Payment methods and the composite subscription id [§7.1]
// ---------------------------------------------------------------------------

/** Methods a PayU mandate can have. Physical NACH is not part of PayU's SI flow. */
export const PAYU_MANDATE_METHODS = [PaymentMethod.Card, PaymentMethod.Upi, PaymentMethod.ENach] as const;
export type PayUMandateMethod = (typeof PAYU_MANDATE_METHODS)[number];

/** Separator in a composite subscription id: `<method>:<mihpayid>`. */
export const SUBSCRIPTION_ID_SEPARATOR = ':';
/** Characters a PayU mandate id may contain (`mihpayid` is numeric in every sample). */
export const MANDATE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** `mode` of a consent response. [reference__payment-consent-transaction-payu-hosted] [reference__upi-recurring-payment-consent-transaction] */
export const PayUPaymentMode = {
  CreditCard: 'CC',
  DebitCard: 'DC',
  Upi: 'UPI',
  ENach: 'ENACH',
  /** `verify_si_payment` / recurring debits. */
  StandingInstruction: 'SI',
} as const;
export type PayUPaymentMode = (typeof PayUPaymentMode)[keyof typeof PayUPaymentMode];

export const PAYMENT_METHOD_BY_MODE: Record<string, PayUMandateMethod> = {
  [PayUPaymentMode.CreditCard]: PaymentMethod.Card,
  [PayUPaymentMode.DebitCard]: PaymentMethod.Card,
  [PayUPaymentMode.Upi]: PaymentMethod.Upi,
  [PayUPaymentMode.ENach]: PaymentMethod.ENach,
};

/** `PG_TYPE` fallback when `mode` is missing. [reference__payment-consent-transaction-payu-hosted] */
export const PayUPgType = {
  CreditCard: 'CC-PG',
  DebitCard: 'DC-PG',
  Upi: 'UPI-PG',
  ENach: 'ENACH-PG',
  StandingInstruction: 'SI-PG',
} as const;
export type PayUPgType = (typeof PayUPgType)[keyof typeof PayUPgType];

export const PAYMENT_METHOD_BY_PG_TYPE: Record<string, PayUMandateMethod> = {
  [PayUPgType.CreditCard]: PaymentMethod.Card,
  [PayUPgType.DebitCard]: PaymentMethod.Card,
  [PayUPgType.Upi]: PaymentMethod.Upi,
  [PayUPgType.ENach]: PaymentMethod.ENach,
};

/** Methods whose mandate is not usable the moment the customer finishes (bank registers it later). [§12.3.11] */
export const ASYNC_REGISTRATION_METHODS: readonly PaymentMethod[] = [PaymentMethod.ENach];

/** Methods for which PayU wants a pre-debit notification. "eNACH does not require a pre-debit notification." [§5.1] */
export const PRE_DEBIT_METHODS: readonly PaymentMethod[] = [PaymentMethod.Card, PaymentMethod.Upi];

// ---------------------------------------------------------------------------
// Consent response outcome [§2.3]
// ---------------------------------------------------------------------------

/** `status` of a `_payment` response. "Treat only `success` as successful." */
export const PayUPaymentStatus = {
  Success: 'success',
  Failure: 'failure',
  Pending: 'pending',
} as const;
export type PayUPaymentStatus = (typeof PayUPaymentStatus)[keyof typeof PayUPaymentStatus];

/**
 * `payment_source`: `sist` = a standing instruction was registered with this
 * transaction, `payu` = an ordinary payment (no mandate), `sirecurring` = a
 * recurring debit. [reference__payment-consent-transaction-payu-hosted] [reference__verify-si-payment-status]
 */
export const PayUPaymentSource = {
  MandateRegistered: 'sist',
  Ordinary: 'payu',
  RecurringDebit: 'sirecurring',
} as const;
export type PayUPaymentSource = (typeof PayUPaymentSource)[keyof typeof PayUPaymentSource];

// ---------------------------------------------------------------------------
// Postservice commands [§5-7, §11]
// ---------------------------------------------------------------------------

export const PayUCommand = {
  PreDebit: 'pre_debit_SI',
  SiTransaction: 'si_transaction',
  VerifyPayment: 'verify_payment',
  CheckMandateStatus: 'check_mandate_status',
  NbMandateStatus: 'NB_mandate_status',
  UpiMandateStatus: 'upi_mandate_status',
  MandateRevoke: 'mandate_revoke',
  UpiMandateRevoke: 'upi_mandate_revoke',
  UpiMandateModify: 'upi_mandate_modify',
  RefundTransaction: 'cancel_refund_transaction',
} as const;
export type PayUCommand = (typeof PayUCommand)[keyof typeof PayUCommand];

/** Form fields of a postservice request. `var2`/`var3`/`var9` only for the refund command. */
export const PayUCommandField = {
  Key: 'key',
  Command: 'command',
  Var1: 'var1',
  Var2: 'var2',
  Var3: 'var3',
  Var9: 'var9',
  Hash: 'hash',
} as const;
export type PayUCommandField = (typeof PayUCommandField)[keyof typeof PayUCommandField];

/** Mandate status command per payment method. */
export const MANDATE_STATUS_COMMAND: Record<PayUMandateMethod, PayUCommand> = {
  [PaymentMethod.Card]: PayUCommand.CheckMandateStatus,
  [PaymentMethod.ENach]: PayUCommand.NbMandateStatus,
  [PaymentMethod.Upi]: PayUCommand.UpiMandateStatus,
};

/** Revoke command per payment method. Cards and eNACH share `mandate_revoke`. */
export const MANDATE_REVOKE_COMMAND: Record<PayUMandateMethod, PayUCommand> = {
  [PaymentMethod.Card]: PayUCommand.MandateRevoke,
  [PaymentMethod.ENach]: PayUCommand.MandateRevoke,
  [PaymentMethod.Upi]: PayUCommand.UpiMandateRevoke,
};

/** Envelope `status` of a successful postservice command. */
export const PAYU_STATUS_OK = 1;
export const PAYU_STATUS_FAILED = 0;

/** `pre_debit_SI` answers with a bank/NPCI code string when the bank declines. [§5.5] */
export const PayUPreDebitCode = {
  /** "Predebit notification already sent for the mandate sequence no." */
  Duplicate: 'E9254',
} as const;
export type PayUPreDebitCode = (typeof PayUPreDebitCode)[keyof typeof PayUPreDebitCode];

/** `providerStatus` of a pre-debit notification that was not sent because the method does not need one. */
export const PAYU_PRE_DEBIT_NOT_REQUIRED = 'not_required';

/** `providerStatus` of a consent that has been prepared but not yet posted by the customer. */
export const PAYU_CONSENT_CREATED = 'consent_created';

// ---------------------------------------------------------------------------
// Mandate status -> SubscriptionStatus [§8.2]
// ---------------------------------------------------------------------------

/** Cards: `check_mandate_status`. [reference__check-mandate-status-api] */
export const PayUCardMandateStatus = {
  Active: 'active',
  Cancelled: 'cancelled',
  Discarded: 'discarded',
  Deleted: 'deleted',
  Failed: 'failed',
  Expired: 'expired',
  Paused: 'paused',
} as const;
export type PayUCardMandateStatus = (typeof PayUCardMandateStatus)[keyof typeof PayUCardMandateStatus];

export const CARD_MANDATE_STATUS: Record<PayUCardMandateStatus, SubscriptionStatus> = {
  [PayUCardMandateStatus.Active]: SubscriptionStatus.Active,
  [PayUCardMandateStatus.Cancelled]: SubscriptionStatus.Cancelled,
  [PayUCardMandateStatus.Discarded]: SubscriptionStatus.Cancelled,
  [PayUCardMandateStatus.Deleted]: SubscriptionStatus.Cancelled,
  [PayUCardMandateStatus.Failed]: SubscriptionStatus.Failed,
  [PayUCardMandateStatus.Expired]: SubscriptionStatus.Expired,
  [PayUCardMandateStatus.Paused]: SubscriptionStatus.Paused,
};

/** eNACH: `NB_mandate_status`. The docs give no meanings, only the sample "SUCCESS = Mandate is active". [reference__net_banking_mandate_status_api] */
export const PayUEnachMandateStatus = {
  Initiated: 'INITIATED',
  Success: 'SUCCESS',
  Failed: 'FAILED',
  CancelInitiated: 'CANCEL_INITIATED',
  CancelPending: 'CANCEL_PENDING',
  CancelSuccess: 'CANCEL_SUCCESS',
  CancelFailed: 'CANCEL_FAILED',
  CancelInitiationFailed: 'CANCEL_INITIATION_FAILED',
} as const;
export type PayUEnachMandateStatus = (typeof PayUEnachMandateStatus)[keyof typeof PayUEnachMandateStatus];

/**
 * A cancellation that is initiated or pending counts as cancelled (PayU marks
 * the mandate inactive: "Mandate is not active" on pre-debit); a cancellation
 * that failed leaves the mandate live. ASSUMPTION.
 */
export const ENACH_MANDATE_STATUS: Record<PayUEnachMandateStatus, SubscriptionStatus> = {
  [PayUEnachMandateStatus.Initiated]: SubscriptionStatus.PendingAuthorization,
  [PayUEnachMandateStatus.Success]: SubscriptionStatus.Active,
  [PayUEnachMandateStatus.Failed]: SubscriptionStatus.Failed,
  [PayUEnachMandateStatus.CancelInitiated]: SubscriptionStatus.Cancelled,
  [PayUEnachMandateStatus.CancelPending]: SubscriptionStatus.Cancelled,
  [PayUEnachMandateStatus.CancelSuccess]: SubscriptionStatus.Cancelled,
  [PayUEnachMandateStatus.CancelFailed]: SubscriptionStatus.Active,
  [PayUEnachMandateStatus.CancelInitiationFailed]: SubscriptionStatus.Active,
};

/** UPI: `upi_mandate_status` (the page lists no values) and the UPI webhook. [reference__modify-the-recurring-payment-for-upi] */
export const PayUUpiMandateStatus = {
  Active: 'active',
  Revoked: 'revoked',
  Pause: 'pause',
  Paused: 'paused',
  Unpause: 'unpause',
} as const;
export type PayUUpiMandateStatus = (typeof PayUUpiMandateStatus)[keyof typeof PayUUpiMandateStatus];

export const UPI_MANDATE_STATUS: Record<PayUUpiMandateStatus, SubscriptionStatus> = {
  [PayUUpiMandateStatus.Active]: SubscriptionStatus.Active,
  [PayUUpiMandateStatus.Revoked]: SubscriptionStatus.Cancelled,
  [PayUUpiMandateStatus.Pause]: SubscriptionStatus.Paused,
  [PayUUpiMandateStatus.Paused]: SubscriptionStatus.Paused,
  [PayUUpiMandateStatus.Unpause]: SubscriptionStatus.Active,
};

/**
 * A mandate status this adapter does not know is not reported as `active`: the
 * mandate is not confirmed live, so it is `pending_authorization` and the
 * verbatim status stays in `providerStatus`.
 */
export const UNKNOWN_MANDATE_STATUS: SubscriptionStatus = SubscriptionStatus.PendingAuthorization;

// ---------------------------------------------------------------------------
// Payment / debit state -> ChargeStatus [§6.5, §8.1, §8.4]
// ---------------------------------------------------------------------------

/**
 * Every transaction state PayU prints, in `unmappedstatus` (payment API),
 * `status` (verify APIs) and the inner `status` of `si_transaction`. Keys are
 * compared case-insensitively with `-` read as a space.
 *
 * - `auth` is authorised but not captured: still pending.
 * - `autoRefund` is a debit PayU already refunded: failed, never "refunded",
 *   because the scheduler counts a refunded charge as collected.
 * - `userCancelled` / `cancelled`: cancelled.
 */
export const PayUTransactionState = {
  Captured: 'captured',
  Success: 'success',
  Auth: 'auth',
  Pending: 'pending',
  InProgress: 'in progress',
  Initiated: 'initiated',
  Failed: 'failed',
  Failure: 'failure',
  Bounced: 'bounced',
  Dropped: 'dropped',
  AutoRefund: 'autorefund',
  UserCancelled: 'usercancelled',
  Cancelled: 'cancelled',
} as const;
export type PayUTransactionState = (typeof PayUTransactionState)[keyof typeof PayUTransactionState];

export const CHARGE_STATUS_BY_STATE: Record<PayUTransactionState, ChargeStatus> = {
  [PayUTransactionState.Captured]: ChargeStatus.Succeeded,
  [PayUTransactionState.Success]: ChargeStatus.Succeeded,
  [PayUTransactionState.Auth]: ChargeStatus.Pending,
  [PayUTransactionState.Pending]: ChargeStatus.Pending,
  [PayUTransactionState.InProgress]: ChargeStatus.Pending,
  [PayUTransactionState.Initiated]: ChargeStatus.Pending,
  [PayUTransactionState.Failed]: ChargeStatus.Failed,
  [PayUTransactionState.Failure]: ChargeStatus.Failed,
  [PayUTransactionState.Bounced]: ChargeStatus.Failed,
  [PayUTransactionState.Dropped]: ChargeStatus.Failed,
  [PayUTransactionState.AutoRefund]: ChargeStatus.Failed,
  [PayUTransactionState.UserCancelled]: ChargeStatus.Cancelled,
  [PayUTransactionState.Cancelled]: ChargeStatus.Cancelled,
};

/**
 * A debit state this adapter does not know is `pending`, not failed: the
 * scheduler keeps asking `getCharge` instead of debiting the customer again.
 */
export const UNKNOWN_CHARGE_STATUS: ChargeStatus = ChargeStatus.Pending;

/** A blank inner `status` in an `si_transaction` answer "must be treated as a failed transaction". [§6.5] */
export const BLANK_DEBIT_STATUS: ChargeStatus = ChargeStatus.Failed;

/** `transaction_details[txnid].status` / `.mihpayid` when PayU has no such transaction. [reference__verify_payment_api] */
export const PAYU_NOT_FOUND = 'Not Found';
/** "0 out of 1 Transactions Fetched Successfully". */
export const PAYU_NONE_FETCHED_PATTERN = /^\s*0 out of \d+ transactions? fetched/i;

// ---------------------------------------------------------------------------
// Refunds [§11]
// ---------------------------------------------------------------------------

/** `error_code` of `cancel_refund_transaction`. "102 should be treated as success; the rest are failures." [reference__error-codes-for-refund-initiation] */
export const PayURefundCode = {
  Success: '100',
  Pending: '101',
  Queued: '102',
  InvalidAmount: '105',
  TokenExists: '106',
  InvalidTransactionStatus: '111',
  TransactionNotFound: '116',
  AmountMismatch: '117',
  PartialNotAllowed: '128',
  DuplicateAmountWindow: '214',
  SameAmountAndToken: '227',
  NotSupported: '232',
  NotPossible: '236',
  TokenTooLong: '255',
} as const;
export type PayURefundCode = (typeof PayURefundCode)[keyof typeof PayURefundCode];

/** Refund errors that map to a more specific code than PROVIDER_ERROR. */
export const REFUND_ERROR_CODES: Record<string, ErrorCode> = {
  [PayURefundCode.InvalidAmount]: ErrorCode.Validation,
  [PayURefundCode.AmountMismatch]: ErrorCode.Validation,
  [PayURefundCode.TokenTooLong]: ErrorCode.Validation,
  [PayURefundCode.PartialNotAllowed]: ErrorCode.Validation,
  [PayURefundCode.TokenExists]: ErrorCode.Conflict,
  [PayURefundCode.DuplicateAmountWindow]: ErrorCode.Conflict,
  [PayURefundCode.SameAmountAndToken]: ErrorCode.Conflict,
  [PayURefundCode.InvalidTransactionStatus]: ErrorCode.Conflict,
  [PayURefundCode.TransactionNotFound]: ErrorCode.NotFound,
  [PayURefundCode.NotSupported]: ErrorCode.Unsupported,
  [PayURefundCode.NotPossible]: ErrorCode.Unsupported,
};

/** "Capture is done today, please check for refund status tomorrow": status 1 but nothing was queued. */
export const REFUND_CAPTURED_TODAY_PATTERN = /capture is done today/i;

/** "Token ID length should not be greater than 23 characters". [reference__refund_transaction_api] */
export const REFUND_TOKEN_MAX_LENGTH = 23;
/** `var9` remarks: max 1024 characters, none of `# $ % ^ & * + = [ ] \ ' ; / { } : < > ? ~`. */
export const REFUND_REMARKS_MAX_LENGTH = 1024;
export const REFUND_REMARKS_DISALLOWED_CHARS = /[#$%^&*+=[\]\\';/{}:<>?~]/g;

// ---------------------------------------------------------------------------
// Body-level errors on HTTP 200 [§1.6]
// ---------------------------------------------------------------------------

/**
 * PayU answers most failures with HTTP 200 and a body such as
 * `{"status":0,"message":"authPayuId is mandatory"}`. These rules classify the
 * documented messages; the first match wins. `null` means "the outcome is
 * unclear" (an internal error): the caller decides between a retryable error
 * (reads) and `OUTCOME_UNKNOWN` (money-moving writes).
 */
export const BODY_ERROR_RULES: readonly { pattern: RegExp; code: ErrorCode | null }[] = [
  { pattern: /invalid hash/i, code: ErrorCode.Auth },
  { pattern: /not authori[sz]ed to use/i, code: ErrorCode.Auth },
  { pattern: /internal[_ ]error/i, code: null },
  { pattern: /not found|not exist|SI is not valid|Consent is Not Mandated/i, code: ErrorCode.NotFound },
  {
    pattern: /is mandatory|missing mandatory|required to update|invalid data|invalid value|invalid country|invalid txnId/i,
    code: ErrorCode.Validation,
  },
  {
    pattern: /not active|not in appropriate state|already revoked|already sent|already used|revoke request rejected|has been revoked/i,
    code: ErrorCode.Conflict,
  },
];

/** `errorCode` values that are more precise than the message. [reference__check-mandate-status-api] */
export const BODY_ERROR_CODES: Record<string, ErrorCode | null> = {
  /** "SI is not valid". */
  ER0816: ErrorCode.NotFound,
  /** "INTERNAL_ERROR". */
  ER1002: null,
};

/** Envelope `status` values that mean the call failed. 422 appears with `errorCode`. */
export const PAYU_FAILED_STATUS_VALUES: readonly (string | number)[] = [0, '0', 422, '422'];

// ---------------------------------------------------------------------------
// Webhooks [§10]
// ---------------------------------------------------------------------------

/** Names for `providerEventType` where PayU sends no event name of its own (payment webhooks). */
export const PayUPaymentWebhookEvent = {
  Successful: 'Successful',
  Failed: 'Failed',
  Pending: 'Pending',
} as const;
export type PayUPaymentWebhookEvent = (typeof PayUPaymentWebhookEvent)[keyof typeof PayUPaymentWebhookEvent];

/** Card mandate events from the issuer. [reference__set-up-webhook-to-receive-cancellation-or-modification-update-from-the-issuer-bank] */
export const PayUMandateNotification = {
  Modification: 'MANDATE_MODIFICATION',
  Cancellation: 'MANDATE_CANCELLATION',
  /** The delete sample uses this value, the table says `MANDATE_CANCELLATION`. */
  Deletion: 'MANDATE_DELETION',
  CancellationTokenDeletion: 'MANDATE_CANCELLATION_TOKEN_DELETION',
} as const;
export type PayUMandateNotification = (typeof PayUMandateNotification)[keyof typeof PayUMandateNotification];

export const EVENT_BY_MANDATE_NOTIFICATION: Record<PayUMandateNotification, EventType> = {
  [PayUMandateNotification.Modification]: EventType.SubscriptionUpdated,
  [PayUMandateNotification.Cancellation]: EventType.SubscriptionCancelled,
  [PayUMandateNotification.Deletion]: EventType.SubscriptionCancelled,
  [PayUMandateNotification.CancellationTokenDeletion]: EventType.SubscriptionCancelled,
};

/** UPI mandate events initiated by the customer in their PSP app. */
export const PayUUpiMandateAction = {
  Pause: 'MANDATE_PAUSE',
  Unpause: 'MANDATE_UNPAUSE',
  Revoke: 'MANDATE_REVOKE',
} as const;
export type PayUUpiMandateAction = (typeof PayUUpiMandateAction)[keyof typeof PayUUpiMandateAction];

export const EVENT_BY_UPI_ACTION: Record<PayUUpiMandateAction, EventType> = {
  [PayUUpiMandateAction.Pause]: EventType.SubscriptionPaused,
  [PayUUpiMandateAction.Unpause]: EventType.SubscriptionResumed,
  [PayUUpiMandateAction.Revoke]: EventType.SubscriptionCancelled,
};

/** The eNACH cancellation webhook (unsigned). [reference__set-up-webhook-to-receive-cancellation-or-modification-update-from-the-issuer-bank] */
export const PAYU_ENACH_CANCELLATION_NOTIFICATION = PayUMandateNotification.Cancellation;
export const PAYU_ENACH_CANCELLATION_STATUS = PayUEnachMandateStatus.CancelSuccess;

/** `action` of a refund webhook. [reference__refund-status-callback] */
export const PAYU_REFUND_ACTION = 'refund';
/** Refund callback `status`. */
export const PayUWebhookRefundStatus = {
  Success: 'success',
  Failure: 'failure',
} as const;
export type PayUWebhookRefundStatus = (typeof PayUWebhookRefundStatus)[keyof typeof PayUWebhookRefundStatus];

/** Kinds of PayU webhook body this adapter recognises (`providerEventType` for Unknown events). */
export const PayUWebhookKind = {
  Payment: 'payment',
  CardMandate: 'card_mandate',
  UpiMandate: 'upi_mandate',
  EnachCancellation: 'enach_cancellation',
  Refund: 'refund',
} as const;
export type PayUWebhookKind = (typeof PayUWebhookKind)[keyof typeof PayUWebhookKind];

/** The first character of a JSON webhook body. */
export const JSON_BODY_START = '{';

/** The unsigned webhook kinds, which are only normalised when `acceptUnsignedWebhooks` is set. */
export const UNSIGNED_WEBHOOK_KINDS: readonly PayUWebhookKind[] = [PayUWebhookKind.EnachCancellation, PayUWebhookKind.Refund];

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------

/** PayU timestamps ("addedon", "dateTime") are "IST, YYYY-MM-DD HH:MM:SS". [reference__authorization] */
export const IST_TIMESTAMP_PATTERN = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/;
export const IST_OFFSET_SUFFIX = '+05:30';
