package dev.indiasubscriptions

import dev.indiasubscriptions.models.CheckoutInstruction
import dev.indiasubscriptions.models.ChannelPolicy
import dev.indiasubscriptions.models.ChooseAlternativeInput
import dev.indiasubscriptions.models.CompletePurchaseInput
import dev.indiasubscriptions.models.Customer
import dev.indiasubscriptions.models.Entitlements
import dev.indiasubscriptions.models.EntitlementStatus
import dev.indiasubscriptions.models.Iso8601
import dev.indiasubscriptions.models.Platform
import dev.indiasubscriptions.models.ProductKind
import dev.indiasubscriptions.models.Provider
import dev.indiasubscriptions.models.PurchaseSession
import dev.indiasubscriptions.models.SessionStatus
import dev.indiasubscriptions.models.StartPurchaseInput
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.json.JSONObject
import org.junit.Test

class ModelDecodingTests {
    private fun fixture(name: String): String =
        javaClass.classLoader!!.getResourceAsStream("fixtures/$name")!!.bufferedReader().use { it.readText() }

    @Test
    fun `a Google Play session decodes with its instruction`() {
        val session = PurchaseSession.fromJson(fixture("session-google-play.json"))
        assertEquals("ps_7a1c0f2e9b3d4c5e8f6a1b2c3d4e5f60", session.id)
        assertEquals(Platform.Android, session.platform)
        assertEquals(ChannelPolicy.UserChoice, session.policy)
        assertEquals(SessionStatus.Open, session.status)
        assertEquals("myapp://billing/return", session.returnUrl)
        assertEquals(1_795_343_400_000L, session.createdAtMillis)
        assertEquals(1_795_429_800_000L, session.expiresAtMillis)

        val play = session.googlePlayOption!!
        assertEquals(Provider.GooglePlay, play.option.provider)
        assertEquals(
            CheckoutInstruction.GooglePlayBilling(
                productKind = ProductKind.Subscription,
                productId = "in.example.pro",
                basePlanId = "monthly",
                offerId = "intro-7d",
                obfuscatedAccountId = "6f1c2f4e-5b6a-4a52-9a43-0f2d7d7c9a10",
                userChoiceBilling = true,
            ),
            play.checkout,
        )
        assertNull(session.hostedOption)
    }

    @Test
    fun `a session after the alternative carries the gateway option and its hosted page`() {
        val session = PurchaseSession.fromJson(fixture("session-alternative.json"))
        assertEquals("ext-token-abc", session.externalTransactionToken)
        assertEquals(2, session.options.size)
        val hosted = session.hostedOption!!
        assertEquals(Provider.Razorpay, hosted.provider)
        assertEquals("https://pay.example.com/checkout/ps_7a1c0f2e9b3d4c5e8f6a1b2c3d4e5f60", hosted.hostedUrl)
        // The gateway's own instruction is not typed: it is carried as its kind.
        assertEquals(CheckoutInstruction.Other("razorpay_checkout"), hosted.checkout)
        assertEquals(1, session.attempts.size)
    }

    @Test
    fun `values and instruction kinds a newer server adds do not break decoding`() {
        val session = PurchaseSession.fromJson(fixture("session-newer-server.json"))
        assertEquals(Platform("visionos"), session.platform)
        assertEquals(ChannelPolicy("bundle"), session.policy)
        assertEquals(SessionStatus("on_hold"), session.status)
        assertEquals("on_hold", session.status.value)
        assertEquals(3, session.options.size)
        assertEquals(CheckoutInstruction.Other("quantum_checkout"), session.options[2].checkout)
        assertEquals("wallet", session.options[0].channel.value)
        assertIs<CheckoutInstruction.GooglePlayBilling>(session.googlePlayOption!!.checkout)
        assertEquals("paused", session.attempts[1].outcome.value)
        assertEquals(1_795_343_401_250L, session.attempts[1].atMillis)
    }

    @Test
    fun `a Google Play instruction that is missing a required field is a decoding error`() {
        val json = JSONObject(fixture("session-google-play.json"))
        json.getJSONArray("options").getJSONObject(0).getJSONObject("checkout").remove("obfuscatedAccountId")
        assertFailsWith<IllegalArgumentException> { PurchaseSession.fromJson(json.toString()) }
        assertFailsWith<IllegalArgumentException> { PurchaseSession.fromJson("[]") }
        assertFailsWith<IllegalArgumentException> { PurchaseSession.fromJson("{}") }
    }

