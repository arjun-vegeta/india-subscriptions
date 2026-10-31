/**
 * The codes of `IndiaSubscriptionsError.code`. The list is open: a newer native SDK may add codes, so compare against
 * the ones you handle and treat the rest as a failure to show a generic message for.
 */
export const ErrorCode = {
  /** `configure` was not called, or failed. */
  NotConfigured: 'NOT_CONFIGURED',
  /** The call exists on the other platform only. */
  NotApplicable: 'NOT_APPLICABLE',
  InvalidArgument: 'INVALID_ARGUMENT',
  /** Android: no foreground activity to launch the purchase from. */
  NoActivity: 'NO_ACTIVITY',
  /** iOS: no foreground window scene to present a sheet from. */
  NoWindowScene: 'NO_WINDOW_SCENE',
  /** The backend failed or could not be reached; `details` says how. */
  Backend: 'BACKEND',
  PurchaseInProgress: 'PURCHASE_IN_PROGRESS',
  NoUsableOption: 'NO_USABLE_OPTION',
  SessionNotOpen: 'SESSION_NOT_OPEN',
  InvalidInstruction: 'INVALID_INSTRUCTION',
  ProductNotFound: 'PRODUCT_NOT_FOUND',
  OfferNotAvailable: 'OFFER_NOT_AVAILABLE',
  ActivityGone: 'ACTIVITY_GONE',
  /** StoreKit failed. */
  StoreKit: 'STORE_KIT',
  Storage: 'STORAGE',
  Unknown: 'UNKNOWN',
} as const;

/**
 * Details of an error. For `BACKEND`: `kind` (`server`, `transport`, `malformedResponse`, `invalidRequest`) and, for a
 * server error, `serverCode`, `statusCode`, `provider`, `providerCode` and `retryable`.
 */
export type ErrorDetails = Record<string, unknown>;

/** The one error the library rejects with. Nothing was charged when a `purchase` call rejects with it. */
export class IndiaSubscriptionsError extends Error {
  readonly code: string;
  readonly details: ErrorDetails;

  constructor(code: string, message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = 'IndiaSubscriptionsError';
    this.code = code;
    this.details = details;
  }
}

/** Turns whatever a native promise rejected with into an `IndiaSubscriptionsError`. */
export function toError(error: unknown): IndiaSubscriptionsError {
  if (error instanceof IndiaSubscriptionsError) {
    return error;
  }
  if (typeof error === 'object' && error !== null) {
    const { code, message, userInfo } = error as {
      code?: unknown;
      message?: unknown;
      userInfo?: unknown;
    };
    const details =
      typeof userInfo === 'object' && userInfo !== null
        ? (userInfo as ErrorDetails)
        : {};
    return new IndiaSubscriptionsError(
      typeof code === 'string' && code !== '' ? code : ErrorCode.Unknown,
      typeof message === 'string' ? message : 'The native call failed',
      details
    );
  }
  return new IndiaSubscriptionsError(ErrorCode.Unknown, String(error));
}
