package dev.indiasubscriptions

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import dev.indiasubscriptions.backend.HttpPurchaseBackend
import dev.indiasubscriptions.backend.PurchaseBackendException
import dev.indiasubscriptions.backend.RetryAdvice
import dev.indiasubscriptions.backend.ServerErrorCode
import dev.indiasubscriptions.models.ChooseAlternativeInput
import dev.indiasubscriptions.models.CompletePurchaseInput
import dev.indiasubscriptions.models.Customer
import dev.indiasubscriptions.models.StartPurchaseInput
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.json.JSONObject
import org.junit.After
import org.junit.Before
import org.junit.Test

/** `HttpPurchaseBackend` against a real HTTP server on the loopback interface. */
class HttpPurchaseBackendTests {
    private class Received(val method: String, val path: String, val rawPath: String, val headers: Map<String, String>, val body: String)

    private class Reply(val status: Int, val body: String = "", val headers: Map<String, String> = emptyMap())

    private lateinit var server: HttpServer
    private val received = CopyOnWriteArrayList<Received>()
    private var reply: (Received) -> Reply = { Reply(200, fixture("session-completed.json")) }

    private val base: String get() = "http://127.0.0.1:${server.address.port}"

    private fun fixture(name: String): String =
        javaClass.classLoader!!.getResourceAsStream("fixtures/$name")!!.bufferedReader().use { it.readText() }

    @Before
    fun startServer() {
        server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/") { exchange -> handle(exchange) }
        server.start()
    }

    @After
    fun stopServer() {
        server.stop(0)
    }

