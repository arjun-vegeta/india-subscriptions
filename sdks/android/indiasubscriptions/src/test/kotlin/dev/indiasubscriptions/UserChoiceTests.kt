@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package dev.indiasubscriptions

import dev.indiasubscriptions.backend.ServerErrorCode
import dev.indiasubscriptions.billing.BillingResult
import dev.indiasubscriptions.billing.BillingUpdate
import dev.indiasubscriptions.storage.PurchaseRecord
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.async
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.advanceUntilIdle
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** User choice billing through the hosted page and the return link, and sessions that only have a gateway. */
class UserChoiceTests {

    private fun chooseAlternative(gateway: FakeBillingGateway) {
        gateway.onLaunch = {
            gateway.send(BillingUpdate.UserChoice(EXTERNAL_TOKEN, listOf(GOOGLE_PRODUCT)))
            BillingResult.ok()
        }
    }

    private fun userChoiceHarness(testScope: kotlinx.coroutines.test.TestScope): Harness {
        val h = Harness(testScope, script = ::chooseAlternative)
        h.backend.onStart = { Sessions.google(policy = "user_choice", userChoice = true) }
        return h
    }

    @Test
    fun `the client is built with user choice billing when the instruction says so`() = runTest {
        val h = userChoiceHarness(this)
        h.buy()
        assertTrue(h.factory.created.single().userChoice)

        val plain = Harness(this, script = { it.onLaunch = { _ -> BillingResult.ok() } })
        val waiting = async { plain.buy() } // Google's screen stays open
        advanceUntilIdle()
        assertTrue(!plain.factory.created.single().userChoice)
        waiting.cancel()
    }

    @Test
    fun `the alternative goes to the backend, then the hosted page opens, and the outcome waits for the return link`() = runTest {
        val h = userChoiceHarness(this)

        val outcome = assertIs<PurchaseOutcome.AwaitingReturn>(h.buy())

        // The token went to the alternative call, not to the complete call.
        val (sessionId, input) = h.backend.alternatives.single()
        assertEquals(SESSION_ID, sessionId)
        assertEquals(EXTERNAL_TOKEN, input.externalTransactionToken)
        assertTrue(h.backend.completes.isEmpty())
        // The gateway option's hosted page opened.
        assertEquals(listOf(HOSTED_URL), h.opener.opened)
        assertEquals(HOSTED_URL, outcome.session.hostedOption?.hostedUrl)
        // The record now waits for the return, and the token is no longer held.
        val record = h.records().single()
        assertEquals(PurchaseRecord.State.AWAITING_RETURN, record.state)
        assertNull(record.externalTransactionToken)
    }

    @Test
    fun `the return link makes the app read the session back from the backend, which decides the outcome`() = runTest {
        val h = userChoiceHarness(this)
        h.buy()
        h.backend.onGet = { id -> Sessions.google(id = id, status = "completed", subscriptionId = "sub_123") }

        val result = h.client.handleReturnLink("$RETURN_LINK?session=$SESSION_ID&status=completed")

        val completed = assertIs<ReturnLinkResult.Completed>(result)
        assertEquals("sub_123", completed.session.subscriptionId)
        assertEquals(listOf(SESSION_ID), h.backend.reads)
        assertEquals(PurchaseRecord.State.COMPLETED, h.records().single().state)
        // Nothing is read twice for a link that arrives again.
        assertEquals(ReturnLinkResult.Ignored, h.client.handleReturnLink("$RETURN_LINK?session=$SESSION_ID&status=completed"))
    }

    @Test
    fun `the status in the link is never trusted`() = runTest {
        val h = userChoiceHarness(this)
        h.buy()
        h.backend.onGet = { id -> Sessions.google(id = id, status = "awaiting_payment") }

        // The link claims success; the backend says the payment is still under way.
        val result = h.client.handleReturnLink("$RETURN_LINK?session=$SESSION_ID&status=completed")

        assertIs<ReturnLinkResult.StillPending>(result)
        assertEquals(PurchaseRecord.State.AWAITING_RETURN, h.records().single().state)
        assertTrue(h.backend.completes.isEmpty(), "the link never completes anything")
    }

