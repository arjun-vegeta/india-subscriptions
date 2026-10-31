# IndiaSubscriptions for Android

A Kotlin library that drives the device side of a purchase for the `india-subscriptions` service. It buys a Google Play
product with Play Billing Library 9, hands the purchase to your backend, and, when the customer chooses the alternative
on Google's user choice billing screen, opens the gateway's hosted checkout page in a Custom Tab and reads the outcome back
when the app is opened through its return link. It has no UI, no analytics and no dependencies beyond Google's billing
library, `androidx.browser` and `kotlinx-coroutines-android`.

- `minSdk` 23 (Play Billing Library 8.1 and later require it), `compileSdk` 36 (`androidx.browser` 1.10 requires it)
- Kotlin, coroutines throughout; nothing blocks the main thread
- Play Billing Library 9.1.0

## How the pieces fit

```
 your app  ──(user's auth header)──▶  your backend  ──(service API key)──▶  india-subscriptions service
 IndiaSubscriptions                   authenticates the user,               verifies the purchase with Google,
                                      forwards five calls                   acknowledges or consumes it,
                                                                            keeps entitlements, reports user
                                                                            choice purchases to Google
```

**The app never holds the service's API key, and the SDK never acknowledges or consumes a purchase.** The SDK talks only
to your own backend, with the signed-in user's authorisation. Your backend forwards five calls to the service (or calls
`subs.purchases` in-process). The service acknowledges the purchase (or consumes a consumable one) when it verifies it.

## Installation

The module is `sdks/android/indiasubscriptions`. Its Maven coordinates are `dev.indiasubscriptions:android:0.1.0`
(`./gradlew :indiasubscriptions:publishToMavenLocal` publishes the release variant to your local Maven repository).
To use it from this repository by path, in your app's `settings.gradle.kts`:

```kotlin
include(":indiasubscriptions")
project(":indiasubscriptions").projectDir = file("../path/to/india-subscriptions/sdks/android/indiasubscriptions")
```

and in the app module:

```kotlin
dependencies {
    implementation(project(":indiasubscriptions"))
}
```

The module applies `com.android.library` without a version and relies on the Android Gradle plugin your project already
declares (the SDK itself builds with Android Gradle plugin 9.5, Gradle 9.6 or later and JDK 17 or later).

The library's manifest adds the `INTERNET` permission. Nothing else is needed in the manifest of the app except the return
link (below).

## The backend it expects

`HttpPurchaseBackend` sends these calls to `baseUrl`, with `Authorization` set from your hook, `Accept:
application/json` and, for a body, `Content-Type: application/json`. The paths are the service's own routes and each is
overridable (`HttpPurchaseBackend.Paths`). `HttpPurchaseBackend(headers = mapOf(...))` adds fixed extra headers to every request; the
authorisation hook takes precedence for `Authorization`.

| Call | Default path | Body | Answer |
|---|---|---|---|
| start | `POST v1/purchases` | `StartPurchaseInput` (`platform`, `product`, `customer`, `customerRef`, `reference?`, `returnUrl?`) | `PurchaseSession` |
| get | `GET v1/purchases/{sessionId}` | | `PurchaseSession` |
| alternative | `POST v1/purchases/{sessionId}/alternative` | `{ "externalTransactionToken" }` | `PurchaseSession` |
| complete | `POST v1/purchases/{sessionId}/complete` | `{ "provider": "google_play", "result": { "purchaseToken": "...", "productId": "..." } }` | `PurchaseSession` |
| entitlements | `GET v1/entitlements/{customerRef}` | | `Entitlements` |

The SDK sends `platform: "android"`. Start, complete and entitlements are used on every Android purchase; alternative is
used when the customer chooses the alternative on Google's choice screen; get is used to read a hosted checkout back.

Your backend must:

- authenticate the user and decide which `customerRef` they may buy for (never trust the one in the request body);
- forward the calls to the service with its API key and return the service's JSON and status code unchanged;
- answer errors in the service's shape, `{ "error": { "code", "message", "provider?", "providerCode?", "retryable" } }`.
  The SDK reads `code` to decide whether to retry (see "Failures and retries");
