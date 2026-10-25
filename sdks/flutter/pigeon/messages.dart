import 'package:pigeon/pigeon.dart';

// The interface between Dart and the two native SDKs. After editing this file,
// run
//   dart run pigeon --input pigeon/messages.dart
// to regenerate the Dart, Kotlin and Swift sides.
//
// The messages carry data only. Every value that a native SDK models as an open
// enumeration or as a sealed type travels as a string (`kind`, `reason`, ...), so
// a value that a newer native SDK adds reaches Dart as text instead of failing
// in the codec. Dart turns the text into the public sealed classes and enums
// (lib/src/mapping.dart), with an "unknown" variant for what it does not know.
//
// Times are milliseconds since the Unix epoch.

@ConfigurePigeon(
  PigeonOptions(
    dartPackageName: 'india_subscriptions',
    dartOut: 'lib/src/messages.g.dart',
    kotlinOut:
        'android/src/main/kotlin/dev/indiasubscriptions/flutter/Messages.g.kt',
    kotlinOptions: KotlinOptions(package: 'dev.indiasubscriptions.flutter'),
    swiftOut: [
      'ios/india_subscriptions/Sources/india_subscriptions/Messages.g.swift',
    ],
  ),
)
/// The five relative paths of the merchant backend. A null path keeps the
/// native SDK's default.
class PurchasePathsMessage {
  PurchasePathsMessage({
    this.start,
    this.session,
    this.alternative,
    this.complete,
    this.entitlements,
  });

  String? start;
  String? session;
  String? alternative;
  String? complete;
  String? entitlements;
}

/// Everything `configure` takes. A null value keeps the native SDK's default.
class ConfigureRequest {
  ConfigureRequest({
    required this.baseUrl,
    this.authorization,
    this.headers,
    this.paths,
    this.timeoutMillis,
    this.maxCompletionAttempts,
    this.retryDelayMillis,
    this.maxServerFailures,
    this.finishUnmatchedTransactions,
    this.allowBasePlanFallback,
    this.enablePrepaidPlans,
    this.allowCleartextCheckout,
    required this.start,
  });

  String baseUrl;

  /// The first value of the `Authorization` header; changed later with
  /// `setAuthorization`.
  String? authorization;

  /// Extra request headers (iOS only; Android reports that it cannot send them).
  Map<String, String>? headers;
  PurchasePathsMessage? paths;
  int? timeoutMillis;
  int? maxCompletionAttempts;
  int? retryDelayMillis;
  int? maxServerFailures;

  /// iOS only.
  bool? finishUnmatchedTransactions;

  /// Android only.
  bool? allowBasePlanFallback;

  /// Android only.
  bool? enablePrepaidPlans;

  /// Android only: open `http` checkout pages (local development).
  bool? allowCleartextCheckout;

  /// Whether `configure` also starts the native listeners.
  bool start;
}

class CustomerMessage {
  CustomerMessage({this.id, this.name, this.email, this.phone, this.state});

  String? id;
  String? name;
  String? email;
  String? phone;
  String? state;
}

class PurchaseRequest {
  PurchaseRequest({
    required this.product,
    required this.customerRef,
    required this.customer,
    this.reference,
    this.returnUrl,
  });

  String product;
  String customerRef;
  CustomerMessage customer;
  String? reference;
  String? returnUrl;
}

class PurchaseOptionMessage {
  PurchaseOptionMessage({
    required this.channel,
    required this.provider,
    required this.handle,
    required this.checkoutKind,
    this.storeProductId,
    this.hostedUrl,
  });

  String channel;
  String provider;
  String handle;
  String checkoutKind;
  String? storeProductId;
  String? hostedUrl;
}

class PurchaseSessionMessage {
  PurchaseSessionMessage({
    required this.id,
    required this.platform,
    required this.product,
    required this.policy,
    required this.status,
    required this.customerRef,
    required this.options,
    required this.createdAt,
    required this.expiresAt,
    this.reference,
    this.returnUrl,
    this.completedAt,
    this.subscriptionId,
    this.paymentId,
    this.provider,
  });

  String id;
  String platform;
  String product;
  String policy;
  String status;
  String customerRef;
  List<PurchaseOptionMessage> options;
  int createdAt;
  int expiresAt;
  String? reference;
  String? returnUrl;
  int? completedAt;
  String? subscriptionId;
  String? paymentId;
  String? provider;
}

/// Why a purchase did not finish with the backend.
class PurchaseFailureMessage {
  PurchaseFailureMessage({
    required this.reason,
    required this.message,
    this.code,
  });

  /// The native reason, by name.
  String reason;
  String message;

  /// The server's error code, when the backend answered with one.
  String? code;
}

/// Why Google Play did not take a purchase (Android).
class BillingFailureMessage {
  BillingFailureMessage({
    required this.reason,
    required this.responseCode,
    required this.message,
    required this.isTransient,
    this.subResponseCode,
  });

