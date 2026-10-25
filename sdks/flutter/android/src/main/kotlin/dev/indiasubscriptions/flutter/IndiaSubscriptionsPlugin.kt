package dev.indiasubscriptions.flutter

import android.app.Activity
import android.content.Context
import android.content.Intent
import dev.indiasubscriptions.CustomTabsPageOpener
import dev.indiasubscriptions.PlaySubscriptions
import dev.indiasubscriptions.PurchaseClient
import dev.indiasubscriptions.PurchaseException
import dev.indiasubscriptions.ReturnLinkResult
import dev.indiasubscriptions.backend.HttpPurchaseBackend
import dev.indiasubscriptions.backend.PurchaseBackendException
import io.flutter.embedding.engine.plugins.FlutterPlugin
import io.flutter.embedding.engine.plugins.activity.ActivityAware
import io.flutter.embedding.engine.plugins.activity.ActivityPluginBinding
import io.flutter.plugin.common.BinaryMessenger
import io.flutter.plugin.common.PluginRegistry
import java.lang.ref.WeakReference
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

/**
 * Bridges the Android SDK to Dart. It holds no purchase logic: it builds the SDK's [PurchaseClient], forwards calls,
 * translates results (see Translation.kt), and delivers the SDK's events to the Dart streams.
 *
 * Threading: Pigeon runs every host call on the main thread, and the plugin collects the SDK's flows on the main
 * dispatcher, so every event sink is touched on the main thread, which is where Flutter requires it.
 *
 * Lifecycle: the activity is kept only between `onAttachedToActivity` and the detach callbacks, and only through a weak
 * reference. The new-intent listener is removed when the activity detaches. A second `configure` (what a hot restart
 * leads to) stops the previous client and its event collection, so no stale listener keeps running.
 */
class IndiaSubscriptionsPlugin : FlutterPlugin, ActivityAware, PurchasesHostApi {
    private var applicationContext: Context? = null
    private var messenger: BinaryMessenger? = null
    private var scope: CoroutineScope? = null

    private var activity: WeakReference<Activity>? = null
    private var activityBinding: ActivityPluginBinding? = null
    private var lastLaunchIntent: WeakReference<Intent>? = null

    private val authorization = AtomicReference<String?>(null)
    private var client: PurchaseClient? = null
    private var collecting: Job? = null

    private val events = EventDelivery<PurchaseEventMessage>()
    private val returnLinks = EventDelivery<ReturnLinkResultMessage>()

    /** Links the activity was opened with before `configure` ran (the launch intent arrives before Dart starts). */
    private val waitingLinks = ArrayList<String>()

    private val newIntentListener = PluginRegistry.NewIntentListener { intent ->
        handleLink(intent.dataString)
        false
    }

    // -- FlutterPlugin -------------------------------------------------------------------------------------------------

