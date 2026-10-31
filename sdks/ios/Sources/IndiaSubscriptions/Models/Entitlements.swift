import Foundation

/// One purchase the customer owns or owned.
public struct EntitlementItem: Codable, Hashable, Sendable {
    /// The key of the product.
    public var product: String
    public var kind: ProductKind
    /// The provider that holds the purchase.
    public var provider: Provider
    public var channel: SalesChannel
    /// The platform the customer bought on.
    public var platform: Platform
    public var subscriptionId: String?
    public var paymentId: String?
    public var status: EntitlementStatus
    /// True when the item gives access now.
    public var active: Bool
    /// True when the subscription ends at the end of the current period.
    public var cancelAtPeriodEnd: Bool?
    /// End of the current paid period, where known.
    public var currentPeriodEnd: Date?
    public var updatedAt: Date

    public init(
        product: String, kind: ProductKind, provider: Provider, channel: SalesChannel, platform: Platform,
        subscriptionId: String? = nil, paymentId: String? = nil, status: EntitlementStatus, active: Bool,
        cancelAtPeriodEnd: Bool? = nil, currentPeriodEnd: Date? = nil, updatedAt: Date
    ) {
        self.product = product
        self.kind = kind
        self.provider = provider
        self.channel = channel
        self.platform = platform
        self.subscriptionId = subscriptionId
        self.paymentId = paymentId
        self.status = status
        self.active = active
        self.cancelAtPeriodEnd = cancelAtPeriodEnd
        self.currentPeriodEnd = currentPeriodEnd
        self.updatedAt = updatedAt
    }
}

/// What a customer owns, across app stores and gateways. The server is the source of truth for it.
public struct Entitlements: Codable, Hashable, Sendable {
    public var customerRef: String
    /// True when at least one item gives access now.
    public var active: Bool
    /// Every purchase of the customer, newest change first, including ended ones.
    public var items: [EntitlementItem]

    public init(customerRef: String, active: Bool, items: [EntitlementItem] = []) {
        self.customerRef = customerRef
        self.active = active
        self.items = items
    }

    /// The items that give access now.
    public var activeItems: [EntitlementItem] { items.filter(\.active) }

    /// Whether the customer has an active item for the product key.
    public func hasAccess(to product: String) -> Bool {
        items.contains { $0.product == product && $0.active }
    }
}
