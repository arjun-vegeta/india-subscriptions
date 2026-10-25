package dev.indiasubscriptions.flutter

import dev.indiasubscriptions.PurchaseEvent
import dev.indiasubscriptions.PurchaseException
import dev.indiasubscriptions.PurchaseFailure
import dev.indiasubscriptions.PurchaseOutcome
import dev.indiasubscriptions.ReturnLinkResult
import dev.indiasubscriptions.backend.PurchaseBackendException
import dev.indiasubscriptions.billing.BillingFailure
import dev.indiasubscriptions.billing.BillingFailureReason
import dev.indiasubscriptions.models.CheckoutInstruction
import dev.indiasubscriptions.models.Customer
import dev.indiasubscriptions.models.EntitlementItem
import dev.indiasubscriptions.models.Entitlements
import dev.indiasubscriptions.models.PurchaseOption
import dev.indiasubscriptions.models.PurchaseSession

/*
 * Translation between the Android SDK's types and the generated messages, and from the SDK's exceptions to the errors
 * the Dart side understands. No decision about a purchase is made here. Every `when` over a sealed type has no `else`
 * branch: a case the SDK adds later stops this file from compiling instead of reaching Dart as a wrong value.
 */

/** The error codes the Dart side reads (`lib/src/errors.dart`). */
internal object ErrorCode {
    const val NOT_CONFIGURED = "not_configured"
    const val BACKEND = "backend"
    const val PURCHASE = "purchase"
    const val UNSUPPORTED_ON_PLATFORM = "unsupported_on_platform"
}

internal const val PLATFORM_NAME = "android"

internal fun PurchaseOption.toMessage(): PurchaseOptionMessage = PurchaseOptionMessage(
    channel = channel.value,
    provider = provider.value,
    handle = handle,
    checkoutKind = checkout.kind,
    storeProductId = (checkout as? CheckoutInstruction.GooglePlayBilling)?.productId,
    hostedUrl = hostedUrl,
)

internal fun PurchaseSession.toMessage(): PurchaseSessionMessage = PurchaseSessionMessage(
    id = id,
    platform = platform.value,
    product = product,
    policy = policy.value,
    status = status.value,
    customerRef = customerRef,
    options = options.map { it.toMessage() },
    createdAt = createdAtMillis,
    expiresAt = expiresAtMillis,
    reference = reference,
    returnUrl = returnUrl,
    completedAt = completedAtMillis,
    subscriptionId = subscriptionId,
    paymentId = paymentId,
    provider = provider?.value,
)

internal fun PurchaseFailure.Reason.wireName(): String = when (this) {
    PurchaseFailure.Reason.BACKEND_UNREACHABLE -> "backendUnreachable"
    PurchaseFailure.Reason.BACKEND_FAILING -> "backendFailing"
    PurchaseFailure.Reason.BACKEND_REFUSED -> "backendRefused"
    PurchaseFailure.Reason.NOT_PAID -> "notPaid"
    PurchaseFailure.Reason.NOT_SETTLED -> "notSettled"
    PurchaseFailure.Reason.GAVE_UP -> "gaveUp"
    PurchaseFailure.Reason.CHECKOUT_UNAVAILABLE -> "checkoutUnavailable"
}

internal fun PurchaseFailure.toMessage(): PurchaseFailureMessage =
    PurchaseFailureMessage(reason = reason.wireName(), message = message, code = code?.value)

internal fun BillingFailureReason.wireName(): String = when (this) {
    BillingFailureReason.USER_CANCELED -> "userCanceled"
    BillingFailureReason.BILLING_UNAVAILABLE -> "billingUnavailable"
    BillingFailureReason.SERVICE_UNAVAILABLE -> "serviceUnavailable"
    BillingFailureReason.SERVICE_DISCONNECTED -> "serviceDisconnected"
    BillingFailureReason.NETWORK_ERROR -> "networkError"
    BillingFailureReason.ITEM_UNAVAILABLE -> "itemUnavailable"
    BillingFailureReason.ITEM_ALREADY_OWNED -> "itemAlreadyOwned"
    BillingFailureReason.ITEM_NOT_OWNED -> "itemNotOwned"
    BillingFailureReason.FEATURE_NOT_SUPPORTED -> "featureNotSupported"
    BillingFailureReason.DEVELOPER_ERROR -> "developerError"
    BillingFailureReason.ERROR -> "error"
    BillingFailureReason.UNKNOWN -> "unknown"
}

internal fun BillingFailure.toMessage(): BillingFailureMessage = BillingFailureMessage(
    reason = reason.wireName(),
    responseCode = responseCode.toLong(),
    message = message,
    isTransient = isTransient,
    subResponseCode = subResponseCode?.toLong(),
)

