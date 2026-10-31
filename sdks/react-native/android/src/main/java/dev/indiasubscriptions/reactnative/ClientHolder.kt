package dev.indiasubscriptions.reactnative

import dev.indiasubscriptions.PurchaseClient
import java.util.concurrent.atomic.AtomicReference

/**
 * The purchase client and the latest authorisation value, kept for the life of the process.
 *
 * A JavaScript reload creates a new module instance but must not lose the client: a purchase may be in flight, and the
 * SDK keeps its own persisted records. The holder is therefore process-wide, and a module instance only attaches to it.
 */
internal object ClientHolder {
  /** The value of the Authorization header the HTTP backend sends. Held in memory only; never written to storage. */
  val authorization = AtomicReference<String?>(null)

  private val current = AtomicReference<PurchaseClient?>(null)

  fun get(): PurchaseClient? = current.get()

  /** Installs a client and returns the one it replaced. */
  fun replace(client: PurchaseClient): PurchaseClient? = current.getAndSet(client)
}
