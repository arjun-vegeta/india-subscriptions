package dev.indiasubscriptions.reactnative

import com.facebook.react.bridge.Promise
import dev.indiasubscriptions.PurchaseException
import dev.indiasubscriptions.backend.PurchaseBackendException

/** The codes of the errors a call rejects with. They match `ErrorCode` in `src/errors.ts`. */
internal object Codes {
  const val NOT_CONFIGURED = "NOT_CONFIGURED"
  const val NOT_APPLICABLE = "NOT_APPLICABLE"
  const val INVALID_ARGUMENT = "INVALID_ARGUMENT"
  const val NO_ACTIVITY = "NO_ACTIVITY"
  const val BACKEND = "BACKEND"
  const val PURCHASE_IN_PROGRESS = "PURCHASE_IN_PROGRESS"
  const val NO_USABLE_OPTION = "NO_USABLE_OPTION"
  const val SESSION_NOT_OPEN = "SESSION_NOT_OPEN"
  const val INVALID_INSTRUCTION = "INVALID_INSTRUCTION"
  const val PRODUCT_NOT_FOUND = "PRODUCT_NOT_FOUND"
  const val OFFER_NOT_AVAILABLE = "OFFER_NOT_AVAILABLE"
  const val ACTIVITY_GONE = "ACTIVITY_GONE"
  const val STORAGE = "STORAGE"
  const val UNKNOWN = "UNKNOWN"
}

/** Rejects a promise with a code, a message and details, the way `IndiaSubscriptionsError` reads them. */
internal fun Promise.fail(code: String, message: String, vararg details: Pair<String, Any?>) {
  reject(code, message, Wire.details(*details))
}

/** Rejects a promise with the error the native SDK threw, translated to a code and details. */
@Suppress("REDUNDANT_ELSE_IN_WHEN")
internal fun Promise.fail(error: Throwable) {
  val message = error.message ?: error.javaClass.simpleName
  when (error) {
    is PurchaseBackendException -> when (error) {
      is PurchaseBackendException.Server -> fail(
        Codes.BACKEND, message,
        "kind" to "server",
        "serverCode" to error.error.code.value,
        "statusCode" to error.error.statusCode,
        "provider" to error.error.provider,
        "providerCode" to error.error.providerCode,
        "retryable" to error.error.retryable,
        "retryAdvice" to error.retryAdvice.name.lowercase(),
      )
      is PurchaseBackendException.Transport ->
        fail(Codes.BACKEND, message, "kind" to "transport", "retryAdvice" to error.retryAdvice.name.lowercase())
      is PurchaseBackendException.MalformedResponse -> fail(
        Codes.BACKEND, message,
        "kind" to "malformedResponse", "statusCode" to error.statusCode, "retryAdvice" to error.retryAdvice.name.lowercase(),
      )
      is PurchaseBackendException.InvalidRequest ->
        fail(Codes.BACKEND, message, "kind" to "invalidRequest", "retryAdvice" to error.retryAdvice.name.lowercase())
      else -> fail(Codes.BACKEND, message, "kind" to "unknown")
    }
    is PurchaseException -> when (error) {
      is PurchaseException.PurchaseInProgress -> fail(Codes.PURCHASE_IN_PROGRESS, message)
      is PurchaseException.NoUsableOption -> fail(Codes.NO_USABLE_OPTION, message, "sessionId" to error.sessionId)
      is PurchaseException.SessionNotOpen ->
        fail(Codes.SESSION_NOT_OPEN, message, "sessionId" to error.sessionId, "status" to error.status.value)
      is PurchaseException.InvalidInstruction -> fail(Codes.INVALID_INSTRUCTION, message)
      is PurchaseException.ProductNotFound -> fail(Codes.PRODUCT_NOT_FOUND, message, "productId" to error.productId)
      is PurchaseException.OfferNotAvailable -> fail(
        Codes.OFFER_NOT_AVAILABLE, message,
        "productId" to error.productId, "basePlanId" to error.basePlanId, "offerId" to error.offerId,
      )
      is PurchaseException.ActivityGone -> fail(Codes.ACTIVITY_GONE, message)
      is PurchaseException.Storage -> fail(Codes.STORAGE, message)
      else -> fail(Codes.UNKNOWN, message)
    }
    else -> fail(Codes.UNKNOWN, message)
  }
}
