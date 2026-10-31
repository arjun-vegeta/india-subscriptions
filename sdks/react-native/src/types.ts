/**
 * A string union that stays open: the listed values are the ones this version knows, and any other string a newer
 * server or native SDK sends is still a valid value. Compare with `===` against the known values.
 */
export type OpenString<Known extends string> = Known | (string & {});

export type Platform = OpenString<'ios' | 'android' | 'web'>;
export type Provider = OpenString<
  | 'app_store'
  | 'google_play'
  | 'razorpay'
  | 'cashfree'
  | 'payu'
  | 'phonepe'
  | 'paytm'
>;
export type ChannelPolicy = OpenString<'store' | 'user_choice' | 'gateways'>;
export type SalesChannel = OpenString<'store' | 'gateway'>;
export type ProductKind = OpenString<'subscription' | 'one_time'>;
export type SessionStatus = OpenString<
  'open' | 'awaiting_payment' | 'completed' | 'failed' | 'expired'
>;
export type EntitlementStatus = OpenString<
  | 'active'
  | 'trialing'
  | 'past_due'
  | 'paused'
  | 'halted'
  | 'cancelled'
  | 'expired'
  | 'refunded'
>;
export type AttemptOutcome = OpenString<'created' | 'failed'>;

/** A customer: identity and contact details. */
export interface Customer {
  id?: string;
  name?: string;
  email?: string;
  /** Mobile number; 10 digits or E.164. */
  phone?: string;
  /** The customer's state or union territory in India, for example "Karnataka". */
  state?: string;
}

/** What the device must do to pay. Only the `kind` is certain; the other fields depend on it. */
export interface CheckoutInstruction {
  kind: OpenString<'apple_storekit' | 'google_play_billing'>;
  /** The App Store Connect or Play Console product id (store checkouts). */
  productId?: string;
  /** `apple_storekit`: the account token the purchase is tied to. */
  appAccountToken?: string;
  /** `google_play_billing`: subscription or one-time product. */
  productKind?: ProductKind;
  basePlanId?: string;
  offerId?: string;
  /** `google_play_billing`: whether Google's choice screen is shown. */
  userChoiceBilling?: boolean;
}

/** One way the customer can pay for a session. */
export interface PurchaseOption {
  channel: SalesChannel;
  provider: Provider;
  checkout: CheckoutInstruction;
  handle: string;
  /** The hosted checkout page of a gateway option. */
  hostedUrl?: string;
}

export interface PurchaseAttempt {
  provider: Provider;
  outcome: AttemptOutcome;
  /** ISO-8601. */
  at: string;
  errorCode?: string;
  message?: string;
}

/** A purchase in progress or done: where the customer may pay and how it ended. */
export interface PurchaseSession {
  id: string;
  platform: Platform;
  /** The key of the product. */
  product: string;
  policy: ChannelPolicy;
  status: SessionStatus;
  customerRef: string;
  reference?: string;
  /** Android: the return link the session was started with. */
  returnUrl?: string;
  options: PurchaseOption[];
  attempts: PurchaseAttempt[];
  externalTransactionToken?: string;
  /** ISO-8601. */
  createdAt: string;
  /** ISO-8601. */
  expiresAt: string;
  /** ISO-8601. */
  completedAt?: string;
  subscriptionId?: string;
  paymentId?: string;
  provider?: Provider;
}

/** Why a purchase did not finish with the backend. */
export interface PurchaseFailure {
  reason: OpenString<
    | 'backendUnreachable'
    | 'backendFailing'
    | 'backendRefused'
    | 'notPaid'
    | 'notSettled'
    | 'gaveUp'
    | 'tokenMismatch'
    | 'checkoutUnavailable'
  >;
  /** The server's error code, when the backend answered with one. */
  code?: string;
  message: string;
}

/** Android: why Google Play did not take the purchase. Nothing was charged. */
export interface BillingFailure {
  reason: OpenString<
    | 'userCanceled'
    | 'billingUnavailable'
    | 'serviceUnavailable'
    | 'serviceDisconnected'
    | 'networkError'
    | 'itemUnavailable'
    | 'itemAlreadyOwned'
    | 'itemNotOwned'
    | 'featureNotSupported'
    | 'developerError'
    | 'error'
    | 'unknown'
  >;
  /** The `BillingResponseCode` Google returned. */
  responseCode: number;
  subResponseCode?: number;
  /** Google's debug message. Not for display to customers. */
  message: string;
}

/**
 * A value the installed native SDK produced that this version of the library does not know. `name` is the raw name the
 * native side used and `raw` is the untouched payload. Treat it as "something happened": read the entitlements.
 */
export interface Unknown {
  type: 'unknown';
  name: string;
  raw: unknown;
}

/** What happened to a purchase the app started with `purchase`. */
export type PurchaseOutcome =
  | { type: 'completed'; session: PurchaseSession }
  | { type: 'pending'; session: PurchaseSession }
  /** The customer closed the purchase screen. Android includes the session; iOS does not. */
  | { type: 'cancelled'; session?: PurchaseSession }
  /** iOS: StoreKit could not verify the transaction. Nothing was sent. */
  | { type: 'unverified'; session: PurchaseSession; reason: string }
  | {
      type: 'awaitingBackend';
      session: PurchaseSession;
      failure: PurchaseFailure;
    }
  | { type: 'rejected'; session: PurchaseSession; failure: PurchaseFailure }
  /** Android: a hosted checkout is open; pass the return link to `handleReturnLink`. */
  | { type: 'awaitingReturn'; session: PurchaseSession }
  /** Android: Google Play did not take the purchase. */
  | { type: 'failed'; session: PurchaseSession; failure: BillingFailure }
  | Unknown;

