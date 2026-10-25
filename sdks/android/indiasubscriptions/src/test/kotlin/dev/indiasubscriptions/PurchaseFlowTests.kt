@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.indiasubscriptions

import dev.indiasubscriptions.backend.ServerErrorCode
import dev.indiasubscriptions.billing.BillingCode
import dev.indiasubscriptions.billing.BillingFailureReason
import dev.indiasubscriptions.billing.BillingResult
import dev.indiasubscriptions.billing.DevicePurchaseState
import dev.indiasubscriptions.models.CompletePurchaseInput
import dev.indiasubscriptions.models.ProductKind
import dev.indiasubscriptions.storage.PurchaseRecord
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** The Google Play flow: success, cancellation, billing errors, pending purchases, duplicates. */
class PurchaseFlowTests {

    @Test
    fun `a purchase goes to the backend with its session and the SDK only reports what the server confirmed`() = runTest {
        var recordAtLaunch: List<PurchaseRecord> = emptyList()
        lateinit var h: Harness
        h = Harness(this, script = { gateway ->
            gateway.onLaunch = {
                recordAtLaunch = h.records() // read while Google's screen would be open
                gateway.deliverPurchase(devicePurchase())
                BillingResult.ok()
            }
        })

        val outcome = h.buy()

        assertIs<PurchaseOutcome.Completed>(outcome)
        // The session was started for platform android with the caller's customer and return link.
        val start = h.backend.starts.single()
        assertEquals("android", start.platform.value)
        assertEquals("pro_monthly", start.product)
        assertEquals("Karnataka", start.customer.state)
        assertEquals(RETURN_LINK, start.returnUrl)
        // The billing flow got the offer token of the base plan and the account id of the instruction.
        val gateway = h.factory.latest
        assertEquals(false, gateway.userChoice)
        val request = gateway.launches.single()
        assertEquals("token-monthly-base", request.offerToken)
        assertEquals(ACCOUNT_ID, request.obfuscatedAccountId)
        // The record was on disk before the screen opened.
        val written = recordAtLaunch.single()
        assertEquals(SESSION_ID, written.sessionId)
        assertEquals(ACCOUNT_ID, written.accountId)
        assertEquals(PurchaseRecord.State.OPEN, written.state)
        // `{ purchaseToken, productId }` with provider google_play, once.
        val (sessionId, complete) = h.backend.completes.single()
        assertEquals(SESSION_ID, sessionId)
        assertEquals(CompletePurchaseInput.googlePlay(PURCHASE_TOKEN, GOOGLE_PRODUCT), complete)
        assertEquals("google_play", complete.provider.value)
        assertEquals(mapOf("purchaseToken" to PURCHASE_TOKEN, "productId" to GOOGLE_PRODUCT), complete.result)
        val finished = h.records().single()
        assertEquals(PurchaseRecord.State.COMPLETED, finished.state)
        assertEquals(listOf(PURCHASE_TOKEN), finished.completedPurchaseTokens)
        // A purchase the call was waiting for is its return value, not an event.
        assertTrue(h.events.isEmpty())
    }

