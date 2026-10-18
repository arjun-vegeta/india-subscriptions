import Foundation

/// The five calls the SDK makes to the merchant's backend, which forwards them to the service. The app never holds the
/// service's API key: the backend authenticates the user and calls the service.
///
/// `HTTPPurchaseBackend` is the ready-made implementation. Implement the protocol yourself to reach the backend through
/// another transport, or to fake it in tests. Implementations throw `PurchaseBackendError` (or any other error: a
/// failure that is not a `PurchaseBackendError` is treated as one that may succeed later).
public protocol PurchaseBackend: Sendable {
    /// `POST /v1/purchases`: starts a session for a product key.
    func startPurchase(_ input: StartPurchaseInput) async throws -> PurchaseSession

    /// `GET /v1/purchases/{sessionId}`.
    func purchase(sessionID: String) async throws -> PurchaseSession

    /// `POST /v1/purchases/{sessionId}/alternative`. Used by Android's user choice billing; part of the contract for completeness.
    func chooseAlternative(sessionID: String, input: ChooseAlternativeInput) async throws -> PurchaseSession

    /// `POST /v1/purchases/{sessionId}/complete`: hands the provider's result to the server, which verifies it.
    func completePurchase(sessionID: String, input: CompletePurchaseInput) async throws -> PurchaseSession

    /// `GET /v1/entitlements/{customerRef}`: what the customer owns.
    func entitlements(customerRef: String) async throws -> Entitlements
}
