package dev.indiasubscriptions.models

import org.json.JSONObject

/** One purchase the customer owns or owned. */
public data class EntitlementItem(
    /** The key of the product. */
    val product: String,
    val kind: ProductKind,
    /** The provider that holds the purchase. */
    val provider: Provider,
    val channel: SalesChannel,
    /** The platform the customer bought on. */
    val platform: Platform,
    val subscriptionId: String?,
    val paymentId: String?,
    val status: EntitlementStatus,
    /** True when the item gives access now. */
    val active: Boolean,
    /** True when the subscription ends at the end of the current period. */
    val cancelAtPeriodEnd: Boolean?,
    /** End of the current paid period, where known. */
    val currentPeriodEndMillis: Long?,
    val updatedAtMillis: Long,
) {
    internal companion object {
        fun fromJson(json: JSONObject): EntitlementItem = EntitlementItem(
            product = json.requiredString("product"),
            kind = ProductKind(json.requiredString("kind")),
            provider = Provider(json.requiredString("provider")),
            channel = SalesChannel(json.requiredString("channel")),
            platform = Platform(json.requiredString("platform")),
            subscriptionId = json.optionalString("subscriptionId"),
            paymentId = json.optionalString("paymentId"),
            status = EntitlementStatus(json.requiredString("status")),
            active = json.requiredBoolean("active"),
            cancelAtPeriodEnd = json.optionalBoolean("cancelAtPeriodEnd"),
            currentPeriodEndMillis = json.optionalTime("currentPeriodEnd"),
            updatedAtMillis = json.requiredTime("updatedAt"),
        )
    }
}

/** What a customer owns, across app stores and gateways. The server is the source of truth for it. */
public data class Entitlements(
    val customerRef: String,
    /** True when at least one item gives access now. */
    val active: Boolean,
    /** Every purchase of the customer, newest change first, including ended ones. */
    val items: List<EntitlementItem>,
) {
    /** The items that give access now. */
    public val activeItems: List<EntitlementItem> get() = items.filter { it.active }

    /** Whether the customer has an active item for the product key. */
    public fun hasAccess(product: String): Boolean = items.any { it.product == product && it.active }

    public companion object {
        /** Reads the service's JSON for the entitlements. Throws [IllegalArgumentException] when it is not one. */
        public fun fromJson(json: String): Entitlements = try {
            decoding(json, ::fromJson)
        } catch (error: DecodingException) {
            throw IllegalArgumentException(error.message, error)
        }

        internal fun fromJson(json: JSONObject): Entitlements = Entitlements(
            customerRef = json.requiredString("customerRef"),
            active = json.requiredBoolean("active"),
            items = json.optionalArray("items")?.mapObjects { EntitlementItem.fromJson(it) }
                ?: throw DecodingException("'items' is missing"),
        )
    }
}
