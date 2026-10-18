import Foundation
import StoreKit

/// Drives the device side of an App Store purchase against the merchant's backend.
///
/// One `PurchaseClient` per app, created at launch and kept alive. It owns:
///
/// - `purchase(product:customerRef:...)`: starts a session, buys the App Store product with the session's account token,
///   sends the signed transaction to the backend and finishes the transaction once the backend confirmed it.
/// - a listener on `Transaction.updates` and a pass over `Transaction.unfinished` (`start()`), which complete the right
///   session when a purchase is approved later or the app was killed mid-purchase.
/// - `restorePurchases(customerRef:)` and `entitlements(customerRef:)`.
///
/// The SDK shows no UI. Results reach the app as a `PurchaseOutcome` (for a purchase the app started) and as
/// `PurchaseEvent`s on `events` (for everything that happens later).
public actor PurchaseClient {
    /// How the client retries and what it does with transactions it cannot place.
    public struct Configuration: Sendable {
        /// The platform sent with `start`. Always `ios` for an App Store purchase.
        public var platform: Platform = .ios
        /// Times one transaction is sent to the backend in a row before the client gives up for now (the transaction
        /// stays unfinished and is tried again later). Only failures that may succeed later are repeated.
        public var maxCompletionAttempts = 3
        /// Seconds to wait before the second attempt; doubled for each further one.
        public var retryDelay: TimeInterval = 1
        /// Rounds (one launch, one purchase, one update) that may end in a lasting-looking server failure before the
        /// client marks the transaction rejected and stops sending it. Failures to reach the backend do not count.
        public var maxServerFailures = 10
        /// When true, a transaction that no purchase record matches is finished. By default it is left unfinished, so
        /// a purchase the backend never heard of stays visible to StoreKit (and `PurchaseEvent.unmatchedTransaction`
        /// is reported once per launch).
        public var finishUnmatchedTransactions = false

        public init() {}
    }

    private let backend: any PurchaseBackend
    private let records: any PurchaseRecordStore
    private let configuration: Configuration
    private let hub = EventHub<PurchaseEvent>()

    private var listener: Task<Void, Never>?
    private var launchPass: Task<Void, Never>?
    private var purchasing: Set<String> = []
    private var inFlight: Set<UInt64> = []
    private var reportedUnmatched: Set<UInt64> = []
    private var reportedUnverified: Set<UInt64> = []

    public init(
        backend: any PurchaseBackend,
        recordStore: any PurchaseRecordStore = UserDefaultsPurchaseRecordStore(),
        configuration: Configuration = Configuration()
    ) {
        self.backend = backend
        self.records = recordStore
        self.configuration = configuration
    }

    deinit {
        listener?.cancel()
        launchPass?.cancel()
        hub.finish()
    }

    // MARK: - Events

    /// A stream of what happens to purchases outside a `purchase` call. Every call returns its own stream; subscribe
    /// before `start()` so no event is missed. Streams buffer their newest 64 events.
    public nonisolated var events: AsyncStream<PurchaseEvent> { hub.makeStream() }

    // MARK: - Transactions that arrive later

    /// Starts the listener on `Transaction.updates` and a pass over `Transaction.unfinished`. Call it once, as early as
    /// possible after launch (StoreKit's documentation asks for the listener "as soon as your app launches"). Calling it
    /// again does nothing.
    public func start() {
        guard listener == nil else { return }
        listener = Task { [weak self] in
            for await result in Transaction.updates {
                guard let self else { return }
                await self.handleIncoming(result)
            }
        }
        launchPass = Task { [weak self] in
            _ = await self?.processUnfinishedTransactions()
        }
    }

    /// Stops the listener started by `start()`.
    public func stop() {
        listener?.cancel()
        listener = nil
        launchPass?.cancel()
        launchPass = nil
    }

    /// Sends every unfinished transaction this device holds to the backend: the pass `start()` runs at launch. Call it
    /// again to retry transactions that stayed unfinished because the backend could not be reached (for example when the
    /// app returns to the foreground or the user signs in). Transactions the SDK stopped sending are skipped. The
    /// events it produced are also published on `events`.
    @discardableResult
    public func processUnfinishedTransactions() async -> [PurchaseEvent] {
        var produced: [PurchaseEvent] = []
        for await result in Transaction.unfinished {
            if Task.isCancelled { break }
            if let event = await handleIncoming(result) { produced.append(event) }
        }
        return produced
    }

    /// Clears the "refused" mark of every rejected purchase record and sends the unfinished transactions again. For when
    /// the merchant fixed the backend a refusal pointed at.
    @discardableResult
    public func retryRejectedTransactions() async -> [PurchaseEvent] {
        do {
            var all = try records.load()
            for index in all.indices where all[index].state == .rejected {
                all[index].state = .open
                all[index].failedRounds = 0
                all[index].lastErrorCode = nil
            }
            try records.save(all)
        } catch {
            return []
        }
        return await processUnfinishedTransactions()
    }

    // MARK: - Purchase

    /// Buys a product.
    ///
    /// Calls the backend's start, finds the session's App Store option, loads the `Product`, purchases it with the
    /// session's account token (and its promotional offer, when it has one) and handles StoreKit's result:
    ///
    /// - verified: the signed transaction goes to the backend's complete call and `finish()` is called only after the
    ///   backend confirmed (`.completed`). If the backend cannot be reached the transaction stays unfinished
    ///   (`.awaitingBackend`); if it refuses for good, it is marked rejected (`.rejected`).
    /// - unverified: nothing is sent (`.unverified`).
    /// - pending (Ask to Buy and similar): the session stays open (`.pending`) and completes later through the listener.
    /// - cancelled by the customer: `.cancelled`.
    ///
    /// - Parameters:
    ///   - product: your product key (the key the backend's catalog knows it by).
    ///   - customerRef: your id for the customer; entitlements are kept under it.
    ///   - reference: your own id for this purchase (at most 25 characters of letters, digits, `_` and `-`). Starting
    ///     again with the same reference and customer returns the same session.
    /// - Throws: errors of the backend's start call as thrown by the backend (`PurchaseBackendError`), and
    ///   `PurchaseError` for the rest. Nothing was charged when it throws before StoreKit's sheet.
    public func purchase(
        product key: String,
        customerRef: String,
        customer: Customer = Customer(),
        reference: String? = nil,
        returnUrl: URL? = nil
    ) async throws -> PurchaseOutcome {
        guard purchasing.insert(key).inserted else { throw PurchaseError.purchaseInProgress(product: key) }
        defer { purchasing.remove(key) }

        let session = try await backend.startPurchase(
            StartPurchaseInput(
                platform: configuration.platform, product: key, customer: customer, customerRef: customerRef,
                reference: reference, returnUrl: returnUrl
            )
        )
        if session.status == .completed { return .completed(session) }
        if session.status == .failed || session.status == .expired {
            throw PurchaseError.sessionNotOpen(sessionID: session.id, status: session.status)
        }
        guard let store = session.appStoreOption else { throw PurchaseError.noAppStoreOption(sessionID: session.id) }
        let checkout = store.checkout

        let product: Product
        do {
            guard let found = try await Product.products(for: [checkout.productId]).first else {
                throw PurchaseError.productNotFound(productID: checkout.productId)
            }
            product = found
        } catch let error as PurchaseError {
            throw error
        } catch {
            throw PurchaseError.storeKit(String(describing: error))
        }

        // Remember the token before the sheet opens: if the app dies after the payment, the next launch can find the session.
        try saveRecord(PurchaseRecord(accountToken: checkout.appAccountToken, sessionID: session.id, product: key, expiresAt: session.expiresAt))

        let result: Product.PurchaseResult
        do {
            result = try await product.purchase(options: Self.purchaseOptions(for: checkout))
        } catch StoreKitError.userCancelled {
            return .cancelled
        } catch {
            throw PurchaseError.storeKit(String(describing: error))
        }

        switch result {
        case .success(let verification):
            switch verification {
            case .verified(let transaction):
                guard transaction.appAccountToken == checkout.appAccountToken else {
                    return .rejected(
                        session,
                        failure: PurchaseFailure(reason: .tokenMismatch, message: "The transaction carries another account token than the session's")
                    )
                }
                guard inFlight.insert(transaction.id).inserted else { return .awaitingBackend(session, failure: Self.inProgress) }
                defer { inFlight.remove(transaction.id) }
                let settlement = await settle(transaction, jws: verification.jwsRepresentation, token: checkout.appAccountToken)
                return Self.outcome(of: settlement, session: session)
            case .unverified(_, let error):
                return .unverified(session, reason: String(describing: error))
            }
        case .pending:
            try? updateRecord(token: checkout.appAccountToken) { $0.state = .pending }
            return .pending(session)
        case .userCancelled:
            try? removeRecord(token: checkout.appAccountToken)
            return .cancelled
        @unknown default:
            throw PurchaseError.unknownPurchaseResult
        }
    }

    // MARK: - Restore and entitlements

    /// Asks the App Store to synchronise (`AppStore.sync()`), sends what that delivers, then returns the backend's
    /// entitlements for the customer.
    ///
    /// Call it only in response to an explicit user action such as a "Restore Purchases" button: Apple documents that
    /// `sync()` prompts the customer to sign in to the App Store. In regular operation it is not needed, because
    /// StoreKit keeps its transactions current and `start()` handles those that arrive.
    ///
    /// The backend's entitlements are the source of truth for what the customer owns. Restore deliberately does not
    /// depend on re-sending old transactions: the server checks a signed transaction's certificates against the
    /// current time and can refuse a very old one. The entitlements come from the server's own record (kept current by
    /// App Store Server Notifications), so a customer whose subscription is active sees it whether or not any
    /// transaction is sent again. Only unfinished transactions, which are recent by nature, are sent.
    public func restorePurchases(customerRef: String) async throws -> Entitlements {
        do {
            try await AppStore.sync()
        } catch {
            throw PurchaseError.storeKit(String(describing: error))
        }
        await processUnfinishedTransactions()
        return try await backend.entitlements(customerRef: customerRef)
    }

    /// The backend's entitlements for the customer: the source of truth for what they own.
    public func entitlements(customerRef: String) async throws -> Entitlements {
        try await backend.entitlements(customerRef: customerRef)
    }

    // MARK: - Settling one transaction

    private enum Settlement {
        case completed(PurchaseSession)
        /// The backend had already confirmed the transaction (or a renewal of a confirmed purchase): finished, nothing to report.
        case alreadyConfirmed
        case awaiting(PurchaseSession?, PurchaseFailure)
        case rejected(PurchaseSession?, PurchaseFailure)
    }

    private static let inProgress = PurchaseFailure(reason: .notSettled, message: "The transaction is being sent already")

    private static func outcome(of settlement: Settlement, session: PurchaseSession) -> PurchaseOutcome {
        switch settlement {
        case .completed(let confirmed): return .completed(confirmed)
        case .alreadyConfirmed: return .completed(session)
        case .awaiting(let latest, let failure): return .awaitingBackend(latest ?? session, failure: failure)
        case .rejected(let latest, let failure): return .rejected(latest ?? session, failure: failure)
        }
    }

    /// Handles a transaction from `Transaction.updates` or `Transaction.unfinished`.
    @discardableResult
    private func handleIncoming(_ result: VerificationResult<Transaction>) async -> PurchaseEvent? {
        switch result {
        case .unverified(let transaction, let error):
            guard reportedUnverified.insert(transaction.id).inserted else { return nil }
            return publish(.unverifiedTransaction(transactionID: transaction.id, reason: String(describing: error)))
        case .verified(let transaction):
            guard inFlight.insert(transaction.id).inserted else { return nil }
            defer { inFlight.remove(transaction.id) }

            guard let token = transaction.appAccountToken, let record = try? record(for: token) else {
                if configuration.finishUnmatchedTransactions {
                    await transaction.finish()
                    return nil
                }
                guard reportedUnmatched.insert(transaction.id).inserted else { return nil }
                return publish(.unmatchedTransaction(transactionID: transaction.id, productID: transaction.productID))
            }
            if record.state == .rejected { return nil }

            let settlement = await settle(transaction, jws: result.jwsRepresentation, token: token)
            switch settlement {
            case .alreadyConfirmed:
                return nil
            case .completed(let session):
                return publish(.completed(session, transactionID: transaction.id))
            case .awaiting(_, let failure):
                return publish(.awaitingBackend(sessionID: record.sessionID, transactionID: transaction.id, failure: failure))
            case .rejected(_, let failure):
                return publish(.rejected(sessionID: record.sessionID, transactionID: transaction.id, failure: failure))
            }
        }
    }


    private func publish(_ event: PurchaseEvent) -> PurchaseEvent {
        hub.publish(event)
        return event
    }

    /// Sends one verified transaction to the backend and finishes it only after the backend confirmed.
    private func settle(_ transaction: Transaction, jws: String, token: UUID) async -> Settlement {
        guard let record = try? record(for: token) else {
            return .rejected(nil, PurchaseFailure(reason: .backendRefused, message: "No purchase record for the transaction's account token"))
        }

        // Already confirmed: finishing is all that is left (the app died between the confirmation and `finish()`).
        if record.completedTransactionIDs.contains(transaction.id) {
            await transaction.finish()
            return .alreadyConfirmed
        }
        // A later transaction of a confirmed purchase (a renewal): the server learns of it from App Store Server
        // Notifications, so it is not sent again.
        if record.state == .completed {
            await transaction.finish()
            return .alreadyConfirmed
        }

        var attempt = 0
        var delay = configuration.retryDelay
        while true {
            attempt += 1
            do {
                let session = try await backend.completePurchase(sessionID: record.sessionID, input: .appStore(signedTransaction: jws))
                return await applyConfirmation(session, to: transaction, token: token)
            } catch is CancellationError {
                return .awaiting(nil, PurchaseFailure(reason: .backendUnreachable, message: "Cancelled"))
            } catch {
                let advice = Self.advice(for: error)
                let canRepeat = advice != .never && attempt < max(1, configuration.maxCompletionAttempts) && !Task.isCancelled
                if canRepeat {
                    if delay > 0 { try? await Task.sleep(nanoseconds: UInt64(delay * 1_000_000_000)) }
                    delay *= 2
                    continue
                }
                return failed(error, advice: advice, token: token)
            }
        }
    }

    private static func advice(for error: Error) -> RetryAdvice {
        (error as? PurchaseBackendError)?.retryAdvice ?? .later
    }

    private func failed(_ error: Error, advice: RetryAdvice, token: UUID) -> Settlement {
        let backendError = error as? PurchaseBackendError
        let code = backendError?.code
        let message = backendError?.errorDescription ?? String(describing: error)
        switch advice {
        case .never:
            try? updateRecord(token: token) {
                $0.state = .rejected
                $0.lastErrorCode = code?.rawValue
            }
            return .rejected(nil, PurchaseFailure(reason: .backendRefused, code: code, message: message))
        case .later:
            return .awaiting(nil, PurchaseFailure(reason: .backendUnreachable, code: code, message: message))
        case .limited:
            var gaveUp = false
            try? updateRecord(token: token) {
                $0.failedRounds += 1
                if $0.failedRounds >= configuration.maxServerFailures {
                    $0.state = .rejected
                    $0.lastErrorCode = code?.rawValue
                    gaveUp = true
                }
            }
            if gaveUp {
                return .rejected(nil, PurchaseFailure(reason: .gaveUp, code: code, message: message))
            }
            return .awaiting(nil, PurchaseFailure(reason: .backendFailing, code: code, message: message))
        }
    }

    private func applyConfirmation(_ session: PurchaseSession, to transaction: Transaction, token: UUID) async -> Settlement {
        switch session.status {
        case .completed:
            try? updateRecord(token: token) {
                $0.state = .completed
                $0.failedRounds = 0
                if !$0.completedTransactionIDs.contains(transaction.id) { $0.completedTransactionIDs.append(transaction.id) }
            }
            // Only now: the backend confirmed.
            await transaction.finish()
            return .completed(session)
        case .failed, .expired:
            let reason = session.status == .expired ? "The session expired without a payment" : "The backend says the transaction is not paid"
            try? updateRecord(token: token) { $0.state = .rejected; $0.lastErrorCode = session.status.rawValue }
            // A refunded, revoked or lapsed transaction has nothing left to deliver.
            await transaction.finish()
            return .rejected(session, PurchaseFailure(reason: .notPaid, message: reason))
        default:
            // `open`, `awaiting_payment`, or a status a newer server added: not settled yet.
            return .awaiting(session, PurchaseFailure(reason: .notSettled, message: "The session is \(session.status.rawValue)"))
        }
    }

    // MARK: - StoreKit options

    /// The purchase options of an instruction: the account token, and the promotional offer when the session has one.
    ///
    /// The server signs promotional offers in the form StoreKit's `promotionalOffer(offerID:keyID:nonce:signature:timestamp:)`
    /// takes (a Base64 DER ECDSA signature, a nonce, a timestamp). Apple deprecates that initialiser in iOS 26 in favour
    /// of a JWS-signed offer; the JWS form needs a different signature, which the checkout instruction does not carry.
    static func purchaseOptions(for checkout: AppleStoreKitCheckout) throws -> Set<Product.PurchaseOption> {
        var options: Set<Product.PurchaseOption> = [.appAccountToken(checkout.appAccountToken)]
        if let offer = checkout.promotionalOffer {
            guard let signature = Data(base64Encoded: offer.signature) else {
                throw PurchaseError.invalidInstruction("The promotional offer signature is not Base64")
            }
            options.insert(legacyPromotionalOffer(offer, signature: signature))
        }
        return options
    }

    @available(iOS, deprecated: 26.0)
    @available(macOS, deprecated: 26.0)
    private static func legacyPromotionalOffer(_ offer: PromotionalOffer, signature: Data) -> Product.PurchaseOption {
        .promotionalOffer(
            offerID: offer.offerId, keyID: offer.keyId, nonce: offer.nonce, signature: signature, timestamp: offer.timestamp
        )
    }

    // MARK: - Records

    private func record(for token: UUID) throws -> PurchaseRecord? {
        let key = PurchaseRecord.key(for: token)
        return try loadRecords().first { $0.accountToken == key }
    }

    private func loadRecords() throws -> [PurchaseRecord] {
        do { return try records.load() } catch { throw PurchaseError.storage(String(describing: error)) }
    }

    private func saveRecord(_ record: PurchaseRecord) throws {
        var all = try loadRecords()
        all.removeAll { $0.accountToken == record.accountToken }
        all.append(record)
        try writeRecords(prune(all))
    }

    private func updateRecord(token: UUID, _ change: (inout PurchaseRecord) -> Void) throws {
        var all = try loadRecords()
        let key = PurchaseRecord.key(for: token)
        guard let index = all.firstIndex(where: { $0.accountToken == key }) else { return }
        change(&all[index])
        all[index].updatedAt = Date()
        try writeRecords(all)
    }

    private func removeRecord(token: UUID) throws {
        let key = PurchaseRecord.key(for: token)
        var all = try loadRecords()
        all.removeAll { $0.accountToken == key && $0.state == .open }
        try writeRecords(all)
    }

    private func writeRecords(_ all: [PurchaseRecord]) throws {
        do { try records.save(all) } catch { throw PurchaseError.storage(String(describing: error)) }
    }

    /// Drops purchases that never got a transaction: `open` and `pending` records a week past their session's expiry.
    private func prune(_ all: [PurchaseRecord]) -> [PurchaseRecord] {
        let cutoff = Date().addingTimeInterval(-7 * 24 * 3600)
        return all.filter { !(($0.state == .open || $0.state == .pending) && $0.expiresAt < cutoff) }
    }
}
