package dev.indiasubscriptions.backend

/** The `code` of an error the server answered with. Open: a code added by a newer server is kept as it is. */
@JvmInline
public value class ServerErrorCode(public val value: String) {
    public companion object {
        public val Validation: ServerErrorCode = ServerErrorCode("VALIDATION")
        public val SignatureInvalid: ServerErrorCode = ServerErrorCode("SIGNATURE_INVALID")
        public val NotFound: ServerErrorCode = ServerErrorCode("NOT_FOUND")
        public val Conflict: ServerErrorCode = ServerErrorCode("CONFLICT")
        public val Unsupported: ServerErrorCode = ServerErrorCode("UNSUPPORTED")
        public val NoRoute: ServerErrorCode = ServerErrorCode("NO_ROUTE")
        public val MethodNotAllowed: ServerErrorCode = ServerErrorCode("METHOD_NOT_ALLOWED")
        public val PayloadTooLarge: ServerErrorCode = ServerErrorCode("PAYLOAD_TOO_LARGE")

        /** The caller's credentials were refused (a missing or expired user token). */
        public val Unauthorized: ServerErrorCode = ServerErrorCode("UNAUTHORIZED")
        public val RateLimited: ServerErrorCode = ServerErrorCode("RATE_LIMITED")
        public val ProviderUnavailable: ServerErrorCode = ServerErrorCode("PROVIDER_UNAVAILABLE")
        public val Network: ServerErrorCode = ServerErrorCode("NETWORK")
        public val Timeout: ServerErrorCode = ServerErrorCode("TIMEOUT")
        public val OutcomeUnknown: ServerErrorCode = ServerErrorCode("OUTCOME_UNKNOWN")
        public val ProviderError: ServerErrorCode = ServerErrorCode("PROVIDER_ERROR")
        public val Auth: ServerErrorCode = ServerErrorCode("AUTH")
        public val UnexpectedResponse: ServerErrorCode = ServerErrorCode("UNEXPECTED_RESPONSE")
        public val Config: ServerErrorCode = ServerErrorCode("CONFIG")
        public val InternalError: ServerErrorCode = ServerErrorCode("INTERNAL_ERROR")
    }

    override fun toString(): String = value
}

/** Whether repeating a call that failed can help, as far as the SDK can tell. */
public enum class RetryAdvice {
    /** The reason will not change: the same call fails the same way. The SDK stops sending the purchase. */
    NEVER,

    /**
     * The server could not be reached or asked to wait (no network, a timeout, a rate limit, the user's token expired).
     * The SDK keeps trying, without a limit.
     */
    LATER,

    /**
     * The server answered with a failure that may be temporary or may be a lasting fault (an internal error, a Google
     * Play lookup that failed). The SDK retries it, up to `PurchaseClient.Configuration.maxServerFailures` rounds.
     */
    LIMITED,
}

/** What the server said when it refused a call, as the error body carries it. */
public data class ServerError(
    val statusCode: Int,
    val code: ServerErrorCode,
    val message: String,
    /** The gateway or store involved, where the server named one. */
    val provider: String? = null,
    /** The store's or gateway's own error code. */
    val providerCode: String? = null,
    /** The server's own `retryable` flag. */
    val retryable: Boolean? = null,
    /** False when the body was not the service's error shape (a proxy page, an empty body): `code` is derived from the status. */
    val isStructured: Boolean = true,
)

/** An error from the purchase backend. */
public sealed class PurchaseBackendException(message: String, cause: Throwable? = null) : Exception(message, cause) {
    /** The backend answered with an error. */
    public class Server(public val error: ServerError) : PurchaseBackendException("${error.code.value}: ${error.message}")

    /** The request did not get an answer (no network, a timeout, a lost connection). */
    public class Transport(description: String, cause: Throwable? = null) : PurchaseBackendException(description, cause)

    /** The backend answered 2xx with a body the SDK cannot read. */
    public class MalformedResponse(public val statusCode: Int, public val detail: String, cause: Throwable? = null) :
        PurchaseBackendException("Unreadable response ($statusCode): $detail", cause)

    /** The request could not be built (a bad base URL or path). */
    public class InvalidRequest(detail: String) : PurchaseBackendException(detail)

    /** The server's error code, when there is one. */
    public val code: ServerErrorCode? get() = (this as? Server)?.error?.code

    /** What the SDK does about this failure when it came from sending a purchase. See [RetryAdvice]. */
    public val retryAdvice: RetryAdvice
        get() = when (this) {
            is Transport -> RetryAdvice.LATER
            // A 2xx the SDK cannot read, or a request it cannot build, fails the same way next time.
            is InvalidRequest, is MalformedResponse -> RetryAdvice.NEVER
            is Server -> adviceFor(error)
        }

    internal companion object {
        fun adviceFor(error: ServerError): RetryAdvice = when (error.code) {
            ServerErrorCode.Validation, ServerErrorCode.SignatureInvalid, ServerErrorCode.NotFound,
            ServerErrorCode.Conflict, ServerErrorCode.Unsupported, ServerErrorCode.NoRoute,
            ServerErrorCode.MethodNotAllowed, ServerErrorCode.PayloadTooLarge,
            -> RetryAdvice.NEVER

            ServerErrorCode.Unauthorized, ServerErrorCode.RateLimited, ServerErrorCode.ProviderUnavailable,
            ServerErrorCode.Network, ServerErrorCode.Timeout,
            -> RetryAdvice.LATER

            ServerErrorCode.OutcomeUnknown, ServerErrorCode.ProviderError, ServerErrorCode.Auth,
            ServerErrorCode.UnexpectedResponse, ServerErrorCode.Config, ServerErrorCode.InternalError,
            -> RetryAdvice.LIMITED

            // A code from a newer server: trust its own flag, then the HTTP status.
            else -> error.retryable?.let { if (it) RetryAdvice.LIMITED else RetryAdvice.NEVER }
                ?: when (error.statusCode) {
                    401, 403, 408, 425, 429 -> RetryAdvice.LATER
                    in 500..599 -> RetryAdvice.LIMITED
                    else -> RetryAdvice.NEVER
                }
        }
    }
}
