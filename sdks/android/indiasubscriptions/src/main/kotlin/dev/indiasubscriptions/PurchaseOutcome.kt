package dev.indiasubscriptions

import dev.indiasubscriptions.backend.ServerErrorCode
import dev.indiasubscriptions.billing.BillingFailure
import dev.indiasubscriptions.models.PurchaseSession
import dev.indiasubscriptions.models.SessionStatus

/** Why a purchase did not finish with the backend. Carried by [PurchaseOutcome] and [PurchaseEvent]. */
public data class PurchaseFailure(
    val reason: Reason,
    /** The server's error code, when the backend answered with one. */
    val code: ServerErrorCode? = null,
    val message: String,
) {
    public enum class Reason {
        /**
         * The backend could not be reached, or asked the app to wait (offline, timeout, rate limit, expired user token).
         * The purchase stays unconfirmed and is sent again, without a limit.
         */
        BACKEND_UNREACHABLE,

        /**
         * The backend failed in a way that may or may not last. The purchase is sent again, up to
         * `Configuration.maxServerFailures` rounds.
         */
        BACKEND_FAILING,

        /**
         * The backend refused the purchase for a reason that will not change (`message` and `code` say why). It is not
         * sent again until `retryRejectedPurchases()`.
         */
        BACKEND_REFUSED,

        /** The backend looked at the purchase and says it is not paid (refunded, revoked, or the session expired). */
        NOT_PAID,

        /** The backend accepted the call but the session is not settled yet (`open` or `awaiting_payment`). */
        NOT_SETTLED,

        /** The SDK retried through its limit of server failures and stopped. */
        GAVE_UP,

        /** The hosted checkout page could not be opened (no browser, an unusable address). */
        CHECKOUT_UNAVAILABLE,
    }
}

/** What happened to a purchase the app started with `PurchaseClient.purchase`. */
public sealed interface PurchaseOutcome {
    /** The backend confirmed the purchase. The server acknowledged it. Grant access (the entitlements are the backend's to read). */
    public data class Completed(val session: PurchaseSession) : PurchaseOutcome

    /**
     * Google Play says the purchase is pending (a payment method that settles later). Nothing is charged yet and no
     * access is granted. A [PurchaseEvent.Completed] arrives on `PurchaseClient.events` when it is approved, even days later.
     */
    public data class Pending(val session: PurchaseSession) : PurchaseOutcome

    /** The customer closed Google's purchase screen. Nothing was charged. */
    public data class Cancelled(val session: PurchaseSession) : PurchaseOutcome

    /**
     * The customer paid but the backend has not confirmed it (it could not be reached, or has not settled the session).
     * The SDK sends it again at the next launch and resume and in the background while the app runs. Tell the customer
     * the purchase is being confirmed, not that it failed; a [PurchaseEvent.Completed] follows. Google refunds a
     * purchase that is not acknowledged within three days.
     */
    public data class AwaitingBackend(val session: PurchaseSession, val failure: PurchaseFailure) : PurchaseOutcome

    /** The backend refused the purchase for a reason that will not change. It is not sent again. Show a way to reach support. */
    public data class Rejected(val session: PurchaseSession, val failure: PurchaseFailure) : PurchaseOutcome

    /**
     * The hosted checkout page is open in a Custom Tab (the customer chose the alternative on Google's choice screen, or
     * the session sends Android to a gateway). The outcome is only known when the app is opened again through its return
     * link: pass the link to `PurchaseClient.handleReturnLink`. `processPendingPurchases()` reads the session back too.
     */
    public data class AwaitingReturn(val session: PurchaseSession) : PurchaseOutcome

    /**
     * Google Play did not take the purchase and nothing was charged: see [BillingFailure.reason]. For
     * `ITEM_ALREADY_OWNED` the SDK has also refreshed the owned purchases and completed the ones it knows.
     */
    public data class Failed(val session: PurchaseSession, val failure: BillingFailure) : PurchaseOutcome
}

