import Foundation
import IndiaSubscriptions
import UIKit

/// The Swift half of the bridge. It translates calls into `PurchaseClient` calls and its results and events into
/// dictionaries; it holds no purchase logic. The Objective-C++ module (`IndiaSubscriptionsReactNative.mm`) forwards to it.
///
/// Threading: every call starts a `Task`; the client is an actor, so nothing here needs a lock except the
/// authorisation value and the event forwarding, which are touched from several threads. Events arrive on whatever
/// thread the client's stream is read on and go to React Native's thread-safe emitter.
///
/// Lifecycle: `detach()` runs when JavaScript reloads and ends this instance's event forwarding. The client lives in
/// `Runtime` for the life of the process, and the next `configure` call replaces it. A purchase that was running keeps
/// running; the SDK finishes it from its own records.
@objc(IndiaSubscriptionsBridge)
public final class IndiaSubscriptionsBridge: NSObject, @unchecked Sendable {
    public typealias Resolve = (Any?) -> Void
    public typealias Reject = (String, String, NSError?) -> Void

    private let lock = NSLock()
    private var sink: (([String: Any]) -> Void)?
    private var forwarding: Task<Void, Never>?
    private var forwardingFrom: ObjectIdentifier?

    @objc public override init() { super.init() }

    @objc public func setEventSink(_ sink: @escaping (NSDictionary) -> Void) {
        lock.lock()
        self.sink = { sink($0 as NSDictionary) }
        lock.unlock()
    }

    @objc public func detach() {
        lock.lock()
        sink = nil
        forwarding?.cancel()
        forwarding = nil
        forwardingFrom = nil
        lock.unlock()
    }

    // MARK: Configuration

    @objc(configure:resolve:reject:)
    public func configure(_ options: NSDictionary, resolve: @escaping Resolve, reject: @escaping Reject) {
        let input = Options(options)
        guard let baseUrl = input.string("baseUrl"), let url = URL(string: baseUrl),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http", url.host != nil
        else {
            return Failure.reject(reject, code: .invalidArgument, "baseUrl must be an http(s) URL")
        }
        let headers = (input.dictionary("headers") as? [String: Any])?.compactMapValues { $0 as? String } ?? [:]
        if headers.keys.contains(where: { $0.caseInsensitiveCompare("Authorization") == .orderedSame }) {
            return Failure.reject(reject, code: .invalidArgument, "Set the Authorization header with `authorization`, not `headers`")
        }

        // An omitted value keeps the one set earlier (a reload calls configure again before the app has a fresh token).
        if options["authorization"] != nil { Runtime.authorization.set(input.string("authorization")) }

        let sessionConfiguration = URLSessionConfiguration.default
        if !headers.isEmpty { sessionConfiguration.httpAdditionalHeaders = headers }
        let defaults = HTTPPurchaseBackend.Paths()
        let given = input.dictionary("paths").map(Options.init)
        let paths = HTTPPurchaseBackend.Paths(
            start: given?.string("start") ?? defaults.start,
            session: given?.string("session") ?? defaults.session,
            alternative: given?.string("alternative") ?? defaults.alternative,
            complete: given?.string("complete") ?? defaults.complete,
            entitlements: given?.string("entitlements") ?? defaults.entitlements
        )
        let backend = HTTPPurchaseBackend(
            baseURL: url,
            authorization: { Runtime.authorization.get() },
            paths: paths,
            timeout: input.double("timeoutMs").map { $0 / 1000 } ?? 30,
            urlSession: URLSession(configuration: sessionConfiguration)
        )

        var configuration = PurchaseClient.Configuration()
        if let value = input.int("maxCompletionAttempts") { configuration.maxCompletionAttempts = value }
        if let value = input.double("retryDelayMs") { configuration.retryDelay = value / 1000 }
        if let value = input.int("maxServerFailures") { configuration.maxServerFailures = value }
        if let value = input.dictionary("ios").map(Options.init)?.bool("finishUnmatchedTransactions") {
            configuration.finishUnmatchedTransactions = value
        }

        let client = PurchaseClient(backend: backend, configuration: configuration)
        let previous = Runtime.replace(client)
        Task {
            await previous?.stop()
            self.forward(from: client)
            resolve(nil)
        }
    }

    @objc(setAuthorization:resolve:reject:)
    public func setAuthorization(_ value: String?, resolve: @escaping Resolve, reject: @escaping Reject) {
        Runtime.authorization.set(value)
        resolve(nil)
    }

    @objc(start:reject:)
    public func start(_ resolve: @escaping Resolve, reject: @escaping Reject) {
        guard let client = requireClient(reject) else { return }
        forward(from: client)
        Task {
            await client.start()
            resolve(nil)
        }
    }

    @objc(stop:reject:)
    public func stop(_ resolve: @escaping Resolve, reject: @escaping Reject) {
        guard let client = Runtime.client() else { return resolve(nil) }
        Task {
            await client.stop()
            resolve(nil)
        }
    }

    // MARK: Purchases

