package dev.indiasubscriptions.models

import org.json.JSONObject

/** One way the customer can pay for a session. */
public data class PurchaseOption(
    /** `store` for an app store, `gateway` for a payment gateway. */
    val channel: SalesChannel,
    /** The provider that holds the purchase. */
    val provider: Provider,
    /** What the device must do to pay. */
    val checkout: CheckoutInstruction,
    /** The id the provider returned when the purchase was created. For a store it is the account id. */
    val handle: String,
    /**
     * A page that performs this option's checkout step, for a client that cannot run the gateway's own browser helper.
     * Present on gateway options when the service serves a hosted checkout. The SDK opens it in a Custom Tab.
     */
    val hostedUrl: String?,
) {
    internal companion object {
        fun fromJson(json: JSONObject): PurchaseOption = PurchaseOption(
            channel = SalesChannel(json.requiredString("channel")),
            provider = Provider(json.requiredString("provider")),
            checkout = CheckoutInstruction.fromJson(json.optionalObject("checkout") ?: throw DecodingException("'checkout' is missing")),
            handle = json.requiredString("handle"),
            hostedUrl = json.optionalString("hostedUrl"),
        )
    }
}

/** One gateway tried while creating the purchase. */
public data class PurchaseAttempt(
    val provider: Provider,
    val outcome: AttemptOutcome,
    val atMillis: Long,
    val errorCode: String?,
    val message: String?,
) {
    internal companion object {
        fun fromJson(json: JSONObject): PurchaseAttempt = PurchaseAttempt(
            provider = Provider(json.requiredString("provider")),
            outcome = AttemptOutcome(json.requiredString("outcome")),
            atMillis = json.requiredTime("at"),
            errorCode = json.optionalString("errorCode"),
            message = json.optionalString("message"),
        )
    }
}

/** The Google Play option of a session and its instruction. */
public data class GooglePlayOption(val option: PurchaseOption, val checkout: CheckoutInstruction.GooglePlayBilling)

/** A purchase in progress or done: where the customer may pay and how it ended. */
public data class PurchaseSession(
    /** The session id. Whoever holds it can complete the session, so keep it out of logs. */
    val id: String,
    val platform: Platform,
    /** The key of the product. */
    val product: String,
    /** The channel policy the session was resolved with. */
    val policy: ChannelPolicy,
    val status: SessionStatus,
    val customerRef: String,
    val reference: String?,
    /** The `returnUrl` given to the start call: where the hosted checkout sends the customer when it is done. */
    val returnUrl: String?,
    val options: List<PurchaseOption>,
    val attempts: List<PurchaseAttempt>,
    val externalTransactionToken: String?,
    val createdAtMillis: Long,
    /** When an unpaid session expires. */
    val expiresAtMillis: Long,
    val completedAtMillis: Long?,
    val subscriptionId: String?,
    val paymentId: String?,
    /** The provider the purchase was confirmed at. */
    val provider: Provider?,
) {
    /** The Google Play option of the session and its instruction, if the session has one. */
    public val googlePlayOption: GooglePlayOption?
        get() {
            for (option in options) {
                val checkout = option.checkout
                if (checkout is CheckoutInstruction.GooglePlayBilling) return GooglePlayOption(option, checkout)
            }
            return null
        }

    /** The first gateway option that carries a hosted checkout page. */
    public val hostedOption: PurchaseOption?
        get() = options.firstOrNull { it.checkout !is CheckoutInstruction.GooglePlayBilling && !it.hostedUrl.isNullOrEmpty() }

    public companion object {
        /** Reads the service's JSON for a session. Throws [IllegalArgumentException] when it is not one. */
        public fun fromJson(json: String): PurchaseSession = try {
            decoding(json, ::fromJson)
        } catch (error: DecodingException) {
            throw IllegalArgumentException(error.message, error)
        }

        internal fun fromJson(json: JSONObject): PurchaseSession = PurchaseSession(
            id = json.requiredString("id"),
            platform = Platform(json.requiredString("platform")),
            product = json.requiredString("product"),
            policy = ChannelPolicy(json.requiredString("policy")),
            status = SessionStatus(json.requiredString("status")),
            customerRef = json.requiredString("customerRef"),
            reference = json.optionalString("reference"),
            returnUrl = json.optionalString("returnUrl"),
            options = json.optionalArray("options")?.mapObjects { PurchaseOption.fromJson(it) }
                ?: throw DecodingException("'options' is missing"),
            attempts = json.optionalArray("attempts")?.mapObjects { PurchaseAttempt.fromJson(it) } ?: emptyList(),
            externalTransactionToken = json.optionalString("externalTransactionToken"),
            createdAtMillis = json.requiredTime("createdAt"),
            expiresAtMillis = json.requiredTime("expiresAt"),
            completedAtMillis = json.optionalTime("completedAt"),
            subscriptionId = json.optionalString("subscriptionId"),
            paymentId = json.optionalString("paymentId"),
            provider = json.optionalString("provider")?.let(::Provider),
        )
    }
}
