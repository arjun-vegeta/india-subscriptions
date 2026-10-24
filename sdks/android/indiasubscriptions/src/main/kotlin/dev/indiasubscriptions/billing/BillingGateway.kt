package dev.indiasubscriptions.billing

import android.app.Activity
import dev.indiasubscriptions.models.ProductKind
import kotlinx.coroutines.flow.Flow

/**
 * The slice of the Play Billing Library the SDK uses, behind a small interface so that every purchase flow runs against
 * a fake in JVM tests. [PlayBillingGateway] is the implementation over `BillingClient`.
 *
 * One gateway wraps one `BillingClient`. The SDK keeps one open at a time (Google recommends it, to avoid several
 * `onPurchasesUpdated` callbacks for one event) and builds a new one when a session needs user choice billing to be
 * switched on or off, because that is a property of the `BillingClient` itself.
 */
public interface BillingGateway {
    /**
     * What the billing client reports on its own: purchase updates, the customer's choice of the alternative, and a lost
     * connection. Buffered: nothing is dropped while nobody collects. Meant for one collector.
     */
    public val updates: Flow<BillingUpdate>

    /** True while the client is connected to the Play Store service. */
    public val isReady: Boolean

    /** Connects (or reconnects). Returns when the setup finished; the result says how. */
    public suspend fun connect(): BillingResult

    /** Loads one product from Google Play. A product Google Play does not return comes back with a null `product`. */
    public suspend fun queryProduct(productId: String, kind: ProductKind): ProductQueryResult

    /**
     * Starts Google's purchase screen. Called on the main thread. The result says whether the screen was launched; the
     * purchase itself arrives on [updates]. The activity is used for this call only and is not kept.
     */
    public fun launch(activity: Activity?, request: FlowRequest): BillingResult

    /** The purchases the Play Store currently reports as owned or pending, of one product type. */
    public suspend fun queryPurchases(kind: ProductKind): PurchasesQueryResult

    /** Ends the connection and releases the client. The gateway is not used again. */
    public fun close()
}

/** Builds gateways. */
public fun interface BillingGatewayFactory {
    /** @param userChoiceBilling true to build the `BillingClient` with `enableUserChoiceBilling`. */
    public fun create(userChoiceBilling: Boolean): BillingGateway
}

/** A `BillingClient.BillingResponseCode` with the debug message Google gave. */
public data class BillingResult(
    val code: Int,
    val message: String = "",
    /** The sub-response code of a `launchBillingFlow` result, where Google sets one. */
    val subCode: Int? = null,
) {
    val isOk: Boolean get() = code == BillingCode.OK

    public companion object {
        public fun ok(): BillingResult = BillingResult(BillingCode.OK)
    }
}

/** The values of `BillingClient.BillingResponseCode`, so that fakes do not need the Play classes. */
public object BillingCode {
    public const val OK: Int = 0
    public const val USER_CANCELED: Int = 1
    public const val SERVICE_UNAVAILABLE: Int = 2
    public const val BILLING_UNAVAILABLE: Int = 3
    public const val ITEM_UNAVAILABLE: Int = 4
    public const val DEVELOPER_ERROR: Int = 5
    public const val ERROR: Int = 6
    public const val ITEM_ALREADY_OWNED: Int = 7
    public const val ITEM_NOT_OWNED: Int = 8
    public const val NETWORK_ERROR: Int = 12
    public const val SERVICE_DISCONNECTED: Int = -1
    public const val FEATURE_NOT_SUPPORTED: Int = -2

    /** Deprecated by Google in favour of [SERVICE_UNAVAILABLE]. */
    public const val SERVICE_TIMEOUT: Int = -3
}

/** One way to buy a product: a base plan, an offer on it, or a one-time purchase option. */
public data class StoreOffer(
    /** The base plan id; null for a one-time product. */
    val basePlanId: String?,
    /** The offer id; null for the base plan itself (Google sets it only for a discounted offer). */
    val offerId: String?,
    /** The token to pass to the billing flow. */
    val token: String?,
)

/** A product as Google Play describes it: the ways to buy it, plus the client's own object for launching the flow. */
public class StoreProduct(
    public val productId: String,
    public val kind: ProductKind,
    public val offers: List<StoreOffer>,
    /** The `ProductDetails` of the Play implementation. Opaque to the SDK. */
    public val native: Any? = null,
)

public data class ProductQueryResult(val result: BillingResult, val product: StoreProduct?)

/** The parameters of one purchase flow. */
public class FlowRequest(
    public val product: StoreProduct,
    public val offerToken: String?,
    /** Passed to `BillingFlowParams.setObfuscatedAccountId`. */
    public val obfuscatedAccountId: String,
)

/** The state of a purchase, from `Purchase.PurchaseState`. */
public enum class DevicePurchaseState { PURCHASED, PENDING, UNSPECIFIED }

/** A purchase as the Play Store reports it. */
public data class DevicePurchase(
    val purchaseToken: String,
    val productIds: List<String>,
    val state: DevicePurchaseState,
    /** The obfuscated account id passed when the purchase was made; null for a purchase made outside the app. */
    val obfuscatedAccountId: String?,
    val orderId: String? = null,
    val acknowledged: Boolean = false,
    val quantity: Int = 1,
)

public data class PurchasesQueryResult(val result: BillingResult, val purchases: List<DevicePurchase>)

/** What a billing client reports on its own. */
public sealed interface BillingUpdate {
    /** `onPurchasesUpdated`: a purchase, a cancellation or an error. [purchases] is empty unless [result] is OK. */
    public data class PurchasesUpdated(val result: BillingResult, val purchases: List<DevicePurchase>) : BillingUpdate

    /** `userSelectedAlternativeBilling`: the customer picked the alternative on Google's choice screen. */
    public data class UserChoice(val externalTransactionToken: String, val productIds: List<String>) : BillingUpdate

    /** `onBillingServiceDisconnected`: the connection to the Play Store service was lost. */
    public data object Disconnected : BillingUpdate
}
