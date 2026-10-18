import XCTest
@testable import IndiaSubscriptions

final class RecordStoreTests: XCTestCase {
    private func record(_ state: PurchaseRecord.State = .open) -> PurchaseRecord {
        PurchaseRecord(
            accountToken: UUID(uuidString: "6F1C2F4E-5B6A-4A52-9A43-0F2D7D7C9A10")!, sessionID: "ps_1", product: "pro_monthly",
            state: state, expiresAt: Date(timeIntervalSince1970: 1_795_430_000)
        )
    }

    func testTheTokenIsKeptInLowerCase() {
        XCTAssertEqual(record().accountToken, "6f1c2f4e-5b6a-4a52-9a43-0f2d7d7c9a10")
        XCTAssertEqual(PurchaseRecord.key(for: UUID(uuidString: "6F1C2F4E-5B6A-4A52-9A43-0F2D7D7C9A10")!), record().accountToken)
    }

    func testUserDefaultsStoreRoundTripsAcrossInstances() throws {
        let suite = "in.india-subscriptions.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }

        var saved = record(.completed)
        saved.completedTransactionIDs = [42, 43]
        saved.failedRounds = 2
        try UserDefaultsPurchaseRecordStore(defaults: defaults).save([saved, record()])

        // A new store over the same defaults is a new launch.
        let loaded = try UserDefaultsPurchaseRecordStore(defaults: defaults).load()
        XCTAssertEqual(loaded.count, 2)
        XCTAssertEqual(loaded[0].state, .completed)
        XCTAssertEqual(loaded[0].completedTransactionIDs, [42, 43])
        XCTAssertEqual(loaded[0].failedRounds, 2)
        XCTAssertEqual(loaded[0].sessionID, "ps_1")
        XCTAssertEqual(loaded[0].expiresAt.timeIntervalSince1970, saved.expiresAt.timeIntervalSince1970, accuracy: 0.001)
    }

    func testAnEmptyStoreLoadsNothing() throws {
        XCTAssertEqual(try InMemoryPurchaseRecordStore().load(), [])
        let suite = "in.india-subscriptions.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertEqual(try UserDefaultsPurchaseRecordStore(defaults: defaults).load(), [])
    }

    func testTheStoredBytesHoldNoSignedTransaction() throws {
        let suite = "in.india-subscriptions.tests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        try UserDefaultsPurchaseRecordStore(defaults: defaults, key: "k").save([record()])
        let text = String(decoding: try XCTUnwrap(defaults.data(forKey: "k")), as: UTF8.self)
        XCTAssertFalse(text.contains("signedTransaction"))
        XCTAssertFalse(text.contains("email"))
    }
}
