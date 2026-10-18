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
}

/// What a customer owns, across app stores and gateways. The server is the source of truth for it.
public struct Entitlements: Codable, Hashable, Sendable {
    public var customerRef: String
    /// True when at least one item gives access now.
    public var active: Bool
    /// Every purchase of the customer, newest change first, including ended ones.
    public var items: [EntitlementItem]

    /// The items that give access now.
    public var activeItems: [EntitlementItem] { items.filter(\.active) }

    /// Whether the customer has an active item for the product key.
    public func hasAccess(to product: String) -> Bool {
        items.contains { $0.product == product && $0.active }
    }
}
