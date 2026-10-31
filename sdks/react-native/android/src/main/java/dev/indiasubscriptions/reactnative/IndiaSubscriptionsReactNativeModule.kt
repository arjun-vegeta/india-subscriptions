package dev.indiasubscriptions.reactnative

import android.util.Log
import com.facebook.react.bridge.Promise
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.module.annotations.ReactModule
import dev.indiasubscriptions.CustomTabsPageOpener
import dev.indiasubscriptions.PlaySubscriptions
import dev.indiasubscriptions.PurchaseClient
import dev.indiasubscriptions.PurchaseException
import dev.indiasubscriptions.backend.HttpPurchaseBackend
import dev.indiasubscriptions.models.Customer
import java.lang.ref.WeakReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * The Android half of the bridge: translates calls into `PurchaseClient` calls and its results and events into maps.
 *
 * Threading: JavaScript calls arrive on the native-modules thread; every call that talks to the SDK runs in [scope] on
 * `Dispatchers.Default` (the SDK moves to the main thread itself where Google's billing client needs it). Events arrive
 * on whatever thread the SDK emits from and are handed to React Native's thread-safe event emitter.
 *
 * Lifecycle: [invalidate] runs when JavaScript reloads. It cancels this instance's coroutines and event collection; the
 * client itself lives on in [ClientHolder], and the next `configure` call replaces it. A purchase cancelled this way is
 * not lost: the SDK completes it from its persisted records.
 */
@ReactModule(name = IndiaSubscriptionsReactNativeModule.NAME)
class IndiaSubscriptionsReactNativeModule(private val reactContext: ReactApplicationContext) :
  NativeIndiaSubscriptionsReactNativeSpec(reactContext) {

  private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
  private val eventLock = Any()
  private var eventJob: Job? = null
  private var eventsFrom: PurchaseClient? = null

  override fun getName(): String = NAME

  override fun invalidate() {
    scope.cancel()
    super.invalidate()
  }

  // -- configuration ---------------------------------------------------------------------------------------------------

  override fun configure(options: ReadableMap, promise: Promise) {
    try {
      val baseUrl = options.string("baseUrl")
      if (baseUrl.isNullOrEmpty()) {
        return promise.fail(Codes.INVALID_ARGUMENT, "baseUrl is required")
      }
      val headers = options.map("headers")
      if (headers != null && headers.keySetIterator().hasNextKey()) {
        return promise.fail(
          Codes.UNSUPPORTED_OPTION,
          "The Android SDK's HTTP backend sends the Authorization header only; extra headers are not supported on Android",
        )
      }
      val android = options.map("android")
      val defaults = PurchaseClient.Configuration()
      val configuration = defaults.copy(
        maxCompletionAttempts = options.int("maxCompletionAttempts") ?: defaults.maxCompletionAttempts,
        retryDelayMillis = options.int("retryDelayMs")?.toLong() ?: defaults.retryDelayMillis,
        maxServerFailures = options.int("maxServerFailures") ?: defaults.maxServerFailures,
        allowBasePlanFallback = android?.bool("allowBasePlanFallback") ?: defaults.allowBasePlanFallback,
        diagnostics = { message, error -> Log.w(TAG, message, error) },
      )
      val paths = HttpPurchaseBackend.Paths().let { default ->
        val given = options.map("paths")
        HttpPurchaseBackend.Paths(
          start = given?.string("start") ?: default.start,
          session = given?.string("session") ?: default.session,
          alternative = given?.string("alternative") ?: default.alternative,
          complete = given?.string("complete") ?: default.complete,
          entitlements = given?.string("entitlements") ?: default.entitlements,
        )
      }
      // An omitted value keeps the one set earlier (a reload calls configure again before the app has a fresh token).
      if (options.hasKey("authorization")) ClientHolder.authorization.set(options.string("authorization"))
      val backend = HttpPurchaseBackend(
        baseUrl = baseUrl,
        authorization = { ClientHolder.authorization.get() },
        paths = paths,
        timeoutMillis = options.int("timeoutMs") ?: DEFAULT_TIMEOUT_MILLIS,
      )
      val applicationContext = reactContext.applicationContext
      val client = PurchaseClient.create(
        context = applicationContext,
        backend = backend,
        opener = CustomTabsPageOpener(applicationContext, allowCleartext = android?.bool("allowCleartextCheckout") ?: false),
        configuration = configuration,
        enablePrepaidPlans = android?.bool("enablePrepaidPlans") ?: false,
      )
      ClientHolder.replace(client)?.stop()
      attachEvents(client)
      promise.resolve(null)
    } catch (error: Throwable) {
      promise.fail(error)
    }
  }

  override fun setAuthorization(value: String?, promise: Promise) {
    ClientHolder.authorization.set(value)
    promise.resolve(null)
  }

  override fun start(promise: Promise) {
    val client = requireClient(promise) ?: return
    attachEvents(client)
    client.start()
    promise.resolve(null)
  }

  override fun stop(promise: Promise) {
    ClientHolder.get()?.stop()
    promise.resolve(null)
  }

  // -- purchases -------------------------------------------------------------------------------------------------------

  override fun purchase(product: String, options: ReadableMap, promise: Promise) {
    val client = requireClient(promise) ?: return
    val customerRef = options.string("customerRef")
    if (customerRef.isNullOrEmpty()) {
      return promise.fail(Codes.INVALID_ARGUMENT, "customerRef is required")
    }
    // Only a weak reference leaves this method: neither this module nor the coroutine keeps the activity alive.
    val activity = WeakReference(
      reactContext.currentActivity
        ?: return promise.fail(Codes.NO_ACTIVITY, "There is no foreground activity to start the purchase from"),
    )
    val customer = options.map("customer")?.let {
      Customer(
        id = it.string("id"), name = it.string("name"), email = it.string("email"),
        phone = it.string("phone"), state = it.string("state"),
      )
    } ?: Customer()
    attachEvents(client)
    run(promise) {
      Wire.outcome(
        client.purchase(
          activity = activity.get() ?: throw PurchaseException.ActivityGone(),
          product = product,
          customerRef = customerRef,
          customer = customer,
          reference = options.string("reference"),
          returnUrl = options.string("returnUrl"),
        ),
      )
    }
  }

  override fun processPending(promise: Promise) {
    val client = requireClient(promise) ?: return
    attachEvents(client)
    run(promise) { Wire.events(client.processPendingPurchases()) }
  }

  override fun retryRejected(promise: Promise) {
    val client = requireClient(promise) ?: return
    attachEvents(client)
    run(promise) { Wire.events(client.retryRejectedPurchases()) }
  }

  override fun restorePurchases(customerRef: String, promise: Promise) {
    val client = requireClient(promise) ?: return
    attachEvents(client)
    run(promise) { Wire.entitlements(client.restorePurchases(customerRef)) }
  }

  override fun entitlements(customerRef: String, promise: Promise) {
    val client = requireClient(promise) ?: return
    run(promise) { Wire.entitlements(client.entitlements(customerRef)) }
  }

  // -- platform-specific -----------------------------------------------------------------------------------------------

  override fun showManageSubscriptions(promise: Promise) {
    promise.fail(Codes.NOT_APPLICABLE, "showManageSubscriptions applies to iOS only", "appliesTo" to "ios")
  }

  override fun requestRefund(transactionId: String, promise: Promise) {
    promise.fail(Codes.NOT_APPLICABLE, "requestRefund applies to iOS only", "appliesTo" to "ios")
  }

  override fun subscriptionManagementUrl(productId: String?, promise: Promise) {
    promise.resolve(PlaySubscriptions.managementUrl(reactContext.packageName, productId))
  }

  override fun handleReturnLink(url: String, promise: Promise) {
    val client = requireClient(promise) ?: return
    run(promise) { Wire.returnLink(client.handleReturnLink(url)) }
  }

  // -- plumbing --------------------------------------------------------------------------------------------------------

  private fun requireClient(promise: Promise): PurchaseClient? {
    val client = ClientHolder.get()
    if (client == null) {
      promise.fail(Codes.NOT_CONFIGURED, "Call configure before any other method")
    }
    return client
  }

  /** Runs a suspend call and settles the promise with its result or its translated error. */
  private fun run(promise: Promise, block: suspend () -> Any?) {
    scope.launch {
      try {
        promise.resolve(block())
      } catch (error: CancellationException) {
        // JavaScript reloaded: nobody is waiting for the answer. The SDK finishes the purchase from its own records.
        throw error
      } catch (error: Throwable) {
        promise.fail(error)
      }
    }
  }

  /** Forwards the client's events to JavaScript. One collector per module instance and client. */
  private fun attachEvents(client: PurchaseClient) {
    synchronized(eventLock) {
      if (eventsFrom === client && eventJob?.isActive == true) return
      eventJob?.cancel()
      eventsFrom = client
      eventJob = scope.launch {
        client.events.collect { event -> emitOnPurchaseEvent(Wire.event(event)) }
      }
    }
  }

  companion object {
    const val NAME = NativeIndiaSubscriptionsReactNativeSpec.NAME
    private const val TAG = "IndiaSubscriptions"
    private const val DEFAULT_TIMEOUT_MILLIS = 30_000
  }
}

private fun ReadableMap.string(key: String): String? = if (hasKey(key) && !isNull(key)) getString(key) else null
private fun ReadableMap.map(key: String): ReadableMap? = if (hasKey(key) && !isNull(key)) getMap(key) else null
private fun ReadableMap.bool(key: String): Boolean? = if (hasKey(key) && !isNull(key)) getBoolean(key) else null
private fun ReadableMap.int(key: String): Int? = if (hasKey(key) && !isNull(key)) getDouble(key).toInt() else null
