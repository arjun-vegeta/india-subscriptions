import Foundation

/// What the SDK remembers about one App Store purchase between launches: the map from the StoreKit account token to the
/// purchase session. A transaction that arrives later (Ask to Buy approved, the app killed mid-purchase) carries the
/// token, and this record says which session it completes.
///
/// A record holds no signed transaction and no customer details.
public struct PurchaseRecord: Codable, Hashable, Sendable {
    /// Where the purchase is, from the device's side.
    public enum State: String, Codable, Sendable {
        /// The purchase was started; StoreKit has not returned a transaction yet (or the app died before it did).
        case open
        /// StoreKit said `pending` (Ask to Buy and similar): the transaction arrives later through `Transaction.updates`.
        case pending
        /// The backend confirmed a transaction of this purchase.
        case completed
        /// The backend refused a transaction for a reason that will not change, or the SDK gave up. Never sent again
        /// until `PurchaseClient.retryRejectedTransactions()`.
        case rejected
    }

    /// The account token (lower-case UUID text) passed to StoreKit and returned in the transaction.
    public var accountToken: String
    public var sessionID: String
    /// The product key.
    public var product: String
    public var state: State
    /// Transactions the backend confirmed. A later transaction of the same token (a renewal) is not sent again.
    public var completedTransactionIDs: [UInt64]
    /// Rounds of retrying that ended in a server failure that may be lasting. See `RetryAdvice.limited`.
    public var failedRounds: Int
    /// The server error code of the last refusal, for a `rejected` record.
    public var lastErrorCode: String?
    public var createdAt: Date
    /// When the session expires. An `open` record is dropped a week after this.
    public var expiresAt: Date
    public var updatedAt: Date

    public init(
        accountToken: UUID, sessionID: String, product: String, state: State = .open, expiresAt: Date, now: Date = Date()
    ) {
        self.accountToken = accountToken.uuidString.lowercased()
        self.sessionID = sessionID
        self.product = product
        self.state = state
        self.completedTransactionIDs = []
        self.failedRounds = 0
        self.createdAt = now
        self.expiresAt = expiresAt
        self.updatedAt = now
    }

    /// The key a transaction's `appAccountToken` is looked up by.
    public static func key(for token: UUID) -> String { token.uuidString.lowercased() }
}

/// Where the SDK keeps its `PurchaseRecord`s. Reads and writes are small and synchronous. The SDK calls them from one
/// actor, one at a time, and replaces the whole list on every change.
public protocol PurchaseRecordStore: Sendable {
    func load() throws -> [PurchaseRecord]
    func save(_ records: [PurchaseRecord]) throws
}

/// Keeps the records in `UserDefaults` as one JSON value. `UserDefaults` is part of the app's backup and survives an app
/// update, not a deletion of the app (after which StoreKit delivers unfinished transactions without a map: see
/// `PurchaseEvent.unmatchedTransaction`).
public final class UserDefaultsPurchaseRecordStore: PurchaseRecordStore, @unchecked Sendable {
    private let defaults: UserDefaults
    private let key: String
    private let lock = NSLock()

    public init(defaults: UserDefaults = .standard, key: String = "in.india-subscriptions.purchase-records") {
        self.defaults = defaults
        self.key = key
    }

    public func load() throws -> [PurchaseRecord] {
        lock.lock()
        defer { lock.unlock() }
        guard let data = defaults.data(forKey: key) else { return [] }
        return try JSONDecoder().decode([PurchaseRecord].self, from: data)
    }

    public func save(_ records: [PurchaseRecord]) throws {
        lock.lock()
        defer { lock.unlock() }
        defaults.set(try JSONEncoder().encode(records), forKey: key)
    }
}

/// Keeps the records in memory. For tests and for apps that do not want a map to survive a launch (they then lose
/// recovery of a purchase interrupted by a kill).
public final class InMemoryPurchaseRecordStore: PurchaseRecordStore, @unchecked Sendable {
    private var records: [PurchaseRecord]
    private let lock = NSLock()

    public init(records: [PurchaseRecord] = []) { self.records = records }

    public func load() throws -> [PurchaseRecord] {
        lock.lock()
        defer { lock.unlock() }
        return records
    }

    public func save(_ records: [PurchaseRecord]) throws {
        lock.lock()
        defer { lock.unlock() }
        self.records = records
    }
}
