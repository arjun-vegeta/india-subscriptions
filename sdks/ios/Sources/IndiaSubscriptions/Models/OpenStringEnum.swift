import Foundation

/// A string-valued enumeration that stays open: a value this version of the SDK does not know decodes into
/// `init(rawValue:)` instead of failing, so a newer server never breaks decoding. Compare against the static members
/// (`status == .completed`) or switch with a `default` branch.
public protocol OpenStringEnum: RawRepresentable, Hashable, Codable, Sendable, ExpressibleByStringLiteral, CustomStringConvertible
where RawValue == String {
    init(rawValue: String)
}

extension OpenStringEnum {
    public init(stringLiteral value: String) { self.init(rawValue: value) }
    public init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        self.init(rawValue: try container.decode(String.self))
    }
    public func encode(to encoder: Encoder) throws {
        var container = encoder.singleValueContainer()
        try container.encode(rawValue)
    }
    public var description: String { rawValue }
}

/// The platform a customer buys on. This SDK always sends `ios`.
public struct Platform: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let ios: Platform = "ios"
    public static let android: Platform = "android"
    public static let web: Platform = "web"
}

/// The provider that holds a purchase. On iPhone it is `appStore`.
public struct Provider: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let appStore: Provider = "app_store"
    public static let googlePlay: Provider = "google_play"
    public static let razorpay: Provider = "razorpay"
    public static let cashfree: Provider = "cashfree"
    public static let payu: Provider = "payu"
    public static let phonepe: Provider = "phonepe"
    public static let paytm: Provider = "paytm"
}

/// Where purchases on a platform may be taken.
public struct ChannelPolicy: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let store: ChannelPolicy = "store"
    public static let userChoice: ChannelPolicy = "user_choice"
    public static let gateways: ChannelPolicy = "gateways"
}

/// The channel a purchase went through.
public struct SalesChannel: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let store: SalesChannel = "store"
    public static let gateway: SalesChannel = "gateway"
}

/// What a product is.
public struct ProductKind: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let subscription: ProductKind = "subscription"
    public static let oneTime: ProductKind = "one_time"
}

/// Where a purchase session is in its life.
public struct SessionStatus: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    /// Created; the customer has not come back from the checkout.
    public static let open: SessionStatus = "open"
    /// Paid or approved but not confirmed by the provider yet.
    public static let awaitingPayment: SessionStatus = "awaiting_payment"
    /// Paid or authorised and recorded as an entitlement.
    public static let completed: SessionStatus = "completed"
    /// A verification said the purchase was not paid. A later payment still completes it.
    public static let failed: SessionStatus = "failed"
    /// The session passed `expiresAt` without a payment.
    public static let expired: SessionStatus = "expired"
}

/// What a customer owns, per entitlement item.
public struct EntitlementStatus: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let active: EntitlementStatus = "active"
    public static let trialing: EntitlementStatus = "trialing"
    public static let pastDue: EntitlementStatus = "past_due"
    public static let paused: EntitlementStatus = "paused"
    public static let halted: EntitlementStatus = "halted"
    public static let cancelled: EntitlementStatus = "cancelled"
    public static let expired: EntitlementStatus = "expired"
    public static let refunded: EntitlementStatus = "refunded"
}

/// How a gateway attempt of a session ended.
public struct AttemptOutcome: OpenStringEnum {
    public let rawValue: String
    public init(rawValue: String) { self.rawValue = rawValue }
    public static let created: AttemptOutcome = "created"
    public static let failed: AttemptOutcome = "failed"
}
