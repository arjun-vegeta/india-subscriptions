import 'package:flutter_test/flutter_test.dart';
import 'package:india_subscriptions/india_subscriptions.dart';
import 'package:india_subscriptions/src/mapping.dart';
import 'package:india_subscriptions/src/messages.g.dart';

import 'support.dart';

void main() {
  group('session and entitlements', () {
    test('a session keeps every field and turns millis into UTC times', () {
      final session = mapSession(sessionMessage());
      expect(session.id, 'sess_1');
      expect(session.platform, PurchasePlatform.ios);
      expect(session.policy, ChannelPolicy.store);
      expect(session.status, SessionStatus.completed);
      expect(session.createdAt, DateTime.utc(2023, 11, 14, 22, 13, 20));
      expect(session.expiresAt.difference(session.createdAt).inMinutes, 60);
      expect(session.completedAt, isNotNull);
      expect(session.provider, PaymentProvider.appStore);
      expect(session.options.single.channel, SalesChannel.store);
      expect(session.options.single.storeProductId, 'in.example.pro');
      expect(session.options.single.hostedUrl, isNull);
    });

    test('values a newer server adds stay as text', () {
      final session = mapSession(
        sessionMessage(status: 'on_hold', platform: 'watchos'),
      );
      expect(session.status.value, 'on_hold');
      expect(session.status == SessionStatus.completed, isFalse);
      expect(session.platform.value, 'watchos');
    });

    test('entitlements answer hasAccess from active items only', () {
      final entitlements = mapEntitlements(
        EntitlementsMessage(
          customerRef: 'cust_1',
          active: true,
          items: [
            EntitlementItemMessage(
              product: 'pro_monthly',
              kind: 'subscription',
              provider: 'google_play',
              channel: 'store',
              platform: 'android',
              status: 'active',
              active: true,
              updatedAt: 1700000000000,
              subscriptionId: 'sub_1',
              cancelAtPeriodEnd: true,
              currentPeriodEnd: 1702592000000,
            ),
            EntitlementItemMessage(
              product: 'old',
              kind: 'one_time',
              provider: 'razorpay',
              channel: 'gateway',
              platform: 'web',
              status: 'quarantined',
              active: false,
              updatedAt: 1700000000000,
              paymentId: 'pay_1',
            ),
          ],
        ),
      );
      expect(entitlements.hasAccess('pro_monthly'), isTrue);
      expect(entitlements.hasAccess('old'), isFalse);
      expect(entitlements.activeItems, hasLength(1));
      expect(entitlements.items.first.cancelAtPeriodEnd, isTrue);
      expect(entitlements.items.first.currentPeriodEnd, isNotNull);
      expect(entitlements.items.last.status.value, 'quarantined');
      expect(entitlements.items.last.paymentId, 'pay_1');
    });
  });

  group('failures', () {
    test('every purchase failure reason maps by name', () {
      for (final reason in PurchaseFailureReason.values) {
        if (reason == PurchaseFailureReason.unknown) continue;
        final failure = mapFailure(failureMessage(reason.name));
        expect(failure.reason, reason);
        expect(failure.rawReason, reason.name);
        expect(failure.code, 'NETWORK');
      }
    });

    test('an unknown purchase failure reason keeps its raw name', () {
      final failure = mapFailure(failureMessage('quotaExceeded'));
      expect(failure.reason, PurchaseFailureReason.unknown);
      expect(failure.rawReason, 'quotaExceeded');
      expect(failure.message, 'no network');
    });

    test('every billing failure reason maps by name, others are unknown', () {
      for (final reason in BillingFailureReason.values) {
        if (reason == BillingFailureReason.unknown) continue;
        final failure = mapBillingFailure(
          BillingFailureMessage(
            reason: reason.name,
            responseCode: 6,
            message: 'm',
            isTransient: true,
            subResponseCode: 2,
          ),
        );
        expect(failure.reason, reason);
        expect(failure.subResponseCode, 2);
        expect(failure.isTransient, isTrue);
      }
      final unknown = mapBillingFailure(
        BillingFailureMessage(
          reason: 'newCode',
          responseCode: 99,
          message: 'm',
          isTransient: false,
        ),
      );
      expect(unknown.reason, BillingFailureReason.unknown);
      expect(unknown.rawReason, 'newCode');
      expect(unknown.responseCode, 99);
    });
  });

  group('outcomes', () {
    PurchaseOutcomeMessage message(
      String kind, {
      bool session = true,
      bool failure = false,
      bool billing = false,
      String? reason,
    }) => PurchaseOutcomeMessage(
      kind: kind,
      session: session ? sessionMessage() : null,
      failure: failure ? failureMessage() : null,
      billingFailure: billing
          ? BillingFailureMessage(
              reason: 'itemUnavailable',
              responseCode: 4,
              message: 'x',
              isTransient: false,
            )
          : null,
      reason: reason,
    );

    test('completed', () {
      final outcome = mapOutcome(message('completed'));
      expect(outcome, isA<PurchaseCompleted>());
      expect((outcome as PurchaseCompleted).session.id, 'sess_1');
    });

    test('pending', () {
      expect(mapOutcome(message('pending')), isA<PurchasePending>());
    });

    test('cancelled with and without a session', () {
      final iOS = mapOutcome(message('cancelled', session: false));
      expect((iOS as PurchaseCancelled).session, isNull);
      final android = mapOutcome(message('cancelled'));
      expect((android as PurchaseCancelled).session?.id, 'sess_1');
    });

    test('unverified carries the reason', () {
      final outcome = mapOutcome(message('unverified', reason: 'bad jws'));
      expect((outcome as PurchaseUnverified).reason, 'bad jws');
    });

    test('awaitingBackend and rejected carry the failure', () {
      final waiting = mapOutcome(message('awaitingBackend', failure: true));
      expect(
        (waiting as PurchaseAwaitingBackend).failure.reason,
        PurchaseFailureReason.backendUnreachable,
      );
      final rejected = mapOutcome(message('rejected', failure: true));
      expect((rejected as PurchaseRejected).failure.code, 'NETWORK');
    });

    test('awaitingReturn', () {
      expect(
        mapOutcome(message('awaitingReturn')),
        isA<PurchaseAwaitingReturn>(),
      );
    });

    test('failed carries the billing failure', () {
      final outcome = mapOutcome(message('failed', billing: true));
      expect(
        (outcome as PurchaseFailed).failure.reason,
        BillingFailureReason.itemUnavailable,
      );
    });

    test('an unknown kind becomes UnknownPurchaseOutcome with its name', () {
      final outcome = mapOutcome(message('refundedLater'));
      expect(outcome, isA<UnknownPurchaseOutcome>());
      expect((outcome as UnknownPurchaseOutcome).kind, 'refundedLater');
      expect(outcome.session?.id, 'sess_1');
    });

    test('a message missing what its kind needs is unknown, not a crash', () {
      expect(
        mapOutcome(message('completed', session: false)),
        isA<UnknownPurchaseOutcome>(),
      );
      expect(mapOutcome(message('rejected')), isA<UnknownPurchaseOutcome>());
      expect(mapOutcome(message('failed')), isA<UnknownPurchaseOutcome>());
    });

    test('a switch over the sealed class is exhaustive', () {
      String name(PurchaseOutcome outcome) => switch (outcome) {
        PurchaseCompleted() => 'completed',
        PurchasePending() => 'pending',
        PurchaseCancelled() => 'cancelled',
        PurchaseUnverified() => 'unverified',
        PurchaseAwaitingBackend() => 'awaitingBackend',
        PurchaseRejected() => 'rejected',
        PurchaseAwaitingReturn() => 'awaitingReturn',
        PurchaseFailed() => 'failed',
        UnknownPurchaseOutcome() => 'unknown',
      };
      expect(name(mapOutcome(message('pending'))), 'pending');
    });
  });

  group('events', () {
    test('completed carries the session and the store reference', () {
      final ios = mapEvent(
        PurchaseEventMessage(
          kind: 'completed',
          session: sessionMessage(),
          transactionId: '2000000123',
        ),
      );
      expect((ios as PurchaseCompletedEvent).transactionId, '2000000123');
      expect(ios.purchaseToken, isNull);
      final android = mapEvent(
        PurchaseEventMessage(
          kind: 'completed',
          session: sessionMessage(platform: 'android'),
          purchaseToken: 'tok',
        ),
      );
      expect((android as PurchaseCompletedEvent).purchaseToken, 'tok');
    });

    test('pending lists the product ids', () {
      final event = mapEvent(
        PurchaseEventMessage(
          kind: 'pending',
          sessionId: 'sess_1',
          productIds: ['in.example.pro'],
        ),
      );
      expect((event as PurchasePendingEvent).productIds, ['in.example.pro']);
    });

    test('awaitingBackend and rejected carry session id and failure', () {
      final waiting = mapEvent(
        PurchaseEventMessage(
          kind: 'awaitingBackend',
          sessionId: 'sess_1',
          failure: failureMessage('backendFailing'),
          transactionId: '7',
        ),
      );
      expect(
        (waiting as PurchaseAwaitingBackendEvent).failure.reason,
        PurchaseFailureReason.backendFailing,
      );
      expect(waiting.transactionId, '7');
      final rejected = mapEvent(
        PurchaseEventMessage(
          kind: 'rejected',
          sessionId: 'sess_1',
          failure: failureMessage('backendRefused'),
        ),
      );
      expect((rejected as PurchaseRejectedEvent).sessionId, 'sess_1');
    });

    test('hostedCheckoutOpened', () {
      final event = mapEvent(
        PurchaseEventMessage(
          kind: 'hostedCheckoutOpened',
          session: sessionMessage(platform: 'android'),
        ),
      );
      expect(event, isA<HostedCheckoutOpenedEvent>());
    });

    test('unmatchedPurchase keeps both stores forms', () {
      final ios = mapEvent(
        PurchaseEventMessage(
          kind: 'unmatchedPurchase',
          transactionId: '9',
          productIds: ['in.example.pro'],
        ),
      );
      expect((ios as UnmatchedPurchaseEvent).transactionId, '9');
      final android = mapEvent(
        PurchaseEventMessage(kind: 'unmatchedPurchase', purchaseToken: 'tok'),
      );
      expect((android as UnmatchedPurchaseEvent).productIds, isEmpty);
      expect(android.purchaseToken, 'tok');
    });

    test('unverifiedTransaction', () {
      final event = mapEvent(
        PurchaseEventMessage(
          kind: 'unverifiedTransaction',
          transactionId: '5',
          reason: 'bad signature',
        ),
      );
      expect((event as UnverifiedTransactionEvent).reason, 'bad signature');
    });

    test('an unknown kind becomes UnknownPurchaseEvent with its name', () {
      final event = mapEvent(
        PurchaseEventMessage(kind: 'priceIncreaseConsent'),
      );
      expect((event as UnknownPurchaseEvent).kind, 'priceIncreaseConsent');
    });

    test('a known kind with missing fields is unknown, not a crash', () {
      expect(
        mapEvent(PurchaseEventMessage(kind: 'completed')),
        isA<UnknownPurchaseEvent>(),
      );
      expect(
        mapEvent(PurchaseEventMessage(kind: 'rejected', sessionId: 's')),
        isA<UnknownPurchaseEvent>(),
      );
    });

    test('a switch over the sealed class is exhaustive', () {
      String name(PurchaseEvent event) => switch (event) {
        PurchaseCompletedEvent() => 'completed',
        PurchasePendingEvent() => 'pending',
        PurchaseAwaitingBackendEvent() => 'awaitingBackend',
        PurchaseRejectedEvent() => 'rejected',
        HostedCheckoutOpenedEvent() => 'hosted',
        UnmatchedPurchaseEvent() => 'unmatched',
        UnverifiedTransactionEvent() => 'unverified',
        UnknownPurchaseEvent() => 'unknown',
      };
      expect(name(mapEvent(PurchaseEventMessage(kind: 'x'))), 'unknown');
    });
  });

  group('return links', () {
    ReturnLinkResultMessage message(String kind, {bool failure = false}) =>
        ReturnLinkResultMessage(
          kind: kind,
          session: failure ? null : sessionMessage(platform: 'android'),
          failure: failure ? failureMessage() : null,
        );

    test('every result maps', () {
      expect(
        mapReturnLink(ReturnLinkResultMessage(kind: 'ignored')),
        isA<ReturnLinkIgnored>(),
      );
      expect(mapReturnLink(message('completed')), isA<ReturnLinkCompleted>());
      expect(mapReturnLink(message('notPaid')), isA<ReturnLinkNotPaid>());
      expect(
        mapReturnLink(message('stillPending')),
        isA<ReturnLinkStillPending>(),
      );
      final failed = mapReturnLink(message('backendFailed', failure: true));
      expect(
        (failed as ReturnLinkBackendFailed).failure.reason,
        PurchaseFailureReason.backendUnreachable,
      );
    });

    test('an unknown result keeps its name', () {
      final result = mapReturnLink(message('expiredLink'));
      expect((result as UnknownReturnLinkResult).kind, 'expiredLink');
    });
  });

  test('refund outcomes map, unknown ones too', () {
    expect(mapRefundOutcome('submitted'), RefundRequestOutcome.submitted);
    expect(mapRefundOutcome('cancelled'), RefundRequestOutcome.cancelled);
    expect(mapRefundOutcome('deferred'), RefundRequestOutcome.unknown);
  });

  group('arguments', () {
    test('purchase request', () {
      final request = buildPurchaseRequest(
        product: 'pro_monthly',
        customerRef: 'cust_1',
        customer: const Customer(
          name: 'Asha',
          email: 'asha@example.com',
          state: 'Karnataka',
        ),
        reference: 'order-9',
        returnUrl: 'myapp://billing/return',
      );
      expect(request.product, 'pro_monthly');
      expect(request.customerRef, 'cust_1');
      expect(request.customer.name, 'Asha');
      expect(request.customer.state, 'Karnataka');
      expect(request.customer.phone, isNull);
      expect(request.reference, 'order-9');
      expect(request.returnUrl, 'myapp://billing/return');
    });

    test('configure request converts durations to millis', () {
      final request = buildConfigureRequest(
        baseUrl: 'https://api.example.com/billing/',
        authorization: 'Bearer t',
        headers: {'X-App': '1'},
        paths: const PurchasePaths(entitlements: 'me/entitlements'),
        timeout: const Duration(seconds: 20),
        maxCompletionAttempts: 5,
        retryDelay: const Duration(milliseconds: 250),
        maxServerFailures: 3,
        allowCleartextCheckout: true,
        start: false,
      );
      expect(request.baseUrl, 'https://api.example.com/billing/');
      expect(request.authorization, 'Bearer t');
      expect(request.headers, {'X-App': '1'});
      expect(request.paths?.entitlements, 'me/entitlements');
      expect(request.paths?.start, isNull);
      expect(request.timeoutMillis, 20000);
      expect(request.retryDelayMillis, 250);
      expect(request.maxCompletionAttempts, 5);
      expect(request.maxServerFailures, 3);
      expect(request.allowCleartextCheckout, isTrue);
      expect(request.finishUnmatchedTransactions, isNull);
      expect(request.start, isFalse);
    });
  });
}
