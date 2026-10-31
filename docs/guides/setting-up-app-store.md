# Setting up the App Store

After this page you will have everything the App Store adapter needs: the agreement and products in App Store Connect, the In-App Purchase key, the server notification addresses, and a sandbox account to test with. Apple's console changes over time, so each step names the Apple page it comes from; follow that page if a menu has moved.

You need an Apple Developer Program membership and an app record whose bundle id matches the bundle id you configure (`APP_STORE_BUNDLE_ID` or `bundleId`).

## 1. Sign the Paid Applications Agreement

To sell in-app purchases, the Account Holder must sign the Paid Apps Agreement. In App Store Connect choose **Business**, open the **Agreements** tab, find the **Paid Apps** row and click **View and Agree to Terms**. The agreement must be active to submit or update in-app purchases. Banking and tax information are separate sections of the same area; complete them so that you can be paid.

Source: [Sign and update agreements](https://developer.apple.com/help/app-store-connect/manage-agreements/sign-and-update-agreements/).

## 2. Create the products

The product id you create here is what the catalog's `appStore.productId` holds. It is permanent, so choose it with care.

**A subscription.** In the app, under **Monetization**, click **Subscriptions**. Create a subscription group (a **reference name**), then create the subscription in it with a **Reference Name** and a **Product ID**. On the subscription's page set the **Subscription Duration**, the **Subscription Prices** (the price for the India storefront; Apple converts it for other territories), the **Availability**, the **Review Information** (a screenshot and review notes) and the localised display name and description. Your first subscription, and your first subscription group, must be submitted with a new app version.

Source: [Offer auto-renewable subscriptions](https://developer.apple.com/help/app-store-connect/manage-subscriptions/offer-auto-renewable-subscriptions).

**A free trial or an offer.** A free trial is an *introductory offer* on the subscription, set up in App Store Connect. A discount for a customer you choose is a *promotional offer*; to sell one through this library you also need the offer key in step 3 and `storeProduct.offerId`. The library cannot add a trial: `trial` on a store product is refused with `UNSUPPORTED`, and the message points here.

**A one-time product.** Under **Monetization**, create an in-app purchase of type **Consumable** (bought again and again, such as coins) or **Non-Consumable** (bought once). Give it a Reference Name, a Product ID, a price, a localised display name and description, and review information. Mark `consumable: true` on the catalog's `appStore` mapping for a consumable.

## 3. Create the In-App Purchase key

The adapter signs every request to the App Store Server API with an In-App Purchase key.

1. On the App Store Connect home page, click **Users and Access**.
2. Click the **Integrations** tab.
3. In the sidebar under **Keys**, click **In-App Purchase**.
4. Click **Generate In-App Purchase Key** (or the add button if one is active already), enter a name for your own reference, and click **Generate**.
5. Download the key with **Download Key**. The private key (a `.p8` file) can be downloaded **once**; Apple keeps no copy. Store it in a secret manager and never in a repository or in client code.

Source: [Creating API keys to authorize API requests](https://developer.apple.com/documentation/appstoreserverapi/creating-api-keys-to-authorize-api-requests).

You now have three values for the adapter: the **key id** (shown with the key), the **issuer id** (shown at the top of the same Keys page) and the **text of the `.p8` file**.

For promotional offers, the key that signs offers can be the same key, or another one; pass it as `promotionalOfferKey` (`APP_STORE_OFFER_KEY_ID` and `APP_STORE_OFFER_PRIVATE_KEY`).

## 4. Point App Store Server Notifications at your server

Renewals, cancellations, refunds and revocations happen without the customer's device, so they reach you as notifications.

1. Select the app, and under **General** in the sidebar click **App Information**.
2. Scroll to **General Information**, then **App Store Server Notifications**.
3. Under **Production Server URL** click **Set Up URL**, enter the address, choose **Version 2** and click **Save**.
4. Do the same for **Sandbox Server URL**.

Source: [Enter server URLs for App Store Server Notifications](https://developer.apple.com/help/app-store-connect/configure-in-app-purchase-settings/enter-server-urls-for-app-store-server-notifications/). Two notes from that page: if you give no Sandbox URL, the App Store sends both environments to the Production URL, and if you give only a Sandbox URL, nothing is sent in production.

The address is the webhook route of the service, `https://<your-service>/v1/app_store/webhooks`, or your own route that calls `subs.webhooks.handle(Provider.AppStore, ...)`. It is a public route: Apple cannot send an API key, and the library authenticates every notification by its signature (a JWS that chains to Apple Root CA - G3), not by who sent it. Expose only the webhook routes publicly: [Running the HTTP service](./http-service.md#network-exposure-rules). Answer `200` once you have handled a notification; Apple retries a `40x` or `50x` in production.

## 5. Give the service its settings

```text
APP_STORE_BUNDLE_ID=com.example.app
APP_STORE_ISSUER_ID=<issuer id>
APP_STORE_KEY_ID=<key id>
APP_STORE_PRIVATE_KEY=<text of the .p8 file>
APP_STORE_ENVIRONMENT=test
APP_STORE_APP_APPLE_ID=<the app's Apple id>
```

`APP_STORE_ENVIRONMENT` is `test` for the sandbox and `live` for production; `live` also needs `APP_STORE_APP_APPLE_ID` (App Store Connect, App Information), because production notifications name it. The private key can be written with `\n` for its line breaks. The full list is in [Environment variables](../reference/generated/environment.md#app-store); with the library, the same settings are the options of [`appStore(...)`](../gateways/app-store.md#configuration).

## 6. Add the capability to the app

In Xcode, add the **In-App Purchase** capability to the app target (the Runner target of a Flutter app, the app target of a React Native app). The device side is done by the [iOS SDK](./mobile-apps.md#ios-sdk), or by [React Native](./mobile-apps.md#react-native) or [Flutter](./mobile-apps.md#flutter), which use it underneath: it starts the purchase for a product key, buys the product with StoreKit 2, sends the signed transaction to your backend and finishes it once your backend confirmed it. The product ids you created in step 2 are the ones the catalog's `appStore.productId` holds; the app only passes your product key.

## Test with a sandbox account

Sandbox purchases are free and use Apple's sandbox servers. Create a Sandbox Apple Account in App Store Connect: choose **Users and Access**, click **Sandbox**, then the add button, and give the tester a name, an e-mail address that is not already an Apple Account, a password and an App Store country or region. On the test device, sign in to the App Store with the sandbox account (Settings, not your own Apple Account) and enable Developer Mode. Source: [Create a Sandbox Apple Account](https://developer.apple.com/help/app-store-connect/test-in-app-purchases/create-a-sandbox-apple-account/).

Configure `Environment.Test` (the sandbox host) and the sandbox notification URL. A transaction id belongs to the environment that created it: a sandbox transaction is `NOT_FOUND` in production, and the adapter refuses signed data from the other environment. Sandbox notifications are sent once, without retries, and omit the app's Apple id.

## Before you go live

- [ ] The Paid Apps Agreement is active, and each product is in `Ready to Submit` or approved.
- [ ] `APP_STORE_ENVIRONMENT` is `live` and `APP_STORE_APP_APPLE_ID` is set.
- [ ] The Production Server URL is set with **Version 2** and answers `200`.
- [ ] The `.p8` key is in a secret manager, and nobody else holds a copy.
- [ ] The catalog's `appStore.productId` values match App Store Connect exactly.
- [ ] You sell on the India storefront: the library's amounts are INR, and a transaction in another currency is `UNSUPPORTED` for reads of charges and payments.
- [ ] The **In-App Purchase** capability is on the app target, and the app uses the iOS SDK (or React Native or Flutter on iPhone).
- [ ] Your iOS app does not steer customers to other ways to pay (App Review Guideline 3.1.1(a)).

See also [Apple App Store](../gateways/app-store.md) and [Selling on iPhone, Android and the web](./purchases.md).
