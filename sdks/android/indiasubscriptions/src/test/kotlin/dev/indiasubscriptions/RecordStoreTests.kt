package dev.indiasubscriptions

import dev.indiasubscriptions.storage.InMemoryPurchaseRecordStore
import dev.indiasubscriptions.storage.PurchaseRecord
import dev.indiasubscriptions.storage.PurchaseRecordCodec
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import org.json.JSONObject
import org.junit.Test

class RecordStoreTests {
    private val record = PurchaseRecord(
        sessionId = "ps_1",
        product = "pro_monthly",
        kind = PurchaseRecord.Kind.GOOGLE_PLAY,
        accountId = ACCOUNT_ID,
        googleProductId = GOOGLE_PRODUCT,
        userChoice = true,
        returnUrl = RETURN_LINK,
        state = PurchaseRecord.State.TOKEN_UNSENT,
        externalTransactionToken = EXTERNAL_TOKEN,
        completedPurchaseTokens = listOf("a", "b"),
        failedRounds = 2,
        lastErrorCode = "INTERNAL_ERROR",
        createdAtMillis = NOW,
        expiresAtMillis = NOW + 1000,
        updatedAtMillis = NOW + 500,
    )

    @Test
    fun `records survive a round trip through the stored JSON`() {
        val minimal = PurchaseRecord(sessionId = "ps_2", product = "p", kind = PurchaseRecord.Kind.HOSTED, createdAtMillis = 1, expiresAtMillis = 2)
        val decoded = PurchaseRecordCodec.decode(PurchaseRecordCodec.encode(listOf(record, minimal)))
        assertEquals(listOf(record, minimal), decoded)
        assertEquals(emptyList(), PurchaseRecordCodec.decode(PurchaseRecordCodec.encode(emptyList())))
    }

    @Test
    fun `a state or kind written by another version is read as open rather than lost`() {
        val json = JSONObject(PurchaseRecordCodec.encode(listOf(record)))
        val first = json.getJSONArray("records").getJSONObject(0)
        first.put("state", "SOMETHING_NEWER")
        first.put("kind", "NEW_KIND")
        val decoded = PurchaseRecordCodec.decode(json.toString()).single()
        assertEquals(PurchaseRecord.State.OPEN, decoded.state)
        assertEquals(PurchaseRecord.Kind.GOOGLE_PLAY, decoded.kind)
        assertEquals(ACCOUNT_ID, decoded.accountId)
    }

    @Test
    fun `storage that cannot be read is an error, not an empty list`() {
        assertFailsWith<Exception> { PurchaseRecordCodec.decode("not json") }
    }

    @Test
    fun `the in-memory store keeps what was saved and is not changed by later edits to the list`() {
        val source = mutableListOf(record)
        val store = InMemoryPurchaseRecordStore()
        assertTrue(store.load().isEmpty())
        store.save(source)
        source.clear()
        assertEquals(listOf(record), store.load())
    }

    @Test
    fun `a record holds no customer details and no purchase token of an unconfirmed purchase`() {
        val encoded = PurchaseRecordCodec.encode(listOf(record.copy(state = PurchaseRecord.State.OPEN, externalTransactionToken = null, completedPurchaseTokens = emptyList())))
        assertTrue(!encoded.contains("email"))
        assertTrue(!encoded.contains(PURCHASE_TOKEN))
        assertTrue(!encoded.contains(EXTERNAL_TOKEN))
    }
}
