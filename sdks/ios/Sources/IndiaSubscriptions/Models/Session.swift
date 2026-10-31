import Foundation

/// One way the customer can pay for a session.
public struct PurchaseOption: Codable, Hashable, Sendable {
    /// `store` for an app store, `gateway` for a payment gateway.
    public var channel: SalesChannel
    /// The provider that holds the purchase.
    public var provider: Provider
    /// What the device must do to pay.
    public var checkout: CheckoutInstruction
    /// The id the provider returned when the purchase was created. For a store it is the account token.
    public var handle: String

    public init(channel: SalesChannel, provider: Provider, checkout: CheckoutInstruction, handle: String) {
        self.channel = channel
        self.provider = provider
        self.checkout = checkout
        self.handle = handle
    }
}

/// One gateway tried while creating the purchase.
public struct PurchaseAttempt: Codable, Hashable, Sendable {
    public var provider: Provider
    public var outcome: AttemptOutcome
    public var at: Date
    public var errorCode: String?
    public var message: String?

    public init(provider: Provider, outcome: AttemptOutcome, at: Date, errorCode: String? = nil, message: String? = nil) {
        self.provider = provider
        self.outcome = outcome
        self.at = at
        self.errorCode = errorCode
        self.message = message
    }
}

/// A purchase in progress or done: where the customer may pay and how it ended.
public struct PurchaseSession: Codable, Hashable, Sendable {
    /// The session id. Whoever holds it can complete the session, so keep it out of logs.
    public var id: String
    public var platform: Platform
    /// The key of the product.
    public var product: String
    /// The channel policy the session was resolved with.
    public var policy: ChannelPolicy
    public var status: SessionStatus
    public var customerRef: String
    public var reference: String?
    public var options: [PurchaseOption]
    public var attempts: [PurchaseAttempt]
    public var externalTransactionToken: String?
    public var createdAt: Date
    /// When an unpaid session expires.
    public var expiresAt: Date
    public var completedAt: Date?
    public var subscriptionId: String?
    public var paymentId: String?
    /// The provider the purchase was confirmed at.
    public var provider: Provider?

    public init(
        id: String, platform: Platform, product: String, policy: ChannelPolicy, status: SessionStatus,
        customerRef: String, reference: String? = nil, options: [PurchaseOption], attempts: [PurchaseAttempt] = [],
        externalTransactionToken: String? = nil, createdAt: Date, expiresAt: Date, completedAt: Date? = nil,
        subscriptionId: String? = nil, paymentId: String? = nil, provider: Provider? = nil
    ) {
        self.id = id
        self.platform = platform
        self.product = product
        self.policy = policy
        self.status = status
        self.customerRef = customerRef
        self.reference = reference
        self.options = options
        self.attempts = attempts
        self.externalTransactionToken = externalTransactionToken
        self.createdAt = createdAt
        self.expiresAt = expiresAt
        self.completedAt = completedAt
        self.subscriptionId = subscriptionId
        self.paymentId = paymentId
        self.provider = provider
    }

    private enum CodingKeys: String, CodingKey {
        case id, platform, product, policy, status, customerRef, reference, options, attempts
        case externalTransactionToken, createdAt, expiresAt, completedAt, subscriptionId, paymentId, provider
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        platform = try c.decode(Platform.self, forKey: .platform)
        product = try c.decode(String.self, forKey: .product)
        policy = try c.decode(ChannelPolicy.self, forKey: .policy)
        status = try c.decode(SessionStatus.self, forKey: .status)
        customerRef = try c.decode(String.self, forKey: .customerRef)
        reference = try c.decodeIfPresent(String.self, forKey: .reference)
        options = try c.decode([PurchaseOption].self, forKey: .options)
        attempts = try c.decodeIfPresent([PurchaseAttempt].self, forKey: .attempts) ?? []
        externalTransactionToken = try c.decodeIfPresent(String.self, forKey: .externalTransactionToken)
        createdAt = try c.decode(Date.self, forKey: .createdAt)
        expiresAt = try c.decode(Date.self, forKey: .expiresAt)
        completedAt = try c.decodeIfPresent(Date.self, forKey: .completedAt)
        subscriptionId = try c.decodeIfPresent(String.self, forKey: .subscriptionId)
        paymentId = try c.decodeIfPresent(String.self, forKey: .paymentId)
        provider = try c.decodeIfPresent(Provider.self, forKey: .provider)
    }

    /// The App Store option of the session and its StoreKit instruction, if the session has one.
    public var appStoreOption: (option: PurchaseOption, checkout: AppleStoreKitCheckout)? {
        for option in options where option.provider == .appStore {
            if case .appleStoreKit(let checkout) = option.checkout { return (option, checkout) }
        }
        return nil
    }
}