internal fun PurchaseOutcome.toMessage(): PurchaseOutcomeMessage = when (this) {
    is PurchaseOutcome.Completed -> PurchaseOutcomeMessage(kind = "completed", session = session.toMessage())
    is PurchaseOutcome.Pending -> PurchaseOutcomeMessage(kind = "pending", session = session.toMessage())
    is PurchaseOutcome.Cancelled -> PurchaseOutcomeMessage(kind = "cancelled", session = session.toMessage())
    is PurchaseOutcome.AwaitingBackend ->
        PurchaseOutcomeMessage(kind = "awaitingBackend", session = session.toMessage(), failure = failure.toMessage())
    is PurchaseOutcome.Rejected ->
        PurchaseOutcomeMessage(kind = "rejected", session = session.toMessage(), failure = failure.toMessage())
    is PurchaseOutcome.AwaitingReturn -> PurchaseOutcomeMessage(kind = "awaitingReturn", session = session.toMessage())
    is PurchaseOutcome.Failed ->
        PurchaseOutcomeMessage(kind = "failed", session = session.toMessage(), billingFailure = failure.toMessage())
}

internal fun PurchaseEvent.toMessage(): PurchaseEventMessage = when (this) {
    is PurchaseEvent.Completed ->
        PurchaseEventMessage(kind = "completed", session = session.toMessage(), purchaseToken = purchaseToken)
    is PurchaseEvent.Pending -> PurchaseEventMessage(kind = "pending", sessionId = sessionId, productIds = productIds)
    is PurchaseEvent.AwaitingBackend ->
        PurchaseEventMessage(kind = "awaitingBackend", sessionId = sessionId, failure = failure.toMessage())
    is PurchaseEvent.Rejected ->
        PurchaseEventMessage(kind = "rejected", sessionId = sessionId, failure = failure.toMessage())
    is PurchaseEvent.HostedCheckoutOpened ->
        PurchaseEventMessage(kind = "hostedCheckoutOpened", session = session.toMessage())
    is PurchaseEvent.UnmatchedPurchase ->
        PurchaseEventMessage(kind = "unmatchedPurchase", purchaseToken = purchaseToken, productIds = productIds)
}

internal fun ReturnLinkResult.toMessage(): ReturnLinkResultMessage = when (this) {
    ReturnLinkResult.Ignored -> ReturnLinkResultMessage(kind = "ignored")
    is ReturnLinkResult.Completed -> ReturnLinkResultMessage(kind = "completed", session = session.toMessage())
    is ReturnLinkResult.NotPaid -> ReturnLinkResultMessage(kind = "notPaid", session = session.toMessage())
    is ReturnLinkResult.StillPending -> ReturnLinkResultMessage(kind = "stillPending", session = session.toMessage())
    is ReturnLinkResult.BackendFailed -> ReturnLinkResultMessage(kind = "backendFailed", failure = failure.toMessage())
}

internal fun EntitlementItem.toMessage(): EntitlementItemMessage = EntitlementItemMessage(
    product = product,
    kind = kind.value,
    provider = provider.value,
    channel = channel.value,
    platform = platform.value,
    status = status.value,
    active = active,
    updatedAt = updatedAtMillis,
    subscriptionId = subscriptionId,
    paymentId = paymentId,
    cancelAtPeriodEnd = cancelAtPeriodEnd,
    currentPeriodEnd = currentPeriodEndMillis,
)

internal fun Entitlements.toMessage(): EntitlementsMessage =
    EntitlementsMessage(customerRef = customerRef, active = active, items = items.map { it.toMessage() })

internal fun CustomerMessage.toCustomer(): Customer =
    Customer(id = id, name = name, email = email, phone = phone, state = state)

// -- errors ------------------------------------------------------------------------------------------------------------

internal fun notConfigured(): FlutterError =
    FlutterError(ErrorCode.NOT_CONFIGURED, "Call IndiaSubscriptions.configure before using the plugin.")

internal fun unsupportedOnAndroid(method: String, detail: String): FlutterError = FlutterError(
    ErrorCode.UNSUPPORTED_ON_PLATFORM,
    "$method $detail",
    mapOf("method" to method, "platform" to PLATFORM_NAME),
)

internal fun PurchaseBackendException.toFlutterError(): FlutterError {
    val details = HashMap<String, Any?>()
    when (this) {
        is PurchaseBackendException.Server -> {
            details["kind"] = "server"
            details["statusCode"] = error.statusCode.toLong()
            details["serverCode"] = error.code.value
            details["provider"] = error.provider
            details["providerCode"] = error.providerCode
            details["retryable"] = error.retryable
        }
        is PurchaseBackendException.Transport -> details["kind"] = "transport"
        is PurchaseBackendException.MalformedResponse -> {
            details["kind"] = "malformedResponse"
            details["statusCode"] = statusCode.toLong()
        }
        is PurchaseBackendException.InvalidRequest -> details["kind"] = "invalidRequest"
    }
    return FlutterError(ErrorCode.BACKEND, message, details)
}

internal fun PurchaseException.kindName(): String = when (this) {
    is PurchaseException.PurchaseInProgress -> "purchaseInProgress"
    is PurchaseException.NoUsableOption -> "noStoreOption"
    is PurchaseException.SessionNotOpen -> "sessionNotOpen"
    is PurchaseException.InvalidInstruction -> "invalidInstruction"
    is PurchaseException.ProductNotFound -> "productNotFound"
    is PurchaseException.OfferNotAvailable -> "offerNotAvailable"
    is PurchaseException.ActivityGone -> "activityGone"
    is PurchaseException.Storage -> "storage"
}

internal fun PurchaseException.toFlutterError(): FlutterError =
    FlutterError(ErrorCode.PURCHASE, message, mapOf("kind" to kindName()))
