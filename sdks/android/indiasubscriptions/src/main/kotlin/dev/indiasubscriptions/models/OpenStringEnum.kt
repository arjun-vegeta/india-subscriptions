package dev.indiasubscriptions.models

/*
 * String-valued enumerations that stay open: a value this version of the SDK does not know is kept as it is instead of
 * failing the decoding, so a newer server never breaks the app. Compare against the companion constants
 * (`status == SessionStatus.Completed`) and handle `else` in a `when`.
 */

/** The platform a customer buys on. This SDK always sends [Android]. */
@JvmInline
public value class Platform(public val value: String) {
    public companion object {
        public val Ios: Platform = Platform("ios")
        public val Android: Platform = Platform("android")
        public val Web: Platform = Platform("web")
    }

    override fun toString(): String = value
}

/** The provider that holds a purchase. On Android it is [GooglePlay], or a payment gateway for a hosted checkout. */
@JvmInline
public value class Provider(public val value: String) {
    public companion object {
        public val AppStore: Provider = Provider("app_store")
        public val GooglePlay: Provider = Provider("google_play")
        public val Razorpay: Provider = Provider("razorpay")
        public val Cashfree: Provider = Provider("cashfree")
        public val PayU: Provider = Provider("payu")
        public val PhonePe: Provider = Provider("phonepe")
        public val Paytm: Provider = Provider("paytm")
    }

    override fun toString(): String = value
}

/** Where purchases on a platform may be taken. */
@JvmInline
public value class ChannelPolicy(public val value: String) {
    public companion object {
        /** Google Play only. */
        public val Store: ChannelPolicy = ChannelPolicy("store")

        /** Google Play with its choice screen offering a payment gateway. */
        public val UserChoice: ChannelPolicy = ChannelPolicy("user_choice")

        /** Payment gateways only. */
        public val Gateways: ChannelPolicy = ChannelPolicy("gateways")
    }

    override fun toString(): String = value
}

/** The channel a purchase goes through. */
@JvmInline
public value class SalesChannel(public val value: String) {
    public companion object {
        public val Store: SalesChannel = SalesChannel("store")
        public val Gateway: SalesChannel = SalesChannel("gateway")
    }

    override fun toString(): String = value
}

/** What a product is. */
@JvmInline
public value class ProductKind(public val value: String) {
    public companion object {
        public val Subscription: ProductKind = ProductKind("subscription")
        public val OneTime: ProductKind = ProductKind("one_time")
    }

    override fun toString(): String = value
}

/** Where a purchase session is in its life. */
@JvmInline
public value class SessionStatus(public val value: String) {
    public companion object {
        /** Created; the customer has not come back from the checkout. */
        public val Open: SessionStatus = SessionStatus("open")

        /** Paid or approved but not confirmed by the provider yet. */
        public val AwaitingPayment: SessionStatus = SessionStatus("awaiting_payment")

        /** Paid or authorised and recorded as an entitlement. */
        public val Completed: SessionStatus = SessionStatus("completed")

        /** A verification said the purchase was not paid. A later payment still completes it. */
        public val Failed: SessionStatus = SessionStatus("failed")

        /** The session passed `expiresAt` without a payment. */
        public val Expired: SessionStatus = SessionStatus("expired")
    }

    override fun toString(): String = value
}

/** What a customer owns, per entitlement item. */
@JvmInline
public value class EntitlementStatus(public val value: String) {
    public companion object {
        public val Active: EntitlementStatus = EntitlementStatus("active")
        public val Trialing: EntitlementStatus = EntitlementStatus("trialing")
        public val PastDue: EntitlementStatus = EntitlementStatus("past_due")
        public val Paused: EntitlementStatus = EntitlementStatus("paused")
        public val Halted: EntitlementStatus = EntitlementStatus("halted")
        public val Cancelled: EntitlementStatus = EntitlementStatus("cancelled")
        public val Expired: EntitlementStatus = EntitlementStatus("expired")
        public val Refunded: EntitlementStatus = EntitlementStatus("refunded")
    }

    override fun toString(): String = value
}

/** How a gateway attempt of a session ended. */
@JvmInline
public value class AttemptOutcome(public val value: String) {
    public companion object {
        public val Created: AttemptOutcome = AttemptOutcome("created")
        public val Failed: AttemptOutcome = AttemptOutcome("failed")
    }

    override fun toString(): String = value
}
