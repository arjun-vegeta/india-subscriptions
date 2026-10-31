# IndiaSubscriptions for iOS

A Swift package that drives the device side of a purchase for the `india-subscriptions` service: it buys an App Store
product with StoreKit 2, hands the signed transaction to your backend, and finishes the transaction once your backend
confirmed it. It has no UI, no analytics and no third-party dependencies.

- iOS 15 and later (it also builds for macOS 12 and later so its logic can be tested from the command line)
- Swift concurrency throughout; the package compiles in the Swift 6 language mode
- StoreKit 2 only

## How the pieces fit

```
 your app  ──(user's auth header)──▶  your backend  ──(service API key)──▶  india-subscriptions service
 IndiaSubscriptions                   authenticates the user,               verifies the signed transaction
                                      forwards five calls                   with Apple, keeps entitlements
```

**The app never holds the service's API key.** The SDK talks to your own backend with the signed-in user's
authorisation. Your backend forwards five calls to the service (or calls `subs.purchases` in-process).

## Installation

Swift Package Manager. In Xcode, File > Add Package Dependencies and add this package from the repository's `sdks/ios`
directory (or, in a `Package.swift`):

```swift
.package(path: "../path/to/india-subscriptions/sdks/ios"),
// ...
.target(name: "MyApp", dependencies: [.product(name: "IndiaSubscriptions", package: "ios")]),
```

From this repository's URL, which has a `Package.swift` at its root exposing the same `IndiaSubscriptions` library (the
sources are the ones in `sdks/ios`; `sdks/ios/Package.swift` stays for development by path and for the package's own tests):

```swift
.package(url: "https://example.com/path/to/india-subscriptions.git", from: "0.1.0"),   // this repository's URL
// ...
.target(name: "MyApp", dependencies: [.product(name: "IndiaSubscriptions", package: "india-subscriptions")]),
```

The package name in `package:` is the repository's name (the last component of the URL).

Add the **In-App Purchase** capability to the app target.

## The backend it expects

`HTTPPurchaseBackend` sends these calls to `baseURL`, with `Authorization` set from your hook, `Accept:
application/json` and, for a body, `Content-Type: application/json`. The paths are the service's own routes and each
is overridable (`HTTPPurchaseBackend.Paths`).

| Call | Default path | Body | Answer |
|---|---|---|---|
| start | `POST v1/purchases` | `StartPurchaseInput` (`platform`, `product`, `customer`, `customerRef`, `reference?`, `returnUrl?`) | `PurchaseSession` |
| get | `GET v1/purchases/{sessionId}` | | `PurchaseSession` |
| alternative | `POST v1/purchases/{sessionId}/alternative` | `{ "externalTransactionToken" }` | `PurchaseSession` |
| complete | `POST v1/purchases/{sessionId}/complete` | `{ "provider": "app_store", "result": { "signedTransaction": "<JWS>" } }` | `PurchaseSession` |
| entitlements | `GET v1/entitlements/{customerRef}` | | `Entitlements` |

The SDK itself uses start, complete and entitlements on iPhone. `get` and `alternative` are part of the contract so that
`PurchaseBackend` is complete; `alternative` belongs to Google Play's user choice billing.

Your backend must:

- authenticate the user and decide which `customerRef` they may buy for (never trust the one in the request body);
- forward the calls to the service with its API key and return the service's JSON and status code unchanged;
- answer errors in the service's shape, `{ "error": { "code", "message", "provider?", "providerCode?", "retryable" } }`.
  The SDK reads `code` to decide whether to retry (see "Failures and retries");
- receive App Store Server Notifications V2 at the service's webhook route, so renewals, cancellations and refunds reach
  the entitlements. The device does not report renewals.

Times in every body are ISO-8601 strings; the models decode them to `Date`. Enumerations (`status`, `platform`,
`policy`, `channel`, `provider`, and so on) are open: a value a newer server adds decodes instead of failing. Checkout
instructions of kinds other than `apple_storekit` decode as `CheckoutInstruction.other(kind:)`.