- tell the service which one-time products are consumable (the `consumable` flag of the complete result belongs to your
  backend, which knows the catalogue; the device does not send it);
- receive Google's real-time developer notifications (Pub/Sub push) at the service's webhook route, so renewals,
  cancellations, refunds and holds reach the entitlements. The device does not report renewals;
- for user choice billing: collect the customer's state at start (`customer.state`), set `taxRateBps` on the product, and
  serve the hosted checkout (`PUBLIC_BASE_URL`), which the app opens in a Custom Tab.

Times in every body are ISO-8601 strings; the models decode them to epoch milliseconds (`...Millis` properties), so the
library does not need `java.time` on API 23 to 25. Enumerations (`status`, `platform`, `policy`, `channel`, `provider` and
so on) are open value classes: a value a newer server adds decodes instead of failing. Checkout instructions of kinds
other than `google_play_billing` decode as `CheckoutInstruction.Other(kind)`.

## Usage

```kotlin
class App : Application() {
    lateinit var purchases: PurchaseClient

    override fun onCreate() {
        super.onCreate()
        val backend = HttpPurchaseBackend(
            baseUrl = "https://api.example.com/billing/",
            authorization = { Auth.freshBearerToken()?.let { "Bearer $it" } },   // the user's own token
        )
        purchases = PurchaseClient.create(this, backend)
        purchases.start()   // connects to Google Play, listens for purchases, sends what is waiting
    }
}
```

```kotlin
class MainActivity : AppCompatActivity() {
    private val purchases get() = (application as App).purchases

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        // Everything that happens outside a purchase call you are waiting for: a pending purchase approved later, a
        // retry that succeeded, a purchase found at launch after the app was killed mid-purchase.
        lifecycleScope.launch {
            repeatOnLifecycle(Lifecycle.State.STARTED) {
                purchases.events.collect { event ->
                    when (event) {
                        is PurchaseEvent.Completed -> showMessage("Purchase of ${event.session.product} confirmed.")
                        is PurchaseEvent.Pending -> showMessage("Waiting for approval.")
                        is PurchaseEvent.AwaitingBackend -> showMessage("Confirming your purchase…")
                        is PurchaseEvent.Rejected -> showMessage("We could not confirm a purchase. Please contact support.")
                        is PurchaseEvent.HostedCheckoutOpened -> Unit
                        is PurchaseEvent.UnmatchedPurchase -> Unit   // read the entitlements; see below
                    }
                }
            }
        }
        handleLink(intent)

        findViewById<Button>(R.id.subscribe).setOnClickListener { lifecycleScope.launch { buy() } }
        findViewById<Button>(R.id.manage).setOnClickListener {
            startActivity(PlaySubscriptions.managementIntent(this, productId = "in.example.pro"))
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handleLink(intent)
    }

    override fun onResume() {
        super.onResume()
        lifecycleScope.launch { purchases.processPendingPurchases() }   // Google: query purchases in onResume()
    }

    private fun handleLink(intent: Intent) {
        lifecycleScope.launch {
            when (val result = purchases.handleReturnLink(intent)) {
                is ReturnLinkResult.Completed -> showMessage("Welcome to Pro.")
                is ReturnLinkResult.NotPaid -> showMessage("The payment did not go through.")
                is ReturnLinkResult.StillPending -> showMessage("Confirming your payment…")
                is ReturnLinkResult.BackendFailed -> showMessage("Could not check the payment. We will try again.")
                ReturnLinkResult.Ignored -> Unit
            }
        }
    }

    private suspend fun buy() {
        try {
            val outcome = purchases.purchase(
                activity = this,
                product = "pro_monthly",                          // your product key
                customerRef = Auth.customerRef,
                customer = Customer(name = "Asha", email = "asha@example.com", state = "Karnataka"),
                returnUrl = "myapp://billing/return",             // the return link declared in the manifest
            )
            when (outcome) {
                is PurchaseOutcome.Completed -> showMessage("Welcome to Pro.")
                is PurchaseOutcome.Pending -> showMessage("Waiting for approval.")         // a payment that settles later
                is PurchaseOutcome.Cancelled -> Unit
                is PurchaseOutcome.AwaitingBackend -> showMessage("Confirming your purchase…")   // paid; retried automatically
                is PurchaseOutcome.Rejected -> showMessage("We could not confirm this purchase. Please contact support.")
                is PurchaseOutcome.AwaitingReturn -> Unit          // the checkout page is open; the return link finishes it
                is PurchaseOutcome.Failed -> showMessage(billingMessage(outcome.failure))  // nothing was charged
            }
        } catch (error: PurchaseBackendException) {
            showMessage("Could not start the purchase: ${error.message}")     // nothing was charged
        } catch (error: PurchaseException) {
            showMessage("Could not start the purchase: ${error.message}")
        }
    }
}
```

