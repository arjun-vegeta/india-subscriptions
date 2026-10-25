import 'messages.g.dart';
import 'models.dart';
import 'outcomes.dart';

// Translation from the generated messages to the public types, and back for the
// arguments. Nothing here decides anything about a purchase: a value this
// version does not know becomes an "unknown" variant that keeps the native
// name, and a message that is missing a field its kind needs does the same.

DateTime _time(int millis) =>
    DateTime.fromMillisecondsSinceEpoch(millis, isUtc: true);

/// A session message as a [PurchaseSession].
PurchaseSession mapSession(PurchaseSessionMessage m) => PurchaseSession(
  id: m.id,
  platform: PurchasePlatform(m.platform),
  product: m.product,
  policy: ChannelPolicy(m.policy),
  status: SessionStatus(m.status),
  customerRef: m.customerRef,
  options: [
    for (final option in m.options)
      PurchaseOption(
        channel: SalesChannel(option.channel),
        provider: PaymentProvider(option.provider),
        handle: option.handle,
        checkoutKind: option.checkoutKind,
        storeProductId: option.storeProductId,
        hostedUrl: option.hostedUrl,
      ),
  ],
  createdAt: _time(m.createdAt),
  expiresAt: _time(m.expiresAt),
  reference: m.reference,
  returnUrl: m.returnUrl,
  completedAt: m.completedAt == null ? null : _time(m.completedAt!),
  subscriptionId: m.subscriptionId,
  paymentId: m.paymentId,
  provider: m.provider == null ? null : PaymentProvider(m.provider!),
);

/// A failure message as a [PurchaseFailure]; a reason this version does not know
/// becomes [PurchaseFailureReason.unknown] with the native name kept.
PurchaseFailure mapFailure(PurchaseFailureMessage m) => PurchaseFailure(
  reason:
      _enumByName(PurchaseFailureReason.values, m.reason) ??
      PurchaseFailureReason.unknown,
  rawReason: m.reason,
  message: m.message,
  code: m.code,
);

/// A billing failure message as a [BillingFailure].
BillingFailure mapBillingFailure(BillingFailureMessage m) => BillingFailure(
  reason:
      _enumByName(BillingFailureReason.values, m.reason) ??
      BillingFailureReason.unknown,
  rawReason: m.reason,
  responseCode: m.responseCode,
  message: m.message,
  isTransient: m.isTransient,
  subResponseCode: m.subResponseCode,
);

/// An outcome message as a [PurchaseOutcome].
PurchaseOutcome mapOutcome(PurchaseOutcomeMessage m) {
  final session = m.session == null ? null : mapSession(m.session!);
  final failure = m.failure == null ? null : mapFailure(m.failure!);
  final billing = m.billingFailure == null
      ? null
      : mapBillingFailure(m.billingFailure!);
  switch (m.kind) {
    case 'completed' when session != null:
      return PurchaseCompleted(session);
    case 'pending' when session != null:
      return PurchasePending(session);
    case 'cancelled':
      return PurchaseCancelled(session);
    case 'unverified' when session != null:
      return PurchaseUnverified(session, m.reason ?? '');
    case 'awaitingBackend' when session != null && failure != null:
      return PurchaseAwaitingBackend(session, failure);
    case 'rejected' when session != null && failure != null:
      return PurchaseRejected(session, failure);
    case 'awaitingReturn' when session != null:
      return PurchaseAwaitingReturn(session);
    case 'failed' when session != null && billing != null:
      return PurchaseFailed(session, billing);
    default:
      return UnknownPurchaseOutcome(m.kind, session);
  }
}

