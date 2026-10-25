import Flutter
import IndiaSubscriptions
import Testing
import UIKit

@testable import india_subscriptions

// Unit tests of the translation between the iOS SDK's types and the generated messages.

struct TranslationTests {
  private func session(status: SessionStatus = .completed) -> PurchaseSession {
    let token = UUID(uuidString: "11111111-2222-3333-4444-555555555555")!
    return PurchaseSession(
      id: "sess_1", platform: .ios, product: "pro_monthly", policy: .store, status: status, customerRef: "cust_1",
      reference: "ref-1",
      options: [
        PurchaseOption(
          channel: .store, provider: .appStore,
          checkout: .appleStoreKit(AppleStoreKitCheckout(productId: "in.example.pro", appAccountToken: token)),
          handle: token.uuidString),
        PurchaseOption(channel: .gateway, provider: "newgateway", checkout: .other(kind: "redirect"), handle: "order-1"),
      ],
      externalTransactionToken: "secret", createdAt: Date(timeIntervalSince1970: 1_700_000_000),
      expiresAt: Date(timeIntervalSince1970: 1_700_003_600), completedAt: Date(timeIntervalSince1970: 1_700_000_100),
      subscriptionId: "sub_1", paymentId: nil, provider: .appStore)
  }

  private let failure = PurchaseFailure(reason: .backendUnreachable, code: .network, message: "offline")

  @Test func sessionKeepsFieldsAndOpenValues() {
    let message = session(status: "on_hold").wire
    #expect(message.id == "sess_1")
    #expect(message.platform == "ios")
    #expect(message.status == "on_hold")
    #expect(message.createdAt == 1_700_000_000_000)
    #expect(message.completedAt == 1_700_000_100_000)
    #expect(message.provider == "app_store")
    #expect(message.options.count == 2)
    #expect(message.options[0].checkoutKind == "apple_storekit")
    #expect(message.options[0].storeProductId == "in.example.pro")
    #expect(message.options[1].checkoutKind == "redirect")
    #expect(message.options[1].storeProductId == nil)
    #expect(message.options[1].provider == "newgateway")
    #expect(!message.description.contains("secret"))
  }