    @objc(purchase:options:resolve:reject:)
    public func purchase(_ product: String, options: NSDictionary, resolve: @escaping Resolve, reject: @escaping Reject) {
        guard let client = requireClient(reject) else { return }
        let input = Options(options)
        guard let customerRef = input.string("customerRef"), !customerRef.isEmpty else {
            return Failure.reject(reject, code: .invalidArgument, "customerRef is required")
        }
        let customer = input.dictionary("customer").map(Options.init).map {
            Customer(id: $0.string("id"), name: $0.string("name"), email: $0.string("email"), phone: $0.string("phone"), state: $0.string("state"))
        } ?? Customer()
        forward(from: client)
        run(resolve, reject) {
            Wire.outcome(
                try await client.purchase(
                    product: product, customerRef: customerRef, customer: customer,
                    reference: input.string("reference"), returnUrl: input.string("returnUrl").flatMap(URL.init(string:))
                )
            )
        }
    }

    @objc(processPending:reject:)
    public func processPending(_ resolve: @escaping Resolve, reject: @escaping Reject) {
        guard let client = requireClient(reject) else { return }
        forward(from: client)
        run(resolve, reject) { Wire.events(await client.processUnfinishedTransactions()) }
    }

    @objc(retryRejected:reject:)
    public func retryRejected(_ resolve: @escaping Resolve, reject: @escaping Reject) {
        guard let client = requireClient(reject) else { return }
        forward(from: client)
        run(resolve, reject) { Wire.events(await client.retryRejectedTransactions()) }
    }

    @objc(restorePurchases:resolve:reject:)
    public func restorePurchases(_ customerRef: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        guard let client = requireClient(reject) else { return }
        forward(from: client)
        run(resolve, reject) { Wire.entitlements(try await client.restorePurchases(customerRef: customerRef)) }
    }

    @objc(entitlements:resolve:reject:)
    public func entitlements(_ customerRef: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        guard let client = requireClient(reject) else { return }
        run(resolve, reject) { Wire.entitlements(try await client.entitlements(customerRef: customerRef)) }
    }

    // MARK: Platform-specific

    @objc(showManageSubscriptions:reject:)
    public func showManageSubscriptions(_ resolve: @escaping Resolve, reject: @escaping Reject) {
        Task { @MainActor in
            guard let scene = Self.foregroundScene() else {
                return Failure.reject(reject, code: .noWindowScene, "There is no foreground window scene to present the sheet from")
            }
            do {
                try await AppStoreSheets.showManageSubscriptions(in: scene)
                resolve(nil)
            } catch {
                Failure.reject(reject, error)
            }
        }
    }

    @objc(requestRefund:resolve:reject:)
    public func requestRefund(_ transactionId: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        guard let id = UInt64(transactionId) else {
            return Failure.reject(reject, code: .invalidArgument, "transactionId must be a decimal transaction id")
        }
        Task { @MainActor in
            guard let scene = Self.foregroundScene() else {
                return Failure.reject(reject, code: .noWindowScene, "There is no foreground window scene to present the sheet from")
            }
            do {
                let outcome = try await AppStoreSheets.requestRefund(forTransaction: id, in: scene)
                resolve(["outcome": String(describing: outcome)])
            } catch {
                Failure.reject(reject, error)
            }
        }
    }

    @objc(subscriptionManagementUrl:resolve:reject:)
    public func subscriptionManagementUrl(_ productId: String?, resolve: @escaping Resolve, reject: @escaping Reject) {
        Failure.reject(reject, code: .notApplicable, "getSubscriptionManagementUrl applies to Android only", ["appliesTo": "android"])
    }

    @objc(handleReturnLink:resolve:reject:)
    public func handleReturnLink(_ url: String, resolve: @escaping Resolve, reject: @escaping Reject) {
        Failure.reject(reject, code: .notApplicable, "handleReturnLink applies to Android only", ["appliesTo": "android"])
    }

    // MARK: Plumbing

    private func requireClient(_ reject: Reject) -> PurchaseClient? {
        let client = Runtime.client()
        if client == nil { Failure.reject(reject, code: .notConfigured, "Call configure before any other method") }
        return client
    }

    /// Runs an async call and settles the promise with its result or its translated error.
    private func run(_ resolve: @escaping Resolve, _ reject: @escaping Reject, _ block: @escaping () async throws -> Any?) {
        Task {
            do {
                resolve(try await block())
            } catch {
                Failure.reject(reject, error)
            }
        }
    }

    /// Forwards the client's events to JavaScript. One forwarder per bridge instance and client.
    private func forward(from client: PurchaseClient) {
        lock.lock()
        defer { lock.unlock() }
        guard sink != nil else { return }
        let identity = ObjectIdentifier(client)
        if forwardingFrom == identity, forwarding?.isCancelled == false { return }
        forwarding?.cancel()
        forwardingFrom = identity
        let stream = client.events
        forwarding = Task { [weak self] in
            for await event in stream {
                guard let self else { return }
                self.currentSink()?(Wire.event(event))
            }
        }
    }

    private func currentSink() -> (([String: Any]) -> Void)? {
        lock.lock()
        defer { lock.unlock() }
        return sink
    }

    @MainActor
    private static func foregroundScene() -> UIWindowScene? {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first { $0.activationState == .foregroundInactive }
    }
}
