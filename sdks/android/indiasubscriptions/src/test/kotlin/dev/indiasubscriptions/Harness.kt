package dev.indiasubscriptions

import android.app.Activity
import dev.indiasubscriptions.models.Customer
import dev.indiasubscriptions.storage.InMemoryPurchaseRecordStore
import dev.indiasubscriptions.storage.PurchaseRecord
import java.lang.ref.WeakReference
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.StandardTestDispatcher
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher

/** One client wired to fakes, on the test's virtual clock. */
@OptIn(ExperimentalCoroutinesApi::class)
class Harness(
    private val testScope: TestScope,
    val backend: FakeBackend = FakeBackend(),
    val store: InMemoryPurchaseRecordStore = InMemoryPurchaseRecordStore(),
    val opener: FakeOpener = FakeOpener(),
    configuration: PurchaseClient.Configuration = PurchaseClient.Configuration(),
    script: (FakeBillingGateway) -> Unit = {},
) {
    val diagnostics = mutableListOf<String>()
    val factory = FakeBillingFactory(script)
    val events = mutableListOf<PurchaseEvent>()

    /** Kept strongly here, as an app's own back stack would. */
    private val activity: Activity? = Activity()
    val client: PurchaseClient

    private val config = configuration.copy(diagnostics = { message, error -> diagnostics += "$message: ${error?.message}" })

    /**
     * The client's own scope. It is not the test's `backgroundScope`: `advanceUntilIdle` does not run background tasks,
     * and the client's collectors and retries must run on the virtual clock like everything else.
     */
    private val scope = CoroutineScope(SupervisorJob() + StandardTestDispatcher(testScope.testScheduler))

    init {
        client = build(factory, store)
        collectEvents(client)
        testScope.coroutineContext[kotlinx.coroutines.Job]?.invokeOnCompletion { scope.cancel() }
    }

    private fun build(factory: FakeBillingFactory, store: InMemoryPurchaseRecordStore): PurchaseClient {
        val dispatcher = StandardTestDispatcher(testScope.testScheduler)
        return PurchaseClient(
            backend,
            factory,
            store,
            opener,
            config,
            PurchaseClient.Environment(
                scope = scope,
                io = dispatcher,
                main = dispatcher,
                now = { NOW + testScope.testScheduler.currentTime },
            ),
        )
    }

    /** A second client on the same store and backend, as after the process died and the app started again. */
    fun restart(script: (FakeBillingGateway) -> Unit = {}): Pair<PurchaseClient, FakeBillingFactory> {
        val newFactory = FakeBillingFactory(script)
        val restarted = build(newFactory, store)
        collectEvents(restarted)
        return restarted to newFactory
    }

    private fun collectEvents(client: PurchaseClient) {
        scope.launch(UnconfinedTestDispatcher(testScope.testScheduler)) {
            client.events.collect { events += it }
        }
    }

    suspend fun buy(client: PurchaseClient = this.client, product: String = "pro_monthly"): PurchaseOutcome =
        client.purchase(
            host = WeakReference(activity),
            product = product,
            customerRef = "cust_1",
            customer = Customer(state = "Karnataka"),
            reference = "ref_1",
            returnUrl = RETURN_LINK,
        )

    fun records(): List<PurchaseRecord> = store.load()
}