  @Test func everyFailureReasonHasItsDartName() {
    let expected: [(PurchaseFailure.Reason, String)] = [
      (.backendUnreachable, "backendUnreachable"), (.backendFailing, "backendFailing"),
      (.backendRefused, "backendRefused"), (.notPaid, "notPaid"), (.notSettled, "notSettled"), (.gaveUp, "gaveUp"),
      (.tokenMismatch, "tokenMismatch"),
    ]
    for (reason, name) in expected { #expect(reason.wireName == name) }
    let message = failure.wire
    #expect(message.reason == "backendUnreachable")
    #expect(message.code == "NETWORK")
    #expect(message.message == "offline")
  }

  @Test func everyOutcomeMapsToItsKind() {
    let s = session()
    #expect(PurchaseOutcome.completed(s).wire.kind == "completed")
    #expect(PurchaseOutcome.pending(s).wire.kind == "pending")
    let cancelled = PurchaseOutcome.cancelled.wire
    #expect(cancelled.kind == "cancelled")
    #expect(cancelled.session == nil)
    let unverified = PurchaseOutcome.unverified(s, reason: "bad jws").wire
    #expect(unverified.kind == "unverified")
    #expect(unverified.reason == "bad jws")
    let awaiting = PurchaseOutcome.awaitingBackend(s, failure: failure).wire
    #expect(awaiting.kind == "awaitingBackend")
    #expect(awaiting.failure?.reason == "backendUnreachable")
    let rejected = PurchaseOutcome.rejected(s, failure: failure).wire
    #expect(rejected.kind == "rejected")
    #expect(rejected.session?.id == "sess_1")
  }

  @Test func everyEventMapsToItsKind() {
    let s = session()
    let completed = PurchaseEvent.completed(s, transactionID: 2_000_000_123).wire
    #expect(completed.kind == "completed")
    #expect(completed.transactionId == "2000000123")
    let awaiting = PurchaseEvent.awaitingBackend(sessionID: "sess_1", transactionID: 7, failure: failure).wire
    #expect(awaiting.kind == "awaitingBackend")
    #expect(awaiting.sessionId == "sess_1")
    #expect(awaiting.transactionId == "7")
    let rejected = PurchaseEvent.rejected(sessionID: "sess_1", transactionID: 8, failure: failure).wire
    #expect(rejected.kind == "rejected")
    let unmatched = PurchaseEvent.unmatchedTransaction(transactionID: 9, productID: "in.example.pro").wire
    #expect(unmatched.kind == "unmatchedPurchase")
    #expect(unmatched.productIds == ["in.example.pro"])
    let unverified = PurchaseEvent.unverifiedTransaction(transactionID: 10, reason: "bad").wire
    #expect(unverified.kind == "unverifiedTransaction")
    #expect(unverified.reason == "bad")
  }

  @Test func entitlementsKeepOpenValuesAsText() throws {
    let json = """
      {"customerRef":"cust_1","active":true,"items":[{"product":"pro_monthly","kind":"subscription",
      "provider":"app_store","channel":"store","platform":"ios","subscriptionId":"sub_1","status":"on_hold",
      "active":false,"cancelAtPeriodEnd":true,"currentPeriodEnd":"2023-12-14T22:13:20Z",
      "updatedAt":"2023-11-14T22:13:20Z"}]}
      """
    let message = try JSONDecoder().decode(Entitlements.self, from: Data(json.utf8)).wire
    #expect(message.items[0].status == "on_hold")
    #expect(message.items[0].currentPeriodEnd == 1_702_592_000_000)
    #expect(message.items[0].updatedAt == 1_700_000_000_000)
    #expect(message.items[0].cancelAtPeriodEnd == true)
    #expect(message.items[0].paymentId == nil)
  }

  @Test func refundOutcomesHaveTheirDartNames() {
    #expect(RefundRequestOutcome.submitted.wireName == "submitted")
    #expect(RefundRequestOutcome.cancelled.wireName == "cancelled")
  }

  @Test func customerMessageBecomesACustomer() {
    let customer = CustomerMessage(id: "i", name: "Asha", email: "a@example.com", phone: "9999999999", state: "Karnataka")
      .customer
    #expect(customer.name == "Asha")
    #expect(customer.state == "Karnataka")
  }

  @Test func serverErrorsKeepCodeStatusAndFlags() {
    let error = PurchaseBackendError.server(
      ServerError(statusCode: 409, code: .conflict, message: "already subscribed", provider: "app_store", providerCode: "X1", retryable: false)
    ).pigeonError
    #expect(error.code == "backend")
    let details = error.details as? [String: Sendable]
    #expect(details?["kind"] as? String == "server")
    #expect(details?["statusCode"] as? Int64 == 409)
    #expect(details?["serverCode"] as? String == "CONFLICT")
    #expect(details?["retryable"] as? Bool == false)
  }

  @Test func otherBackendFailuresKeepTheirKind() {
    func kind(_ error: PurchaseBackendError) -> String? {
      (error.pigeonError.details as? [String: Sendable])?["kind"] as? String
    }
    #expect(kind(.transport(code: -1009, description: "offline")) == "transport")
    #expect(kind(.malformedResponse(statusCode: 200, detail: "not json")) == "malformedResponse")
    #expect(kind(.invalidRequest("bad url")) == "invalidRequest")
  }

  @Test func everyPurchaseErrorHasItsDartKind() {
    let cases: [(PurchaseError, String)] = [
      (.purchaseInProgress(product: "p"), "purchaseInProgress"),
      (.noAppStoreOption(sessionID: "s"), "noStoreOption"),
      (.sessionNotOpen(sessionID: "s", status: .expired), "sessionNotOpen"),
      (.invalidInstruction("x"), "invalidInstruction"),
      (.productNotFound(productID: "p"), "productNotFound"),
      (.storeKit("failed"), "storeFailure"),
      (.storage("disk"), "storage"),
      (.unknownPurchaseResult, "unknownPurchaseResult"),
    ]
    for (error, kind) in cases {
      #expect(error.pigeonError.code == "purchase")
      #expect((error.pigeonError.details as? [String: Sendable])?["kind"] as? String == kind)
    }
  }

  @Test func platformOnlyCallsReportThePlatformPlainly() {
    let error = unsupportedOnIOS("handleReturnLink", "applies to Android only.")
    #expect(error.code == "unsupported_on_platform")
    let details = error.details as? [String: Sendable]
    #expect(details?["method"] as? String == "handleReturnLink")
    #expect(details?["platform"] as? String == "ios")
    #expect(error.message == "handleReturnLink applies to Android only.")
    #expect(notConfigured().code == "not_configured")
  }

  @Test func authorizationStoreHoldsTheLatestValue() {
    let store = AuthorizationStore()
    #expect(store.value == nil)
    store.set("Bearer a")
    store.set("Bearer b")
    #expect(store.value == "Bearer b")
    store.set(nil)
    #expect(store.value == nil)
  }

  @MainActor
  @Test func valuesThatArriveBeforeTheListenerAreKeptUpToTheCapacity() {
    let delivery = EventDelivery<Int>(capacity: 3)
    for value in 1...10 { delivery.deliver(value) }
    var received: [Int] = []
    delivery.listen(PigeonEventSink<Int> { received.append($0 as! Int) })
    delivery.deliver(11)
    #expect(received == [8, 9, 10, 11])
    delivery.cancel()
    delivery.deliver(12)
    var second: [Int] = []
    delivery.listen(PigeonEventSink<Int> { second.append($0 as! Int) })
    #expect(second == [12])
  }
}