    private fun handle(exchange: HttpExchange) {
        val body = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
        val headers = exchange.requestHeaders.entries.associate { it.key.lowercase() to it.value.joinToString(",") }
        val request = Received(exchange.requestMethod, exchange.requestURI.path, exchange.requestURI.rawPath, headers, body)
        received += request
        val answer = reply(request)
        val bytes = answer.body.toByteArray(Charsets.UTF_8)
        for ((name, value) in answer.headers) exchange.responseHeaders.add(name, value)
        exchange.sendResponseHeaders(answer.status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
        if (bytes.isNotEmpty()) exchange.responseBody.use { it.write(bytes) }
        exchange.close()
    }

    private fun backend(
        baseUrl: String = base,
        authorization: suspend () -> String? = { "Bearer user-token" },
        paths: HttpPurchaseBackend.Paths = HttpPurchaseBackend.Paths(),
        timeoutMillis: Int = 5_000,
    ) = HttpPurchaseBackend(baseUrl, authorization, paths, timeoutMillis)

    @Test
    fun `the five calls use the service's routes, the user's authorisation and JSON bodies`() = runBlocking<Unit> {
        val backend = backend()
        reply = { request ->
            when {
                request.path.startsWith("/v1/entitlements/") -> Reply(200, fixture("entitlements.json"))
                else -> Reply(200, fixture("session-completed.json"))
            }
        }

        backend.startPurchase(StartPurchaseInput(product = "pro_monthly", customer = Customer(state = "Karnataka"), customerRef = "cust_1", reference = "ref_1"))
        backend.purchase("ps_1")
        backend.chooseAlternative("ps_1", ChooseAlternativeInput("tok"))
        backend.completePurchase("ps_1", CompletePurchaseInput.googlePlay("pt", "in.example.pro"))
        backend.entitlements("cust_1")

        assertEquals(
            listOf(
                "POST /v1/purchases", "GET /v1/purchases/ps_1", "POST /v1/purchases/ps_1/alternative",
                "POST /v1/purchases/ps_1/complete", "GET /v1/entitlements/cust_1",
            ),
            received.map { "${it.method} ${it.path}" },
        )
        for (request in received) {
            assertEquals("Bearer user-token", request.headers["authorization"])
            assertEquals("application/json", request.headers["accept"])
            // The service's API key never goes anywhere: there is no such header.
            assertNull(request.headers["x-api-key"])
        }
        assertEquals("application/json", received[0].headers["content-type"])
        assertEquals("android", JSONObject(received[0].body).getString("platform"))
        assertEquals("Karnataka", JSONObject(received[0].body).getJSONObject("customer").getString("state"))
        assertEquals("tok", JSONObject(received[2].body).getString("externalTransactionToken"))
        val complete = JSONObject(received[3].body)
        assertEquals("google_play", complete.getString("provider"))
        assertEquals("pt", complete.getJSONObject("result").getString("purchaseToken"))
        assertEquals("in.example.pro", complete.getJSONObject("result").getString("productId"))
        assertNull(received[1].headers["content-type"], "a GET sends no body")
        assertEquals("", received[1].body)
    }

    @Test
    fun `answers decode into the models`() = runBlocking<Unit> {
        val session = backend().purchase("ps_1")
        assertEquals("completed", session.status.value)
        assertEquals("purchase-token-1", session.subscriptionId)
        assertEquals(1_795_343_472_500L, session.completedAtMillis)
        reply = { Reply(200, fixture("entitlements.json")) }
        assertTrue(backend().entitlements("cust_1").hasAccess("pro_monthly"))
    }

    @Test
    fun `the authorisation hook is asked for every request and may return nothing`() = runBlocking<Unit> {
        var calls = 0
        val backend = backend(authorization = {
            calls++
            if (calls == 1) "Bearer first" else null
        })
        backend.purchase("ps_1")
        backend.purchase("ps_1")
        assertEquals("Bearer first", received[0].headers["authorization"])
        assertNull(received[1].headers["authorization"])
    }

    @Test
    fun `paths are overridable, the base may carry a prefix, and values stay one path segment`() = runBlocking<Unit> {
        val custom = HttpPurchaseBackend.Paths(
            start = "billing/start",
            session = "billing/s/{sessionId}",
            alternative = "billing/s/{sessionId}/alt",
            complete = "billing/s/{sessionId}/done",
            entitlements = "billing/e/{customerRef}",
        )
        val backend = backend(baseUrl = "$base/api/", paths = custom)
        backend.purchase("ps/../1 x")
        backend.completePurchase("ps_1", CompletePurchaseInput.googlePlay("t", "p"))
        reply = { Reply(200, fixture("entitlements.json")) }
        backend.entitlements("cust/1 é")

        assertEquals("/api/billing/s/ps%2F..%2F1%20x", received[0].rawPath)
        assertEquals("/api/billing/s/ps_1/done", received[1].path)
        assertEquals("/api/billing/e/cust%2F1%20%C3%A9", received[2].rawPath)
    }

    @Test
    fun `an empty identifier is refused before anything is sent`() = runBlocking<Unit> {
        val error = assertFailsWith<PurchaseBackendException.InvalidRequest> { backend().purchase("") }
        assertEquals(RetryAdvice.NEVER, error.retryAdvice)
        assertTrue(received.isEmpty())
        assertFailsWith<PurchaseBackendException.InvalidRequest> { backend(baseUrl = "ftp://example.com").purchase("ps_1") }
    }

    @Test
    fun `an error in the service's shape carries its code and decides retrying`() = runBlocking<Unit> {
        val cases = listOf(
            Triple(400, """{"error":{"code":"VALIDATION","message":"bad","provider":"google_play","retryable":false}}""", RetryAdvice.NEVER),
            Triple(409, """{"error":{"code":"CONFLICT","message":"already subscribed","retryable":false}}""", RetryAdvice.NEVER),
            Triple(404, """{"error":{"code":"NOT_FOUND","message":"no such session","retryable":false}}""", RetryAdvice.NEVER),
            Triple(422, """{"error":{"code":"SIGNATURE_INVALID","message":"x"}}""", RetryAdvice.NEVER),
            Triple(429, """{"error":{"code":"RATE_LIMITED","message":"slow down","retryable":true}}""", RetryAdvice.LATER),
            Triple(503, """{"error":{"code":"PROVIDER_UNAVAILABLE","message":"down","providerCode":"4040003","retryable":true}}""", RetryAdvice.LATER),
            Triple(401, """{"error":{"code":"UNAUTHORIZED","message":"token expired"}}""", RetryAdvice.LATER),
            Triple(502, """{"error":{"code":"PROVIDER_ERROR","message":"google said no","provider":"google_play","retryable":true}}""", RetryAdvice.LIMITED),
            Triple(500, """{"error":{"code":"INTERNAL_ERROR","message":"boom"}}""", RetryAdvice.LIMITED),
            Triple(500, """{"error":{"code":"OUTCOME_UNKNOWN","message":"?"}}""", RetryAdvice.LIMITED),
            Triple(418, """{"error":{"code":"TEAPOT","message":"newer code","retryable":false}}""", RetryAdvice.NEVER),
            Triple(418, """{"error":{"code":"TEAPOT","message":"newer code","retryable":true}}""", RetryAdvice.LIMITED),
            Triple(502, """{"error":{"code":"NEWER","message":"no flag"}}""", RetryAdvice.LIMITED),
            Triple(400, """{"error":{"code":"NEWER","message":"no flag"}}""", RetryAdvice.NEVER),
        )
        for ((status, body, advice) in cases) {
            reply = { Reply(status, body) }
            val error = assertFailsWith<PurchaseBackendException.Server>(body) { backend().completePurchase("ps_1", CompletePurchaseInput.googlePlay("t", "p")) }
            assertEquals(status, error.error.statusCode)
            assertEquals(JSONObject(body).getJSONObject("error").getString("code"), error.code?.value)
            assertTrue(error.error.isStructured, "structured: $body")
            assertEquals(advice, error.retryAdvice, body)
        }
    }

    @Test
    fun `the whole error is kept`() = runBlocking<Unit> {
        // The bodies the service's error handler produces (the same fixtures as the iOS package).
        reply = { Reply(503, fixture("error-unavailable.json")) }
        val unavailable = assertFailsWith<PurchaseBackendException.Server> { backend().purchase("ps_1") }.error
        assertEquals(ServerErrorCode.ProviderUnavailable, unavailable.code)
        assertEquals("The gateway is unavailable", unavailable.message)
        assertEquals("app_store", unavailable.provider)
        assertEquals("4040003", unavailable.providerCode)
        assertEquals(true, unavailable.retryable)

        reply = { Reply(400, fixture("error-validation.json")) }
        val validation = assertFailsWith<PurchaseBackendException.Server> { backend().purchase("ps_1") }
        assertEquals(ServerErrorCode.Validation, validation.code)
        assertEquals(false, validation.error.retryable)
        assertEquals(RetryAdvice.NEVER, validation.retryAdvice)
    }

    @Test
    fun `an error that is not in the service's shape is derived from the status`() = runBlocking<Unit> {
        val cases = listOf(
            401 to (ServerErrorCode.Unauthorized to RetryAdvice.LATER),
            403 to (ServerErrorCode.Unauthorized to RetryAdvice.LATER),
            404 to (ServerErrorCode.NotFound to RetryAdvice.NEVER),
            408 to (ServerErrorCode.Timeout to RetryAdvice.LATER),
            429 to (ServerErrorCode.RateLimited to RetryAdvice.LATER),
            400 to (ServerErrorCode.Validation to RetryAdvice.NEVER),
            413 to (ServerErrorCode.Validation to RetryAdvice.NEVER),
            503 to (ServerErrorCode.ProviderUnavailable to RetryAdvice.LATER),
            504 to (ServerErrorCode.Timeout to RetryAdvice.LATER),
            502 to (ServerErrorCode.InternalError to RetryAdvice.LIMITED),
            500 to (ServerErrorCode.InternalError to RetryAdvice.LIMITED),
        )
        for ((status, expected) in cases) {
            reply = { Reply(status, "<html>proxy says no</html>") }
            val error = assertFailsWith<PurchaseBackendException.Server>("status $status") { backend().purchase("ps_1") }
            assertEquals(expected.first, error.code, "status $status")
            assertEquals(expected.second, error.retryAdvice, "status $status")
            assertTrue(!error.error.isStructured)
        }
        reply = { Reply(502) } // an empty body
        assertEquals(ServerErrorCode.InternalError, assertFailsWith<PurchaseBackendException.Server> { backend().purchase("ps_1") }.code)
    }

    @Test
    fun `a 2xx body the SDK cannot read is a malformed response that is not retried`() = runBlocking<Unit> {
        for (body in listOf("not json", "[]", "{}", """{"id":"x"}""", "")) {
            reply = { Reply(200, body) }
            val error = assertFailsWith<PurchaseBackendException.MalformedResponse>("body '$body'") { backend().purchase("ps_1") }
            assertEquals(200, error.statusCode)
            assertEquals(RetryAdvice.NEVER, error.retryAdvice)
        }
    }

    @Test
    fun `a backend that cannot be reached is a transport error that is retried later`() = runBlocking<Unit> {
        val closedPort = ServerSocket(0, 0, InetAddress.getLoopbackAddress()).use { it.localPort }
        val error = assertFailsWith<PurchaseBackendException.Transport> {
            backend(baseUrl = "http://127.0.0.1:$closedPort").purchase("ps_1")
        }
        assertEquals(RetryAdvice.LATER, error.retryAdvice)
        assertNull(error.code)
    }

    @Test
    fun `a backend that does not answer in time is a transport error`() = runBlocking<Unit> {
        val release = CountDownLatch(1)
        reply = {
            release.await(10, TimeUnit.SECONDS)
            Reply(200, fixture("session-completed.json"))
        }
        val error = assertFailsWith<PurchaseBackendException.Transport> { backend(timeoutMillis = 300).purchase("ps_1") }
        assertEquals(RetryAdvice.LATER, error.retryAdvice)
        release.countDown()
    }

    @Test
    fun `cancelling the caller closes the connection and returns at once`() = runBlocking<Unit> {
        val release = CountDownLatch(1)
        val arrived = CountDownLatch(1)
        reply = {
            arrived.countDown()
            release.await(10, TimeUnit.SECONDS)
            Reply(200, fixture("session-completed.json"))
        }
        val call = async(kotlinx.coroutines.Dispatchers.Default) { backend(timeoutMillis = 30_000).purchase("ps_1") }
        assertTrue(arrived.await(5, TimeUnit.SECONDS))
        call.cancel()
        withTimeout(3_000) { // far less than the 30 s timeout
            assertFailsWith<CancellationException> { call.await() }
        }
        release.countDown()
    }

    @Test
    fun `a redirect is not followed, so the authorisation never travels to another host`() = runBlocking<Unit> {
        reply = { request ->
            if (request.path == "/v1/purchases/ps_1") Reply(302, headers = mapOf("Location" to "$base/elsewhere")) else Reply(200, fixture("session-completed.json"))
        }
        val error = assertFailsWith<PurchaseBackendException.Server> { backend().purchase("ps_1") }
        assertEquals(302, error.error.statusCode)
        assertEquals(listOf("/v1/purchases/ps_1"), received.map { it.path })
    }

    @Test
    fun `an unusable authorisation value is an invalid request, not a crash`() = runBlocking<Unit> {
        assertIs<PurchaseBackendException.InvalidRequest>(
            assertFailsWith<PurchaseBackendException> { backend(authorization = { "Bearer a\nb" }).purchase("ps_1") },
        )
    }
}
