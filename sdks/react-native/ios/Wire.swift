import Foundation
import IndiaSubscriptions

/// Translates the native SDK's results into the dictionaries JavaScript reads (see `src/types.ts`). Nothing is decided
/// here: a value maps to its JavaScript name, and a result case this file does not know maps to its own case name,
/// which JavaScript reports as an `unknown` variant instead of failing.
enum Wire {
    private static func iso(_ date: Date) -> String {
        let format = ISO8601DateFormatter()
        format.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return format.string(from: date)
    }

    /// The case name of an enum value: `.awaitingBackend(...)` -> `awaitingBackend`.
    private static func tag(_ value: Any) -> String {
        let text = String(describing: value)
        return String(text.prefix { $0 != "(" })
    }

    /// Drops nil members, so JavaScript sees only what is set.
    private static func dictionary(_ entries: [String: Any?]) -> [String: Any] {
        entries.compactMapValues { $0 }
    }

    // MARK: Models

    private static func checkout(_ instruction: CheckoutInstruction) -> [String: Any] {
        switch instruction {
        case .appleStoreKit(let value):
            return ["kind": instruction.kind, "productId": value.productId, "appAccountToken": value.appAccountToken.uuidString.lowercased()]
        case .other:
            return ["kind": instruction.kind]
        }
    }

    private static func option(_ option: PurchaseOption) -> [String: Any] {
        [
            "channel": option.channel.rawValue, "provider": option.provider.rawValue,
            "checkout": checkout(option.checkout), "handle": option.handle,
        ]
    }

    private static func attempt(_ attempt: PurchaseAttempt) -> [String: Any] {
        dictionary([
            "provider": attempt.provider.rawValue, "outcome": attempt.outcome.rawValue, "at": iso(attempt.at),
            "errorCode": attempt.errorCode, "message": attempt.message,
        ])
    }

    static func session(_ session: PurchaseSession) -> [String: Any] {
        dictionary([
            "id": session.id, "platform": session.platform.rawValue, "product": session.product,
            "policy": session.policy.rawValue, "status": session.status.rawValue, "customerRef": session.customerRef,
            "reference": session.reference, "options": session.options.map(option), "attempts": session.attempts.map(attempt),
            "externalTransactionToken": session.externalTransactionToken, "createdAt": iso(session.createdAt),
            "expiresAt": iso(session.expiresAt), "completedAt": session.completedAt.map(iso),
            "subscriptionId": session.subscriptionId, "paymentId": session.paymentId, "provider": session.provider?.rawValue,
        ])
    }

    private static func item(_ item: EntitlementItem) -> [String: Any] {
        dictionary([
            "product": item.product, "kind": item.kind.rawValue, "provider": item.provider.rawValue,
            "channel": item.channel.rawValue, "platform": item.platform.rawValue, "subscriptionId": item.subscriptionId,
            "paymentId": item.paymentId, "status": item.status.rawValue, "active": item.active,
            "cancelAtPeriodEnd": item.cancelAtPeriodEnd, "currentPeriodEnd": item.currentPeriodEnd.map(iso),
            "updatedAt": iso(item.updatedAt),
        ])
    }

    static func entitlements(_ entitlements: Entitlements) -> [String: Any] {
        ["customerRef": entitlements.customerRef, "active": entitlements.active, "items": entitlements.items.map(item)]
    }

    private static func failure(_ failure: PurchaseFailure) -> [String: Any] {
        // `String(describing:)` of a payload-free enum is its case name, already lower camel case.
        dictionary(["reason": String(describing: failure.reason), "code": failure.code?.rawValue, "message": failure.message])
    }

    // MARK: Results

    static func outcome(_ outcome: PurchaseOutcome) -> [String: Any] {
        switch outcome {
        case .completed(let session): return ["type": "completed", "session": Self.session(session)]
        case .pending(let session): return ["type": "pending", "session": Self.session(session)]
        case .cancelled: return ["type": "cancelled"]
        case .unverified(let session, let reason): return ["type": "unverified", "session": Self.session(session), "reason": reason]
        case .awaitingBackend(let session, let failure):
            return ["type": "awaitingBackend", "session": Self.session(session), "failure": Self.failure(failure)]
        case .rejected(let session, let failure):
            return ["type": "rejected", "session": Self.session(session), "failure": Self.failure(failure)]
        @unknown default: return ["type": tag(outcome)]
        }
    }

    static func event(_ event: PurchaseEvent) -> [String: Any] {
        switch event {
        case .completed(let session, let transactionID):
            return ["type": "completed", "session": Self.session(session), "transactionId": String(transactionID)]
        case .awaitingBackend(let sessionID, let transactionID, let failure):
            return ["type": "awaitingBackend", "sessionId": sessionID, "transactionId": String(transactionID), "failure": Self.failure(failure)]
        case .rejected(let sessionID, let transactionID, let failure):
            return ["type": "rejected", "sessionId": sessionID, "transactionId": String(transactionID), "failure": Self.failure(failure)]
        case .unmatchedTransaction(let transactionID, let productID):
            return ["type": "unmatchedPurchase", "transactionId": String(transactionID), "productIds": [productID]]
        case .unverifiedTransaction(let transactionID, let reason):
            return ["type": "unverifiedTransaction", "transactionId": String(transactionID), "reason": reason]
        @unknown default: return ["type": tag(event)]
        }
    }

    static func events(_ events: [PurchaseEvent]) -> [String: Any] {
        ["events": events.map(event)]
    }
}
