import 'package:meta/meta.dart';

import 'models.dart';

/// Why a purchase did not finish with the backend.
enum PurchaseFailureReason {
  /// The backend could not be reached, or asked the app to wait. The purchase
  /// stays unconfirmed and is sent again.
  backendUnreachable,

  /// The backend failed in a way that may or may not last. It is sent again, up
  /// to a limit.
  backendFailing,

  /// The backend refused the purchase for a reason that will not change.
  backendRefused,

  /// The backend says the purchase is not paid.
  notPaid,

  /// The backend accepted the call but has not settled the session yet.
  notSettled,

  /// The SDK retried through its limit of server failures and stopped.
  gaveUp,

  /// The transaction's account token is not the one this purchase started with.
  /// Nothing was sent (iOS).
  tokenMismatch,

  /// The hosted checkout page could not be opened (Android).
  checkoutUnavailable,

  /// A reason a newer native SDK added; see [PurchaseFailure.rawReason].
  unknown,
}

/// Why a purchase did not finish with the backend.
@immutable
class PurchaseFailure {
  const PurchaseFailure({
    required this.reason,
    required this.rawReason,
    required this.message,
    this.code,
  });

  final PurchaseFailureReason reason;

  /// The native SDK's name for the reason, as it sent it.
  final String rawReason;
  final String message;

  /// The server's error code, when the backend answered with one.
  final String? code;
}

/// Why Google Play did not take a purchase (Android).
enum BillingFailureReason {
  userCanceled,
  billingUnavailable,
  serviceUnavailable,
  serviceDisconnected,
  networkError,
  itemUnavailable,
  itemAlreadyOwned,
  itemNotOwned,
  featureNotSupported,
  developerError,
  error,

  /// A reason the native SDK does not know or a newer one added; see
  /// [BillingFailure.rawReason] and [BillingFailure.responseCode].
  unknown,
}

/// Why Google Play did not take a purchase. Nothing was charged.
@immutable
class BillingFailure {
  const BillingFailure({
    required this.reason,
    required this.rawReason,
    required this.responseCode,
    required this.message,
    required this.isTransient,
    this.subResponseCode,
  });

  final BillingFailureReason reason;
  final String rawReason;

  /// The `BillingResponseCode` Google returned.
  final int responseCode;

  /// Google's debug message. Not for display to customers.
  final String message;

  /// True when trying again later may work without anything else changing.
  final bool isTransient;

  /// The sub-response code of a purchase flow result, where Google set one.
  final int? subResponseCode;
}

/// What happened to a purchase the app started with `purchase`.
///
/// Match it with a `switch` and keep a branch for [UnknownPurchaseOutcome]: a
/// native SDK newer than this plugin may report an outcome it does not know.
@immutable
sealed class PurchaseOutcome {
  const PurchaseOutcome();
}

/// The backend confirmed the purchase. Grant access (the backend's entitlements
/// are the source of truth).
final class PurchaseCompleted extends PurchaseOutcome {
  const PurchaseCompleted(this.session);
  final PurchaseSession session;
}

/// A payment that settles later (Ask to Buy, a pending Google Play payment).
/// A [PurchaseCompletedEvent] arrives on `events` when it does.
final class PurchasePending extends PurchaseOutcome {
  const PurchasePending(this.session);
  final PurchaseSession session;
}

/// The customer closed the purchase screen. Nothing was charged. [session] is
/// set on Android only.
final class PurchaseCancelled extends PurchaseOutcome {
  const PurchaseCancelled([this.session]);
  final PurchaseSession? session;
}

/// StoreKit could not verify the transaction's signature (iOS). Nothing was sent
/// to the backend. Do not grant access.
final class PurchaseUnverified extends PurchaseOutcome {
  const PurchaseUnverified(this.session, this.reason);
  final PurchaseSession session;
  final String reason;
}

/// The store took the payment but the backend has not confirmed it. It is sent
/// again later; tell the customer it is being confirmed.
final class PurchaseAwaitingBackend extends PurchaseOutcome {
  const PurchaseAwaitingBackend(this.session, this.failure);
  final PurchaseSession session;
  final PurchaseFailure failure;
}

/// The backend refused the purchase for a reason that will not change.
final class PurchaseRejected extends PurchaseOutcome {
  const PurchaseRejected(this.session, this.failure);
  final PurchaseSession session;
  final PurchaseFailure failure;
}

/// The hosted checkout page is open in a Custom Tab (Android). The outcome is
/// known when the app is opened through its return link.
final class PurchaseAwaitingReturn extends PurchaseOutcome {
  const PurchaseAwaitingReturn(this.session);
  final PurchaseSession session;
}

/// Google Play did not take the purchase and nothing was charged (Android).
final class PurchaseFailed extends PurchaseOutcome {
  const PurchaseFailed(this.session, this.failure);
  final PurchaseSession session;
  final BillingFailure failure;
}

