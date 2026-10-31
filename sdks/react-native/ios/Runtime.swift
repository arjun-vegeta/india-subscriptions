import Foundation
import IndiaSubscriptions

/// The purchase client and the latest authorisation value, kept for the life of the process.
///
/// A JavaScript reload creates a new module instance but must not lose the client: a purchase may be in flight, and the
/// SDK keeps its own persisted records. A module instance only attaches to this holder.
enum Runtime {
    /// The value of the Authorization header the HTTP backend sends. Held in memory only; never written to storage.
    static let authorization = AuthorizationStore()

    private static let lock = NSLock()
    nonisolated(unsafe) private static var current: PurchaseClient?

    static func client() -> PurchaseClient? {
        lock.lock()
        defer { lock.unlock() }
        return current
    }

    /// Installs a client and returns the one it replaced.
    static func replace(_ client: PurchaseClient) -> PurchaseClient? {
        lock.lock()
        defer { lock.unlock() }
        let previous = current
        current = client
        return previous
    }
}

final class AuthorizationStore: @unchecked Sendable {
    private let lock = NSLock()
    private var value: String?

    func get() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }

    func set(_ new: String?) {
        lock.lock()
        value = new
        lock.unlock()
    }
}

/// Typed reads from the dictionaries JavaScript sends. A missing, `null` or wrongly typed member reads as nil.
struct Options {
    private let values: NSDictionary

    init(_ values: NSDictionary) { self.values = values }

    func string(_ key: String) -> String? { values[key] as? String }
    func bool(_ key: String) -> Bool? { (values[key] as? NSNumber)?.boolValue }
    func int(_ key: String) -> Int? { (values[key] as? NSNumber)?.intValue }
    func double(_ key: String) -> Double? { (values[key] as? NSNumber)?.doubleValue }
    func dictionary(_ key: String) -> NSDictionary? { values[key] as? NSDictionary }
}
