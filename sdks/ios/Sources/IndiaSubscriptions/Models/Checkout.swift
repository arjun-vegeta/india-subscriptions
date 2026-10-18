import Foundation

/// A signed promotional offer the server made for this purchase, to pass to StoreKit.
public struct PromotionalOffer: Codable, Hashable, Sendable {
    /// The promotional offer id.
    public var offerId: String
    /// The id of the key that signed the offer.
    public var keyId: String
    /// A one-time UUID for this signature.
    public var nonce: UUID
    /// When the signature was made, in milliseconds since the Unix epoch.
    public var timestamp: Int
    /// The signature, Base64 text of the DER-encoded ECDSA signature.
    public var signature: String

    public init(offerId: String, keyId: String, nonce: UUID, timestamp: Int, signature: String) {
        self.offerId = offerId
        self.keyId = keyId
        self.nonce = nonce
        self.timestamp = timestamp
        self.signature = signature
    }
}

/// Purchase through StoreKit on an Apple device: the `apple_storekit` checkout instruction.
public struct AppleStoreKitCheckout: Codable, Hashable, Sendable {
    /// The App Store Connect product id to purchase.
    public var productId: String
    /// Passed to StoreKit's `appAccountToken` purchase option; ties the purchase to this order.
    public var appAccountToken: UUID
    /// A signed promotional offer to apply to the purchase.
    public var promotionalOffer: PromotionalOffer?

    public init(productId: String, appAccountToken: UUID, promotionalOffer: PromotionalOffer? = nil) {
        self.productId = productId
        self.appAccountToken = appAccountToken
        self.promotionalOffer = promotionalOffer
    }
}

/// What the device must do to pay. Only the App Store kind is typed; every other kind a server sends (a gateway
/// redirect, Google Play Billing, a kind added later) decodes as `.other` and carries just its `kind` string.
public enum CheckoutInstruction: Hashable, Sendable {
    case appleStoreKit(AppleStoreKitCheckout)
    case other(kind: String)

    /// The `kind` string of the instruction.
    public var kind: String {
        switch self {
        case .appleStoreKit: return CheckoutInstruction.appleStoreKitKind
        case .other(let kind): return kind
        }
    }

    static let appleStoreKitKind = "apple_storekit"
}

extension CheckoutInstruction: Codable {
    private enum KindKey: String, CodingKey { case kind }

    public init(from decoder: Decoder) throws {
        let kind = try decoder.container(keyedBy: KindKey.self).decode(String.self, forKey: .kind)
        if kind == Self.appleStoreKitKind {
            self = .appleStoreKit(try AppleStoreKitCheckout(from: decoder))
        } else {
            self = .other(kind: kind)
        }
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: KindKey.self)
        try container.encode(kind, forKey: .kind)
        if case .appleStoreKit(let checkout) = self {
            try checkout.encode(to: encoder)
        }
    }
}