    @Test
    fun `a link that names a session this app did not start reads nothing`() = runTest {
        val h = userChoiceHarness(this)
        h.buy()

        val result = h.client.handleReturnLink("$RETURN_LINK?session=ps_someone_else&status=completed")

        assertEquals(ReturnLinkResult.Ignored, result)
        assertTrue(h.backend.reads.isEmpty())
        assertEquals(PurchaseRecord.State.AWAITING_RETURN, h.records().single().state)
        // Things that are not return links at all, or that point somewhere else in the app.
        assertEquals(ReturnLinkResult.Ignored, h.client.handleReturnLink("not a uri %%"))
        assertEquals(ReturnLinkResult.Ignored, h.client.handleReturnLink("myapp://settings/profile?session=$SESSION_ID&status=completed"))
        assertEquals(ReturnLinkResult.Ignored, h.client.handleReturnLink("https://evil.example/billing/return?session=$SESSION_ID"))
        assertTrue(h.backend.reads.isEmpty())
    }

    @Test
    fun `a link without a session is matched to the only pending checkout, and to none when there are several`() = runTest {
        val h = userChoiceHarness(this)
        h.buy()
        h.backend.onGet = { id -> Sessions.google(id = id, status = "failed") }
        assertIs<ReturnLinkResult.NotPaid>(h.client.handleReturnLink(RETURN_LINK))
        assertEquals(PurchaseRecord.State.REJECTED, h.records().single().state)

        // Two pending checkouts: a link that does not say which is ambiguous.
        val two = Harness(this)
        two.store.save(listOf(hosted("ps_a"), hosted("ps_b")))
        assertEquals(ReturnLinkResult.Ignored, two.client.handleReturnLink(RETURN_LINK))
        assertTrue(two.backend.reads.isEmpty())
    }

    @Test
    fun `an expired session behind the link is reported as not paid`() = runTest {
        val h = userChoiceHarness(this)
        h.buy()
        h.backend.onGet = { id -> Sessions.google(id = id, status = "expired") }
        val result = assertIs<ReturnLinkResult.NotPaid>(h.client.handleReturnLink("$RETURN_LINK?session=$SESSION_ID"))
        assertEquals("expired", result.session.status.value)
    }

    @Test
    fun `the return link with the backend down leaves the checkout pending and it is read again later`() = runTest {
        val h = userChoiceHarness(this)
        h.buy()
        h.backend.onGet = { throw transportError() }
        val result = assertIs<ReturnLinkResult.BackendFailed>(h.client.handleReturnLink("$RETURN_LINK?session=$SESSION_ID"))
        assertEquals(PurchaseFailure.Reason.BACKEND_UNREACHABLE, result.failure.reason)
        assertEquals(PurchaseRecord.State.AWAITING_RETURN, h.records().single().state)

        // The customer closes the tab without a link; a resume reads the session.
        h.backend.onGet = { id -> Sessions.google(id = id, status = "completed") }
        val events = h.client.processPendingPurchases()
        assertIs<PurchaseEvent.Completed>(events.single())
        assertNull((events.single() as PurchaseEvent.Completed).purchaseToken)
    }

    @Test
    fun `a hosted checkout that ended unpaid is reported as rejected on resume`() = runTest {
        val h = userChoiceHarness(this)
        h.buy()
        h.backend.onGet = { id -> Sessions.google(id = id, status = "failed") }
        val events = h.client.processPendingPurchases()
        val rejected = assertIs<PurchaseEvent.Rejected>(events.single())
        assertEquals(PurchaseFailure.Reason.NOT_PAID, rejected.failure.reason)
    }

