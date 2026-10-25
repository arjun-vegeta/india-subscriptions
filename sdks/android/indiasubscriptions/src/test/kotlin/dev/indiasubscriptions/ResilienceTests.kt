@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.indiasubscriptions

import dev.indiasubscriptions.backend.ServerErrorCode
import dev.indiasubscriptions.billing.BillingCode
import dev.indiasubscriptions.billing.BillingFailureReason
import dev.indiasubscriptions.billing.BillingResult
import dev.indiasubscriptions.models.ProductKind
import dev.indiasubscriptions.storage.PurchaseRecord
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.currentTime
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** A backend that is down, a refusal that will not change, a lost billing connection, and a process that died. */
class ResilienceTests {

    private fun launchAndPay(gateway: FakeBillingGateway) {
        gateway.onLaunch = {
            // Google holds the purchase from now on, and delivers it.
            gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase())
            gateway.deliverPurchase(devicePurchase())
            BillingResult.ok()
        }
    }

    // -- the backend is down -----------------------------------------------------------------------------------------------

    @Test
    fun `a backend that is down is retried in the call, then in the background, until it answers`() = runTest {
        val h = Harness(this, script = ::launchAndPay)
        var down = true
        h.backend.onComplete = { id, _ ->
            if (down) throw transportError()
            Sessions.google(id = id, status = "completed")
        }

        val outcome = assertIs<PurchaseOutcome.AwaitingBackend>(h.buy())
        assertEquals(PurchaseFailure.Reason.BACKEND_UNREACHABLE, outcome.failure.reason)
        // Three attempts in the call (maxCompletionAttempts), with the delay doubling: 1 s, then 2 s.
        assertEquals(3, h.backend.completes.size)
        assertEquals(PurchaseRecord.State.OPEN, h.records().single().state, "not confirmed: still to be sent")

        // The backend comes back; the next background retry (30 s after the failure) delivers it.
        down = false
        advanceTimeBy(60_000)
        advanceUntilIdle()

        val event = assertIs<PurchaseEvent.Completed>(h.events.single())
        assertEquals(PURCHASE_TOKEN, event.purchaseToken)
        assertEquals(PurchaseRecord.State.COMPLETED, h.records().single().state)
        val sent = h.backend.completes.size
        advanceTimeBy(3_600_000)
        assertEquals(sent, h.backend.completes.size, "nothing is sent again once it is confirmed")
    }

    @Test
    fun `an unreachable backend is retried with no limit, and each retry waits longer`() = runTest {
        val h = Harness(this, configuration = PurchaseClient.Configuration(maxCompletionAttempts = 1, maxServerFailures = 2), script = ::launchAndPay)
        h.backend.onComplete = { _, _ -> throw transportError() }
        assertIs<PurchaseOutcome.AwaitingBackend>(h.buy())

        val times = mutableListOf<Long>()
        h.backend.onComplete = { _, _ ->
            times += currentTime
            throw transportError()
        }
        advanceTimeBy(24 * 3_600_000L)
        assertTrue(times.size > 10, "keeps trying for a day: ${times.size}")
        // The gaps grow up to the cap of 15 minutes.
        val gaps = times.zipWithNext { a, b -> b - a }
        assertTrue(gaps.first() < gaps.last())
        assertTrue(gaps.max() <= 900_000)
        assertEquals(PurchaseRecord.State.OPEN, h.records().single().state, "transport errors never count towards giving up")
    }

    @Test
    fun `background retrying stops after three days, when Google would have refunded the purchase`() = runTest {
        // The purchase is delivered once but Google no longer lists it, so nothing can settle it.
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = { gateway.deliverPurchase(devicePurchase()); BillingResult.ok() }
        })
        h.backend.onComplete = { _, _ -> throw transportError() }
        assertIs<PurchaseOutcome.AwaitingBackend>(h.buy())
        val start = currentTime

        advanceUntilIdle() // would never return if the loop did not end

        val elapsed = currentTime - start
        assertTrue(elapsed >= 3 * 24 * 3_600_000L, "kept trying for the whole window: $elapsed")
        assertTrue(elapsed < 4 * 24 * 3_600_000L, "and then stopped: $elapsed")
    }

    @Test
    fun `an expired user token is waited for, not given up on`() = runTest {
        val h = Harness(this, script = ::launchAndPay)
        h.backend.onComplete = { _, _ -> throw serverError(401, ServerErrorCode.Unauthorized) }
        val outcome = assertIs<PurchaseOutcome.AwaitingBackend>(h.buy())
        assertEquals(PurchaseFailure.Reason.BACKEND_UNREACHABLE, outcome.failure.reason)
        assertEquals(ServerErrorCode.Unauthorized, outcome.failure.code)
    }

    @Test
    fun `a refusal that will not change is not retried and not sent again until the app says so`() = runTest {
        val h = Harness(this, script = ::launchAndPay)
        h.backend.onComplete = { _, _ -> throw serverError(400, ServerErrorCode.Validation, "result must carry purchaseToken") }

        val outcome = assertIs<PurchaseOutcome.Rejected>(h.buy())
        assertEquals(PurchaseFailure.Reason.BACKEND_REFUSED, outcome.failure.reason)
        assertEquals(ServerErrorCode.Validation, outcome.failure.code)
        assertEquals(1, h.backend.completes.size, "one call, no retry")
        assertEquals(PurchaseRecord.State.REJECTED, h.records().single().state)

        // Google keeps reporting the purchase as owned; a resume and a day of waiting send nothing.
        h.client.processPendingPurchases()
        advanceTimeBy(24 * 3_600_000L)
        assertEquals(1, h.backend.completes.size)

        // The merchant fixed the cause: the app retries on purpose.
        h.backend.onComplete = { id, _ -> Sessions.google(id = id, status = "completed") }
        val events = h.client.retryRejectedPurchases()
        assertIs<PurchaseEvent.Completed>(events.single())
        assertEquals(2, h.backend.completes.size)
    }

    @Test
    fun `every code that will never change is refused at once`() = runTest {
        val never = listOf(
            ServerErrorCode.Validation, ServerErrorCode.SignatureInvalid, ServerErrorCode.NotFound, ServerErrorCode.Conflict,
            ServerErrorCode.Unsupported, ServerErrorCode.NoRoute,
        )
        for (code in never) {
            val h = Harness(this, script = ::launchAndPay)
            h.backend.onComplete = { _, _ -> throw serverError(422, code) }
            val outcome = assertIs<PurchaseOutcome.Rejected>(h.buy(), code.value)
            assertEquals(PurchaseFailure.Reason.BACKEND_REFUSED, outcome.failure.reason)
            assertEquals(1, h.backend.completes.size, code.value)
        }
    }

    @Test
    fun `a failure that may or may not last is retried for a limited number of rounds and then given up`() = runTest {
        val h = Harness(this, configuration = PurchaseClient.Configuration(maxCompletionAttempts = 2, maxServerFailures = 3), script = ::launchAndPay)
        h.backend.onComplete = { _, _ -> throw serverError(500, ServerErrorCode.InternalError) }

        val first = assertIs<PurchaseOutcome.AwaitingBackend>(h.buy())
        assertEquals(PurchaseFailure.Reason.BACKEND_FAILING, first.failure.reason)
        assertEquals(2, h.backend.completes.size, "two attempts in the round")

        advanceTimeBy(10 * 3_600_000L) // the background retries: two more rounds, then it stops
        advanceUntilIdle()

        val record = h.records().single()
        assertEquals(PurchaseRecord.State.REJECTED, record.state)
        assertEquals(3, record.failedRounds)
        val rejected = assertIs<PurchaseEvent.Rejected>(h.events.last())
        assertEquals(PurchaseFailure.Reason.GAVE_UP, rejected.failure.reason)
        val sent = h.backend.completes.size
        advanceTimeBy(24 * 3_600_000L)
        assertEquals(sent, h.backend.completes.size, "given up means given up")
    }

    @Test
    fun `a server that answers with a status the SDK does not know follows its own retryable flag`() = runTest {
        val h = Harness(this, script = ::launchAndPay)
        h.backend.onComplete = { _, _ -> throw serverError(418, ServerErrorCode("TEAPOT"), retryable = false) }
        assertIs<PurchaseOutcome.Rejected>(h.buy())
    }

    @Test
    fun `a session that is not settled yet is awaited, and one the backend says is not paid is rejected`() = runTest {
        val unsettled = Harness(this, script = ::launchAndPay)
        unsettled.backend.onComplete = { id, _ -> Sessions.google(id = id, status = "awaiting_payment") }
        val awaiting = assertIs<PurchaseOutcome.AwaitingBackend>(unsettled.buy())
        assertEquals(PurchaseFailure.Reason.NOT_SETTLED, awaiting.failure.reason)

        val unpaid = Harness(this, script = ::launchAndPay)
        unpaid.backend.onComplete = { id, _ -> Sessions.google(id = id, status = "failed") }
        val rejected = assertIs<PurchaseOutcome.Rejected>(unpaid.buy())
        assertEquals(PurchaseFailure.Reason.NOT_PAID, rejected.failure.reason)
        assertEquals(PurchaseRecord.State.REJECTED, unpaid.records().single().state)
    }

    // -- the process died -----------------------------------------------------------------------------------------------------

    @Test
    fun `a purchase that completes after the process died finds its session through the persisted account id`() = runTest {
        val h = Harness(this) // Google's screen opens, then the process is killed before any result
        val waiting = async { h.buy() }
        advanceUntilIdle()
        assertEquals(PurchaseRecord.State.OPEN, h.records().single().state)
        waiting.cancel()
        h.client.stop()

        // A new process: no in-memory state. The customer did pay, so Google reports the purchase.
        val (restarted, factory) = h.restart { gateway ->
            gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase())
        }
        restarted.start()
        advanceUntilIdle()

        assertEquals(SESSION_ID, h.backend.completes.single().first)
        assertEquals(PURCHASE_TOKEN, h.backend.completes.single().second.result["purchaseToken"])
        val event = assertIs<PurchaseEvent.Completed>(h.events.single())
        assertEquals(SESSION_ID, event.session.id)
        assertEquals(PurchaseRecord.State.COMPLETED, h.records().single().state)
        assertEquals(1, factory.created.size)
    }

    @Test
    fun `a purchase interrupted while the backend was down is sent at the next launch`() = runTest {
        val h = Harness(this, script = ::launchAndPay)
        h.backend.onComplete = { _, _ -> throw transportError() }
        assertIs<PurchaseOutcome.AwaitingBackend>(h.buy())
        h.client.stop()

        h.backend.onComplete = { id, _ -> Sessions.google(id = id, status = "completed") }
        val (restarted, _) = h.restart { it.owned[ProductKind.Subscription] = mutableListOf(devicePurchase()) }
        val events = restarted.processPendingPurchases()

        assertIs<PurchaseEvent.Completed>(events.single())
    }

    @Test
    fun `old records are dropped but confirmed ones are remembered so a renewal is not sent again`() = runTest {
        val old = PurchaseRecord(
            sessionId = "ps_stale", product = "p", kind = PurchaseRecord.Kind.GOOGLE_PLAY, accountId = "acct-stale",
            createdAtMillis = NOW - 20 * 86_400_000L, expiresAtMillis = NOW - 10 * 86_400_000L,
        )
        val done = PurchaseRecord(
            sessionId = SESSION_ID, product = "pro_monthly", kind = PurchaseRecord.Kind.GOOGLE_PLAY, accountId = ACCOUNT_ID,
            state = PurchaseRecord.State.COMPLETED, completedPurchaseTokens = listOf(PURCHASE_TOKEN),
            createdAtMillis = NOW - 86_400_000L, expiresAtMillis = NOW, updatedAtMillis = NOW - 86_400_000L,
        )
        val h = Harness(this, script = { it.owned[ProductKind.Subscription] = mutableListOf(devicePurchase()) })
        h.store.save(listOf(old, done))
        h.client.processPendingPurchases()
        assertEquals(listOf(SESSION_ID), h.records().map { it.sessionId })
        assertTrue(h.backend.completes.isEmpty())
    }

    // -- the billing connection ------------------------------------------------------------------------------------------------

    @Test
    fun `a billing service that is unavailable is retried with a backoff and the purchase then goes through`() = runTest {
        val h = Harness(this, script = { gateway ->
            launchAndPay(gateway)
            gateway.connectScript += BillingResult(BillingCode.SERVICE_UNAVAILABLE, "busy")
            gateway.connectScript += BillingResult(BillingCode.SERVICE_DISCONNECTED, "gone")
        })
        val outcome = h.buy()
        assertIs<PurchaseOutcome.Completed>(outcome)
        assertEquals(3, h.factory.latest.connects)
    }

    @Test
    fun `a billing service that stays unavailable ends as a failed outcome after the attempts`() = runTest {
        val h = Harness(this, configuration = PurchaseClient.Configuration(maxBillingAttempts = 3), script = { gateway ->
            repeat(10) { gateway.connectScript += BillingResult(BillingCode.SERVICE_UNAVAILABLE, "busy") }
        })
        val outcome = assertIs<PurchaseOutcome.Failed>(h.buy())
        assertEquals(BillingFailureReason.SERVICE_UNAVAILABLE, outcome.failure.reason)
        assertTrue(outcome.failure.isTransient)
        // At least the three attempts of the purchase (the launch pass `start()` runs connects on its own account too).
        assertTrue(h.factory.latest.connects >= 3)
        assertTrue(h.records().isEmpty())
    }

    @Test
    fun `billing that is unavailable for the user is not retried`() = runTest {
        val h = Harness(this, script = { it.connectScript += BillingResult(BillingCode.BILLING_UNAVAILABLE, "Play Store out of date") })
        val outcome = assertIs<PurchaseOutcome.Failed>(h.buy())
        assertEquals(BillingFailureReason.BILLING_UNAVAILABLE, outcome.failure.reason)
        assertEquals(1, h.factory.latest.connects)
        assertTrue(h.factory.latest.launches.isEmpty())
    }

    @Test
    fun `a connection lost while a request is made is restored and the request repeated`() = runTest {
        val h = Harness(this, script = { gateway ->
            launchAndPay(gateway)
            gateway.queryProductScript += BillingResult(BillingCode.SERVICE_DISCONNECTED, "lost")
        })
        assertIs<PurchaseOutcome.Completed>(h.buy())
        assertEquals(2, h.factory.latest.productQueries)
        assertEquals(2, h.factory.latest.connects, "reconnected once")
    }

    @Test
    fun `a lost connection is restored in the background and what arrived meanwhile is processed`() = runTest {
        val h = Harness(this)
        h.client.start()
        advanceUntilIdle()
        val gateway = h.factory.latest
        gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase())
        h.store.save(
            listOf(
                PurchaseRecord(
                    sessionId = SESSION_ID, product = "pro_monthly", kind = PurchaseRecord.Kind.GOOGLE_PLAY, accountId = ACCOUNT_ID,
                    googleProductId = GOOGLE_PRODUCT, createdAtMillis = NOW, expiresAtMillis = NOW + 86_400_000,
                ),
            ),
        )

        gateway.disconnect() // `onBillingServiceDisconnected`
        advanceUntilIdle()

        assertTrue(gateway.connects >= 2, "reconnected")
        assertIs<PurchaseEvent.Completed>(h.events.single())
    }

    @Test
    fun `a request Google keeps failing with a transient error is reported as a failed outcome, not retried for ever`() = runTest {
        val h = Harness(this, configuration = PurchaseClient.Configuration(maxBillingAttempts = 3), script = { gateway ->
            repeat(10) { gateway.queryProductScript += BillingResult(BillingCode.ERROR, "internal") }
        })
        val outcome = assertIs<PurchaseOutcome.Failed>(h.buy())
        assertEquals(BillingFailureReason.ERROR, outcome.failure.reason)
        assertEquals(3, h.factory.latest.productQueries)
    }

    @Test
    fun `a pass that cannot reach Google Play does not stop the backend work`() = runTest {
        val h = Harness(this, script = { it.queryPurchasesScript += BillingResult(BillingCode.BILLING_UNAVAILABLE, "no") })
        val events = h.client.processPendingPurchases()
        assertTrue(events.isEmpty())
        assertTrue(h.diagnostics.isNotEmpty())
    }
}
