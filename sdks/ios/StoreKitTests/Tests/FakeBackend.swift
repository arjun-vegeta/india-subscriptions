import Foundation
import StoreKit
@testable import IndiaSubscriptions

/// A merchant backend that mints App Store sessions and checks what the device sends the way the real one does: the
/// signed transaction must carry the account token of the session.
actor FakeBackend: PurchaseBackend {
    /// product key -> App Store Connect product id
    var catalog: [String: String] = [
        "pro_monthly": "in.example.pro.monthly",
        "coins_100": "in.example.coins100",
        "lifetime": "in.example.lifetime",
    ]

    private(set) var startCalls: [StartPurchaseInput] = []
    private(set) var completeCalls: [(sessionID: String, signedTransaction: String)] = []
    private(set) var sessions: [String: PurchaseSession] = [:]

    /// Errors thrown by the next `completePurchase` calls, one per call, before it behaves normally again.
    private var completeFailures: [Error] = []
    /// When set, every `completePurchase` call fails with this error.
    private var completeAlwaysFails: Error?
    /// The status `completePurchase` answers with.
    var settleStatus: SessionStatus = .completed
    /// Called with the session id as `completePurchase` begins (after recording the call).
    private var onComplete: (@Sendable (String) async throws -> Void)?
    var entitlementsAnswer: Entitlements?

    func setCompleteFailures(_ errors: [Error]) { completeFailures = errors }
    func setCompleteAlwaysFails(_ error: Error?) { completeAlwaysFails = error }
    func setSettleStatus(_ status: SessionStatus) { settleStatus = status }
    func setOnComplete(_ hook: (@Sendable (String) async throws -> Void)?) { onComplete = hook }
    func setEntitlements(_ entitlements: Entitlements) { entitlementsAnswer = entitlements }
    func setCatalog(_ key: String, _ productID: String) { catalog[key] = productID }

    // MARK: PurchaseBackend

    func startPurchase(_ input: StartPurchaseInput) async throws -> PurchaseSession {
        startCalls.append(input)
        guard let productID = catalog[input.product] else {
            throw PurchaseBackendError.server(ServerError(statusCode: 404, code: .notFound, message: "Unknown product \(input.product)"))
        }
        let token = UUID()
        let now = Date()
        let session = PurchaseSession(
            id: "ps_\(UUID().uuidString.prefix(8))", platform: input.platform, product: input.product, policy: .store, status: .open,
            customerRef: input.customerRef, reference: input.reference,
            options: [
                PurchaseOption(
                    channel: .store, provider: .appStore,
                    checkout: .appleStoreKit(AppleStoreKitCheckout(productId: productID, appAccountToken: token)),
                    handle: token.uuidString.lowercased()
                )
            ],
            createdAt: now, expiresAt: now.addingTimeInterval(86_400)
        )
        sessions[session.id] = session
        return session
    }

    func purchase(sessionID: String) async throws -> PurchaseSession {
        guard let session = sessions[sessionID] else { throw Self.notFound(sessionID) }
        return session
    }

    func chooseAlternative(sessionID: String, input: ChooseAlternativeInput) async throws -> PurchaseSession {
        guard let session = sessions[sessionID] else { throw Self.notFound(sessionID) }
        return session
    }

    func completePurchase(sessionID: String, input: CompletePurchaseInput) async throws -> PurchaseSession {
        guard var session = sessions[sessionID] else { throw Self.notFound(sessionID) }
        let jws = input.result["signedTransaction"] ?? ""
        completeCalls.append((sessionID, jws))
        XCTAssertEqualOnActor(input.provider, .appStore)
        if let hook = onComplete { try await hook(sessionID) }
        if let always = completeAlwaysFails { throw always }
        if !completeFailures.isEmpty { throw completeFailures.removeFirst() }

        // What the real adapter checks: the signed transaction belongs to this order.
        guard let claims = JWSClaims(jws), claims.appAccountToken == session.options[0].handle else {
            throw PurchaseBackendError.server(
                ServerError(statusCode: 401, code: .signatureInvalid, message: "The transaction belongs to another order")
            )
        }
        if session.status == .completed { return session }
        session.status = settleStatus
        if settleStatus == .completed {
            session.completedAt = Date()
            session.subscriptionId = claims.originalTransactionId
            session.provider = .appStore
        }
        sessions[sessionID] = session
        return session
    }

    func entitlements(customerRef: String) async throws -> Entitlements {
        entitlementsAnswer ?? Entitlements(customerRef: customerRef, active: false, items: [])
    }

    private static func notFound(_ id: String) -> PurchaseBackendError {
        .server(ServerError(statusCode: 404, code: .notFound, message: "No session \(id)"))
    }
}

private func XCTAssertEqualOnActor(_ a: Provider, _ b: Provider) { precondition(a == b, "the SDK sent a provider other than app_store") }

extension Entitlements {
    init(customerRef: String, active: Bool, items: [EntitlementItem]) {
        self = try! JSONDecoder().decode(
            Entitlements.self, from: Data(#"{"customerRef":"\#(customerRef)","active":\#(active),"items":[]}"#.utf8)
        )
        self.items = items
    }
}

/// The claims of a StoreKit JWS (`Transaction.jwsRepresentation`), read without verifying the signature.
struct JWSClaims {
    var appAccountToken: String?
    var productId: String?
    var transactionId: String?
    var originalTransactionId: String?

    init?(_ jws: String) {
        let parts = jws.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var base64 = String(parts[1]).replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        guard let data = Data(base64Encoded: base64), let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        appAccountToken = (object["appAccountToken"] as? String)?.lowercased()
        productId = object["productId"] as? String
        transactionId = object["transactionId"] as? String
        originalTransactionId = object["originalTransactionId"] as? String
    }
}