    @Test
    fun `an external transaction token the backend could not take is kept and delivered later`() = runTest {
        val h = userChoiceHarness(this)
        var down = true
        h.backend.onAlternative = { id, _ ->
            if (down) throw transportError()
            Sessions.google(id = id, status = "awaiting_payment", policy = "user_choice", userChoice = true, hostedUrl = HOSTED_URL, externalToken = EXTERNAL_TOKEN)
        }

        val outcome = assertIs<PurchaseOutcome.AwaitingBackend>(h.buy())
        assertEquals(PurchaseFailure.Reason.BACKEND_UNREACHABLE, outcome.failure.reason)
        assertEquals(3, h.backend.alternatives.size)
        val record = h.records().single()
        assertEquals(PurchaseRecord.State.TOKEN_UNSENT, record.state)
        assertEquals(EXTERNAL_TOKEN, record.externalTransactionToken)
        assertTrue(h.opener.opened.isEmpty())

        down = false
        advanceTimeBy(60_000)
        advanceUntilIdle()

        assertEquals(listOf(HOSTED_URL), h.opener.opened)
        assertIs<PurchaseEvent.HostedCheckoutOpened>(h.events.single())
        assertEquals(PurchaseRecord.State.AWAITING_RETURN, h.records().single().state)
        assertNull(h.records().single().externalTransactionToken)
    }

    @Test
    fun `a token that survived a process death is delivered at the next launch`() = runTest {
        val h = userChoiceHarness(this)
        h.backend.onAlternative = { _, _ -> throw transportError() }
        h.buy()
        h.client.stop()

        h.backend.onAlternative = { id, _ ->
            Sessions.google(id = id, status = "awaiting_payment", policy = "user_choice", userChoice = true, hostedUrl = HOSTED_URL, externalToken = EXTERNAL_TOKEN)
        }
        val (restarted, _) = h.restart()
        val events = restarted.processPendingPurchases()

        assertIs<PurchaseEvent.HostedCheckoutOpened>(events.single())
        assertEquals(EXTERNAL_TOKEN, h.backend.alternatives.last().second.externalTransactionToken)
    }

    @Test
    fun `a refusal of the token is final`() = runTest {
        val h = userChoiceHarness(this)
        h.backend.onAlternative = { _, _ -> throw serverError(400, ServerErrorCode.Validation, "customer.state is required") }
        val outcome = assertIs<PurchaseOutcome.Rejected>(h.buy())
        assertEquals(PurchaseFailure.Reason.BACKEND_REFUSED, outcome.failure.reason)
        assertEquals(1, h.backend.alternatives.size)
        assertEquals(PurchaseRecord.State.REJECTED, h.records().single().state)
        assertNull(h.records().single().externalTransactionToken)
    }

    @Test
    fun `an answer without a hosted page cannot be completed`() = runTest {
        val h = userChoiceHarness(this)
        h.backend.onAlternative = { id, _ -> Sessions.google(id = id, status = "awaiting_payment", policy = "user_choice", userChoice = true) }
        val outcome = assertIs<PurchaseOutcome.Rejected>(h.buy())
        assertEquals(PurchaseFailure.Reason.CHECKOUT_UNAVAILABLE, outcome.failure.reason)
    }

    @Test
    fun `a page that cannot be opened is reported and the checkout is still read back later`() = runTest {
        val h = userChoiceHarness(this)
        h.opener.failure = IllegalStateException("No browser can open the hosted checkout page")
        val outcome = assertIs<PurchaseOutcome.Rejected>(h.buy())
        assertEquals(PurchaseFailure.Reason.CHECKOUT_UNAVAILABLE, outcome.failure.reason)
        assertEquals(PurchaseRecord.State.AWAITING_RETURN, h.records().single().state)
    }

