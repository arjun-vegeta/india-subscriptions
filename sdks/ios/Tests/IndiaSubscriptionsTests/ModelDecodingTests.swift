import XCTest
@testable import IndiaSubscriptions

final class ModelDecodingTests: XCTestCase {
    func testAppStoreSessionDecodesWithItsPromotionalOffer() throws {
        let session = try decodeFixture(PurchaseSession.self, "session-app-store")
        XCTAssertEqual(session.id, "ps_3f6c1d0e8a7b4c2d9e5f1a2b3c4d5e6f")
        XCTAssertEqual(session.platform, .ios)
        XCTAssertEqual(session.policy, .store)
        XCTAssertEqual(session.status, .open)
        XCTAssertEqual(session.reference, "ref_1")
        XCTAssertEqual(session.createdAt.timeIntervalSince1970, 1_795_343_400, accuracy: 0.001)
        XCTAssertEqual(session.expiresAt.timeIntervalSince(session.createdAt), 86_400)

        let store = try XCTUnwrap(session.appStoreOption)
        XCTAssertEqual(store.option.channel, .store)
        XCTAssertEqual(store.checkout.productId, "in.example.pro.monthly")
        XCTAssertEqual(store.checkout.appAccountToken, UUID(uuidString: "6F1C2F4E-5B6A-4A52-9A43-0F2D7D7C9A10"))
        XCTAssertEqual(store.option.handle, "6f1c2f4e-5b6a-4a52-9a43-0f2d7d7c9a10")
        let offer = try XCTUnwrap(store.checkout.promotionalOffer)
        XCTAssertEqual(offer.offerId, "winback_50")
        XCTAssertEqual(offer.keyId, "ABC123DEFG")
        XCTAssertEqual(offer.timestamp, 1_795_343_400_000)
        XCTAssertEqual(offer.nonce, UUID(uuidString: "0b6b3e0e-6b4d-4a2c-8f55-2f1d3a5b7c90"))
    }

    func testCompletedSessionReadsAnOffsetTimestamp() throws {
        let session = try decodeFixture(PurchaseSession.self, "session-completed")
        XCTAssertEqual(session.status, .completed)
        XCTAssertEqual(session.provider, .appStore)
        XCTAssertEqual(session.subscriptionId, "2000000123456789")
        XCTAssertNil(session.paymentId)
        // 10:31:12+05:30 is 05:01:12Z.
        let completed = try XCTUnwrap(session.completedAt)
        XCTAssertEqual(completed.timeIntervalSince1970, ISO8601DateFormatter().date(from: "2026-11-22T05:01:12Z")!.timeIntervalSince1970)
        XCTAssertNil(session.appStoreOption?.checkout.promotionalOffer)
    }

    func testSessionFromANewerServerDecodes() throws {
        let session = try decodeFixture(PurchaseSession.self, "session-newer-server")
        XCTAssertEqual(session.platform.rawValue, "visionos")
        XCTAssertEqual(session.policy.rawValue, "bundle")
        XCTAssertEqual(session.status.rawValue, "on_hold")
        XCTAssertNotEqual(session.status, .completed)
        XCTAssertEqual(session.options.count, 3)
        XCTAssertEqual(session.options[0].channel.rawValue, "wallet")
        XCTAssertEqual(session.options[0].provider, .razorpay)
        XCTAssertEqual(session.options[0].checkout, .other(kind: "razorpay_checkout"))
        XCTAssertEqual(session.options[1].checkout.kind, "google_play_billing")
        XCTAssertEqual(session.attempts[1].outcome.rawValue, "paused")
        XCTAssertEqual(session.attempts[1].errorCode, "PROVIDER_UNAVAILABLE")
        // The App Store option has a kind this version does not know: there is no usable App Store instruction.
        XCTAssertEqual(session.options[2].checkout, .other(kind: "quantum_checkout"))
        XCTAssertNil(session.appStoreOption)
    }

