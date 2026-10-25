package dev.indiasubscriptions.flutter

import dev.indiasubscriptions.PurchaseEvent
import dev.indiasubscriptions.PurchaseException
import dev.indiasubscriptions.PurchaseFailure
import dev.indiasubscriptions.PurchaseOutcome
import dev.indiasubscriptions.ReturnLinkResult
import dev.indiasubscriptions.backend.PurchaseBackendException
import dev.indiasubscriptions.backend.ServerError
import dev.indiasubscriptions.backend.ServerErrorCode
import dev.indiasubscriptions.billing.BillingFailure
import dev.indiasubscriptions.billing.BillingFailureReason
import dev.indiasubscriptions.models.ChannelPolicy
import dev.indiasubscriptions.models.CheckoutInstruction
import dev.indiasubscriptions.models.EntitlementItem
import dev.indiasubscriptions.models.EntitlementStatus
import dev.indiasubscriptions.models.Entitlements
import dev.indiasubscriptions.models.Platform
import dev.indiasubscriptions.models.ProductKind
import dev.indiasubscriptions.models.Provider
import dev.indiasubscriptions.models.PurchaseOption
import dev.indiasubscriptions.models.PurchaseSession
import dev.indiasubscriptions.models.SalesChannel
import dev.indiasubscriptions.models.SessionStatus
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

internal class TranslationTest {
    private val play = PurchaseOption(
        channel = SalesChannel.Store,
        provider = Provider.GooglePlay,
        checkout = CheckoutInstruction.GooglePlayBilling(
            productKind = ProductKind.Subscription,
            productId = "in.example.pro",
            basePlanId = "monthly",
            offerId = null,
            obfuscatedAccountId = "acct-1",
            userChoiceBilling = true,
        ),
        handle = "acct-1",
        hostedUrl = null,
    )
    private val gateway = PurchaseOption(
        channel = SalesChannel.Gateway,
        provider = Provider("newgateway"),
        checkout = CheckoutInstruction.Other("redirect"),
        handle = "order-1",
        hostedUrl = "https://example.com/checkout/sess_1",
    )

    private fun session(status: SessionStatus = SessionStatus.Completed) = PurchaseSession(
        id = "sess_1",
        platform = Platform.Android,
        product = "pro_monthly",
        policy = ChannelPolicy.UserChoice,
        status = status,
        customerRef = "cust_1",
        reference = "ref-1",
        returnUrl = "myapp://billing/return",
        options = listOf(play, gateway),
        attempts = emptyList(),
        externalTransactionToken = "secret-token",
        createdAtMillis = 1_700_000_000_000,
        expiresAtMillis = 1_700_003_600_000,
        completedAtMillis = 1_700_000_100_000,
        subscriptionId = "sub_1",
        paymentId = null,
        provider = Provider.GooglePlay,
    )

    private val failure = PurchaseFailure(PurchaseFailure.Reason.BACKEND_UNREACHABLE, ServerErrorCode.Network, "offline")

    @Test
    fun sessionKeepsFieldsAndNeverExposesTheExternalToken() {
        val message = session().toMessage()
        assertEquals("sess_1", message.id)
        assertEquals("android", message.platform)
        assertEquals("user_choice", message.policy)
        assertEquals("completed", message.status)
        assertEquals(1_700_000_000_000, message.createdAt)
        assertEquals(1_700_000_100_000, message.completedAt)
        assertEquals("myapp://billing/return", message.returnUrl)
        assertEquals("google_play", message.provider)
        assertEquals(2, message.options.size)
        assertEquals("google_play_billing", message.options[0].checkoutKind)
        assertEquals("in.example.pro", message.options[0].storeProductId)
        assertNull(message.options[0].hostedUrl)
        assertEquals("redirect", message.options[1].checkoutKind)
        assertNull(message.options[1].storeProductId)
        assertEquals("https://example.com/checkout/sess_1", message.options[1].hostedUrl)
        assertEquals("newgateway", message.options[1].provider)
        assertTrue(!message.toString().contains("secret-token"))
    }

