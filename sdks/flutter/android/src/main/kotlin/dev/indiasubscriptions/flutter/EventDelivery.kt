package dev.indiasubscriptions.flutter

/**
 * Hands values to the Dart listener of one event channel. Used on the main thread only (where Flutter requires event
 * sinks to be called).
 *
 * The SDK does not replay events, and Dart can start listening after `configure` already produced some, so values that
 * arrive while nobody listens are kept (the newest [capacity]) and delivered when the listener arrives. A new listener
 * replaces the old one, which is what happens after a hot restart.
 */
internal class EventDelivery<T : Any>(private val capacity: Int = DEFAULT_CAPACITY) {
    private var sink: PigeonEventSink<T>? = null
    private val waiting = ArrayDeque<T>()

    /** Dart started listening: delivers what waited. */
    fun listen(sink: PigeonEventSink<T>) {
        this.sink = sink
        while (waiting.isNotEmpty()) sink.success(waiting.removeFirst())
    }

    /** Dart stopped listening. Later values wait for the next listener. */
    fun cancel() {
        sink = null
    }

    fun deliver(value: T) {
        val current = sink
        if (current != null) {
            current.success(value)
        } else {
            waiting.addLast(value)
            while (waiting.size > capacity) waiting.removeFirst()
        }
    }

    /** The engine went away. */
    fun release() {
        sink = null
        waiting.clear()
    }

    internal companion object {
        const val DEFAULT_CAPACITY = 64
    }
}