    func testSessionWithoutAttemptsOrReferenceDecodes() throws {
        let json = """
        { "id": "ps_1", "platform": "ios", "product": "p", "policy": "store", "status": "open", "customerRef": "c",
          "options": [], "createdAt": "2026-11-22T10:30:00Z", "expiresAt": "2026-11-22T11:30:00Z" }
        """
        let session = try JSONDecoder().decode(PurchaseSession.self, from: Data(json.utf8))
        XCTAssertEqual(session.attempts, [])
        XCTAssertNil(session.reference)
    }

    func testAMalformedAppleInstructionStillFails() {
        let json = #"{ "kind": "apple_storekit", "productId": "p", "appAccountToken": "not-a-uuid" }"#
        XCTAssertThrowsError(try JSONDecoder().decode(CheckoutInstruction.self, from: Data(json.utf8)))
    }

    func testABadTimestampFails() {
        let json = """
        { "id": "ps_1", "platform": "ios", "product": "p", "policy": "store", "status": "open", "customerRef": "c",
          "options": [], "createdAt": "yesterday", "expiresAt": "2026-11-22T11:30:00Z" }
        """
        XCTAssertThrowsError(try JSONDecoder().decode(PurchaseSession.self, from: Data(json.utf8)))
    }

    func testEntitlementsDecodeAndAnswerAccessQuestions() throws {
        let entitlements = try decodeFixture(Entitlements.self, "entitlements")
        XCTAssertTrue(entitlements.active)
        XCTAssertEqual(entitlements.items.count, 3)
        XCTAssertEqual(entitlements.activeItems.map(\.product), ["pro_monthly"])
        XCTAssertTrue(entitlements.hasAccess(to: "pro_monthly"))
        XCTAssertFalse(entitlements.hasAccess(to: "coins_100"))

        let subscription = entitlements.items[0]
        XCTAssertEqual(subscription.kind, .subscription)
        XCTAssertEqual(subscription.provider, .appStore)
        XCTAssertEqual(subscription.channel, .store)
        XCTAssertEqual(subscription.status, .active)
        XCTAssertEqual(subscription.cancelAtPeriodEnd, false)
        XCTAssertNotNil(subscription.currentPeriodEnd)

        XCTAssertEqual(entitlements.items[1].status, .refunded)
        XCTAssertEqual(entitlements.items[1].paymentId, "pay_9")
        XCTAssertEqual(entitlements.items[2].status.rawValue, "in_dunning")
    }

    func testStartInputEncodesTheServersShape() throws {
        let input = StartPurchaseInput(
            product: "pro_monthly",
            customer: Customer(name: "Asha", email: "asha@example.com", phone: "9876543210", state: "Karnataka"),
            customerRef: "cust_1",
            reference: "ref_1"
        )
        let data = try JSONEncoder().encode(input)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(object["platform"] as? String, "ios")
        XCTAssertEqual(object["product"] as? String, "pro_monthly")
        XCTAssertEqual(object["customerRef"] as? String, "cust_1")
        XCTAssertEqual(object["reference"] as? String, "ref_1")
        XCTAssertNil(object["returnUrl"])
        let customer = try XCTUnwrap(object["customer"] as? [String: Any])
        XCTAssertEqual(customer["state"] as? String, "Karnataka")
        XCTAssertEqual(customer["phone"] as? String, "9876543210")
    }

    func testCompleteInputCarriesTheSignedTransactionAsTheResult() throws {
        let input = CompletePurchaseInput.appStore(signedTransaction: "aaa.bbb.ccc")
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(input)) as? [String: Any])
        XCTAssertEqual(object["provider"] as? String, "app_store")
        XCTAssertEqual(object["result"] as? [String: String], ["signedTransaction": "aaa.bbb.ccc"])
    }

    func testSessionRoundTrips() throws {
        let session = try decodeFixture(PurchaseSession.self, "session-app-store")
        let again = try JSONDecoder().decode(PurchaseSession.self, from: JSONEncoder().encode(session))
        XCTAssertEqual(session, again)
    }
}