/** A purchase that moved without the app asking for it in a `purchase` call. */
export type PurchaseEvent =
  | {
      type: 'completed';
      session: PurchaseSession;
      /** iOS: the StoreKit transaction id (a decimal string). */
      transactionId?: string;
      /** Android: the Play purchase token; absent for a hosted checkout. */
      purchaseToken?: string;
    }
  /** Android: Google Play reports the purchase as pending. */
  | { type: 'pending'; sessionId: string; productIds: string[] }
  | {
      type: 'awaitingBackend';
      sessionId: string;
      transactionId?: string;
      failure: PurchaseFailure;
    }
  | {
      type: 'rejected';
      sessionId: string;
      transactionId?: string;
      failure: PurchaseFailure;
    }
  /** Android: a hosted checkout page was opened for a session whose `purchase` call is no longer waiting. */
  | { type: 'hostedCheckoutOpened'; session: PurchaseSession }
  /** A store purchase the SDK has no record for. Read the entitlements; a purchase the backend never heard of needs support. */
  | {
      type: 'unmatchedPurchase';
      transactionId?: string;
      purchaseToken?: string;
      productIds: string[];
    }
  /** iOS: StoreKit delivered a transaction whose signature it could not verify. */
  | { type: 'unverifiedTransaction'; transactionId: string; reason: string }
  | Unknown;

/** Android: what `handleReturnLink` found. */
export type ReturnLinkResult =
  | { type: 'ignored' }
  | { type: 'completed'; session: PurchaseSession }
  | { type: 'notPaid'; session: PurchaseSession }
  | { type: 'stillPending'; session: PurchaseSession }
  | { type: 'backendFailed'; failure: PurchaseFailure }
  | Unknown;

/** iOS: whether a refund request was sent. The App Store decides the refund later. */
export type RefundRequestOutcome = OpenString<'submitted' | 'cancelled'>;

export interface EntitlementItem {
  /** The key of the product. */
  product: string;
  kind: ProductKind;
  provider: Provider;
  channel: SalesChannel;
  platform: Platform;
  subscriptionId?: string;
  paymentId?: string;
  status: EntitlementStatus;
  /** True when the item gives access now. */
  active: boolean;
  cancelAtPeriodEnd?: boolean;
  /** ISO-8601. */
  currentPeriodEnd?: string;
  /** ISO-8601. */
  updatedAt: string;
}

/** What a customer owns, across app stores and gateways. The backend is the source of truth for it. */
export interface Entitlements {
  customerRef: string;
  /** True when at least one item gives access now. */
  active: boolean;
  items: EntitlementItem[];
}

/** The five relative paths of the backend; `{sessionId}` and `{customerRef}` are placeholders. */
export interface BackendPaths {
  start?: string;
  session?: string;
  alternative?: string;
  complete?: string;
  entitlements?: string;
}

export interface ConfigureOptions {
  /** The root of your backend, for example `https://api.example.com/billing/`. Never the service's own API key. */
  baseUrl: string;
  /** The value of the Authorization header, for example `Bearer <the user's token>`. Update it with `setAuthorization`. */
  authorization?: string | null;
  /**
   * Fixed extra headers sent on every request, for example an app version or a tenant id. `Authorization` is set
   * through `authorization`, not here (naming it here rejects with `INVALID_ARGUMENT`).
   */
  headers?: Record<string, string>;
  paths?: BackendPaths;
  /** Request timeout in milliseconds. */
  timeoutMs?: number;
  /** Times one call to the backend is sent in a row before the client gives up for now. */
  maxCompletionAttempts?: number;
  /** Milliseconds before the second attempt; doubled for each further one. */
  retryDelayMs?: number;
  /** Rounds that may end in a lasting-looking server failure before a purchase is marked rejected. */
  maxServerFailures?: number;
  ios?: {
    /** Finish a transaction that no purchase record matches. Off by default. */
    finishUnmatchedTransactions?: boolean;
  };
  android?: {
    /** Buy the base plan when the named offer is not offered to the customer. Off by default. */
    allowBasePlanFallback?: boolean;
    /** Also enable pending purchases for prepaid plans. */
    enablePrepaidPlans?: boolean;
    /** Allow an `http` hosted checkout address (local development only). */
    allowCleartextCheckout?: boolean;
  };
}

export interface PurchaseOptions {
  /** Your id for the customer: entitlements are kept under it. */
  customerRef: string;
  customer?: Customer;
  /** Your own id for this purchase (at most 25 characters of letters, digits, `_` and `-`). The same reference and customer returns the same session. */
  reference?: string;
  /** Android: the app's return link, where a hosted checkout sends the customer when it is done. */
  returnUrl?: string;
}

/** A subscription returned by `addPurchaseListener`. */
export interface Subscription {
  remove(): void;
}
