import 'package:flutter/services.dart';
import 'package:meta/meta.dart';

import 'errors.dart';
import 'mapping.dart';
import 'messages.g.dart' as wire;
import 'models.dart';
import 'outcomes.dart';

/// Sells subscriptions and one-time purchases through the app stores, with the
/// `india-subscriptions` backend, on iOS and Android.
///
/// The plugin holds no purchase logic. Every flow, retry and persistence rule
/// lives in the native SDKs (`IndiaSubscriptions` for iOS, `dev.indiasubscriptions`
/// for Android); this class translates calls, results and events.
///
/// Calls that apply to one platform only (`showManageSubscriptions` and
/// `requestRefund` on iOS; `subscriptionManagementUrl`,
/// `openSubscriptionManagement` and `handleReturnLink` on Android) throw
/// [UnsupportedOnPlatformException] on the other one.
class IndiaSubscriptions {
  /// Creates an instance. [hostApi], [purchaseEvents] and [returnLinkResults]
  /// replace the platform channels in tests.
  IndiaSubscriptions({
    @visibleForTesting wire.PurchasesHostApi? hostApi,
    @visibleForTesting
    Stream<wire.PurchaseEventMessage> Function()? purchaseEvents,
    @visibleForTesting
    Stream<wire.ReturnLinkResultMessage> Function()? returnLinkResults,
  }) : _host = hostApi ?? wire.PurchasesHostApi(),
       _purchaseEvents = purchaseEvents ?? wire.purchaseEvents,
       _returnLinkResults = returnLinkResults ?? wire.returnLinkResults;

  /// The instance an app uses.
  static final IndiaSubscriptions instance = IndiaSubscriptions();

  final wire.PurchasesHostApi _host;
  final Stream<wire.PurchaseEventMessage> Function() _purchaseEvents;
  final Stream<wire.ReturnLinkResultMessage> Function() _returnLinkResults;

  /// Builds the native purchase client for the backend at [baseUrl] and, unless
  /// [start] is false, starts its listeners (the transaction listener on iOS, the
  /// billing connection and the pass over pending purchases on Android).
  ///
  /// Call it once at launch, after listening to [events] so that no event is
  /// missed. Calling it again replaces the client, which is what a hot restart
  /// does.
  ///
  /// - [baseUrl]: the root of your backend, which forwards the service's
  ///   purchase calls. The app never holds the service's API key.
  /// - [authorization]: the first value of the `Authorization` header; call
  ///   [setAuthorization] when the user's token changes.
  /// - [headers]: fixed extra request headers sent with every call, on both
  ///   platforms. The `Authorization` header always comes from [authorization]
  ///   and [setAuthorization]; `Accept` and `Content-Type` are the SDK's own.
  /// - [paths]: where your backend mounts the five routes.
  /// - [timeout], [maxCompletionAttempts], [retryDelay] and [maxServerFailures]
  ///   tune the native SDKs' retry rules.
  /// - [finishUnmatchedTransactions] is iOS only. [allowBasePlanFallback],
  ///   [enablePrepaidPlans] and [allowCleartextCheckout] are Android only. A
  ///   platform ignores the options of the other one.
  Future<void> configure({
    required String baseUrl,
    String? authorization,
    Map<String, String>? headers,
    PurchasePaths? paths,
    Duration? timeout,
    int? maxCompletionAttempts,
    Duration? retryDelay,
    int? maxServerFailures,
    bool? finishUnmatchedTransactions,
    bool? allowBasePlanFallback,
    bool? enablePrepaidPlans,
    bool? allowCleartextCheckout,
    bool start = true,
  }) => _guard(
    () => _host.configure(
      buildConfigureRequest(
        baseUrl: baseUrl,
        authorization: authorization,
        headers: headers,
        paths: paths,
        timeout: timeout,
        maxCompletionAttempts: maxCompletionAttempts,
        retryDelay: retryDelay,
        maxServerFailures: maxServerFailures,
        finishUnmatchedTransactions: finishUnmatchedTransactions,
        allowBasePlanFallback: allowBasePlanFallback,
        enablePrepaidPlans: enablePrepaidPlans,
        allowCleartextCheckout: allowCleartextCheckout,
        start: start,
      ),
    ),
  );

  /// Replaces the `Authorization` header value the native backend sends (for
  /// example `Bearer <token>`) when the app's token changes. Null sends no
  /// header. The next request uses it.
  Future<void> setAuthorization(String? authorization) =>
      _guard(() => _host.setAuthorization(authorization));

