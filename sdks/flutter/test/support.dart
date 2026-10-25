import 'package:flutter/services.dart';
import 'package:india_subscriptions/src/messages.g.dart';

/// A host API that records its calls and answers from closures.
class FakeHost implements PurchasesHostApi {
  final calls = <String>[];
  ConfigureRequest? configured;
  PurchaseRequest? purchased;
  String? authorization;
  Object? error;

  PurchaseOutcomeMessage outcome = PurchaseOutcomeMessage(kind: 'cancelled');
  EntitlementsMessage entitlementsAnswer = EntitlementsMessage(
    customerRef: 'c',
    active: false,
    items: [],
  );
  List<PurchaseEventMessage> eventsAnswer = [];
  String refundAnswer = 'submitted';
  ReturnLinkResultMessage linkAnswer = ReturnLinkResultMessage(kind: 'ignored');

  T _run<T>(String name, T Function() answer) {
    calls.add(name);
    final failure = error;
    if (failure != null) throw failure;
    return answer();
  }

  @override
  Future<void> configure(ConfigureRequest request) async =>
      _run('configure', () => configured = request);

  @override
  Future<void> setAuthorization(String? authorization) async =>
      _run('setAuthorization', () => this.authorization = authorization);

  @override
  Future<PurchaseOutcomeMessage> purchase(PurchaseRequest request) async =>
      _run('purchase', () {
        purchased = request;
        return outcome;
      });

  @override
  Future<EntitlementsMessage> entitlements(String customerRef) async =>
      _run('entitlements:$customerRef', () => entitlementsAnswer);

  @override
  Future<EntitlementsMessage> restorePurchases(String customerRef) async =>
      _run('restorePurchases:$customerRef', () => entitlementsAnswer);

  @override
  Future<List<PurchaseEventMessage>> processPendingPurchases() async =>
      _run('processPendingPurchases', () => eventsAnswer);

  @override
  Future<List<PurchaseEventMessage>> retryRejectedPurchases() async =>
      _run('retryRejectedPurchases', () => eventsAnswer);

  @override
  Future<void> dispose() async => _run('dispose', () {});

  @override
  Future<void> showManageSubscriptions() async =>
      _run('showManageSubscriptions', () {});

  @override
  Future<String> requestRefund(String transactionId) async =>
      _run('requestRefund:$transactionId', () => refundAnswer);

  @override
  Future<String> subscriptionManagementUrl(String? productId) async => _run(
    'subscriptionManagementUrl:$productId',
    () => 'https://play.google.com/x',
  );

  @override
  Future<void> openSubscriptionManagement(String? productId) async =>
      _run('openSubscriptionManagement:$productId', () {});

  @override
  Future<ReturnLinkResultMessage> handleReturnLink(String link) async =>
      _run('handleReturnLink:$link', () => linkAnswer);

  @override
  // ignore: non_constant_identifier_names
  BinaryMessenger? get pigeonVar_binaryMessenger => null;

  @override
  // ignore: non_constant_identifier_names
  String get pigeonVar_messageChannelSuffix => '';
}

PurchaseSessionMessage sessionMessage({
  String status = 'completed',
  String platform = 'ios',
  List<PurchaseOptionMessage>? options,
}) => PurchaseSessionMessage(
  id: 'sess_1',
  platform: platform,
  product: 'pro_monthly',
  policy: 'store',
  status: status,
  customerRef: 'cust_1',
  options:
      options ??
      [
        PurchaseOptionMessage(
          channel: 'store',
          provider: 'app_store',
          handle: 'token-1',
          checkoutKind: 'apple_storekit',
          storeProductId: 'in.example.pro',
        ),
      ],
  createdAt: 1700000000000,
  expiresAt: 1700003600000,
  reference: 'ref-1',
  completedAt: 1700000100000,
  subscriptionId: 'sub_1',
  provider: 'app_store',
);

PurchaseFailureMessage failureMessage([String reason = 'backendUnreachable']) =>
    PurchaseFailureMessage(
      reason: reason,
      message: 'no network',
      code: 'NETWORK',
    );
