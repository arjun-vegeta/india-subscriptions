package dev.indiasubscriptions.billing

/** What a `BillingClient.BillingResponseCode` means for a purchase, sorted into the cases an app handles differently. */
public enum class BillingFailureReason {
    /** `USER_CANCELED`: the customer closed Google's purchase screen. */
    USER_CANCELED,

    /**
     * `BILLING_UNAVAILABLE`: Play Store out of date, an unsupported country, an enterprise admin who disabled purchases,
     * or Google Play could not charge the payment method. Google says that letting the customer retry may succeed once
     * the condition changed.
     */
    BILLING_UNAVAILABLE,

    /** `SERVICE_UNAVAILABLE` (and the deprecated `SERVICE_TIMEOUT`): transient, retried with a backoff. */
    SERVICE_UNAVAILABLE,

    /** `SERVICE_DISCONNECTED`: the connection to the Play Store service was lost. Transient, reconnected and retried. */
    SERVICE_DISCONNECTED,

    /** `NETWORK_ERROR`: a problem between the device and Google Play. */
    NETWORK_ERROR,

    /** `ITEM_UNAVAILABLE`: the product is not available in the customer's country, or the catalogue has not propagated. */
    ITEM_UNAVAILABLE,

    /** `ITEM_ALREADY_OWNED`: the customer already owns the item. The SDK refreshes the purchases and completes them. */
    ITEM_ALREADY_OWNED,

    /** `ITEM_NOT_OWNED`: an action on an item the customer does not own. */
    ITEM_NOT_OWNED,

    /** `FEATURE_NOT_SUPPORTED`: the Play Store on this device does not support what was asked for. */
    FEATURE_NOT_SUPPORTED,

    /** `DEVELOPER_ERROR`: invalid arguments or a misconfigured app (an unsigned build, a missing permission). */
    DEVELOPER_ERROR,

    /** `ERROR`: an internal Google Play error that may be transient. */
    ERROR,

    /** A response code this version of the SDK does not know. */
    UNKNOWN,
}

/** Why Google Play did not take the purchase. Nothing was charged. */
public data class BillingFailure(
    val reason: BillingFailureReason,
    /** The `BillingResponseCode` Google returned. */
    val responseCode: Int,
    /** The sub-response code of a purchase flow result (`USER_INELIGIBLE`, insufficient funds), where Google set one. */
    val subResponseCode: Int? = null,
    /** Google's debug message. Not for display to customers. */
    val message: String = "",
) {
    /** True when trying again later may work without anything else changing. */
    val isTransient: Boolean
        get() = when (reason) {
            BillingFailureReason.SERVICE_UNAVAILABLE, BillingFailureReason.SERVICE_DISCONNECTED,
            BillingFailureReason.NETWORK_ERROR, BillingFailureReason.ERROR,
            -> true

            else -> false
        }

    internal companion object {
        fun from(result: BillingResult): BillingFailure = BillingFailure(
            reason = reasonFor(result.code),
            responseCode = result.code,
            subResponseCode = result.subCode,
            message = result.message,
        )

        fun reasonFor(code: Int): BillingFailureReason = when (code) {
            BillingCode.USER_CANCELED -> BillingFailureReason.USER_CANCELED
            BillingCode.BILLING_UNAVAILABLE -> BillingFailureReason.BILLING_UNAVAILABLE
            BillingCode.SERVICE_UNAVAILABLE, BillingCode.SERVICE_TIMEOUT -> BillingFailureReason.SERVICE_UNAVAILABLE
            BillingCode.SERVICE_DISCONNECTED -> BillingFailureReason.SERVICE_DISCONNECTED
            BillingCode.NETWORK_ERROR -> BillingFailureReason.NETWORK_ERROR
            BillingCode.ITEM_UNAVAILABLE -> BillingFailureReason.ITEM_UNAVAILABLE
            BillingCode.ITEM_ALREADY_OWNED -> BillingFailureReason.ITEM_ALREADY_OWNED
            BillingCode.ITEM_NOT_OWNED -> BillingFailureReason.ITEM_NOT_OWNED
            BillingCode.FEATURE_NOT_SUPPORTED -> BillingFailureReason.FEATURE_NOT_SUPPORTED
            BillingCode.DEVELOPER_ERROR -> BillingFailureReason.DEVELOPER_ERROR
            BillingCode.ERROR -> BillingFailureReason.ERROR
            else -> BillingFailureReason.UNKNOWN
        }

        /** The response codes the SDK retries by reconnecting and asking again. */
        fun isRetryable(code: Int): Boolean = when (code) {
            BillingCode.SERVICE_UNAVAILABLE, BillingCode.SERVICE_TIMEOUT, BillingCode.SERVICE_DISCONNECTED,
            BillingCode.NETWORK_ERROR, BillingCode.ERROR,
            -> true

            else -> false
        }
    }
}
