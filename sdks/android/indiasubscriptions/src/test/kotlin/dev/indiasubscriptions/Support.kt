package dev.indiasubscriptions

import android.app.Activity
import dev.indiasubscriptions.backend.PurchaseBackend
import dev.indiasubscriptions.backend.PurchaseBackendException
import dev.indiasubscriptions.backend.ServerError
import dev.indiasubscriptions.backend.ServerErrorCode
import dev.indiasubscriptions.billing.BillingGateway
import dev.indiasubscriptions.billing.BillingGatewayFactory
import dev.indiasubscriptions.billing.BillingResult
import dev.indiasubscriptions.billing.BillingUpdate
import dev.indiasubscriptions.billing.DevicePurchase
import dev.indiasubscriptions.billing.DevicePurchaseState
import dev.indiasubscriptions.billing.FlowRequest
import dev.indiasubscriptions.billing.ProductQueryResult
import dev.indiasubscriptions.billing.PurchasesQueryResult
import dev.indiasubscriptions.billing.StoreOffer
import dev.indiasubscriptions.billing.StoreProduct
import dev.indiasubscriptions.models.ChooseAlternativeInput
import dev.indiasubscriptions.models.CompletePurchaseInput
import dev.indiasubscriptions.models.Entitlements
import dev.indiasubscriptions.models.ProductKind
import dev.indiasubscriptions.models.PurchaseSession
import dev.indiasubscriptions.models.StartPurchaseInput
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import org.json.JSONArray
import org.json.JSONObject

/** 2026-11-24T10:30:00Z, the "now" of the flow tests. */
const val NOW = 1_795_516_200_000L

const val ACCOUNT_ID = "6f1c2f4e-5b6a-4a52-9a43-0f2d7d7c9a10"
const val SESSION_ID = "ps_1"
const val GOOGLE_PRODUCT = "in.example.pro"
const val PURCHASE_TOKEN = "purchase-token-1"
const val RETURN_LINK = "myapp://billing/return"
const val HOSTED_URL = "https://pay.example.com/checkout/ps_1"
const val EXTERNAL_TOKEN = "ext-token-abc"

/** Builds sessions as the service sends them, through the same decoder the SDK uses. */
object Sessions {
    fun google(
        id: String = SESSION_ID,
        status: String = "open",
        policy: String = "store",
        accountId: String = ACCOUNT_ID,
        productKind: String = "subscription",
        basePlanId: String? = "monthly",
        offerId: String? = null,
        userChoice: Boolean = false,
        hostedUrl: String? = null,
        externalToken: String? = null,
        subscriptionId: String? = null,
    ): PurchaseSession {
        val options = JSONArray()
        options.put(
            JSONObject()
                .put("channel", "store")
                .put("provider", "google_play")
                .put(
                    "checkout",
                    JSONObject()
                        .put("kind", "google_play_billing")
                        .put("productKind", productKind)
                        .put("productId", GOOGLE_PRODUCT)
                        .put("obfuscatedAccountId", accountId)
                        .put("userChoiceBilling", userChoice)
                        .apply {
                            basePlanId?.let { put("basePlanId", it) }
                            offerId?.let { put("offerId", it) }
                        },
                )
                .put("handle", accountId),
        )
        if (hostedUrl != null) options.put(gatewayOption(hostedUrl))
        return build(id, status, policy, options, externalToken, subscriptionId)
    }

    /** A session whose only option is a gateway (the `gateways` policy). */
    fun gatewayOnly(id: String = SESSION_ID, status: String = "open", hostedUrl: String? = HOSTED_URL): PurchaseSession =
        build(id, status, "gateways", JSONArray().put(gatewayOption(hostedUrl)), null, null)

    private fun gatewayOption(hostedUrl: String?): JSONObject = JSONObject()
        .put("channel", "gateway")
        .put("provider", "razorpay")
        .put("checkout", JSONObject().put("kind", "razorpay_checkout").put("keyId", "rzp_test_x").put("subscriptionId", "sub_123"))
        .put("handle", "sub_123")
        .apply { hostedUrl?.let { put("hostedUrl", it) } }