    @Test
    fun `the offer is chosen from the base plan and offer id of the instruction`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = { gateway.deliverPurchase(devicePurchase()); BillingResult.ok() }
        })
        h.backend.onStart = { Sessions.google(basePlanId = "monthly", offerId = "intro-7d") }
        h.buy()
        assertEquals("token-monthly-intro", h.factory.latest.launches.single().offerToken)
    }

    @Test
    fun `a one-time product is bought with its purchase option`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.products[GOOGLE_PRODUCT] = FakeBillingGateway.oneTimeProduct()
            gateway.onLaunch = { gateway.deliverPurchase(devicePurchase()); BillingResult.ok() }
        })
        h.backend.onStart = { Sessions.google(productKind = "one_time", basePlanId = null) }
        assertIs<PurchaseOutcome.Completed>(h.buy())
        assertEquals("token-once", h.factory.latest.launches.single().offerToken)
    }

    @Test
    fun `an offer the customer is not eligible for fails, or falls back to the base plan when allowed`() = runTest {
        val strict = Harness(this, script = { it.onLaunch = { _ -> BillingResult.ok() } })
        strict.backend.onStart = { Sessions.google(basePlanId = "monthly", offerId = "gone") }
        assertFailsWith<PurchaseException.OfferNotAvailable> { strict.buy() }
        assertTrue(strict.records().isEmpty(), "nothing is written for a flow that cannot start")
        assertTrue(strict.factory.latest.launches.isEmpty())

        val lenient = Harness(this, configuration = PurchaseClient.Configuration(allowBasePlanFallback = true), script = { gateway ->
            gateway.onLaunch = { gateway.deliverPurchase(devicePurchase()); BillingResult.ok() }
        })
        lenient.backend.onStart = { Sessions.google(basePlanId = "monthly", offerId = "gone") }
        assertIs<PurchaseOutcome.Completed>(lenient.buy())
        assertEquals("token-monthly-base", lenient.factory.latest.launches.single().offerToken)
    }

    @Test
    fun `a closed purchase screen is a cancellation and leaves nothing behind`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = { gateway.deliverResult(BillingCode.USER_CANCELED); BillingResult.ok() }
        })
        val outcome = h.buy()
        assertIs<PurchaseOutcome.Cancelled>(outcome)
        assertTrue(h.backend.completes.isEmpty())
        assertTrue(h.records().isEmpty())
        // The next purchase may start.
        h.factory.latest.onLaunch = { h.factory.latest.deliverPurchase(devicePurchase()); BillingResult.ok() }
        assertIs<PurchaseOutcome.Completed>(h.buy())
    }

    @Test
    fun `every response code is mapped to a reason an app can act on`() {
        val expected = mapOf(
            BillingCode.USER_CANCELED to BillingFailureReason.USER_CANCELED,
            BillingCode.SERVICE_UNAVAILABLE to BillingFailureReason.SERVICE_UNAVAILABLE,
            BillingCode.SERVICE_TIMEOUT to BillingFailureReason.SERVICE_UNAVAILABLE,
            BillingCode.BILLING_UNAVAILABLE to BillingFailureReason.BILLING_UNAVAILABLE,
            BillingCode.ITEM_UNAVAILABLE to BillingFailureReason.ITEM_UNAVAILABLE,
            BillingCode.DEVELOPER_ERROR to BillingFailureReason.DEVELOPER_ERROR,
            BillingCode.ERROR to BillingFailureReason.ERROR,
            BillingCode.ITEM_ALREADY_OWNED to BillingFailureReason.ITEM_ALREADY_OWNED,
            BillingCode.ITEM_NOT_OWNED to BillingFailureReason.ITEM_NOT_OWNED,
            BillingCode.NETWORK_ERROR to BillingFailureReason.NETWORK_ERROR,
            BillingCode.SERVICE_DISCONNECTED to BillingFailureReason.SERVICE_DISCONNECTED,
            BillingCode.FEATURE_NOT_SUPPORTED to BillingFailureReason.FEATURE_NOT_SUPPORTED,
            99 to BillingFailureReason.UNKNOWN,
        )
        for ((code, reason) in expected) {
            assertEquals(reason, dev.indiasubscriptions.billing.BillingFailure.from(BillingResult(code)).reason, "code $code")
        }
        // Transient ones are the ones Google says to retry.
        assertTrue(dev.indiasubscriptions.billing.BillingFailure.from(BillingResult(BillingCode.SERVICE_UNAVAILABLE)).isTransient)
        assertTrue(!dev.indiasubscriptions.billing.BillingFailure.from(BillingResult(BillingCode.BILLING_UNAVAILABLE)).isTransient)
    }

    @Test
    fun `a billing error when the screen is launched is a failed outcome with nothing charged and no record`() = runTest {
        val codes = listOf(
            BillingCode.BILLING_UNAVAILABLE, BillingCode.ITEM_UNAVAILABLE, BillingCode.DEVELOPER_ERROR,
            BillingCode.FEATURE_NOT_SUPPORTED, BillingCode.ERROR, BillingCode.NETWORK_ERROR,
        )
        for (code in codes) {
            val h = Harness(this, script = { it.onLaunch = { _ -> BillingResult(code, "scripted") } })
            val outcome = assertIs<PurchaseOutcome.Failed>(h.buy(), "code $code")
            assertEquals(code, outcome.failure.responseCode)
            assertEquals(dev.indiasubscriptions.billing.BillingFailure.reasonFor(code), outcome.failure.reason)
            assertTrue(h.records().isEmpty())
            assertTrue(h.backend.completes.isEmpty())
        }
    }

    @Test
    fun `a failure Google reports through the listener is reported as well, with its sub-response code`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = {
                gateway.send(
                    dev.indiasubscriptions.billing.BillingUpdate.PurchasesUpdated(
                        BillingResult(BillingCode.BILLING_UNAVAILABLE, "declined", subCode = 1), emptyList(),
                    ),
                )
                BillingResult.ok()
            }
        })
        val failed = assertIs<PurchaseOutcome.Failed>(h.buy())
        assertEquals(1, failed.failure.subResponseCode)
        assertTrue(h.records().isEmpty())
    }

    @Test
    fun `item already owned refreshes the owned purchases and completes the one the SDK knows`() = runTest {
        // An earlier purchase of this customer was interrupted: its record is on disk and Google still holds it.
        val earlier = PurchaseRecord(
            sessionId = "ps_old", product = "pro_monthly", kind = PurchaseRecord.Kind.GOOGLE_PLAY, accountId = "acct-old",
            googleProductId = GOOGLE_PRODUCT, createdAtMillis = NOW, expiresAtMillis = NOW + 86_400_000,
        )
        val h = Harness(this, store = dev.indiasubscriptions.storage.InMemoryPurchaseRecordStore(listOf(earlier)), script = { gateway ->
            gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase(token = "old-token", accountId = "acct-old"))
            gateway.onLaunch = { BillingResult(BillingCode.ITEM_ALREADY_OWNED, "owned") }
        })
        h.backend.onComplete = { id, _ -> Sessions.google(id = id, status = "completed") }

        val outcome = assertIs<PurchaseOutcome.Failed>(h.buy())
        assertEquals(BillingFailureReason.ITEM_ALREADY_OWNED, outcome.failure.reason)
        advanceUntilIdle()

        val (sessionId, _) = h.backend.completes.single()
        assertEquals("ps_old", sessionId)
        val completed = assertIs<PurchaseEvent.Completed>(h.events.single())
        assertEquals("old-token", completed.purchaseToken)
    }

    @Test
    fun `a pending purchase stays open and completes when it is approved later`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = {
                gateway.deliverPurchase(devicePurchase(state = DevicePurchaseState.PENDING))
                BillingResult.ok()
            }
        })
        val outcome = h.buy()
        assertIs<PurchaseOutcome.Pending>(outcome)
        assertTrue(h.backend.completes.isEmpty(), "a pending purchase is not sent: nothing is paid yet")
        assertEquals(PurchaseRecord.State.PENDING, h.records().single().state)

        // Days later Google delivers it as purchased, on the same client.
        h.factory.latest.deliverPurchase(devicePurchase(state = DevicePurchaseState.PURCHASED))
        advanceUntilIdle()

        val event = assertIs<PurchaseEvent.Completed>(h.events.single())
        assertEquals(PURCHASE_TOKEN, event.purchaseToken)
        assertEquals(1, h.backend.completes.size)
        assertEquals(PurchaseRecord.State.COMPLETED, h.records().single().state)
    }

    @Test
    fun `a pending purchase approved after the process died is found through the persisted account id`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = { gateway.deliverPurchase(devicePurchase(state = DevicePurchaseState.PENDING)); BillingResult.ok() }
        })
        assertIs<PurchaseOutcome.Pending>(h.buy())

        // New process: nothing in memory, the same record store; Google now reports the purchase as purchased.
        val (restarted, factory) = h.restart { gateway ->
            gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase(state = DevicePurchaseState.PURCHASED))
        }
        val events = restarted.processPendingPurchases()

        val completed = assertIs<PurchaseEvent.Completed>(events.single())
        assertEquals(SESSION_ID, completed.session.id)
        assertEquals(SESSION_ID, h.backend.completes.single().first)
        assertEquals(1, factory.created.size)
    }

    @Test
    fun `a pending purchase is announced once, not on every resume`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase(state = DevicePurchaseState.PENDING))
        })
        h.store.save(listOf(openRecord()))
        h.client.processPendingPurchases()
        h.client.processPendingPurchases()
        assertEquals(1, h.events.filterIsInstance<PurchaseEvent.Pending>().size)
        assertTrue(h.backend.completes.isEmpty())
    }

    @Test
    fun `the same purchase delivered twice is sent once`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase())
            gateway.onLaunch = {
                gateway.deliverPurchase(devicePurchase())
                gateway.deliverPurchase(devicePurchase()) // delivered again
                BillingResult.ok()
            }
        })
        h.backend.onComplete = { id, _ -> Sessions.google(id = id, status = "completed") }
        assertIs<PurchaseOutcome.Completed>(h.buy())
        advanceUntilIdle()
        // And again by a query, as a resume would.
        h.client.processPendingPurchases()
        h.client.processPendingPurchases()
        assertEquals(1, h.backend.completes.size)
    }

    @Test
    fun `a purchase being sent is not sent a second time by a concurrent pass`() = runTest {
        val h = Harness(this, script = { gateway -> gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase()) })
        h.store.save(listOf(openRecord()))
        h.backend.onComplete = { id, _ ->
            kotlinx.coroutines.delay(5_000) // a slow backend
            Sessions.google(id = id, status = "completed")
        }
        val first = async { h.client.processPendingPurchases() }
        val second = async { h.client.processPendingPurchases() }
        advanceUntilIdle()
        assertEquals(1, h.backend.completes.size)
        assertEquals(1, first.await().size + second.await().size)
    }

    @Test
    fun `a purchase without a record is reported once and left to the backend, unless the server already acknowledged it`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.owned[ProductKind.Subscription] = mutableListOf(
                devicePurchase(token = "other-device", accountId = null),
                devicePurchase(token = "unknown-account", accountId = "never-seen"),
                devicePurchase(token = "acknowledged", accountId = null, acknowledged = true),
            )
        })
        val first = h.client.processPendingPurchases()
        val second = h.client.processPendingPurchases()

        assertEquals(setOf("other-device", "unknown-account"), first.map { (it as PurchaseEvent.UnmatchedPurchase).purchaseToken }.toSet())
        assertTrue(second.isEmpty(), "reported once per launch")
        assertTrue(h.backend.completes.isEmpty())
    }

    @Test
    fun `a session that is already completed needs no purchase and one that is failed or expired is refused`() = runTest {
        val h = Harness(this)
        h.backend.onStart = { Sessions.google(status = "completed") }
        assertIs<PurchaseOutcome.Completed>(h.buy())
        assertTrue(h.factory.created.none { it.launches.isNotEmpty() })

        for (status in listOf("failed", "expired")) {
            h.backend.onStart = { Sessions.google(status = status) }
            val error = assertFailsWith<PurchaseException.SessionNotOpen> { h.buy() }
            assertEquals(status, error.status.value)
        }
    }

    @Test
    fun `a second purchase while one is running is refused`() = runTest {
        val h = Harness(this) // the fake screen never answers
        val first = async { h.buy() }
        advanceUntilIdle()
        assertFailsWith<PurchaseException.PurchaseInProgress> { h.buy() }
        first.cancel()
    }

    @Test
    fun `an activity that is gone is reported before anything is written`() = runTest {
        val h = Harness(this)
        assertFailsWith<PurchaseException.ActivityGone> {
            h.client.purchase(java.lang.ref.WeakReference(null), "pro_monthly", "cust_1", dev.indiasubscriptions.models.Customer(), null, null)
        }
        assertTrue(h.records().isEmpty())
        assertTrue(h.factory.latest.launches.isEmpty())
    }

    @Test
    fun `a product Google Play does not return is a configuration error, not a billing outcome`() = runTest {
        val h = Harness(this, script = { it.products.clear() })
        val error = assertFailsWith<PurchaseException.ProductNotFound> { h.buy() }
        assertEquals(GOOGLE_PRODUCT, error.productId)
        assertTrue(h.records().isEmpty())
    }

    @Test
    fun `an app that stops waiting does not lose the purchase`() = runTest {
        val h = Harness(this)
        val waiting = async { h.buy() }
        advanceUntilIdle()
        waiting.cancel() // the activity was destroyed
        advanceUntilIdle()

        h.factory.latest.deliverPurchase(devicePurchase())
        advanceUntilIdle()

        assertIs<PurchaseEvent.Completed>(h.events.single())
        assertEquals(1, h.backend.completes.size)
    }

    @Test
    fun `the backend's start error reaches the caller and nothing is launched`() = runTest {
        val h = Harness(this)
        h.backend.onStart = { throw serverError(409, ServerErrorCode.Conflict) }
        val error = assertFailsWith<dev.indiasubscriptions.backend.PurchaseBackendException.Server> { h.buy() }
        assertEquals(ServerErrorCode.Conflict, error.code)
        assertNull(h.factory.created.firstOrNull()?.launches?.firstOrNull())
    }

    @Test
    fun `restore runs the pass and returns the backend's entitlements`() = runTest {
        val h = Harness(this, script = { gateway -> gateway.owned[ProductKind.Subscription] = mutableListOf(devicePurchase(token = "t", accountId = null, acknowledged = true)) })
        val entitlements = h.client.restorePurchases("cust_1")
        assertEquals("cust_1", entitlements.customerRef)
        assertEquals(listOf("entitlements"), h.backend.calls.filter { it == "entitlements" })
        assertTrue(h.factory.latest.purchaseQueries >= 2, "subscriptions and one-time purchases were both queried")
    }

    private fun openRecord(): PurchaseRecord = PurchaseRecord(
        sessionId = SESSION_ID, product = "pro_monthly", kind = PurchaseRecord.Kind.GOOGLE_PLAY, accountId = ACCOUNT_ID,
        googleProductId = GOOGLE_PRODUCT, createdAtMillis = NOW, expiresAtMillis = NOW + 86_400_000,
    )

    @Test
    fun `advancing virtual time past the backoff does not resend a confirmed purchase`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = { gateway.deliverPurchase(devicePurchase()); BillingResult.ok() }
        })
        assertIs<PurchaseOutcome.Completed>(h.buy())
        advanceTimeBy(24 * 3600 * 1000L)
        assertEquals(1, h.backend.completes.size)
    }
}
