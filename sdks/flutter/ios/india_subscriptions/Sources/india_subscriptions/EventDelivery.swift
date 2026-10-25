import Foundation

/// Hands values to the Dart listener of one event channel, on the main thread (where Flutter requires event sinks to
/// be called).
///
/// The SDK does not replay events, and Dart can start listening after `configure` already produced some, so values
/// that arrive while nobody listens are kept (the newest `capacity`) and delivered when the listener arrives. A new
/// listener replaces the old one, which is what happens after a hot restart.
@MainActor
final class EventDelivery<Value> {
  private let capacity: Int
  private var sink: PigeonEventSink<Value>?
  private var waiting: [Value] = []

  init(capacity: Int = 64) {
    self.capacity = capacity
  }

  /// Dart started listening: delivers what waited.
  func listen(_ sink: PigeonEventSink<Value>) {
    self.sink = sink
    let backlog = waiting
    waiting.removeAll()
    for value in backlog { sink.success(value) }
  }

  /// Dart stopped listening. Later values wait for the next listener.
  func cancel() {
    sink = nil
  }

  func deliver(_ value: Value) {
    if let sink {
      sink.success(value)
    } else {
      waiting.append(value)
      if waiting.count > capacity { waiting.removeFirst(waiting.count - capacity) }
    }
  }

  /// The engine went away.
  func release() {
    sink = nil
    waiting.removeAll()
  }
}