    @Test
    fun `optional fields may be absent or null`() {
        val json = JSONObject(fixture("session-google-play.json"))
        json.remove("returnUrl")
        json.remove("attempts")
        json.put("reference", JSONObject.NULL)
        val session = PurchaseSession.fromJson(json.toString())
        assertNull(session.returnUrl)
        assertNull(session.reference)
        assertTrue(session.attempts.isEmpty())
    }

    @Test
    fun `entitlements decode with unknown statuses and answer access questions`() {
        val entitlements = Entitlements.fromJson(fixture("entitlements.json"))
        assertTrue(entitlements.active)
        assertEquals(3, entitlements.items.size)
        assertTrue(entitlements.hasAccess("pro_monthly"))
        assertTrue(!entitlements.hasAccess("coins_100"), "refunded")
        assertEquals(1, entitlements.activeItems.size)
        assertEquals(EntitlementStatus("in_dunning"), entitlements.items[2].status)
        assertEquals(EntitlementStatus.Refunded, entitlements.items[1].status)
        assertEquals(1_797_935_400_000L, entitlements.items[0].currentPeriodEndMillis)
        assertEquals(false, entitlements.items[0].cancelAtPeriodEnd)
        assertNull(entitlements.items[1].currentPeriodEndMillis)
    }

    @Test
    fun `requests are encoded the way the service reads them`() {
        val start = StartPurchaseInput(
            product = "pro_monthly",
            customer = Customer(name = "Asha", email = "asha@example.com", state = "Karnataka"),
            customerRef = "cust_1",
            reference = "ref_1",
            returnUrl = "myapp://billing/return",
        ).toJson()
        assertEquals("android", start.getString("platform"))
        assertEquals("Karnataka", start.getJSONObject("customer").getString("state"))
        assertEquals("ref_1", start.getString("reference"))
        assertEquals(setOf("platform", "product", "customer", "customerRef", "reference", "returnUrl"), start.keys().asSequence().toSet())

        val minimal = StartPurchaseInput(product = "p", customerRef = "c").toJson()
        assertEquals(setOf("platform", "product", "customer", "customerRef"), minimal.keys().asSequence().toSet())
        assertEquals(0, minimal.getJSONObject("customer").length())

        assertEquals("""{"externalTransactionToken":"tok"}""", ChooseAlternativeInput("tok").toJson().toString())

        val complete = CompletePurchaseInput.googlePlay("pt", "in.example.pro").toJson()
        assertEquals("google_play", complete.getString("provider"))
        assertEquals("pt", complete.getJSONObject("result").getString("purchaseToken"))
        assertEquals("in.example.pro", complete.getJSONObject("result").getString("productId"))
        assertEquals(setOf("purchaseToken", "productId"), complete.getJSONObject("result").keys().asSequence().toSet())
    }

    @Test
    fun `times are read with a zone, an offset, and fractions`() {
        assertEquals(1_795_343_400_000L, Iso8601.parse("2026-11-22T10:30:00.000Z"))
        assertEquals(1_795_343_400_000L, Iso8601.parse("2026-11-22T10:30:00Z"))
        assertEquals(1_795_343_400_000L, Iso8601.parse("2026-11-22T16:00:00+05:30"))
        assertEquals(1_795_343_400_000L, Iso8601.parse("2026-11-22T05:30:00-0500"))
        assertEquals(1_795_343_401_250L, Iso8601.parse("2026-11-22T10:30:01.25Z"))
        assertEquals(1_795_343_401_250L, Iso8601.parse("2026-11-22T10:30:01.250999Z"))
        assertEquals(0L, Iso8601.parse("1970-01-01T00:00:00Z"))
        assertEquals(951_825_600_000L, Iso8601.parse("2000-02-29T12:00:00Z"))
        assertEquals(-1_000L, Iso8601.parse("1969-12-31T23:59:59Z"))
        assertNull(Iso8601.parse("2026-11-22"))
        assertNull(Iso8601.parse("2026-11-22T10:30:00"))
        assertNull(Iso8601.parse("yesterday"))
        assertNull(Iso8601.parse("2026-13-22T10:30:00Z"))
    }
}