    @Test
    fun everyPurchaseFailureReasonHasItsDartName() {
        val expected = mapOf(
            PurchaseFailure.Reason.BACKEND_UNREACHABLE to "backendUnreachable",
            PurchaseFailure.Reason.BACKEND_FAILING to "backendFailing",
            PurchaseFailure.Reason.BACKEND_REFUSED to "backendRefused",
            PurchaseFailure.Reason.NOT_PAID to "notPaid",
            PurchaseFailure.Reason.NOT_SETTLED to "notSettled",
            PurchaseFailure.Reason.GAVE_UP to "gaveUp",
            PurchaseFailure.Reason.CHECKOUT_UNAVAILABLE to "checkoutUnavailable",
        )
        assertEquals(PurchaseFailure.Reason.entries.toSet(), expected.keys)
        for ((reason, name) in expected) assertEquals(name, reason.wireName())
        val message = failure.toMessage()
        assertEquals("backendUnreachable", message.reason)
        assertEquals("NETWORK", message.code)
        assertEquals("offline", message.message)
    }

    @Test
    fun everyBillingFailureReasonHasItsDartName() {
        val expected = mapOf(
            BillingFailureReason.USER_CANCELED to "userCanceled",
            BillingFailureReason.BILLING_UNAVAILABLE to "billingUnavailable",
            BillingFailureReason.SERVICE_UNAVAILABLE to "serviceUnavailable",
            BillingFailureReason.SERVICE_DISCONNECTED to "serviceDisconnected",
            BillingFailureReason.NETWORK_ERROR to "networkError",
            BillingFailureReason.ITEM_UNAVAILABLE to "itemUnavailable",
            BillingFailureReason.ITEM_ALREADY_OWNED to "itemAlreadyOwned",
            BillingFailureReason.ITEM_NOT_OWNED to "itemNotOwned",
            BillingFailureReason.FEATURE_NOT_SUPPORTED to "featureNotSupported",
            BillingFailureReason.DEVELOPER_ERROR to "developerError",
            BillingFailureReason.ERROR to "error",
            BillingFailureReason.UNKNOWN to "unknown",
        )
        assertEquals(BillingFailureReason.entries.toSet(), expected.keys)
        for ((reason, name) in expected) assertEquals(name, reason.wireName())
        val message = BillingFailure(BillingFailureReason.SERVICE_UNAVAILABLE, 2, 1, "debug").toMessage()
        assertEquals(2L, message.responseCode)
        assertEquals(1L, message.subResponseCode)
        assertTrue(message.isTransient)
    }

    @Test
    fun everyOutcomeMapsToItsKind() {
        val s = session()
        val billing = BillingFailure(BillingFailureReason.ITEM_UNAVAILABLE, 4)
        assertEquals("completed", PurchaseOutcome.Completed(s).toMessage().kind)
        assertEquals("pending", PurchaseOutcome.Pending(s).toMessage().kind)
        assertEquals("cancelled", PurchaseOutcome.Cancelled(s).toMessage().kind)
        assertEquals("awaitingReturn", PurchaseOutcome.AwaitingReturn(s).toMessage().kind)
        val awaiting = PurchaseOutcome.AwaitingBackend(s, failure).toMessage()
        assertEquals("awaitingBackend", awaiting.kind)
        assertEquals("backendUnreachable", awaiting.failure?.reason)
        val rejected = PurchaseOutcome.Rejected(s, failure).toMessage()
        assertEquals("rejected", rejected.kind)
        assertEquals("sess_1", rejected.session?.id)
        val failed = PurchaseOutcome.Failed(s, billing).toMessage()
        assertEquals("failed", failed.kind)
        assertEquals("itemUnavailable", failed.billingFailure?.reason)
        assertNull(failed.failure)
    }

    @Test
    fun everyEventMapsToItsKind() {
        val s = session()
        val completed = PurchaseEvent.Completed(s, "tok").toMessage()
        assertEquals("completed", completed.kind)
        assertEquals("tok", completed.purchaseToken)
        assertNull(PurchaseEvent.Completed(s, null).toMessage().purchaseToken)
        val pending = PurchaseEvent.Pending("sess_1", listOf("in.example.pro")).toMessage()
        assertEquals("pending", pending.kind)
        assertEquals(listOf("in.example.pro"), pending.productIds)
        val awaiting = PurchaseEvent.AwaitingBackend("sess_1", failure).toMessage()
        assertEquals("awaitingBackend", awaiting.kind)
        assertEquals("sess_1", awaiting.sessionId)
        assertEquals("rejected", PurchaseEvent.Rejected("sess_1", failure).toMessage().kind)
        assertEquals("hostedCheckoutOpened", PurchaseEvent.HostedCheckoutOpened(s).toMessage().kind)
        val unmatched = PurchaseEvent.UnmatchedPurchase("tok", listOf("p")).toMessage()
        assertEquals("unmatchedPurchase", unmatched.kind)
        assertEquals("tok", unmatched.purchaseToken)
    }

