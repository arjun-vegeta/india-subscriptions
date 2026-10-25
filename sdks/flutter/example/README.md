# india_subscriptions example

A small app that configures the plugin, buys a product, listens to purchase events and reads entitlements. It consumes
the iOS and Android SDKs of this repository by path (see `ios/` through the plugin's `Package.swift`, and the
`includeBuild` in `android/settings.gradle.kts`).

```sh
flutter run --dart-define=BILLING_URL=https://api.example.com/billing/ --dart-define=PRODUCT_KEY=pro_monthly
flutter build apk --debug
flutter build ios --simulator --no-codesign
```

`BILLING_URL` is the root of your backend, which forwards the service's purchase calls; see the plugin's README.
