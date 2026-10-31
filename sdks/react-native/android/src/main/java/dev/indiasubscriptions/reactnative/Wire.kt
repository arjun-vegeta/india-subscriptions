package dev.indiasubscriptions.reactnative

import com.facebook.react.bridge.Arguments
import com.facebook.react.bridge.WritableArray
import com.facebook.react.bridge.WritableMap
import dev.indiasubscriptions.PurchaseEvent
import dev.indiasubscriptions.PurchaseFailure
import dev.indiasubscriptions.PurchaseOutcome
import dev.indiasubscriptions.ReturnLinkResult
import dev.indiasubscriptions.billing.BillingFailure
import dev.indiasubscriptions.models.CheckoutInstruction
import dev.indiasubscriptions.models.EntitlementItem
import dev.indiasubscriptions.models.Entitlements
import dev.indiasubscriptions.models.PurchaseAttempt
import dev.indiasubscriptions.models.PurchaseOption
import dev.indiasubscriptions.models.PurchaseSession
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Translates the native SDK's results into the maps JavaScript reads (see `src/types.ts`). Nothing is decided here: a
 * value maps to its JavaScript name, and a result class this file does not know maps to its own class name, which
 * JavaScript reports as an `unknown` variant instead of failing.
 */
internal object Wire {
  /** `BACKEND_UNREACHABLE` -> `backendUnreachable`. Works for any enum constant, including ones added later. */
  fun camel(name: String): String {
    val parts = name.lowercase(Locale.ROOT).split('_').filter { it.isNotEmpty() }
    return parts.first() + parts.drop(1).joinToString("") { part -> part.replaceFirstChar { it.uppercase() } }
  }

  /** A class name as a lower-camel type tag: `AwaitingBackend` -> `awaitingBackend`. */
  private fun tag(value: Any): String =
    (value::class.simpleName ?: "unknown").replaceFirstChar { it.lowercase() }

