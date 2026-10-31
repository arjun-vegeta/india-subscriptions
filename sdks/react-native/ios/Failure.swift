import Foundation
import IndiaSubscriptions

/// The codes of the errors a call rejects with. They match `ErrorCode` in `src/errors.ts`.
enum FailureCode: String {
    case notConfigured = "NOT_CONFIGURED"
    case notApplicable = "NOT_APPLICABLE"
    case invalidArgument = "INVALID_ARGUMENT"
    case noWindowScene = "NO_WINDOW_SCENE"
    case backend = "BACKEND"
    case purchaseInProgress = "PURCHASE_IN_PROGRESS"
    case noUsableOption = "NO_USABLE_OPTION"
    case sessionNotOpen = "SESSION_NOT_OPEN"
    case invalidInstruction = "INVALID_INSTRUCTION"
    case productNotFound = "PRODUCT_NOT_FOUND"
    case storeKit = "STORE_KIT"
    case storage = "STORAGE"
    case unknown = "UNKNOWN"
}

/// Rejects a promise with a code, a message and details, the way `IndiaSubscriptionsError` reads them: the details are
/// the `userInfo` of the `NSError`.
enum Failure {
    static func reject(
        _ reject: (String, String, NSError?) -> Void, code: FailureCode, _ message: String, _ details: [String: Any] = [:]
    ) {
        reject(code.rawValue, message, NSError(domain: "IndiaSubscriptions", code: 0, userInfo: details))
    }

    /// Rejects with the error the native SDK threw, translated to a code and details.
    static func reject(_ reject: (String, String, NSError?) -> Void, _ error: Error) {
        let message = (error as? LocalizedError)?.errorDescription ?? String(describing: error)
        switch error {
        case let error as PurchaseBackendError:
            Self.reject(reject, code: .backend, message, details(of: error))
        case let error as PurchaseError:
            switch error {
            case .purchaseInProgress:
                Self.reject(reject, code: .purchaseInProgress, message)
            case .noAppStoreOption(let sessionID):
                Self.reject(reject, code: .noUsableOption, message, ["sessionId": sessionID])
            case .sessionNotOpen(let sessionID, let status):
                Self.reject(reject, code: .sessionNotOpen, message, ["sessionId": sessionID, "status": status.rawValue])
            case .invalidInstruction:
                Self.reject(reject, code: .invalidInstruction, message)
            case .productNotFound(let productID):
                Self.reject(reject, code: .productNotFound, message, ["productId": productID])
            case .storeKit:
                Self.reject(reject, code: .storeKit, message)
            case .storage:
                Self.reject(reject, code: .storage, message)
            case .unknownPurchaseResult:
                Self.reject(reject, code: .unknown, message)
            @unknown default:
                Self.reject(reject, code: .unknown, message)
            }
        case is CancellationError:
            Self.reject(reject, code: .unknown, "The call was cancelled")
        default:
            Self.reject(reject, code: .unknown, message)
        }
    }

    private static func details(of error: PurchaseBackendError) -> [String: Any] {
        let advice = String(describing: error.retryAdvice)
        switch error {
        case .server(let server):
            var out: [String: Any] = [
                "kind": "server", "serverCode": server.code.rawValue, "statusCode": server.statusCode, "retryAdvice": advice,
            ]
            if let provider = server.provider { out["provider"] = provider }
            if let providerCode = server.providerCode { out["providerCode"] = providerCode }
            if let retryable = server.retryable { out["retryable"] = retryable }
            return out
        case .transport:
            return ["kind": "transport", "retryAdvice": advice]
        case .malformedResponse(let status, _):
            return ["kind": "malformedResponse", "statusCode": status, "retryAdvice": advice]
        case .invalidRequest:
            return ["kind": "invalidRequest", "retryAdvice": advice]
        }
    }
}