/// An event message as a [PurchaseEvent].
PurchaseEvent mapEvent(PurchaseEventMessage m) {
  final session = m.session == null ? null : mapSession(m.session!);
  final failure = m.failure == null ? null : mapFailure(m.failure!);
  switch (m.kind) {
    case 'completed' when session != null:
      return PurchaseCompletedEvent(
        session,
        transactionId: m.transactionId,
        purchaseToken: m.purchaseToken,
      );
    case 'pending' when m.sessionId != null:
      return PurchasePendingEvent(m.sessionId!, m.productIds ?? const []);
    case 'awaitingBackend' when m.sessionId != null && failure != null:
      return PurchaseAwaitingBackendEvent(
        m.sessionId!,
        failure,
        transactionId: m.transactionId,
      );
    case 'rejected' when m.sessionId != null && failure != null:
      return PurchaseRejectedEvent(
        m.sessionId!,
        failure,
        transactionId: m.transactionId,
      );
    case 'hostedCheckoutOpened' when session != null:
      return HostedCheckoutOpenedEvent(session);
    case 'unmatchedPurchase':
      return UnmatchedPurchaseEvent(
        productIds: m.productIds ?? const [],
        transactionId: m.transactionId,
        purchaseToken: m.purchaseToken,
      );
    case 'unverifiedTransaction' when m.transactionId != null:
      return UnverifiedTransactionEvent(m.transactionId!, m.reason ?? '');
    default:
      return UnknownPurchaseEvent(m.kind);
  }
}

/// A return link message as a [ReturnLinkResult].
ReturnLinkResult mapReturnLink(ReturnLinkResultMessage m) {
  final session = m.session == null ? null : mapSession(m.session!);
  final failure = m.failure == null ? null : mapFailure(m.failure!);
  switch (m.kind) {
    case 'ignored':
      return const ReturnLinkIgnored();
    case 'completed' when session != null:
      return ReturnLinkCompleted(session);
    case 'notPaid' when session != null:
      return ReturnLinkNotPaid(session);
    case 'stillPending' when session != null:
      return ReturnLinkStillPending(session);
    case 'backendFailed' when failure != null:
      return ReturnLinkBackendFailed(failure);
    default:
      return UnknownReturnLinkResult(m.kind);
  }
}

/// An entitlements message as [Entitlements].
Entitlements mapEntitlements(EntitlementsMessage m) => Entitlements(
  customerRef: m.customerRef,
  active: m.active,
  items: [
    for (final item in m.items)
      EntitlementItem(
        product: item.product,
        kind: ProductKind(item.kind),
        provider: PaymentProvider(item.provider),
        channel: SalesChannel(item.channel),
        platform: PurchasePlatform(item.platform),
        status: EntitlementStatus(item.status),
        active: item.active,
        updatedAt: _time(item.updatedAt),
        subscriptionId: item.subscriptionId,
        paymentId: item.paymentId,
        cancelAtPeriodEnd: item.cancelAtPeriodEnd,
        currentPeriodEnd: item.currentPeriodEnd == null
            ? null
            : _time(item.currentPeriodEnd!),
      ),
  ],
);

/// The refund sheet's result text as a [RefundRequestOutcome].
RefundRequestOutcome mapRefundOutcome(String raw) =>
    _enumByName(RefundRequestOutcome.values, raw) ??
    RefundRequestOutcome.unknown;

/// The `purchase` arguments as the request message.
PurchaseRequest buildPurchaseRequest({
  required String product,
  required String customerRef,
  required Customer customer,
  String? reference,
  String? returnUrl,
}) => PurchaseRequest(
  product: product,
  customerRef: customerRef,
  customer: CustomerMessage(
    id: customer.id,
    name: customer.name,
    email: customer.email,
    phone: customer.phone,
    state: customer.state,
  ),
  reference: reference,
  returnUrl: returnUrl,
);

/// The `configure` arguments as the request message.
ConfigureRequest buildConfigureRequest({
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
  required bool start,
}) => ConfigureRequest(
  baseUrl: baseUrl,
  authorization: authorization,
  headers: headers,
  paths: paths == null
      ? null
      : PurchasePathsMessage(
          start: paths.start,
          session: paths.session,
          alternative: paths.alternative,
          complete: paths.complete,
          entitlements: paths.entitlements,
        ),
  timeoutMillis: timeout?.inMilliseconds,
  maxCompletionAttempts: maxCompletionAttempts,
  retryDelayMillis: retryDelay?.inMilliseconds,
  maxServerFailures: maxServerFailures,
  finishUnmatchedTransactions: finishUnmatchedTransactions,
  allowBasePlanFallback: allowBasePlanFallback,
  enablePrepaidPlans: enablePrepaidPlans,
  allowCleartextCheckout: allowCleartextCheckout,
  start: start,
);

T? _enumByName<T extends Enum>(List<T> values, String name) {
  for (final value in values) {
    if (value.name == name) return value;
  }
  return null;
}
