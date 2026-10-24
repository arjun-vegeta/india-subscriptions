package dev.indiasubscriptions.models

import org.json.JSONObject

/**
 * What the device must do to pay. Only the Google Play Billing kind is typed; every other kind a server sends (a gateway
 * redirect, a Razorpay or Cashfree checkout, a kind added later) decodes as [Other] and carries just its `kind` string.
 * A gateway option is paid through its [PurchaseOption.hostedUrl], not through its instruction.
 */
public sealed interface CheckoutInstruction {
    /** The `kind` string of the instruction. */
    public val kind: String

    /** Purchase through Google Play Billing: the `google_play_billing` instruction. */
    public data class GooglePlayBilling(
        /** Whether the product is a subscription or a one-time product. */
        val productKind: ProductKind,
        /** The Play Console product id. */
        val productId: String,
        /** Subscriptions: the base plan id. */
        val basePlanId: String?,
        /** The offer id, where an offer applies. */
        val offerId: String?,
        /** Passed to `BillingFlowParams.setObfuscatedAccountId`; ties the purchase to this order. At most 64 characters. */
        val obfuscatedAccountId: String,
        /** True: build the `BillingClient` with `enableUserChoiceBilling`, so Google shows its choice screen. */
        val userChoiceBilling: Boolean,
    ) : CheckoutInstruction {
        override val kind: String get() = KIND
    }

    /** An instruction of another kind. */
    public data class Other(override val kind: String) : CheckoutInstruction

    public companion object {
        internal const val KIND = "google_play_billing"

        internal fun fromJson(json: JSONObject): CheckoutInstruction {
            val kind = json.requiredString("kind")
            if (kind != KIND) return Other(kind)
            return GooglePlayBilling(
                productKind = ProductKind(json.requiredString("productKind")),
                productId = json.requiredString("productId"),
                basePlanId = json.optionalString("basePlanId"),
                offerId = json.optionalString("offerId"),
                obfuscatedAccountId = json.requiredString("obfuscatedAccountId"),
                userChoiceBilling = json.requiredBoolean("userChoiceBilling"),
            )
        }
    }
}