    override fun onAttachedToEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        applicationContext = binding.applicationContext
        messenger = binding.binaryMessenger
        scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
        PurchasesHostApi.setUp(binding.binaryMessenger, this)
        PurchaseEventsStreamHandler.register(
            binding.binaryMessenger,
            object : PurchaseEventsStreamHandler() {
                override fun onListen(p0: Any?, sink: PigeonEventSink<PurchaseEventMessage>) = events.listen(sink)

                override fun onCancel(p0: Any?) = events.cancel()
            },
        )
        ReturnLinkResultsStreamHandler.register(
            binding.binaryMessenger,
            object : ReturnLinkResultsStreamHandler() {
                override fun onListen(p0: Any?, sink: PigeonEventSink<ReturnLinkResultMessage>) = returnLinks.listen(sink)

                override fun onCancel(p0: Any?) = returnLinks.cancel()
            },
        )
    }

    override fun onDetachedFromEngine(binding: FlutterPlugin.FlutterPluginBinding) {
        PurchasesHostApi.setUp(binding.binaryMessenger, null)
        PurchaseEventsEventChannel(binding.binaryMessenger).setStreamHandler(null)
        ReturnLinkResultsEventChannel(binding.binaryMessenger).setStreamHandler(null)
        stopClient()
        scope?.cancel()
        scope = null
        events.release()
        returnLinks.release()
        waitingLinks.clear()
        applicationContext = null
        messenger = null
    }

    // -- ActivityAware -------------------------------------------------------------------------------------------------

    override fun onAttachedToActivity(binding: ActivityPluginBinding) {
        attach(binding)
        // The activity may have been opened by a return link.
        val intent = binding.activity.intent
        if (intent != null && lastLaunchIntent?.get() !== intent) {
            lastLaunchIntent = WeakReference(intent)
            handleLink(intent.dataString)
        }
    }

    override fun onReattachedToActivityForConfigChanges(binding: ActivityPluginBinding) = attach(binding)

    override fun onDetachedFromActivityForConfigChanges() = detach()

    override fun onDetachedFromActivity() = detach()

    private fun attach(binding: ActivityPluginBinding) {
        detach()
        activityBinding = binding
        activity = WeakReference(binding.activity)
        binding.addOnNewIntentListener(newIntentListener)
    }

    private fun detach() {
        activityBinding?.removeOnNewIntentListener(newIntentListener)
        activityBinding = null
        activity = null
    }

    // -- PurchasesHostApi ----------------------------------------------------------------------------------------------

    override suspend fun configure(request: ConfigureRequest) {
        if (!request.headers.isNullOrEmpty()) {
            throw unsupportedOnAndroid(
                "configure(headers)",
                "is not supported on Android: the SDK's HTTP backend sends the Authorization header only.",
            )
        }
        val context = applicationContext ?: throw notConfigured()
        stopClient()
        authorization.set(request.authorization)

        val defaults = HttpPurchaseBackend.Paths()
        val paths = request.paths?.let {
            defaults.copy(
                start = it.start ?: defaults.start,
                session = it.session ?: defaults.session,
                alternative = it.alternative ?: defaults.alternative,
                complete = it.complete ?: defaults.complete,
                entitlements = it.entitlements ?: defaults.entitlements,
            )
        } ?: defaults
        val reader: suspend () -> String? = { authorization.get() }
        val backend = request.timeoutMillis?.let {
            HttpPurchaseBackend(request.baseUrl, reader, paths, timeoutMillis = it.toInt())
        } ?: HttpPurchaseBackend(request.baseUrl, reader, paths)

        val base = PurchaseClient.Configuration()
        val configuration = base.copy(
            maxCompletionAttempts = request.maxCompletionAttempts?.toInt() ?: base.maxCompletionAttempts,
            retryDelayMillis = request.retryDelayMillis ?: base.retryDelayMillis,
            maxServerFailures = request.maxServerFailures?.toInt() ?: base.maxServerFailures,
            allowBasePlanFallback = request.allowBasePlanFallback ?: base.allowBasePlanFallback,
        )
        val created = PurchaseClient.create(
            context,
            backend,
            opener = CustomTabsPageOpener(context, allowCleartext = request.allowCleartextCheckout ?: false),
            configuration = configuration,
            enablePrepaidPlans = request.enablePrepaidPlans ?: false,
        )
        client = created
        // Collect before start() so that the events of the first pass are not missed.
        collecting = scope?.launch { created.events.collect { events.deliver(it.toMessage()) } }
        if (request.start) created.start()
        drainWaitingLinks()
    }

    override suspend fun setAuthorization(authorization: String?) {
        this.authorization.set(authorization)
    }

    override suspend fun purchase(request: PurchaseRequest): PurchaseOutcomeMessage {
        val current = client ?: throw notConfigured()
        val host = activity?.get() ?: throw PurchaseException.ActivityGone().toFlutterError()
        try {
            return current.purchase(
                activity = host,
                product = request.product,
                customerRef = request.customerRef,
                customer = request.customer.toCustomer(),
                reference = request.reference,
                returnUrl = request.returnUrl,
            ).toMessage()
        } catch (error: PurchaseBackendException) {
            throw error.toFlutterError()
        } catch (error: PurchaseException) {
            throw error.toFlutterError()
        }
    }

    override suspend fun entitlements(customerRef: String): EntitlementsMessage = backendCall {
        requireClient().entitlements(customerRef).toMessage()
    }

    override suspend fun restorePurchases(customerRef: String): EntitlementsMessage = backendCall {
        requireClient().restorePurchases(customerRef).toMessage()
    }

    override suspend fun processPendingPurchases(): List<PurchaseEventMessage> =
        requireClient().processPendingPurchases().map { it.toMessage() }

    override suspend fun retryRejectedPurchases(): List<PurchaseEventMessage> =
        requireClient().retryRejectedPurchases().map { it.toMessage() }

    override suspend fun dispose() {
        stopClient()
    }

    override suspend fun showManageSubscriptions() {
        throw unsupportedOnAndroid("showManageSubscriptions", "applies to iOS only. On Android use subscriptionManagementUrl.")
    }

    override suspend fun requestRefund(transactionId: String): String {
        throw unsupportedOnAndroid("requestRefund", "applies to iOS only. Google Play refunds go through your backend.")
    }

    override suspend fun subscriptionManagementUrl(productId: String?): String {
        val context = applicationContext ?: throw notConfigured()
        return PlaySubscriptions.managementUrl(context.packageName, productId)
    }

    override suspend fun openSubscriptionManagement(productId: String?) {
        val context = applicationContext ?: throw notConfigured()
        val host = activity?.get()
        val intent = PlaySubscriptions.managementIntent(context, productId)
        if (host != null) {
            host.startActivity(intent)
        } else {
            context.startActivity(intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        }
    }

    override suspend fun handleReturnLink(link: String): ReturnLinkResultMessage = backendCall {
        requireClient().handleReturnLink(link).toMessage()
    }

    // -- internals -----------------------------------------------------------------------------------------------------

    private fun requireClient(): PurchaseClient = client ?: throw notConfigured()

    private suspend fun <T> backendCall(call: suspend () -> T): T = try {
        call()
    } catch (error: PurchaseBackendException) {
        throw error.toFlutterError()
    }

    private fun stopClient() {
        collecting?.cancel()
        collecting = null
        client?.stop()
        client = null
    }

    /** Passes a link the activity was opened with to the SDK, or keeps it until `configure` has run. */
    private fun handleLink(link: String?) {
        if (link == null) return
        val current = client
        if (current == null) {
            if (waitingLinks.size < MAX_WAITING_LINKS) waitingLinks.add(link)
            return
        }
        scope?.launch { forward(current, link) }
    }

    private fun drainWaitingLinks() {
        val current = client ?: return
        val links = ArrayList(waitingLinks)
        waitingLinks.clear()
        for (link in links) scope?.launch { forward(current, link) }
    }

    /** Reports what a link led to on the return-link stream; a link that is not for a pending checkout is not reported. */
    private suspend fun forward(current: PurchaseClient, link: String) {
        val result = try {
            current.handleReturnLink(link)
        } catch (error: CancellationException) {
            throw error
        } catch (error: Exception) {
            return
        }
        if (result != ReturnLinkResult.Ignored) returnLinks.deliver(result.toMessage())
    }

    private companion object {
        const val MAX_WAITING_LINKS = 4
    }
}
