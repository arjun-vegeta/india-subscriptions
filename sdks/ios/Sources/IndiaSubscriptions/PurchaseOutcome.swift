import Foundation

/// Why a purchase did not finish with the backend. Carried by `PurchaseOutcome` and `PurchaseEvent`.
public struct PurchaseFailure: Error, Sendable, Hashable {
    public enum Reason: Sendable, Hashable {
        /// The backend could not be reached, or asked the app to wait (offline, timeout, rate limit, expired user token).
        /// The transaction stays unfinished and is sent again.
        case backendUnreachable
        /// The backend failed in a way that may or may not last. The transaction stays unfinished and is sent again,
        /// up to `PurchaseClient.Configuration.maxServerFailures` rounds.
        case backendFailing
        /// The backend refused the transaction for a reason that will not change (`message` and `code` say why). It is
        /// not sent again until `retryRejectedTransactions()`.
        case backendRefused
        /// The backend looked at the transaction and says it is not paid (refunded, revoked or an expired subscription).
        case notPaid
        /// The backend accepted the call but the session is not settled yet (`open` or `awaiting_payment`). The
        /// transaction stays unfinished and is sent again.
        case notSettled
        /// The SDK retried through its limit of server failures and stopped.
        case gaveUp
        /// The transaction's account token is not the one this purchase started with. Nothing was sent.
        case tokenMismatch
    }

    public var reason: Reason
    /// The server's error code, when the backend answered with one.
    public var code: ServerErrorCode?
    public var message: String

    public init(reason: Reason, code: ServerErrorCode? = nil, message: String) {
        self.reason = reason
        self.code = code
        self.message = message
    }
}

/// What happened to a purchase the app started with `PurchaseClient.purchase`.
public enum PurchaseOutcome: Sendable, Equatable {
    /// StoreKit verified the transaction, the backend confirmed it and the SDK finished it. Grant access (the
    /// entitlements are the backend's to read).
    case completed(PurchaseSession)

    /// Ask to Buy or another approval is pending. The session stays open and completes later: a `PurchaseEvent.completed`
    /// arrives on `PurchaseClient.events` when the transaction does. Tell the customer the purchase waits for approval.
    case pending(PurchaseSession)

    /// The customer cancelled the purchase sheet. Nothing was charged.
    case cancelled

    /// StoreKit could not verify the transaction's signature. Nothing was sent to the backend and the transaction was
    /// not finished. Do not grant access.
    case unverified(PurchaseSession, reason: String)

    /// The App Store took the payment but the backend has not confirmed it (it could not be reached, or has not settled
    /// the session). The transaction stays unfinished and the SDK sends it again at the next launch, when a
    /// transaction update arrives, and on `processUnfinishedTransactions()`. Tell the customer the purchase is being
    /// confirmed, not that it failed; a `PurchaseEvent.completed` follows.
    case awaitingBackend(PurchaseSession, failure: PurchaseFailure)

    /// The backend refused the transaction for a reason that will not change. It is not sent again. Show the customer a
    /// way to reach support.
    case rejected(PurchaseSession, failure: PurchaseFailure)
}

/// A purchase that moved without the app asking for it: an Ask to Buy approved later, a retry, a transaction found at
/// start-up after the app was killed mid-purchase, a purchase made on another device.
public enum PurchaseEvent: Sendable, Equatable {
    /// The backend confirmed the transaction and the SDK finished it.
    case completed(PurchaseSession, transactionID: UInt64)

    /// The backend has not confirmed the transaction yet; it stays unfinished and is retried.
    case awaitingBackend(sessionID: String, transactionID: UInt64, failure: PurchaseFailure)

    /// The backend refused the transaction for a reason that will not change; it is not sent again.
    case rejected(sessionID: String, transactionID: UInt64, failure: PurchaseFailure)

    /// StoreKit delivered a transaction that carries no account token, or one this device has no purchase record for
    /// (a purchase started on another device, a promoted in-app purchase, an app that was deleted and reinstalled).
    /// The SDK cannot complete a session for it. The app's access follows the backend's entitlements; a purchase the
    /// backend never heard of needs support. Reported once per launch.
    case unmatchedTransaction(transactionID: UInt64, productID: String)

    /// StoreKit delivered a transaction whose signature it could not verify. Nothing was sent. Reported once per launch.
    case unverifiedTransaction(transactionID: UInt64, reason: String)
}

/// What can go wrong before a purchase reaches StoreKit's result, or around it.
public enum PurchaseError: Error, Sendable, Equatable {
    /// Another purchase of the same product is still running.
    case purchaseInProgress(product: String)
    /// The session has no App Store option (the product has no `appStore` mapping, or the policy sends the platform elsewhere).
    case noAppStoreOption(sessionID: String)
    /// The session is not open: it is `failed` or `expired`.
    case sessionNotOpen(sessionID: String, status: SessionStatus)
    /// The server's checkout instruction cannot be used (for example an account token that is not a UUID).
    case invalidInstruction(String)
    /// The App Store does not know the product id the session named.
    case productNotFound(productID: String)
    /// StoreKit failed (`Product.products`, `Product.purchase`, `AppStore.sync`). The description is StoreKit's own.
    case storeKit(String)
    /// The record store failed to read or write.
    case storage(String)
    /// StoreKit returned a purchase result this SDK version does not know.
    case unknownPurchaseResult
}
