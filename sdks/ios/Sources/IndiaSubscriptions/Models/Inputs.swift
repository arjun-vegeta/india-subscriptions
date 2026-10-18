import Foundation

/// A customer: identity and contact details.
public struct Customer: Codable, Hashable, Sendable {
    public var id: String?
    public var name: String?
    public var email: String?
    /// Mobile number; 10 digits or E.164.
    public var phone: String?
    /// The customer's state or union territory in India (for example "Karnataka").
    public var state: String?

    public init(id: String? = nil, name: String? = nil, email: String? = nil, phone: String? = nil, state: String? = nil) {
        self.id = id
        self.name = name
        self.email = email
        self.phone = phone
        self.state = state
    }
}

/// The body of the start call.
public struct StartPurchaseInput: Codable, Hashable, Sendable {
    public var platform: Platform
    /// The key of the product.
    public var product: String
    public var customer: Customer
    /// Your id for the customer: entitlements are kept under it.
    public var customerRef: String
    /// Your own id for the purchase: at most 25 characters of letters, digits, `_` and `-`. Starting again with the same
    /// reference and customer returns the same session.
    public var reference: String?
    public var returnUrl: URL?

    public init(
        platform: Platform = .ios, product: String, customer: Customer = Customer(), customerRef: String,
        reference: String? = nil, returnUrl: URL? = nil
    ) {
        self.platform = platform
        self.product = product
        self.customer = customer
        self.customerRef = customerRef
        self.reference = reference
        self.returnUrl = returnUrl
    }
}

/// The body of the alternative call (Google Play user choice billing). Not used on iPhone; part of the backend contract.
public struct ChooseAlternativeInput: Codable, Hashable, Sendable {
    public var externalTransactionToken: String
    public init(externalTransactionToken: String) { self.externalTransactionToken = externalTransactionToken }
}

/// The body of the complete call: what the provider handed back to the device, untouched.
public struct CompletePurchaseInput: Codable, Hashable, Sendable {
    public var provider: Provider
    public var result: [String: String]

    public init(provider: Provider, result: [String: String]) {
        self.provider = provider
        self.result = result
    }

    /// The App Store form: `{ "signedTransaction": "<the StoreKit JWS>" }`.
    public static func appStore(signedTransaction: String) -> CompletePurchaseInput {
        CompletePurchaseInput(provider: .appStore, result: [signedTransactionKey: signedTransaction])
    }

    static let signedTransactionKey = "signedTransaction"
}