    private fun build(id: String, status: String, policy: String, options: JSONArray, externalToken: String?, subscriptionId: String?): PurchaseSession {
        val json = JSONObject()
            .put("id", id)
            .put("platform", "android")
            .put("product", "pro_monthly")
            .put("policy", policy)
            .put("status", status)
            .put("customerRef", "cust_1")
            .put("reference", "ref_1")
            .put("returnUrl", RETURN_LINK)
            .put("options", options)
            .put("attempts", JSONArray())
            .put("createdAt", "2026-11-24T10:00:00Z")
            .put("expiresAt", "2026-11-25T10:00:00Z")
        externalToken?.let { json.put("externalTransactionToken", it) }
        subscriptionId?.let { json.put("subscriptionId", it) }
        return PurchaseSession.fromJson(json.toString())
    }
}

fun serverError(status: Int, code: ServerErrorCode, message: String = code.value, retryable: Boolean? = null): PurchaseBackendException =
    PurchaseBackendException.Server(ServerError(status, code, message, retryable = retryable))

fun transportError(): PurchaseBackendException = PurchaseBackendException.Transport("Unable to resolve host")

/** A scripted backend that records every call. */
class FakeBackend : PurchaseBackend {
    val calls = mutableListOf<String>()
    val completes = mutableListOf<Pair<String, CompletePurchaseInput>>()
    val alternatives = mutableListOf<Pair<String, ChooseAlternativeInput>>()
    val starts = mutableListOf<StartPurchaseInput>()
    val reads = mutableListOf<String>()

    var onStart: suspend (StartPurchaseInput) -> PurchaseSession = { Sessions.google() }
    var onComplete: suspend (String, CompletePurchaseInput) -> PurchaseSession = { _, _ -> Sessions.google(status = "completed") }
    var onAlternative: suspend (String, ChooseAlternativeInput) -> PurchaseSession =
        { _, _ -> Sessions.google(status = "awaiting_payment", policy = "user_choice", userChoice = true, hostedUrl = HOSTED_URL, externalToken = EXTERNAL_TOKEN) }
    var onGet: suspend (String) -> PurchaseSession = { Sessions.google(status = "completed") }
    var onEntitlements: suspend (String) -> Entitlements = { Entitlements(it, false, emptyList()) }

    override suspend fun startPurchase(input: StartPurchaseInput): PurchaseSession {
        calls += "start"
        starts += input
        return onStart(input)
    }

    override suspend fun purchase(sessionId: String): PurchaseSession {
        calls += "get"
        reads += sessionId
        return onGet(sessionId)
    }

    override suspend fun chooseAlternative(sessionId: String, input: ChooseAlternativeInput): PurchaseSession {
        calls += "alternative"
        alternatives += sessionId to input
        return onAlternative(sessionId, input)
    }

    override suspend fun completePurchase(sessionId: String, input: CompletePurchaseInput): PurchaseSession {
        calls += "complete"
        completes += sessionId to input
        return onComplete(sessionId, input)
    }

    override suspend fun entitlements(customerRef: String): Entitlements {
        calls += "entitlements"
        return onEntitlements(customerRef)
    }
}

/** A scripted billing client. */
class FakeBillingGateway(val userChoice: Boolean) : BillingGateway {
    private val channel = Channel<BillingUpdate>(Channel.UNLIMITED)
    override val updates: Flow<BillingUpdate> = channel.receiveAsFlow()

    var ready = false
    override val isReady: Boolean get() = ready
    var closed = false

    /** Results the next connects return, in order; connects after that succeed. */
    val connectScript = ArrayDeque<BillingResult>()
    var connects = 0

    val queryProductScript = ArrayDeque<BillingResult>()
    var products = mutableMapOf<String, StoreProduct>()
    var productQueries = 0

    /** What the Play Store holds, per kind. */
    val owned = mutableMapOf<ProductKind, MutableList<DevicePurchase>>()
    val queryPurchasesScript = ArrayDeque<BillingResult>()
    var purchaseQueries = 0

    val launches = mutableListOf<FlowRequest>()
    var launchActivities = mutableListOf<Activity?>()

