import Flutter
import IndiaSubscriptions
import UIKit

/// Registers the bridge with the Flutter engine. The bridge itself is `PurchaseBridge`.
public class IndiaSubscriptionsPlugin: NSObject, FlutterPlugin {
  private var bridge: PurchaseBridge?
  private var messenger: FlutterBinaryMessenger?

  public static func register(with registrar: FlutterPluginRegistrar) {
    let messenger = registrar.messenger()
    let instance = IndiaSubscriptionsPlugin()
    // Flutter registers plugins on the main thread.
    let bridge = MainActor.assumeIsolated { PurchaseBridge() }
    instance.bridge = bridge
    instance.messenger = messenger
    PurchasesHostApiSetup.setUp(binaryMessenger: messenger, api: bridge)
    PurchaseEventsStreamHandler.register(with: messenger, streamHandler: bridge.eventsHandler)
    ReturnLinkResultsStreamHandler.register(with: messenger, streamHandler: bridge.returnLinksHandler)
    registrar.publish(instance)
  }

  public func detachFromEngine(for registrar: FlutterPluginRegistrar) {
    let messenger = registrar.messenger()
    PurchasesHostApiSetup.setUp(binaryMessenger: messenger, api: nil)
    PurchaseEventsEventChannel(messenger: messenger).setStreamHandler(nil)
    ReturnLinkResultsEventChannel(messenger: messenger).setStreamHandler(nil)
    if let bridge {
      MainActor.assumeIsolated { bridge.shutdown() }
    }
    bridge = nil
  }
}

/// Bridges the iOS SDK to Dart. It holds no purchase logic: it builds the SDK's `PurchaseClient`, forwards calls,
/// translates results (see Translation.swift), and delivers the SDK's events to the Dart stream.
///
/// Threading: the generated channel code calls this class on the main actor, and the SDK's event stream is read in a
/// task that hops to the main actor before it touches the event sink, which is where Flutter requires it.
///
/// Lifecycle: a second `configure` (what a hot restart leads to) cancels the previous event task and stops the previous
/// client, so no stale listener keeps running. The engine's detach stops it too.
@MainActor
final class PurchaseBridge: PurchasesHostApi {
  private let authorization = AuthorizationStore()
  private let events = EventDelivery<PurchaseEventMessage>()
  private let returnLinks = EventDelivery<ReturnLinkResultMessage>()
  private var client: PurchaseClient?
  private var collecting: Task<Void, Never>?

  let eventsHandler: PurchaseEventsStreamHandler
  let returnLinksHandler: ReturnLinkResultsStreamHandler

  init() {
    eventsHandler = EventsHandler(delivery: events)
    returnLinksHandler = LinksHandler(delivery: returnLinks)
  }

  func shutdown() {
    stopClient()
    events.release()
    returnLinks.release()
  }

  // MARK: PurchasesHostApi

  func configure(request: ConfigureRequest) async throws {
    stopClient()
    guard let baseURL = URL(string: request.baseUrl), baseURL.scheme != nil else {
      throw PurchaseBackendError.invalidRequest("Not a valid base URL: \(request.baseUrl)").pigeonError
    }
    authorization.set(request.authorization)

    var paths = HTTPPurchaseBackend.Paths()
    if let given = request.paths {
      if let value = given.start { paths.start = value }
      if let value = given.session { paths.session = value }
      if let value = given.alternative { paths.alternative = value }
      if let value = given.complete { paths.complete = value }
      if let value = given.entitlements { paths.entitlements = value }
    }

    var urlSession = URLSession.shared
    if let headers = request.headers, !headers.isEmpty {
      let configuration = URLSessionConfiguration.default
      configuration.httpAdditionalHeaders = headers
      urlSession = URLSession(configuration: configuration)
    }

    let store = authorization
    let reader: HTTPPurchaseBackend.AuthorizationProvider = { store.value }
    let backend: HTTPPurchaseBackend
    if let timeoutMillis = request.timeoutMillis {
      backend = HTTPPurchaseBackend(
        baseURL: baseURL, authorization: reader, paths: paths, timeout: TimeInterval(timeoutMillis) / 1000,
        urlSession: urlSession)
    } else {
      backend = HTTPPurchaseBackend(baseURL: baseURL, authorization: reader, paths: paths, urlSession: urlSession)
    }

    var configuration = PurchaseClient.Configuration()
    if let value = request.maxCompletionAttempts { configuration.maxCompletionAttempts = Int(value) }
    if let value = request.retryDelayMillis { configuration.retryDelay = TimeInterval(value) / 1000 }
    if let value = request.maxServerFailures { configuration.maxServerFailures = Int(value) }
    if let value = request.finishUnmatchedTransactions { configuration.finishUnmatchedTransactions = value }

    let created = PurchaseClient(backend: backend, configuration: configuration)
    client = created
    // The stream is created (and buffering) before start(), so the events of the first pass are not missed.
    let stream = created.events
    collecting = Task { [events] in
      for await event in stream {
        events.deliver(event.wire)
      }
    }
    if request.start { await created.start() }
  }

