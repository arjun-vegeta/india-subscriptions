# india-subscriptions for React Native

A React Native library that sells subscriptions and one-time purchases through the `india-subscriptions` service from
one TypeScript API. It is a thin bridge over the two native SDKs in this repository, [`sdks/ios`](../ios/README.md)
(StoreKit 2) and [`sdks/android`](../android/README.md) (Google Play Billing). **Every flow, retry and persistence rule
lives in those SDKs.** The bridge translates arguments, results and events and nothing else.

- React Native 0.87 or later, New Architecture (a Turbo Native Module), TypeScript types included
- iOS 15 or later, Android `minSdk` 24
- no JavaScript dependencies besides `react` and `react-native`

## How the pieces fit

```
 your app (JS)  ──▶  this library  ──▶  IndiaSubscriptions (Swift) / indiasubscriptions (Kotlin)
                                              │  the user's authorisation header
                                              ▼
                                       your backend  ──(service API key)──▶  india-subscriptions service
```

**The app never holds the service's API key.** The native SDKs call your own backend with the signed-in user's
authorisation, and your backend forwards five calls to the service.

## Installation

### In this repository (by path)

The example app in [`example/`](example) is the reference. In short:

```sh
npm install ../path/to/india-subscriptions/sdks/react-native      # or "file:" in package.json
```

**iOS.** `pod install` in your app's `ios` directory. The pod `IndiaSubscriptionsReactNative` links the Swift package
`sdks/ios` through React Native's `spm_dependency` helper, using the package next to the bridge by path (see the
podspec). Add the **In-App Purchase** capability to the app target. React Native documents `spm_dependency`'s static
linking caveat: if the build reports linker errors, set `USE_FRAMEWORKS=dynamic`.

**Android.** The bridge asks for the SDK by its Maven coordinates, `dev.indiasubscriptions:android`. To resolve it from
this repository, add a composite build to your app's `android/settings.gradle`:

```groovy
includeBuild("../path/to/india-subscriptions/sdks/android") {
    dependencySubstitution {
        substitute module("dev.indiasubscriptions:android") using project(":indiasubscriptions")
    }
}
```

The SDK builds with Android Gradle plugin 9.5.1, and a Gradle build may use one version of that plugin only, so the
app's root `build.gradle` must use the same version (`classpath("com.android.tools.build:gradle:9.5.1")`; React Native
0.88 itself brings 9.2.1). That plugin needs Gradle 9.6 or later. React Native 0.88's Gradle plugin is compiled with
Kotlin 2.2.0 and cannot read the Kotlin metadata that Gradle 9.7 and later embed, so use Gradle 9.6.x (the example's
wrapper is 9.6.1). The SDK also needs `compileSdk` 36 or later.

### As a published package

`npm install india-subscriptions-react-native`, then the two native SDKs are resolved the way any native dependency is:

- **Android:** from a Maven repository, as `dev.indiasubscriptions:android:<version>` (the bridge's `build.gradle` asks
  for `0.1.0`; set `ext.indiaSubscriptionsAndroidVersion` in your root `build.gradle` to use another release). Publish
  the SDK with `./gradlew :indiasubscriptions:publishToMavenLocal` or to your own repository.
- **iOS:** the pod's podspec asks CocoaPods, through `spm_dependency`, for the Swift package product `IndiaSubscriptions`
  of this repository, from `0.1.0` up to the next major version. The repository root holds a `Package.swift` (package
  `IndiaSubscriptions`, product `IndiaSubscriptions`, sources from `sdks/ios/Sources/IndiaSubscriptions`), so the SDK
  can be depended on by the repository's URL; in a clone of this repository the podspec uses `sdks/ios` by path instead.
  An app that uses the SDK from Swift as well adds the same package with Swift Package Manager:
  `.package(url: "<repository URL>", from: "0.1.0")`.

## The backend it expects

