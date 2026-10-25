package dev.indiasubscriptions

import com.android.billingclient.api.BillingResult as PlayBillingResult
import com.android.billingclient.api.Purchase
import dev.indiasubscriptions.billing.DevicePurchaseState
import dev.indiasubscriptions.billing.toDevicePurchase
import dev.indiasubscriptions.billing.toSdk
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.json.JSONObject
import org.junit.Test

/** The translation of the Play Billing Library's own objects, with the library's real classes. */
class PlayBillingMappingTests {
    private fun purchaseJson(state: Int, accountId: String? = ACCOUNT_ID, acknowledged: Boolean = false): String =
        JSONObject()
            .put("orderId", "GPA.1234-5678-9012-34567")
            .put("packageName", "in.example.app")
            .put("productId", GOOGLE_PRODUCT)
            .put("purchaseTime", 1_795_516_200_000L)
            .put("purchaseState", state)
            .put("purchaseToken", PURCHASE_TOKEN)
            .put("quantity", 1)
            .put("acknowledged", acknowledged)
            .put("autoRenewing", true)
            .apply { accountId?.let { put("obfuscatedAccountId", it) } }
            .toString()

    @Test
    fun `a purchase keeps its token, products, account id and acknowledgement`() {
        val purchase = Purchase(purchaseJson(state = 0), "signature").toDevicePurchase()
        assertEquals(PURCHASE_TOKEN, purchase.purchaseToken)
        assertEquals(listOf(GOOGLE_PRODUCT), purchase.productIds)
        assertEquals(ACCOUNT_ID, purchase.obfuscatedAccountId)
        assertEquals(false, purchase.acknowledged)
        assertEquals(1, purchase.quantity)
    }

    @Test
    fun `a purchase made outside the app has no account id`() {
        assertNull(Purchase(purchaseJson(state = 0, accountId = null), "signature").toDevicePurchase().obfuscatedAccountId)
    }

    @Test
    fun `the purchase states of Google are told apart`() {
        // The library reads the state out of the purchase JSON: 0 purchased, 4 pending, anything else unspecified.
        assertEquals(DevicePurchaseState.PURCHASED, Purchase(purchaseJson(state = 0), "s").toDevicePurchase().state)
        assertEquals(DevicePurchaseState.PENDING, Purchase(purchaseJson(state = 4), "s").toDevicePurchase().state)
    }

    @Test
    fun `a billing result keeps its code, message and sub-response code`() {
        val plain = PlayBillingResult.newBuilder().setResponseCode(7).setDebugMessage("owned").build().toSdk()
        assertEquals(7, plain.code)
        assertEquals("owned", plain.message)
        assertNull(plain.subCode)

        val declined = PlayBillingResult.newBuilder().setResponseCode(3).setOnPurchasesUpdatedSubResponseCode(1).build().toSdk()
        assertEquals(1, declined.subCode)
    }
}