  private fun iso(millis: Long): String {
    val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.ROOT)
    format.timeZone = TimeZone.getTimeZone("UTC")
    return format.format(Date(millis))
  }

  private fun map(vararg entries: Pair<String, Any?>): WritableMap {
    val out = Arguments.createMap()
    for ((key, value) in entries) put(out, key, value)
    return out
  }

  /** Puts a value under a key; null and unsupported values are left out. */
  fun put(out: WritableMap, key: String, value: Any?) {
    when (value) {
      null -> Unit
      is String -> out.putString(key, value)
      is Boolean -> out.putBoolean(key, value)
      is Int -> out.putInt(key, value)
      is Long -> out.putDouble(key, value.toDouble())
      is Double -> out.putDouble(key, value)
      is WritableMap -> out.putMap(key, value)
      is WritableArray -> out.putArray(key, value)
      else -> out.putString(key, value.toString())
    }
  }

  private fun strings(values: List<String>): WritableArray {
    val out = Arguments.createArray()
    for (value in values) out.pushString(value)
    return out
  }

  private fun <T> maps(values: List<T>, encode: (T) -> WritableMap): WritableArray {
    val out = Arguments.createArray()
    for (value in values) out.pushMap(encode(value))
    return out
  }

  // -- models ---------------------------------------------------------------------------------------------------------

  private fun checkout(instruction: CheckoutInstruction): WritableMap = when (instruction) {
    is CheckoutInstruction.GooglePlayBilling -> map(
      "kind" to instruction.kind,
      "productId" to instruction.productId,
      "productKind" to instruction.productKind.value,
      "basePlanId" to instruction.basePlanId,
      "offerId" to instruction.offerId,
      "userChoiceBilling" to instruction.userChoiceBilling,
    )
    else -> map("kind" to instruction.kind)
  }

  private fun option(option: PurchaseOption): WritableMap = map(
    "channel" to option.channel.value,
    "provider" to option.provider.value,
    "checkout" to checkout(option.checkout),
    "handle" to option.handle,
    "hostedUrl" to option.hostedUrl,
  )

  private fun attempt(attempt: PurchaseAttempt): WritableMap = map(
    "provider" to attempt.provider.value,
    "outcome" to attempt.outcome.value,
    "at" to iso(attempt.atMillis),
    "errorCode" to attempt.errorCode,
    "message" to attempt.message,
  )

  fun session(session: PurchaseSession): WritableMap = map(
    "id" to session.id,
    "platform" to session.platform.value,
    "product" to session.product,
    "policy" to session.policy.value,
    "status" to session.status.value,
    "customerRef" to session.customerRef,
    "reference" to session.reference,
    "returnUrl" to session.returnUrl,
    "options" to maps(session.options, ::option),
    "attempts" to maps(session.attempts, ::attempt),
    "externalTransactionToken" to session.externalTransactionToken,
    "createdAt" to iso(session.createdAtMillis),
    "expiresAt" to iso(session.expiresAtMillis),
    "completedAt" to session.completedAtMillis?.let(::iso),
    "subscriptionId" to session.subscriptionId,
    "paymentId" to session.paymentId,
    "provider" to session.provider?.value,
  )

  private fun item(item: EntitlementItem): WritableMap = map(
    "product" to item.product,
    "kind" to item.kind.value,
    "provider" to item.provider.value,
    "channel" to item.channel.value,
    "platform" to item.platform.value,
    "subscriptionId" to item.subscriptionId,
    "paymentId" to item.paymentId,
    "status" to item.status.value,
    "active" to item.active,
    "cancelAtPeriodEnd" to item.cancelAtPeriodEnd,
    "currentPeriodEnd" to item.currentPeriodEndMillis?.let(::iso),
    "updatedAt" to iso(item.updatedAtMillis),
  )

  fun entitlements(entitlements: Entitlements): WritableMap = map(
    "customerRef" to entitlements.customerRef,
    "active" to entitlements.active,
    "items" to maps(entitlements.items, ::item),
  )

  private fun failure(failure: PurchaseFailure): WritableMap = map(
    "reason" to camel(failure.reason.name),
    "code" to failure.code?.value,
    "message" to failure.message,
  )

  private fun billingFailure(failure: BillingFailure): WritableMap = map(
    "reason" to camel(failure.reason.name),
    "responseCode" to failure.responseCode,
    "subResponseCode" to failure.subResponseCode,
    "message" to failure.message,
  )

  // -- results --------------------------------------------------------------------------------------------------------

  @Suppress("REDUNDANT_ELSE_IN_WHEN")
  fun outcome(outcome: PurchaseOutcome): WritableMap = when (outcome) {
    is PurchaseOutcome.Completed -> map("type" to "completed", "session" to session(outcome.session))
    is PurchaseOutcome.Pending -> map("type" to "pending", "session" to session(outcome.session))
    is PurchaseOutcome.Cancelled -> map("type" to "cancelled", "session" to session(outcome.session))
    is PurchaseOutcome.AwaitingBackend ->
      map("type" to "awaitingBackend", "session" to session(outcome.session), "failure" to failure(outcome.failure))
    is PurchaseOutcome.Rejected ->
      map("type" to "rejected", "session" to session(outcome.session), "failure" to failure(outcome.failure))
    is PurchaseOutcome.AwaitingReturn -> map("type" to "awaitingReturn", "session" to session(outcome.session))
    is PurchaseOutcome.Failed ->
      map("type" to "failed", "session" to session(outcome.session), "failure" to billingFailure(outcome.failure))
    else -> map("type" to tag(outcome))
  }

  @Suppress("REDUNDANT_ELSE_IN_WHEN")
  fun event(event: PurchaseEvent): WritableMap = when (event) {
    is PurchaseEvent.Completed ->
      map("type" to "completed", "session" to session(event.session), "purchaseToken" to event.purchaseToken)
    is PurchaseEvent.Pending -> map("type" to "pending", "sessionId" to event.sessionId, "productIds" to strings(event.productIds))
    is PurchaseEvent.AwaitingBackend ->
      map("type" to "awaitingBackend", "sessionId" to event.sessionId, "failure" to failure(event.failure))
    is PurchaseEvent.Rejected ->
      map("type" to "rejected", "sessionId" to event.sessionId, "failure" to failure(event.failure))
    is PurchaseEvent.HostedCheckoutOpened -> map("type" to "hostedCheckoutOpened", "session" to session(event.session))
    is PurchaseEvent.UnmatchedPurchase ->
      map("type" to "unmatchedPurchase", "purchaseToken" to event.purchaseToken, "productIds" to strings(event.productIds))
    else -> map("type" to tag(event))
  }

  fun events(events: List<PurchaseEvent>): WritableMap = map("events" to maps(events, ::event))

  @Suppress("REDUNDANT_ELSE_IN_WHEN")
  fun returnLink(result: ReturnLinkResult): WritableMap = when (result) {
    is ReturnLinkResult.Ignored -> map("type" to "ignored")
    is ReturnLinkResult.Completed -> map("type" to "completed", "session" to session(result.session))
    is ReturnLinkResult.NotPaid -> map("type" to "notPaid", "session" to session(result.session))
    is ReturnLinkResult.StillPending -> map("type" to "stillPending", "session" to session(result.session))
    is ReturnLinkResult.BackendFailed -> map("type" to "backendFailed", "failure" to failure(result.failure))
    else -> map("type" to tag(result))
  }

  fun details(vararg entries: Pair<String, Any?>): WritableMap = map(*entries)
}