The same five calls as the native SDKs; read the "backend it expects" section of the [iOS](../ios/README.md#the-backend-it-expects)
and [Android](../android/README.md#the-backend-it-expects) READMEs. In short, your backend authenticates the user,
decides which `customerRef` they may buy for, forwards `POST v1/purchases`, `GET v1/purchases/{sessionId}`,
`POST v1/purchases/{sessionId}/alternative`, `POST v1/purchases/{sessionId}/complete` and
`GET v1/entitlements/{customerRef}` to the service with its API key, and answers errors in the service's shape.
`baseUrl` and every path are options of `configure`.

## Usage

```tsx
import { useEffect, useState } from 'react';
import { Button, Linking, Platform, Text, View } from 'react-native';
import {
  addPurchaseListener,
  configure,
  entitlements,
  getSubscriptionManagementUrl,
  handleReturnLink,
  IndiaSubscriptionsError,
  processPendingPurchases,
  purchase,
  restorePurchases,
  setAuthorization,
  showManageSubscriptions,
  start,
} from 'india-subscriptions-react-native';

const CUSTOMER_REF = 'customer_123'; // your id for the signed-in customer

export function Paywall() {
  const [message, setMessage] = useState('');

  useEffect(() => {
    let listener: { remove(): void } | undefined;
    (async () => {
      // 1. Configure, 2. listen, 3. start: no event is missed.
      await configure({
        baseUrl: 'https://api.example.com/billing/',
        authorization: `Bearer ${await Auth.freshToken()}`,
      });
      listener = addPurchaseListener((event) => {
        // Everything outside a purchase call: an approval that comes in later, a retry, a purchase found at launch.
        switch (event.type) {
          case 'completed':
            return setMessage(`Purchase of ${event.session.product} confirmed.`);
          case 'pending':
            return setMessage('Waiting for approval.');
          case 'awaitingBackend':
            return setMessage('Confirming your purchase...');
          case 'rejected':
            return setMessage('We could not confirm a purchase. Please contact support.');
          default:
            return; // hostedCheckoutOpened, unmatchedPurchase, unverifiedTransaction, and values a newer SDK adds
        }
      });
      await start();
    })();
    return () => listener?.remove();
  }, []);

  // Keep the native HTTP backend's header current when the app's token changes.
  useEffect(() => Auth.onTokenChange((token) => setAuthorization(token ? `Bearer ${token}` : null)), []);

  // Android: the app is opened again through its return link after a hosted checkout.
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const read = async (url: string | null | undefined) => {
      if (!url) return;
      const result = await handleReturnLink(url);
      if (result.type === 'completed') setMessage('Welcome to Pro.');
    };
    Linking.getInitialURL().then(read);
    const subscription = Linking.addEventListener('url', ({ url }) => read(url));
    return () => subscription.remove();
  }, []);

  const buy = async () => {
    try {
      const outcome = await purchase('pro_monthly', {
        customerRef: CUSTOMER_REF,
        customer: { name: 'Asha', email: 'asha@example.com', state: 'Karnataka' },
        returnUrl: 'myapp://billing/return', // Android hosted checkout; see below
      });
      switch (outcome.type) {
        case 'completed': return setMessage('Welcome to Pro.');
        case 'pending': return setMessage('Waiting for approval.');
        case 'cancelled': return setMessage('');
        case 'awaitingBackend': return setMessage('Confirming your purchase...'); // paid; retried natively
        case 'awaitingReturn': return setMessage('Finish the payment in the browser.');
        case 'failed': return setMessage('Google Play could not take the purchase.');
        case 'unverified':
        case 'rejected': return setMessage('We could not confirm this purchase. Please contact support.');
        case 'unknown': return setMessage('Checking your purchase...'); // a newer SDK produced a result this version does not know
      }
    } catch (error) {
      // Nothing was charged. `error.code` is an `ErrorCode`; a backend failure carries details.
      if (error instanceof IndiaSubscriptionsError) {
        setMessage(`Could not start the purchase (${error.code}).`);
      }
    }
  };

  const restore = async () => {
    const owned = await restorePurchases(CUSTOMER_REF); // iOS: prompts to sign in; call it from a button
    setMessage(owned.items.some((i) => i.product === 'pro_monthly' && i.active) ? 'Pro restored.' : 'No active purchase.');
  };

  const manage = async () => {
    if (Platform.OS === 'ios') await showManageSubscriptions();
    else await Linking.openURL(await getSubscriptionManagementUrl('in.example.pro'));
  };

  return (
    <View>
      <Button title="Subscribe" onPress={buy} />
      <Button title="Restore purchases" onPress={restore} />
      <Button title="Manage subscription" onPress={manage} />
      <Button title="Check again" onPress={() => processPendingPurchases()} />
      <Text>{message}</Text>
    </View>
  );
}
```

Read what the customer owns from your backend, never from the store alone:

```ts
const owned = await entitlements(CUSTOMER_REF);
const hasPro = owned.items.some((item) => item.product === 'pro_monthly' && item.active);
```

## API

| Function | Notes |
|---|---|
| `configure(options)` | Builds the native client: `baseUrl`, `authorization`, `headers` (fixed extra headers on every request), `paths`, `timeoutMs`, retry limits, and `ios` / `android` option groups. Call once at start-up; calling it again replaces the client. |
| `setAuthorization(value \| null)` | Replaces the Authorization header value the native HTTP backend sends. Held in memory only. Call it whenever the app's token changes. |
| `start()` / `stop()` | Starts or stops the native listeners and the pass over purchases that are waiting. Add your listener before `start()`. |
| `purchase(productKey, { customerRef, customer?, reference?, returnUrl? })` | Resolves with a `PurchaseOutcome`; rejects with an `IndiaSubscriptionsError` when something went wrong before the payment screen. |
| `addPurchaseListener(listener)` | Events outside a `purchase` call. Returns `{ remove() }`. |
| `processPendingPurchases()` / `retryRejectedPurchases()` | Send waiting or refused purchases again; resolve with the events produced. Call the first when the app returns to the foreground or the user signs in. |
| `restorePurchases(customerRef)` / `entitlements(customerRef)` | The backend's entitlements. Restore also asks the store to synchronise (iOS prompts to sign in). |
| `showManageSubscriptions()`, `requestRefund(transactionId)` | iOS only. |
| `getSubscriptionManagementUrl(productId?)`, `handleReturnLink(url)` | Android only. |

Outcomes (`PurchaseOutcome`) and events (`PurchaseEvent`) are discriminated unions on `type`. Every union ends in
`{ type: 'unknown', name, raw }`: a result a newer native SDK adds, or a payload this version cannot read, arrives as
that variant with the native name instead of throwing. String fields such as `status`, `provider` and `reason` are open
too (`'completed' | (string & {})`): compare with the values you know and treat others as "not recognised".

Errors are always `IndiaSubscriptionsError` with a `code` (see `ErrorCode`) and `details`. For `BACKEND`, `details.kind`
is `server`, `transport`, `malformedResponse` or `invalidRequest`, and for a server error `details.serverCode`,
`statusCode`, `provider`, `providerCode`, `retryable` and `retryAdvice` are set.

## What differs between iOS and Android

| | iOS | Android |
|---|---|---|
| Store | App Store, StoreKit 2 | Google Play Billing; Google Play user choice billing with a gateway through a hosted checkout page; gateways only for apps outside Play |
| Outcomes only here | `unverified` | `awaitingReturn`, `failed` (with a `BillingFailure`) |
| Events only here | `unverifiedTransaction` | `pending`, `hostedCheckoutOpened` |
| `cancelled` | no session | carries the session |
| Platform-only calls | `showManageSubscriptions`, `requestRefund` | `getSubscriptionManagementUrl`, `handleReturnLink` |
| Restore | calls `AppStore.sync()` (prompts the customer) | re-reads Google Play's purchases; no prompt |
| Needs | In-App Purchase capability | a return link in the manifest for hosted checkouts; the current Activity (`NO_ACTIVITY` when there is none) |

A call that belongs to the other platform rejects with `NOT_APPLICABLE` and `details.appliesTo`; it is never undefined.
Transaction ids and `paymentId` values travel as strings, because a 64-bit id does not fit a JavaScript number.

### The Android return link

A hosted checkout (user choice billing, or a gateway-only session) opens in a Custom Tab and ends by opening your app
through the `returnUrl` you passed to `purchase`. Declare it in the manifest of the activity (`launchMode="singleTask"`
as in React Native's template):

```xml
<intent-filter>
    <action android:name="android.intent.action.VIEW" />
    <category android:name="android.intent.category.DEFAULT" />
    <category android:name="android.intent.category.BROWSABLE" />
    <data android:scheme="myapp" android:host="billing" android:path="/return" />
</intent-filter>
```

Pass the link to `handleReturnLink` (from `Linking.getInitialURL()` and the `url` event, as in the example). The link's
own `status` is never trusted: the result is what your backend says about the session. A link that is not for a pending
checkout gives `{ type: 'ignored' }`. What to set up in Play Console (products, base plans, user choice billing, the
payment-method logos and the subscription-management URL) is in the [Android README](../android/README.md).

## Store rules that shape the library

- **Apple: in-app purchase only on iPhone.** Digital goods and subscriptions sold in an iOS app go through the App
  Store in India; there is no external-link or alternative-payment entitlement for the Indian storefront. The service's
  platform policy for `ios` is `store`, so a session for iOS carries an App Store option only. Do not add buttons, links,
  prices or text to the iOS app that steer people to buy elsewhere (App Review Guideline 3.1.1(a)). The server can neither
  cancel nor refund an App Store purchase: `showManageSubscriptions` and `requestRefund` open Apple's own sheets.
- **Google: Google Play or user choice billing on Android.** In India, Google Play billing stays an option; "alternative
  billing only" and link-outs are not available. With user choice billing Google shows its own choice screen, and when
  the customer picks the alternative the purchase is routed to a gateway and reported to Google by the service. Apps
  distributed outside Google Play, and physical goods, use gateways only.

## Threading and lifecycle

- Calls return promises and never block the JavaScript thread. Native work runs off the main thread; the SDKs move to
  the main thread themselves where StoreKit or Google's billing client needs it.
- Events can originate on any native thread; they are delivered to listeners on the JavaScript thread.
- Android's purchase needs the current Activity. The bridge reads it when `purchase` is called and passes it on; the SDK
  holds it weakly, and the bridge keeps no reference to it.
- A JavaScript reload ends the old module instance, which stops forwarding events. The native client stays alive for the
  process; call `configure` again after a reload (your start-up code does) and it is replaced. A purchase in flight at
  that moment is not lost: the SDKs complete it from their persisted records.
- The authorisation value is held in memory only. Purchases the SDK finds at launch are sent once `configure` has
  supplied a client and a token.

## Tests and builds

```sh
npm install
npm run typecheck     # TypeScript
npm run lint          # ESLint and Prettier
npm test              # Jest, with the native module mocked
```

The example app under `example/` builds the bridge together with both SDKs:

```sh
cd example && npm install
cd android && ANDROID_HOME=<sdk path> ./gradlew assembleDebug
cd ../ios && pod install
xcodebuild -workspace IndiaSubscriptionsReactNativeExample.xcworkspace -scheme IndiaSubscriptionsReactNativeExample \
  -configuration Debug -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The Jest tests cover argument translation, every outcome and event mapping (including unknown values), error
translation and the platform-only calls. The native SDKs have their own tests in `sdks/ios` and `sdks/android`.