## Usage

```swift
import IndiaSubscriptions
import StoreKit

@main
struct MyApp: App {
    let purchases: PurchaseClient

    init() {
        let backend = HTTPPurchaseBackend(
            baseURL: URL(string: "https://api.example.com/billing/")!,
            authorization: { await Auth.shared.freshBearerToken().map { "Bearer \($0)" } }   // the user's own token
        )
        purchases = PurchaseClient(backend: backend)
        Task { await purchases.start() }          // listener on Transaction.updates + pass over unfinished transactions
    }

    var body: some Scene {
        WindowGroup { ContentView(purchases: purchases) }
    }
}

struct ContentView: View {
    let purchases: PurchaseClient
    @State private var message = ""

    var body: some View {
        VStack {
            Button("Subscribe") { Task { await buy() } }
            Button("Restore purchases") { Task { await restore() } }
            Text(message)
        }
        .task {
            // Everything that happens outside a purchase call: an Ask to Buy approved later, a retry, a transaction
            // found at launch after the app was killed mid-purchase.
            for await event in purchases.events {
                switch event {
                case .completed(let session, _): message = "Purchase of \(session.product) confirmed."
                case .awaitingBackend: message = "Confirming your purchase…"
                case .rejected: message = "We could not confirm a purchase. Please contact support."
                case .unmatchedTransaction, .unverifiedTransaction: break
                }
            }
        }
    }

    func buy() async {
        do {
            let outcome = try await purchases.purchase(
                product: "pro_monthly",                   // your product key
                customerRef: Auth.shared.customerRef,
                customer: Customer(name: "Asha", email: "asha@example.com", state: "Karnataka")
            )
            switch outcome {
            case .completed:              message = "Welcome to Pro."
            case .pending:                message = "Waiting for approval."          // Ask to Buy
            case .cancelled:              message = ""
            case .unverified:             message = "The App Store could not verify this purchase."
            case .awaitingBackend:        message = "Confirming your purchase…"      // paid; retried automatically
            case .rejected:               message = "We could not confirm this purchase. Please contact support."
            }
        } catch {
            message = "Could not start the purchase: \(error)"                      // nothing was charged
        }
    }

    func restore() async {
        do {
            let entitlements = try await purchases.restorePurchases(customerRef: Auth.shared.customerRef)
            message = entitlements.hasAccess(to: "pro_monthly") ? "Pro restored." : "No active purchase found."
        } catch {
            message = "Restore failed: \(error)"
        }
    }
}
```

Manage and refund sheets (the server can neither cancel nor refund an App Store purchase):

```swift
try await AppStoreSheets.showManageSubscriptions(in: windowScene)
let outcome = try await AppStoreSheets.requestRefund(forTransaction: transactionID, in: windowScene)  // .submitted or .cancelled
```

Read what the customer owns from the backend, never from StoreKit alone:

```swift
let entitlements = try await purchases.entitlements(customerRef: customerRef)
if entitlements.hasAccess(to: "pro_monthly") { /* unlock */ }
```

## What `purchase` does

1. Starts a session for the product key with platform `ios` and finds the session's App Store option.
2. Saves the account token and session id in a small persisted record (see below).
3. Loads the `Product`, then calls `Product.purchase(options:)` with `.appAccountToken(token)` and, when the option
   carries one, the promotional offer.
4. Handles every `Product.PurchaseResult`:

| StoreKit result | `PurchaseOutcome` | What the SDK did |
|---|---|---|
| `.success(.verified)` | `.completed` | sent the JWS to the complete call; called `finish()` after the backend confirmed |
| `.success(.verified)`, backend not reachable or not settled | `.awaitingBackend` | left the transaction unfinished; it is sent again later |
| `.success(.verified)`, backend refused for good | `.rejected` | stopped sending it |
| `.success(.unverified)` | `.unverified` | sent nothing, finished nothing |
| `.pending` (Ask to Buy and similar) | `.pending` | kept the session open; the listener completes it when the transaction arrives |
| `.userCancelled` | `.cancelled` | nothing |

