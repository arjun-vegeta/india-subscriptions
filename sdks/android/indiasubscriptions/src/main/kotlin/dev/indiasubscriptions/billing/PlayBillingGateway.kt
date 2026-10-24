package dev.indiasubscriptions.billing

import android.app.Activity
import android.content.Context
import com.android.billingclient.api.BillingClient
import com.android.billingclient.api.BillingClientStateListener
import com.android.billingclient.api.BillingFlowParams
import com.android.billingclient.api.PendingPurchasesParams
import com.android.billingclient.api.ProductDetails
import com.android.billingclient.api.Purchase
import com.android.billingclient.api.QueryProductDetailsParams
import com.android.billingclient.api.QueryPurchasesParams
import dev.indiasubscriptions.models.ProductKind
import kotlin.coroutines.resume
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import com.android.billingclient.api.BillingResult as PlayBillingResult

/**
 * The [BillingGateway] over a Play Billing Library 9 `BillingClient`.
 *
 * - The client is built with pending purchases enabled for one-time products (Google requires it to be called), with
 *   user choice billing when asked, and without automatic service reconnection: the SDK reconnects and retries itself
 *   (see `PurchaseClient.Configuration`), which keeps the retry rules in one place.
 * - Every call to the client is made on [mainDispatcher], where Google's callbacks are delivered, so the SDK's own
 *   threads never touch it.
 * - The SDK never acknowledges or consumes a purchase: the server does it when it verifies the purchase.
 *
 * @param enablePrepaidPlans also enable pending purchases for prepaid plans (see Google's subscriptions guide).
 */
public class PlayBillingGateway(
    context: Context,
    userChoiceBilling: Boolean,
    enablePrepaidPlans: Boolean = false,
    private val mainDispatcher: CoroutineDispatcher = Dispatchers.Main.immediate,
) : BillingGateway {
    private val channel = Channel<BillingUpdate>(Channel.UNLIMITED)

    override val updates: Flow<BillingUpdate> = channel.receiveAsFlow()

    private val client: BillingClient = BillingClient.newBuilder(context.applicationContext)
        .setListener { result, purchases ->
            channel.trySend(
                BillingUpdate.PurchasesUpdated(result.toSdk(), purchases.orEmpty().map { it.toDevicePurchase() }),
            )
        }
        .enablePendingPurchases(
            PendingPurchasesParams.newBuilder().enableOneTimeProducts().apply { if (enablePrepaidPlans) enablePrepaidPlans() }.build(),
        )
        .apply {
            if (userChoiceBilling) {
                enableUserChoiceBilling { details ->
                    channel.trySend(
                        BillingUpdate.UserChoice(details.externalTransactionToken, details.products.map { it.id }),
                    )
                }
            }
        }
        .build()

    override val isReady: Boolean get() = client.isReady

    override suspend fun connect(): BillingResult = withContext(mainDispatcher) {
        suspendCancellableCoroutine { continuation ->
            client.startConnection(
                object : BillingClientStateListener {
                    override fun onBillingSetupFinished(billingResult: PlayBillingResult) {
                        if (continuation.isActive) continuation.resume(billingResult.toSdk())
                    }

                    override fun onBillingServiceDisconnected() {
                        // Before the setup finished it is a failed connection; after it, a lost one.
                        if (continuation.isActive) {
                            continuation.resume(BillingResult(BillingCode.SERVICE_DISCONNECTED, "The service disconnected during setup"))
                        } else {
                            channel.trySend(BillingUpdate.Disconnected)
                        }
                    }
                },
            )
        }
    }

    override suspend fun queryProduct(productId: String, kind: ProductKind): ProductQueryResult = withContext(mainDispatcher) {
        val params = QueryProductDetailsParams.newBuilder()
            .setProductList(
                listOf(
                    QueryProductDetailsParams.Product.newBuilder()
                        .setProductId(productId)
                        .setProductType(kind.toPlayType())
                        .build(),
                ),
            )
            .build()
        suspendCancellableCoroutine { continuation ->
            client.queryProductDetailsAsync(params) { result, queryResult ->
                val details = queryResult.productDetailsList.firstOrNull { it.productId == productId }
                if (continuation.isActive) continuation.resume(ProductQueryResult(result.toSdk(), details?.toStoreProduct(kind)))
            }
        }
    }

    override fun launch(activity: Activity?, request: FlowRequest): BillingResult {
        val details = request.product.native as? ProductDetails
            ?: return BillingResult(BillingCode.DEVELOPER_ERROR, "The product was not loaded by this gateway")
        if (activity == null) return BillingResult(BillingCode.DEVELOPER_ERROR, "The activity is gone")
        val productParams = BillingFlowParams.ProductDetailsParams.newBuilder()
            .setProductDetails(details)
            .apply { request.offerToken?.let { setOfferToken(it) } }
            .build()
        val params = BillingFlowParams.newBuilder()
            .setProductDetailsParamsList(listOf(productParams))
            .setObfuscatedAccountId(request.obfuscatedAccountId)
            .build()
        return client.launchBillingFlow(activity, params).toSdk()
    }

    override suspend fun queryPurchases(kind: ProductKind): PurchasesQueryResult = withContext(mainDispatcher) {
        val params = QueryPurchasesParams.newBuilder().setProductType(kind.toPlayType()).build()
        suspendCancellableCoroutine { continuation ->
            client.queryPurchasesAsync(params) { result, purchases ->
                if (continuation.isActive) {
                    continuation.resume(PurchasesQueryResult(result.toSdk(), purchases.map { it.toDevicePurchase() }))
                }
            }
        }
    }

    override fun close() {
        channel.close()
        client.endConnection()
    }
}

private fun ProductKind.toPlayType(): String =
    if (this == ProductKind.Subscription) BillingClient.ProductType.SUBS else BillingClient.ProductType.INAPP

internal fun PlayBillingResult.toSdk(): BillingResult = BillingResult(
    code = responseCode,
    message = debugMessage,
    subCode = onPurchasesUpdatedSubResponseCode.takeIf { it != BillingClient.OnPurchasesUpdatedSubResponseCode.NO_APPLICABLE_SUB_RESPONSE_CODE },
)

internal fun Purchase.toDevicePurchase(): DevicePurchase = DevicePurchase(
    purchaseToken = purchaseToken,
    productIds = products,
    state = when (purchaseState) {
        Purchase.PurchaseState.PURCHASED -> DevicePurchaseState.PURCHASED
        Purchase.PurchaseState.PENDING -> DevicePurchaseState.PENDING
        else -> DevicePurchaseState.UNSPECIFIED
    },
    // A purchase made outside the app carries no account id (the library may give an empty one).
    obfuscatedAccountId = accountIdentifiers?.obfuscatedAccountId?.takeIf { it.isNotEmpty() },
    orderId = orderId,
    acknowledged = isAcknowledged,
    quantity = quantity,
)

internal fun ProductDetails.toStoreProduct(kind: ProductKind): StoreProduct {
    val offers = if (kind == ProductKind.Subscription) {
        subscriptionOfferDetails.orEmpty().map { StoreOffer(basePlanId = it.basePlanId, offerId = it.offerId, token = it.offerToken) }
    } else {
        // `oneTimePurchaseOfferDetailsList` is only set for a product with several purchase options or offers.
        val details = oneTimePurchaseOfferDetailsList?.takeIf { it.isNotEmpty() } ?: listOfNotNull(oneTimePurchaseOfferDetails)
        details.map { StoreOffer(basePlanId = null, offerId = it.offerId, token = it.offerToken) }
    }
    return StoreProduct(productId = productId, kind = kind, offers = offers, native = this)
}
