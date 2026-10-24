# Setting up Google Play

After this page you will have everything the Google Play adapter needs: a service account with the right permissions, a Pub/Sub topic with an authenticated push subscription pointing at your server, products with base plans and offers, license testers, and, if you use it, enrolment in user choice billing. Google's consoles change over time, so each step names the Google page it comes from; follow that page if a menu has moved.

## 1. Billing basics in Play Console

To sell in-app purchases you need a Google Play developer account with a linked payments profile, and an app published to any track (the internal test track will do) with the Play Billing Library in it. Play Console enables the billing features once such a version exists. Use Play Billing Library 8 or later (9.1.0 is current); the `Sku*` classes are gone. Source: [Getting ready](https://developer.android.com/google/play/billing/getting-ready).

## 2. Create the service account

The adapter calls the Google Play Developer API as a service account.

1. In the Google Cloud project you will use, open the Google Play Android Developer API page and click **Enable**.
2. Open the **Service Accounts** page and click **Create service account**. Create a key (JSON) for it.
3. In Play Console, open **Users & permissions** and click **Invite new users**. Enter the service account's e-mail address.
4. Grant the rights **View financial data, orders, and cancellation survey responses** and **Manage orders and subscriptions**, then click **Invite user**.

Source: [Getting started with the Google Play Developer API](https://developers.google.com/android-publisher/getting_started). The two permissions are what [Getting ready](https://developer.android.com/google/play/billing/getting-ready#dev-api) and [Report external transactions](https://developer.android.com/google/play/billing/outside-gpb-backend) ask for: reading purchases, acknowledging them, refunding, cancelling, and reporting external transactions.

From the JSON key you need two values: `client_email` and `private_key` (and optionally `private_key_id`). They are `GOOGLE_PLAY_CLIENT_EMAIL` and `GOOGLE_PLAY_PRIVATE_KEY`; the key may be written with `\n` for its line breaks. Keep the file in a secret manager.

## 3. Create the products

Product ids are permanent: they cannot be changed or reused after creation, and base plan ids and offer ids are permanent once activated.

**A subscription.** In Play Console go to **Monetize with Play**, **Products**, **Subscriptions** and click **Create subscription**. Enter a **Product ID** and a name. Open it, click **Add base plan**, choose a **Base plan ID** and a type (auto-renewing, prepaid or installments), set the billing period, choose the countries or regions and the price for each, then **Save** and **Activate**. A subscription needs at least one active base plan before anyone can buy it.

**A free trial or an introductory price.** Offers are linked to a base plan: in **Base plans and offers** click **Add offer**, choose the base plan and an **Offer ID**, choose who is eligible, add a phase (a **Free trial** of 3 days to 3 years, or an introductory price), then **Save** and **Activate**. The library cannot add a trial: `trial` on a store product is refused with `UNSUPPORTED`, and the message says to pass the offer's id as `storeProduct.offerId`.

Source: [Create and manage subscriptions](https://support.google.com/googleplay/android-developer/answer/140504).

**A one-time product.** Play Console calls it a managed product ([Create a managed product](https://support.google.com/googleplay/android-developer/answer/1153481)). It needs a product id, a title, a description and a price. Mark `consumable: true` on the catalog's `googlePlay` mapping for one the customer can buy again (coins); the adapter then consumes it, and acknowledges any other.

The catalog's `googlePlay` mapping is `{ productId, basePlanId, offerId? }` for a subscription and `{ productId }` for a one-time product.

## 4. Create the Pub/Sub topic and the push subscription

Real-time developer notifications tell you about renewals, cancellations, holds and refunds. They arrive through Google Cloud Pub/Sub, and the adapter accepts them only with Google's authentication.

1. **Create a topic** in the Cloud project (a name such as `play-notifications`). The topic is named `projects/{project_id}/topics/{topic_name}`.
2. **Let Google Play publish to it.** Open the topic's permissions, add the principal `google-play-developer-notifications@system.gserviceaccount.com` and grant it the **Pub/Sub Publisher** role. Source: [Getting ready](https://developer.android.com/google/play/billing/getting-ready#configure-rtdn). If your organisation's domain restricted sharing blocks this, add an exception for that service account.
3. **Create a service account for push authentication** (it can be a new one, such as `pubsub-push`). Its e-mail is the adapter's `pushServiceAccountEmail`.
4. **Let Pub/Sub sign as it.** Grant the Pub/Sub service agent, `service-{PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com`, the role `roles/iam.serviceAccountTokenCreator`. The person creating the subscription needs `iam.serviceAccounts.actAs` on the push service account.
5. **Create a push subscription** to the topic whose endpoint is your webhook route, with authentication enabled and an audience you choose. The audience is the adapter's `pushAudience`; use the endpoint address itself unless you have a reason not to.

```bash
gcloud pubsub subscriptions create play-notifications-push --topic=play-notifications --push-endpoint=https://billing.example.com/v1/google_play/webhooks --push-auth-service-account=pubsub-push@example-project.iam.gserviceaccount.com --push-auth-token-audience=https://billing.example.com/v1/google_play/webhooks
```

Source: [Authenticate push subscriptions](https://docs.cloud.google.com/pubsub/docs/authenticate-push-subscriptions).

With both `pushAudience` and `pushServiceAccountEmail` set, the adapter checks the Google-signed token on every push: the RS256 signature against Google's published keys, the issuer, the audience, the expiry, the e-mail and `email_verified`. Without them a webhook cannot be told from a forgery, so the adapter refuses it, unless you set `acceptUnauthenticatedWebhooks` to say the route is protected another way. A push needs no API key (Pub/Sub cannot send one), so the webhook route is one of the few you expose publicly: [Running the HTTP service](./http-service.md#network-exposure-rules).

6. **Enable the notifications for the app.** In Play Console select the app, go to **Monetize**, **Monetization setup**, find **Real-time developer notifications**, select **Enable real-time notifications**, and enter the full topic name. Click **Send Test Message**: a test notification arrives at your endpoint as an `unknown` event. Choose **Get all notifications for subscriptions and one-time products** if you sell one-time products (the other choice leaves out `ONE_TIME_PRODUCT_PURCHASED` and `ONE_TIME_PRODUCT_CANCELED`), then **Save changes**.

Each Android app is configured separately. You can use one Cloud project for several apps, and the Developer API access must be in one project.

## 5. Give the service its settings

```text
GOOGLE_PLAY_PACKAGE_NAME=com.example.app
GOOGLE_PLAY_CLIENT_EMAIL=billing@example-project.iam.gserviceaccount.com
GOOGLE_PLAY_PRIVATE_KEY=<private_key of the JSON key>
GOOGLE_PLAY_ENVIRONMENT=test
GOOGLE_PLAY_PUSH_AUDIENCE=https://billing.example.com/v1/google_play/webhooks
GOOGLE_PLAY_PUSH_SERVICE_ACCOUNT_EMAIL=pubsub-push@example-project.iam.gserviceaccount.com
```

`GOOGLE_PLAY_ENVIRONMENT` is `test` to accept purchases made by license testers and `live` to refuse them. The full list, with `GOOGLE_PLAY_REVOKE_ON_REFUND` and `GOOGLE_PLAY_CONSUMABLE_PRODUCT_IDS`, is in [Environment variables](../reference/generated/environment.md#google-play); with the library, the same settings are the options of [`googlePlay(...)`](../gateways/google-play.md#configuration).

## 6. Test with license testers

Add the Google accounts of your testers as license testers in Play Console (see [Test in-app billing with application licensing](https://support.google.com/googleplay/android-developer/answer/6062777)). Their purchases are not charged, they carry a test marker, and with `GOOGLE_PLAY_ENVIRONMENT=live` the adapter refuses to grant anything for them. License testers are also how you test user choice billing: you are not invoiced for transactions started by their accounts.

## Enrol in user choice billing

Skip this if your Android policy is `store`. For `user_choice` Google requires you to enrol:

1. Review the requirements on [Understanding user choice billing on Google Play](https://support.google.com/googleplay/android-developer/answer/13821247): the app must offer alternative billing to mobile and tablet users in India.
2. In Play Console go to **Manage account**, **Play apps settings**, **Monetization settings**, **Alternative billing**. Accept the terms of service and set up a payment profile if required.
3. Wait for Google's e-mail confirming onboarding. It carries the instructions for enrolling your app, implementing the APIs and meeting the program requirements.

What the program asks of you, as Google states it on [the program page](https://support.google.com/googleplay/android-developer/answer/13306652): Google Play billing stays an option beside yours, Google renders the information and choice screens when you use the alternative billing APIs, transactions are reported within 24 hours of the payment's authorisation, and an adjusted service fee applies to transactions made outside Google Play's billing. The library queues and sends the reports; see [Google's user choice billing](./purchases.md#google-user-choice-billing).

## Before you go live

- [ ] The service account has **View financial data** and **Manage orders and subscriptions**, and the JSON key is in a secret manager.
- [ ] The push subscription has authentication on, and `pushAudience` and `pushServiceAccountEmail` match it exactly.
- [ ] Real-time developer notifications are enabled for the app, with the right notification types, and the test message arrived.
- [ ] Base plans and offers are **active**, and the catalog's `googlePlay` mapping matches the ids exactly.
- [ ] `GOOGLE_PLAY_ENVIRONMENT` is `live`.
- [ ] For user choice billing: you are enrolled, the products carry `taxRateBps`, `customer.state` is collected, `PUBLIC_BASE_URL` is set and the report queue is flushed on a schedule with an alert on `overdue`.
- [ ] A purchase that never reaches your server is not acknowledged and Google refunds it after three days: the app retries the completion until the backend confirms it.

See also [Google Play](../gateways/google-play.md) and [Selling on iPhone, Android and the web](./purchases.md).