    /** Called by `launch`. It may push updates, as Google's screen would after the customer acted. */
    var onLaunch: (FlowRequest) -> BillingResult = { BillingResult.ok() }

    init {
        products[GOOGLE_PRODUCT] = subscriptionProduct()
    }

    override suspend fun connect(): BillingResult {
        connects++
        val result = connectScript.removeFirstOrNull() ?: BillingResult.ok()
        if (result.isOk) ready = true
        return result
    }

    override suspend fun queryProduct(productId: String, kind: ProductKind): ProductQueryResult {
        productQueries++
        val scripted = queryProductScript.removeFirstOrNull()
        if (scripted != null) {
            if (!scripted.isOk && scripted.code == dev.indiasubscriptions.billing.BillingCode.SERVICE_DISCONNECTED) ready = false
            if (!scripted.isOk) return ProductQueryResult(scripted, null)
        }
        return ProductQueryResult(BillingResult.ok(), products[productId])
    }

    override fun launch(activity: Activity?, request: FlowRequest): BillingResult {
        launches += request
        launchActivities += activity
        return onLaunch(request)
    }

    override suspend fun queryPurchases(kind: ProductKind): PurchasesQueryResult {
        purchaseQueries++
        val scripted = queryPurchasesScript.removeFirstOrNull()
        if (scripted != null && !scripted.isOk) return PurchasesQueryResult(scripted, emptyList())
        return PurchasesQueryResult(BillingResult.ok(), owned[kind].orEmpty().toList())
    }

    override fun close() {
        closed = true
        ready = false
        channel.close()
    }

    // -- what Google would report ----------------------------------------------------------------------------------------

    fun send(update: BillingUpdate) {
        channel.trySend(update)
    }

    fun deliverPurchase(purchase: DevicePurchase) {
        send(BillingUpdate.PurchasesUpdated(BillingResult.ok(), listOf(purchase)))
    }

    fun deliverResult(code: Int) {
        send(BillingUpdate.PurchasesUpdated(BillingResult(code, "scripted $code"), emptyList()))
    }

    fun disconnect() {
        ready = false
        send(BillingUpdate.Disconnected)
    }

    companion object {
        fun subscriptionProduct(): StoreProduct = StoreProduct(
            productId = GOOGLE_PRODUCT,
            kind = ProductKind.Subscription,
            offers = listOf(
                StoreOffer("monthly", null, "token-monthly-base"),
                StoreOffer("monthly", "intro-7d", "token-monthly-intro"),
                StoreOffer("yearly", null, "token-yearly-base"),
            ),
        )

        fun oneTimeProduct(): StoreProduct = StoreProduct(
            productId = GOOGLE_PRODUCT,
            kind = ProductKind.OneTime,
            offers = listOf(StoreOffer(null, null, "token-once")),
        )
    }
}

class FakeBillingFactory(private val configure: (FakeBillingGateway) -> Unit = {}) : BillingGatewayFactory {
    val created = mutableListOf<FakeBillingGateway>()
    val latest: FakeBillingGateway get() = created.last()

    override fun create(userChoiceBilling: Boolean): BillingGateway =
        FakeBillingGateway(userChoiceBilling).also {
            configure(it)
            created += it
        }
}

class FakeOpener : HostedPageOpener {
    val opened = mutableListOf<String>()
    var failure: Exception? = null

    override fun open(activity: Activity?, url: String) {
        failure?.let { throw it }
        opened += url
    }
}

fun devicePurchase(
    token: String = PURCHASE_TOKEN,
    state: DevicePurchaseState = DevicePurchaseState.PURCHASED,
    accountId: String? = ACCOUNT_ID,
    acknowledged: Boolean = false,
    productId: String = GOOGLE_PRODUCT,
): DevicePurchase = DevicePurchase(
    purchaseToken = token,
    productIds = listOf(productId),
    state = state,
    obfuscatedAccountId = accountId,
    orderId = if (state == DevicePurchaseState.PURCHASED) "GPA.1234-5678-9012-34567" else null,
    acknowledged = acknowledged,
)
