import Foundation

/// The `code` of an error the server answered with. Open: a code added by a newer server still decodes.
public struct ServerErrorCode: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }

    public static let validation: ServerErrorCode = "VALIDATION"
    public static let signatureInvalid: ServerErrorCode = "SIGNATURE_INVALID"
    public static let notFound: ServerErrorCode = "NOT_FOUND"
    public static let conflict: ServerErrorCode = "CONFLICT"
    public static let unsupported: ServerErrorCode = "UNSUPPORTED"
    public static let noRoute: ServerErrorCode = "NO_ROUTE"
    public static let methodNotAllowed: ServerErrorCode = "METHOD_NOT_ALLOWED"
    public static let payloadTooLarge: ServerErrorCode = "PAYLOAD_TOO_LARGE"
    /// The caller's credentials were refused (a missing or expired user token).
    public static let unauthorized: ServerErrorCode = "UNAUTHORIZED"
    public static let rateLimited: ServerErrorCode = "RATE_LIMITED"
    public static let providerUnavailable: ServerErrorCode = "PROVIDER_UNAVAILABLE"
    public static let network: ServerErrorCode = "NETWORK"
    public static let timeout: ServerErrorCode = "TIMEOUT"
    public static let outcomeUnknown: ServerErrorCode = "OUTCOME_UNKNOWN"
    public static let providerError: ServerErrorCode = "PROVIDER_ERROR"
    public static let auth: ServerErrorCode = "AUTH"
    public static let unexpectedResponse: ServerErrorCode = "UNEXPECTED_RESPONSE"
    public static let config: ServerErrorCode = "CONFIG"
    public static let internalError: ServerErrorCode = "INTERNAL_ERROR"
}

/// Whether repeating a call that failed can help, as far as the SDK can tell.
public enum RetryAdvice: Sendable, Hashable {
    /// The reason will not change: the same call fails the same way. The SDK stops sending the transaction.
    case never
    /// The server could not be reached or asked to wait (no network, a timeout, a rate limit, the user's token expired).
    /// The SDK keeps trying, without a limit.
    case later
    /// The server answered with a failure that may be temporary or may be a lasting fault (an internal error, an App
    /// Store lookup that failed). The SDK retries it, up to `PurchaseClient.Configuration.maxServerFailures` rounds.
    case limited
}

/// What the server said when it refused a call, as the error body carries it.
public struct ServerError: Sendable, Hashable {
    public var statusCode: Int
    public var code: ServerErrorCode
    public var message: String
    /// The gateway or store involved, where the server named one.
    public var provider: String?
    /// The store's or gateway's own error code.
    public var providerCode: String?
    /// The server's own `retryable` flag.
    public var retryable: Bool?
    /// False when the body was not the service's error shape (a proxy page, an empty body); `code` is then derived from the status.
    public var isStructured: Bool

    public init(
        statusCode: Int, code: ServerErrorCode, message: String, provider: String? = nil, providerCode: String? = nil,
        retryable: Bool? = nil, isStructured: Bool = true
    ) {
        self.statusCode = statusCode
        self.code = code
        self.message = message
        self.provider = provider
        self.providerCode = providerCode
        self.retryable = retryable
        self.isStructured = isStructured
    }
}

/// An error from the purchase backend.
public enum PurchaseBackendError: Error, Sendable, Hashable {
    /// The backend answered with an error.
    case server(ServerError)
    /// The request did not get an answer (no network, a timeout, a lost connection). `code` is the `URLError` code.
    case transport(code: Int, description: String)
    /// The backend answered 2xx with a body the SDK cannot read.
    case malformedResponse(statusCode: Int, detail: String)
    /// The request could not be built (a bad base URL or path).
    case invalidRequest(String)

    /// The server's error, when there is one.
    public var serverError: ServerError? {
        if case .server(let error) = self { return error }
        return nil
    }

    /// The server's error code, when there is one.
    public var code: ServerErrorCode? { serverError?.code }

    /// What the SDK does about this failure when it came from sending a transaction. See `RetryAdvice`.
    public var retryAdvice: RetryAdvice {
        switch self {
        case .transport:
            return .later
        case .invalidRequest, .malformedResponse:
            // A 2xx the SDK cannot read, or a request it cannot build, fails the same way next time.
            return .never
        case .server(let error):
            return Self.advice(for: error)
        }
    }

    static func advice(for error: ServerError) -> RetryAdvice {
        switch error.code {
        case .validation, .signatureInvalid, .notFound, .conflict, .unsupported, .noRoute, .methodNotAllowed, .payloadTooLarge:
            return .never
        case .unauthorized, .rateLimited, .providerUnavailable, .network, .timeout:
            return .later
        case .outcomeUnknown, .providerError, .auth, .unexpectedResponse, .config, .internalError:
            return .limited
        default:
            // A code from a newer server. Trust its own flag, then the HTTP status.
            if let retryable = error.retryable { return retryable ? .limited : .never }
            switch error.statusCode {
            case 401, 403, 408, 425, 429: return .later
            case 500...599: return .limited
            default: return .never
            }
        }
    }
}

extension PurchaseBackendError: LocalizedError {
    public var errorDescription: String? {
        switch self {
        case .server(let error): return "\(error.code.rawValue): \(error.message)"
        case .transport(_, let description): return description
        case .malformedResponse(let status, let detail): return "Unreadable response (\(status)): \(detail)"
        case .invalidRequest(let detail): return detail
        }
    }
}
