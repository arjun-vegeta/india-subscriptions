import XCTest
@testable import IndiaSubscriptions

final class HTTPPurchaseBackendTests: XCTestCase {
    private let base = URL(string: "https://merchant.example.com/api/")!

    private func backend(
        paths: HTTPPurchaseBackend.Paths = .default,
        authorization: @escaping HTTPPurchaseBackend.AuthorizationProvider = { "Bearer user-token-1" }
    ) -> HTTPPurchaseBackend {
        HTTPPurchaseBackend(baseURL: base, authorization: authorization, paths: paths, urlSession: StubURLProtocol.makeSession())
    }

    private func ok(_ fixtureName: String) -> (StubURLProtocol.Recorded) throws -> StubURLProtocol.Reply {
        let body = try! fixture(fixtureName)
        return { _ in StubURLProtocol.Reply(status: 200, body: body) }
    }

    // MARK: Paths, methods, headers, bodies

    func testStartPostsToThePurchasesPathWithTheUsersAuthorization() async throws {
        StubURLProtocol.install(ok("session-app-store"))
        let session = try await backend().startPurchase(StartPurchaseInput(product: "pro_monthly", customerRef: "cust_1"))
        XCTAssertEqual(session.product, "pro_monthly")

        let request = try XCTUnwrap(StubURLProtocol.requests.first)
        XCTAssertEqual(request.method, "POST")
        XCTAssertEqual(request.url.absoluteString, "https://merchant.example.com/api/v1/purchases")
        XCTAssertEqual(request.headers["Authorization"], "Bearer user-token-1")
        XCTAssertEqual(request.headers["Content-Type"], "application/json")
        XCTAssertEqual(request.headers["Accept"], "application/json")
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: request.body) as? [String: Any])
        XCTAssertEqual(body["product"] as? String, "pro_monthly")
        XCTAssertEqual(body["platform"] as? String, "ios")
    }

    func testTheFiveCallsUseTheirDefaultPathsAndMethods() async throws {
        StubURLProtocol.install { request in
            let name = request.url.path.hasSuffix("cust_1") ? "entitlements" : "session-app-store"
            return StubURLProtocol.Reply(status: 200, body: try fixture(name))
        }
        let backend = backend()
        _ = try await backend.startPurchase(StartPurchaseInput(product: "p", customerRef: "c"))
        _ = try await backend.purchase(sessionID: "ps_1")
        _ = try await backend.chooseAlternative(sessionID: "ps_1", input: ChooseAlternativeInput(externalTransactionToken: "tok"))
        _ = try await backend.completePurchase(sessionID: "ps_1", input: .appStore(signedTransaction: "a.b.c"))
        _ = try await backend.entitlements(customerRef: "cust_1")

        let seen = StubURLProtocol.requests.map { "\($0.method) \($0.url.path)" }
        XCTAssertEqual(seen, [
            "POST /api/v1/purchases",
            "GET /api/v1/purchases/ps_1",
            "POST /api/v1/purchases/ps_1/alternative",
            "POST /api/v1/purchases/ps_1/complete",
            "GET /api/v1/entitlements/cust_1",
        ])
        let complete = try XCTUnwrap(JSONSerialization.jsonObject(with: StubURLProtocol.requests[3].body) as? [String: Any])
        XCTAssertEqual(complete["provider"] as? String, "app_store")
        XCTAssertEqual(complete["result"] as? [String: String], ["signedTransaction": "a.b.c"])
        XCTAssertTrue(StubURLProtocol.requests[1].body.isEmpty)
        XCTAssertNil(StubURLProtocol.requests[1].headers["Content-Type"])
    }

    func testPathsAreOverridable() async throws {
        StubURLProtocol.install(ok("session-app-store"))
        let paths = HTTPPurchaseBackend.Paths(
            start: "/billing/start", session: "billing/{sessionId}", alternative: "billing/{sessionId}/alt",
            complete: "billing/{sessionId}/done", entitlements: "me/entitlements/{customerRef}"
        )
        _ = try await backend(paths: paths).completePurchase(sessionID: "ps_9", input: .appStore(signedTransaction: "x"))
        XCTAssertEqual(StubURLProtocol.requests.first?.url.absoluteString, "https://merchant.example.com/api/billing/ps_9/done")
    }

    func testValuesInAPathAreEscaped() async throws {
        StubURLProtocol.install(ok("entitlements"))
        _ = try await backend().entitlements(customerRef: "a/b c?x=1")
        XCTAssertEqual(
            StubURLProtocol.requests.first?.url.absoluteString,
            "https://merchant.example.com/api/v1/entitlements/a%2Fb%20c%3Fx%3D1"
        )
    }

    func testABaseURLWithoutATrailingSlashWorks() async throws {
        StubURLProtocol.install(ok("session-app-store"))
        let backend = HTTPPurchaseBackend(baseURL: URL(string: "https://merchant.example.com")!, urlSession: StubURLProtocol.makeSession())
        _ = try await backend.purchase(sessionID: "ps_1")
        XCTAssertEqual(StubURLProtocol.requests.first?.url.absoluteString, "https://merchant.example.com/v1/purchases/ps_1")
        XCTAssertNil(StubURLProtocol.requests.first?.headers["Authorization"])
    }

    func testTheAuthorizationHookIsCalledForEveryRequest() async throws {
        StubURLProtocol.install(ok("session-app-store"))
        let counter = Counter()
        let backend = backend(authorization: { "Bearer t\(await counter.next())" })
        _ = try await backend.purchase(sessionID: "a")
        _ = try await backend.purchase(sessionID: "b")
        XCTAssertEqual(StubURLProtocol.requests.map { $0.headers["Authorization"] }, ["Bearer t1", "Bearer t2"])
    }

    func testAHookThatThrowsFailsTheCallWithoutSendingIt() async {
        StubURLProtocol.install(ok("session-app-store"))
        struct SignedOut: Error {}
        do {
            _ = try await backend(authorization: { throw SignedOut() }).purchase(sessionID: "a")
            XCTFail("expected a throw")
        } catch is SignedOut {
            XCTAssertTrue(StubURLProtocol.requests.isEmpty)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    // MARK: Errors

    func testAStructuredErrorCarriesTheServersCodeAndMessage() async throws {
        let body = try fixture("error-validation")
        StubURLProtocol.install { _ in StubURLProtocol.Reply(status: 400, body: body) }
        do {
            _ = try await backend().completePurchase(sessionID: "ps_1", input: .appStore(signedTransaction: "x"))
            XCTFail("expected a throw")
        } catch let error as PurchaseBackendError {
            let server = try XCTUnwrap(error.serverError)
            XCTAssertEqual(server.statusCode, 400)
            XCTAssertEqual(server.code, .validation)
            XCTAssertEqual(server.message, "Invalid purchase completion: result must carry signedTransaction")
            XCTAssertEqual(server.provider, "app_store")
            XCTAssertEqual(server.retryable, false)
            XCTAssertTrue(server.isStructured)
            XCTAssertEqual(error.retryAdvice, .never)
        }
    }

    func testAnUnavailableGatewayIsRetryableWithItsProviderCode() async throws {
        let body = try fixture("error-unavailable")
        StubURLProtocol.install { _ in StubURLProtocol.Reply(status: 503, body: body) }
        do {
            _ = try await backend().purchase(sessionID: "ps_1")
            XCTFail("expected a throw")
        } catch let error as PurchaseBackendError {
            XCTAssertEqual(error.code, .providerUnavailable)
            XCTAssertEqual(error.serverError?.providerCode, "4040003")
            XCTAssertEqual(error.retryAdvice, .later)
        }
    }

    func testAnUnstructuredBodyIsMappedFromTheStatus() async throws {
        let cases: [(Int, ServerErrorCode, RetryAdvice)] = [
            (401, .unauthorized, .later), (403, .unauthorized, .later), (404, .notFound, .never), (429, .rateLimited, .later),
            (500, .internalError, .limited), (502, .internalError, .limited), (503, .providerUnavailable, .later),
            (504, .timeout, .later), (422, .validation, .never),
        ]
        for (status, code, advice) in cases {
            StubURLProtocol.install { _ in StubURLProtocol.Reply(status: status, body: Data("<html>proxy</html>".utf8)) }
            do {
                _ = try await backend().purchase(sessionID: "ps_1")
                XCTFail("expected a throw for \(status)")
            } catch let error as PurchaseBackendError {
                XCTAssertEqual(error.code, code, "status \(status)")
                XCTAssertEqual(error.retryAdvice, advice, "status \(status)")
                XCTAssertEqual(error.serverError?.isStructured, false)
            }
        }
    }

    func testEveryKnownServerCodeHasAnAdvice() {
        let never: [ServerErrorCode] = [.validation, .signatureInvalid, .notFound, .conflict, .unsupported, .noRoute, .methodNotAllowed, .payloadTooLarge]
        let later: [ServerErrorCode] = [.unauthorized, .rateLimited, .providerUnavailable, .network, .timeout]
        let limited: [ServerErrorCode] = [.outcomeUnknown, .providerError, .auth, .unexpectedResponse, .config, .internalError]
        for (codes, advice) in [(never, RetryAdvice.never), (later, .later), (limited, .limited)] {
            for code in codes {
                let error = PurchaseBackendError.server(ServerError(statusCode: 400, code: code, message: "m", retryable: !(advice == .never)))
                XCTAssertEqual(error.retryAdvice, advice, code.rawValue)
            }
        }
    }

    func testAnUnknownCodeFollowsTheServersFlagThenTheStatus() {
        func advice(_ status: Int, _ retryable: Bool?) -> RetryAdvice {
            PurchaseBackendError.server(ServerError(statusCode: status, code: "FROM_THE_FUTURE", message: "m", retryable: retryable)).retryAdvice
        }
        XCTAssertEqual(advice(400, true), .limited)
        XCTAssertEqual(advice(503, false), .never)
        XCTAssertEqual(advice(503, nil), .limited)
        XCTAssertEqual(advice(429, nil), .later)
        XCTAssertEqual(advice(400, nil), .never)
    }

    func testANetworkFailureIsATransportErrorToRetryLater() async {
        StubURLProtocol.install { _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await backend().purchase(sessionID: "ps_1")
            XCTFail("expected a throw")
        } catch let error as PurchaseBackendError {
            guard case .transport(let code, _) = error else { return XCTFail("expected transport, got \(error)") }
            XCTAssertEqual(code, URLError.notConnectedToInternet.rawValue)
            XCTAssertEqual(error.retryAdvice, .later)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testAnUnreadableSuccessBodyIsNotRetried() async {
        StubURLProtocol.install { _ in StubURLProtocol.Reply(status: 200, body: Data(#"{"id": 3}"#.utf8)) }
        do {
            _ = try await backend().purchase(sessionID: "ps_1")
            XCTFail("expected a throw")
        } catch let error as PurchaseBackendError {
            guard case .malformedResponse(let status, _) = error else { return XCTFail("expected malformedResponse, got \(error)") }
            XCTAssertEqual(status, 200)
            XCTAssertEqual(error.retryAdvice, .never)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }

    func testAnEmptyValueForAPlaceholderIsRefusedBeforeSending() async {
        StubURLProtocol.install(ok("session-app-store"))
        do {
            _ = try await backend().purchase(sessionID: "")
            XCTFail("expected a throw")
        } catch let error as PurchaseBackendError {
            guard case .invalidRequest = error else { return XCTFail("expected invalidRequest, got \(error)") }
            XCTAssertTrue(StubURLProtocol.requests.isEmpty)
        } catch {
            XCTFail("unexpected \(error)")
        }
    }
}

private actor Counter {
    private var value = 0
    func next() -> Int {
        value += 1
        return value
    }
}
