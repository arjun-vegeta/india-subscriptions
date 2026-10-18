import Foundation

/// A `PurchaseBackend` that talks to the merchant's backend over HTTPS with JSON bodies.
///
/// - `baseURL` is the merchant backend's root, for example `https://api.example.com/` or `https://example.com/billing/`.
/// - `authorization` supplies the value of the `Authorization` header for each request (for example `"Bearer <user token>"`).
///   It is called per request, so it can refresh an expired token. Return `nil` to send no header.
/// - `paths` are the five relative paths, with `{sessionId}` and `{customerRef}` placeholders. The defaults are the
///   service's own routes; override them when the merchant's backend mounts them elsewhere.
public struct HTTPPurchaseBackend: PurchaseBackend {
    /// The five relative paths. A path is joined to `baseURL`; `{sessionId}` and `{customerRef}` are replaced by the
    /// percent-encoded value.
    public struct Paths: Sendable, Hashable {
        public var start: String
        public var session: String
        public var alternative: String
        public var complete: String
        public var entitlements: String

        public init(
            start: String = "v1/purchases",
            session: String = "v1/purchases/{sessionId}",
            alternative: String = "v1/purchases/{sessionId}/alternative",
            complete: String = "v1/purchases/{sessionId}/complete",
            entitlements: String = "v1/entitlements/{customerRef}"
        ) {
            self.start = start
            self.session = session
            self.alternative = alternative
            self.complete = complete
            self.entitlements = entitlements
        }

        public static let `default` = Paths()
    }

    /// Supplies the `Authorization` header value for one request.
    public typealias AuthorizationProvider = @Sendable () async throws -> String?

    public let baseURL: URL
    public let paths: Paths
    public let timeout: TimeInterval
    private let authorization: AuthorizationProvider
    private let urlSession: URLSession

    public init(
        baseURL: URL,
        authorization: @escaping AuthorizationProvider = { nil },
        paths: Paths = .default,
        timeout: TimeInterval = 30,
        urlSession: URLSession = .shared
    ) {
        self.baseURL = baseURL
        self.authorization = authorization
        self.paths = paths
        self.timeout = timeout
        self.urlSession = urlSession
    }

    // MARK: PurchaseBackend

    public func startPurchase(_ input: StartPurchaseInput) async throws -> PurchaseSession {
        try await send(.post, paths.start, [:], body: input)
    }

    public func purchase(sessionID: String) async throws -> PurchaseSession {
        try await send(.get, paths.session, [Placeholder.sessionId: sessionID], body: NoBody?.none)
    }

    public func chooseAlternative(sessionID: String, input: ChooseAlternativeInput) async throws -> PurchaseSession {
        try await send(.post, paths.alternative, [Placeholder.sessionId: sessionID], body: input)
    }

    public func completePurchase(sessionID: String, input: CompletePurchaseInput) async throws -> PurchaseSession {
        try await send(.post, paths.complete, [Placeholder.sessionId: sessionID], body: input)
    }

    public func entitlements(customerRef: String) async throws -> Entitlements {
        try await send(.get, paths.entitlements, [Placeholder.customerRef: customerRef], body: NoBody?.none)
    }

    // MARK: Plumbing

    private enum Method: String { case get = "GET", post = "POST" }

    private enum Placeholder {
        static let sessionId = "{sessionId}"
        static let customerRef = "{customerRef}"
    }

    private enum Header {
        static let authorization = "Authorization"
        static let accept = "Accept"
        static let contentType = "Content-Type"
        static let json = "application/json"
    }

    /// Characters a path segment may carry unescaped. `/` is escaped, so a value never adds a segment.
    private static let segmentAllowed: CharacterSet = {
        var set = CharacterSet.alphanumerics
        set.insert(charactersIn: "-._~")
        return set
    }()

    func url(for template: String, _ values: [String: String]) throws -> URL {
        var path = template
        for (placeholder, value) in values {
            guard let encoded = value.addingPercentEncoding(withAllowedCharacters: Self.segmentAllowed), !encoded.isEmpty else {
                throw PurchaseBackendError.invalidRequest("An empty or unencodable value for \(placeholder)")
            }
            path = path.replacingOccurrences(of: placeholder, with: encoded)
        }
        var base = baseURL.absoluteString
        while base.hasSuffix("/") { base.removeLast() }
        while path.hasPrefix("/") { path.removeFirst() }
        guard let url = URL(string: base + "/" + path) else {
            throw PurchaseBackendError.invalidRequest("Not a valid URL: \(base)/\(path)")
        }
        return url
    }

    private func send<Body: Encodable, Response: Decodable>(
        _ method: Method, _ template: String, _ values: [String: String], body: Body?
    ) async throws -> Response {
        var request = URLRequest(url: try url(for: template, values), timeoutInterval: timeout)
        request.httpMethod = method.rawValue
        request.setValue(Header.json, forHTTPHeaderField: Header.accept)
        if let body {
            request.httpBody = try JSONEncoder().encode(body)
            request.setValue(Header.json, forHTTPHeaderField: Header.contentType)
        }
        if let value = try await authorization() {
            request.setValue(value, forHTTPHeaderField: Header.authorization)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await urlSession.data(for: request)
        } catch let error as URLError where error.code == .cancelled {
            throw CancellationError()
        } catch let error as URLError {
            throw PurchaseBackendError.transport(code: error.errorCode, description: error.localizedDescription)
        }
        guard let http = response as? HTTPURLResponse else {
            throw PurchaseBackendError.malformedResponse(statusCode: 0, detail: "Not an HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            throw PurchaseBackendError.server(Self.serverError(status: http.statusCode, data: data))
        }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            throw PurchaseBackendError.malformedResponse(statusCode: http.statusCode, detail: String(describing: error))
        }
    }

    /// The service's error body: `{ "error": { "code", "message", "provider"?, "providerCode"?, "retryable" } }`.
    private struct ErrorEnvelope: Decodable {
        struct Detail: Decodable {
            var code: ServerErrorCode
            var message: String
            var provider: String?
            var providerCode: String?
            var retryable: Bool?
        }
        var error: Detail
    }

    static func serverError(status: Int, data: Data) -> ServerError {
        if let envelope = try? JSONDecoder().decode(ErrorEnvelope.self, from: data) {
            let detail = envelope.error
            return ServerError(
                statusCode: status, code: detail.code, message: detail.message, provider: detail.provider,
                providerCode: detail.providerCode, retryable: detail.retryable
            )
        }
        // Not the service's shape: a proxy, a gateway page or a backend that wraps errors its own way.
        let code: ServerErrorCode
        switch status {
        case 401, 403: code = .unauthorized
        case 404: code = .notFound
        case 408: code = .timeout
        case 429: code = .rateLimited
        case 400, 405, 409, 413, 422: code = .validation
        case 503: code = .providerUnavailable
        case 504: code = .timeout
        default: code = status >= 500 ? .internalError : .validation
        }
        return ServerError(
            statusCode: status, code: code, message: HTTPURLResponse.localizedString(forStatusCode: status), isStructured: false
        )
    }
}

/// The body type of a call that sends none.
private struct NoBody: Encodable {}