    @Test
    fun everyReturnLinkResultMapsToItsKind() {
        val s = session()
        assertEquals("ignored", ReturnLinkResult.Ignored.toMessage().kind)
        assertEquals("completed", ReturnLinkResult.Completed(s).toMessage().kind)
        assertEquals("notPaid", ReturnLinkResult.NotPaid(s).toMessage().kind)
        assertEquals("stillPending", ReturnLinkResult.StillPending(s).toMessage().kind)
        val failed = ReturnLinkResult.BackendFailed(failure).toMessage()
        assertEquals("backendFailed", failed.kind)
        assertEquals("backendUnreachable", failed.failure?.reason)
    }

    @Test
    fun entitlementsKeepOpenValuesAsText() {
        val item = EntitlementItem(
            product = "pro_monthly",
            kind = ProductKind.Subscription,
            provider = Provider.GooglePlay,
            channel = SalesChannel.Store,
            platform = Platform.Android,
            subscriptionId = "sub_1",
            paymentId = null,
            status = EntitlementStatus("on_hold"),
            active = false,
            cancelAtPeriodEnd = true,
            currentPeriodEndMillis = 1_702_592_000_000,
            updatedAtMillis = 1_700_000_000_000,
        )
        val message = Entitlements("cust_1", true, listOf(item)).toMessage()
        assertEquals("cust_1", message.customerRef)
        assertEquals("on_hold", message.items[0].status)
        assertEquals(1_702_592_000_000, message.items[0].currentPeriodEnd)
        assertEquals(true, message.items[0].cancelAtPeriodEnd)
        assertNull(message.items[0].paymentId)
    }

    @Test
    fun customerMessageBecomesACustomer() {
        val customer = CustomerMessage(id = "i", name = "Asha", email = "a@example.com", phone = "9999999999", state = "Karnataka").toCustomer()
        assertEquals("Asha", customer.name)
        assertEquals("Karnataka", customer.state)
        assertEquals("9999999999", customer.phone)
    }

    @Test
    fun serverErrorsKeepCodeStatusAndFlags() {
        val error = PurchaseBackendException.Server(
            ServerError(409, ServerErrorCode.Conflict, "already subscribed", "google_play", "X1", false),
        ).toFlutterError()
        assertEquals("backend", error.code)
        @Suppress("UNCHECKED_CAST")
        val details = error.details as Map<String, Any?>
        assertEquals("server", details["kind"])
        assertEquals(409L, details["statusCode"])
        assertEquals("CONFLICT", details["serverCode"])
        assertEquals("google_play", details["provider"])
        assertEquals(false, details["retryable"])
    }

    @Test
    fun otherBackendFailuresKeepTheirKind() {
        val transport = PurchaseBackendException.Transport("offline").toFlutterError()
        assertEquals("transport", (transport.details as Map<*, *>)["kind"])
        val malformed = PurchaseBackendException.MalformedResponse(200, "not json").toFlutterError()
        assertEquals("malformedResponse", (malformed.details as Map<*, *>)["kind"])
        val invalid = PurchaseBackendException.InvalidRequest("bad url").toFlutterError()
        assertEquals("invalidRequest", (invalid.details as Map<*, *>)["kind"])
    }

    @Test
    fun everyPurchaseExceptionHasItsDartKind() {
        val cases = listOf(
            PurchaseException.PurchaseInProgress() to "purchaseInProgress",
            PurchaseException.NoUsableOption("s") to "noStoreOption",
            PurchaseException.SessionNotOpen("s", SessionStatus.Expired) to "sessionNotOpen",
            PurchaseException.InvalidInstruction("x") to "invalidInstruction",
            PurchaseException.ProductNotFound("p") to "productNotFound",
            PurchaseException.OfferNotAvailable("p", "b", null) to "offerNotAvailable",
            PurchaseException.ActivityGone() to "activityGone",
            PurchaseException.Storage("disk") to "storage",
        )
        for ((exception, kind) in cases) {
            val error = exception.toFlutterError()
            assertEquals("purchase", error.code)
            assertEquals(kind, (error.details as Map<*, *>)["kind"])
        }
    }

    @Test
    fun platformOnlyCallsReportThePlatformPlainly() {
        val error = unsupportedOnAndroid("showManageSubscriptions", "applies to iOS only.")
        assertEquals("unsupported_on_platform", error.code)
        val details = error.details as Map<*, *>
        assertEquals("showManageSubscriptions", details["method"])
        assertEquals("android", details["platform"])
        assertEquals("showManageSubscriptions applies to iOS only.", error.message)
        assertEquals("not_configured", notConfigured().code)
    }
}
