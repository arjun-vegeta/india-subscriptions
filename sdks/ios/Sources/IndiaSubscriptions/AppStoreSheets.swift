import Foundation
import StoreKit
#if canImport(AppKit)
import AppKit
#endif

/// Whether a refund request was sent. It says nothing about the refund itself: the App Store takes up to 48 hours to
/// approve or deny it, and the server learns the result from App Store Server Notifications.
public enum RefundRequestOutcome: Sendable, Hashable {
    /// The customer submitted the request.
    case submitted
    /// The customer closed the sheet without submitting.
    case cancelled
}

/// Thin wrappers over the system sheets for what a server cannot do to an App Store purchase: it can neither cancel a
/// subscription nor refund a purchase. The customer does both through Apple, and the app only opens the sheet.
public enum AppStoreSheets {
    #if canImport(UIKit) && !os(watchOS)
    /// Presents the App Store's manage-subscriptions sheet (`AppStore.showManageSubscriptions(in:)`): the customer can
    /// view, change or cancel their subscription there. The server learns of the change from App Store Server
    /// Notifications; read the entitlements afterwards.
    @MainActor
    public static func showManageSubscriptions(in scene: UIWindowScene) async throws {
        try await AppStore.showManageSubscriptions(in: scene)
    }

    /// Presents the refund-request sheet for a transaction (`Transaction.beginRefundRequest(for:in:)`).
    /// `transactionID` is the id of the transaction the customer wants refunded: `Transaction.id`, which the backend
    /// also has as the entitlement's payment or latest transaction id.
    @MainActor
    public static func requestRefund(forTransaction transactionID: UInt64, in scene: UIWindowScene) async throws -> RefundRequestOutcome {
        switch try await Transaction.beginRefundRequest(for: transactionID, in: scene) {
        case .success: return .submitted
        case .userCancelled: return .cancelled
        @unknown default: return .cancelled
        }
    }
    #elseif os(macOS)
    /// Presents the refund-request sheet for a transaction in a view controller (`Transaction.beginRefundRequest(for:in:)`).
    @MainActor
    public static func requestRefund(forTransaction transactionID: UInt64, in controller: NSViewController) async throws -> RefundRequestOutcome {
        switch try await Transaction.beginRefundRequest(for: transactionID, in: controller) {
        case .success: return .submitted
        case .userCancelled: return .cancelled
        @unknown default: return .cancelled
        }
    }
    #endif
}
