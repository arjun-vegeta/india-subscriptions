package dev.indiasubscriptions.backend

import dev.indiasubscriptions.models.ChooseAlternativeInput
import dev.indiasubscriptions.models.CompletePurchaseInput
import dev.indiasubscriptions.models.DecodingException
import dev.indiasubscriptions.models.Entitlements
import dev.indiasubscriptions.models.PurchaseSession
import dev.indiasubscriptions.models.StartPurchaseInput
import dev.indiasubscriptions.models.decoding
import dev.indiasubscriptions.models.optionalBoolean
import dev.indiasubscriptions.models.optionalObject
import dev.indiasubscriptions.models.optionalString
import dev.indiasubscriptions.models.requiredString
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * A [PurchaseBackend] that talks to the merchant's backend over HTTP with JSON bodies, through `HttpURLConnection`.
 *
 * - [baseUrl] is the merchant backend's root, for example `https://api.example.com/` or `https://example.com/billing/`.
 *   Use `https`: Android blocks cleartext traffic by default unless the app's network security configuration allows it.
 * - [authorization] supplies the value of the `Authorization` header for each request (for example `"Bearer <user
 *   token>"`). It is called per request, so it can refresh an expired token. Return null to send no header.
 * - [paths] are the five relative paths, with `{sessionId}` and `{customerRef}` placeholders. The defaults are the
 *   service's own routes; override them when the merchant's backend mounts them elsewhere.
 *
 * Every call runs on `Dispatchers.IO` and never blocks the caller's thread. Cancelling the calling coroutine closes the
 * connection. Redirects are not followed, so the `Authorization` header never travels to another host.
 */