  func setAuthorization(authorization value: String?) async throws {
    authorization.set(value)
  }

  func purchase(request: PurchaseRequest) async throws -> PurchaseOutcomeMessage {
    let current = try requireClient()
    return try await translatingErrors {
      try await current.purchase(
        product: request.product, customerRef: request.customerRef, customer: request.customer.customer,
        reference: request.reference, returnUrl: request.returnUrl.flatMap { URL(string: $0) }
      ).wire
    }
  }

  func entitlements(customerRef: String) async throws -> EntitlementsMessage {
    let current = try requireClient()
    return try await translatingErrors { try await current.entitlements(customerRef: customerRef).wire }
  }

  func restorePurchases(customerRef: String) async throws -> EntitlementsMessage {
    let current = try requireClient()
    return try await translatingErrors { try await current.restorePurchases(customerRef: customerRef).wire }
  }

  func processPendingPurchases() async throws -> [PurchaseEventMessage] {
    let current = try requireClient()
    return await current.processUnfinishedTransactions().map(\.wire)
  }

  func retryRejectedPurchases() async throws -> [PurchaseEventMessage] {
    let current = try requireClient()
    return await current.retryRejectedTransactions().map(\.wire)
  }

  func dispose() async throws {
    stopClient()
  }

  func showManageSubscriptions() async throws {
    guard let scene = Self.foregroundScene() else {
      throw PigeonError(code: ErrorCode.unexpected, message: "There is no window scene to show the sheet in.", details: nil)
    }
    try await translatingErrors { try await AppStoreSheets.showManageSubscriptions(in: scene) }
  }

  func requestRefund(transactionId: String) async throws -> String {
    guard let id = UInt64(transactionId) else {
      throw PigeonError(code: ErrorCode.unexpected, message: "Not a transaction id: \(transactionId)", details: nil)
    }
    guard let scene = Self.foregroundScene() else {
      throw PigeonError(code: ErrorCode.unexpected, message: "There is no window scene to show the sheet in.", details: nil)
    }
    return try await translatingErrors {
      try await AppStoreSheets.requestRefund(forTransaction: id, in: scene).wireName
    }
  }

  func subscriptionManagementUrl(productId: String?) async throws -> String {
    throw unsupportedOnIOS("subscriptionManagementUrl", "applies to Android only. On iOS use showManageSubscriptions.")
  }

  func openSubscriptionManagement(productId: String?) async throws {
    throw unsupportedOnIOS("openSubscriptionManagement", "applies to Android only. On iOS use showManageSubscriptions.")
  }

  func handleReturnLink(link: String) async throws -> ReturnLinkResultMessage {
    throw unsupportedOnIOS("handleReturnLink", "applies to Android only: the App Store needs no hosted checkout.")
  }

  // MARK: Internals

  private func requireClient() throws -> PurchaseClient {
    guard let client else { throw notConfigured() }
    return client
  }

  private func stopClient() {
    collecting?.cancel()
    collecting = nil
    if let client {
      Task { await client.stop() }
    }
    client = nil
  }

  private static func foregroundScene() -> UIWindowScene? {
    let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
    return scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
  }
}

/// Holds the latest `Authorization` value; the SDK's HTTP backend reads it for every request.
final class AuthorizationStore: @unchecked Sendable {
  private let lock = NSLock()
  private var current: String?

  var value: String? {
    lock.lock()
    defer { lock.unlock() }
    return current
  }

  func set(_ value: String?) {
    lock.lock()
    current = value
    lock.unlock()
  }
}

private final class EventsHandler: PurchaseEventsStreamHandler {
  private let delivery: EventDelivery<PurchaseEventMessage>

  init(delivery: EventDelivery<PurchaseEventMessage>) {
    self.delivery = delivery
  }

  override func onListen(withArguments arguments: Any?, sink: PigeonEventSink<PurchaseEventMessage>) {
    MainActor.assumeIsolated { delivery.listen(sink) }
  }

  override func onCancel(withArguments arguments: Any?) {
    MainActor.assumeIsolated { delivery.cancel() }
  }
}

private final class LinksHandler: ReturnLinkResultsStreamHandler {
  private let delivery: EventDelivery<ReturnLinkResultMessage>

  init(delivery: EventDelivery<ReturnLinkResultMessage>) {
    self.delivery = delivery
  }

  override func onListen(withArguments arguments: Any?, sink: PigeonEventSink<ReturnLinkResultMessage>) {
    MainActor.assumeIsolated { delivery.listen(sink) }
  }

  override func onCancel(withArguments arguments: Any?) {
    MainActor.assumeIsolated { delivery.cancel() }
  }
}
