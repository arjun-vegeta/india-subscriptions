import StoreKit
import StoreKitTest
import XCTest
@testable import IndiaSubscriptions

/// The purchase flow against StoreKit Testing in Xcode (`SKTestSession`) and a fake merchant backend.
/// All tests share one StoreKit test environment, so they run one at a time.
@available(iOS 17.0, macOS 14.0, *)
final class StoreKitFlowTests: XCTestCase {
    private var storeKit: SKTestSession!
    private var backend: FakeBackend!
    private var records: InMemoryPurchaseRecordStore!
    private var clients: [PurchaseClient] = []

    override func setUp() async throws {
        let url = try XCTUnwrap(Bundle(for: StoreKitFlowTests.self).url(forResource: "Products", withExtension: "storekit"))
        storeKit = try SKTestSession(contentsOf: url)
        storeKit.resetToDefaultState()
        storeKit.clearTransactions()
        storeKit.disableDialogs = true
        storeKit.askToBuyEnabled = false
        backend = FakeBackend()
        records = InMemoryPurchaseRecordStore()
        clients = []
    }

    override func tearDown() async throws {
        for client in clients { await client.stop() }
        try await storeKit.setSimulatedError(nil, forAPI: .purchase)
        try await storeKit.setSimulatedError(nil, forAPI: .verification)
        try await storeKit.setSimulatedError(nil, forAPI: .appStoreSync)
        storeKit.clearTransactions()
        storeKit.resetToDefaultState()
        storeKit = nil
    }

    // MARK: Helpers

    private func makeClient(
        backend override: (any PurchaseBackend)? = nil, store: InMemoryPurchaseRecordStore? = nil,
        attempts: Int = 1, maxServerFailures: Int = 10
    ) -> PurchaseClient {
        var configuration = PurchaseClient.Configuration()
        configuration.maxCompletionAttempts = attempts
        configuration.retryDelay = 0
        configuration.maxServerFailures = maxServerFailures
        let client = PurchaseClient(backend: override ?? backend, recordStore: store ?? records, configuration: configuration)
        clients.append(client)
        return client
    }

    private func unfinishedIDs() async -> [UInt64] { await currentUnfinishedIDs() }

