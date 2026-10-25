import Foundation
import IndiaSubscriptions

// Translation between the iOS SDK's types and the generated messages, and from the SDK's errors to the errors the Dart
// side understands. No decision about a purchase is made here.

/// The error codes the Dart side reads (`lib/src/errors.dart`).
enum ErrorCode {
  static let notConfigured = "not_configured"
  static let backend = "backend"
  static let purchase = "purchase"
  static let unsupportedOnPlatform = "unsupported_on_platform"
  static let unexpected = "unexpected"
}

let platformName = "ios"

private func millis(_ date: Date) -> Int64 {
  Int64((date.timeIntervalSince1970 * 1000).rounded())
}

extension PurchaseOption {
  var wire: PurchaseOptionMessage {
    var storeProductID: String?
    if case .appleStoreKit(let checkout) = checkout { storeProductID = checkout.productId }
    return PurchaseOptionMessage(
      channel: channel.rawValue, provider: provider.rawValue, handle: handle, checkoutKind: checkout.kind,
      storeProductId: storeProductID, hostedUrl: nil)
  }
}

extension PurchaseSession {
  var wire: PurchaseSessionMessage {
    PurchaseSessionMessage(
      id: id, platform: platform.rawValue, product: product, policy: policy.rawValue, status: status.rawValue,
      customerRef: customerRef, options: options.map(\.wire), createdAt: millis(createdAt),
      expiresAt: millis(expiresAt), reference: reference, returnUrl: nil, completedAt: completedAt.map(millis),
      subscriptionId: subscriptionId, paymentId: paymentId, provider: provider?.rawValue)
  }
}

extension PurchaseFailure.Reason {
  var wireName: String {
    switch self {
    case .backendUnreachable: return "backendUnreachable"
    case .backendFailing: return "backendFailing"
    case .backendRefused: return "backendRefused"
    case .notPaid: return "notPaid"
    case .notSettled: return "notSettled"
    case .gaveUp: return "gaveUp"
    case .tokenMismatch: return "tokenMismatch"
    }
  }
}

extension PurchaseFailure {
  var wire: PurchaseFailureMessage {
    PurchaseFailureMessage(reason: reason.wireName, message: message, code: code?.rawValue)
  }
}

extension PurchaseOutcome {
  var wire: PurchaseOutcomeMessage {
    switch self {
    case .completed(let session):
      return PurchaseOutcomeMessage(kind: "completed", session: session.wire)
    case .pending(let session):
      return PurchaseOutcomeMessage(kind: "pending", session: session.wire)
    case .cancelled:
      return PurchaseOutcomeMessage(kind: "cancelled")
    case .unverified(let session, let reason):
      return PurchaseOutcomeMessage(kind: "unverified", session: session.wire, reason: reason)
    case .awaitingBackend(let session, let failure):
      return PurchaseOutcomeMessage(kind: "awaitingBackend", session: session.wire, failure: failure.wire)
    case .rejected(let session, let failure):
      return PurchaseOutcomeMessage(kind: "rejected", session: session.wire, failure: failure.wire)
    }
  }
}

extension PurchaseEvent {
  var wire: PurchaseEventMessage {
    switch self {
    case .completed(let session, let transactionID):
      return PurchaseEventMessage(kind: "completed", session: session.wire, transactionId: String(transactionID))
    case .awaitingBackend(let sessionID, let transactionID, let failure):
      return PurchaseEventMessage(
        kind: "awaitingBackend", sessionId: sessionID, failure: failure.wire, transactionId: String(transactionID))
    case .rejected(let sessionID, let transactionID, let failure):
      return PurchaseEventMessage(
        kind: "rejected", sessionId: sessionID, failure: failure.wire, transactionId: String(transactionID))
    case .unmatchedTransaction(let transactionID, let productID):
      return PurchaseEventMessage(
        kind: "unmatchedPurchase", transactionId: String(transactionID), productIds: [productID])
    case .unverifiedTransaction(let transactionID, let reason):
      return PurchaseEventMessage(kind: "unverifiedTransaction", transactionId: String(transactionID), reason: reason)
    }
  }
}

extension EntitlementItem {
  var wire: EntitlementItemMessage {
    EntitlementItemMessage(
      product: product, kind: kind.rawValue, provider: provider.rawValue, channel: channel.rawValue,
      platform: platform.rawValue, status: status.rawValue, active: active, updatedAt: millis(updatedAt),
      subscriptionId: subscriptionId, paymentId: paymentId, cancelAtPeriodEnd: cancelAtPeriodEnd,
      currentPeriodEnd: currentPeriodEnd.map(millis))
  }
}

extension Entitlements {
  var wire: EntitlementsMessage {
    EntitlementsMessage(customerRef: customerRef, active: active, items: items.map(\.wire))
  }
}

extension CustomerMessage {
  var customer: Customer {
    Customer(id: id, name: name, email: email, phone: phone, state: state)
  }
}

extension RefundRequestOutcome {
  var wireName: String {
    switch self {
    case .submitted: return "submitted"
    case .cancelled: return "cancelled"
    }
  }
}

// MARK: - Errors

func notConfigured() -> PigeonError {
  PigeonError(code: ErrorCode.notConfigured, message: "Call IndiaSubscriptions.configure before using the plugin.", details: nil)
}

func unsupportedOnIOS(_ method: String, _ detail: String) -> PigeonError {
  PigeonError(
    code: ErrorCode.unsupportedOnPlatform, message: "\(method) \(detail)",
    details: ["method": method, "platform": platformName])
}

extension PurchaseBackendError {
  var pigeonError: PigeonError {
    var details: [String: Sendable] = [:]
    switch self {
    case .server(let error):
      details["kind"] = "server"
      details["statusCode"] = Int64(error.statusCode)
      details["serverCode"] = error.code.rawValue
      if let provider = error.provider { details["provider"] = provider }
      if let providerCode = error.providerCode { details["providerCode"] = providerCode }
      if let retryable = error.retryable { details["retryable"] = retryable }
    case .transport:
      details["kind"] = "transport"
    case .malformedResponse(let statusCode, _):
      details["kind"] = "malformedResponse"
      details["statusCode"] = Int64(statusCode)
    case .invalidRequest:
      details["kind"] = "invalidRequest"
    }
    return PigeonError(code: ErrorCode.backend, message: errorDescription ?? "\(self)", details: details)
  }
}

extension PurchaseError {
  var kindName: String {
    switch self {
    case .purchaseInProgress: return "purchaseInProgress"
    case .noAppStoreOption: return "noStoreOption"
    case .sessionNotOpen: return "sessionNotOpen"
    case .invalidInstruction: return "invalidInstruction"
    case .productNotFound: return "productNotFound"
    case .storeKit: return "storeFailure"
    case .storage: return "storage"
    case .unknownPurchaseResult: return "unknownPurchaseResult"
    }
  }

  var pigeonError: PigeonError {
    PigeonError(code: ErrorCode.purchase, message: "\(self)", details: ["kind": kindName])
  }
}

/// Runs a call into the SDK and turns what it throws into the errors Dart understands.
func translatingErrors<T>(_ call: () async throws -> T) async throws -> T {
  do {
    return try await call()
  } catch let error as PurchaseBackendError {
    throw error.pigeonError
  } catch let error as PurchaseError {
    throw error.pigeonError
  } catch is CancellationError {
    throw CancellationError()
  } catch {
    throw PigeonError(code: ErrorCode.unexpected, message: "\(error)", details: nil)
  }
}
