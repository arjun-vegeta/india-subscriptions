package dev.indiasubscriptions

import android.app.Activity
import android.content.Context
import dev.indiasubscriptions.backend.PurchaseBackend
import dev.indiasubscriptions.backend.PurchaseBackendException
import dev.indiasubscriptions.backend.RetryAdvice
import dev.indiasubscriptions.backend.asBackendFailure
import dev.indiasubscriptions.billing.BillingCode
import dev.indiasubscriptions.billing.BillingFailure
import dev.indiasubscriptions.billing.BillingGateway
import dev.indiasubscriptions.billing.BillingGatewayFactory
import dev.indiasubscriptions.billing.BillingResult
import dev.indiasubscriptions.billing.BillingUpdate
import dev.indiasubscriptions.billing.DevicePurchase
import dev.indiasubscriptions.billing.DevicePurchaseState
import dev.indiasubscriptions.billing.FlowRequest
import dev.indiasubscriptions.billing.ProductQueryResult
import dev.indiasubscriptions.billing.PlayBillingGateway
import dev.indiasubscriptions.billing.PurchasesQueryResult
import dev.indiasubscriptions.billing.StoreOffer
import dev.indiasubscriptions.billing.StoreProduct
import dev.indiasubscriptions.models.ChooseAlternativeInput
import dev.indiasubscriptions.models.CheckoutInstruction
import dev.indiasubscriptions.models.CompletePurchaseInput
import dev.indiasubscriptions.models.Customer
import dev.indiasubscriptions.models.Entitlements
import dev.indiasubscriptions.models.Platform
import dev.indiasubscriptions.models.ProductKind
import dev.indiasubscriptions.models.PurchaseSession
import dev.indiasubscriptions.models.SessionStatus
import dev.indiasubscriptions.models.StartPurchaseInput
import dev.indiasubscriptions.storage.PurchaseRecord
import dev.indiasubscriptions.storage.PurchaseRecordStore
import dev.indiasubscriptions.storage.SharedPreferencesPurchaseRecordStore
import java.lang.ref.WeakReference
import java.net.URI
import java.net.URLDecoder
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext

/**
 * Drives the device side of a Google Play purchase against the merchant's backend.
 *
 * One `PurchaseClient` per app, created at launch and kept alive. The SDK talks only to the merchant's backend through
 * [PurchaseBackend]; it never holds the service's API key and it never acknowledges or consumes a purchase (the server
 * does, when it verifies the purchase).
 *
 * - [purchase] starts a session for a product key and follows the session's options: Google Play Billing (with user
 *   choice billing when the instruction says so) or a hosted checkout page in a Custom Tab.
 * - [start] listens to the billing client and queries the purchases Google Play holds, so that a purchase that
 *   completes after the process died, a pending one approved days later, and one the backend could not be told about
 *   are all sent to the session they belong to. [processPendingPurchases] repeats that pass: call it when the app
 *   returns to the foreground.
 * - [handleReturnLink] reads the outcome of a hosted checkout when the app is opened through its return link.
 *
 * The SDK shows no UI of its own. Results reach the app as a [PurchaseOutcome] (for a purchase the app started and is
 * still waiting for) and as [PurchaseEvent]s on [events] (for everything else).
 *
 * Threading: every method is a suspend function that is safe to call from the main thread; HTTP and storage run on
 * `Dispatchers.IO`, and Google's billing client is only touched on the main thread, where it delivers its callbacks.
 * The `Activity` given to [purchase] is held weakly, is used to launch Google's screen and the Custom Tab, and is not
 * kept after that.
 */
