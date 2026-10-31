import XCTest
import IndiaSubscriptions  // not @testable: these initialisers must be usable from an app's own tests

final class PublicInitializerTests: XCTestCase {
    func testEntitlementsCanBeBuiltFromOutsideThePackage() throws {
        let item = EntitlementItem(
            product: "pro_monthly", kind: .subscription, provider: .appStore, channel: .store, platform: .ios,
            subscriptionId: "sub_1", status: .active, active: true, cancelAtPeriodEnd: false,
            currentPeriodEnd: Date(timeIntervalSince1970: 1_800_000_000), updatedAt: Date(timeIntervalSince1970: 1_795_000_000))
        let entitlements = Entitlements(customerRef: "cust_1", active: true, items: [item])
        XCTAssertTrue(entitlements.hasAccess(to: "pro_monthly"))
        XCTAssertFalse(entitlements.hasAccess(to: "other"))
        XCTAssertEqual(entitlements.activeItems, [item])
        XCTAssertNil(item.paymentId)

        // They encode and decode like the server's own values.
        let again = try JSONDecoder().decode(Entitlements.self, from: JSONEncoder().encode(entitlements))
        XCTAssertEqual(again, entitlements)
        XCTAssertTrue(Entitlements(customerRef: "c", active: false).items.isEmpty)
    }

    func testAttemptsAndSessionsCanBeBuilt() throws {
        let attempt = PurchaseAttempt(provider: .razorpay, outcome: .failed, at: Date(timeIntervalSince1970: 1_795_000_000), errorCode: "NETWORK")
        XCTAssertNil(attempt.message)
        let session = PurchaseSession(
            id: "ps_1", platform: .ios, product: "pro_monthly", policy: .store, status: .open, customerRef: "cust_1",
            options: [], attempts: [attempt], createdAt: Date(timeIntervalSince1970: 1_795_000_000),
            expiresAt: Date(timeIntervalSince1970: 1_795_003_600))
        let again = try JSONDecoder().decode(PurchaseSession.self, from: JSONEncoder().encode(session))
        XCTAssertEqual(again.attempts, [attempt])
    }
}
