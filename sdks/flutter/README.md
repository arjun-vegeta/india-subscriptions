# india_subscriptions for Flutter

A Flutter plugin for the `india-subscriptions` service. One Dart API sells subscriptions and one-time purchases through
the App Store on iOS and through Google Play (or Google Play user choice billing) on Android. The plugin contains no
purchase logic: it bridges the two native SDKs in this repository, [`sdks/ios`](../ios) and
[`sdks/android`](../android), which own every flow, retry and persistence rule. The plugin translates calls, results and
events, and nothing else.

- Flutter 3.41 or later, Dart 3.11 or later
- iOS 15 and later (Swift Package Manager), Android `minSdk` 24 (`compileSdk` 36)
- Typed results: sealed classes for outcomes, events and return-link results, with an `Unknown...` variant for a value
  a newer native SDK adds
- Generated, type-safe platform channels ([Pigeon](https://pub.dev/packages/pigeon) 30)

## How the pieces fit

```
 Flutter app  ──(user's auth header)──▶  your backend  ──(service API key)──▶  india-subscriptions service
 india_subscriptions                     authenticates the user,               verifies the purchase with the store,
   │                                     forwards five calls                   keeps entitlements
   ├─ iOS: IndiaSubscriptions (StoreKit 2)
   └─ Android: dev.indiasubscriptions (Play Billing Library 9)
```

**The app never holds the service's API key.** The native SDKs talk to your own backend with the signed-in user's
authorisation. Your backend forwards five calls to the service (or calls `subs.purchases` in-process).

## Installation

```yaml
dependencies:
  india_subscriptions:
    path: ../path/to/india-subscriptions/sdks/flutter
```

### iOS

The plugin integrates through **Swift Package Manager**, because the iOS SDK is a Swift package. Flutter enables Swift
Package Manager by default (the plugin requires Flutter 3.41 or later). There is no CocoaPods podspec: a project that has
turned Swift Package Manager off cannot use this plugin.

`ios/india_subscriptions/Package.swift` depends on the iOS SDK by path (`.package(path: "../../../ios")`), which is how
the repository is developed. A published plugin replaces that line with the SDK's repository and version, for example
`.package(url: "https://example.com/india-subscriptions-ios.git", from: "0.1.0")`, and keeps
`.product(name: "IndiaSubscriptions", package: ...)` as the target dependency; SwiftPM needs `Package.swift` at the root of a
repository it resolves by URL, so the SDK has to be published from a repository root. In Xcode, add the **In-App Purchase**
capability to the Runner target.

### Android

`android/build.gradle.kts` depends on the Maven coordinate of the Android SDK,
`dev.indiasubscriptions:android:0.1.0`. A published plugin resolves it from the repository the SDK is published to.
While developing in this repository, substitute the local module for the coordinate with a Gradle composite build, in the
app's `android/settings.gradle.kts` (the example app does this):

```kotlin
includeBuild("../../../android") {          // the path to sdks/android
    dependencySubstitution {
        substitute(module("dev.indiasubscriptions:android")).using(project(":indiasubscriptions"))
    }
}
```

The Android SDK builds with Android Gradle plugin 9.5, Gradle 9.6 or later and JDK 17 or later, so the app must use a
compatible Gradle wrapper and plugin version. Alternatively run `./gradlew :indiasubscriptions:publishToMavenLocal` in
`sdks/android` and add `mavenLocal()` to the app's repositories.

Declare the return link of a hosted checkout in `AndroidManifest.xml` (below) if you use Google Play user choice billing or a
`gateways` policy on Android.

## The backend it expects

`configure` points the plugin at the root of your backend. The native SDKs send these calls there, with `Authorization` set
from the value you give the plugin, `Accept: application/json` and, for a body, `Content-Type: application/json`. The paths
are the service's own routes; each is overridable (`PurchasePaths`).

| Call | Default path | Body | Answer |
|---|---|---|---|
| start | `POST v1/purchases` | `platform`, `product`, `customer`, `customerRef`, `reference?`, `returnUrl?` | `PurchaseSession` |
| get | `GET v1/purchases/{sessionId}` | | `PurchaseSession` |
| alternative | `POST v1/purchases/{sessionId}/alternative` | `{ "externalTransactionToken" }` | `PurchaseSession` |
| complete | `POST v1/purchases/{sessionId}/complete` | `{ "provider", "result" }` | `PurchaseSession` |
| entitlements | `GET v1/entitlements/{customerRef}` | | `Entitlements` |

Your backend must authenticate the user and decide which `customerRef` they may buy for, forward the calls to the service
with its API key, return the service's JSON and status code unchanged, answer errors in the service's shape
(`{ "error": { "code", "message", "provider?", "providerCode?", "retryable" } }`), and receive App Store Server
Notifications V2 and Google's real-time developer notifications so renewals, cancellations and refunds reach the
entitlements. Both native READMEs list what else the backend does:
[iOS](../ios/README.md#the-backend-it-expects), [Android](../android/README.md#the-backend-it-expects).

## Usage

```dart
import 'dart:async';

import 'package:india_subscriptions/india_subscriptions.dart';

final subs = IndiaSubscriptions.instance;

Future<void> startBilling() async {
  // Listen first: the native SDKs do not replay events. The plugin keeps the newest 64 until you do.
  subs.events.listen((event) {
    switch (event) {
      case PurchaseCompletedEvent(:final session):
        showMessage('Purchase of ${session.product} confirmed.');
      case PurchasePendingEvent():
        showMessage('Waiting for approval.');
      case PurchaseAwaitingBackendEvent():
        showMessage('Confirming your purchase…');
      case PurchaseRejectedEvent():
        showMessage('We could not confirm a purchase. Please contact support.');
      case HostedCheckoutOpenedEvent() ||
          UnmatchedPurchaseEvent() ||
          UnverifiedTransactionEvent():
        break;
      case UnknownPurchaseEvent(:final kind): // an event a newer native SDK added
        break;
    }
  });

  // Android: what a hosted checkout's return link led to (launch intent or a new intent).
  subs.returnLinkResults.listen((result) {
    switch (result) {
      case ReturnLinkCompleted():
        showMessage('Welcome to Pro.');
      case ReturnLinkNotPaid():
        showMessage('The payment did not go through.');
      case ReturnLinkStillPending():
        showMessage('Confirming your payment…');
      case ReturnLinkBackendFailed():
        showMessage('Could not check the payment. We will try again.');
      case ReturnLinkIgnored() || UnknownReturnLinkResult():
        break;
    }
  });

  await subs.configure(
    baseUrl: 'https://api.example.com/billing/',
    authorization: 'Bearer ${await auth.freshToken()}', // the user's own token
  );
}

// When the app's token changes, give the plugin the new header value.
Future<void> onTokenChanged(String token) => subs.setAuthorization('Bearer $token');

Future<void> buy() async {
  try {
    final outcome = await subs.purchase(
      'pro_monthly', // your product key
      customerRef: auth.customerRef,
      customer: const Customer(name: 'Asha', email: 'asha@example.com', state: 'Karnataka'),
      returnUrl: 'myapp://billing/return', // Android: the return link declared in the manifest
    );
    switch (outcome) {
      case PurchaseCompleted():
        showMessage('Welcome to Pro.');
      case PurchasePending():
        showMessage('Waiting for approval.'); // Ask to Buy, a pending Google Play payment
      case PurchaseCancelled():
        break;
      case PurchaseUnverified():
        showMessage('The store could not verify this purchase.'); // iOS
      case PurchaseAwaitingBackend():
        showMessage('Confirming your purchase…'); // paid; the native SDK retries
      case PurchaseRejected():
        showMessage('We could not confirm this purchase. Please contact support.');
      case PurchaseAwaitingReturn():
        break; // Android: the hosted checkout is open; the return link finishes it
      case PurchaseFailed(:final failure):
        showMessage('Google Play: ${failure.reason.name}'); // Android; nothing was charged
      case UnknownPurchaseOutcome(:final kind): // an outcome a newer native SDK added
        showMessage('Unexpected result: $kind');
    }
  } on BackendException catch (error) {
    showMessage('Could not start the purchase: ${error.message}'); // nothing was charged
  } on PurchaseStartException catch (error) {
    showMessage('Could not start the purchase: ${error.kind.name}'); // nothing was charged
  }
}

Future<void> restore() async {
  final entitlements = await subs.restorePurchases(auth.customerRef);
  showMessage(entitlements.hasAccess('pro_monthly') ? 'Pro restored.' : 'No active purchase found.');
}

// Read what the customer owns from the backend, never from the store alone.
Future<bool> hasPro() async => (await subs.entitlements(auth.customerRef)).hasAccess('pro_monthly');

// Call it when the app returns to the foreground or the user signs in.
Future<void> onResume() => subs.processPendingPurchases();

// Manage subscriptions: Apple's sheet on iOS, Google Play's page on Android.
Future<void> manage() async {
  try {
    await subs.showManageSubscriptions(); // iOS
  } on UnsupportedOnPlatformException {
    await subs.openSubscriptionManagement(productId: 'in.example.pro'); // Android
  }
}
```

`configure` builds the native client and, unless you pass `start: false`, starts its listeners: the `Transaction.updates`
listener and the pass over unfinished transactions on iOS, the billing connection and the pass over pending purchases on
Android. Call it once at launch. Calling it again replaces the client, which is what a hot restart does.

### Declare the return link (Android)

```xml
<activity android:name=".MainActivity" android:exported="true" android:launchMode="singleTop" ...>
    <intent-filter>
        <action android:name="android.intent.action.MAIN"/>
        <category android:name="android.intent.category.LAUNCHER"/>
    </intent-filter>
    <intent-filter>
        <action android:name="android.intent.action.VIEW"/>
        <category android:name="android.intent.category.DEFAULT"/>
        <category android:name="android.intent.category.BROWSABLE"/>
        <data android:scheme="myapp" android:host="billing" android:path="/return"/>
    </intent-filter>
    <!-- Flutter would otherwise push the link into the app's navigator as a route. -->
    <meta-data android:name="flutter_deeplinking_enabled" android:value="false"/>
</activity>
```

The plugin watches the activity: a link the activity was opened with, and a link that arrives while the app runs, go to the
native SDK, which reads the session from your backend and reports the result on `returnLinkResults`. A link that is not for
a checkout the app has pending is ignored and not reported. If your own deep link handler (for example `app_links`)
receives the link, pass it to `handleReturnLink(link)`, which returns the result. The result is what the backend says; the
link's own `status` is never read. An Android App Link (`https`, `android:autoVerify="true"`) ties the link to your domain;
a custom scheme does not.

## What differs between iOS and Android

The Dart API is the same on both platforms. A call that applies to one platform exists on both and throws
`UnsupportedOnPlatformException` (with `method` and `platform`) on the other.

| | iOS | Android |
|---|---|---|
| Store | App Store, StoreKit 2 | Google Play Billing Library 9 |
| `purchase` outcomes | `PurchaseCompleted`, `PurchasePending` (Ask to Buy), `PurchaseCancelled`, `PurchaseUnverified`, `PurchaseAwaitingBackend`, `PurchaseRejected` | `PurchaseCompleted`, `PurchasePending`, `PurchaseCancelled`, `PurchaseAwaitingBackend`, `PurchaseRejected`, `PurchaseAwaitingReturn`, `PurchaseFailed` |
| `PurchaseCancelled.session` | null | set |
| `events` | `completed` (with `transactionId`), `awaitingBackend`, `rejected`, `unmatchedPurchase`, `unverifiedTransaction` | `completed` (with `purchaseToken`), `pending`, `awaitingBackend`, `rejected`, `hostedCheckoutOpened`, `unmatchedPurchase` |
| `restorePurchases` | `AppStore.sync()` (prompts the customer to sign in: call it from a button), then the entitlements | pending purchases, then the entitlements |
| `processPendingPurchases` | unfinished transactions | purchases Google Play holds, pending hosted checkouts |
| `showManageSubscriptions`, `requestRefund` | Apple's sheets | `UnsupportedOnPlatformException` |
| `subscriptionManagementUrl`, `openSubscriptionManagement` | `UnsupportedOnPlatformException` | Google Play's subscription page |
| `handleReturnLink`, `returnLinkResults` | `UnsupportedOnPlatformException` / never emits | the hosted checkout's return link |
| `configure(headers:)` | extra request headers | `UnsupportedOnPlatformException`: the SDK's HTTP backend sends the `Authorization` header only |
| iOS-only options | `finishUnmatchedTransactions` | ignored |
| Android-only options | ignored | `allowBasePlanFallback`, `enablePrepaidPlans`, `allowCleartextCheckout` |
| Activity | | `purchase` needs a live activity; the plugin holds it only between attach and detach, through a weak reference |

Other behaviour that follows from the native SDKs:

- Failures before the store's screen are exceptions (`BackendException`, `PurchaseStartException`,
  `NotConfiguredException`); nothing was charged. A payment the backend has not confirmed is an outcome
  (`PurchaseAwaitingBackend`), not an exception, and the native SDK sends it again until the backend confirms or refuses it.
- Events and return-link results arrive on any native thread and are delivered to Dart on the platform's main thread.
- Hot restart: Dart's state is lost and the native state is not. Calling `configure` again stops the previous native client
  and its event collection before it builds a new one, and a new `events` listener replaces the old one.
- One Flutter engine is supported: the native SDKs keep one transaction listener and one set of purchase records per app.

## Store rules that shape the plugin

- **Apple: in-app purchase only on iPhone.** Digital goods and subscriptions sold in an iOS app go through the App Store in
  India; there is no external-link or alternative-payment entitlement for the Indian storefront. A session for iOS carries
  an App Store option only. Do not add a gateway checkout to the iOS app, and do not steer iOS users to other ways to pay
  (App Review Guideline 3.1.1(a)). A customer who bought elsewhere may use it in the app if the same item is also sold as an
  in-app purchase (guideline 3.1.3(b)); read what they own with `entitlements`. The server can neither cancel nor refund an
  App Store purchase: use `showManageSubscriptions` and `requestRefund`.
- **Google Play: Google Play billing, or user choice billing.** Android sells through Google Play Billing, or through Google
  Play user choice billing, where Google's own screen lets the customer pick Google Play or your payment gateway (Google Play
  billing stays an option); or, for apps distributed outside Google Play and for physical goods, through gateways only. The
  session's policy decides which; the plugin follows the session. Google asks for an alternative transaction to be reported
  within 24 hours; your backend does that, the device only hands over the token. The device never acknowledges or consumes a
  purchase: the server does.
- Physical goods and services consumed outside the app are not in-app purchases and go to the gateways.

Store setup (products, base plans, user choice billing enrolment, notification URLs, the In-App Purchase capability) is
described in the native READMEs: [iOS](../ios/README.md#what-the-app-developer-sets-up-in-app-store-connect),
[Android](../android/README.md#what-the-app-developer-sets-up-in-play-console).

## Development

```sh
dart run pigeon --input pigeon/messages.dart   # regenerate the channels (Dart, Kotlin, Swift)
dart format lib
flutter analyze
flutter test                                    # Dart tests with the host API mocked
cd example && flutter build apk --debug
cd example && flutter build ios --simulator --no-codesign
cd example/android && ./gradlew :india_subscriptions:testDebugUnitTest   # Kotlin translation tests, after one build
cd example/ios && xcodebuild test -workspace Runner.xcworkspace -scheme Runner \
  -destination 'platform=iOS Simulator,name=iPhone 17'                    # Swift translation tests
```

Layout:

| Path | What it holds |
|---|---|
| `pigeon/messages.dart` | the host API and event channels; the single source of the generated code |
| `lib/src/messages.g.dart`, `android/.../Messages.g.kt`, `ios/.../Messages.g.swift` | generated |
| `lib/src/api.dart`, `models.dart`, `outcomes.dart`, `errors.dart`, `mapping.dart` | the public Dart API and the translation from the messages |
| `android/.../IndiaSubscriptionsPlugin.kt`, `Translation.kt`, `EventDelivery.kt` | the Android bridge |
| `ios/india_subscriptions/Sources/india_subscriptions/` | the iOS bridge |
| `example/` | an app that builds against both SDKs |