public class PurchaseClient internal constructor(
    private val backend: PurchaseBackend,
    private val billing: BillingGatewayFactory,
    recordStore: PurchaseRecordStore,
    private val opener: HostedPageOpener,
    public val configuration: Configuration,
    private val environment: Environment,
) {
    /** How the client retries and what it does with purchases it cannot place. */
    public data class Configuration(
        /** The platform sent with the start call. */
        val platform: Platform = Platform.Android,
        /**
         * Times one call to the backend is sent in a row before the client gives up for now. Only failures that may
         * succeed later are repeated; the purchase stays unconfirmed and is tried again later.
         */
        val maxCompletionAttempts: Int = 3,
        /** Milliseconds to wait before the second attempt; doubled for each further one. */
        val retryDelayMillis: Long = 1_000,
        /**
         * Rounds (one launch, one purchase, one update) that may end in a lasting-looking server failure before the client
         * marks the purchase rejected and stops sending it. Failures to reach the backend do not count.
         */
        val maxServerFailures: Int = 10,
        /** Times the client tries to connect to the Play Store service, or to repeat a request that failed transiently. */
        val maxBillingAttempts: Int = 4,
        /** Milliseconds to wait before the second connection attempt; doubled for each further one. */
        val billingRetryDelayMillis: Long = 500,
        /** Milliseconds before the first background retry of a purchase the backend has not confirmed; doubled each time. */
        val backgroundRetryDelayMillis: Long = 30_000,
        /** The longest wait between two background retries. */
        val backgroundRetryMaxDelayMillis: Long = 900_000,
        /**
         * When the offer the session names is not offered to this customer (for example an introductory offer they
         * already used), buy the base plan instead of failing. Off by default: the customer would pay the base price, not
         * the price the app showed.
         */
        val allowBasePlanFallback: Boolean = false,
        /** Called with problems the SDK handled itself (a failed storage write, an update it could not process). */
        val diagnostics: ((message: String, error: Throwable?) -> Unit)? = null,
    )

    /** The things tests replace: the scope, the dispatchers and the clock. */
    internal class Environment(
        val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
        val io: CoroutineDispatcher = Dispatchers.IO,
        val main: CoroutineDispatcher = Dispatchers.Main.immediate,
        val now: () -> Long = System::currentTimeMillis,
    )

    /** @see PurchaseClient */
    public constructor(
        backend: PurchaseBackend,
        billing: BillingGatewayFactory,
        recordStore: PurchaseRecordStore,
        opener: HostedPageOpener,
        configuration: Configuration = Configuration(),
    ) : this(backend, billing, recordStore, opener, configuration, Environment())

    private val records = Records(recordStore)
    private val mutableEvents = MutableSharedFlow<PurchaseEvent>(extraBufferCapacity = 64, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /**
     * What happens to purchases outside a [purchase] call that is waiting: a pending purchase approved later, a retry, a
     * purchase found at start-up. Collect it before [start] so that no event is missed; the newest 64 are buffered per
     * collector.
     */
    public val events: SharedFlow<PurchaseEvent> get() = mutableEvents

    private val started = AtomicBoolean(false)
    private val flight = AtomicReference<Flight?>(null)
    private val settling = HashSet<String>()
    private val reportedUnmatched = HashSet<String>()
    /** Sessions with something the backend has not taken yet, and when that began. */
    private val unsettled = HashMap<String, Long>()
    private val billingLock = Mutex()
    private val gatewayLock = Mutex()
    private var current: BillingGateway? = null
    private var currentUserChoice = false
    private var retryJob: Job? = null
    private var reconnectJob: Job? = null
    private var startJob: Job? = null

    // -- lifecycle -----------------------------------------------------------------------------------------------------

    /**
     * Connects to Google Play, starts listening to purchase updates, and runs [processPendingPurchases]. Call it once,
     * as early as possible after launch (Google recommends a connection "when your app is launched or comes to the
     * foreground"). Calling it again does nothing. [purchase] calls it if the app has not.
     */
    public fun start() {
        if (!started.compareAndSet(false, true)) return
        startJob = environment.scope.launch { processPendingPurchases() }
    }

    /** Stops listening, ends the billing connection and cancels the background retries. [start] works again afterwards. */
    public fun stop() {
        started.set(false)
        startJob?.cancel()
        retryJob?.cancel()
        reconnectJob?.cancel()
        val gateway = synchronized(this) { current.also { current = null } }
        gateway?.close()
    }

    // -- purchase ------------------------------------------------------------------------------------------------------

    /**
     * Buys a product.
     *
     * Calls the backend's start, then follows the session:
     *
     * - **Google Play option.** Builds the billing client (with user choice billing when the instruction says so), loads
     *   the product, picks the offer from `basePlanId` / `offerId`, writes the account id and the session id to the record
     *   store, and launches Google's screen with the obfuscated account id. What Google returns is handled as follows:
     *   a purchase goes to the backend's complete call (`{ purchaseToken, productId }`, provider `google_play`) and the
     *   call returns [PurchaseOutcome.Completed]; a pending purchase returns [PurchaseOutcome.Pending] and completes
     *   later as a [PurchaseEvent.Completed]; a closed screen returns [PurchaseOutcome.Cancelled]; if the customer chose
     *   the alternative, the external transaction token goes to the backend's alternative call, the hosted page opens in a
     *   Custom Tab and the call returns [PurchaseOutcome.AwaitingReturn].
     * - **Gateway option only.** The hosted page opens in a Custom Tab: [PurchaseOutcome.AwaitingReturn].
     *
     * Only one purchase runs at a time. If the calling coroutine is cancelled while Google's screen is open, the purchase
     * is not lost: its result is handled when it arrives and reported as a [PurchaseEvent].
     *
     * @param activity launches Google's screen and the Custom Tab. Held weakly.
     * @param product your product key (the key the backend's catalogue knows it by).
     * @param customerRef your id for the customer; entitlements are kept under it.
     * @param reference your own id for this purchase (at most 25 characters of letters, digits, `_` and `-`). Starting
     *   again with the same reference and customer returns the same session.
     * @param returnUrl the app's return link: where the hosted checkout sends the customer when it is done.
     * @throws dev.indiasubscriptions.backend.PurchaseBackendException when the start call fails.
     * @throws PurchaseException for the rest. Nothing was charged when it is thrown.
     */
    public suspend fun purchase(
        activity: Activity,
        product: String,
        customerRef: String,
        customer: Customer = Customer(),
        reference: String? = null,
        returnUrl: String? = null,
    ): PurchaseOutcome = purchase(WeakReference(activity), product, customerRef, customer, reference, returnUrl)

    internal suspend fun purchase(
        host: WeakReference<Activity>?,
        product: String,
        customerRef: String,
        customer: Customer,
        reference: String?,
        returnUrl: String?,
    ): PurchaseOutcome {
        start()
        val running = Flight(host)
        if (!flight.compareAndSet(null, running)) throw PurchaseException.PurchaseInProgress()
        try {
            val session = try {
                backend.startPurchase(
                    StartPurchaseInput(configuration.platform, product, customer, customerRef, reference, returnUrl),
                )
            } catch (error: Throwable) {
                throw error.asBackendFailure()
            }
            running.session = session
            when (session.status) {
                SessionStatus.Completed -> return PurchaseOutcome.Completed(session)
                SessionStatus.Failed, SessionStatus.Expired -> throw PurchaseException.SessionNotOpen(session.id, session.status)
            }
            val play = session.googlePlayOption
            val hosted = session.hostedOption
            // A session that already carries its gateway option has been through the choice screen: open the page again.
            if (play == null || (hosted != null && session.externalTransactionToken != null)) {
                if (hosted == null) throw PurchaseException.NoUsableOption(session.id)
                return openHostedCheckout(running, session, hosted.hostedUrl.orEmpty())
            }
            return playFlow(running, session, play.checkout)
        } finally {
            flight.compareAndSet(running, null)
        }
    }

    private suspend fun playFlow(running: Flight, session: PurchaseSession, checkout: CheckoutInstruction.GooglePlayBilling): PurchaseOutcome {
        if (checkout.obfuscatedAccountId.isEmpty() || checkout.obfuscatedAccountId.length > MAX_ACCOUNT_ID_LENGTH) {
            throw PurchaseException.InvalidInstruction("The obfuscated account id must be 1 to $MAX_ACCOUNT_ID_LENGTH characters")
        }
        if (checkout.productKind != ProductKind.Subscription && checkout.productKind != ProductKind.OneTime) {
            throw PurchaseException.InvalidInstruction("Unknown product kind ${checkout.productKind}")
        }
        // One user of the billing client at a time, so that it is not replaced under a request that is using it. The lock
        // is not held while the customer is in Google's screen.
        val early = billingLock.withLock {
            val gateway = gateway(checkout.userChoiceBilling)
            val query = billingCall(gateway, { ProductQueryResult(it, null) }, { it.result }) {
                gateway.queryProduct(checkout.productId, checkout.productKind)
            }
            if (!query.result.isOk) return@withLock failureOutcome(session, query.result)
            val product = query.product ?: throw PurchaseException.ProductNotFound(checkout.productId)
            val offer = selectOffer(product, checkout, configuration.allowBasePlanFallback)
            if (running.host?.get() == null) throw PurchaseException.ActivityGone()

            // The map from the account id to the session, on disk before Google's screen opens: a purchase that completes
            // after the process died still finds its session.
            records.upsert(
                PurchaseRecord(
                    sessionId = session.id,
                    product = session.product,
                    kind = PurchaseRecord.Kind.GOOGLE_PLAY,
                    accountId = checkout.obfuscatedAccountId,
                    googleProductId = checkout.productId,
                    userChoice = checkout.userChoiceBilling,
                    returnUrl = session.returnUrl,
                    createdAtMillis = environment.now(),
                    expiresAtMillis = session.expiresAtMillis,
                ),
            )
            running.accountId = checkout.obfuscatedAccountId
            running.launched = true
            val launch = withContext(environment.main) {
                gateway.launch(running.host?.get(), FlowRequest(product, offer.token, checkout.obfuscatedAccountId))
            }
            if (launch.isOk) return@withLock null
            running.launched = false
            records.remove(session.id) { it.state == PurchaseRecord.State.OPEN }
            failureOutcome(session, launch)
        }
        return early ?: running.outcome.await()
    }

    private suspend fun openHostedCheckout(running: Flight?, session: PurchaseSession, url: String): PurchaseOutcome {
        val now = environment.now()
        records.upsert(
            PurchaseRecord(
                sessionId = session.id,
                product = session.product,
                kind = PurchaseRecord.Kind.HOSTED,
                state = PurchaseRecord.State.AWAITING_RETURN,
                returnUrl = session.returnUrl,
                createdAtMillis = now,
                expiresAtMillis = session.expiresAtMillis,
            ),
        )
        return when (val opened = open(running?.host, url)) {
            null -> PurchaseOutcome.AwaitingReturn(session)
            else -> PurchaseOutcome.Rejected(session, PurchaseFailure(PurchaseFailure.Reason.CHECKOUT_UNAVAILABLE, message = opened))
        }
    }

    /** Opens the hosted page on the main thread. Returns null when it opened, else the reason it did not. */
    private suspend fun open(host: WeakReference<Activity>?, url: String): String? = try {
        withContext(environment.main) { opener.open(host?.get(), url) }
        null
    } catch (error: CancellationException) {
        throw error
    } catch (error: Exception) {
        diagnose("The hosted checkout page could not be opened", error)
        error.message ?: error.javaClass.simpleName
    }

    private fun failureOutcome(session: PurchaseSession, result: BillingResult): PurchaseOutcome {
        val failure = BillingFailure.from(result)
        return when (result.code) {
            BillingCode.USER_CANCELED -> PurchaseOutcome.Cancelled(session)
            BillingCode.ITEM_ALREADY_OWNED -> {
                // Google: refresh the purchases and process them; they are the ones this customer already owns.
                environment.scope.launch { processPendingPurchases() }
                PurchaseOutcome.Failed(session, failure)
            }
            else -> PurchaseOutcome.Failed(session, failure)
        }
    }

    // -- updates from the billing client ---------------------------------------------------------------------------------

    private suspend fun handleUpdate(update: BillingUpdate) {
        try {
            when (update) {
                is BillingUpdate.PurchasesUpdated -> handlePurchasesUpdated(update)
                is BillingUpdate.UserChoice -> handleUserChoice(update)
                BillingUpdate.Disconnected -> scheduleReconnect()
            }
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            // One update the SDK cannot process must not end the collection of the next ones.
            diagnose("A billing update could not be processed", error)
        }
    }

    private suspend fun handlePurchasesUpdated(update: BillingUpdate.PurchasesUpdated) {
        if (update.result.isOk) {
            for (purchase in update.purchases) handlePurchase(purchase)
            return
        }
        val running = flight.get() ?: return
        val session = running.session
        if (!running.launched || session == null) return
        records.remove(session.id) { it.state == PurchaseRecord.State.OPEN }
        if (running.outcome.complete(failureOutcome(session, update.result))) flight.compareAndSet(running, null)
    }

    /**
     * Sends one purchase to the session it belongs to. Idempotent: the same purchase delivered twice (by
     * `onPurchasesUpdated` and by a query, or by two queries) is sent once, and a purchase the backend confirmed is not
     * sent again. Returns the event it published, if any.
     */
    private suspend fun handlePurchase(purchase: DevicePurchase): PurchaseEvent? {
        if (purchase.state == DevicePurchaseState.UNSPECIFIED) return null
        if (!synchronized(settling) { settling.add(purchase.purchaseToken) }) return null // being sent already
        try {
            val record = purchase.obfuscatedAccountId?.let { records.findByAccount(it) }
                ?: return reportUnmatched(purchase)
            val running = flight.get()?.takeIf { it.accountId == record.accountId }
            if (purchase.state == DevicePurchaseState.PENDING) return handlePending(purchase, record, running)
            if (purchase.purchaseToken in record.completedPurchaseTokens || record.state == PurchaseRecord.State.COMPLETED) {
                // Confirmed before: finishing the waiting call is all that is left (the app died after the confirmation).
                running?.let { r -> r.session?.let { s -> if (r.outcome.complete(PurchaseOutcome.Completed(s))) flight.compareAndSet(r, null) } }
                return null
            }
            if (record.state == PurchaseRecord.State.REJECTED) return null
            val productId = record.googleProductId?.takeIf { it in purchase.productIds } ?: purchase.productIds.firstOrNull().orEmpty()
            val settlement = settle(record, purchase.purchaseToken, productId)
            return dispatchSettlement(running, record, purchase.purchaseToken, settlement)
        } finally {
            synchronized(settling) { settling.remove(purchase.purchaseToken) }
        }
    }

    private suspend fun handlePending(purchase: DevicePurchase, record: PurchaseRecord, running: Flight?): PurchaseEvent? {
        val firstTime = record.state != PurchaseRecord.State.PENDING && record.state != PurchaseRecord.State.COMPLETED
        if (firstTime) records.update(record.sessionId) { it.copy(state = PurchaseRecord.State.PENDING) }
        val event = PurchaseEvent.Pending(record.sessionId, purchase.productIds)
        val session = running?.session
        if (running != null && session != null && running.outcome.complete(PurchaseOutcome.Pending(session))) {
            flight.compareAndSet(running, null)
            return null
        }
        return if (firstTime) publish(event) else null
    }

    private fun reportUnmatched(purchase: DevicePurchase): PurchaseEvent? {
        // An acknowledged purchase is one the server has already confirmed, whichever device it was bought on.
        if (purchase.acknowledged) return null
        if (!synchronized(reportedUnmatched) { reportedUnmatched.add(purchase.purchaseToken) }) return null
        return publish(PurchaseEvent.UnmatchedPurchase(purchase.purchaseToken, purchase.productIds))
    }

    // -- sending a purchase to the backend ---------------------------------------------------------------------------

    private sealed interface Settlement {
        data class Completed(val session: PurchaseSession) : Settlement
        data class Awaiting(val session: PurchaseSession?, val failure: PurchaseFailure) : Settlement
        data class Rejected(val session: PurchaseSession?, val failure: PurchaseFailure) : Settlement
    }

    private suspend fun settle(record: PurchaseRecord, purchaseToken: String, productId: String): Settlement {
        val result = callBackend { backend.completePurchase(record.sessionId, CompletePurchaseInput.googlePlay(purchaseToken, productId)) }
        return when (result) {
            is Attempt.Success -> applyConfirmation(result.value, record, purchaseToken)
            is Attempt.Failure -> failed(result.error, record)
        }
    }

    private sealed interface Attempt<out T> {
        data class Success<T>(val value: T) : Attempt<T>
        data class Failure(val error: PurchaseBackendException) : Attempt<Nothing>
    }

    /** One backend call, repeated while the failure may succeed later, up to `maxCompletionAttempts` times in a row. */
    private suspend fun <T> callBackend(call: suspend () -> T): Attempt<T> {
        var attempt = 0
        var wait = configuration.retryDelayMillis
        while (true) {
            attempt++
            try {
                return Attempt.Success(call())
            } catch (error: Throwable) {
                val failure = error.asBackendFailure()
                val canRepeat = failure.retryAdvice != RetryAdvice.NEVER && attempt < maxOf(1, configuration.maxCompletionAttempts)
                if (!canRepeat) return Attempt.Failure(failure)
                if (wait > 0) delay(wait)
                wait *= 2
            }
        }
    }

    private suspend fun failed(error: PurchaseBackendException, record: PurchaseRecord): Settlement {
        val code = error.code
        val message = error.message.orEmpty()
        return when (error.retryAdvice) {
            RetryAdvice.NEVER -> {
                records.update(record.sessionId) { it.copy(state = PurchaseRecord.State.REJECTED, lastErrorCode = code?.value) }
                markSettled(record.sessionId)
                Settlement.Rejected(null, PurchaseFailure(PurchaseFailure.Reason.BACKEND_REFUSED, code, message))
            }
            RetryAdvice.LATER -> {
                markUnsettled(record.sessionId)
                Settlement.Awaiting(null, PurchaseFailure(PurchaseFailure.Reason.BACKEND_UNREACHABLE, code, message))
            }
            RetryAdvice.LIMITED -> {
                var gaveUp = false
                records.update(record.sessionId) {
                    val rounds = it.failedRounds + 1
                    gaveUp = rounds >= configuration.maxServerFailures
                    if (gaveUp) it.copy(failedRounds = rounds, state = PurchaseRecord.State.REJECTED, lastErrorCode = code?.value) else it.copy(failedRounds = rounds)
                }
                if (gaveUp) {
                    markSettled(record.sessionId)
                    Settlement.Rejected(null, PurchaseFailure(PurchaseFailure.Reason.GAVE_UP, code, message))
                } else {
                    markUnsettled(record.sessionId)
                    Settlement.Awaiting(null, PurchaseFailure(PurchaseFailure.Reason.BACKEND_FAILING, code, message))
                }
            }
        }
    }

    private suspend fun applyConfirmation(session: PurchaseSession, record: PurchaseRecord, purchaseToken: String): Settlement = when (session.status) {
        SessionStatus.Completed -> {
            records.update(record.sessionId) {
                it.copy(
                    state = PurchaseRecord.State.COMPLETED,
                    failedRounds = 0,
                    completedPurchaseTokens = if (purchaseToken in it.completedPurchaseTokens) it.completedPurchaseTokens else it.completedPurchaseTokens + purchaseToken,
                )
            }
            markSettled(record.sessionId)
            Settlement.Completed(session)
        }
        SessionStatus.Failed, SessionStatus.Expired -> {
            val reason = if (session.status == SessionStatus.Expired) "The session expired without a payment" else "The backend says the purchase is not paid"
            records.update(record.sessionId) { it.copy(state = PurchaseRecord.State.REJECTED, lastErrorCode = session.status.value) }
            markSettled(record.sessionId)
            Settlement.Rejected(session, PurchaseFailure(PurchaseFailure.Reason.NOT_PAID, message = reason))
        }
        else -> {
            // `open`, `awaiting_payment`, or a status a newer server added: not settled yet.
            markUnsettled(record.sessionId)
            Settlement.Awaiting(session, PurchaseFailure(PurchaseFailure.Reason.NOT_SETTLED, message = "The session is ${session.status.value}"))
        }
    }

    /** Hands a settlement to the call that is waiting for it, or publishes it as an event. */
    private fun dispatchSettlement(running: Flight?, record: PurchaseRecord, purchaseToken: String, settlement: Settlement): PurchaseEvent? {
        val fallback = running?.session
        val outcome: PurchaseOutcome?
        val event: PurchaseEvent
        when (settlement) {
            is Settlement.Completed -> {
                outcome = PurchaseOutcome.Completed(settlement.session)
                event = PurchaseEvent.Completed(settlement.session, purchaseToken)
            }
            is Settlement.Awaiting -> {
                val session = settlement.session ?: fallback
                outcome = session?.let { PurchaseOutcome.AwaitingBackend(it, settlement.failure) }
                event = PurchaseEvent.AwaitingBackend(record.sessionId, settlement.failure)
            }
            is Settlement.Rejected -> {
                val session = settlement.session ?: fallback
                outcome = session?.let { PurchaseOutcome.Rejected(it, settlement.failure) }
                event = PurchaseEvent.Rejected(record.sessionId, settlement.failure)
            }
        }
        if (running != null && outcome != null && running.outcome.complete(outcome)) {
            flight.compareAndSet(running, null)
            return null
        }
        return publish(event)
    }

    // -- user choice billing -------------------------------------------------------------------------------------------

    private suspend fun handleUserChoice(update: BillingUpdate.UserChoice) {
        val running = flight.get()
        val accountId = running?.accountId
        val record = if (accountId != null) {
            records.findByAccount(accountId)
        } else {
            // The call that started the flow is gone (the app was recreated while Google's screen was open).
            records.all()
                .filter {
                    it.kind == PurchaseRecord.Kind.GOOGLE_PLAY && it.userChoice && it.state == PurchaseRecord.State.OPEN &&
                        it.googleProductId in update.productIds
                }
                .maxByOrNull { it.createdAtMillis }
        } ?: return
        // The token first on disk: Google needs it reported within 24 hours of the payment, so it is kept until the backend has it.
        val stored = records.update(record.sessionId) {
            it.copy(state = PurchaseRecord.State.TOKEN_UNSENT, externalTransactionToken = update.externalTransactionToken)
        } ?: record.copy(state = PurchaseRecord.State.TOKEN_UNSENT, externalTransactionToken = update.externalTransactionToken)
        deliverAlternative(stored, running?.takeIf { it.accountId == record.accountId })
    }

    /** Sends a stored external transaction token to the backend, then opens the hosted page its answer names. */
    private suspend fun deliverAlternative(record: PurchaseRecord, running: Flight?): PurchaseEvent? {
        val token = record.externalTransactionToken ?: return null
        val result = callBackend { backend.chooseAlternative(record.sessionId, ChooseAlternativeInput(token)) }
        when (result) {
            is Attempt.Failure -> {
                val error = result.error
                val code = error.code
                if (error.retryAdvice == RetryAdvice.NEVER) {
                    records.update(record.sessionId) {
                        it.copy(state = PurchaseRecord.State.REJECTED, lastErrorCode = code?.value, externalTransactionToken = null)
                    }
                    markSettled(record.sessionId)
                    val failure = PurchaseFailure(PurchaseFailure.Reason.BACKEND_REFUSED, code, error.message.orEmpty())
                    return dispatchHosted(running, record.sessionId, PurchaseOutcomeFactory.rejected(running?.session, failure), PurchaseEvent.Rejected(record.sessionId, failure))
                }
                markUnsettled(record.sessionId)
                val failure = PurchaseFailure(
                    if (error.retryAdvice == RetryAdvice.LATER) PurchaseFailure.Reason.BACKEND_UNREACHABLE else PurchaseFailure.Reason.BACKEND_FAILING,
                    code,
                    error.message.orEmpty(),
                )
                return dispatchHosted(running, record.sessionId, PurchaseOutcomeFactory.awaiting(running?.session, failure), PurchaseEvent.AwaitingBackend(record.sessionId, failure))
            }
            is Attempt.Success -> {
                val session = result.value
                val url = session.hostedOption?.hostedUrl
                if (url.isNullOrEmpty()) {
                    records.update(record.sessionId) { it.copy(state = PurchaseRecord.State.REJECTED, externalTransactionToken = null) }
                    markSettled(record.sessionId)
                    val failure = PurchaseFailure(PurchaseFailure.Reason.CHECKOUT_UNAVAILABLE, message = "The session has no hosted checkout page")
                    return dispatchHosted(running, record.sessionId, PurchaseOutcome.Rejected(session, failure), PurchaseEvent.Rejected(record.sessionId, failure))
                }
                records.update(record.sessionId) { it.copy(state = PurchaseRecord.State.AWAITING_RETURN, externalTransactionToken = null, failedRounds = 0) }
                markSettled(record.sessionId)
                val problem = open(running?.host, url)
                return if (problem == null) {
                    dispatchHosted(running, record.sessionId, PurchaseOutcome.AwaitingReturn(session), PurchaseEvent.HostedCheckoutOpened(session))
                } else {
                    val failure = PurchaseFailure(PurchaseFailure.Reason.CHECKOUT_UNAVAILABLE, message = problem)
                    dispatchHosted(running, record.sessionId, PurchaseOutcome.Rejected(session, failure), PurchaseEvent.Rejected(record.sessionId, failure))
                }
            }
        }
    }

    private fun dispatchHosted(running: Flight?, sessionId: String, outcome: PurchaseOutcome?, event: PurchaseEvent): PurchaseEvent? {
        if (running != null && outcome != null && running.outcome.complete(outcome)) {
            flight.compareAndSet(running, null)
            return null
        }
        return publish(event)
    }

    private object PurchaseOutcomeFactory {
        fun rejected(session: PurchaseSession?, failure: PurchaseFailure): PurchaseOutcome? = session?.let { PurchaseOutcome.Rejected(it, failure) }
        fun awaiting(session: PurchaseSession?, failure: PurchaseFailure): PurchaseOutcome? = session?.let { PurchaseOutcome.AwaitingBackend(it, failure) }
    }

    // -- hosted checkouts and the return link -----------------------------------------------------------------------------

    /**
     * Reads the outcome of a hosted checkout when the app is opened through its return link.
     *
     * Nothing in the link is trusted. Its `status` is never read, and its `session` is only used to pick one of the
     * checkouts this app has itself recorded as pending: a link that names any other session, or that does not point to
     * the `returnUrl` the session was started with, is [ReturnLinkResult.Ignored]. The outcome is what the backend says
     * about the recorded session, read with the user's own authorisation.
     *
     * Call it from `onCreate` (for the intent the activity started with) and from `onNewIntent`; see also the
     * `handleReturnLink(Intent?)` extension.
     */
    public suspend fun handleReturnLink(link: String): ReturnLinkResult {
        val destination = parse(link) ?: return ReturnLinkResult.Ignored
        val named = queryParameter(link, RETURN_SESSION_PARAMETER)
        // Only the checkouts this app recorded as pending, and only when the link points where their session said it would.
        val pending = records.all().filter {
            it.state == PurchaseRecord.State.AWAITING_RETURN && (it.returnUrl == null || sameDestination(destination, it.returnUrl))
        }
        val record = when {
            named != null -> pending.firstOrNull { it.sessionId == named }
            pending.size == 1 -> pending[0]
            else -> null
        } ?: return ReturnLinkResult.Ignored
        return when (val reading = readHosted(record)) {
            is HostedReading.Completed -> ReturnLinkResult.Completed(reading.session)
            is HostedReading.NotPaid -> ReturnLinkResult.NotPaid(reading.session)
            is HostedReading.StillPending -> ReturnLinkResult.StillPending(reading.session)
            is HostedReading.Failed -> ReturnLinkResult.BackendFailed(reading.failure)
        }
    }

    private sealed interface HostedReading {
        data class Completed(val session: PurchaseSession) : HostedReading
        data class NotPaid(val session: PurchaseSession) : HostedReading
        data class StillPending(val session: PurchaseSession) : HostedReading
        data class Failed(val failure: PurchaseFailure) : HostedReading
    }

    /** Reads a recorded hosted checkout's session from the backend and updates the record. */
    private suspend fun readHosted(record: PurchaseRecord): HostedReading {
        return when (val result = callBackend { backend.purchase(record.sessionId) }) {
            is Attempt.Failure -> {
                val error = result.error
                if (error.retryAdvice == RetryAdvice.NEVER) {
                    records.update(record.sessionId) { it.copy(state = PurchaseRecord.State.REJECTED, lastErrorCode = error.code?.value) }
                    HostedReading.Failed(PurchaseFailure(PurchaseFailure.Reason.BACKEND_REFUSED, error.code, error.message.orEmpty()))
                } else {
                    val reason = if (error.retryAdvice == RetryAdvice.LATER) PurchaseFailure.Reason.BACKEND_UNREACHABLE else PurchaseFailure.Reason.BACKEND_FAILING
                    HostedReading.Failed(PurchaseFailure(reason, error.code, error.message.orEmpty()))
                }
            }
            is Attempt.Success -> {
                val session = result.value
                when (session.status) {
                    SessionStatus.Completed -> {
                        records.update(record.sessionId) { it.copy(state = PurchaseRecord.State.COMPLETED) }
                        HostedReading.Completed(session)
                    }
                    SessionStatus.Failed, SessionStatus.Expired -> {
                        records.update(record.sessionId) { it.copy(state = PurchaseRecord.State.REJECTED, lastErrorCode = session.status.value) }
                        HostedReading.NotPaid(session)
                    }
                    else -> HostedReading.StillPending(session)
                }
            }
        }
    }

    // -- the pass over everything that may be waiting -----------------------------------------------------------------

    /**
     * Sends every purchase Google Play holds for this app to the session it belongs to, sends external transaction
     * tokens the backend does not have yet, and reads the pending hosted checkouts back from the backend. [start] runs
     * it at launch; call it again when the app returns to the foreground (Google: "call `queryPurchasesAsync()` in your
     * app's `onResume()`") and when the user signs in.
     *
     * A purchase is sent at most once at a time and never again after the backend confirmed it, so calling it often is
     * safe. A purchase that cannot be placed (no record) is reported once per launch as
     * [PurchaseEvent.UnmatchedPurchase]. Returns the events this pass produced; they are also published on [events].
     */
    public suspend fun processPendingPurchases(): List<PurchaseEvent> {
        val produced = ArrayList<PurchaseEvent>()
        try {
            produced += scanPlayPurchases()
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            diagnose("Google Play's purchases could not be read", error)
        }
        for (record in records.all()) {
            try {
                when {
                    record.state == PurchaseRecord.State.TOKEN_UNSENT -> deliverAlternative(record, null)?.let { produced += it }
                    record.state == PurchaseRecord.State.AWAITING_RETURN -> readHostedAsEvent(record)?.let { produced += it }
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Exception) {
                diagnose("A pending purchase could not be refreshed", error)
            }
        }
        records.prune(environment.now())
        return produced
    }

    private suspend fun scanPlayPurchases(): List<PurchaseEvent> {
        // The queries under the billing lock; the backend calls after it.
        val found = ArrayList<DevicePurchase>()
        billingLock.withLock {
            val gateway = gateway(null)
            for (kind in listOf(ProductKind.Subscription, ProductKind.OneTime)) {
                val query = billingCall(gateway, { PurchasesQueryResult(it, emptyList()) }, { it.result }) { gateway.queryPurchases(kind) }
                if (!query.result.isOk) {
                    diagnose("Google Play's purchases could not be queried: ${query.result.code} ${query.result.message}", null)
                    continue
                }
                found += query.purchases
            }
        }
        val produced = ArrayList<PurchaseEvent>()
        for (purchase in found) handlePurchase(purchase)?.let { produced += it }
        return produced
    }

    private suspend fun readHostedAsEvent(record: PurchaseRecord): PurchaseEvent? = when (val reading = readHosted(record)) {
        is HostedReading.Completed -> publish(PurchaseEvent.Completed(reading.session, null))
        is HostedReading.NotPaid -> publish(
            PurchaseEvent.Rejected(
                record.sessionId,
                PurchaseFailure(PurchaseFailure.Reason.NOT_PAID, message = "The hosted checkout ended as ${reading.session.status.value}"),
            ),
        )
        is HostedReading.StillPending, is HostedReading.Failed -> null
    }

    /** Clears the "refused" mark of every rejected purchase record and runs [processPendingPurchases]. For when the merchant fixed what a refusal pointed at. */
    public suspend fun retryRejectedPurchases(): List<PurchaseEvent> {
        records.reopenRejected()
        return processPendingPurchases()
    }

    // -- restore and entitlements ----------------------------------------------------------------------------------------

    /**
     * Runs [processPendingPurchases] and returns the backend's entitlements for the customer. Google Play needs no
     * separate restore call: its purchases are listed by the same query. The backend's entitlements are the source of
     * truth for what the customer owns; a customer whose subscription is active sees it whether or not any purchase is
     * sent again.
     */
    public suspend fun restorePurchases(customerRef: String): Entitlements {
        processPendingPurchases()
        return entitlements(customerRef)
    }

    /** The backend's entitlements for the customer: the source of truth for what they own. */
    public suspend fun entitlements(customerRef: String): Entitlements = try {
        backend.entitlements(customerRef)
    } catch (error: Throwable) {
        throw error.asBackendFailure()
    }

    // -- billing connection --------------------------------------------------------------------------------------------

    /**
     * The billing gateway for a mode. [userChoice] null accepts whatever is open (or opens one without user choice
     * billing). A gateway of the other mode replaces the open one: user choice billing is a property of the client.
     */
    private suspend fun gateway(userChoice: Boolean?): BillingGateway = gatewayLock.withLock {
        val existing = current
        if (existing != null && (userChoice == null || userChoice == currentUserChoice)) return@withLock existing
        existing?.close() // ends its update stream; what was already buffered is still handled
        val mode = userChoice ?: false
        val created = billing.create(mode)
        current = created
        currentUserChoice = mode
        environment.scope.launch {
            created.updates.collect { handleUpdate(it) }
        }
        created
    }

    private suspend fun ensureConnected(gateway: BillingGateway): BillingResult {
        val attempts = maxOf(1, configuration.maxBillingAttempts)
        var wait = configuration.billingRetryDelayMillis
        var last = BillingResult.ok()
        for (attempt in 1..attempts) {
            if (gateway.isReady) return BillingResult.ok()
            last = gateway.connect()
            if (last.isOk) return last
            if (!BillingFailure.isRetryable(last.code) || attempt == attempts) return last
            delay(wait)
            wait *= 2
        }
        return last
    }

    /** One request to the billing client: connects first, and repeats it (reconnecting) while Google calls the failure transient. */
    private suspend fun <R> billingCall(
        gateway: BillingGateway,
        failed: (BillingResult) -> R,
        resultOf: (R) -> BillingResult,
        request: suspend () -> R,
    ): R {
        val attempts = maxOf(1, configuration.maxBillingAttempts)
        var wait = configuration.billingRetryDelayMillis
        for (attempt in 1..attempts) {
            val connected = ensureConnected(gateway)
            if (!connected.isOk) return failed(connected)
            val response = request()
            val result = resultOf(response)
            if (result.isOk || !BillingFailure.isRetryable(result.code) || attempt == attempts) return response
            delay(wait)
            wait *= 2
        }
        error("unreachable")
    }

    /** After a lost connection: reconnect in the background and look at what may have arrived meanwhile. */
    private fun scheduleReconnect() {
        synchronized(this) {
            if (reconnectJob?.isActive == true || !started.get()) return
            reconnectJob = environment.scope.launch {
                processPendingPurchases()
            }
        }
    }

    // -- background retry --------------------------------------------------------------------------------------------

    private fun markUnsettled(sessionId: String) {
        synchronized(unsettled) { if (!unsettled.containsKey(sessionId)) unsettled[sessionId] = environment.now() }
        scheduleBackgroundRetry()
    }

    private fun markSettled(sessionId: String) {
        synchronized(unsettled) { unsettled.remove(sessionId) }
    }

    /**
     * While the app runs, a purchase the backend has not confirmed is sent again with a growing delay. The retrying stops
     * after three days, the time Google gives to acknowledge a purchase before it refunds it: after that there is nothing
     * left to deliver. A later launch looks again.
     */
    private fun scheduleBackgroundRetry() {
        synchronized(this) {
            if (retryJob?.isActive == true) return
            retryJob = environment.scope.launch {
                var wait = configuration.backgroundRetryDelayMillis
                while (isActive) {
                    delay(wait)
                    val cutoff = environment.now() - ACKNOWLEDGEMENT_WINDOW_MILLIS
                    val nothingLeft = synchronized(unsettled) {
                        unsettled.values.removeAll { it < cutoff }
                        unsettled.isEmpty()
                    }
                    if (nothingLeft) break
                    processPendingPurchases()
                    wait = minOf(wait * 2, configuration.backgroundRetryMaxDelayMillis)
                }
            }
        }
    }

    // -- records -------------------------------------------------------------------------------------------------------

    private inner class Records(private val store: PurchaseRecordStore) {
        private val lock = Mutex()

        suspend fun all(): List<PurchaseRecord> = lock.withLock { read() }

        suspend fun findByAccount(accountId: String): PurchaseRecord? = all().firstOrNull { it.accountId == accountId }

        /** Writes a record, replacing the one of the same session. Throws [PurchaseException.Storage]. */
        suspend fun upsert(record: PurchaseRecord) {
            lock.withLock {
                val all = read().filter { it.sessionId != record.sessionId } + record
                write(all)
            }
        }

        /** Changes a record. A storage failure is reported to the diagnostics and the change is lost: the purchase is sent again. */
        suspend fun update(sessionId: String, change: (PurchaseRecord) -> PurchaseRecord): PurchaseRecord? = try {
            lock.withLock {
                val all = read()
                val index = all.indexOfFirst { it.sessionId == sessionId }
                if (index < 0) {
                    null
                } else {
                    val changed = change(all[index]).copy(updatedAtMillis = environment.now())
                    write(all.toMutableList().also { it[index] = changed })
                    changed
                }
            }
        } catch (error: PurchaseException.Storage) {
            diagnose("A purchase record could not be updated", error)
            null
        }

        suspend fun remove(sessionId: String, onlyIf: (PurchaseRecord) -> Boolean) {
            try {
                lock.withLock { write(read().filter { it.sessionId != sessionId || !onlyIf(it) }) }
            } catch (error: PurchaseException.Storage) {
                diagnose("A purchase record could not be removed", error)
            }
        }

        suspend fun reopenRejected() {
            try {
                lock.withLock {
                    write(read().map { if (it.state == PurchaseRecord.State.REJECTED) it.copy(state = PurchaseRecord.State.OPEN, failedRounds = 0, lastErrorCode = null) else it })
                }
            } catch (error: PurchaseException.Storage) {
                diagnose("The rejected purchase records could not be reset", error)
            }
        }

        /** Drops purchases that never got a result, a week past their session's expiry, and confirmed ones after 90 days. */
        suspend fun prune(now: Long) {
            try {
                lock.withLock {
                    val all = read()
                    val kept = all.filter { record ->
                        when (record.state) {
                            PurchaseRecord.State.COMPLETED -> record.updatedAtMillis > now - COMPLETED_RETENTION_MILLIS
                            PurchaseRecord.State.REJECTED -> true
                            else -> record.expiresAtMillis > now - UNFINISHED_RETENTION_MILLIS
                        }
                    }
                    if (kept.size != all.size) write(kept)
                }
            } catch (error: PurchaseException.Storage) {
                diagnose("The purchase records could not be pruned", error)
            }
        }

        private suspend fun read(): List<PurchaseRecord> = withContext(environment.io) {
            try {
                store.load()
            } catch (error: Exception) {
                throw PurchaseException.Storage("The purchase records could not be read", error)
            }
        }

        private suspend fun write(records: List<PurchaseRecord>) = withContext(environment.io) {
            try {
                store.save(records)
            } catch (error: Exception) {
                throw PurchaseException.Storage("The purchase records could not be written", error)
            }
        }
    }

    // -- small things ----------------------------------------------------------------------------------------------------

    /** The purchase flow in progress. Only one runs at a time, which is what lets a result without an account id (a closed screen) be matched. */
    private class Flight(val host: WeakReference<Activity>?) {
        val outcome = CompletableDeferred<PurchaseOutcome>()

        @Volatile var session: PurchaseSession? = null

        @Volatile var accountId: String? = null

        /** True from just before Google's screen is launched. */
        @Volatile var launched: Boolean = false
    }

    private fun publish(event: PurchaseEvent): PurchaseEvent {
        mutableEvents.tryEmit(event)
        return event
    }

    private fun diagnose(message: String, error: Throwable?) {
        configuration.diagnostics?.invoke(message, error)
    }

    public companion object {
        /**
         * Builds a client over Google Play Billing, a Custom Tab for hosted checkouts and a `SharedPreferences` record
         * store. Create it once, in `Application.onCreate`, then call [start].
         *
         * @param backend your backend, usually an [dev.indiasubscriptions.backend.HttpPurchaseBackend].
         * @param enablePrepaidPlans also enable pending purchases for prepaid plans.
         */
        public fun create(
            context: Context,
            backend: PurchaseBackend,
            recordStore: PurchaseRecordStore = SharedPreferencesPurchaseRecordStore(context),
            opener: HostedPageOpener = CustomTabsPageOpener(context.applicationContext),
            configuration: Configuration = Configuration(),
            enablePrepaidPlans: Boolean = false,
        ): PurchaseClient = PurchaseClient(
            backend,
            BillingGatewayFactory { userChoice -> PlayBillingGateway(context, userChoice, enablePrepaidPlans) },
            recordStore,
            opener,
            configuration,
        )

        internal const val MAX_ACCOUNT_ID_LENGTH = 64
        internal const val RETURN_SESSION_PARAMETER = "session"
        internal const val ACKNOWLEDGEMENT_WINDOW_MILLIS = 3L * 24 * 3600 * 1000
        internal const val UNFINISHED_RETENTION_MILLIS = 7L * 24 * 3600 * 1000
        internal const val COMPLETED_RETENTION_MILLIS = 90L * 24 * 3600 * 1000

        internal fun parse(link: String): URI? = try {
            URI(link).takeIf { it.scheme != null }
        } catch (_: Exception) {
            null
        }

        /** Whether a link points to a return URL: same scheme, host, port and path, whatever the query. */
        internal fun sameDestination(link: URI, returnUrl: String): Boolean {
            val expected = parse(returnUrl) ?: return false
            return link.scheme.equals(expected.scheme, ignoreCase = true) &&
                link.host.equals(expected.host, ignoreCase = true) &&
                link.port == expected.port &&
                (link.path ?: "").trimEnd('/') == (expected.path ?: "").trimEnd('/')
        }

        /** The query parameter of a link, percent-decoded; null when the link is not a URI or has no such parameter. */
        internal fun queryParameter(link: String, name: String): String? {
            val query = parse(link)?.rawQuery ?: return null
            for (pair in query.split('&')) {
                val separator = pair.indexOf('=')
                val key = if (separator < 0) pair else pair.substring(0, separator)
                if (URLDecoder.decode(key, "UTF-8") != name) continue
                return if (separator < 0) "" else URLDecoder.decode(pair.substring(separator + 1), "UTF-8")
            }
            return null
        }

        /**
         * Picks the way to buy from what Google Play returned: the entry for the base plan and offer the instruction
         * names. For a one-time product the offer id alone decides (no offer id: the plain purchase option).
         */
        internal fun selectOffer(product: StoreProduct, checkout: CheckoutInstruction.GooglePlayBilling, allowBasePlanFallback: Boolean): StoreOffer {
            val offers = product.offers
            val inPlan = if (checkout.basePlanId != null) offers.filter { it.basePlanId == checkout.basePlanId } else offers
            inPlan.firstOrNull { it.offerId == checkout.offerId }?.let { return it }
            if (checkout.offerId != null && allowBasePlanFallback) inPlan.firstOrNull { it.offerId == null }?.let { return it }
            // A one-time product with no listed offers is bought without an offer token.
            if (product.kind == ProductKind.OneTime && offers.isEmpty() && checkout.offerId == null) return StoreOffer(null, null, null)
            throw PurchaseException.OfferNotAvailable(checkout.productId, checkout.basePlanId, checkout.offerId)
        }
    }
}