    @Test
    fun `when the customer picks Google Play on the choice screen the purchase is an ordinary one`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = { gateway.deliverPurchase(devicePurchase()); BillingResult.ok() }
        })
        h.backend.onStart = { Sessions.google(policy = "user_choice", userChoice = true) }
        assertIs<PurchaseOutcome.Completed>(h.buy())
        assertTrue(h.backend.alternatives.isEmpty())
        assertTrue(h.opener.opened.isEmpty())
    }

    @Test
    fun `starting again with the same reference after the choice reopens the hosted page instead of Google's screen`() = runTest {
        val h = userChoiceHarness(this)
        h.backend.onStart = {
            Sessions.google(status = "awaiting_payment", policy = "user_choice", userChoice = true, hostedUrl = HOSTED_URL, externalToken = EXTERNAL_TOKEN)
        }
        val outcome = assertIs<PurchaseOutcome.AwaitingReturn>(h.buy())
        assertEquals(HOSTED_URL, h.opener.opened.single())
        assertEquals(SESSION_ID, outcome.session.id)
        assertTrue(h.factory.created.none { it.launches.isNotEmpty() }, "Google's screen is not opened")
    }

    // -- gateways only ----------------------------------------------------------------------------------------------------------

    @Test
    fun `a session that only has a gateway goes straight to the hosted page`() = runTest {
        val h = Harness(this)
        h.backend.onStart = { Sessions.gatewayOnly() }

        val outcome = assertIs<PurchaseOutcome.AwaitingReturn>(h.buy())

        assertEquals(listOf(HOSTED_URL), h.opener.opened)
        assertTrue(h.factory.created.none { it.launches.isNotEmpty() }, "Google's screen is not opened")
        val record = h.records().single()
        assertEquals(PurchaseRecord.Kind.HOSTED, record.kind)
        assertEquals(PurchaseRecord.State.AWAITING_RETURN, record.state)
        assertEquals(SESSION_ID, outcome.session.id)

        h.backend.onGet = { id -> Sessions.gatewayOnly(id = id, status = "completed") }
        assertIs<ReturnLinkResult.Completed>(h.client.handleReturnLink("$RETURN_LINK?session=$SESSION_ID&status=completed"))
    }

    @Test
    fun `a session with no option the SDK can use is refused`() = runTest {
        val h = Harness(this)
        h.backend.onStart = { Sessions.gatewayOnly(hostedUrl = null) }
        val error = kotlin.test.assertFailsWith<PurchaseException.NoUsableOption> { h.buy() }
        assertEquals(SESSION_ID, error.sessionId)
        assertTrue(h.records().isEmpty())
    }

    @Test
    fun `the billing client is replaced when a session needs the other mode, and only one is open`() = runTest {
        val h = Harness(this, script = { gateway ->
            gateway.onLaunch = { gateway.deliverPurchase(devicePurchase()); BillingResult.ok() }
        })
        h.backend.onStart = { Sessions.google(userChoice = false) }
        h.buy()
        val first = h.factory.latest

        h.backend.onStart = { Sessions.google(id = "ps_2", accountId = "acct-2", userChoice = true, policy = "user_choice") }
        h.factory.latest.onLaunch = { first.deliverPurchase(devicePurchase(token = "t2", accountId = "acct-2")); BillingResult.ok() }
        // The new gateway (user choice) is created by the next purchase; script it to pay.
        val second = async {
            h.buy()
        }
        advanceUntilIdle()
        val replacement = h.factory.latest
        assertTrue(replacement.userChoice)
        assertTrue(first.closed, "the old client is ended")
        replacement.deliverPurchase(devicePurchase(token = "t2", accountId = "acct-2"))
        advanceUntilIdle()
        assertIs<PurchaseOutcome.Completed>(second.await())
        assertEquals(listOf(false, true), h.factory.created.map { it.userChoice })
    }

    private fun hosted(sessionId: String) = PurchaseRecord(
        sessionId = sessionId, product = "pro_monthly", kind = PurchaseRecord.Kind.HOSTED, state = PurchaseRecord.State.AWAITING_RETURN,
        createdAtMillis = NOW, expiresAtMillis = NOW + 86_400_000,
    )
}