  String reason;
  int responseCode;
  String message;
  bool isTransient;
  int? subResponseCode;
}

/// The result of `purchase`. `kind` is one of the native outcome names
/// (`completed`, `pending`, `cancelled`, `unverified`, `awaitingBackend`,
/// `rejected`, `awaitingReturn`, `failed`).
class PurchaseOutcomeMessage {
  PurchaseOutcomeMessage({
    required this.kind,
    this.session,
    this.failure,
    this.billingFailure,
    this.reason,
  });

  String kind;
  PurchaseSessionMessage? session;
  PurchaseFailureMessage? failure;
  BillingFailureMessage? billingFailure;

  /// The text of an `unverified` outcome.
  String? reason;
}

/// A purchase that moved without the app asking for it. `kind` is one of
/// `completed`, `pending`, `awaitingBackend`, `rejected`, `hostedCheckoutOpened`,
/// `unmatchedPurchase`, `unverifiedTransaction`.
class PurchaseEventMessage {
  PurchaseEventMessage({
    required this.kind,
    this.session,
    this.sessionId,
    this.failure,
    this.transactionId,
    this.purchaseToken,
    this.productIds,
    this.reason,
  });

  String kind;
  PurchaseSessionMessage? session;
  String? sessionId;
  PurchaseFailureMessage? failure;

  /// The App Store transaction id (iOS), as text.
  String? transactionId;

  /// The Google Play purchase token (Android).
  String? purchaseToken;
  List<String>? productIds;
  String? reason;
}

/// What the app link led to (Android). `kind` is one of `ignored`, `completed`,
/// `notPaid`, `stillPending`, `backendFailed`.
class ReturnLinkResultMessage {
  ReturnLinkResultMessage({required this.kind, this.session, this.failure});

  String kind;
  PurchaseSessionMessage? session;
  PurchaseFailureMessage? failure;
}

class EntitlementItemMessage {
  EntitlementItemMessage({
    required this.product,
    required this.kind,
    required this.provider,
    required this.channel,
    required this.platform,
    required this.status,
    required this.active,
    required this.updatedAt,
    this.subscriptionId,
    this.paymentId,
    this.cancelAtPeriodEnd,
    this.currentPeriodEnd,
  });

  String product;
  String kind;
  String provider;
  String channel;
  String platform;
  String status;
  bool active;
  int updatedAt;
  String? subscriptionId;
  String? paymentId;
  bool? cancelAtPeriodEnd;
  int? currentPeriodEnd;
}

class EntitlementsMessage {
  EntitlementsMessage({
    required this.customerRef,
    required this.active,
    required this.items,
  });

  String customerRef;
  bool active;
  List<EntitlementItemMessage> items;
}

/// Calls from Dart to the native SDKs.
///
/// Errors come back as a `PlatformException` whose code is one of
/// `not_configured`, `backend`, `purchase`, `unsupported_on_platform`,
/// `invalid_argument` or `unexpected`; lib/src/errors.dart turns them into typed
/// exceptions.
@HostApi()
abstract class PurchasesHostApi {
  /// Builds the native purchase client (replacing and stopping an earlier one,
  /// which is what a hot restart does).
  @async
  void configure(ConfigureRequest request);

  /// Replaces the `Authorization` header value; null sends no header.
  @async
  void setAuthorization(String? authorization);

  @async
  PurchaseOutcomeMessage purchase(PurchaseRequest request);

  @async
  EntitlementsMessage entitlements(String customerRef);

  @async
  EntitlementsMessage restorePurchases(String customerRef);

  /// iOS: `processUnfinishedTransactions`. Android: `processPendingPurchases`.
  @async
  List<PurchaseEventMessage> processPendingPurchases();

  @async
  List<PurchaseEventMessage> retryRejectedPurchases();

  /// Stops the native listeners and drops the client.
  @async
  void dispose();

  /// iOS only: shows the App Store's manage-subscriptions sheet.
  @async
  void showManageSubscriptions();

  /// iOS only: shows the refund-request sheet. Returns `submitted` or
  /// `cancelled`.
  @async
  String requestRefund(String transactionId);

  /// Android only: Google Play's subscription management page.
  @async
  String subscriptionManagementUrl(String? productId);

  /// Android only: opens [subscriptionManagementUrl].
  @async
  void openSubscriptionManagement(String? productId);

  /// Android only: reads the outcome of a hosted checkout from a return link.
  @async
  ReturnLinkResultMessage handleReturnLink(String link);
}

/// Events from the native SDKs to Dart.
@EventChannelApi()
abstract class PurchaseStreams {
  /// Purchases that moved outside a `purchase` call.
  PurchaseEventMessage purchaseEvents();

  /// Outcomes of return links the Android activity was opened with, as launch
  /// intent or as new intent.
  ReturnLinkResultMessage returnLinkResults();
}