The manifest declares the return link and keeps `MainActivity` as the single instance that receives it:

```xml
<activity android:name=".MainActivity" android:exported="true" android:launchMode="singleTop">
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="myapp" android:host="billing" android:path="/return" />
    </intent-filter>
</activity>
```

Read what the customer owns from the backend, never from Google Play alone:

```kotlin
val entitlements = purchases.entitlements(customerRef)
if (entitlements.hasAccess("pro_monthly")) { /* unlock */ }
```

`PurchaseClient.events` buffers per collector and does not replay: an event emitted while nobody collects is gone. That
is why the entitlements are the source of truth; read them when the app comes to the foreground.

## What `purchase` does

1. Calls the backend's start with platform `android` and follows the session's options. The session's `policy` says which
   shape it has.
2. **A Google Play option** (policy `store`, or `user_choice`): builds the billing client (with `enableUserChoiceBilling`
   when the instruction's `userChoiceBilling` is true), loads the product from Google Play, picks the offer from
   `basePlanId` and `offerId`, writes the account id and the session id to the record store, and launches Google's
   purchase screen with the instruction's obfuscated account id.
3. **A gateway option only** (policy `gateways`): opens the option's `hostedUrl` in a Custom Tab.

What Google returns, and what the SDK does with it:

| Google Play | `PurchaseOutcome` | What the SDK did |
|---|---|---|
| a `Purchase` in state `PURCHASED` | `Completed` | sent `{ purchaseToken, productId }` to the complete call; the server acknowledged or consumed it |
| `PURCHASED`, backend not reachable or not settled | `AwaitingBackend` | sent it again later (below) |
| `PURCHASED`, backend refused for good | `Rejected` | stopped sending it |
| a `Purchase` in state `PENDING` | `Pending` | kept the session open and the record `PENDING`; it completes later as a `PurchaseEvent.Completed` |
| `USER_CANCELED` | `Cancelled` | removed the record |
| the customer chose the alternative (`userSelectedAlternativeBilling`) | `AwaitingReturn` | sent the external transaction token to the alternative call and opened the gateway option's `hostedUrl` in a Custom Tab |
| any other `BillingResponseCode` | `Failed` | nothing was charged; see below |

`purchase` throws `PurchaseBackendException` (the backend's start call failed) or `PurchaseException` (the session has no
usable option, is `failed` or `expired`, the product or offer is not on Google Play, another purchase is running, the
activity is gone, or the record store failed) before Google's screen opens; nothing was charged then.

Only one purchase runs at a time. If the coroutine that called `purchase` is cancelled while Google's screen is open (the
activity was destroyed), the purchase is not lost: its result is handled when it arrives and reported on `events`.

### Billing response codes

`PurchaseOutcome.Failed` carries a `BillingFailure` whose `reason` sorts Google's `BillingResponseCode`:

| `BillingFailureReason` | `BillingResponseCode` | Meaning, as Google documents it |
|---|---|---|
| `USER_CANCELED` | `USER_CANCELED` | the customer closed the screen (a `Cancelled` outcome, not a `Failed` one) |
| `BILLING_UNAVAILABLE` | `BILLING_UNAVAILABLE` | Play Store out of date, an unsupported country, an enterprise admin disabled purchases, or Google Play could not charge the payment method; letting the customer retry may work once the condition changed |
| `SERVICE_UNAVAILABLE` | `SERVICE_UNAVAILABLE`, `SERVICE_TIMEOUT` | transient; the SDK retries with a backoff before reporting it |
| `SERVICE_DISCONNECTED` | `SERVICE_DISCONNECTED` | the connection to the Play Store service was lost; the SDK reconnects and repeats the request |
| `NETWORK_ERROR` | `NETWORK_ERROR` | a problem between the device and Google Play; retried like the transient ones |
| `ITEM_UNAVAILABLE` | `ITEM_UNAVAILABLE` | the product is not available in the customer's country, or the catalogue has not propagated |
| `ITEM_ALREADY_OWNED` | `ITEM_ALREADY_OWNED` | the customer already owns it; the SDK refreshes the owned purchases and completes the ones it has a record for |
| `ITEM_NOT_OWNED` | `ITEM_NOT_OWNED` | an action on an item the customer does not own |
| `FEATURE_NOT_SUPPORTED` | `FEATURE_NOT_SUPPORTED` | the Play Store on this device lacks what was asked for |
| `DEVELOPER_ERROR` | `DEVELOPER_ERROR` | invalid arguments or a misconfigured app (an unsigned build, a missing permission) |
| `ERROR` | `ERROR` | an internal Google Play error that may be transient; retried a limited number of times |
| `UNKNOWN` | a code this version does not know | |

`BillingFailure.subResponseCode` carries the sub-response code Play Billing Library 9 adds to a purchase flow result
(`PAYMENT_DECLINED_DUE_TO_INSUFFICIENT_FUNDS` is 1, `USER_INELIGIBLE` is 2) where Google sets one, and `isTransient` says
whether trying again later may work without anything else changing.

## User choice billing

When the session's instruction says `userChoiceBilling: true`, the `BillingClient` is built with
`enableUserChoiceBilling` and Google renders its own information and choice screens; the SDK draws nothing. Google's
documentation describes what follows:

- If the customer picks **Google Play**, `onPurchasesUpdated` runs and the purchase is an ordinary one (the table above).
- If the customer picks **the alternative**, no purchase is created: `userSelectedAlternativeBilling` runs with an external
  transaction token. The SDK writes the token to the record store, sends it to the backend's alternative call, and opens
  the `hostedUrl` of the gateway option the answer carries in a Custom Tab. The call returns `AwaitingReturn`.
- The hosted page performs the gateway's checkout, completes the session when the customer comes back and redirects to the
  `returnUrl` you gave at start with `session` and `status` appended.

**The return link is not trusted.** When the app is opened through it, `handleReturnLink` reads the session from the
backend and reports what the backend says (`Completed`, `NotPaid`, `StillPending`, `BackendFailed`). The link's `status` is
never read. Its `session` only selects one of the checkouts this app itself recorded as pending, and only when the link
points to the `returnUrl` that session was started with; any other link gives `Ignored` and nothing is read. Android's
link verification covers `http` and `https` intent filters only, so nothing ties a custom URL scheme to your app; an App Link
(below) is verified for your domain.
The outcome that decides access is the entitlement your backend holds.

A token that could not be delivered (the backend was down) stays in the record store until the backend has it: the SDK
retries in the background while the app runs and again at the next launch. Google asks for the transaction to be reported
within 24 hours of the payment, by the backend; the token is what lets it do that.

`handleReturnLink` also covers a customer who closes the tab without being sent back: `processPendingPurchases()` reads
every pending hosted checkout from the backend, so the outcome arrives as a `PurchaseEvent` on the next resume.

### The return link the app must declare

Pass the link as `returnUrl` to `purchase`; the service sends the customer there when the hosted checkout is done. Declare
it on the activity that handles it:

- **Custom scheme** (`myapp://billing/return`), as in the example above: the simplest, and outside Android's link verification.
- **Android App Link** (`https://app.example.com/billing/return`): add `android:autoVerify="true"` to an intent filter with
  action `VIEW`, categories `DEFAULT` and `BROWSABLE` and an `https` scheme, and serve
  `https://app.example.com/.well-known/assetlinks.json`. Android verifies the host when the app is installed (API 23 and
  later). Source: [Verify Android App Links](https://developer.android.com/training/app-links/verify-android-applinks).

Use `launchMode="singleTop"` (or handle `onNewIntent`) so that a link opens the running activity, and pass the intent to
`handleReturnLink` from `onCreate` and `onNewIntent`.

## Transactions that arrive later

`PurchaseClient.start()` connects and runs `processPendingPurchases()`; the billing client's listener stays on while the
client lives. Both look a purchase's obfuscated account id up in the persisted record (account id to session id, written
before Google's screen opens) and complete that session. That covers a purchase that completes after the process died, a
pending one approved days later, a purchase `onPurchasesUpdated` delivers that this process did not start, and a backend
that was down. Call `processPendingPurchases()` again when the app returns to the foreground or the user signs in.

`onPurchasesUpdated` can deliver the same purchase more than once, and a query returns purchases that were sent already.
Completing is idempotent on the SDK side too: a purchase being sent is not sent a second time by a concurrent pass, and a
purchase the backend confirmed is remembered (by token) and not sent again. The SDK never acknowledges or consumes: the
server does, when it verifies the purchase.

The records are kept in a private `SharedPreferences` file (`SharedPreferencesPurchaseRecordStore`, written with
`commit()` so a record is on disk before Google's screen opens); pass another `PurchaseRecordStore` to keep them
elsewhere. A record holds the account id, the session id, the product key and a state. It holds no customer details, and
the external transaction token only until the backend has it. Session ids are capabilities, so keep the file out of
backups:

```xml
<!-- res/xml/backup_rules.xml, referenced by android:fullBackupContent -->
<full-backup-content>
    <exclude domain="sharedpref" path="dev.indiasubscriptions.purchase-records.xml" />
</full-backup-content>

<!-- res/xml/data_extraction_rules.xml, referenced by android:dataExtractionRules (Android 12 and later) -->
<data-extraction-rules>
    <cloud-backup><exclude domain="sharedpref" path="dev.indiasubscriptions.purchase-records.xml" /></cloud-backup>
    <device-transfer><exclude domain="sharedpref" path="dev.indiasubscriptions.purchase-records.xml" /></device-transfer>
</data-extraction-rules>
```

A purchase the SDK has no record for (bought on another device, outside the app, or the app was reinstalled) cannot be
matched to a session. If Google reports it as not yet acknowledged, it is reported once per launch as
`PurchaseEvent.UnmatchedPurchase`; the backend learns of it from the real-time developer notifications.

### Failures and retries

The SDK sorts every failure of a call to the backend by the error's `code` (`ServerErrorCode`, `RetryAdvice`):

- **Cannot reach the backend** (no network, timeout, 429, 503, 504, an expired user token, `UNAUTHORIZED`): the purchase
  stays unconfirmed and is retried with no limit. Within one call the SDK repeats up to `maxCompletionAttempts` times (default
  3) with a doubling `retryDelayMillis` (default 1 second); after that a background retry runs while the app is alive, after
  30 seconds, then doubling up to 15 minutes, for three days (the time Google gives to acknowledge a purchase before it
  refunds it), and every launch and resume tries again.
- **The backend failed in a way that may or may not last** (`INTERNAL_ERROR`, `PROVIDER_ERROR`, `OUTCOME_UNKNOWN`,
  `UNEXPECTED_RESPONSE`, `AUTH`, `CONFIG`, other 5xx): retried, up to `maxServerFailures` rounds (default 10), then marked
  rejected.
- **A reason that will not change** (`VALIDATION`, `SIGNATURE_INVALID`, `NOT_FOUND`, `CONFLICT`, `UNSUPPORTED`, `NO_ROUTE`, a
  2xx body the SDK cannot read): marked rejected at once. A rejected purchase is not sent again; call
  `retryRejectedPurchases()` after you fixed the cause.
- The backend says the session is `failed` or `expired` (not paid: refunded, revoked): rejected with reason `NOT_PAID`.

A purchase that never reaches the server is refunded by Google after three days, so the SDK retries until the backend
confirms it or refuses it for good.

**Billing connection.** The SDK builds the client without automatic service reconnection and manages the connection
itself: it connects before a request, reconnects and repeats a request that fails with `SERVICE_DISCONNECTED`,
`SERVICE_UNAVAILABLE`, `NETWORK_ERROR` or `ERROR` (up to `maxBillingAttempts`, default 4, with a doubling
`billingRetryDelayMillis`), does not retry `BILLING_UNAVAILABLE`, `DEVELOPER_ERROR` or `FEATURE_NOT_SUPPORTED`, and reconnects
in the background when the service disconnects. Google recommends one active `BillingClient`; the SDK keeps one and replaces
it when a session needs user choice billing switched on or off.

## Restore and entitlements

`restorePurchases(customerRef)` runs `processPendingPurchases()` and returns the backend's entitlements. Google Play needs no
separate restore call: its owned purchases are listed by the query. The entitlements are the source of truth; a customer
whose subscription is active sees it whether or not any purchase is sent again.

`PlaySubscriptions.managementUrl(packageName, productId)` and `PlaySubscriptions.managementIntent(context, productId)` give
Google's subscription management page for one subscription (`https://play.google.com/store/account/subscriptions?sku=...&package=...`),
or the list of subscriptions when no product id is given. A subscription bought through Google Play is cancelled or paused
there; a subscription of a gateway is cancelled through your backend and the service.

## What the app developer sets up in Play Console

1. A Google Play developer account with a payments profile, and an app on any track with the Play Billing Library in it.
2. Each product, with the product id that the catalogue's `googlePlay.productId` holds:
   - **A subscription:** Monetize with Play > Products > Subscriptions, a product id, at least one **active** base plan
     (its base plan id is `googlePlay.basePlanId`), and optionally offers (a free trial or an introductory price; the offer
     id is `googlePlay.offerId`). Ids are permanent once created.
   - **A one-time product** (Play Console calls it a managed product): a product id, a title, a description and a price.
     Mark `consumable: true` on the catalogue's `googlePlay` mapping for one the customer can buy again.
3. The service account, real-time developer notifications and license testers for the service: see
   [Setting up Google Play](../../docs/guides/setting-up-google-play.md).
4. **User choice billing** (policy `user_choice`):
   - Enrol: Manage account > Play apps settings > Monetization settings > Alternative billing; accept the terms and set up
     a payment profile if asked. Google confirms by e-mail and sends the instructions for enrolling the app. Google Play
     billing stays an option beside yours. Source:
     [Understanding user choice billing on Google Play](https://support.google.com/googleplay/android-developer/answer/13821247).
   - In Play Console's alternative billing settings for the app, choose to offer the alternative, **upload the payment
     method logos**, and, if you offer subscriptions, **provide the subscription management link** Google requires. The logos
     are optional but recommended: one PNG with a transparent background, 192 dp by 20 dp, up to five cards of 32 dp by 20 dp
     spaced 8 dp apart (3 dp inner padding, a 1 dp #E0E0E0 outline with a 2 dp radius, a solid card background), and nothing
     else in the image; an image that does not follow the specification is not shown. Google's page does not state the
     format of the management link: point it at the page where your customers manage subscriptions bought through the
     alternative. Source: [Alternative billing](https://developer.android.com/google/play/billing/alternative).
   - Google renders the choice screen; the app draws nothing. License testers are not invoiced for the transactions they start.
5. The app's package name and signing, so that Google Play accepts the billing flow.

## Rules that shape the SDK

- **Google Play billing stays an option in India.** User choice billing is available for apps and games, for in-app purchases
  and subscriptions; "alternative billing only" and link-outs are not available. The SDK only builds a
  `userChoiceBilling` client when the service's session says so.
- **Pending purchases.** The client enables pending purchases for one-time products (Google requires the call), and for
  prepaid plans when `enablePrepaidPlans` is set. Entitlement is granted only when a purchase is `PURCHASED`; the backend, not
  the SDK, decides, and a pending purchase is announced and not sent.
- **Suspended subscriptions** are not queried (they give no access); the customer manages them on Google Play's subscription
  page.
- **Physical goods and services consumed outside the app** are not in-app purchases: mark them `physicalGoods` in the
  catalogue and the session sends them to the hosted checkout.

## Threading

Every public suspend function can be called from the main thread. HTTP and storage run on `Dispatchers.IO`; Google's billing
client is only touched on the main thread, where it delivers its callbacks; collectors and retries run on
`Dispatchers.Default`. The `Activity` given to `purchase` is held weakly and used to launch Google's screen and the Custom
Tab; it is not kept after that, and a Custom Tab for a session whose activity is gone opens through the application context.

## Tests

```sh
cd sdks/android
export ANDROID_HOME=/path/to/android/sdk
./gradlew build        # assemble, lint and unit tests
```

The unit tests run on the JVM. The billing client sits behind the small `BillingGateway` interface, so every purchase flow
runs against a fake of it and a fake `PurchaseBackend`; `HttpPurchaseBackend` is exercised against a local HTTP server;
`PlayBillingGateway`, the only class that touches Google's library, is a thin translation layer.

## Public API

- `PurchaseClient`: `create(context, backend, ...)`, `start()`, `stop()`, `purchase(activity, product, customerRef, customer,
  reference, returnUrl)`, `processPendingPurchases()`, `retryRejectedPurchases()`, `handleReturnLink(link)` and
  `handleReturnLink(intent)`, `restorePurchases(customerRef)`, `entitlements(customerRef)`, `events`, and
  `PurchaseClient.Configuration`.
- `PurchaseOutcome`, `PurchaseEvent`, `PurchaseFailure`, `ReturnLinkResult`, `PurchaseException`.
- `PurchaseBackend` (interface) and `HttpPurchaseBackend` (with `Paths` and an authorisation hook);
  `PurchaseBackendException`, `ServerError`, `ServerErrorCode`, `RetryAdvice`.
- `BillingGateway`, `BillingGatewayFactory`, `PlayBillingGateway`, `BillingFailure`, `BillingFailureReason`, `BillingCode`
  and the small types of the gateway interface.
- Models: `StartPurchaseInput`, `CompletePurchaseInput`, `ChooseAlternativeInput`, `Customer`, `PurchaseSession`,
  `PurchaseOption`, `PurchaseAttempt`, `CheckoutInstruction`, `Entitlements`, `EntitlementItem`, and the open value classes
  `Platform`, `Provider`, `ChannelPolicy`, `SalesChannel`, `ProductKind`, `SessionStatus`, `EntitlementStatus`,
  `AttemptOutcome`.
- `PurchaseRecord`, `PurchaseRecordStore`, `SharedPreferencesPurchaseRecordStore`, `InMemoryPurchaseRecordStore`.
- `HostedPageOpener` and `CustomTabsPageOpener`; `PlaySubscriptions`.

## Sources

Play Billing Library: [integration guide](https://developer.android.com/google/play/billing/integrate),
[release notes](https://developer.android.com/google/play/billing/release-notes),
[migrating to version 9](https://developer.android.com/google/play/billing/migrate-gpblv9),
[subscriptions](https://developer.android.com/google/play/billing/subscriptions);
user choice billing: [in-app integration](https://developer.android.com/google/play/billing/alternative/alternative-billing-with-user-choice-in-app);
Custom Tabs: [Chrome for Developers](https://developer.chrome.com/docs/android/custom-tabs/).