/// An outcome this version of the plugin does not know. [kind] is the native
/// SDK's name for it.
final class UnknownPurchaseOutcome extends PurchaseOutcome {
  const UnknownPurchaseOutcome(this.kind, [this.session]);
  final String kind;
  final PurchaseSession? session;
}

/// A purchase that moved without the app asking for it in a `purchase` call: a
/// payment approved later, a retry, a transaction found at launch.
///
/// Match it with a `switch` and keep a branch for [UnknownPurchaseEvent].
@immutable
sealed class PurchaseEvent {
  const PurchaseEvent();
}

/// The backend confirmed the purchase. [transactionId] is set on iOS,
/// [purchaseToken] on Android (null for a hosted checkout).
final class PurchaseCompletedEvent extends PurchaseEvent {
  const PurchaseCompletedEvent(
    this.session, {
    this.transactionId,
    this.purchaseToken,
  });
  final PurchaseSession session;
  final String? transactionId;
  final String? purchaseToken;
}

/// Google Play reports the purchase as pending (Android).
final class PurchasePendingEvent extends PurchaseEvent {
  const PurchasePendingEvent(this.sessionId, this.productIds);
  final String sessionId;
  final List<String> productIds;
}

/// The backend has not confirmed the purchase yet; it is retried.
final class PurchaseAwaitingBackendEvent extends PurchaseEvent {
  const PurchaseAwaitingBackendEvent(
    this.sessionId,
    this.failure, {
    this.transactionId,
  });
  final String sessionId;
  final PurchaseFailure failure;
  final String? transactionId;
}

/// The backend refused the purchase for a reason that will not change.
final class PurchaseRejectedEvent extends PurchaseEvent {
  const PurchaseRejectedEvent(
    this.sessionId,
    this.failure, {
    this.transactionId,
  });
  final String sessionId;
  final PurchaseFailure failure;
  final String? transactionId;
}

/// The hosted checkout page was opened for a session whose `purchase` call is no
/// longer waiting (Android).
final class HostedCheckoutOpenedEvent extends PurchaseEvent {
  const HostedCheckoutOpenedEvent(this.session);
  final PurchaseSession session;
}

/// The store reports a purchase this device has no record for (bought on
/// another device or outside the app, or the app was reinstalled). The app's
/// access follows the backend's entitlements. [transactionId] is set on iOS,
/// [purchaseToken] on Android.
final class UnmatchedPurchaseEvent extends PurchaseEvent {
  const UnmatchedPurchaseEvent({
    required this.productIds,
    this.transactionId,
    this.purchaseToken,
  });
  final List<String> productIds;
  final String? transactionId;
  final String? purchaseToken;
}

/// StoreKit delivered a transaction whose signature it could not verify (iOS).
final class UnverifiedTransactionEvent extends PurchaseEvent {
  const UnverifiedTransactionEvent(this.transactionId, this.reason);
  final String transactionId;
  final String reason;
}

/// An event this version of the plugin does not know. [kind] is the native
/// SDK's name for it.
final class UnknownPurchaseEvent extends PurchaseEvent {
  const UnknownPurchaseEvent(this.kind);
  final String kind;
}

/// What a return link of a hosted checkout led to (Android).
@immutable
sealed class ReturnLinkResult {
  const ReturnLinkResult();
}

/// The link is not for a checkout this app has pending. Nothing was read.
final class ReturnLinkIgnored extends ReturnLinkResult {
  const ReturnLinkIgnored();
}

/// The backend says the purchase is complete.
final class ReturnLinkCompleted extends ReturnLinkResult {
  const ReturnLinkCompleted(this.session);
  final PurchaseSession session;
}

/// The backend says the purchase is not paid.
final class ReturnLinkNotPaid extends ReturnLinkResult {
  const ReturnLinkNotPaid(this.session);
  final PurchaseSession session;
}

/// The session is not settled yet.
final class ReturnLinkStillPending extends ReturnLinkResult {
  const ReturnLinkStillPending(this.session);
  final PurchaseSession session;
}

/// The backend could not be reached, or refused to answer.
final class ReturnLinkBackendFailed extends ReturnLinkResult {
  const ReturnLinkBackendFailed(this.failure);
  final PurchaseFailure failure;
}

/// A result this version of the plugin does not know.
final class UnknownReturnLinkResult extends ReturnLinkResult {
  const UnknownReturnLinkResult(this.kind);
  final String kind;
}

/// Whether a refund request was sent (iOS). It says nothing about the refund
/// itself: Apple decides it, and the backend learns the result from App Store
/// Server Notifications.
enum RefundRequestOutcome {
  /// The customer submitted the request.
  submitted,

  /// The customer closed the sheet without submitting.
  cancelled,

  /// A result a newer native SDK added.
  unknown,
}