    /// The first event of the stream that matches, or a failure after the timeout.
    private func nextEvent(
        _ stream: AsyncStream<PurchaseEvent>, timeout: TimeInterval = 20, where matches: @escaping @Sendable (PurchaseEvent) -> Bool = { _ in true }
    ) async -> PurchaseEvent? {
        await withTaskGroup(of: PurchaseEvent?.self) { group in
            group.addTask {
                for await event in stream where matches(event) { return event }
                return nil
            }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return nil
            }
            let first = await group.next() ?? nil
            group.cancelAll()
            return first
        }
    }

    private func record(for session: PurchaseSession) throws -> PurchaseRecord {
        let token = try XCTUnwrap(session.appStoreOption?.checkout.appAccountToken)
        return try XCTUnwrap(try records.load().first { $0.accountToken == PurchaseRecord.key(for: token) })
    }

    // MARK: Success

    func testVerifiedPurchaseIsSentToTheBackendAndFinishedOnlyAfterItConfirmed() async throws {
        let unfinishedWhileBackendRuns = Box<[UInt64]>([])
        await backend.setOnComplete { _ in unfinishedWhileBackendRuns.value = await currentUnfinishedIDs() }
        let client = makeClient()

        let outcome = try await client.purchase(product: "pro_monthly", customerRef: "cust_1", customer: Customer(state: "Karnataka"), reference: "ref_1")

        guard case .completed(let session) = outcome else { return XCTFail("expected completed, got \(outcome)") }
        XCTAssertEqual(session.status, .completed)
        XCTAssertEqual(session.provider, .appStore)

        let start = await backend.startCalls
        XCTAssertEqual(start.count, 1)
        XCTAssertEqual(start[0].platform, .ios)
        XCTAssertEqual(start[0].product, "pro_monthly")
        XCTAssertEqual(start[0].customerRef, "cust_1")
        XCTAssertEqual(start[0].reference, "ref_1")
        XCTAssertEqual(start[0].customer.state, "Karnataka")

        // The backend got the JWS of a transaction for the right product and the session's account token.
        let sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(sent[0].sessionID, session.id)
        let claims = try XCTUnwrap(JWSClaims(sent[0].signedTransaction))
        XCTAssertEqual(claims.productId, "in.example.pro.monthly")
        XCTAssertEqual(claims.appAccountToken, session.appStoreOption?.option.handle)

        // The transaction was still unfinished while the backend was deciding, and is finished now.
        XCTAssertEqual(unfinishedWhileBackendRuns.value.count, 1)
        let remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])

        let saved = try record(for: session)
        XCTAssertEqual(saved.state, .completed)
        XCTAssertEqual(saved.completedTransactionIDs.count, 1)
    }

    func testAConsumableCanBeBoughtAgainWithANewSessionEachTime() async throws {
        let client = makeClient()
        for _ in 0..<2 {
            let outcome = try await client.purchase(product: "coins_100", customerRef: "cust_1")
            guard case .completed = outcome else { return XCTFail("expected completed, got \(outcome)") }
        }
        let starts = await backend.startCalls
        XCTAssertEqual(starts.count, 2)
        XCTAssertEqual(try records.load().count, 2)
        let remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
    }

    // MARK: Cancelled, unverified, errors

    func testCancelledPurchaseSendsNothing() async throws {
        try await storeKit.setSimulatedError(.generic(.userCancelled), forAPI: .purchase)
        let outcome = try await makeClient().purchase(product: "pro_monthly", customerRef: "cust_1")
        XCTAssertEqual(outcome, .cancelled)
        let sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 0)
        XCTAssertEqual(try records.load(), [], "the record of a cancelled purchase is dropped")
    }

    func testUnverifiedTransactionIsNeitherSentNorFinished() async throws {
        try await storeKit.setSimulatedError(.verification(.invalidSignature), forAPI: .verification)
        let outcome = try await makeClient().purchase(product: "lifetime", customerRef: "cust_1")
        guard case .unverified = outcome else { return XCTFail("expected unverified, got \(outcome)") }
        let sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 0)
        var remaining = 0
        for await _ in Transaction.unfinished { remaining += 1 }
        XCTAssertEqual(remaining, 1, "an unverified transaction stays unfinished")
    }

    func testStoreKitFailureSurfacesAsAPurchaseError() async throws {
        try await storeKit.setSimulatedError(.purchase(.purchaseNotAllowed), forAPI: .purchase)
        do {
            _ = try await makeClient().purchase(product: "pro_monthly", customerRef: "cust_1")
            XCTFail("expected a throw")
        } catch let error as PurchaseError {
            guard case .storeKit = error else { return XCTFail("unexpected \(error)") }
        }
        let sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 0)
    }

    func testAProductTheAppStoreDoesNotKnowThrows() async throws {
        await backend.setCatalog("ghost", "in.example.ghost")
        do {
            _ = try await makeClient().purchase(product: "ghost", customerRef: "cust_1")
            XCTFail("expected a throw")
        } catch let error as PurchaseError {
            XCTAssertEqual(error, .productNotFound(productID: "in.example.ghost"))
        }
    }

    func testAStartRefusedByTheBackendThrowsItsError() async throws {
        do {
            _ = try await makeClient().purchase(product: "no_such_product", customerRef: "cust_1")
            XCTFail("expected a throw")
        } catch let error as PurchaseBackendError {
            XCTAssertEqual(error.code, .notFound)
        }
        XCTAssertEqual(try records.load(), [])
    }

    func testPromotionalOfferBecomesAStoreKitOptionAndABadSignatureIsRefused() throws {
        let token = UUID()
        let plain = AppleStoreKitCheckout(productId: "p", appAccountToken: token)
        XCTAssertEqual(try PurchaseClient.purchaseOptions(for: plain).count, 1)

        let offer = PromotionalOffer(
            offerId: "winback_50", keyId: "ABC123DEFG", nonce: UUID(), timestamp: 1_795_343_400_000,
            signature: Data("signature".utf8).base64EncodedString()
        )
        let withOffer = AppleStoreKitCheckout(productId: "p", appAccountToken: token, promotionalOffer: offer)
        XCTAssertEqual(try PurchaseClient.purchaseOptions(for: withOffer).count, 2)

        var broken = offer
        broken.signature = "%%% not base64 %%%"
        XCTAssertThrowsError(
            try PurchaseClient.purchaseOptions(for: AppleStoreKitCheckout(productId: "p", appAccountToken: token, promotionalOffer: broken))
        ) { error in
            guard case PurchaseError.invalidInstruction = error else { return XCTFail("unexpected \(error)") }
        }
    }

    // MARK: Ask to Buy

    func testAskToBuyStaysOpenAndCompletesWhenApprovedLater() async throws {
        storeKit.askToBuyEnabled = true
        let client = makeClient()
        let events = client.events
        await client.start()

        let outcome = try await client.purchase(product: "pro_monthly", customerRef: "cust_1")
        guard case .pending(let session) = outcome else { return XCTFail("expected pending, got \(outcome)") }
        XCTAssertEqual(session.status, .open)
        var sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 0, "nothing is sent while the purchase waits for approval")
        XCTAssertEqual(try record(for: session).state, .pending)

        let waiting = try XCTUnwrap(storeKit.allTransactions().first { $0.pendingAskToBuyConfirmation })
        try storeKit.approveAskToBuyTransaction(identifier: waiting.identifier)

        let event = await nextEvent(events) { if case .completed = $0 { return true } else { return false } }
        guard case .completed(let done, let transactionID)? = event else { return XCTFail("no completion arrived: \(String(describing: event))") }
        XCTAssertEqual(done.id, session.id)
        XCTAssertEqual(transactionID, UInt64(waiting.identifier))
        sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 1)
        XCTAssertEqual(JWSClaims(sent[0].signedTransaction)?.appAccountToken, session.appStoreOption?.option.handle)
        let remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
        XCTAssertEqual(try record(for: session).state, .completed)
    }

    // MARK: Backend failures and retries

    func testBackendDownKeepsTheTransactionUnfinishedAndALaterPassCompletesIt() async throws {
        await backend.setCompleteAlwaysFails(PurchaseBackendError.transport(code: URLError.notConnectedToInternet.rawValue, description: "offline"))
        let client = makeClient(attempts: 3)

        let outcome = try await client.purchase(product: "pro_monthly", customerRef: "cust_1")
        guard case .awaitingBackend(let session, let failure) = outcome else { return XCTFail("expected awaitingBackend, got \(outcome)") }
        XCTAssertEqual(failure.reason, .backendUnreachable)
        var sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 3, "an unreachable backend is tried maxCompletionAttempts times in a row")
        var remaining = await unfinishedIDs()
        XCTAssertEqual(remaining.count, 1)
        XCTAssertEqual(try record(for: session).state, .open)

        // The backend is back.
        await backend.setCompleteAlwaysFails(nil)
        let events = client.events
        let produced = await client.processUnfinishedTransactions()
        guard case .completed(let done, _)? = produced.first else { return XCTFail("expected completed, got \(produced)") }
        XCTAssertEqual(done.id, session.id)
        let streamed = await nextEvent(events, timeout: 5) { if case .completed = $0 { return true } else { return false } }
        XCTAssertNotNil(streamed, "the completion is also published on the event stream")
        sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 4)
        remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
        XCTAssertEqual(try record(for: session).state, .completed)
    }

    func testAFailureThatMayPassIsRepeatedWithinThePurchase() async throws {
        await backend.setCompleteFailures([
            PurchaseBackendError.server(ServerError(statusCode: 503, code: .providerUnavailable, message: "down")),
            PurchaseBackendError.transport(code: URLError.timedOut.rawValue, description: "timed out"),
        ])
        let outcome = try await makeClient(attempts: 3).purchase(product: "pro_monthly", customerRef: "cust_1")
        guard case .completed = outcome else { return XCTFail("expected completed, got \(outcome)") }
        let sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 3)
    }

    func testARefusalThatWillNeverChangeIsNotRetriedUntilAskedTo() async throws {
        await backend.setCompleteAlwaysFails(
            PurchaseBackendError.server(ServerError(statusCode: 400, code: .validation, message: "bundle id mismatch"))
        )
        let client = makeClient(attempts: 3)

        let outcome = try await client.purchase(product: "pro_monthly", customerRef: "cust_1")
        guard case .rejected(let session, let failure) = outcome else { return XCTFail("expected rejected, got \(outcome)") }
        XCTAssertEqual(failure.reason, .backendRefused)
        XCTAssertEqual(failure.code, .validation)
        var sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 1, "a refusal is not repeated within the purchase")
        XCTAssertEqual(try record(for: session).state, .rejected)
        XCTAssertEqual(try record(for: session).lastErrorCode, "VALIDATION")

        // Later passes skip it: no call, no event.
        for _ in 0..<3 {
            let produced = await client.processUnfinishedTransactions()
            XCTAssertEqual(produced, [])
        }
        sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 1)
        var remaining = await unfinishedIDs()
        XCTAssertEqual(remaining.count, 1, "the transaction is kept for support, not finished")

        // The merchant fixed the backend: retrying on request completes it.
        await backend.setCompleteAlwaysFails(nil)
        let produced = await client.retryRejectedTransactions()
        guard case .completed? = produced.first else { return XCTFail("expected completed, got \(produced)") }
        remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
    }

    func testALastingLookingServerFailureIsRetriedOnlyUpToTheLimit() async throws {
        await backend.setCompleteAlwaysFails(
            PurchaseBackendError.server(ServerError(statusCode: 500, code: .internalError, message: "boom"))
        )
        let client = makeClient(maxServerFailures: 3)

        guard case .awaitingBackend(_, let first) = try await client.purchase(product: "pro_monthly", customerRef: "cust_1") else {
            return XCTFail("expected awaitingBackend")
        }
        XCTAssertEqual(first.reason, .backendFailing)

        var produced = await client.processUnfinishedTransactions()
        guard case .awaitingBackend(_, _, let second)? = produced.first else { return XCTFail("expected awaitingBackend, got \(produced)") }
        XCTAssertEqual(second.reason, .backendFailing)

        produced = await client.processUnfinishedTransactions()
        guard case .rejected(_, _, let third)? = produced.first else { return XCTFail("expected rejected, got \(produced)") }
        XCTAssertEqual(third.reason, .gaveUp)

        produced = await client.processUnfinishedTransactions()
        XCTAssertEqual(produced, [])
        let sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 3)
    }

    func testASessionThatIsNotSettledYetKeepsTheTransactionUnfinished() async throws {
        await backend.setSettleStatus(.awaitingPayment)
        let client = makeClient()
        let outcome = try await client.purchase(product: "pro_monthly", customerRef: "cust_1")
        guard case .awaitingBackend(let session, let failure) = outcome else { return XCTFail("expected awaitingBackend, got \(outcome)") }
        XCTAssertEqual(failure.reason, .notSettled)
        XCTAssertEqual(session.status, .awaitingPayment)
        var remaining = await unfinishedIDs()
        XCTAssertEqual(remaining.count, 1)

        await backend.setSettleStatus(.completed)
        let produced = await client.processUnfinishedTransactions()
        guard case .completed? = produced.first else { return XCTFail("expected completed, got \(produced)") }
        remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
    }

    func testATransactionTheBackendSaysIsNotPaidIsRejectedAndFinished() async throws {
        await backend.setSettleStatus(.failed)
        let outcome = try await makeClient().purchase(product: "pro_monthly", customerRef: "cust_1")
        guard case .rejected(_, let failure) = outcome else { return XCTFail("expected rejected, got \(outcome)") }
        XCTAssertEqual(failure.reason, .notPaid)
        let remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
    }

    // MARK: Interrupted purchase, next launch

    func testAPurchaseInterruptedMidwayIsFinishedAtTheNextLaunch() async throws {
        // First launch: StoreKit takes the payment, then the app is killed while the backend call is in flight.
        let reached = Box(false)
        await backend.setOnComplete { _ in
            reached.value = true
            // Hang until the task is cancelled: the process "dies" here.
            try await Task.sleep(nanoseconds: 60 * 1_000_000_000)
        }
        let first = makeClient()
        let launch1 = Task { try await first.purchase(product: "pro_monthly", customerRef: "cust_1") }
        for _ in 0..<400 where !reached.value { try await Task.sleep(nanoseconds: 50_000_000) }
        XCTAssertTrue(reached.value, "the purchase never reached the backend")
        launch1.cancel()
        _ = try? await launch1.value
        await first.stop()

        var remaining = await unfinishedIDs()
        XCTAssertEqual(remaining.count, 1, "the paid transaction is waiting")
        let before = await backend.completeCalls.count
        let allSessions = await backend.sessions
        let session = try XCTUnwrap(allSessions.values.first)
        XCTAssertNotEqual(try record(for: session).state, .completed)

        // Second launch: a new client over the same persisted records, a backend that answers.
        await backend.setOnComplete(nil)
        let second = makeClient()
        let events = second.events
        await second.start()

        let event = await nextEvent(events) { if case .completed = $0 { return true } else { return false } }
        guard case .completed(let done, _)? = event else { return XCTFail("no completion arrived: \(String(describing: event))") }
        XCTAssertEqual(done.id, session.id)
        let after = await backend.completeCalls.count
        XCTAssertEqual(after, before + 1)
        remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
        XCTAssertEqual(try record(for: session).state, .completed)
    }

    func testARecordWithoutAnAnswerFromTheStoreIsKeptAcrossLaunches() async throws {
        let session = try await backend.startPurchase(StartPurchaseInput(product: "pro_monthly", customerRef: "cust_1"))
        let token = try XCTUnwrap(session.appStoreOption?.checkout.appAccountToken)
        try records.save([PurchaseRecord(accountToken: token, sessionID: session.id, product: "pro_monthly", expiresAt: session.expiresAt)])
        // The app was killed after StoreKit's sheet; the transaction exists outside the app's own flow.
        _ = try await storeKit.buyProduct(identifier: "in.example.pro.monthly", options: [.appAccountToken(token)])

        let client = makeClient()
        let produced = await client.processUnfinishedTransactions()
        guard case .completed(let done, _)? = produced.first else { return XCTFail("expected completed, got \(produced)") }
        XCTAssertEqual(done.id, session.id)
    }

    // MARK: Transactions this device cannot place

    func testATransactionWithoutAMatchingRecordIsReportedOnceAndLeftUnfinished() async throws {
        let transaction = try await storeKit.buyProduct(identifier: "in.example.lifetime")
        let client = makeClient()

        var produced = await client.processUnfinishedTransactions()
        XCTAssertEqual(produced, [.unmatchedTransaction(transactionID: transaction.id, productID: "in.example.lifetime")])
        produced = await client.processUnfinishedTransactions()
        XCTAssertEqual(produced, [], "reported once per launch")
        let sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 0)
        let remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [transaction.id])
    }

    func testUnmatchedTransactionsCanBeFinishedByConfiguration() async throws {
        _ = try await storeKit.buyProduct(identifier: "in.example.lifetime")
        var configuration = PurchaseClient.Configuration()
        configuration.finishUnmatchedTransactions = true
        let client = PurchaseClient(backend: backend, recordStore: records, configuration: configuration)
        clients.append(client)
        let produced = await client.processUnfinishedTransactions()
        XCTAssertEqual(produced, [])
        let remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
    }

    func testARenewalOfAConfirmedSubscriptionIsFinishedWithoutBeingSentAgain() async throws {
        let client = makeClient()
        guard case .completed = try await client.purchase(product: "pro_monthly", customerRef: "cust_1") else {
            return XCTFail("expected completed")
        }
        let before = await backend.completeCalls.count

        try storeKit.forceRenewalOfSubscription(productIdentifier: "in.example.pro.monthly")
        var remaining: [UInt64] = []
        // The renewal is an unfinished transaction of the same token.
        for _ in 0..<20 {
            remaining = await unfinishedIDs()
            if !remaining.isEmpty { break }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        XCTAssertEqual(remaining.count, 1, "StoreKit created the renewal")
        let produced = await client.processUnfinishedTransactions()
        XCTAssertEqual(produced, [])
        let after = await backend.completeCalls.count
        XCTAssertEqual(after, before, "the server learns of renewals from App Store Server Notifications")
        remaining = await unfinishedIDs()
        XCTAssertEqual(remaining, [])
    }

    // MARK: Restore

    func testRestoreSyncsWithTheAppStoreThenReturnsTheBackendsEntitlements() async throws {
        let entitlements = try decodeEntitlements()
        await backend.setEntitlements(entitlements)
        let restored = try await makeClient().restorePurchases(customerRef: "cust_1")
        XCTAssertEqual(restored, entitlements)
        XCTAssertTrue(restored.hasAccess(to: "pro_monthly"))
        let sent = await backend.completeCalls
        XCTAssertEqual(sent.count, 0, "restore does not re-send old transactions")
    }

    func testRestoreSurfacesAStoreKitFailure() async throws {
        try await storeKit.setSimulatedError(.generic(.networkError(URLError(.notConnectedToInternet))), forAPI: .appStoreSync)
        do {
            _ = try await makeClient().restorePurchases(customerRef: "cust_1")
            XCTFail("expected a throw")
        } catch let error as PurchaseError {
            guard case .storeKit = error else { return XCTFail("unexpected \(error)") }
        }
    }

    private func decodeEntitlements() throws -> Entitlements {
        let json = """
        { "customerRef": "cust_1", "active": true, "items": [
          { "product": "pro_monthly", "kind": "subscription", "provider": "app_store", "channel": "store", "platform": "ios",
            "subscriptionId": "2000000123456789", "status": "active", "active": true, "updatedAt": "2026-11-22T10:30:00.000Z" } ] }
        """
        return try JSONDecoder().decode(Entitlements.self, from: Data(json.utf8))
    }
}

/// A mutable box a `@Sendable` closure can write to in a test.
final class Box<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: Value
    init(_ value: Value) { stored = value }
    var value: Value {
        get { lock.lock(); defer { lock.unlock() }; return stored }
        set { lock.lock(); defer { lock.unlock() }; stored = newValue }
    }
}

/// The ids of the verified transactions StoreKit still lists as unfinished.
func currentUnfinishedIDs() async -> [UInt64] {
    var ids: [UInt64] = []
    for await result in Transaction.unfinished {
        if case .verified(let transaction) = result { ids.append(transaction.id) }
    }
    return ids
}