`purchase` throws `PurchaseError` (or the backend's error from the start call) before the payment sheet when something
is wrong; nothing was charged then.

## Transactions that arrive later

`start()` runs a `Task` over `Transaction.updates` and a pass over `Transaction.unfinished`. Both look the
transaction's `appAccountToken` up in the persisted record (account token to session id) and complete that session.
That covers an Ask to Buy approved days later, a purchase interrupted by the app being killed, and a backend that was
down. Call `processUnfinishedTransactions()` again when the app returns to the foreground or the user signs in.

The records are kept in `UserDefaults` (`UserDefaultsPurchaseRecordStore`); pass another `PurchaseRecordStore` to keep
them elsewhere. A record holds the token, the session id, the product key and a state, not the signed transaction or
the customer's details.

### Failures and retries

The SDK sorts every failure of the complete call:

- **Cannot reach the backend** (no network, timeout, 429, 503, 504, an expired user token, `UNAUTHORIZED`): kept
  unfinished and retried with no limit.
- **The backend failed in a way that may or may not last** (`INTERNAL_ERROR`, `PROVIDER_ERROR`, `OUTCOME_UNKNOWN`,
  `UNEXPECTED_RESPONSE`, `AUTH`, `CONFIG`, other 5xx): retried, up to `Configuration.maxServerFailures` rounds
  (default 10), then marked rejected.
- **A reason that will not change** (`VALIDATION`, `SIGNATURE_INVALID`, `NOT_FOUND`, `CONFLICT`, `UNSUPPORTED`,
  `NO_ROUTE`, a 2xx body the SDK cannot read): marked rejected at once. A rejected transaction is not sent again and
  stays unfinished; call `retryRejectedTransactions()` after you fixed the cause.
- The backend says the session is `failed` or `expired` (not paid: refunded, revoked, a lapsed subscription): the
  transaction is finished, nothing is left to deliver.

Within one call the SDK repeats a retryable failure up to `Configuration.maxCompletionAttempts` times (default 3) with
a doubling `retryDelay` (default 1 second).

A transaction the SDK has no record for (bought on another device, a promoted in-app purchase, the app was deleted and
reinstalled) cannot be matched to a session. It is reported once per launch as `PurchaseEvent.unmatchedTransaction`
and left unfinished (set `Configuration.finishUnmatchedTransactions` to finish it). A renewal of a purchase the backend
already confirmed is finished without being sent again, because the server learns renewals from App Store Server
Notifications.

## Restore and entitlements

`restorePurchases(customerRef:)` calls `AppStore.sync()`, sends any unfinished transaction that arrives, and returns the
backend's entitlements. Apple documents that `sync()` prompts the customer to sign in, so call it only from an explicit
user action such as a button. Restore does not depend on re-sending old transactions: the server checks a signed
transaction's certificates against the current time and can refuse a very old one, so the answer comes from the server's
own record, which App Store Server Notifications keep current.

## App Store rules that shape the SDK

- **In-app purchase only on iPhone.** Digital goods and subscriptions sold in an iOS app go through the App Store in
  India: there is no external-link or alternative-payment entitlement for the Indian storefront. The service's platform
  policy for `ios` is `store`, and a session for `ios` carries an App Store option only. Do not add a gateway checkout
  to the iOS app for these products.
- **The app must not point users to other ways to pay** (App Review Guideline 3.1.1(a)): no buttons, links, prices or
  text in the iOS app that steer people to buy on the web or through a gateway.
- **Using what was bought elsewhere is allowed** if the same item is also sold as an in-app purchase in the app
  (guideline 3.1.3(b)). The entitlements span stores and gateways, so a customer who bought on the web can read their
  access in the app; the service refuses a second subscription to the same product (`CONFLICT` on start).
- Physical goods and services consumed outside the app are not in-app purchases; mark them `physicalGoods` in the catalog
  and they go to the gateways.
- The server cannot cancel or refund an App Store purchase. Use `AppStoreSheets` and let the customer do it through Apple.

## What the app developer sets up in App Store Connect

1. An app record whose bundle id matches the bundle id the service is configured with.
2. The **Paid Applications Agreement**, banking and tax information, so products can be sold.
3. Each product: an auto-renewable subscription (inside a subscription group), a consumable or a non-consumable, with
   a price for the India storefront and localised names. The product id is what the catalog's `appStore.productId` holds.
4. For promotional offers: the offers on the subscription, and the **In-App Purchase key** (a `.p8` file) the service
   signs offers with.
5. For the service: the In-App Purchase key, its key id and the issuer id (App Store Connect > Users and Access >
   Integrations > In-App Purchase), and the **App Store Server Notifications V2** URL pointing at the service's webhook
   route, for production and for sandbox.
6. The **In-App Purchase** capability in the app target.

## Tests

The package has two kinds of tests.

```sh
# Models, the HTTP backend (URLProtocol stub) and the record store: no StoreKit environment needed.
cd sdks/ios && swift test

# The purchase flow against StoreKit Testing (SKTestSession) and a fake backend. StoreKit Testing runs only inside an
# app, so these tests live in an Xcode project with an empty host app that depends on this package.
cd sdks/ios && xcodebuild test \
  -project StoreKitTests/IndiaSubscriptionsStoreKitTests.xcodeproj -scheme StoreKitTests \
  -destination 'platform=iOS Simulator,name=iPhone 17'
```

The StoreKit configuration file with the test products is `StoreKitTests/Tests/Products.storekit`.

## Public API

- `PurchaseClient` (actor): `init(backend:recordStore:configuration:)`, `start()`, `stop()`,
  `purchase(product:customerRef:customer:reference:returnUrl:)`, `processUnfinishedTransactions()`,
  `retryRejectedTransactions()`, `restorePurchases(customerRef:)`, `entitlements(customerRef:)`, `events`.
- `PurchaseOutcome`, `PurchaseEvent`, `PurchaseFailure`, `PurchaseError`.
- `PurchaseBackend` (protocol) and `HTTPPurchaseBackend` (with `Paths` and an authorisation hook);
  `PurchaseBackendError`, `ServerError`, `ServerErrorCode`, `RetryAdvice`.
- Models: `StartPurchaseInput`, `CompletePurchaseInput`, `ChooseAlternativeInput`, `Customer`, `PurchaseSession`,
  `PurchaseOption`, `PurchaseAttempt`, `CheckoutInstruction`, `AppleStoreKitCheckout`, `PromotionalOffer`, `Entitlements`,
  `EntitlementItem`, and the open enumerations `Platform`, `Provider`, `ChannelPolicy`, `SalesChannel`, `ProductKind`,
  `SessionStatus`, `EntitlementStatus`, `AttemptOutcome`.
- `PurchaseRecord`, `PurchaseRecordStore`, `UserDefaultsPurchaseRecordStore`, `InMemoryPurchaseRecordStore`.
- `AppStoreSheets` (`showManageSubscriptions(in:)`, `requestRefund(forTransaction:in:)`) and `RefundRequestOutcome`.

## Promotional offers

The server signs a promotional offer with the legacy signature form and sends `offerId`, `keyId`, `nonce`, `timestamp`
and `signature`; the SDK passes them to StoreKit's `promotionalOffer(offerID:keyID:nonce:signature:timestamp:)`. Apple
marks that initialiser deprecated from iOS 26 in favour of a JWS-signed offer (`promotionalOffer(_:compactJWS:)`); the
legacy form is what the checkout instruction carries.