public class HttpPurchaseBackend(
    public val baseUrl: String,
    private val authorization: suspend () -> String? = { null },
    public val paths: Paths = Paths(),
    public val timeoutMillis: Int = 30_000,
    private val dispatcher: CoroutineDispatcher = Dispatchers.IO,
) : PurchaseBackend {

    /**
     * The five relative paths. A path is joined to the base URL; `{sessionId}` and `{customerRef}` are replaced by the
     * percent-encoded value.
     */
    public data class Paths(
        val start: String = "v1/purchases",
        val session: String = "v1/purchases/{sessionId}",
        val alternative: String = "v1/purchases/{sessionId}/alternative",
        val complete: String = "v1/purchases/{sessionId}/complete",
        val entitlements: String = "v1/entitlements/{customerRef}",
    )

    override suspend fun startPurchase(input: StartPurchaseInput): PurchaseSession =
        send("POST", paths.start, emptyMap(), input.toJson()) { PurchaseSession.fromJson(it) }

    override suspend fun purchase(sessionId: String): PurchaseSession =
        send("GET", paths.session, mapOf(SESSION_ID to sessionId), null) { PurchaseSession.fromJson(it) }

    override suspend fun chooseAlternative(sessionId: String, input: ChooseAlternativeInput): PurchaseSession =
        send("POST", paths.alternative, mapOf(SESSION_ID to sessionId), input.toJson()) { PurchaseSession.fromJson(it) }

    override suspend fun completePurchase(sessionId: String, input: CompletePurchaseInput): PurchaseSession =
        send("POST", paths.complete, mapOf(SESSION_ID to sessionId), input.toJson()) { PurchaseSession.fromJson(it) }

    override suspend fun entitlements(customerRef: String): Entitlements =
        send("GET", paths.entitlements, mapOf(CUSTOMER_REF to customerRef), null) { Entitlements.fromJson(it) }

    // -- plumbing ------------------------------------------------------------------------------------------------------

    private class Response(val status: Int, val body: ByteArray)

    private suspend fun <T> send(
        method: String,
        template: String,
        values: Map<String, String>,
        body: JSONObject?,
        decode: (JSONObject) -> T,
    ): T {
        val url = url(template, values)
        val header = authorization()
        val response = execute(url, method, header, body?.toString()?.toByteArray(Charsets.UTF_8))
        if (response.status !in 200..299) throw PurchaseBackendException.Server(serverError(response.status, response.body))
        val text = String(response.body, Charsets.UTF_8)
        try {
            return decoding(text, decode)
        } catch (error: DecodingException) {
            throw PurchaseBackendException.MalformedResponse(response.status, error.message ?: "unreadable", error)
        }
    }

    internal fun url(template: String, values: Map<String, String>): URL {
        var path = template
        for ((placeholder, value) in values) {
            if (value.isEmpty()) throw PurchaseBackendException.InvalidRequest("An empty value for $placeholder")
            path = path.replace(placeholder, encodeSegment(value))
        }
        val base = baseUrl.trimEnd('/')
        val joined = "$base/${path.trimStart('/')}"
        return try {
            val url = URL(joined)
            if (url.protocol != "https" && url.protocol != "http") throw IOException("not an http(s) URL")
            url
        } catch (error: IOException) {
            throw PurchaseBackendException.InvalidRequest("Not a valid URL: $joined")
        }
    }

    /** Percent-encodes a value so that it stays one path segment (a `/` becomes `%2F`). */
    private fun encodeSegment(value: String): String = URLEncoder.encode(value, "UTF-8").replace("+", "%20")

    private suspend fun execute(url: URL, method: String, authorizationHeader: String?, body: ByteArray?): Response =
        withContext(dispatcher) {
            val connection = try {
                url.openConnection() as HttpURLConnection
            } catch (error: IOException) {
                throw PurchaseBackendException.Transport(error.message ?: "Could not open a connection", error)
            }
            try {
                suspendCancellableCoroutine { continuation ->
                    // Cancelling the caller closes the socket, which wakes the blocked read.
                    continuation.invokeOnCancellation { connection.disconnect() }
                    try {
                        continuation.resumeWith(Result.success(call(connection, method, authorizationHeader, body)))
                    } catch (error: PurchaseBackendException) {
                        continuation.resumeWith(Result.failure(error))
                    }
                }
            } finally {
                connection.disconnect()
            }
        }

    /** Blocking: runs on the IO dispatcher. */
    private fun call(connection: HttpURLConnection, method: String, authorizationHeader: String?, body: ByteArray?): Response {
        try {
            connection.requestMethod = method
            connection.connectTimeout = timeoutMillis
            connection.readTimeout = timeoutMillis
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.setRequestProperty("Accept", JSON)
            if (authorizationHeader != null) connection.setRequestProperty("Authorization", authorizationHeader)
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", JSON)
                // No streaming mode: with it, the platform drops the body of a 401 answer.
                connection.outputStream.use { it.write(body) }
            }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            return Response(status, stream?.use { readBounded(it) } ?: ByteArray(0))
        } catch (error: IOException) {
            throw PurchaseBackendException.Transport(error.message ?: error.javaClass.simpleName, error)
        } catch (error: IllegalArgumentException) {
            // For example a header value with a line break.
            throw PurchaseBackendException.InvalidRequest(error.message ?: "Invalid request")
        }
    }

    private fun readBounded(stream: InputStream): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(8 * 1024)
        while (true) {
            val read = stream.read(buffer)
            if (read < 0) break
            out.write(buffer, 0, read)
            if (out.size() > MAX_BODY_BYTES) throw IOException("The response is larger than $MAX_BODY_BYTES bytes")
        }
        return out.toByteArray()
    }

    internal companion object {
        private const val SESSION_ID = "{sessionId}"
        private const val CUSTOMER_REF = "{customerRef}"
        private const val JSON = "application/json"
        private const val MAX_BODY_BYTES = 4 * 1024 * 1024

        /** The service's error body: `{ "error": { "code", "message", "provider"?, "providerCode"?, "retryable" } }`. */
        fun serverError(status: Int, body: ByteArray): ServerError {
            try {
                val root = JSONObject(String(body, Charsets.UTF_8))
                val detail = root.optionalObject("error")
                if (detail != null) {
                    return ServerError(
                        statusCode = status,
                        code = ServerErrorCode(detail.requiredString("code")),
                        message = detail.optionalString("message") ?: "",
                        provider = detail.optionalString("provider"),
                        providerCode = detail.optionalString("providerCode"),
                        retryable = detail.optionalBoolean("retryable"),
                    )
                }
            } catch (_: Exception) {
                // Not the service's shape: fall through.
            }
            // A proxy, a gateway page or a backend that wraps errors its own way.
            val code = when (status) {
                401, 403 -> ServerErrorCode.Unauthorized
                404 -> ServerErrorCode.NotFound
                408 -> ServerErrorCode.Timeout
                429 -> ServerErrorCode.RateLimited
                400, 405, 409, 413, 422 -> ServerErrorCode.Validation
                503 -> ServerErrorCode.ProviderUnavailable
                504 -> ServerErrorCode.Timeout
                else -> if (status >= 500) ServerErrorCode.InternalError else ServerErrorCode.Validation
            }
            return ServerError(status, code, "HTTP $status", isStructured = false)
        }
    }
}

/** Rethrows cancellation, wraps anything else: the SDK treats an unknown failure as one that may succeed later. */
internal fun Throwable.asBackendFailure(): PurchaseBackendException = when (this) {
    is PurchaseBackendException -> this
    is CancellationException -> throw this
    else -> PurchaseBackendException.Transport(message ?: javaClass.simpleName, this)
}
