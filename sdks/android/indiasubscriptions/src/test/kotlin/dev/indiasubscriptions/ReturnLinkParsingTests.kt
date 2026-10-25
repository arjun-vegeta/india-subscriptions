package dev.indiasubscriptions

import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

class ReturnLinkParsingTests {
    private fun query(link: String, name: String) = PurchaseClient.queryParameter(link, name)

    @Test
    fun `query parameters are read and percent-decoded`() {
        assertEquals("ps_1", query("myapp://billing/return?session=ps_1&status=completed", "session"))
        assertEquals("completed", query("myapp://billing/return?session=ps_1&status=completed", "status"))
        assertEquals("a b&c", query("myapp://billing/return?session=a%20b%26c", "session"))
        assertEquals("", query("myapp://billing/return?session", "session"))
        assertEquals("first", query("myapp://billing/return?session=first&session=second", "session"))
        assertNull(query("myapp://billing/return?status=completed", "session"))
        assertNull(query("myapp://billing/return", "session"))
        assertNull(query("not a uri %%", "session"))
        assertNull(query("no-scheme?session=x", "session"))
    }

    @Test
    fun `a link points to a return URL when scheme, host, port and path agree`() {
        fun same(link: String, returnUrl: String) = PurchaseClient.sameDestination(PurchaseClient.parse(link)!!, returnUrl)
        assertTrue(same("myapp://billing/return?session=ps_1", "myapp://billing/return"))
        assertTrue(same("MYAPP://Billing/return/?x=1", "myapp://billing/return"))
        assertTrue(same("https://app.example.com/billing/return?session=ps_1", "https://app.example.com/billing/return"))
        assertFalse(same("myapp://billing/other", "myapp://billing/return"))
        assertFalse(same("myapp://settings/return", "myapp://billing/return"))
        assertFalse(same("other://billing/return", "myapp://billing/return"))
        assertFalse(same("https://evil.example/billing/return", "https://app.example.com/billing/return"))
        assertFalse(same("https://app.example.com:8443/billing/return", "https://app.example.com/billing/return"))
        assertFalse(same("myapp://billing/return", "not a uri %%"))
    }
}