/**
 * A purchase that moved without the app asking for it in a `purchase` call (or after that call stopped waiting): a
 * pending purchase approved later, a retry, a purchase found at start-up after the app was killed mid-purchase.
 */
public sealed interface PurchaseEvent {
    /** The backend confirmed the purchase. [purchaseToken] is null for a hosted checkout. */
    public data class Completed(val session: PurchaseSession, val purchaseToken: String?) : PurchaseEvent

    /** Google Play reports the purchase as pending. Nothing is charged yet. */
    public data class Pending(val sessionId: String, val productIds: List<String>) : PurchaseEvent

    /** The backend has not confirmed the purchase yet; it is retried. */
    public data class AwaitingBackend(val sessionId: String, val failure: PurchaseFailure) : PurchaseEvent

    /** The backend refused the purchase for a reason that will not change; it is not sent again. */
    public data class Rejected(val sessionId: String, val failure: PurchaseFailure) : PurchaseEvent

    /** The hosted checkout page was opened for a session whose `purchase` call is no longer waiting. */
    public data class HostedCheckoutOpened(val session: PurchaseSession) : PurchaseEvent

    /**
     * Google Play reports an unacknowledged purchase that carries no account id, or one this device has no record for
     * (bought on another device or outside the app, or the app was reinstalled). The SDK cannot complete a session for
     * it. The app's access follows the backend's entitlements. Reported once per launch.
     */
    public data class UnmatchedPurchase(val purchaseToken: String, val productIds: List<String>) : PurchaseEvent
}

/** What [PurchaseClient.handleReturnLink] found. */
public sealed interface ReturnLinkResult {
    /** The link is not for a checkout this app has pending (no such session, or it is not a return link). Nothing was read. */
    public data object Ignored : ReturnLinkResult

    /** The backend says the purchase is complete. Read the entitlements. */
    public data class Completed(val session: PurchaseSession) : ReturnLinkResult

    /** The backend says the purchase is not paid ([PurchaseSession.status] is `failed` or `expired`). */
    public data class NotPaid(val session: PurchaseSession) : ReturnLinkResult

    /** The session is not settled yet (the gateway has not confirmed). It is read again on `processPendingPurchases()`. */
    public data class StillPending(val session: PurchaseSession) : ReturnLinkResult

    /** The backend could not be reached, or refused to answer ([PurchaseFailure.reason] says which). An unreachable backend leaves the checkout pending; it is read again later. */
    public data class BackendFailed(val failure: PurchaseFailure) : ReturnLinkResult
}

/** What can go wrong before a purchase reaches Google's screen, or around it. Nothing was charged when one is thrown. */
public sealed class PurchaseException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** Another purchase is still running. The SDK runs one purchase flow at a time. */
    public class PurchaseInProgress : PurchaseException("Another purchase is still running")

    /** The session has neither a Google Play option nor a hosted checkout page. */
    public class NoUsableOption(public val sessionId: String) :
        PurchaseException("The session has no Google Play option and no hosted checkout page")

    /** The session is not open: it is `failed` or `expired`. */
    public class SessionNotOpen(public val sessionId: String, public val status: SessionStatus) :
        PurchaseException("The session is ${status.value}")

    /** The server's checkout instruction cannot be used. */
    public class InvalidInstruction(public val detail: String) : PurchaseException(detail)

    /** Google Play does not know the product id the session named. */
    public class ProductNotFound(public val productId: String) :
        PurchaseException("Google Play does not return the product $productId")

    /** The product is on Google Play but not the base plan or offer the session named (for example an offer the customer is not eligible for). */
    public class OfferNotAvailable(public val productId: String, public val basePlanId: String?, public val offerId: String?) :
        PurchaseException("Google Play does not offer $productId base plan ${basePlanId ?: "-"} offer ${offerId ?: "-"} to this customer")

    /** The activity the purchase was started from is gone. */
    public class ActivityGone : PurchaseException("The activity is gone")

    /** The record store failed to read or write. */
    public class Storage(public val detail: String, cause: Throwable? = null) : PurchaseException(detail, cause)
}