  /// Buys the product with the key [productKey] (the key your backend's
  /// catalogue knows it by).
  ///
  /// Starts a session with your backend and follows what the platform's SDK does:
  /// StoreKit on iOS, Google Play Billing (or the hosted checkout) on Android.
  /// Throws [BackendException] when the start call fails and
  /// [PurchaseStartException] when the SDK cannot run the purchase; nothing was
  /// charged then.
  ///
  /// - [customerRef]: your id for the customer; entitlements are kept under it.
  /// - [reference]: your own id for this purchase (at most 25 characters of
  ///   letters, digits, `_` and `-`). Starting again with the same reference and
  ///   customer returns the same session.
  /// - [returnUrl]: Android: the app link the hosted checkout sends the customer
  ///   back to.
  Future<PurchaseOutcome> purchase(
    String productKey, {
    required String customerRef,
    Customer customer = const Customer(),
    String? reference,
    String? returnUrl,
  }) => _guard(() async {
    final message = await _host.purchase(
      buildPurchaseRequest(
        product: productKey,
        customerRef: customerRef,
        customer: customer,
        reference: reference,
        returnUrl: returnUrl,
      ),
    );
    return mapOutcome(message);
  });

  /// Purchases that moved outside a `purchase` call: a payment approved later, a
  /// retry that succeeded, a purchase found at launch. Listen before [configure].
  /// The native SDKs do not replay events, and the plugin keeps the newest 64
  /// until the first listener arrives.
  Stream<PurchaseEvent> get events => _purchaseEvents().map(mapEvent);

  /// Outcomes of return links the Android activity was opened with, whether as
  /// the launch intent or as a new intent while the app runs. Links that are not
  /// for a pending checkout are not reported. Never emits on iOS.
  Stream<ReturnLinkResult> get returnLinkResults =>
      _returnLinkResults().map(mapReturnLink);

  /// What the customer owns, from the backend (the source of truth).
  Future<Entitlements> entitlements(String customerRef) => _guard(
    () async => mapEntitlements(await _host.entitlements(customerRef)),
  );

  /// Syncs with the store and returns the backend's entitlements. On iOS this
  /// calls `AppStore.sync()`, which prompts the customer to sign in, so call it
  /// from an explicit user action. On Android the store needs no restore call: it
  /// processes the pending purchases and reads the entitlements.
  Future<Entitlements> restorePurchases(String customerRef) => _guard(
    () async => mapEntitlements(await _host.restorePurchases(customerRef)),
  );

  /// Sends the unfinished transactions (iOS) or pending purchases (Android) to the
  /// backend. Call it when the app returns to the foreground or the user signs
  /// in. The events it produced are also published on [events].
  Future<List<PurchaseEvent>> processPendingPurchases() => _guard(
    () async => [
      for (final event in await _host.processPendingPurchases())
        mapEvent(event),
    ],
  );

  /// Clears the "refused" mark of every rejected purchase and sends them again.
  /// Use it after you fixed what the backend refused them for.
  Future<List<PurchaseEvent>> retryRejectedPurchases() => _guard(
    () async => [
      for (final event in await _host.retryRejectedPurchases()) mapEvent(event),
    ],
  );

  /// iOS only: shows the App Store's manage-subscriptions sheet. The server can
  /// neither cancel nor refund an App Store purchase.
  Future<void> showManageSubscriptions() =>
      _guard(_host.showManageSubscriptions);

  /// iOS only: shows the refund-request sheet for the App Store transaction
  /// [transactionId] (the entitlement's payment or latest transaction id).
  Future<RefundRequestOutcome> requestRefund(String transactionId) => _guard(
    () async => mapRefundOutcome(await _host.requestRefund(transactionId)),
  );

  /// Android only: Google Play's subscription management page for the
  /// subscription [productId], or the list of the customer's subscriptions.
  Future<String> subscriptionManagementUrl({String? productId}) =>
      _guard(() => _host.subscriptionManagementUrl(productId));

  /// Android only: opens [subscriptionManagementUrl].
  Future<void> openSubscriptionManagement({String? productId}) =>
      _guard(() => _host.openSubscriptionManagement(productId));

  /// Android only: reads the outcome of a hosted checkout from a return [link].
  /// The plugin already passes the links the activity is opened with to the
  /// native SDK and reports them on [returnLinkResults]; call this for a link
  /// your own deep link handler received. The link is not trusted: the result
  /// is what the backend says.
  Future<ReturnLinkResult> handleReturnLink(String link) =>
      _guard(() async => mapReturnLink(await _host.handleReturnLink(link)));

  /// Stops the native listeners and drops the client. [configure] works again
  /// afterwards.
  Future<void> dispose() => _guard(_host.dispose);

  Future<T> _guard<T>(Future<T> Function() call) async {
    try {
      return await call();
    } on PlatformException catch (error) {
      throw translateError(error);
    }
  }
}
