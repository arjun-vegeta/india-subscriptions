package dev.indiasubscriptions.flutter

import io.flutter.plugin.common.EventChannel
import kotlin.test.Test
import kotlin.test.assertEquals

internal class EventDeliveryTest {
    private class RecordingSink : EventChannel.EventSink {
        val values = ArrayList<Any?>()

        override fun success(event: Any?) {
            values += event
        }

        override fun error(errorCode: String?, errorMessage: String?, errorDetails: Any?) = Unit

        override fun endOfStream() = Unit
    }

    @Test
    fun valuesThatArriveBeforeTheListenerAreDeliveredWhenItArrives() {
        val delivery = EventDelivery<String>()
        delivery.deliver("a")
        delivery.deliver("b")
        val sink = RecordingSink()
        delivery.listen(PigeonEventSink(sink))
        delivery.deliver("c")
        assertEquals(listOf<Any?>("a", "b", "c"), sink.values)
    }

    @Test
    fun onlyTheNewestValuesWaitWhenNobodyListens() {
        val delivery = EventDelivery<Int>(capacity = 3)
        for (i in 1..10) delivery.deliver(i)
        val sink = RecordingSink()
        delivery.listen(PigeonEventSink(sink))
        assertEquals(listOf<Any?>(8, 9, 10), sink.values)
    }

    @Test
    fun aNewListenerReplacesTheOldOneAndCancelStopsDelivery() {
        val delivery = EventDelivery<String>()
        val first = RecordingSink()
        val second = RecordingSink()
        delivery.listen(PigeonEventSink(first))
        delivery.listen(PigeonEventSink(second))
        delivery.deliver("x")
        assertEquals(emptyList<Any?>(), first.values)
        assertEquals(listOf<Any?>("x"), second.values)
        delivery.cancel()
        delivery.deliver("y")
        val third = RecordingSink()
        delivery.listen(PigeonEventSink(third))
        assertEquals(listOf<Any?>("y"), third.values)
    }

    @Test
    fun releaseDropsWhatWaited() {
        val delivery = EventDelivery<String>()
        delivery.deliver("a")
        delivery.release()
        val sink = RecordingSink()
        delivery.listen(PigeonEventSink(sink))
        assertEquals(emptyList<Any?>(), sink.values)
    }
}
